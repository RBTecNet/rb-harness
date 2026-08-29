import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ClaudeCodeAdapter } from "../../../src/vnext/providers/anthropic/claude-code/adapter.js";
import { CLAUDE_CODE_CONFORMANCE_CASES } from "../../../src/vnext/providers/anthropic/claude-code/fixtures.js";
import { CLAUDE_CODE_OPUS_5_PROFILE } from "../../../src/vnext/providers/anthropic/claude-code/profiles.js";
import { migrateClaudeCodeRuntimeEvidence } from "../../../src/vnext/providers/anthropic/claude-code/record.js";
import { SpawnClaudeCodeProcess } from "../../../src/vnext/providers/anthropic/claude-code/process.js";
import { sanitizeClaudeCodeRawResponse, type ClaudeCodeRawResponse } from "../../../src/vnext/providers/anthropic/claude-code/normalize.js";
import { measured, unmeasured } from "../../../src/vnext/providers/contract.js";
import {
  readConformanceRecord,
  sealRecord,
  writeConformanceRecord,
  type ConformanceRecord,
  type ConformanceRecordBody,
} from "../../../src/vnext/providers/conformance/recording.js";
import { replayConformance, validateConformanceRecord } from "../../../src/vnext/providers/conformance/runner.js";
import { CONFORMANCE_SUITE_VERSION, type ConformanceResult } from "../../../src/vnext/providers/conformance/suite.js";
import { assertProviderRuntimeVersion } from "../../../src/vnext/providers/registry.js";
import { runVnextConformanceCommand } from "../../../src/vnext/providers/conformance/cli.js";

function raw(payload: unknown): ClaudeCodeRawResponse {
  return {
    events: [
      { type: "system", subtype: "init", model: "claude-opus-5", tools: [], mcp_servers: [] },
      { type: "assistant", message: { id: "msg_one_step", model: "claude-opus-5", stop_reason: "end_turn" } },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: 2,
        structured_output: payload,
        usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 4 },
        modelUsage: { "claude-opus-5": {} },
        subagent_stats: { spawned: 0 },
      },
    ],
    exitCode: 0,
    exitSignal: null,
    startedAt: "2026-08-29T00:00:00.000Z",
    completedAt: "2026-08-29T00:00:00.100Z",
    firstOutputMs: 10,
    streamComplete: true,
    treeQuiescent: true,
    treeVerified: true,
  };
}

function record(): ConformanceRecord {
  const representation = {
    title: "transport-probe",
    mode: "alpha",
    nested: { level1: { level2: { value: "kept" } } },
    arrays: [[], ["one"], ["one", "two"]],
    optional: null,
  };
  const incomplete = { items: [] };
  const runId = "claude-code-offline-fixture";
  const recordedAt = "2026-08-29T00:00:00.000Z";
  const provisionalResult: ConformanceResult = {
    profileId: CLAUDE_CODE_OPUS_5_PROFILE.id,
    suiteVersion: CONFORMANCE_SUITE_VERSION,
    runId,
    recordedAt,
    tier: "UNSUPPORTED",
    cases: [],
    normalizationsOnHappyPath: [],
    capabilitiesActuallyTested: [],
  };
  const representationRaw = raw(representation);
  const body: ConformanceRecordBody = {
    format: "rb-adapter-conformance-record/v1",
    producer: "rb-harness-conformance-runner",
    providerFamily: "anthropic",
    profileId: CLAUDE_CODE_OPUS_5_PROFILE.id,
    modelId: "claude-opus-5",
    transport: "claude-code-cli",
    requestAccounting: "opaque",
    transportVersion: "2.1.251 (Claude Code)",
    suiteVersion: CONFORMANCE_SUITE_VERSION,
    runId,
    recordedAt,
    rawResponses: {
      "representation-comprehensive": { origin: "local-transport-fixture", response: representationRaw },
      "semantic-incomplete": { origin: "local-transport-fixture", response: raw(incomplete) },
      "structured-output-retry-probe": { origin: "local-transport-fixture", response: raw({ value: "x" }) },
      "derived-truncated": { origin: "derived-from-recording", response: { ...representationRaw, streamComplete: false } },
      "derived-malformed": { origin: "derived-from-recording", response: { ...representationRaw, events: [{ type: "unknown" }] } },
    },
    liveSmoke: {
      cancellation: { passed: true, errorKind: "cancelled", durationMs: 50, transportInvocations: 1, promptAbort: true, treeQuiescent: true, treeVerified: true },
      timeout: { passed: true, errorKind: "timeout", durationMs: 10, transportInvocations: 1, promptAbort: true, treeQuiescent: true, treeVerified: true },
    },
    runtimeEvidence: {
      format: "rb-external-runtime-evidence/v2",
      cliInvocations: 5,
      observedProviderRequests: unmeasured("unsupported-by-provider"),
      observedTopLevelModelSteps: [1, 1, 1],
      observedModelIds: ["claude-opus-5"],
      liveAttestations: [
        { check: "subscription-auth", checkedAt: recordedAt, transport: "claude-code-cli", transportVersion: "2.1.251 (Claude Code)", authMode: "subscription" },
        {
          check: "environment-api-key-isolation",
          checkedAt: recordedAt,
          transport: "claude-code-cli",
          transportVersion: "2.1.251 (Claude Code)",
          providerCredentialVariablesPresent: false,
          alternateBackendVariablesPresent: false,
          observedApiKeySource: "none",
        },
        { check: "transport-version", checkedAt: recordedAt, transport: "claude-code-cli", transportVersion: "2.1.251 (Claude Code)", executable: "claude" },
      ],
      invocationConfiguration: {
        modelId: "claude-opus-5",
        effort: "low",
        inputMode: "stdin",
        systemPromptMode: "replacement-file",
        settingSources: "none",
        strictMcpConfig: true,
        configuredMcpServers: 0,
        toolsMode: "disabled-except-structured-output",
        fallbackModelConfigured: false,
        sessionPersistence: "disabled",
        restrictedMode: true,
      },
      invocations: [
        { id: "valid-structured-response", recordingKey: "representation-comprehensive", transportInvocations: 1, cwdIsolated: true, numTurns: 2, topLevelModelSteps: 1, modelIds: ["claude-opus-5"], resultSubtype: "success" },
        { id: "semantically-incomplete", recordingKey: "semantic-incomplete", transportInvocations: 1, cwdIsolated: true, numTurns: 2, topLevelModelSteps: 1, modelIds: ["claude-opus-5"], resultSubtype: "success" },
        { id: "structured-output-retry-probe", recordingKey: "structured-output-retry-probe", transportInvocations: 1, cwdIsolated: true, numTurns: 2, topLevelModelSteps: 1, modelIds: ["claude-opus-5"], resultSubtype: "success" },
      ],
    },
    result: provisionalResult,
  };
  const provisional = sealRecord(body);
  const result = replayConformance({ adapter: new ClaudeCodeAdapter(), profile: CLAUDE_CODE_OPUS_5_PROFILE, cases: CLAUDE_CODE_CONFORMANCE_CASES, record: provisional });
  return sealRecord({ ...body, result });
}

function replay(source: ConformanceRecord): ConformanceResult {
  return replayConformance({
    adapter: new ClaudeCodeAdapter(),
    profile: CLAUDE_CODE_OPUS_5_PROFILE,
    cases: CLAUDE_CODE_CONFORMANCE_CASES,
    record: source,
  });
}

function mutateResponse(
  source: ConformanceRecord,
  key: string,
  mutate: (raw: ClaudeCodeRawResponse) => ClaudeCodeRawResponse,
): ConformanceRecord {
  const { integritySha256: _integrity, ...body } = source;
  const entry = body.rawResponses[key]!;
  return sealRecord({
    ...body,
    rawResponses: { ...body.rawResponses, [key]: { ...entry, response: mutate(entry.response as ClaudeCodeRawResponse) } },
  });
}

describe("Claude Code independent conformance", () => {
  it("replays all generic and CLI assertions offline without binary or network", () => {
    const source = record();
    const process = { run: vi.fn(() => { throw new Error("Claude binary forbidden during replay"); }) };
    const result = validateConformanceRecord({
      adapter: new ClaudeCodeAdapter(process),
      profile: CLAUDE_CODE_OPUS_5_PROFILE,
      cases: CLAUDE_CODE_CONFORMANCE_CASES,
      record: source,
    });
    expect(result.cases.filter((item) => !item.passed)).toEqual([]);
    expect(result.tier).toBe("SUPPORTED");
    expect(result.cases.find((item) => item.id === "semantically-incomplete")).toMatchObject({ passed: true });
    const replayed = new ClaudeCodeAdapter(process).replay(CLAUDE_CODE_OPUS_5_PROFILE, CLAUDE_CODE_CONFORMANCE_CASES[0]!.request(), raw({ items: [] }));
    expect(replayed).toMatchObject({ ok: true, value: { usage: { providerRequests: { measured: false } } } });
    expect(process.run).not.toHaveBeenCalled();
  });

  it("gates exact external runtime versions while leaving offline replay independent", () => {
    const source = record();
    expect(() => assertProviderRuntimeVersion(CLAUDE_CODE_OPUS_5_PROFILE, source, "2.1.251 (Claude Code)")).not.toThrow();
    expect(() => assertProviderRuntimeVersion(CLAUDE_CODE_OPUS_5_PROFILE, source, "2.1.252 (Claude Code)")).toThrow(/does not match/);
  });

  it("does not let arbitrary resealed legacy conclusions enter the migration path", () => {
    const source = record();
    const { integritySha256: _integrity, ...body } = source;
    const current = body.runtimeEvidence!;
    const legacyRuntime = {
      authMode: "subscription",
      cliInvocations: current.cliInvocations,
      observedProviderRequests: current.observedProviderRequests,
      observedTopLevelModelSteps: current.observedTopLevelModelSteps,
      observedModelIds: current.observedModelIds,
      invocations: current.invocations!.map(({ recordingKey: _recordingKey, cwdIsolated: _cwdIsolated, ...item }) => item),
      assertions: {
        "subscription-auth": { passed: true },
        "environment-api-key-isolation": { passed: true },
        "transport-version": { passed: true },
        "isolated-context": { passed: true },
      },
    };
    const legacy = sealRecord({ ...body, runtimeEvidence: legacyRuntime as unknown as typeof body.runtimeEvidence });
    expect(() => migrateClaudeCodeRuntimeEvidence(legacy, CLAUDE_CODE_OPUS_5_PROFILE)).toThrow(/known accurate Phase 2B live record/);
  });

  it("keeps direct API and CLI record filenames and attribution collision-free", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rb-vnext-cli-records-"));
    const source = record();
    const cliPath = await writeConformanceRecord(root, source);
    expect(cliPath).toContain("anthropic_claude-code-cli_claude-opus-5.json");
    expect((await readConformanceRecord(root, CLAUDE_CODE_OPUS_5_PROFILE.id)).transport).toBe("claude-code-cli");
    await expect(readConformanceRecord(root, "anthropic:claude-opus-5")).rejects.toThrow();
  });

  it("rejects direct transport evidence, missing version, and invalid typed runtime evidence", () => {
    const source = record();
    const { integritySha256: _integrity, ...body } = source;
    const wrongTransport = sealRecord({ ...body, transport: "direct-api" });
    expect(() => validateConformanceRecord({ adapter: new ClaudeCodeAdapter(), profile: CLAUDE_CODE_OPUS_5_PROFILE, cases: CLAUDE_CODE_CONFORMANCE_CASES, record: wrongTransport }))
      .toThrow(/direct-api.*claude-code-cli/);
    const missingVersion = sealRecord({ ...body, transportVersion: undefined });
    expect(() => validateConformanceRecord({ adapter: new ClaudeCodeAdapter(), profile: CLAUDE_CODE_OPUS_5_PROFILE, cases: CLAUDE_CODE_CONFORMANCE_CASES, record: missingVersion }))
      .toThrow(/missing transportVersion/);
    const missingAccounting = sealRecord({ ...body, requestAccounting: undefined });
    expect(() => validateConformanceRecord({ adapter: new ClaudeCodeAdapter(), profile: CLAUDE_CODE_OPUS_5_PROFILE, cases: CLAUDE_CODE_CONFORMANCE_CASES, record: missingAccounting }))
      .toThrow(/request accounting/);
    const wrongAccounting = sealRecord({ ...body, requestAccounting: "exact" });
    expect(() => validateConformanceRecord({ adapter: new ClaudeCodeAdapter(), profile: CLAUDE_CODE_OPUS_5_PROFILE, cases: CLAUDE_CODE_CONFORMANCE_CASES, record: wrongAccounting }))
      .toThrow(/request accounting/);
    const wrongFamily = sealRecord({ ...body, providerFamily: "other-family" });
    expect(() => validateConformanceRecord({ adapter: new ClaudeCodeAdapter(), profile: CLAUDE_CODE_OPUS_5_PROFILE, cases: CLAUDE_CODE_CONFORMANCE_CASES, record: wrongFamily }))
      .toThrow(/provider family/);
    const wrongModel = sealRecord({ ...body, modelId: "claude-sonnet-5" });
    expect(() => validateConformanceRecord({ adapter: new ClaudeCodeAdapter(), profile: CLAUDE_CODE_OPUS_5_PROFILE, cases: CLAUDE_CODE_CONFORMANCE_CASES, record: wrongModel }))
      .toThrow(/record model/);
    const multipleProcesses = sealRecord({
      ...body,
      runtimeEvidence: {
        ...body.runtimeEvidence!,
        invocations: body.runtimeEvidence!.invocations!.map((item, index) => index === 0 ? { ...item, transportInvocations: 2 } : item),
      },
    });
    expect(replayConformance({ adapter: new ClaudeCodeAdapter(), profile: CLAUDE_CODE_OPUS_5_PROFILE, cases: CLAUDE_CODE_CONFORMANCE_CASES, record: multipleProcesses }).tier)
      .toBe("UNSUPPORTED");
  });

  it("derives model, tools and subagent assertions from raw evidence instead of stored conclusions", () => {
    const source = record();
    const wrongModel = mutateResponse(source, "representation-comprehensive", (response) => ({
      ...response,
      events: response.events.map((value) => {
        const event = value as Record<string, unknown>;
        if (event.type === "system") return { ...event, model: "claude-haiku-5" };
        if (event.type === "assistant") return { ...event, message: { ...(event.message as object), model: "claude-haiku-5" } };
        if (event.type === "result") return { ...event, modelUsage: { "claude-haiku-5": {} } };
        return event;
      }),
    }));
    expect(replay(wrongModel).cases.find((item) => item.id === "exact-model")).toMatchObject({ passed: false });

    const tool = mutateResponse(source, "representation-comprehensive", (response) => ({
      ...response,
      events: response.events.map((value) => {
        const event = value as Record<string, unknown>;
        if (event.type === "system") return { ...event, tools: ["StructuredOutput", "Read"] };
        if (event.type === "assistant") {
          return { ...event, message: { ...(event.message as object), content: [{ type: "tool_use", name: "Read", input: {} }] } };
        }
        return event;
      }),
    }));
    expect(replay(tool).cases.find((item) => item.id === "no-agent-tools-or-mcp")).toMatchObject({ passed: false });

    const subagent = mutateResponse(source, "representation-comprehensive", (response) => ({
      ...response,
      events: response.events.map((value) => {
        const event = value as Record<string, unknown>;
        return event.type === "result" ? { ...event, subagent_stats: { spawned: 1 } } : event;
      }),
    }));
    expect(replay(subagent).cases.find((item) => item.id === "no-agent-tools-or-mcp")).toMatchObject({ passed: false });
  });

  it("derives invocation, accounting, retry and isolation assertions from typed evidence", () => {
    const source = record();
    const { integritySha256: _integrity, ...body } = source;
    const first = body.runtimeEvidence!.invocations![0]!;
    const twoProcesses = sealRecord({
      ...body,
      runtimeEvidence: {
        ...body.runtimeEvidence!,
        invocations: [{ ...first, transportInvocations: 2 }, ...body.runtimeEvidence!.invocations!.slice(1)],
      },
    });
    expect(replay(twoProcesses).cases.find((item) => item.id === "single-harness-invocation")).toMatchObject({ passed: false });

    const measuredAccounting = sealRecord({
      ...body,
      runtimeEvidence: { ...body.runtimeEvidence!, observedProviderRequests: measured(1) },
    });
    expect(replay(measuredAccounting).cases.find((item) => item.id === "opaque-provider-accounting")).toMatchObject({ passed: false });

    const retryInvocations = body.runtimeEvidence!.invocations!.map((item) => (
      item.id === "structured-output-retry-probe" ? { ...item, transportInvocations: 2 } : item
    ));
    const unboundedRetry = sealRecord({ ...body, runtimeEvidence: { ...body.runtimeEvidence!, invocations: retryInvocations } });
    expect(replay(unboundedRetry).cases.find((item) => item.id === "structured-output-retry-bound")).toMatchObject({ passed: false });

    const nonIsolated = sealRecord({
      ...body,
      runtimeEvidence: {
        ...body.runtimeEvidence!,
        invocations: body.runtimeEvidence!.invocations!.map((item, index) => index === 0 ? { ...item, cwdIsolated: false } : item),
      },
    });
    expect(replay(nonIsolated).cases.find((item) => item.id === "isolated-context")).toMatchObject({ passed: false });
  });

  it("ignores generic conclusion booleans and cannot reseal them into support", () => {
    const source = record();
    const { integritySha256: _integrity, ...body } = source;
    const withFakeConclusions = sealRecord({
      ...body,
      runtimeEvidence: {
        ...body.runtimeEvidence!,
        assertions: { "exact-model": { passed: true }, "no-agent-tools-or-mcp": { passed: true } },
      } as unknown as typeof body.runtimeEvidence,
    });
    expect(replay(withFakeConclusions).tier).toBe("SUPPORTED");

    const invalidTool = mutateResponse(withFakeConclusions, "representation-comprehensive", (response) => ({
      ...response,
      events: response.events.map((value) => {
        const event = value as Record<string, unknown>;
        return event.type === "system" ? { ...event, tools: ["StructuredOutput", "Read"] } : event;
      }),
    }));
    const derived = replay(invalidTool);
    expect(derived.tier).toBe("UNSUPPORTED");
    const { integritySha256: _invalidIntegrity, ...invalidBody } = invalidTool;
    const forgedConclusions = sealRecord({ ...invalidBody, result: source.result });
    expect(() => validateConformanceRecord({
      adapter: new ClaudeCodeAdapter(),
      profile: CLAUDE_CODE_OPUS_5_PROFILE,
      cases: CLAUDE_CODE_CONFORMANCE_CASES,
      record: forgedConclusions,
    })).toThrow(/stored conformance result does not match deterministic replay/);
  });

  it("derives v2 smoke results from typed process observations rather than passed booleans", () => {
    const source = record();
    const { integritySha256: _integrity, ...body } = source;
    const falseConclusion = sealRecord({
      ...body,
      liveSmoke: {
        ...body.liveSmoke,
        cancellation: { ...body.liveSmoke.cancellation, passed: false },
      },
    });
    expect(replay(falseConclusion).cases.find((item) => item.id === "cancellation")).toMatchObject({ passed: true });

    const unverifiedTree = sealRecord({
      ...body,
      liveSmoke: {
        ...body.liveSmoke,
        cancellation: { ...body.liveSmoke.cancellation, passed: true, treeVerified: false },
      },
    });
    expect(replay(unverifiedTree).cases.find((item) => item.id === "cancellation")).toMatchObject({ passed: false });
  });

  it("removes process identity/auth metadata and rejects it if it reaches persistence", async () => {
    const source = raw({ items: [] });
    const dirty = {
      ...source,
      events: [{ type: "system", apiKeySource: "none", session_id: "private-session", cwd: "/private/home", total_cost_usd: 99, messaging_socket_path: "/private/socket" }, ...source.events],
    };
    expect(JSON.stringify(sanitizeClaudeCodeRawResponse(dirty))).not.toMatch(/apiKeySource|private-session|private\/home|total_cost|private\/socket/);

    const conformance = record();
    const { integritySha256: _integrity, ...body } = conformance;
    const unsafe = sealRecord({
      ...body,
      rawResponses: { unsafe: { origin: "local-transport-fixture", response: dirty } },
    });
    const root = await mkdtemp(resolve(tmpdir(), "rb-vnext-cli-unsafe-"));
    await expect(writeConformanceRecord(root, unsafe)).rejects.toThrow(/forbidden credential field/);
  });

  it("rejects --credential for the ambient-session profile before recording", async () => {
    await expect(runVnextConformanceCommand({
      profileId: CLAUDE_CODE_OPUS_5_PROFILE.id,
      record: true,
      credential: "claudeAPI",
    })).rejects.toThrow(/--credential is not accepted/);
  });

  it("replays the authoritative supported opaque-accounting record with zero CLI or network activity", async () => {
    const run = vi.spyOn(SpawnClaudeCodeProcess.prototype, "run").mockRejectedValue(new Error("Claude process forbidden during replay"));
    const fetch = vi.fn(() => { throw new Error("network forbidden during replay"); });
    vi.stubGlobal("fetch", fetch);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const previousExitCode = process.exitCode;
    await runVnextConformanceCommand({ profileId: CLAUDE_CODE_OPUS_5_PROFILE.id, record: false });
    const output = write.mock.calls.flat().join("");
    expect(output).toContain("Transport: claude-code-cli");
    expect(output).toContain("Transport version: 2.1.251 (Claude Code)");
    expect(output).toContain("Tier: SUPPORTED");
    expect(run).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    process.exitCode = previousExitCode;
    write.mockRestore();
    run.mockRestore();
    vi.unstubAllGlobals();
  });
});
