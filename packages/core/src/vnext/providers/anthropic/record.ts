import type { ModelProfile, ResolvedProviderCredential, SemanticRequest } from "../contract.js";
import {
  AnthropicAdapter,
  FetchAnthropicTransport,
  type AnthropicTransport,
  type AnthropicTransportInput,
} from "./adapter.js";
import type { AnthropicRawResponse } from "./normalize.js";
import { CONFORMANCE_CASES, LIVE_RECORDING_REQUESTS } from "../conformance/fixtures.js";
import {
  newRunIdentity,
  sealRecord,
  type ConformanceRecord,
  type ConformanceRecordBody,
  type LiveSmokeRecord,
  type RecordedRawResponse,
} from "../conformance/recording.js";
import { replayConformance } from "../conformance/runner.js";
import { CONFORMANCE_SUITE_VERSION, type ConformanceResult } from "../conformance/suite.js";

class CapturingTransport implements AnthropicTransport {
  calls = 0;
  lastRaw: AnthropicRawResponse | undefined;
  lastRequestBody: unknown;

  constructor(private readonly delegate: AnthropicTransport = new FetchAnthropicTransport()) {}

  async send(input: AnthropicTransportInput): Promise<AnthropicRawResponse> {
    this.calls += 1;
    this.lastRequestBody = JSON.parse(input.body);
    const raw = await this.delegate.send(input);
    this.lastRaw = raw;
    return raw;
  }
}

function derived(raw: AnthropicRawResponse): { truncated: AnthropicRawResponse; malformed: AnthropicRawResponse } {
  const firstData = raw.body.indexOf("data: {");
  if (firstData < 0) throw new Error("live Anthropic recording did not contain an SSE JSON data frame");
  return {
    truncated: { ...raw, streamComplete: false, body: raw.body.slice(0, Math.max(0, Math.floor(raw.body.length / 2))) },
    malformed: { ...raw, body: `${raw.body.slice(0, firstData + 6)}!${raw.body.slice(firstData + 6)}` },
  };
}

function withDeadline(request: SemanticRequest, deadlineMs: number, signal: AbortSignal): SemanticRequest {
  return { ...request, limits: { ...request.limits, deadlineMs }, signal };
}

async function smoke(
  profile: ModelProfile,
  credential: ResolvedProviderCredential,
  kind: "cancelled" | "timeout",
): Promise<{ record: LiveSmokeRecord; requests: number }> {
  const transport = new CapturingTransport();
  const adapter = new AnthropicAdapter(transport);
  const controller = new AbortController();
  const base = LIVE_RECORDING_REQUESTS["representation-comprehensive"](controller.signal);
  const request = kind === "cancelled" ? withDeadline(base, 30_000, controller.signal) : withDeadline(base, 1, controller.signal);
  const started = Date.now();
  let cancelTimer: ReturnType<typeof setTimeout> | undefined;
  if (kind === "cancelled") cancelTimer = setTimeout(() => controller.abort(new DOMException("conformance cancellation", "AbortError")), 50);
  const outcome = await adapter.request(profile, credential, request);
  if (cancelTimer) clearTimeout(cancelTimer);
  const durationMs = Date.now() - started;
  const passed = !outcome.ok && outcome.error.kind === kind && durationMs < 5_000 && transport.calls === 1;
  return {
    requests: transport.calls,
    record: { passed, errorKind: kind, durationMs, providerRequests: transport.calls, promptAbort: durationMs < 5_000 },
  };
}

export interface LiveRecordResult {
  readonly record: ConformanceRecord;
  readonly providerRequests: number;
}

export async function recordAnthropicConformance(
  profile: ModelProfile,
  credential: ResolvedProviderCredential,
): Promise<LiveRecordResult> {
  if (profile.id !== "anthropic:claude-opus-5") throw new Error(`live recording is restricted to anthropic:claude-opus-5, received ${profile.id}`);
  const rawResponses: Record<string, RecordedRawResponse> = {};
  let providerRequests = 0;

  for (const [key, createRequest] of Object.entries(LIVE_RECORDING_REQUESTS)) {
    const transport = new CapturingTransport();
    const adapter = new AnthropicAdapter(transport);
    const outcome = await adapter.request(profile, credential, createRequest());
    providerRequests += transport.calls;
    if (!outcome.ok) throw new Error(`live conformance '${key}' failed: ${outcome.error.kind}: ${outcome.error.message}`);
    if (!transport.lastRaw) throw new Error(`live conformance '${key}' captured no raw response`);
    rawResponses[key] = {
      origin: "live-recorded",
      canonicalPayload: outcome.value.payload,
      response: transport.lastRaw,
      sanitizedRequestBody: transport.lastRequestBody,
    };
  }

  const representation = rawResponses["representation-comprehensive"]!.response as AnthropicRawResponse;
  const adverse = derived(representation);
  rawResponses["derived-truncated"] = {
    origin: "derived-from-recording",
    response: adverse.truncated,
    derivedFrom: "representation-comprehensive",
    derivation: "body truncated at deterministic midpoint and marked stream-incomplete",
  };
  rawResponses["derived-malformed"] = {
    origin: "derived-from-recording",
    response: adverse.malformed,
    derivedFrom: "representation-comprehensive",
    derivation: "first SSE JSON data frame made syntactically invalid by one inserted byte",
  };

  const cancellation = await smoke(profile, credential, "cancelled");
  const timeout = await smoke(profile, credential, "timeout");
  providerRequests += cancellation.requests + timeout.requests;
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
  const provisionalBody: ConformanceRecordBody = {
    format: "rb-adapter-conformance-record/v1",
    producer: "rb-harness-conformance-runner",
    profileId: profile.id,
    transport: profile.transport,
    suiteVersion: CONFORMANCE_SUITE_VERSION,
    ...identity,
    rawResponses,
    liveSmoke: { cancellation: cancellation.record, timeout: timeout.record },
    result: provisionalResult,
  };
  const provisional = sealRecord(provisionalBody);
  const result = replayConformance({ adapter: new AnthropicAdapter(), profile, cases: CONFORMANCE_CASES, record: provisional });
  return { record: sealRecord({ ...provisionalBody, result }), providerRequests };
}
