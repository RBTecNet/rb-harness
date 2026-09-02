import type { ModelProfile, ResolvedProviderCredential, SemanticRequest } from "../contract.js";
import {
  FetchOpenAiTransport,
  OpenAiAdapter,
  type OpenAiTransport,
  type OpenAiTransportInput,
} from "./adapter.js";
import type { OpenAiRawResponse } from "./normalize.js";
import { OPENAI_PROFILES } from "./profiles.js";
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

class CapturingTransport implements OpenAiTransport {
  calls = 0;
  lastRaw: OpenAiRawResponse | undefined;
  lastRequestBody: unknown;

  constructor(private readonly delegate: OpenAiTransport = new FetchOpenAiTransport()) {}

  async send(input: OpenAiTransportInput): Promise<OpenAiRawResponse> {
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

function safeError(value: unknown): Record<string, string> {
  const source = object(value) ?? {};
  const result: Record<string, string> = {};
  if (typeof source.type === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(source.type)) result.type = source.type;
  if (typeof source.code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(source.code)) result.code = source.code;
  if (typeof source.param === "string" && /^[A-Za-z0-9_.\[\]-]{1,128}$/.test(source.param)) result.param = source.param;
  return result;
}

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeValue).filter((entry) => entry !== undefined);
  const source = object(value);
  if (!source) return value;
  if (source.type === "reasoning" || source.type === "reasoning_text") return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(source)) {
    if (key === "reasoning" || key === "reasoning_text" || key === "reasoning_content") continue;
    if (key === "error") {
      result.error = safeError(entry);
      continue;
    }
    const sanitized = sanitizeValue(entry);
    if (sanitized !== undefined) result[key] = sanitized;
  }
  return result;
}

function sanitizeFrame(frame: string): string | undefined {
  const lines = frame.split(/\r?\n/);
  const eventName = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
  const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart());
  if (!data.length) return frame;
  let parsed: unknown;
  try { parsed = JSON.parse(data.join("\n")); } catch { return frame; }
  const source = object(parsed);
  const type = typeof source?.type === "string" ? source.type : eventName;
  if (type?.includes("reasoning")) return undefined;
  const sanitized = sanitizeValue(parsed);
  if (sanitized === undefined) return undefined;
  return [
    ...(eventName ? [`event: ${eventName}`] : []),
    `data: ${JSON.stringify(sanitized)}`,
  ].join("\n");
}

export function sanitizeOpenAiRawResponseForRecord(raw: OpenAiRawResponse): OpenAiRawResponse {
  const frames = raw.body
    .split(/\r?\n\r?\n/)
    .filter((frame) => frame.trim())
    .map(sanitizeFrame)
    .filter((frame): frame is string => frame !== undefined);
  return {
    ...raw,
    headers: Object.fromEntries(Object.entries(raw.headers).filter(([key]) => (
      ["content-type", "request-id", "x-request-id", "openai-request-id"].includes(key)
    ))),
    body: frames.length ? `${frames.join("\n\n")}\n\n` : "",
  };
}

export function assertOpenAiRecordCandidateSanitized(candidate: unknown, activeSecret: string): void {
  if (!activeSecret) throw new Error("cannot verify OpenAI record sanitization without the active credential");
  if ((JSON.stringify(candidate) ?? "").includes(activeSecret)) {
    throw new Error("OpenAI record candidate contains active credential material");
  }
}

function derived(raw: OpenAiRawResponse): { truncated: OpenAiRawResponse; malformed: OpenAiRawResponse } {
  const firstData = raw.body.indexOf("data: {");
  if (firstData < 0) throw new Error("live OpenAI recording did not contain an SSE JSON data frame");
  return {
    truncated: { ...raw, streamComplete: false, body: raw.body.slice(0, Math.floor(raw.body.length / 2)) },
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
  const adapter = new OpenAiAdapter(transport);
  const controller = new AbortController();
  const base = LIVE_RECORDING_REQUESTS["representation-comprehensive"](controller.signal);
  const request = kind === "cancelled"
    ? withDeadline(base, 30_000, controller.signal)
    : withDeadline(base, 1, controller.signal);
  const started = Date.now();
  const timer = kind === "cancelled" ? setTimeout(() => controller.abort(), 50) : undefined;
  const outcome = await adapter.request(profile, { kind: "credential", credential }, request);
  if (timer) clearTimeout(timer);
  const durationMs = Date.now() - started;
  const passed = !outcome.ok && outcome.error.kind === kind && durationMs < 5_000 && transport.calls === 1;
  return {
    requests: transport.calls,
    record: { passed, errorKind: kind, durationMs, providerRequests: transport.calls, promptAbort: durationMs < 5_000 },
  };
}

/** Invoked only by the explicit conformance recording path. */
export async function recordOpenAiConformance(
  profile: ModelProfile,
  credential: ResolvedProviderCredential,
): Promise<{ readonly record: ConformanceRecord; readonly providerRequests: number }> {
  if (!OPENAI_PROFILES.some((candidate) => candidate.id === profile.id && candidate.modelId === profile.modelId)) {
    throw new Error(`live recording is restricted to declared OpenAI profiles, received ${profile.id}`);
  }
  const rawResponses: Record<string, RecordedRawResponse> = {};
  let providerRequests = 0;
  for (const [key, makeRequest] of Object.entries(LIVE_RECORDING_REQUESTS)) {
    const transport = new CapturingTransport();
    const adapter = new OpenAiAdapter(transport);
    const outcome = await adapter.request(profile, { kind: "credential", credential }, makeRequest());
    providerRequests += transport.calls;
    if (!outcome.ok) throw new Error(`live OpenAI conformance '${key}' failed safely`);
    if (!transport.lastRaw) throw new Error(`live OpenAI conformance '${key}' captured no raw response`);
    const entry: RecordedRawResponse = {
      origin: "live-recorded",
      canonicalPayload: outcome.value.payload,
      response: sanitizeOpenAiRawResponseForRecord(transport.lastRaw),
      sanitizedRequestBody: transport.lastRequestBody,
    };
    assertOpenAiRecordCandidateSanitized(entry, credential.secret);
    rawResponses[key] = entry;
  }
  const representation = rawResponses["representation-comprehensive"]!.response as OpenAiRawResponse;
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
  const placeholder: ConformanceResult = {
    profileId: profile.id,
    suiteVersion: CONFORMANCE_SUITE_VERSION,
    ...identity,
    tier: "UNSUPPORTED",
    cases: [],
    normalizationsOnHappyPath: [],
    capabilitiesActuallyTested: [],
  };
  const body: ConformanceRecordBody = {
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
    result: placeholder,
  };
  assertOpenAiRecordCandidateSanitized(body, credential.secret);
  const provisional = sealRecord(body);
  const result = replayConformance({ adapter: new OpenAiAdapter(), profile, cases: CONFORMANCE_CASES, record: provisional });
  const record = sealRecord({ ...body, result });
  assertOpenAiRecordCandidateSanitized(record, credential.secret);
  return { record, providerRequests };
}
