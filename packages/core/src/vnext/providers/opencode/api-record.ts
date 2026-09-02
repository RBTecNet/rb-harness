import type { ModelProfile, ResolvedProviderCredential, SemanticRequest } from "../contract.js";
import { measured } from "../contract.js";
import { OpenCodeApiAdapter, FetchOpenCodeApiTransport, type OpenCodeApiTransport, type OpenCodeApiTransportInput } from "./api-adapter.js";
import type { OpenCodeApiRawResponse } from "./api-normalize.js";
import { OPENCODE_API_PROFILES } from "./profiles.js";
import { CONFORMANCE_CASES, LIVE_RECORDING_REQUESTS } from "../conformance/fixtures.js";
import { newRunIdentity, sealRecord, type ConformanceRecord, type ConformanceRecordBody, type LiveSmokeRecord, type RecordedRawResponse } from "../conformance/recording.js";
import { replayConformance } from "../conformance/runner.js";
import { CONFORMANCE_SUITE_VERSION, type ConformanceResult } from "../conformance/suite.js";

class CapturingTransport implements OpenCodeApiTransport {
  calls = 0;
  raw?: OpenCodeApiRawResponse;
  requestBody?: unknown;
  constructor(private readonly delegate: OpenCodeApiTransport = new FetchOpenCodeApiTransport()) {}
  async send(input: OpenCodeApiTransportInput): Promise<OpenCodeApiRawResponse> {
    this.calls += 1;
    this.requestBody = JSON.parse(input.body);
    return this.raw = await this.delegate.send(input);
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stripReasoning(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripReasoning).filter((item) => item !== undefined);
  const source = object(value);
  if (!source) return value;
  if (source.type === "reasoning" || source.type === "thinking") return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(source)) {
    if (/reasoning_(?:text|content)|thinking/i.test(key)) continue;
    const safe = stripReasoning(child);
    if (safe !== undefined) result[key] = safe;
  }
  return result;
}

export function sanitizeOpenCodeApiRawForRecord(raw: OpenCodeApiRawResponse): OpenCodeApiRawResponse {
  const frames = raw.body.split(/\r?\n\r?\n/).filter((frame) => frame.trim()).flatMap((frame) => {
    if (frame.includes("data: [DONE]")) return [frame];
    const event = frame.split(/\r?\n/).find((line) => line.startsWith("event:"))?.slice(6).trim();
    if (event?.includes("reasoning") || event?.includes("thinking")) return [];
    const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart());
    if (!data.length) return [frame];
    try {
      const safe = stripReasoning(JSON.parse(data.join("\n")));
      return safe === undefined ? [] : [[...(event ? [`event: ${event}`] : []), `data: ${JSON.stringify(safe)}`].join("\n")];
    } catch { return [frame]; }
  });
  return { ...raw, body: frames.length ? `${frames.join("\n\n")}\n\n` : "" };
}

export function assertOpenCodeRecordSanitized(candidate: unknown, activeSecret: string): void {
  if (!activeSecret) throw new Error("cannot verify OpenCode record sanitization without the active credential");
  if ((JSON.stringify(candidate) ?? "").includes(activeSecret)) throw new Error("OpenCode record candidate contains active credential material");
}

function derived(raw: OpenCodeApiRawResponse): { truncated: OpenCodeApiRawResponse; malformed: OpenCodeApiRawResponse } {
  const data = raw.body.indexOf("data:");
  if (data < 0) throw new Error("live OpenCode API recording contained no SSE data frame");
  return {
    truncated: { ...raw, streamComplete: false, body: raw.body.slice(0, Math.floor(raw.body.length / 2)) },
    malformed: { ...raw, body: `${raw.body.slice(0, data + 5)} !${raw.body.slice(data + 5)}` },
  };
}

async function smoke(profile: ModelProfile, credential: ResolvedProviderCredential, kind: "cancelled" | "timeout"): Promise<{ record: LiveSmokeRecord; calls: number }> {
  const transport = new CapturingTransport();
  const adapter = new OpenCodeApiAdapter(transport);
  const controller = new AbortController();
  const base = LIVE_RECORDING_REQUESTS["representation-comprehensive"](controller.signal);
  const request: SemanticRequest = { ...base, limits: { ...base.limits, deadlineMs: kind === "timeout" ? 1 : 30_000 } };
  const started = Date.now();
  const timer = kind === "cancelled" ? setTimeout(() => controller.abort(), 50) : undefined;
  const outcome = await adapter.request(profile, { kind: "credential", credential }, request);
  if (timer) clearTimeout(timer);
  const durationMs = Date.now() - started;
  return { calls: transport.calls, record: {
    passed: !outcome.ok && outcome.error.kind === kind && transport.calls === 1, errorKind: kind, durationMs,
    providerRequests: transport.calls, transportInvocations: transport.calls, promptAbort: durationMs < 5_000,
  } };
}

export async function recordOpenCodeApiConformance(profile: ModelProfile, credential: ResolvedProviderCredential): Promise<{ record: ConformanceRecord; providerRequests: number }> {
  if (!OPENCODE_API_PROFILES.some((item) => item.id === profile.id && item.modelId === profile.modelId)) throw new Error(`live OpenCode API recording is restricted to declared profiles, received ${profile.id}`);
  const rawResponses: Record<string, RecordedRawResponse> = {};
  let providerRequests = 0;
  for (const [key, createRequest] of Object.entries(LIVE_RECORDING_REQUESTS)) {
    const transport = new CapturingTransport();
    const adapter = new OpenCodeApiAdapter(transport);
    const outcome = await adapter.request(profile, { kind: "credential", credential }, createRequest());
    providerRequests += transport.calls;
    if (!outcome.ok || !transport.raw) throw new Error(`live OpenCode API conformance '${key}' failed safely`);
    const response = sanitizeOpenCodeApiRawForRecord(transport.raw);
    const entry: RecordedRawResponse = { origin: "live-recorded", canonicalPayload: outcome.value.payload, response, sanitizedRequestBody: transport.requestBody };
    assertOpenCodeRecordSanitized(entry, credential.secret);
    rawResponses[key] = entry;
  }
  const adverse = derived(rawResponses["representation-comprehensive"]!.response as OpenCodeApiRawResponse);
  rawResponses["derived-truncated"] = { origin: "derived-from-recording", response: adverse.truncated, derivedFrom: "representation-comprehensive", derivation: "stream truncated deterministically" };
  rawResponses["derived-malformed"] = { origin: "derived-from-recording", response: adverse.malformed, derivedFrom: "representation-comprehensive", derivation: "first SSE data field made malformed" };
  const cancellation = await smoke(profile, credential, "cancelled");
  const timeout = await smoke(profile, credential, "timeout");
  providerRequests += cancellation.calls + timeout.calls;
  const identity = newRunIdentity();
  const provisionalResult: ConformanceResult = { profileId: profile.id, suiteVersion: CONFORMANCE_SUITE_VERSION, ...identity, tier: "UNSUPPORTED", cases: [], normalizationsOnHappyPath: [], capabilitiesActuallyTested: [] };
  const body: ConformanceRecordBody = {
    format: "rb-adapter-conformance-record/v1", producer: "rb-harness-conformance-runner", profileId: profile.id,
    providerFamily: profile.family, modelId: profile.modelId, transport: profile.transport, requestAccounting: profile.requestAccounting,
    suiteVersion: CONFORMANCE_SUITE_VERSION, ...identity, rawResponses, liveSmoke: { cancellation: cancellation.record, timeout: timeout.record }, result: provisionalResult,
  };
  assertOpenCodeRecordSanitized(body, credential.secret);
  const provisional = sealRecord(body);
  const result = replayConformance({ adapter: new OpenCodeApiAdapter(), profile, cases: CONFORMANCE_CASES, record: provisional });
  const record = sealRecord({ ...body, result });
  assertOpenCodeRecordSanitized(record, credential.secret);
  return { record, providerRequests };
}
