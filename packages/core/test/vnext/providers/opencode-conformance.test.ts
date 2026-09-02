import { describe, expect, it, vi } from "vitest";
import { OpenCodeApiAdapter, type OpenCodeApiTransport } from "../../../src/vnext/providers/opencode/api-adapter.js";
import { OpenCodeCliAdapter, type OpenCodeProcess } from "../../../src/vnext/providers/opencode/cli-adapter.js";
import type { OpenCodeCliRawResponse } from "../../../src/vnext/providers/opencode/cli-normalize.js";
import { assertOpenCodeCliRecordSanitized } from "../../../src/vnext/providers/opencode/cli-record.js";
import { OPENCODE_API_PROFILES, OPENCODE_CLI_PROFILES } from "../../../src/vnext/providers/opencode/profiles.js";
import { CONFORMANCE_CASES, REPRESENTATION_PAYLOAD, SEMANTICALLY_INCOMPLETE_PAYLOAD } from "../../../src/vnext/providers/conformance/fixtures.js";
import { OPENCODE_CLI_CONFORMANCE_CASES } from "../../../src/vnext/providers/opencode/cli-fixtures.js";
import { sealRecord, type ConformanceRecord, type ConformanceRecordBody } from "../../../src/vnext/providers/conformance/recording.js";
import { replayConformance, validateConformanceRecord } from "../../../src/vnext/providers/conformance/runner.js";
import { CONFORMANCE_SUITE_VERSION, type ConformanceResult } from "../../../src/vnext/providers/conformance/suite.js";
import { unmeasured, type ExternalCliInvocationPolicyEvidence, type ModelProfile } from "../../../src/vnext/providers/contract.js";

const apiProfile = OPENCODE_API_PROFILES.find((item) => item.id === "opencode:zen:gpt-5.6-luna")!;
const cliProfile = OPENCODE_CLI_PROFILES.find((item) => item.id === "opencode:cli:opencode/gpt-5.6-luna")!;
const startedAt = "2026-09-01T12:00:00.000Z";
const completedAt = "2026-09-01T12:00:01.000Z";

function placeholder(profile: ModelProfile): ConformanceResult {
  return { profileId: profile.id, suiteVersion: CONFORMANCE_SUITE_VERSION, runId: "offline-opencode-run", recordedAt: startedAt,
    tier: "UNSUPPORTED", cases: [], normalizationsOnHappyPath: [], capabilitiesActuallyTested: [] };
}

function responsesRaw(payload: unknown, model = apiProfile.modelId) {
  const body = [
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: JSON.stringify(payload) })}`,
    `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_fixture", model, status: "completed", usage: { input_tokens: 9, input_tokens_details: { cached_tokens: 2 }, output_tokens: 6, output_tokens_details: { reasoning_tokens: 1 } } } })}`,
    "",
  ].join("\n\n");
  return { status: 200, headers: {}, body, startedAt, completedAt, firstOutputMs: 5, streamComplete: true };
}

function noNetworkApi(network = vi.fn()): OpenCodeApiAdapter {
  return new OpenCodeApiAdapter({ async send() { network(); throw new Error("network forbidden"); } } as OpenCodeApiTransport);
}

function apiRecord(): ConformanceRecord {
  const representation = responsesRaw(REPRESENTATION_PAYLOAD);
  const incomplete = responsesRaw(SEMANTICALLY_INCOMPLETE_PAYLOAD);
  const body: ConformanceRecordBody = {
    format: "rb-adapter-conformance-record/v1", producer: "rb-harness-conformance-runner", profileId: apiProfile.id,
    providerFamily: "opencode", modelId: apiProfile.modelId, transport: "direct-api", requestAccounting: "exact",
    suiteVersion: CONFORMANCE_SUITE_VERSION, runId: "offline-opencode-run", recordedAt: startedAt,
    rawResponses: {
      "representation-comprehensive": { origin: "local-transport-fixture", response: representation },
      "semantic-incomplete": { origin: "local-transport-fixture", response: incomplete },
      "derived-truncated": { origin: "derived-from-recording", derivedFrom: "representation-comprehensive", derivation: "offline truncation", response: { ...representation, streamComplete: false } },
      "derived-malformed": { origin: "derived-from-recording", derivedFrom: "representation-comprehensive", derivation: "offline corruption", response: { ...representation, body: "event: response.completed\ndata: {!}\n\n" } },
    },
    liveSmoke: {
      cancellation: { passed: true, errorKind: "cancelled", durationMs: 5, providerRequests: 1, promptAbort: true },
      timeout: { passed: true, errorKind: "timeout", durationMs: 5, providerRequests: 1, promptAbort: true },
    }, result: placeholder(apiProfile),
  };
  const provisional = sealRecord(body);
  return sealRecord({ ...body, result: replayConformance({ adapter: noNetworkApi(), profile: apiProfile, cases: CONFORMANCE_CASES, record: provisional }) });
}

function cliRaw(payload: unknown): OpenCodeCliRawResponse {
  return {
    events: [
      { kind: "step-start", modelId: cliProfile.modelId, messageId: "message_fixture" },
      { kind: "text", id: "visible", text: JSON.stringify(payload) },
      { kind: "step-finish", reason: "stop", usage: { input: 9, cacheRead: 2, output: 6, reasoning: 1, cost: 0.001 } },
      { kind: "complete" },
    ], toolEventsObserved: 0, assistantMessageCount: 1, observedModelIds: [cliProfile.modelId],
    exitCode: 0, startedAt, completedAt, firstOutputMs: 5, streamComplete: true, treeQuiescent: true, treeVerified: true,
  };
}

function noProcessCli(processCall = vi.fn()): OpenCodeCliAdapter {
  return new OpenCodeCliAdapter({ async run() { processCall(); throw new Error("CLI forbidden during replay"); } } as OpenCodeProcess);
}

function cliRecord(): ConformanceRecord {
  const representation = cliRaw(REPRESENTATION_PAYLOAD);
  const incomplete = cliRaw(SEMANTICALLY_INCOMPLETE_PAYLOAD);
  const invocations = [
    { id: "valid-structured-response", recordingKey: "representation-comprehensive", transportInvocations: 1 as const, processCompleted: true, treeQuiescent: true, treeVerified: true, observedModelIds: [cliProfile.modelId], toolEventsObserved: 0 },
    { id: "semantically-incomplete", recordingKey: "semantic-incomplete", transportInvocations: 1 as const, processCompleted: true, treeQuiescent: true, treeVerified: true, observedModelIds: [cliProfile.modelId], toolEventsObserved: 0 },
  ];
  const smoke = (errorKind: "cancelled" | "timeout") => ({ passed: true, errorKind, durationMs: 5, providerRequestMeasurement: unmeasured<number>("unsupported-by-provider"), transportInvocations: 1, promptAbort: true, treeQuiescent: true, treeVerified: true });
  const body: ConformanceRecordBody = {
    format: "rb-adapter-conformance-record/v1", producer: "rb-harness-conformance-runner", profileId: cliProfile.id,
    providerFamily: "opencode", modelId: cliProfile.modelId, transport: "opencode-cli", requestAccounting: "opaque", transportVersion: "1.18.25",
    suiteVersion: CONFORMANCE_SUITE_VERSION, runId: "offline-opencode-run", recordedAt: startedAt,
    rawResponses: {
      "representation-comprehensive": { origin: "local-transport-fixture", response: representation },
      "semantic-incomplete": { origin: "local-transport-fixture", response: incomplete },
      "derived-truncated": { origin: "derived-from-recording", derivedFrom: "representation-comprehensive", derivation: "offline truncation", response: { ...representation, streamComplete: false } },
      "derived-malformed": { origin: "derived-from-recording", derivedFrom: "representation-comprehensive", derivation: "offline malformed JSON", response: {
        ...representation, events: [{ kind: "step-start", modelId: cliProfile.modelId }, { kind: "text", id: "visible", text: "{" }],
      } },
    }, liveSmoke: { cancellation: smoke("cancelled"), timeout: smoke("timeout") },
    externalCliEvidence: {
      format: "rb-external-cli-evidence/v1", executable: "opencode", transportVersion: "1.18.25", requestedModel: cliProfile.modelId,
      transportInvocations: 2, observedProviderRequests: unmeasured("unsupported-by-provider"),
      invocationPolicy: noProcessCli().currentExternalCliInvocationPolicy(cliProfile), invocations,
    }, result: placeholder(cliProfile),
  };
  const provisional = sealRecord(body);
  return sealRecord({ ...body, result: replayConformance({ adapter: noProcessCli(), profile: cliProfile, cases: OPENCODE_CLI_CONFORMANCE_CASES, record: provisional }) });
}

describe("OpenCode offline conformance and replay", () => {
  it("allows arbitrary semantic words while rejecting forbidden CLI record structures", () => {
    const record = cliRecord();
    const representation = record.rawResponses["representation-comprehensive"]!;
    const response = representation.response as OpenCodeCliRawResponse;
    const semanticWords = {
      ...record,
      rawResponses: {
        ...record.rawResponses,
        "representation-comprehensive": {
          ...representation,
          canonicalPayload: { note: "account authorization are legitimate semantic values" },
          response: {
            ...response,
            events: response.events.map((event) => event.kind === "text"
              ? { ...event, text: JSON.stringify({ note: "account authorization" }) }
              : event),
          },
        },
      },
    };
    expect(() => assertOpenCodeCliRecordSanitized(semanticWords)).not.toThrow();

    const withRawField = (field: string) => ({ ...record, [field]: { unsafe: true } });
    for (const field of ["rawExport", "rawSessionData", "authorization", "environment", "stderr"]) {
      expect(() => assertOpenCodeCliRecordSanitized(withRawField(field))).toThrow(/forbidden structural field/);
    }
    for (const field of ["toolArguments", "toolOutput", "reasoning_content", "filesystemPath"]) {
      const unsafe = {
        ...record,
        rawResponses: {
          ...record.rawResponses,
          "representation-comprehensive": {
            ...representation,
            response: { ...response, events: [{ ...response.events[0], [field]: "must-not-persist" }, ...response.events.slice(1)] },
          },
        },
      };
      expect(() => assertOpenCodeCliRecordSanitized(unsafe)).toThrow(/forbidden structural field/);
    }
  });

  it("replays API evidence deterministically with zero network or credentials", () => {
    const network = vi.fn();
    const record = apiRecord();
    const first = validateConformanceRecord({ adapter: noNetworkApi(network), profile: apiProfile, cases: CONFORMANCE_CASES, record });
    const second = validateConformanceRecord({ adapter: noNetworkApi(network), profile: apiProfile, cases: CONFORMANCE_CASES, record });
    expect(first).toEqual(second);
    expect(network).not.toHaveBeenCalled();
    expect(first.cases).toHaveLength(16);
    expect(first.cases.every((item) => item.passed)).toBe(true);
    expect(first.tier).toBe("SUPPORTED");
    expect(apiProfile.conformance).toMatchObject({ tier: "UNSUPPORTED", verifiedRecord: false });
  });

  it("replays CLI evidence deterministically without executable, ambient auth, network, or credentials", () => {
    const processCall = vi.fn();
    const record = cliRecord();
    const first = validateConformanceRecord({ adapter: noProcessCli(processCall), profile: cliProfile, cases: OPENCODE_CLI_CONFORMANCE_CASES, record });
    const second = validateConformanceRecord({ adapter: noProcessCli(processCall), profile: cliProfile, cases: OPENCODE_CLI_CONFORMANCE_CASES, record });
    expect(first).toEqual(second);
    expect(processCall).not.toHaveBeenCalled();
    expect(first.cases).toHaveLength(17);
    expect(first.cases.every((item) => item.passed)).toBe(true);
    expect(first.tier).toBe("SUPPORTED");
    expect(cliProfile.conformance).toMatchObject({ tier: "UNSUPPORTED", verifiedRecord: false });
  });

  it("keeps service, protocol and model evidence isolated", () => {
    const record = apiRecord();
    const wrong = OPENCODE_API_PROFILES.find((item) => item.id === "opencode:go:gpt-5.6-luna")!;
    expect(() => validateConformanceRecord({ adapter: noNetworkApi(), profile: wrong, cases: CONFORMANCE_CASES, record })).toThrow(/belongs to|does not match/);
  });

  it("fails conformance when observed model identity is empty or tool activity occurred", () => {
    const record = cliRecord();
    const emptyIdentity = sealRecord({ ...record, externalCliEvidence: {
      ...record.externalCliEvidence!, invocations: record.externalCliEvidence!.invocations.map((item, index) => index === 0 ? { ...item, observedModelIds: [] } : item),
    } });
    const toolActivity = sealRecord({ ...record, externalCliEvidence: {
      ...record.externalCliEvidence!, invocations: record.externalCliEvidence!.invocations.map((item, index) => index === 0 ? { ...item, toolEventsObserved: 1 } : item),
    } });
    expect(replayConformance({ adapter: noProcessCli(), profile: cliProfile, cases: OPENCODE_CLI_CONFORMANCE_CASES, record: emptyIdentity })
      .cases.find((item) => item.id === "external-cli-evidence")).toMatchObject({ passed: false });
    expect(replayConformance({ adapter: noProcessCli(), profile: cliProfile, cases: OPENCODE_CLI_CONFORMANCE_CASES, record: toolActivity })
      .cases.find((item) => item.id === "external-cli-evidence")).toMatchObject({ passed: false });
  });

  it("binds recorded evidence to the current invocation policy", () => {
    class PolicyChangedAdapter extends OpenCodeCliAdapter {
      override currentExternalCliInvocationPolicy(profile: ModelProfile): ExternalCliInvocationPolicyEvidence {
        return { ...super.currentExternalCliInvocationPolicy(profile), pluginMode: "configured" };
      }
    }
    expect(() => validateConformanceRecord({ adapter: new PolicyChangedAdapter(), profile: cliProfile, cases: OPENCODE_CLI_CONFORMANCE_CASES, record: cliRecord() }))
      .toThrow(/invocation policy differs/);
  });

  it("rejects evidence carrying the pre-session-export process policy", () => {
    const record = cliRecord();
    const current = record.externalCliEvidence!.invocationPolicy;
    const oldPolicy = {
      ...current,
      processesPerSemanticRequest: 1,
    } as unknown as ExternalCliInvocationPolicyEvidence;
    delete (oldPolicy as unknown as Record<string, unknown>).modelBearingProcessesPerSemanticRequest;
    delete (oldPolicy as unknown as Record<string, unknown>).metadataProcessesPerSemanticRequest;
    delete (oldPolicy as unknown as Record<string, unknown>).identitySource;
    const { integritySha256: _seal, ...body } = record;
    const stale = sealRecord({ ...body, externalCliEvidence: { ...record.externalCliEvidence!, invocationPolicy: oldPolicy } });
    expect(() => validateConformanceRecord({ adapter: noProcessCli(), profile: cliProfile, cases: OPENCODE_CLI_CONFORMANCE_CASES, record: stale }))
      .toThrow(/invocation policy differs/);
  });

  it("selects external evidence from transport identity and rejects the wrong form", () => {
    const cli = cliRecord();
    const { integritySha256: _cliSeal, externalCliEvidence: _external, ...cliWithoutExternal } = cli;
    const missingExternal = sealRecord(cliWithoutExternal);
    expect(() => validateConformanceRecord({ adapter: noProcessCli(), profile: cliProfile, cases: OPENCODE_CLI_CONFORMANCE_CASES, record: missingExternal }))
      .toThrow(/requires only rb-external-cli-evidence/);
    const api = apiRecord();
    const { integritySha256: _apiSeal, ...apiBody } = api;
    const injectedExternal = sealRecord({ ...apiBody, externalCliEvidence: cli.externalCliEvidence });
    expect(() => validateConformanceRecord({ adapter: noNetworkApi(), profile: apiProfile, cases: CONFORMANCE_CASES, record: injectedExternal }))
      .toThrow(/may not use external CLI evidence/);
  });
});
