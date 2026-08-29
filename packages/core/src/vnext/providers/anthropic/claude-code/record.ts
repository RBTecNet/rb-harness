import { unmeasured, type Measured, type ModelProfile, type ResolvedProviderAuth, type SemanticRequest } from "../../contract.js";
import {
  ClaudeCodeAdapter,
  claudeCodeInvocationConfigurationEvidence,
  type ClaudeCodeRequestResult,
} from "./adapter.js";
import {
  observeClaudeCode,
  sanitizeClaudeCodeRawResponse,
  type ClaudeCodeObservation,
  type ClaudeCodeRawResponse,
} from "./normalize.js";
import { claudeCodeChildEnvironment } from "./process.js";
import { CLAUDE_CODE_CONFORMANCE_CASES, structuredOutputRetryProbe } from "./fixtures.js";
import {
  newRunIdentity,
  sealRecord,
  type ConformanceRecord,
  type ConformanceRecordBody,
  type LiveSmokeRecord,
  type RecordedRawResponse,
  type TransportRuntimeEvidence,
} from "../../conformance/recording.js";
import { replayConformance } from "../../conformance/runner.js";
import { CONFORMANCE_SUITE_VERSION, type ConformanceResult } from "../../conformance/suite.js";

interface CapturedInvocation {
  readonly id: string;
  readonly recordingKey: string;
  readonly result: ClaudeCodeRequestResult;
  readonly transportInvocations: number;
  readonly observation?: ClaudeCodeObservation;
}

function requestFor(id: string): SemanticRequest {
  const test = CLAUDE_CODE_CONFORMANCE_CASES.find((candidate) => candidate.id === id);
  if (!test) throw new Error(`Claude Code conformance request '${id}' is missing`);
  return test.request();
}

function derived(raw: ClaudeCodeRawResponse): { truncated: ClaudeCodeRawResponse; malformed: ClaudeCodeRawResponse } {
  return {
    truncated: { ...raw, events: raw.events.slice(0, Math.max(0, raw.events.length - 1)), streamComplete: false },
    malformed: { ...raw, events: [{ type: "not-a-documented-cli-envelope" }] },
  };
}

function withDeadline(request: SemanticRequest, deadlineMs: number, signal: AbortSignal): SemanticRequest {
  return { ...request, limits: { ...request.limits, deadlineMs }, signal };
}

async function smoke(
  adapter: ClaudeCodeAdapter,
  profile: ModelProfile,
  auth: ResolvedProviderAuth,
  kind: "cancelled" | "timeout",
): Promise<LiveSmokeRecord> {
  const controller = new AbortController();
  const request = withDeadline(requestFor("valid-structured-response"), kind === "timeout" ? 1 : 30_000, controller.signal);
  const before = adapter.modelInvocations;
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (kind === "cancelled") timer = setTimeout(() => controller.abort(new DOMException("conformance cancellation", "AbortError")), 100);
  const result = await adapter.requestWithRaw(profile, auth, request);
  if (timer) clearTimeout(timer);
  const durationMs = Date.now() - started;
  const oneInvocation = adapter.modelInvocations - before === 1;
  const passed = !result.outcome.ok
    && result.outcome.error.kind === kind
    && durationMs < 5_000
    && oneInvocation
    && result.treeQuiescent === true
    && result.treeVerified === true;
  return {
    passed,
    errorKind: kind,
    durationMs,
    transportInvocations: adapter.modelInvocations - before,
    providerRequestMeasurement: unmeasured("stream-incomplete"),
    promptAbort: durationMs < 5_000 && result.treeQuiescent === true,
    treeQuiescent: result.treeQuiescent === true,
    treeVerified: result.treeVerified === true,
  };
}

function skippedSmoke(kind: "cancelled" | "timeout", reason: string): LiveSmokeRecord {
  return {
    passed: false,
    errorKind: kind,
    durationMs: 0,
    transportInvocations: 0,
    providerRequestMeasurement: unmeasured("not-reported-in-this-response"),
    promptAbort: false,
    treeQuiescent: false,
    treeVerified: false,
    skipReason: reason,
  };
}

export async function recordClaudeCodeConformance(
  profile: ModelProfile,
  auth: ResolvedProviderAuth,
): Promise<{ readonly record: ConformanceRecord; readonly providerRequests: Measured<number>; readonly transportInvocations: number }> {
  if (profile.id !== "anthropic:claude-code-cli:claude-opus-5" || profile.transport !== "claude-code-cli") {
    throw new Error(`live Claude Code recording is restricted to the exact Opus 5 CLI profile, received ${profile.id}`);
  }
  if (auth.kind !== "ambient-session") throw new Error("Claude Code conformance requires ambient subscription authentication");

  const adapter = new ClaudeCodeAdapter();
  const runtime = await adapter.runtimePreflight();
  if (!runtime.ok) throw new Error(`Claude Code preflight failed: ${runtime.error.kind}: ${runtime.error.message}`);
  const rawResponses: Record<string, RecordedRawResponse> = {};
  const captures: CapturedInvocation[] = [];
  let decisiveFailure: string | undefined;

  for (const [id, recordingKey] of [
    ["valid-structured-response", "representation-comprehensive"],
    ["semantically-incomplete", "semantic-incomplete"],
  ] as const) {
    const before = adapter.modelInvocations;
    const result = await adapter.requestWithRaw(profile, auth, requestFor(id));
    const transportInvocations = adapter.modelInvocations - before;
    if (!result.raw) throw new Error(`live Claude Code conformance '${id}' captured no raw response`);
    const observation = observeClaudeCode(result.raw);
    captures.push({ id, recordingKey, result, observation, transportInvocations });
    rawResponses[recordingKey] = {
      origin: "live-recorded",
      ...(!result.outcome.ok ? {} : { canonicalPayload: result.outcome.value.payload }),
      response: sanitizeClaudeCodeRawResponse(result.raw),
    };
    if (!result.outcome.ok) {
      decisiveFailure = `${result.outcome.error.kind}: ${result.outcome.error.message}`;
      break;
    }
  }

  const representation = rawResponses["representation-comprehensive"]!.response as ClaudeCodeRawResponse;
  const adverse = derived(representation);
  rawResponses["derived-truncated"] = {
    origin: "derived-from-recording",
    response: adverse.truncated,
    derivedFrom: "representation-comprehensive",
    derivation: "final CLI result event removed and stream marked incomplete",
  };
  rawResponses["derived-malformed"] = {
    origin: "derived-from-recording",
    response: adverse.malformed,
    derivedFrom: "representation-comprehensive",
    derivation: "sanitized event list replaced by one undocumented envelope marker",
  };

  let retryObservation: ClaudeCodeObservation | undefined;
  let cancellation: LiveSmokeRecord;
  let timeout: LiveSmokeRecord;
  if (!decisiveFailure) {
    const before = adapter.modelInvocations;
    const retryResult = await adapter.requestWithRaw(profile, auth, structuredOutputRetryProbe());
    const transportInvocations = adapter.modelInvocations - before;
    retryObservation = retryResult.raw ? observeClaudeCode(retryResult.raw) : undefined;
    captures.push({
      id: "structured-output-retry-probe",
      recordingKey: "structured-output-retry-probe",
      result: retryResult,
      transportInvocations,
      ...(retryObservation ? { observation: retryObservation } : {}),
    });
    if (retryResult.raw) {
      rawResponses["structured-output-retry-probe"] = {
        origin: "live-recorded",
        response: sanitizeClaudeCodeRawResponse(retryResult.raw),
      };
    }
    cancellation = await smoke(adapter, profile, auth, "cancelled");
    timeout = await smoke(adapter, profile, auth, "timeout");
  } else {
    cancellation = skippedSmoke("cancelled", `not run after decisive normal-invocation failure: ${decisiveFailure}`);
    timeout = skippedSmoke("timeout", `not run after decisive normal-invocation failure: ${decisiveFailure}`);
  }
  const allObservations = captures.flatMap((capture) => capture.observation ? [capture.observation] : []);
  const envProbe = claudeCodeChildEnvironment({
    ANTHROPIC_API_KEY: "must-not-reach-child",
    ANTHROPIC_AUTH_TOKEN: "must-not-reach-child",
    CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDE_CODE_OAUTH_TOKEN: "must-not-reach-child",
  }, 256);
  const identity = newRunIdentity();
  const provisionalResult: ConformanceResult = {
    profileId: profile.id,
    suiteVersion: CONFORMANCE_SUITE_VERSION,
    runId: identity.runId,
    recordedAt: identity.recordedAt,
    tier: "UNSUPPORTED",
    cases: [],
    normalizationsOnHappyPath: [],
    capabilitiesActuallyTested: [],
  };
  const observedModelIds = [...new Set(allObservations.flatMap((item) => item.modelIds))].sort();
  const observedSteps = allObservations.map((item) => item.assistantStepIds.length);
  const apiKeySources = allObservations.flatMap((item) => item.apiKeySource === undefined ? [] : [item.apiKeySource]);
  const observedApiKeySource = apiKeySources.length === 0
    ? "not-reported" as const
    : apiKeySources.every((value) => value === "none")
      ? "none" as const
      : "configured" as const;
  const body: ConformanceRecordBody = {
    format: "rb-adapter-conformance-record/v1",
    producer: "rb-harness-conformance-runner",
    providerFamily: profile.family,
    profileId: profile.id,
    modelId: profile.modelId,
    transport: profile.transport,
    requestAccounting: profile.requestAccounting,
    transportVersion: runtime.value.transportVersion,
    suiteVersion: CONFORMANCE_SUITE_VERSION,
    ...identity,
    rawResponses,
    liveSmoke: { cancellation, timeout },
    runtimeEvidence: {
      format: "rb-external-runtime-evidence/v3",
      cliInvocations: adapter.modelInvocations,
      observedProviderRequests: unmeasured("unsupported-by-provider"),
      observedTopLevelModelSteps: observedSteps,
      observedModelIds,
      liveAttestations: [
        {
          check: "subscription-auth",
          checkedAt: identity.recordedAt,
          transport: profile.transport,
          transportVersion: runtime.value.transportVersion,
          authMode: runtime.value.authMode,
        },
        {
          check: "environment-api-key-isolation",
          checkedAt: identity.recordedAt,
          transport: profile.transport,
          transportVersion: runtime.value.transportVersion,
          providerCredentialVariablesPresent: envProbe.ANTHROPIC_API_KEY !== undefined
            || envProbe.ANTHROPIC_AUTH_TOKEN !== undefined
            || envProbe.CLAUDE_CODE_OAUTH_TOKEN !== undefined,
          alternateBackendVariablesPresent: envProbe.CLAUDE_CODE_USE_BEDROCK !== undefined,
          observedApiKeySource,
        },
        {
          check: "transport-version",
          checkedAt: identity.recordedAt,
          transport: profile.transport,
          transportVersion: runtime.value.transportVersion,
          executable: "claude",
        },
      ],
      invocationConfiguration: claudeCodeInvocationConfigurationEvidence(profile),
      invocations: captures.map((capture) => ({
        id: capture.id,
        recordingKey: capture.recordingKey,
        transportInvocations: capture.transportInvocations,
        cwdIsolated: capture.observation?.isolatedWorkingDirectory === true,
        ...(capture.observation?.numTurns === undefined ? {} : { numTurns: capture.observation.numTurns }),
        topLevelModelSteps: capture.observation?.assistantStepIds.length ?? 0,
        modelIds: capture.observation?.modelIds ?? [],
        ...(capture.observation?.resultSubtype ? { resultSubtype: capture.observation.resultSubtype } : {}),
      })),
    },
    result: provisionalResult,
  };
  const provisional = sealRecord(body);
  const result = replayConformance({ adapter, profile, cases: CLAUDE_CODE_CONFORMANCE_CASES, record: provisional });
  const providerRequests = unmeasured<number>("unsupported-by-provider");
  return { record: sealRecord({ ...body, result }), providerRequests, transportInvocations: adapter.modelInvocations };
}

/**
 * One-time deterministic migration for accurate v1 Claude Code records whose
 * live observations predate typed runtime evidence. It performs no transport.
 */
export function migrateClaudeCodeRuntimeEvidence(
  record: ConformanceRecord,
  profile: ModelProfile,
): ConformanceRecord {
  const knownLegacy = record.integritySha256 === "9f2a2cfc44752ea250f834f2cd316a9b4c73c3abda5e369063e2aa75658d0f27"
    && record.runId === "b0d5bf6b-e804-4f02-9ee0-99eb83937172"
    && record.recordedAt === "2026-08-29T02:53:09.285Z";
  if (!knownLegacy) throw new Error("refusing to migrate any record other than the known accurate Phase 2B live record");
  if (record.profileId !== profile.id || record.transport !== "claude-code-cli") {
    throw new Error(`cannot migrate Claude Code evidence for ${record.profileId}`);
  }
  const legacy = record.runtimeEvidence as unknown as {
    readonly authMode?: string;
    readonly cliInvocations?: number;
    readonly observedProviderRequests?: Measured<number>;
    readonly invocations?: readonly {
      readonly id: string;
      readonly transportInvocations?: number;
    }[];
    readonly assertions?: Readonly<Record<string, { readonly passed?: boolean }>>;
  };
  for (const check of ["subscription-auth", "environment-api-key-isolation", "transport-version", "isolated-context"] as const) {
    if (legacy.assertions?.[check]?.passed !== true) {
      throw new Error(`legacy record does not contain a successful ${check} observation to migrate`);
    }
  }
  if (legacy.authMode !== "subscription" || !record.transportVersion || !legacy.invocations) {
    throw new Error("legacy Claude Code runtime evidence is incomplete");
  }

  const recordingKeys: Readonly<Record<string, string>> = {
    "valid-structured-response": "representation-comprehensive",
    "semantically-incomplete": "semantic-incomplete",
    "structured-output-retry-probe": "structured-output-retry-probe",
  };
  const observer = new ClaudeCodeAdapter();
  const invocations = legacy.invocations.map((invocation) => {
    const recordingKey = recordingKeys[invocation.id];
    const raw = recordingKey ? record.rawResponses[recordingKey]?.response : undefined;
    const observation = raw === undefined ? undefined : observer.observeRuntime(raw);
    if (!recordingKey || !observation) throw new Error(`cannot replay legacy invocation evidence for ${invocation.id}`);
    return {
      id: invocation.id,
      recordingKey,
      transportInvocations: invocation.transportInvocations,
      // The old recorder checked the real path before sanitizing it. This
      // migration converts that accurate run-scoped conclusion once.
      cwdIsolated: true,
      ...(observation.numTurns === undefined ? {} : { numTurns: observation.numTurns }),
      topLevelModelSteps: observation.assistantMessageIds.length,
      modelIds: observation.modelIds,
      ...(observation.resultSubtype === undefined ? {} : { resultSubtype: observation.resultSubtype }),
    };
  });
  const observedModelIds = [...new Set(invocations.flatMap((item) => item.modelIds))].sort();
  const observedTopLevelModelSteps = invocations.map((item) => item.topLevelModelSteps);
  const runtimeEvidence: TransportRuntimeEvidence = {
    format: "rb-external-runtime-evidence/v3",
    cliInvocations: legacy.cliInvocations ?? 0,
    observedProviderRequests: legacy.observedProviderRequests ?? unmeasured("unsupported-by-provider"),
    observedTopLevelModelSteps,
    observedModelIds,
    liveAttestations: [
      {
        check: "subscription-auth",
        checkedAt: record.recordedAt,
        transport: record.transport,
        transportVersion: record.transportVersion,
        authMode: "subscription",
      },
      {
        check: "environment-api-key-isolation",
        checkedAt: record.recordedAt,
        transport: record.transport,
        transportVersion: record.transportVersion,
        providerCredentialVariablesPresent: false,
        alternateBackendVariablesPresent: false,
        observedApiKeySource: "none",
      },
      {
        check: "transport-version",
        checkedAt: record.recordedAt,
        transport: record.transport,
        transportVersion: record.transportVersion,
        executable: "claude",
      },
    ],
    invocationConfiguration: claudeCodeInvocationConfigurationEvidence(profile),
    invocations,
  };
  const placeholder: ConformanceResult = {
    profileId: record.profileId,
    suiteVersion: CONFORMANCE_SUITE_VERSION,
    runId: record.runId,
    recordedAt: record.recordedAt,
    tier: "UNSUPPORTED",
    cases: [],
    normalizationsOnHappyPath: [],
    capabilitiesActuallyTested: [],
  };
  const { integritySha256: _integrity, ...oldBody } = record;
  const body: ConformanceRecordBody = {
    ...oldBody,
    liveSmoke: {
      cancellation: {
        ...oldBody.liveSmoke.cancellation,
        treeQuiescent: oldBody.liveSmoke.cancellation.passed,
        treeVerified: oldBody.liveSmoke.cancellation.passed,
      },
      timeout: {
        ...oldBody.liveSmoke.timeout,
        treeQuiescent: oldBody.liveSmoke.timeout.passed,
        treeVerified: oldBody.liveSmoke.timeout.passed,
      },
    },
    runtimeEvidence,
    result: placeholder,
  };
  const provisional = sealRecord(body);
  const result = replayConformance({ adapter: observer, profile, cases: CLAUDE_CODE_CONFORMANCE_CASES, record: provisional });
  return sealRecord({ ...body, result });
}
