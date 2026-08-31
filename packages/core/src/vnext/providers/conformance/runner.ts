import { isDeepStrictEqual } from "node:util";
import type {
  ConformanceTier,
  ModelProfile,
  NormalizationCode,
  ProviderAdapter,
  ProviderRuntimeObservation,
} from "../contract.js";
import { isProviderTransportId } from "../contract.js";
import {
  verifyRecordIntegrity,
  type ConformanceRecord,
  type TransportRuntimeEvidence,
} from "./recording.js";
import {
  CONFORMANCE_SUITE_VERSION,
  MANDATORY_CATEGORIES,
  type ConformanceCase,
  type ConformanceCaseResult,
  type ConformanceResult,
  type RuntimeAssertionKey,
} from "./suite.js";

function requestedModelForProfile(profile: ModelProfile): string {
  return profile.runtimeModel?.requestedModel ?? profile.modelId;
}

function resolvedModelForProfile(profile: ModelProfile): string | undefined {
  return profile.runtimeModel ? profile.runtimeModel.resolvedModel : profile.modelId;
}

function fail(test: ConformanceCase, diagnostic: string): ConformanceCaseResult {
  return { id: test.id, category: test.category, mandatory: test.mandatory, passed: false, normalizations: [], diagnostic };
}

interface ReplayedRuntimeInvocation {
  readonly id: string;
  readonly transportInvocations: number;
  readonly cwdIsolated: boolean;
  readonly observation: ProviderRuntimeObservation;
}

interface DerivedRuntimeAssertion {
  readonly passed: boolean;
  readonly diagnostic: string;
}

function runtimePass(): DerivedRuntimeAssertion {
  return { passed: true, diagnostic: "" };
}

function runtimeFail(diagnostic: string): DerivedRuntimeAssertion {
  return { passed: false, diagnostic };
}

function replayRuntimeInvocations(
  adapter: ProviderAdapter,
  record: ConformanceRecord,
): readonly ReplayedRuntimeInvocation[] | undefined {
  const evidence = record.runtimeEvidence;
  if (!evidence?.invocations || !adapter.observeRuntime) return undefined;
  const replayed: ReplayedRuntimeInvocation[] = [];
  for (const invocation of evidence.invocations) {
    const raw = record.rawResponses[invocation.recordingKey]?.response;
    const observation = raw === undefined ? undefined : adapter.observeRuntime(raw);
    if (!observation) return undefined;
    if (invocation.numTurns !== observation.numTurns) return undefined;
    if (invocation.topLevelModelSteps !== observation.assistantMessageIds.length) return undefined;
    if (!isDeepStrictEqual(invocation.modelIds, observation.modelIds)) return undefined;
    if (invocation.resultSubtype !== observation.resultSubtype) return undefined;
    replayed.push({
      id: invocation.id,
      transportInvocations: invocation.transportInvocations ?? 0,
      cwdIsolated: invocation.cwdIsolated,
      observation,
    });
  }
  const aggregateModels = [...new Set(replayed.flatMap((item) => item.observation.modelIds))].sort();
  const aggregateSteps = replayed.map((item) => item.observation.assistantMessageIds.length);
  if (!isDeepStrictEqual(evidence.observedModelIds, aggregateModels)) return undefined;
  if (!isDeepStrictEqual(evidence.observedTopLevelModelSteps, aggregateSteps)) return undefined;
  return replayed;
}

function hasExactModel(invocations: readonly ReplayedRuntimeInvocation[], profile: ModelProfile): boolean {
  const resolvedModel = resolvedModelForProfile(profile);
  return invocations.length > 0
    && resolvedModel !== undefined
    && invocations.every((item) => item.observation.modelIds.length === 1 && item.observation.modelIds[0] === resolvedModel);
}

function hasOnlyStructuredOutput(invocations: readonly ReplayedRuntimeInvocation[]): boolean {
  return invocations.length > 0 && invocations.every((item) => (
    item.observation.declaredTools.every((tool) => tool === "StructuredOutput")
    && item.observation.usedTools.every((tool) => tool === "StructuredOutput")
    && item.observation.mcpServers.length === 0
    && item.observation.subagentsSpawned === 0
  ));
}

function validAttestationBase(
  evidence: TransportRuntimeEvidence,
  record: ConformanceRecord,
  check: "subscription-auth" | "environment-api-key-isolation" | "transport-version",
): boolean {
  if (!Array.isArray(evidence.liveAttestations)) return false;
  const matching = evidence.liveAttestations.filter((item) => item.check === check);
  if (matching.length !== 1) return false;
  const attestation = matching[0]!;
  const checkedAt = Date.parse(attestation.checkedAt);
  const recordedAt = Date.parse(record.recordedAt);
  return Number.isFinite(checkedAt)
    && Number.isFinite(recordedAt)
    && checkedAt <= recordedAt
    && attestation.transport === record.transport
    && attestation.transportVersion === record.transportVersion;
}

function deriveRuntimeAssertion(input: {
  readonly key: RuntimeAssertionKey;
  readonly adapter: ProviderAdapter;
  readonly profile: ModelProfile;
  readonly cases: readonly ConformanceCase[];
  readonly record: ConformanceRecord;
}): DerivedRuntimeAssertion {
  const { key, adapter, profile, cases, record } = input;
  const evidence = record.runtimeEvidence;
  if (!evidence) return runtimeFail("external runtime evidence is missing");
  if (evidence.format !== "rb-external-runtime-evidence/v3") return runtimeFail("external runtime evidence format is stale or missing");
  const invocations = replayRuntimeInvocations(adapter, record);
  const configuration = evidence.invocationConfiguration;

  switch (key) {
    case "subscription-auth": {
      const attestation = evidence.liveAttestations?.find((item) => item.check === key);
      return validAttestationBase(evidence, record, key) && attestation?.check === key && attestation.authMode === "subscription"
        ? runtimePass()
        : runtimeFail("typed live subscription-auth attestation is absent or invalid");
    }
    case "environment-api-key-isolation": {
      const attestation = evidence.liveAttestations?.find((item) => item.check === key);
      return validAttestationBase(evidence, record, key)
        && attestation?.check === key
        && attestation.providerCredentialVariablesPresent === false
        && attestation.alternateBackendVariablesPresent === false
        && attestation.observedApiKeySource === "none"
        ? runtimePass()
        : runtimeFail("typed live environment-isolation attestation is absent or invalid");
    }
    case "transport-version": {
      const attestation = evidence.liveAttestations?.find((item) => item.check === key);
      return validAttestationBase(evidence, record, key)
        && attestation?.check === key
        && attestation.executable.trim().length > 0
        && attestation.transportVersion === record.transportVersion
        ? runtimePass()
        : runtimeFail("typed live transport-version attestation is absent or invalid");
    }
    case "single-harness-invocation": {
      if (!invocations) return runtimeFail("model-bearing invocation evidence cannot be replayed");
      const required = ["valid-structured-response", "semantically-incomplete", "structured-output-retry-probe"];
      const ids = invocations.map((item) => item.id).sort();
      const smokeInvocations = (record.liveSmoke.cancellation.transportInvocations ?? 0)
        + (record.liveSmoke.timeout.transportInvocations ?? 0);
      return isDeepStrictEqual(ids, [...required].sort())
        && invocations.every((item) => item.transportInvocations === 1)
        && evidence.cliInvocations === invocations.length + smokeInvocations
        ? runtimePass()
        : runtimeFail("record does not prove exactly one Harness-owned model-bearing process per adapter request");
    }
    case "opaque-provider-accounting": {
      if (!invocations || profile.requestAccounting !== "opaque" || evidence.observedProviderRequests.measured) {
        return runtimeFail("opaque provider accounting evidence is inconsistent");
      }
      for (const id of ["valid-structured-response", "semantically-incomplete"] as const) {
        const invocation = evidence.invocations?.find((item) => item.id === id);
        const test = cases.find((item) => item.id === id);
        const raw = invocation ? record.rawResponses[invocation.recordingKey]?.response : undefined;
        if (!test || raw === undefined) return runtimeFail(`canonical accounting evidence for ${id} is missing`);
        const outcome = adapter.replay(profile, test.request(), raw);
        if (!outcome.ok || outcome.value.usage.providerRequests.measured) {
          return runtimeFail(`canonical accounting evidence for ${id} is not opaque`);
        }
      }
      return runtimePass();
    }
    case "structured-output-retry-bound": {
      const retry = invocations?.find((item) => item.id === "structured-output-retry-probe");
      return retry
        && retry.transportInvocations === 1
        && retry.observation.streamComplete
        && retry.observation.treeQuiescent
        && retry.observation.treeVerified
        && retry.observation.resultSubtype !== undefined
        && hasExactModel([retry], profile)
        && hasOnlyStructuredOutput([retry])
        && configuration?.fallbackModelConfigured === false
        ? runtimePass()
        : runtimeFail("stress-probe evidence does not prove one bounded isolated Harness invocation");
    }
    case "exact-model":
      return invocations && hasExactModel(invocations, profile)
        ? runtimePass()
        : runtimeFail("raw runtime observations contain a model outside the exact profile");
    case "no-fallback":
      return invocations
        && hasExactModel(invocations, profile)
        && configuration?.modelId === requestedModelForProfile(profile)
        && configuration.fallbackModelConfigured === false
        ? runtimePass()
        : runtimeFail("raw model observations or invocation configuration permit fallback");
    case "no-agent-tools-or-mcp":
      return invocations && hasOnlyStructuredOutput(invocations)
        ? runtimePass()
        : runtimeFail("raw runtime observations contain tools, MCP activity, or subagents");
    case "isolated-context":
      return invocations
        && invocations.every((item) => item.cwdIsolated)
        && configuration?.settingSources === "none"
        && configuration.strictMcpConfig === true
        && configuration.configuredMcpServers === 0
        && configuration.toolsMode === "disabled-except-structured-output"
        && configuration.restrictedMode === true
        ? runtimePass()
        : runtimeFail("sanitized cwd observations or invocation configuration do not prove isolation");
    case "no-session-persistence":
      return configuration?.sessionPersistence === "disabled"
        ? runtimePass()
        : runtimeFail("invocation configuration does not disable session persistence");
    default: {
      const exhaustive: never = key;
      return runtimeFail(`runtime assertion has no evidence predicate: ${String(exhaustive)}`);
    }
  }
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
    if (test.expect.kind === "runtime-assertion") tested.add(`runtime:${test.expect.key}`);
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
    if (test.expect.kind === "runtime-assertion") {
      const derived = deriveRuntimeAssertion({ key: test.expect.key, adapter, profile, cases, record });
      results.push(derived.passed
        ? { id: test.id, category: test.category, mandatory: test.mandatory, passed: true, normalizations: [] }
        : fail(test, derived.diagnostic));
      continue;
    }
    if (test.expect.kind === "live-smoke") {
      const smoke = record.liveSmoke[test.expect.errorKind === "cancelled" ? "cancellation" : "timeout"];
      const invocations = smoke?.transportInvocations ?? smoke?.providerRequests;
      const externalV3 = record.runtimeEvidence?.format === "rb-external-runtime-evidence/v3";
      const passed = externalV3
        ? smoke?.errorKind === test.expect.errorKind
          && invocations === 1
          && smoke.promptAbort
          && smoke.treeQuiescent === true
          && smoke.treeVerified === true
          && smoke.durationMs >= 0
        : smoke?.passed === true && smoke.errorKind === test.expect.errorKind && invocations === 1 && smoke.promptAbort;
      results.push(passed
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
        const required = profile.requestAccounting === "opaque"
          ? test.expect.required.filter((key) => key !== "providerRequests")
          : test.expect.required;
        passed = required.every((key) => outcome.value.usage[key].measured)
          && (profile.requestAccounting !== "opaque" || !outcome.value.usage.providerRequests.measured);
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
  if (profile.runtime.kind === "external-executable") {
    if (record.providerFamily !== profile.family) throw new Error(`conformance record provider family '${String(record.providerFamily)}' does not match profile family '${profile.family}'`);
    if (record.modelId !== profile.modelId) throw new Error(`conformance record model '${String(record.modelId)}' does not match profile model '${profile.modelId}'`);
    if (!record.transportVersion?.trim()) throw new Error("external transport conformance record is missing transportVersion");
    if (!record.runtimeEvidence) throw new Error("external transport conformance record is missing runtime evidence");
    if (record.runtimeEvidence.format !== "rb-external-runtime-evidence/v3") {
      throw new Error(`external transport runtime evidence format '${String(record.runtimeEvidence.format)}' is stale or invalid`);
    }
    const currentConfiguration = input.adapter.invocationConfigurationEvidence?.(profile);
    if (!currentConfiguration) throw new Error(`external transport ${profile.transport} does not expose current invocation policy evidence`);
    if (!isDeepStrictEqual(record.runtimeEvidence.invocationConfiguration, currentConfiguration)) {
      throw new Error("external transport invocation policy differs from the conformance record");
    }
    if (record.requestAccounting !== profile.requestAccounting) {
      throw new Error(`conformance record request accounting '${String(record.requestAccounting)}' does not match profile request accounting '${profile.requestAccounting}'`);
    }
  } else if (record.requestAccounting !== undefined && record.requestAccounting !== profile.requestAccounting) {
    throw new Error(`conformance record request accounting '${record.requestAccounting}' does not match profile request accounting '${profile.requestAccounting}'`);
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
