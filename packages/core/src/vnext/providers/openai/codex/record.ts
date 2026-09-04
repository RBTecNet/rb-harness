import { unmeasured, type Measured, type ModelProfile, type ResolvedProviderAuth, type SemanticRequest } from "../../contract.js";
import {
  newRunIdentity,
  sealRecord,
  type CodexAppServerRuntimeEvidence,
  type ConformanceRecord,
  type ConformanceRecordBody,
  type LiveSmokeRecord,
  type RecordedRawResponse,
} from "../../conformance/recording.js";
import { replayConformance } from "../../conformance/runner.js";
import { CONFORMANCE_SUITE_VERSION, type ConformanceResult } from "../../conformance/suite.js";
import { CodexSubscriptionAdapter, type CodexRequestResult } from "./adapter.js";
import { CODEX_SUBSCRIPTION_CONFORMANCE_CASES } from "./fixtures.js";
import type { CodexAppServerRawResponse } from "./normalize.js";
import { CODEX_SUBSCRIPTION_PROFILE_ID } from "./profiles.js";

function requestFor(id: string): SemanticRequest {
  const test = CODEX_SUBSCRIPTION_CONFORMANCE_CASES.find((candidate) => candidate.id === id);
  if (!test) throw new Error(`Codex Subscription conformance request '${id}' is missing`);
  return test.request();
}

function derived(raw: CodexAppServerRawResponse): { truncated: CodexAppServerRawResponse; malformed: CodexAppServerRawResponse } {
  const { completion: _completion, terminalStatus: _terminalStatus, ...withoutTerminal } = raw;
  return {
    truncated: { ...withoutTerminal, streamComplete: false },
    malformed: { ...raw, finalMessages: ["{not-valid-json"] },
  };
}

function withDeadline(request: SemanticRequest, deadlineMs: number, signal: AbortSignal): SemanticRequest {
  return { ...request, limits: { ...request.limits, deadlineMs }, signal };
}

async function smoke(
  adapter: CodexSubscriptionAdapter,
  profile: ModelProfile,
  auth: ResolvedProviderAuth,
  kind: "cancelled" | "timeout",
): Promise<LiveSmokeRecord> {
  const controller = new AbortController();
  const before = adapter.modelInvocations;
  const request = withDeadline(requestFor("valid-structured-response"), kind === "timeout" ? 1 : 30_000, controller.signal);
  let poll: ReturnType<typeof setInterval> | undefined;
  if (kind === "cancelled") {
    poll = setInterval(() => {
      if (adapter.modelInvocations > before) controller.abort(new DOMException("Codex conformance cancellation", "AbortError"));
    }, 5);
    poll.unref();
  }
  const started = Date.now();
  const result = await adapter.requestWithRaw(profile, auth, request);
  if (poll) clearInterval(poll);
  const durationMs = Date.now() - started;
  const transportInvocations = adapter.modelInvocations - before;
  const passed = !result.outcome.ok && result.outcome.error.kind === kind && transportInvocations === 1
    && result.treeQuiescent === true && result.treeVerified === true;
  return {
    passed, errorKind: kind, durationMs, transportInvocations,
    providerRequestMeasurement: unmeasured("stream-incomplete"),
    promptAbort: passed,
    treeQuiescent: result.treeQuiescent === true,
    treeVerified: result.treeVerified === true,
  };
}

interface Capture {
  readonly id: string;
  readonly recordingKey: string;
  readonly result: CodexRequestResult;
}

export async function recordCodexSubscriptionConformance(
  profile: ModelProfile,
  auth: ResolvedProviderAuth,
  adapter = new CodexSubscriptionAdapter(),
): Promise<{ readonly record: ConformanceRecord; readonly providerRequests: Measured<number>; readonly transportInvocations: number }> {
  if (profile.id !== CODEX_SUBSCRIPTION_PROFILE_ID || profile.transport !== "codex-app-server") {
    throw new Error(`live Codex Subscription recording is restricted to ${CODEX_SUBSCRIPTION_PROFILE_ID}`);
  }
  if (auth.kind !== "external-auth-store") throw new Error("Codex Subscription conformance requires rb-codex-owned authentication");
  const rawResponses: Record<string, RecordedRawResponse> = {};
  const captures: Capture[] = [];
  for (const [id, recordingKey] of [["valid-structured-response", "representation-comprehensive"], ["semantically-incomplete", "semantic-incomplete"]] as const) {
    const result = await adapter.requestWithRaw(profile, auth, requestFor(id));
    if (!result.raw || !result.outcome.ok) throw new Error(`Codex Subscription conformance '${id}' failed: ${result.outcome.ok ? "missing raw response" : `${result.outcome.error.kind}: ${result.outcome.error.message}`}`);
    captures.push({ id, recordingKey, result });
    rawResponses[recordingKey] = { origin: "live-recorded", canonicalPayload: result.outcome.value.payload, response: result.raw };
  }
  const representation = rawResponses["representation-comprehensive"]!.response as CodexAppServerRawResponse;
  const adverse = derived(representation);
  rawResponses["derived-truncated"] = { origin: "derived-from-recording", response: adverse.truncated, derivedFrom: "representation-comprehensive", derivation: "authoritative turn completion removed" };
  rawResponses["derived-malformed"] = { origin: "derived-from-recording", response: adverse.malformed, derivedFrom: "representation-comprehensive", derivation: "canonical assistant payload replaced by malformed JSON" };
  const cancellation = await smoke(adapter, profile, auth, "cancelled");
  const timeout = await smoke(adapter, profile, auth, "timeout");
  const runtime = captures[0]!.result.runtime!;
  const identity = newRunIdentity();
  const provisionalResult: ConformanceResult = {
    profileId: profile.id, suiteVersion: CONFORMANCE_SUITE_VERSION, runId: identity.runId, recordedAt: identity.recordedAt,
    tier: "UNSUPPORTED", cases: [], normalizationsOnHappyPath: [], capabilitiesActuallyTested: [],
  };
  const invocationPolicy: CodexAppServerRuntimeEvidence["invocationPolicy"] = {
    modelSelection: "thread/start", turnModelOverride: false, schemaTransmission: "unchanged", outputSchemaStrict: false,
    toolPolicy: "none", instructionPolicy: "isolated", sessionMode: "ephemeral", internalRetryLimit: 0,
    fallbackModelConfigured: false, authStoreKind: "file",
  };
  const body: ConformanceRecordBody = {
    format: "rb-adapter-conformance-record/v1",
    producer: "rb-harness-conformance-runner",
    profileId: profile.id,
    providerFamily: profile.family,
    modelId: profile.modelId,
    transport: profile.transport,
    requestAccounting: profile.requestAccounting,
    transportVersion: runtime.version,
    suiteVersion: CONFORMANCE_SUITE_VERSION,
    ...identity,
    rawResponses,
    liveSmoke: { cancellation, timeout },
    codexAppServerEvidence: {
      format: "rb-codex-app-server-evidence/v1",
      managedRuntimeVersion: runtime.version,
      managedRuntimeSha256: runtime.sha256,
      semanticModeVersion: runtime.semanticModeVersion,
      semanticRuntimeVersion: runtime.semanticRuntimeVersion,
      requestedModel: profile.modelId,
      requestedProvider: "openai",
      identitySource: "app-server-semantic-preflight-and-final-completion",
      requestAccounting: "opaque",
      invocationPolicy,
      invocations: captures.map(({ id, recordingKey, result }) => ({
        id, recordingKey, transportInvocations: 1,
        terminalStatus: result.raw!.terminalStatus!,
        initialModel: result.raw!.completion!.initialModel,
        initialProvider: result.raw!.completion!.initialModelProvider,
        finalModel: result.raw!.completion!.finalModel,
        finalProvider: result.raw!.completion!.finalModelProvider,
        rerouted: result.raw!.completion!.rerouted,
        actionCounts: result.raw!.actionCounts,
        authoritativeFinalMessages: result.raw!.finalMessages.length,
      })),
    },
    result: provisionalResult,
  };
  const provisional = sealRecord(body);
  const result = replayConformance({ adapter, profile, cases: CODEX_SUBSCRIPTION_CONFORMANCE_CASES, record: provisional });
  return { record: sealRecord({ ...body, result }), providerRequests: unmeasured("unsupported-by-provider"), transportInvocations: adapter.modelInvocations };
}
