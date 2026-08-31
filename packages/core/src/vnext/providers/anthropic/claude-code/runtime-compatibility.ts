import { isDeepStrictEqual } from "node:util";
import type { ModelProfile, ResolvedProviderAuth } from "../../contract.js";
import { readConformanceRecord, type ConformanceRecord } from "../../conformance/recording.js";
import { validateConformanceRecord } from "../../conformance/runner.js";
import { CONFORMANCE_SUITE_VERSION } from "../../conformance/suite.js";
import { CLAUDE_CODE_CONFORMANCE_CASES } from "./fixtures.js";
import { CLAUDE_CODE_OPUS_5_PROFILE } from "./profiles.js";
import { ClaudeCodeAdapter } from "./adapter.js";
import { recordClaudeCodeConformance } from "./record.js";
import {
  CLAUDE_CODE_COMPATIBILITY_EVIDENCE_CONTRACT,
  claudeCodeCompatibilityEvidenceIsInvalidated,
  compatibilityEvidenceId,
  defaultProviderCompatibilityRoot,
  listClaudeCodeCompatibilityEvidence,
  sealClaudeCodeCompatibilityEvidence,
  verifyClaudeCodeCompatibilityEvidenceIntegrity,
  writeClaudeCodeCompatibilityEvidence,
  type ClaudeCodeCapabilityEnvelope,
  type ClaudeCodeRuntimeCompatibilityEvidence,
} from "./compatibility-store.js";
import {
  CLAUDE_CODE_SUGGESTED_ALIASES,
  CLAUDE_CODE_TRANSPORT_PROFILE_ID,
  claudeCodeInvocationPolicySha256,
  createClaudeCodeRuntimeProfile,
  runtimeModelSelection,
  validateClaudeCodeModelSelector,
} from "./runtime-model.js";

export type ClaudeCodeCompatibilityState = "SUPPORTED" | "UNVERIFIED" | "STALE" | "UNAVAILABLE" | "UNSUPPORTED";

export interface ClaudeCodeCompatibilityInspection {
  readonly requestedModel: string;
  readonly state: ClaudeCodeCompatibilityState;
  readonly transportVersion: string;
  readonly resolvedModel?: string;
  readonly source?: "packaged" | "runtime";
  readonly evidence?: ClaudeCodeRuntimeCompatibilityEvidence;
  readonly target?: ModelProfile;
  readonly reason?: string;
}

export interface ClaudeCodeConformanceRecording {
  readonly record: ConformanceRecord;
  readonly profile: ModelProfile;
  readonly transportInvocations: number;
}

function maxOutputTokensFromRecord(record: ConformanceRecord, resolvedModel: string): number {
  const values = Object.values(record.rawResponses).flatMap((entry) => {
    const response = entry.response as { readonly events?: readonly unknown[] };
    return (response.events ?? []).flatMap((eventValue) => {
      if (!eventValue || typeof eventValue !== "object") return [];
      const event = eventValue as Record<string, unknown>;
      if (event.type !== "result") return [];
      const usages = event.modelUsage && typeof event.modelUsage === "object"
        ? event.modelUsage as Record<string, unknown>
        : event.model_usage && typeof event.model_usage === "object"
          ? event.model_usage as Record<string, unknown>
          : {};
      const usage = usages[resolvedModel];
      if (!usage || typeof usage !== "object") return [];
      const value = (usage as Record<string, unknown>).maxOutputTokens;
      return typeof value === "number" && Number.isInteger(value) && value > 0 ? [value] : [];
    });
  });
  return values.length ? Math.min(...values) : 1_024;
}

function capabilityEnvelope(record: ConformanceRecord, resolvedModel: string): ClaudeCodeCapabilityEnvelope {
  return {
    structuredOutput: "claude-code-json-schema",
    reasoningEfforts: ["low"],
    maxOutputTokens: maxOutputTokensFromRecord(record, resolvedModel),
    testedCapabilities: [...record.result.capabilitiesActuallyTested].sort(),
  };
}

function conformanceState(record: ConformanceRecord): ModelProfile["conformance"] {
  return {
    tier: record.result.tier,
    suiteVersion: record.result.suiteVersion,
    runId: record.runId,
    recordedAt: record.recordedAt,
    normalizationsOnHappyPath: record.result.normalizationsOnHappyPath,
    verifiedRecord: true,
  };
}

function targetFromRuntimeEvidence(
  evidence: ClaudeCodeRuntimeCompatibilityEvidence,
  storeRoot: string,
): ModelProfile {
  return createClaudeCodeRuntimeProfile({
    requestedModel: evidence.requestedModel,
    resolvedModel: evidence.resolvedModel,
    transportVersion: evidence.transportVersion,
    maxOutputTokens: evidence.capabilityEnvelope.maxOutputTokens,
    conformance: conformanceState(evidence.conformanceRecord),
    compatibilityEvidenceId: evidence.evidenceId,
    compatibilityEvidenceSha256: evidence.integritySha256,
    compatibilityStoreRoot: storeRoot,
    compatibilitySource: "runtime",
  });
}

function assertRuntimeEvidence(
  evidence: ClaudeCodeRuntimeCompatibilityEvidence,
  adapter: ClaudeCodeAdapter,
): ModelProfile {
  if (!verifyClaudeCodeCompatibilityEvidenceIntegrity(evidence)) throw new Error("runtime compatibility evidence integrity mismatch");
  if (evidence.format !== CLAUDE_CODE_COMPATIBILITY_EVIDENCE_CONTRACT
    || evidence.providerFamily !== "anthropic"
    || evidence.transportProfileId !== CLAUDE_CODE_TRANSPORT_PROFILE_ID
    || evidence.transport !== "claude-code-cli"
    || evidence.requestAccounting !== "opaque") {
    throw new Error("runtime compatibility evidence attribution mismatch");
  }
  if (evidence.invocationPolicySha256 !== claudeCodeInvocationPolicySha256()) {
    throw new Error("runtime compatibility invocation policy is stale");
  }
  if (evidence.conformanceContractVersion !== CONFORMANCE_SUITE_VERSION
    || evidence.conformanceDigest !== evidence.conformanceRecord.integritySha256) {
    throw new Error("runtime compatibility conformance evidence is stale");
  }
  if (!isDeepStrictEqual(evidence.observedModelIdentities, [evidence.resolvedModel])) {
    throw new Error("runtime compatibility evidence contains inconsistent model identities");
  }
  if (evidence.conformanceRecord.runtimeEvidence?.invocationConfiguration.modelId !== evidence.requestedModel
    || evidence.conformanceRecord.runtimeEvidence.invocationConfiguration.fallbackModelConfigured !== false
    || !evidence.conformanceRecord.runtimeEvidence.invocations?.every((invocation) => isDeepStrictEqual(invocation.modelIds, [evidence.resolvedModel]))) {
    throw new Error("runtime compatibility requested/resolved model evidence mismatch");
  }
  const selection = runtimeModelSelection(evidence.requestedModel, evidence.resolvedModel);
  if (selection.selectorKind !== evidence.selectorKind) throw new Error("runtime compatibility selector kind mismatch");
  const expectedId = compatibilityEvidenceId({
    providerFamily: evidence.providerFamily,
    transportProfileId: evidence.transportProfileId,
    transportVersion: evidence.transportVersion,
    invocationPolicySha256: evidence.invocationPolicySha256,
    requestedModel: evidence.requestedModel,
    resolvedModel: evidence.resolvedModel,
    conformanceContractVersion: evidence.conformanceContractVersion,
    capabilityEnvelope: evidence.capabilityEnvelope,
  });
  if (evidence.evidenceId !== expectedId) throw new Error("runtime compatibility evidence cache key mismatch");
  const profile = createClaudeCodeRuntimeProfile({
    requestedModel: evidence.requestedModel,
    resolvedModel: evidence.resolvedModel,
    transportVersion: evidence.transportVersion,
    maxOutputTokens: evidence.capabilityEnvelope.maxOutputTokens,
    conformance: conformanceState(evidence.conformanceRecord),
  });
  const replayed = validateConformanceRecord({
    adapter,
    profile,
    cases: CLAUDE_CODE_CONFORMANCE_CASES,
    record: evidence.conformanceRecord,
  });
  if (!isDeepStrictEqual(replayed, evidence.conformanceRecord.result)
    || evidence.conformanceTier !== replayed.tier
    || !isDeepStrictEqual(evidence.capabilityEnvelope.testedCapabilities, replayed.capabilitiesActuallyTested)) {
    throw new Error("runtime compatibility full conformance replay mismatch");
  }
  return profile;
}

function packagedTarget(record: ConformanceRecord, transportVersion: string): ModelProfile {
  const profile: ModelProfile = {
    ...CLAUDE_CODE_OPUS_5_PROFILE,
    conformance: conformanceState(record),
    runtimeModel: {
      transportProfileId: CLAUDE_CODE_TRANSPORT_PROFILE_ID,
      transportVersion,
      requestedModel: "claude-opus-5",
      selectorKind: "exact",
      resolvedModel: "claude-opus-5",
      compatibilityEvidenceId: `packaged:${record.integritySha256}`,
      compatibilityEvidenceSha256: record.integritySha256,
      compatibilitySource: "packaged",
    },
  };
  return Object.freeze(profile);
}

export async function inspectClaudeCodeCompatibility(input: {
  readonly requestedModel: string;
  readonly transportVersion: string;
  readonly recordsRoot: string;
  readonly storeRoot?: string;
  readonly adapter?: ClaudeCodeAdapter;
}): Promise<ClaudeCodeCompatibilityInspection> {
  const requestedModel = validateClaudeCodeModelSelector(input.requestedModel);
  const adapter = input.adapter ?? new ClaudeCodeAdapter();
  const storeRoot = input.storeRoot ?? defaultProviderCompatibilityRoot();
  let packagedStale = false;
  if (requestedModel === "claude-opus-5") {
    try {
      const record = await readConformanceRecord(input.recordsRoot, CLAUDE_CODE_OPUS_5_PROFILE.id);
      validateConformanceRecord({ adapter, profile: CLAUDE_CODE_OPUS_5_PROFILE, cases: CLAUDE_CODE_CONFORMANCE_CASES, record });
      if (record.transportVersion === input.transportVersion) {
        return {
          requestedModel,
          state: record.result.tier === "UNSUPPORTED" ? "UNSUPPORTED" : "SUPPORTED",
          transportVersion: input.transportVersion,
          resolvedModel: "claude-opus-5",
          source: "packaged",
          target: packagedTarget(record, input.transportVersion),
        };
      }
      packagedStale = true;
    } catch {
      // Runtime evidence may still support this exact selector.
    }
  }

  const all = await listClaudeCodeCompatibilityEvidence(storeRoot);
  const selectorEvidence = all.filter((entry) => entry.requestedModel === requestedModel);
  const matching = selectorEvidence
    .filter((entry) => entry.transportVersion === input.transportVersion
      && entry.invocationPolicySha256 === claudeCodeInvocationPolicySha256()
      && entry.conformanceContractVersion === CONFORMANCE_SUITE_VERSION)
    .sort((left, right) => right.verifiedAt.localeCompare(left.verifiedAt));
  for (const evidence of matching) {
    try {
      assertRuntimeEvidence(evidence, adapter);
      if (await claudeCodeCompatibilityEvidenceIsInvalidated(storeRoot, evidence)) {
        return { requestedModel, state: "STALE", transportVersion: input.transportVersion, resolvedModel: evidence.resolvedModel, source: "runtime", evidence, reason: "runtime model identity changed" };
      }
      const state = evidence.conformanceTier === "UNSUPPORTED" ? "UNSUPPORTED" : "SUPPORTED";
      return {
        requestedModel,
        state,
        transportVersion: input.transportVersion,
        resolvedModel: evidence.resolvedModel,
        source: "runtime",
        evidence,
        ...(state === "SUPPORTED" ? { target: targetFromRuntimeEvidence(evidence, storeRoot) } : {}),
      };
    } catch {
      // Invalid evidence cannot grant support; inspect older candidates next.
    }
  }
  return {
    requestedModel,
    state: selectorEvidence.length || packagedStale ? "STALE" : "UNVERIFIED",
    transportVersion: input.transportVersion,
    ...(selectorEvidence.length || packagedStale ? { reason: "runtime, policy, conformance, or capability evidence changed" } : {}),
  };
}

export async function listClaudeCodeCompatibilityChoices(input: {
  readonly transportVersion: string;
  readonly recordsRoot: string;
  readonly storeRoot?: string;
  readonly adapter?: ClaudeCodeAdapter;
}): Promise<readonly ClaudeCodeCompatibilityInspection[]> {
  const storeRoot = input.storeRoot ?? defaultProviderCompatibilityRoot();
  const stored = await listClaudeCodeCompatibilityEvidence(storeRoot);
  const selectors = [...new Set([
    "claude-opus-5",
    ...CLAUDE_CODE_SUGGESTED_ALIASES,
    ...stored.map((entry) => entry.requestedModel),
  ])];
  const inspections = await Promise.all(selectors.map((requestedModel) => inspectClaudeCodeCompatibility({
    requestedModel,
    transportVersion: input.transportVersion,
    recordsRoot: input.recordsRoot,
    storeRoot,
    ...(input.adapter ? { adapter: input.adapter } : {}),
  })));
  return inspections.sort((left, right) => {
    const rank = (state: ClaudeCodeCompatibilityState): number => state === "SUPPORTED" ? 0 : state === "STALE" ? 1 : state === "UNVERIFIED" ? 2 : 3;
    return rank(left.state) - rank(right.state) || left.requestedModel.localeCompare(right.requestedModel);
  });
}

export function buildClaudeCodeCompatibilityEvidence(input: {
  readonly requestedModel: string;
  readonly transportVersion: string;
  readonly recording: ClaudeCodeConformanceRecording;
}): ClaudeCodeRuntimeCompatibilityEvidence {
  const record = input.recording.record;
  const observed = [...new Set(record.runtimeEvidence?.observedModelIds ?? [])].sort();
  if (observed.length !== 1) throw new Error(`MODEL_IDENTITY_DISAGREEMENT: conformance observed ${observed.join(", ") || "no model"}`);
  const resolvedModel = observed[0]!;
  if (record.runtimeEvidence?.invocationConfiguration.modelId !== input.requestedModel) {
    throw new Error("runtime conformance did not invoke the requested model selector");
  }
  if (record.runtimeEvidence.invocationConfiguration.fallbackModelConfigured !== false) {
    throw new Error("runtime conformance configured model fallback");
  }
  if (!record.runtimeEvidence.invocations?.every((invocation) => isDeepStrictEqual(invocation.modelIds, [resolvedModel]))) {
    throw new Error("runtime conformance model-bearing captures disagree");
  }
  if (record.modelId !== resolvedModel || input.recording.profile.modelId !== resolvedModel) {
    throw new Error("runtime conformance resolved-model attribution mismatch");
  }
  if (record.transportVersion !== input.transportVersion) throw new Error("runtime conformance transport version changed during verification");
  const selection = runtimeModelSelection(input.requestedModel, resolvedModel);
  const envelope = capabilityEnvelope(record, resolvedModel);
  const evidenceId = compatibilityEvidenceId({
    providerFamily: "anthropic",
    transportProfileId: CLAUDE_CODE_TRANSPORT_PROFILE_ID,
    transportVersion: input.transportVersion,
    invocationPolicySha256: claudeCodeInvocationPolicySha256(),
    requestedModel: selection.requestedModel,
    resolvedModel,
    conformanceContractVersion: CONFORMANCE_SUITE_VERSION,
    capabilityEnvelope: envelope,
  });
  return sealClaudeCodeCompatibilityEvidence({
    format: CLAUDE_CODE_COMPATIBILITY_EVIDENCE_CONTRACT,
    producer: "rb-harness-runtime-compatibility",
    evidenceId,
    providerFamily: "anthropic",
    transportProfileId: CLAUDE_CODE_TRANSPORT_PROFILE_ID,
    transport: "claude-code-cli",
    transportVersion: input.transportVersion,
    invocationPolicySha256: claudeCodeInvocationPolicySha256(),
    requestedModel: selection.requestedModel,
    selectorKind: selection.selectorKind,
    resolvedModel,
    requestAccounting: "opaque",
    conformanceContractVersion: CONFORMANCE_SUITE_VERSION,
    capabilityEnvelope: envelope,
    conformanceTier: record.result.tier,
    conformanceDigest: record.integritySha256,
    observedModelIdentities: observed,
    verifiedAt: record.recordedAt,
    conformanceRecord: record,
  });
}

export async function verifyClaudeCodeRuntimeCompatibility(input: {
  readonly requestedModel: string;
  readonly recordsRoot: string;
  readonly storeRoot?: string;
  readonly adapter?: ClaudeCodeAdapter;
  readonly auth?: ResolvedProviderAuth;
  readonly record?: (profile: ModelProfile, auth: ResolvedProviderAuth) => Promise<ClaudeCodeConformanceRecording>;
}): Promise<{ readonly evidence: ClaudeCodeRuntimeCompatibilityEvidence; readonly target: ModelProfile; readonly path: string; readonly transportInvocations: number }> {
  const requestedModel = validateClaudeCodeModelSelector(input.requestedModel);
  const adapter = input.adapter ?? new ClaudeCodeAdapter();
  const runtime = await adapter.runtimePreflight();
  if (!runtime.ok) throw new Error(`Claude Code preflight failed: ${runtime.error.message}`);
  const auth = input.auth ?? { kind: "ambient-session", id: "claude-code-subscription" };
  const pending = createClaudeCodeRuntimeProfile({ requestedModel, transportVersion: runtime.value.transportVersion });
  const recording = await (input.record ?? (async (profile, resolvedAuth) => recordClaudeCodeConformance(profile, resolvedAuth)))(pending, auth);
  const evidence = buildClaudeCodeCompatibilityEvidence({ requestedModel, transportVersion: runtime.value.transportVersion, recording });
  assertRuntimeEvidence(evidence, adapter);
  const storeRoot = input.storeRoot ?? defaultProviderCompatibilityRoot();
  const path = await writeClaudeCodeCompatibilityEvidence(storeRoot, evidence);
  if (evidence.conformanceTier === "UNSUPPORTED") {
    throw new Error(`MODEL_COMPATIBILITY_UNSUPPORTED: ${requestedModel} failed the full Claude Code conformance contract`);
  }
  return {
    evidence,
    target: targetFromRuntimeEvidence(evidence, storeRoot),
    path,
    transportInvocations: recording.transportInvocations,
  };
}
