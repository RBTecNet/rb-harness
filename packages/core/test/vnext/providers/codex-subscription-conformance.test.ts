import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { REPRESENTATION_PAYLOAD, SEMANTICALLY_INCOMPLETE_PAYLOAD } from "../../../src/vnext/providers/conformance/fixtures.js";
import { readConformanceRecord, sealRecord, writeConformanceRecord, type ConformanceRecordBody } from "../../../src/vnext/providers/conformance/recording.js";
import { replayConformance, validateConformanceRecord } from "../../../src/vnext/providers/conformance/runner.js";
import { CONFORMANCE_SUITE_VERSION, type ConformanceResult } from "../../../src/vnext/providers/conformance/suite.js";
import { CodexSubscriptionAdapter } from "../../../src/vnext/providers/openai/codex/adapter.js";
import { CODEX_SUBSCRIPTION_CONFORMANCE_CASES } from "../../../src/vnext/providers/openai/codex/fixtures.js";
import { EMPTY_TOOL_MANIFEST_SHA256, type CodexAppServerRawResponse } from "../../../src/vnext/providers/openai/codex/normalize.js";
import { CODEX_SUBSCRIPTION_PROFILE } from "../../../src/vnext/providers/openai/codex/profiles.js";
import { listProviderProfiles, resolveProviderAdapter, resolveProviderConformanceCases, resolveProviderProfile } from "../../../src/vnext/providers/registry.js";

function raw(payload: unknown): CodexAppServerRawResponse {
  return {
    preflight: {
      semanticMode: true, semanticModeVersion: "v1", runtimeVersion: "rb-codex 0.151.0-rb.1 (upstream 78c290807ce710180111df227df3b7a4fe845452)", model: "gpt-5.6-sol", modelProvider: "openai",
      toolPolicy: "none", effectiveToolCount: 0, toolManifestDigest: EMPTY_TOOL_MANIFEST_SHA256, instructionPolicy: "isolated",
      outputSchemaStrict: false, authenticated: true, authMode: "chatgpt", authStoreKind: "file", sessionMode: "ephemeral",
      requestedCodexTurns: 1, requestAccounting: "opaque",
    },
    completion: { initialModel: "gpt-5.6-sol", initialModelProvider: "openai", finalModel: "gpt-5.6-sol", finalModelProvider: "openai", rerouted: false },
    terminalStatus: "completed", finalMessages: [JSON.stringify(payload)],
    actionCounts: { commandExecutionEvents: 0, fileChangeEvents: 0, mcpToolEvents: 0, appToolEvents: 0, webSearchEvents: 0, otherToolEvents: 0 },
    usage: { inputTokens: 10, cachedInputTokens: 2, cacheWriteInputTokens: 0, outputTokens: 4, reasoningOutputTokens: 1 },
    startedAt: "2026-09-04T00:00:00.000Z", completedAt: "2026-09-04T00:00:01.000Z", firstOutputMs: 20,
    streamComplete: true, processCompleted: true,
  };
}

function record() {
  const representation = raw(REPRESENTATION_PAYLOAD);
  const incomplete = raw(SEMANTICALLY_INCOMPLETE_PAYLOAD);
  const { completion: _completion, terminalStatus: _terminalStatus, ...truncated } = representation;
  const identity = { runId: "codex-offline-run", recordedAt: "2026-09-04T00:00:02.000Z" };
  const provisionalResult: ConformanceResult = {
    profileId: CODEX_SUBSCRIPTION_PROFILE.id, suiteVersion: CONFORMANCE_SUITE_VERSION, ...identity,
    tier: "UNSUPPORTED", cases: [], normalizationsOnHappyPath: [], capabilitiesActuallyTested: [],
  };
  const body: ConformanceRecordBody = {
    format: "rb-adapter-conformance-record/v1", producer: "rb-harness-conformance-runner",
    profileId: CODEX_SUBSCRIPTION_PROFILE.id, providerFamily: "openai", modelId: "gpt-5.6-sol",
    transport: "codex-app-server", requestAccounting: "opaque", transportVersion: "0.151.0-rb.1",
    suiteVersion: CONFORMANCE_SUITE_VERSION, ...identity,
    rawResponses: {
      "representation-comprehensive": { origin: "local-transport-fixture", canonicalPayload: REPRESENTATION_PAYLOAD, response: representation },
      "semantic-incomplete": { origin: "local-transport-fixture", canonicalPayload: SEMANTICALLY_INCOMPLETE_PAYLOAD, response: incomplete },
      "derived-truncated": { origin: "derived-from-recording", response: { ...truncated, streamComplete: false } },
      "derived-malformed": { origin: "derived-from-recording", response: { ...representation, finalMessages: ["{bad"] } },
    },
    liveSmoke: {
      cancellation: { passed: true, errorKind: "cancelled", durationMs: 10, transportInvocations: 1, promptAbort: true, treeQuiescent: true, treeVerified: true },
      timeout: { passed: true, errorKind: "timeout", durationMs: 10, transportInvocations: 1, promptAbort: true, treeQuiescent: true, treeVerified: true },
    },
    codexAppServerEvidence: {
      format: "rb-codex-app-server-evidence/v1", managedRuntimeVersion: "0.151.0-rb.1",
      managedRuntimeSha256: "b68d7cc25105d38cca12977164e45710ae4576a18f898269b563e743e100493d",
      semanticModeVersion: "v1", requestedModel: "gpt-5.6-sol", requestedProvider: "openai",
      semanticRuntimeVersion: "rb-codex 0.151.0-rb.1 (upstream 78c290807ce710180111df227df3b7a4fe845452)",
      identitySource: "app-server-semantic-preflight-and-final-completion", requestAccounting: "opaque",
      invocationPolicy: {
        modelSelection: "thread/start", turnModelOverride: false, schemaTransmission: "unchanged", outputSchemaStrict: false,
        toolPolicy: "none", instructionPolicy: "isolated", sessionMode: "ephemeral", internalRetryLimit: 0,
        fallbackModelConfigured: false, authStoreKind: "file",
      },
      invocations: [
        ["valid-structured-response", "representation-comprehensive", representation],
        ["semantically-incomplete", "semantic-incomplete", incomplete],
      ].map(([id, recordingKey, response]) => ({
        id: id as string, recordingKey: recordingKey as string, transportInvocations: 1 as const,
        terminalStatus: (response as CodexAppServerRawResponse).terminalStatus!, initialModel: "gpt-5.6-sol", initialProvider: "openai",
        finalModel: "gpt-5.6-sol", finalProvider: "openai", rerouted: false,
        actionCounts: (response as CodexAppServerRawResponse).actionCounts, authoritativeFinalMessages: 1,
      })),
    },
    result: provisionalResult,
  };
  const provisional = sealRecord(body);
  const result = replayConformance({ adapter: new CodexSubscriptionAdapter(), profile: CODEX_SUBSCRIPTION_PROFILE, cases: CODEX_SUBSCRIPTION_CONFORMANCE_CASES, record: provisional });
  return sealRecord({ ...body, result });
}

describe("Codex Subscription conformance evidence", () => {
  it("registers exactly one separate unsupported source profile", () => {
    const profile = resolveProviderProfile("openai:codex:gpt-5.6-sol");
    expect(profile).toMatchObject({ label: "GPT-5.6 Sol — Codex Subscription", family: "openai", transport: "codex-app-server", modelId: "gpt-5.6-sol", conformance: { tier: "UNSUPPORTED", verifiedRecord: false } });
    expect(listProviderProfiles().filter((item) => item.transport === "codex-app-server")).toHaveLength(1);
    expect(resolveProviderAdapter(profile.id)).toMatchObject({ family: "openai", transport: "codex-app-server" });
    expect(resolveProviderConformanceCases(profile.id)).toBe(CODEX_SUBSCRIPTION_CONFORMANCE_CASES);
  });

  it("derives SUPPORTED only from integrity-bound exact-profile Codex evidence and replays without transport", async () => {
    const sealed = record();
    const adapter = new CodexSubscriptionAdapter({ run: async () => { throw new Error("transport must not run during replay"); } }, { verify: async () => { throw new Error("runtime must not run during replay"); } });
    const result = validateConformanceRecord({ adapter, profile: CODEX_SUBSCRIPTION_PROFILE, cases: CODEX_SUBSCRIPTION_CONFORMANCE_CASES, record: sealed });
    expect(result.tier).toBe("SUPPORTED");
    const root = await mkdtemp(resolve(tmpdir(), "rb-codex-record-"));
    await writeConformanceRecord(root, sealed);
    expect(await readConformanceRecord(root, CODEX_SUBSCRIPTION_PROFILE.id)).toEqual(sealed);
  });

  it.each([
    ["reroute", (body: ConformanceRecordBody) => { (body.codexAppServerEvidence!.invocations as unknown as { rerouted: boolean }[])[0] = { ...body.codexAppServerEvidence!.invocations[0]!, rerouted: true }; }],
    ["action", (body: ConformanceRecordBody) => { (body.codexAppServerEvidence!.invocations as unknown as { actionCounts: { webSearchEvents: number } }[])[0] = { ...body.codexAppServerEvidence!.invocations[0]!, actionCounts: { ...body.codexAppServerEvidence!.invocations[0]!.actionCounts, webSearchEvents: 1 } }; }],
  ])("rejects tampered %s evidence", (_name, mutate) => {
    const sealed = record();
    const { integritySha256: _sha, ...body } = structuredClone(sealed);
    mutate(body);
    const tampered = sealRecord(body);
    expect(() => validateConformanceRecord({ adapter: new CodexSubscriptionAdapter(), profile: CODEX_SUBSCRIPTION_PROFILE, cases: CODEX_SUBSCRIPTION_CONFORMANCE_CASES, record: tampered })).toThrow(/stored conformance result|exact-profile|replay/i);
  });
});
