import { unmeasured, type ModelProfile, type ResolvedProviderAuth, type SemanticRequest } from "../contract.js";
import { decodeOpenCodeSessionExport, OpenCodeCliAdapter, SpawnOpenCodeProcess, type OpenCodeCommandInput, type OpenCodeCommandResult, type OpenCodeProcess } from "./cli-adapter.js";
import { decodeOpenCodeCliJsonl, observeOpenCodeCli, type OpenCodeCliRawResponse } from "./cli-normalize.js";
import { openCodeProfileConfiguration } from "./profiles.js";
import { LIVE_RECORDING_REQUESTS } from "../conformance/fixtures.js";
import { OPENCODE_CLI_CONFORMANCE_CASES } from "./cli-fixtures.js";
import { newRunIdentity, sealRecord, type ConformanceRecord, type ConformanceRecordBody, type LiveSmokeRecord, type RecordedRawResponse } from "../conformance/recording.js";
import { replayConformance } from "../conformance/runner.js";
import { CONFORMANCE_SUITE_VERSION, type ConformanceResult } from "../conformance/suite.js";

class CapturingProcess implements OpenCodeProcess {
  calls = 0;
  readonly invocations: Array<{ input: OpenCodeCommandInput; result: OpenCodeCommandResult }> = [];
  get modelBearingCalls(): number { return this.invocations.filter((item) => item.input.args.includes("run")).length; }
  get metadataCalls(): number { return this.invocations.filter((item) => item.input.args.includes("export")).length; }
  get modelResult(): OpenCodeCommandResult | undefined { return this.invocations.find((item) => item.input.args.includes("run"))?.result; }
  get metadataResult(): OpenCodeCommandResult | undefined { return this.invocations.find((item) => item.input.args.includes("export"))?.result; }
  constructor(private readonly delegate: OpenCodeProcess = new SpawnOpenCodeProcess()) {}
  async run(input: OpenCodeCommandInput): Promise<OpenCodeCommandResult> {
    this.calls += 1;
    const result = await this.delegate.run(input);
    this.invocations.push({ input, result });
    return result;
  }
}

function rawFrom(result: OpenCodeCommandResult, metadata: OpenCodeCommandResult): OpenCodeCliRawResponse {
  const identity = decodeOpenCodeSessionExport(metadata.stdout);
  if (!identity) throw new Error("live OpenCode CLI session export was not valid identity evidence");
  const decoded = decodeOpenCodeCliJsonl(result.stdout, {
    exitCode: result.exitCode, startedAt: result.startedAt, completedAt: result.completedAt,
    ...(result.firstOutputMs === undefined ? {} : { firstOutputMs: result.firstOutputMs }),
    streamComplete: result.exitCode !== null, treeQuiescent: result.settlement.quiescent, treeVerified: result.settlement.verified,
    assistantMessageCount: identity.assistantMessageCount, observedModelIds: identity.observedModelIds,
  });
  if (!decoded.ok) throw new Error("live OpenCode CLI output was not recordable JSONL");
  return decoded.value;
}

function recordObject(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`OpenCode CLI record contains invalid structure at ${path}`);
  }
  return value as Record<string, unknown>;
}

function exactRecordKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const permitted = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !permitted.has(key));
  if (unexpected.length) throw new Error(`OpenCode CLI record contains forbidden structural field at ${path}.${unexpected.sort()[0]}`);
}

/**
 * The JSONL and session-export decoders are the content privacy boundary. This
 * final guard validates their recorded shape without treating arbitrary model
 * text as metadata merely because it contains words such as "account".
 */
export function assertOpenCodeCliRecordSanitized(candidate: unknown): void {
  const root = recordObject(candidate, "$record");
  exactRecordKeys(root, [
    "format", "producer", "profileId", "transport", "requestAccounting", "providerFamily", "modelId",
    "transportVersion", "suiteVersion", "runId", "recordedAt", "rawResponses", "liveSmoke",
    "externalCliEvidence", "result", "integritySha256",
  ], "$record");

  const rawResponses = recordObject(root.rawResponses, "$record.rawResponses");
  for (const [recordingKey, rawValue] of Object.entries(rawResponses)) {
    const raw = recordObject(rawValue, `$record.rawResponses.${recordingKey}`);
    exactRecordKeys(raw, ["origin", "canonicalPayload", "response", "derivedFrom", "derivation", "semanticNormalizationRequired"], `$record.rawResponses.${recordingKey}`);
    const response = recordObject(raw.response, `$record.rawResponses.${recordingKey}.response`);
    exactRecordKeys(response, [
      "events", "toolEventsObserved", "assistantMessageCount", "observedModelIds", "exitCode", "startedAt",
      "completedAt", "firstOutputMs", "streamComplete", "treeQuiescent", "treeVerified",
    ], `$record.rawResponses.${recordingKey}.response`);
    if (!Array.isArray(response.events)) throw new Error(`OpenCode CLI record contains invalid events at $record.rawResponses.${recordingKey}.response.events`);
    response.events.forEach((eventValue, index) => {
      const path = `$record.rawResponses.${recordingKey}.response.events[${index}]`;
      const event = recordObject(eventValue, path);
      switch (event.kind) {
        case "text": exactRecordKeys(event, ["kind", "id", "text"], path); break;
        case "step-start": exactRecordKeys(event, ["kind", "modelId", "messageId"], path); break;
        case "step-finish": {
          exactRecordKeys(event, ["kind", "reason", "usage"], path);
          if (event.usage !== undefined) exactRecordKeys(recordObject(event.usage, `${path}.usage`), ["input", "output", "reasoning", "cacheRead", "cacheWrite", "cost"], `${path}.usage`);
          break;
        }
        case "complete": exactRecordKeys(event, ["kind"], path); break;
        case "error": exactRecordKeys(event, ["kind", "classification"], path); break;
        default: throw new Error(`OpenCode CLI record contains forbidden event structure at ${path}`);
      }
    });
  }

  const evidence = recordObject(root.externalCliEvidence, "$record.externalCliEvidence");
  exactRecordKeys(evidence, [
    "format", "executable", "transportVersion", "requestedModel", "transportInvocations",
    "observedProviderRequests", "invocationPolicy", "invocations",
  ], "$record.externalCliEvidence");
  if (!Array.isArray(evidence.invocations)) throw new Error("OpenCode CLI record contains invalid invocation evidence");
  evidence.invocations.forEach((invocationValue, index) => exactRecordKeys(recordObject(invocationValue, `$record.externalCliEvidence.invocations[${index}]`), [
    "id", "recordingKey", "transportInvocations", "processCompleted", "treeQuiescent", "treeVerified",
    "observedModelIds", "toolEventsObserved",
  ], `$record.externalCliEvidence.invocations[${index}]`));
}

async function smoke(profile: ModelProfile, auth: ResolvedProviderAuth, kind: "cancelled" | "timeout"): Promise<{ record: LiveSmokeRecord; calls: number }> {
  const processClient = new CapturingProcess();
  const adapter = new OpenCodeCliAdapter(processClient);
  const controller = new AbortController();
  const base = LIVE_RECORDING_REQUESTS["representation-comprehensive"](controller.signal);
  const request: SemanticRequest = { ...base, limits: { ...base.limits, deadlineMs: kind === "timeout" ? 1 : 30_000 } };
  const started = Date.now();
  const timer = kind === "cancelled" ? setTimeout(() => controller.abort(), 50) : undefined;
  const outcome = await adapter.request(profile, auth, request);
  if (timer) clearTimeout(timer);
  const durationMs = Date.now() - started;
  const settlement = processClient.modelResult?.settlement;
  return { calls: processClient.calls, record: {
    passed: !outcome.ok && outcome.error.kind === kind, errorKind: kind, durationMs,
    providerRequestMeasurement: unmeasured("unsupported-by-provider"), transportInvocations: processClient.calls,
    promptAbort: durationMs < 5_000, treeQuiescent: settlement?.quiescent === true, treeVerified: settlement?.verified === true,
  } };
}

export async function recordOpenCodeCliConformance(profile: ModelProfile, auth: ResolvedProviderAuth): Promise<{ record: ConformanceRecord; transportInvocations: number }> {
  const config = openCodeProfileConfiguration(profile);
  if (profile.family !== "opencode" || profile.transport !== "opencode-cli" || config?.mode !== "cli" || config.modelSelector !== profile.modelId) {
    throw new Error(`live OpenCode CLI recording requires an exact admitted CLI profile, received ${profile.id}`);
  }
  if (auth.kind !== "ambient-session") throw new Error("OpenCode CLI recording requires ambient authentication");
  const preflightAdapter = new OpenCodeCliAdapter();
  const runtime = await preflightAdapter.runtimePreflight();
  if (!runtime.ok) throw new Error(runtime.error.message);
  const rawResponses: Record<string, RecordedRawResponse> = {};
  const invocations: Array<{ id: string; recordingKey: string; transportInvocations: 1; processCompleted: boolean; treeQuiescent: boolean; treeVerified: boolean; observedModelIds: readonly string[]; toolEventsObserved: number }> = [];
  let transportInvocations = 0;
  const identities = { "representation-comprehensive": "valid-structured-response", "semantic-incomplete": "semantically-incomplete" } as const;
  for (const [key, createRequest] of Object.entries(LIVE_RECORDING_REQUESTS)) {
    const processClient = new CapturingProcess();
    const adapter = new OpenCodeCliAdapter(processClient);
    const outcome = await adapter.request(profile, auth, createRequest());
    transportInvocations += processClient.calls;
    if (!outcome.ok || !processClient.modelResult || !processClient.metadataResult
      || processClient.modelBearingCalls !== 1 || processClient.metadataCalls !== 1) {
      throw new Error(`live OpenCode CLI conformance '${key}' failed safely`);
    }
    const response = rawFrom(processClient.modelResult, processClient.metadataResult);
    const observation = observeOpenCodeCli(response)!;
    rawResponses[key] = { origin: "live-recorded", canonicalPayload: outcome.value.payload, response };
    invocations.push({ id: identities[key as keyof typeof identities], recordingKey: key, transportInvocations: 1,
      processCompleted: response.streamComplete, treeQuiescent: response.treeQuiescent, treeVerified: response.treeVerified,
      observedModelIds: observation.modelIds, toolEventsObserved: observation.toolEventsObserved ?? 0 });
  }
  const representation = rawResponses["representation-comprehensive"]!.response as OpenCodeCliRawResponse;
  rawResponses["derived-truncated"] = { origin: "derived-from-recording", response: { ...representation, streamComplete: false }, derivedFrom: "representation-comprehensive", derivation: "stream completion removed" };
  rawResponses["derived-malformed"] = { origin: "derived-from-recording", response: {
    ...representation, events: [{ kind: "step-start", modelId: profile.modelId }, { kind: "text", id: "visible", text: "{" }],
  }, derivedFrom: "representation-comprehensive", derivation: "visible JSON made malformed" };
  const cancellation = await smoke(profile, auth, "cancelled");
  const timeout = await smoke(profile, auth, "timeout");
  transportInvocations += cancellation.calls + timeout.calls;
  const identity = newRunIdentity();
  const provisionalResult: ConformanceResult = { profileId: profile.id, suiteVersion: CONFORMANCE_SUITE_VERSION, ...identity, tier: "UNSUPPORTED", cases: [], normalizationsOnHappyPath: [], capabilitiesActuallyTested: [] };
  const body: ConformanceRecordBody = {
    format: "rb-adapter-conformance-record/v1", producer: "rb-harness-conformance-runner", profileId: profile.id,
    providerFamily: profile.family, modelId: profile.modelId, transport: profile.transport, requestAccounting: profile.requestAccounting,
    transportVersion: runtime.value.transportVersion, suiteVersion: CONFORMANCE_SUITE_VERSION, ...identity, rawResponses,
    liveSmoke: { cancellation: cancellation.record, timeout: timeout.record },
    externalCliEvidence: {
      format: "rb-external-cli-evidence/v1", executable: runtime.value.executable, transportVersion: runtime.value.transportVersion,
      requestedModel: profile.modelId, transportInvocations: invocations.length, observedProviderRequests: unmeasured("unsupported-by-provider"),
      invocationPolicy: preflightAdapter.currentExternalCliInvocationPolicy(profile), invocations,
    }, result: provisionalResult,
  };
  assertOpenCodeCliRecordSanitized(body);
  const provisional = sealRecord(body);
  const result = replayConformance({ adapter: new OpenCodeCliAdapter(), profile, cases: OPENCODE_CLI_CONFORMANCE_CASES, record: provisional });
  const record = sealRecord({ ...body, result });
  assertOpenCodeCliRecordSanitized(record);
  return { record, transportInvocations };
}
