import { isDeepStrictEqual } from "node:util";
import type {
  ConformanceTier,
  ModelProfile,
  NormalizationCode,
  ProviderAdapter,
} from "../contract.js";
import { isProviderTransportId } from "../contract.js";
import { verifyRecordIntegrity, type ConformanceRecord } from "./recording.js";
import {
  CONFORMANCE_SUITE_VERSION,
  MANDATORY_CATEGORIES,
  type ConformanceCase,
  type ConformanceCaseResult,
  type ConformanceResult,
} from "./suite.js";

function fail(test: ConformanceCase, diagnostic: string): ConformanceCaseResult {
  return { id: test.id, category: test.category, mandatory: test.mandatory, passed: false, normalizations: [], diagnostic };
}

function capabilitiesActuallyTested(
  profile: ModelProfile,
  cases: readonly ConformanceCase[],
  results: readonly ConformanceCaseResult[],
): string[] {
  const passed = new Set(results.filter((result) => result.passed).map((result) => result.id));
  const tested = new Set<string>();
  const recordingKeys = new Set<string>();
  for (const test of cases) {
    if (!passed.has(test.id)) continue;
    if (test.category === "valid-structured-response") {
      tested.add(`structured-output:${profile.structuredOutput}`);
      if (profile.streaming.supported) tested.add("streaming");
    }
    if (test.category === "usage-reporting") tested.add("usage-reporting");
    if (test.category === "cancellation") tested.add("cancellation");
    if (test.category === "timeout") tested.add("timeout");
    if (test.category === "unsupported-structured-output") tested.add("preflight:unsupported-structured-output");
    if (test.recordingKey && !recordingKeys.has(test.recordingKey)) {
      recordingKeys.add(test.recordingKey);
      const reasoning = test.request().reasoning;
      tested.add(reasoning.mode === "on" ? `reasoning:enabled:${reasoning.effort}` : "reasoning:disabled");
    }
  }
  return [...tested].sort();
}

export function deriveConformanceTier(input: {
  cases: readonly ConformanceCaseResult[];
  happyPathCodes: readonly NormalizationCode[];
  semanticNormalizationRequired: boolean;
}): ConformanceTier {
  if (input.semanticNormalizationRequired) return "UNSUPPORTED";
  if (input.cases.some((result) => result.mandatory && !result.passed)) return "UNSUPPORTED";
  const distinct = new Set(input.happyPathCodes);
  if (distinct.size > 3) return "UNSUPPORTED";
  return distinct.size ? "SUPPORTED_WITH_NORMALIZATION" : "SUPPORTED";
}

export function replayConformance(input: {
  adapter: ProviderAdapter;
  profile: ModelProfile;
  cases: readonly ConformanceCase[];
  record: ConformanceRecord;
}): ConformanceResult {
  const { adapter, profile, cases, record } = input;
  const results: ConformanceCaseResult[] = [];
  const happyPathCodes = new Set<NormalizationCode>();

  for (const category of MANDATORY_CATEGORIES) {
    if (!cases.some((test) => test.mandatory && test.category === category)) {
      results.push({ id: `missing:${category}`, category, mandatory: true, passed: false, normalizations: [], diagnostic: "mandatory category missing from suite" });
    }
  }

  for (const test of cases) {
    if (test.expect.kind === "live-smoke") {
      const smoke = record.liveSmoke[test.expect.errorKind === "cancelled" ? "cancellation" : "timeout"];
      results.push(smoke?.passed && smoke.errorKind === test.expect.errorKind && smoke.providerRequests === 1 && smoke.promptAbort
        ? { id: test.id, category: test.category, mandatory: test.mandatory, passed: true, normalizations: [] }
        : fail(test, "live smoke evidence is absent or failed"));
      continue;
    }

    if (test.expect.kind === "capability-refusal") {
      const outcome = adapter.checkCapabilities(test.profile?.(profile) ?? profile, test.request());
      results.push(!outcome.ok && outcome.error.kind === "unsupported-capability"
        ? { id: test.id, category: test.category, mandatory: test.mandatory, passed: true, normalizations: [] }
        : fail(test, "profile did not refuse unsupported capability before transport"));
      continue;
    }

    const recorded = test.recordingKey ? record.rawResponses[test.recordingKey] : undefined;
    if (!recorded) {
      results.push(fail(test, `recording '${test.recordingKey ?? ""}' is missing`));
      continue;
    }
    const outcome = adapter.replay(profile, test.request(), recorded.response);
    let passed = false;
    let diagnostic = "expectation failed";
    let normalizations: readonly NormalizationCode[] = [];
    if (test.expect.kind === "error") {
      passed = !outcome.ok && outcome.error.kind === test.expect.errorKind;
      diagnostic = outcome.ok ? `expected ${test.expect.errorKind}, received payload` : `expected ${test.expect.errorKind}, received ${outcome.error.kind}`;
    } else if (!outcome.ok) {
      diagnostic = `unexpected ${outcome.error.kind}: ${outcome.error.message}`;
    } else {
      normalizations = outcome.value.normalizations.map((event) => event.code);
      if (test.expect.kind === "payload-equals") {
        passed = isDeepStrictEqual(outcome.value.payload, test.expect.value);
        diagnostic = "canonical payload differs from expected payload";
      } else {
        passed = test.expect.required.every((key) => outcome.value.usage[key].measured);
        diagnostic = "a profile-claimed usage metric is unmeasured";
      }
      if (test.happyPath) for (const code of normalizations) happyPathCodes.add(code);
    }
    results.push({
      id: test.id,
      category: test.category,
      mandatory: test.mandatory,
      passed,
      normalizations,
      ...(passed ? {} : { diagnostic }),
    });
  }

  const semanticNormalizationRequired = Object.values(record.rawResponses).some((entry) => entry.semanticNormalizationRequired === true);
  const normalizationsOnHappyPath = [...happyPathCodes].sort();
  return {
    profileId: profile.id,
    suiteVersion: CONFORMANCE_SUITE_VERSION,
    runId: record.runId,
    recordedAt: record.recordedAt,
    tier: deriveConformanceTier({ cases: results, happyPathCodes: normalizationsOnHappyPath, semanticNormalizationRequired }),
    cases: results,
    normalizationsOnHappyPath,
    capabilitiesActuallyTested: capabilitiesActuallyTested(profile, cases, results),
  };
}

export function validateConformanceRecord(input: {
  adapter: ProviderAdapter;
  profile: ModelProfile;
  cases: readonly ConformanceCase[];
  record: ConformanceRecord;
}): ConformanceResult {
  const { record, profile } = input;
  if (!verifyRecordIntegrity(record)) throw new Error("conformance record integrity mismatch");
  if (!isProviderTransportId(record.transport)) throw new Error(`invalid conformance record transport: ${String(record.transport)}`);
  if (record.transport !== profile.transport) {
    throw new Error(`conformance record transport '${record.transport}' does not match profile transport '${profile.transport}'`);
  }
  if (record.profileId !== profile.id) throw new Error(`conformance record belongs to ${record.profileId}, not ${profile.id}`);
  if (record.suiteVersion !== CONFORMANCE_SUITE_VERSION) {
    throw new Error(`stale conformance record suite: record '${record.suiteVersion}', expected '${CONFORMANCE_SUITE_VERSION}'`);
  }
  if (record.result.suiteVersion !== CONFORMANCE_SUITE_VERSION) {
    throw new Error(`stale conformance result suite: result '${record.result.suiteVersion}', expected '${CONFORMANCE_SUITE_VERSION}'`);
  }
  if (record.runId !== record.result.runId || record.profileId !== record.result.profileId) {
    throw new Error("conformance record result attribution mismatch");
  }
  const replayed = replayConformance(input);
  if (!isDeepStrictEqual(replayed, record.result)) throw new Error("stored conformance result does not match deterministic replay");
  return replayed;
}
