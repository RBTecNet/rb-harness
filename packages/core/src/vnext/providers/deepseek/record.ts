import type { ModelProfile, ResolvedProviderCredential, SemanticRequest } from "../contract.js";
import {
  DeepSeekAdapter,
  FetchDeepSeekTransport,
  type DeepSeekTransport,
  type DeepSeekTransportInput,
} from "./adapter.js";
import type { DeepSeekRawResponse } from "./normalize.js";
import { DEEPSEEK_PROFILES } from "./profiles.js";
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

class CapturingTransport implements DeepSeekTransport {
  calls = 0;
  lastRaw: DeepSeekRawResponse | undefined;
  lastRequestBody: unknown;

  constructor(private readonly delegate: DeepSeekTransport = new FetchDeepSeekTransport()) {}

  async send(input: DeepSeekTransportInput): Promise<DeepSeekRawResponse> {
    this.calls += 1;
    this.lastRequestBody = JSON.parse(input.body);
    const raw = await this.delegate.send(input);
    this.lastRaw = raw;
    return raw;
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stripReasoningValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map(stripReasoningValue)
      .filter((entry) => entry !== undefined);
  }
  const source = object(value);
  if (!source) return value;
  if (source.type === "reasoning" || source.type === "reasoning_text") return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(source)) {
    if (key === "reasoning_text" || key === "reasoning_content") continue;
    const sanitized = stripReasoningValue(entry);
    if (sanitized !== undefined) result[key] = sanitized;
  }
  return result;
}

function sanitizeSseFrame(frame: string): string | undefined {
  const lines = frame.split(/\r?\n/);
  const eventName = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
  const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart());
  if (!data.length) return frame;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.join("\n"));
  } catch {
    return frame;
  }
  const event = object(parsed);
  const type = typeof event?.type === "string" ? event.type : eventName;
  if (type?.startsWith("response.reasoning_text.")) return undefined;
  if (object(event?.item)?.type === "reasoning" || object(event?.part)?.type === "reasoning_text") return undefined;
  const sanitized = stripReasoningValue(parsed);
  if (sanitized === undefined) return undefined;
  return [
    ...(eventName ? [`event: ${eventName}`] : []),
    `data: ${JSON.stringify(sanitized)}`,
  ].join("\n");
}

/** Remove chain-of-thought events/items before a raw response can be persisted. */
export function sanitizeDeepSeekRawResponseForRecord(raw: DeepSeekRawResponse): DeepSeekRawResponse {
  const sanitizedFrames = raw.body
    .split(/\r?\n\r?\n/)
    .filter((frame) => frame.trim())
    .map(sanitizeSseFrame)
    .filter((frame): frame is string => frame !== undefined);
  return { ...raw, body: sanitizedFrames.length ? `${sanitizedFrames.join("\n\n")}\n\n` : "" };
}

/** Exact-secret guard used before sealing or returning any DeepSeek record. */
export function assertDeepSeekRecordCandidateSanitized(candidate: unknown, activeSecret: string): void {
  if (!activeSecret) throw new Error("cannot verify DeepSeek record sanitization without the active credential");
  const serialized = JSON.stringify(candidate) ?? "";
  if (serialized.includes(activeSecret)) throw new Error("DeepSeek record candidate contains active credential material");
}

function derived(raw: DeepSeekRawResponse): { truncated: DeepSeekRawResponse; malformed: DeepSeekRawResponse } {
  const firstData = raw.body.indexOf("data: {");
  if (firstData < 0) throw new Error("live DeepSeek recording did not contain an SSE JSON data frame");
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
  const adapter = new DeepSeekAdapter(transport);
  const controller = new AbortController();
  const base = LIVE_RECORDING_REQUESTS["representation-comprehensive"](controller.signal);
  const request = kind === "cancelled"
    ? withDeadline(base, 30_000, controller.signal)
    : withDeadline(base, 1, controller.signal);
  const started = Date.now();
  let cancelTimer: ReturnType<typeof setTimeout> | undefined;
  if (kind === "cancelled") {
    cancelTimer = setTimeout(() => controller.abort(new DOMException("conformance cancellation", "AbortError")), 50);
  }
  const outcome = await adapter.request(profile, { kind: "credential", credential }, request);
  if (cancelTimer) clearTimeout(cancelTimer);
  const durationMs = Date.now() - started;
  const passed = !outcome.ok && outcome.error.kind === kind && durationMs < 5_000 && transport.calls === 1;
  return {
    requests: transport.calls,
    record: { passed, errorKind: kind, durationMs, providerRequests: transport.calls, promptAbort: durationMs < 5_000 },
  };
}

export interface DeepSeekLiveRecordResult {
  readonly record: ConformanceRecord;
  readonly providerRequests: number;
}

/** Invoked only by the explicit `conformance --record` path. */
export async function recordDeepSeekConformance(
  profile: ModelProfile,
  credential: ResolvedProviderCredential,
): Promise<DeepSeekLiveRecordResult> {
  const declared = DEEPSEEK_PROFILES.some((candidate) => (
    candidate.id === profile.id
    && candidate.modelId === profile.modelId
    && candidate.family === profile.family
    && candidate.transport === profile.transport
  ));
  if (!declared) {
    throw new Error(`live recording is restricted to declared DeepSeek profiles, received ${profile.id}/${profile.modelId}`);
  }
  const rawResponses: Record<string, RecordedRawResponse> = {};
  let providerRequests = 0;

  for (const [key, createRequest] of Object.entries(LIVE_RECORDING_REQUESTS)) {
    const transport = new CapturingTransport();
    const adapter = new DeepSeekAdapter(transport);
    const outcome = await adapter.request(profile, { kind: "credential", credential }, createRequest());
    providerRequests += transport.calls;
    if (!outcome.ok) throw new Error(`live DeepSeek conformance '${key}' failed: ${outcome.error.kind}: ${outcome.error.message}`);
    if (!transport.lastRaw) throw new Error(`live DeepSeek conformance '${key}' captured no raw response`);
    const response = sanitizeDeepSeekRawResponseForRecord(transport.lastRaw);
    const entry: RecordedRawResponse = {
      origin: "live-recorded",
      canonicalPayload: outcome.value.payload,
      response,
      sanitizedRequestBody: transport.lastRequestBody,
    };
    assertDeepSeekRecordCandidateSanitized(entry, credential.secret);
    rawResponses[key] = entry;
  }

  const representation = rawResponses["representation-comprehensive"]!.response as DeepSeekRawResponse;
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
    providerFamily: profile.family,
    modelId: profile.modelId,
    transport: profile.transport,
    requestAccounting: profile.requestAccounting,
    suiteVersion: CONFORMANCE_SUITE_VERSION,
    ...identity,
    rawResponses,
    liveSmoke: { cancellation: cancellation.record, timeout: timeout.record },
    result: provisionalResult,
  };
  assertDeepSeekRecordCandidateSanitized(provisionalBody, credential.secret);
  const provisional = sealRecord(provisionalBody);
  const result = replayConformance({ adapter: new DeepSeekAdapter(), profile, cases: CONFORMANCE_CASES, record: provisional });
  const record = sealRecord({ ...provisionalBody, result });
  assertDeepSeekRecordCandidateSanitized(record, credential.secret);
  return { record, providerRequests };
}
