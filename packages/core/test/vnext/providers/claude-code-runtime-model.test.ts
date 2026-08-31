import { mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ModelProfile, SemanticRequest } from "../../../src/vnext/providers/contract.js";
import { defaultConformanceRecordsRoot } from "../../../src/vnext/providers/conformance/cli.js";
import {
  readConformanceRecord,
  sealRecord,
  type ConformanceRecord,
  type ConformanceRecordBody,
} from "../../../src/vnext/providers/conformance/recording.js";
import { replayConformance } from "../../../src/vnext/providers/conformance/runner.js";
import { CLAUDE_CODE_CONFORMANCE_CASES } from "../../../src/vnext/providers/anthropic/claude-code/fixtures.js";
import { CLAUDE_CODE_OPUS_5_PROFILE } from "../../../src/vnext/providers/anthropic/claude-code/profiles.js";
import {
  CLAUDE_CODE_TRANSPORT_PROFILE_ID,
  CLAUDE_CODE_TRANSPORT_PROFILE,
  createClaudeCodeRuntimeProfile,
  validateClaudeCodeModelSelector,
} from "../../../src/vnext/providers/anthropic/claude-code/runtime-model.js";
import {
  buildClaudeCodeCompatibilityEvidence,
  inspectClaudeCodeCompatibility,
  verifyClaudeCodeRuntimeCompatibility,
  type ClaudeCodeConformanceRecording,
} from "../../../src/vnext/providers/anthropic/claude-code/runtime-compatibility.js";
import {
  claudeCodeCompatibilityEvidenceIsInvalidated,
  defaultProviderCompatibilityRoot,
  listClaudeCodeCompatibilityEvidence,
  readClaudeCodeCompatibilityEvidence,
  sealClaudeCodeCompatibilityEvidence,
  writeClaudeCodeCompatibilityEvidence,
} from "../../../src/vnext/providers/anthropic/claude-code/compatibility-store.js";
import {
  CLAUDE_CODE_AMBIENT_AUTH_ID,
  ClaudeCodeAdapter,
} from "../../../src/vnext/providers/anthropic/claude-code/adapter.js";
import type {
  ClaudeCodeCommandInput,
  ClaudeCodeCommandResult,
  ClaudeCodeProcess,
} from "../../../src/vnext/providers/anthropic/claude-code/process.js";

const recordsRoot = defaultConformanceRecordsRoot();
const ambient = { kind: "ambient-session" as const, id: CLAUDE_CODE_AMBIENT_AUTH_ID };

function replaceModel(value: unknown, resolvedModel: string): unknown {
  if (typeof value === "string") return value === "claude-opus-5" ? resolvedModel : value;
  if (Array.isArray(value)) return value.map((entry) => replaceModel(entry, resolvedModel));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key === "claude-opus-5" ? resolvedModel : key,
      replaceModel(entry, resolvedModel),
    ]));
  }
  return value;
}

async function dynamicRecording(requestedModel = "sonnet", resolvedModel = "claude-sonnet-5", transportVersion = "2.1.251 (Claude Code)", supported = true): Promise<ClaudeCodeConformanceRecording> {
  const source = await readConformanceRecord(recordsRoot, CLAUDE_CODE_OPUS_5_PROFILE.id);
  const { integritySha256: _integrity, ...sourceBody } = source;
  const transformed = replaceModel(sourceBody, resolvedModel) as ConformanceRecordBody;
  const pending = createClaudeCodeRuntimeProfile({ requestedModel, resolvedModel, transportVersion, maxOutputTokens: 64_000 });
  const runtimeEvidence = transformed.runtimeEvidence!;
  const body: ConformanceRecordBody = {
    ...transformed,
    profileId: CLAUDE_CODE_TRANSPORT_PROFILE_ID,
    providerFamily: "anthropic",
    modelId: resolvedModel,
    transportVersion,
    runtimeEvidence: {
      ...runtimeEvidence,
      observedModelIds: [resolvedModel],
      invocationConfiguration: {
        ...runtimeEvidence.invocationConfiguration,
        modelId: requestedModel,
        fallbackModelConfigured: false,
      },
      invocations: runtimeEvidence.invocations?.map((invocation) => ({ ...invocation, modelIds: [resolvedModel] })),
    },
    liveSmoke: supported ? transformed.liveSmoke : {
      ...transformed.liveSmoke,
      cancellation: { ...transformed.liveSmoke.cancellation, passed: false, promptAbort: false },
    },
    result: {
      ...transformed.result,
      profileId: CLAUDE_CODE_TRANSPORT_PROFILE_ID,
      tier: "UNSUPPORTED",
      cases: [],
      normalizationsOnHappyPath: [],
      capabilitiesActuallyTested: [],
    },
  };
  const adapter = new ClaudeCodeAdapter();
  const provisional = sealRecord(body);
  const result = replayConformance({ adapter, profile: pending, cases: CLAUDE_CODE_CONFORMANCE_CASES, record: provisional });
  const record = sealRecord({ ...body, result });
  return { record, profile: pending, transportInvocations: runtimeEvidence.cliInvocations };
}

function settled(stdout: string): ClaudeCodeCommandResult {
  return {
    stdout,
    stderr: "",
    exitCode: 0,
    exitSignal: null,
    startedAt: "2026-08-30T00:00:00.000Z",
    completedAt: "2026-08-30T00:00:00.010Z",
    firstOutputMs: 1,
    cancelled: false,
    timedOut: false,
    outputLimitExceeded: false,
    settlement: {
      observed: true,
      quiescent: true,
      verified: true,
      containment: { kind: "cgroup2", structural: true, reason: "fixture" },
      survivors: [],
    },
  };
}

function modelStream(systemModel: string, assistantModel = systemModel, usageModel = systemModel): string {
  return [
    { type: "system", subtype: "init", model: systemModel, tools: [], mcp_servers: [] },
    { type: "assistant", message: { id: "step-1", model: assistantModel, stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }, content: [] } },
    { type: "result", subtype: "success", is_error: false, num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: { [usageModel]: { maxOutputTokens: 64_000 } }, subagent_stats: { spawned: 0 }, structured_output: { ok: true } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

class RuntimeProcess implements ClaudeCodeProcess {
  readonly calls: ClaudeCodeCommandInput[] = [];
  constructor(private readonly stdout: string, private readonly version = "2.1.251 (Claude Code)") {}
  async run(input: ClaudeCodeCommandInput): Promise<ClaudeCodeCommandResult> {
    this.calls.push(input);
    if (input.args.includes("--version")) return settled(`${this.version}\n`);
    if (input.args[0] === "auth") return settled(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max" }));
    return settled(this.stdout);
  }
}

function semanticRequest(): SemanticRequest {
  return {
    slice: "runtime-model-test",
    instructions: "Return structured output.",
    input: "{}",
    schema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } },
    schemaName: "runtime_model_test",
    limits: { maxOutputTokens: 128, deadlineMs: 5_000 },
    reasoning: { mode: "on", effort: "low" },
    signal: new AbortController().signal,
  };
}

describe("Claude Code runtime model compatibility", () => {
  it("declares transport identity independently and validates bounded argument-safe selectors", () => {
    expect(CLAUDE_CODE_TRANSPORT_PROFILE).toMatchObject({
      id: "anthropic:claude-code-cli",
      transport: "claude-code-cli",
      requestAccounting: "opaque",
      fallback: "disabled",
      runtimeVersionPolicy: "exact-evidence",
    });
    expect(validateClaudeCodeModelSelector("claude-future-9;$(not-a-shell)" )).toBe("claude-future-9;$(not-a-shell)");
    expect(() => validateClaudeCodeModelSelector("")).toThrow(/MODEL_SELECTOR_INVALID/);
    expect(() => validateClaudeCodeModelSelector(" sonnet")).toThrow(/MODEL_SELECTOR_INVALID/);
    expect(() => validateClaudeCodeModelSelector("sonnet\n--fallback-model")).toThrow(/control characters/);
    expect(() => validateClaudeCodeModelSelector("x".repeat(257))).toThrow(/256/);
  });

  it("bootstraps only the legacy exact selector from packaged evidence", async () => {
    const storeRoot = await mkdtemp(resolve(tmpdir(), "rb-runtime-model-empty-"));
    const exact = await inspectClaudeCodeCompatibility({ requestedModel: "claude-opus-5", transportVersion: "2.1.251 (Claude Code)", recordsRoot, storeRoot });
    const alias = await inspectClaudeCodeCompatibility({ requestedModel: "opus", transportVersion: "2.1.251 (Claude Code)", recordsRoot, storeRoot });
    expect(exact).toMatchObject({ state: "SUPPORTED", source: "packaged", resolvedModel: "claude-opus-5", target: { runtimeModel: { requestedModel: "claude-opus-5", selectorKind: "exact" } } });
    expect(alias).toMatchObject({ state: "UNVERIFIED" });
    expect(alias.target).toBeUndefined();
  });

  it("writes, reloads, and replays full runtime evidence only for the exact tuple", async () => {
    const storeRoot = await mkdtemp(resolve(tmpdir(), "rb-runtime-model-store-"));
    const evidence = buildClaudeCodeCompatibilityEvidence({ requestedModel: "sonnet", transportVersion: "2.1.251 (Claude Code)", recording: await dynamicRecording() });
    expect(evidence).toMatchObject({
      format: "rb-claude-code-runtime-compatibility/v1",
      providerFamily: "anthropic",
      transportProfileId: CLAUDE_CODE_TRANSPORT_PROFILE_ID,
      requestedModel: "sonnet",
      selectorKind: "alias",
      resolvedModel: "claude-sonnet-5",
      conformanceTier: "SUPPORTED",
      requestAccounting: "opaque",
      observedModelIdentities: ["claude-sonnet-5"],
      conformanceRecord: { runtimeEvidence: { invocationConfiguration: { modelId: "sonnet", fallbackModelConfigured: false } } },
    });
    expect(evidence.conformanceRecord.result.cases).toHaveLength(26);
    const path = await writeClaudeCodeCompatibilityEvidence(storeRoot, evidence);
    const reloaded = await readClaudeCodeCompatibilityEvidence(storeRoot, evidence.evidenceId);
    expect(reloaded).toEqual(evidence);
    expect(path).toBe(resolve(storeRoot, `${evidence.evidenceId}.json`));
    const inspection = await inspectClaudeCodeCompatibility({ requestedModel: "sonnet", transportVersion: "2.1.251 (Claude Code)", recordsRoot, storeRoot });
    expect(inspection).toMatchObject({ state: "SUPPORTED", source: "runtime", resolvedModel: "claude-sonnet-5", target: { id: CLAUDE_CODE_TRANSPORT_PROFILE_ID, runtimeModel: { requestedModel: "sonnet", resolvedModel: "claude-sonnet-5" } } });
    expect(JSON.stringify(reloaded)).not.toMatch(/sk-[A-Za-z0-9_-]{12,}/);
  });

  it("treats exact Claude Code version drift as stale", async () => {
    const storeRoot = await mkdtemp(resolve(tmpdir(), "rb-runtime-model-version-"));
    await writeClaudeCodeCompatibilityEvidence(storeRoot, buildClaudeCodeCompatibilityEvidence({ requestedModel: "sonnet", transportVersion: "2.1.251 (Claude Code)", recording: await dynamicRecording() }));
    const inspection = await inspectClaudeCodeCompatibility({ requestedModel: "sonnet", transportVersion: "2.1.252 (Claude Code)", recordsRoot, storeRoot });
    expect(inspection.state).toBe("STALE");
    expect(inspection.target).toBeUndefined();
  });

  it("records successful full verification in user state without touching packaged records", async () => {
    const storeRoot = await mkdtemp(resolve(tmpdir(), "rb-runtime-model-verify-"));
    const packagedBefore = await readFile(resolve(recordsRoot, "anthropic_claude-code-cli_claude-opus-5.json"), "utf8");
    const process = new RuntimeProcess(modelStream("claude-sonnet-5"));
    const adapter = new ClaudeCodeAdapter(process);
    const recording = await dynamicRecording();
    const result = await verifyClaudeCodeRuntimeCompatibility({
      requestedModel: "sonnet",
      recordsRoot,
      storeRoot,
      adapter,
      auth: ambient,
      record: async (profile) => {
        expect(profile.runtimeModel).toMatchObject({ requestedModel: "sonnet", compatibilitySource: "verification-pending" });
        expect(profile.runtimeModel?.resolvedModel).toBeUndefined();
        return recording;
      },
    });
    expect(result).toMatchObject({ target: { runtimeModel: { requestedModel: "sonnet", resolvedModel: "claude-sonnet-5", compatibilitySource: "runtime" } } });
    expect(await listClaudeCodeCompatibilityEvidence(storeRoot)).toHaveLength(1);
    expect(await readFile(resolve(recordsRoot, "anthropic_claude-code-cli_claude-opus-5.json"), "utf8")).toBe(packagedBefore);
  });

  it("persists failed full verification as unsupported and never returns an execution target", async () => {
    const storeRoot = await mkdtemp(resolve(tmpdir(), "rb-runtime-model-unsupported-"));
    const adapter = new ClaudeCodeAdapter(new RuntimeProcess(modelStream("claude-sonnet-5")));
    await expect(verifyClaudeCodeRuntimeCompatibility({
      requestedModel: "sonnet",
      recordsRoot,
      storeRoot,
      adapter,
      auth: ambient,
      record: async () => dynamicRecording("sonnet", "claude-sonnet-5", "2.1.251 (Claude Code)", false),
    })).rejects.toThrow(/MODEL_COMPATIBILITY_UNSUPPORTED/);
    expect(await listClaudeCodeCompatibilityEvidence(storeRoot)).toHaveLength(1);
    await expect(inspectClaudeCodeCompatibility({ requestedModel: "sonnet", transportVersion: "2.1.251 (Claude Code)", recordsRoot, storeRoot })).resolves.toMatchObject({ state: "UNSUPPORTED" });
  });

  it("rejects alias drift before exposing semantic payload and invalidates cached support", async () => {
    const storeRoot = await mkdtemp(resolve(tmpdir(), "rb-runtime-model-drift-"));
    const evidence = buildClaudeCodeCompatibilityEvidence({ requestedModel: "opus", transportVersion: "2.1.251 (Claude Code)", recording: await dynamicRecording("opus", "claude-opus-5") });
    await writeClaudeCodeCompatibilityEvidence(storeRoot, evidence);
    const supported = await inspectClaudeCodeCompatibility({ requestedModel: "opus", transportVersion: "2.1.251 (Claude Code)", recordsRoot, storeRoot });
    const process = new RuntimeProcess(modelStream("claude-opus-6"));
    const adapter = new ClaudeCodeAdapter(process);
    const result = await adapter.request(supported.target!, ambient, semanticRequest());
    expect(result).toMatchObject({ ok: false, error: { kind: "provider-error", message: expect.stringContaining("MODEL_COMPATIBILITY_STALE") } });
    expect(await claudeCodeCompatibilityEvidenceIsInvalidated(storeRoot, evidence)).toBe(true);
    const stale = await inspectClaudeCodeCompatibility({ requestedModel: "opus", transportVersion: "2.1.251 (Claude Code)", recordsRoot, storeRoot });
    expect(stale.state).toBe("STALE");
    expect(stale.target).toBeUndefined();
    const invocation = process.calls.find((call) => call.args.includes("--json-schema"))!;
    expect(invocation.args.slice(invocation.args.indexOf("--model"), invocation.args.indexOf("--model") + 2)).toEqual(["--model", "opus"]);
    expect(invocation.args).not.toContain("--fallback-model");
  });

  it("fails closed when model-bearing stream locations disagree", async () => {
    const storeRoot = await mkdtemp(resolve(tmpdir(), "rb-runtime-model-disagree-"));
    const evidence = buildClaudeCodeCompatibilityEvidence({ requestedModel: "sonnet", transportVersion: "2.1.251 (Claude Code)", recording: await dynamicRecording() });
    await writeClaudeCodeCompatibilityEvidence(storeRoot, evidence);
    const target = (await inspectClaudeCodeCompatibility({ requestedModel: "sonnet", transportVersion: "2.1.251 (Claude Code)", recordsRoot, storeRoot })).target!;
    const result = await new ClaudeCodeAdapter(new RuntimeProcess(modelStream("claude-sonnet-5", "claude-opus-5", "claude-sonnet-5")))
      .request(target, ambient, semanticRequest());
    expect(result).toMatchObject({ ok: false, error: { kind: "provider-error", message: expect.stringContaining("MODEL_IDENTITY_DISAGREEMENT") } });
  });

  it("rejects transport-version drift inside the adapter before the model invocation", async () => {
    const storeRoot = await mkdtemp(resolve(tmpdir(), "rb-runtime-model-adapter-version-"));
    const evidence = buildClaudeCodeCompatibilityEvidence({ requestedModel: "sonnet", transportVersion: "2.1.251 (Claude Code)", recording: await dynamicRecording() });
    await writeClaudeCodeCompatibilityEvidence(storeRoot, evidence);
    const target = (await inspectClaudeCodeCompatibility({ requestedModel: "sonnet", transportVersion: "2.1.251 (Claude Code)", recordsRoot, storeRoot })).target!;
    const process = new RuntimeProcess(modelStream("claude-sonnet-5"), "2.1.252 (Claude Code)");
    const result = await new ClaudeCodeAdapter(process).request(target, ambient, semanticRequest());
    expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining("MODEL_COMPATIBILITY_STALE") } });
    expect(process.calls.filter((call) => call.args.includes("--json-schema"))).toHaveLength(0);
  });

  it("cache deletion changes operational support only and persisted evidence rejects secrets", async () => {
    const storeRoot = await mkdtemp(resolve(tmpdir(), "rb-runtime-model-authority-"));
    const projectRoot = await mkdtemp(resolve(tmpdir(), "rb-runtime-model-project-"));
    const semanticPath = resolve(projectRoot, "project-description.md");
    await writeFile(semanticPath, "developer-owned semantics\n", "utf8");
    const evidence = buildClaudeCodeCompatibilityEvidence({ requestedModel: "sonnet", transportVersion: "2.1.251 (Claude Code)", recording: await dynamicRecording() });
    const evidencePath = await writeClaudeCodeCompatibilityEvidence(storeRoot, evidence);
    expect((await inspectClaudeCodeCompatibility({ requestedModel: "sonnet", transportVersion: "2.1.251 (Claude Code)", recordsRoot, storeRoot })).state).toBe("SUPPORTED");
    await unlink(evidencePath);
    expect((await inspectClaudeCodeCompatibility({ requestedModel: "sonnet", transportVersion: "2.1.251 (Claude Code)", recordsRoot, storeRoot })).state).toBe("UNVERIFIED");
    expect(await readFile(semanticPath, "utf8")).toBe("developer-owned semantics\n");

    const { integritySha256: _evidenceIntegrity, ...body } = evidence;
    const unsafe = sealClaudeCodeCompatibilityEvidence({ ...body, requestedModel: "sk-ant-secret-material-12345" });
    await expect(writeClaudeCodeCompatibilityEvidence(storeRoot, unsafe)).rejects.toThrow(/credential material/);
  });

  it("uses XDG user state and keeps compatibility cache outside project semantics", () => {
    expect(defaultProviderCompatibilityRoot({ XDG_STATE_HOME: "/tmp/xdg-state" }, "linux", "/home/example"))
      .toBe("/tmp/xdg-state/rb-harness/provider-compatibility");
    expect(defaultProviderCompatibilityRoot({}, "linux", "/home/example"))
      .toBe("/home/example/.local/state/rb-harness/provider-compatibility");
  });
});
