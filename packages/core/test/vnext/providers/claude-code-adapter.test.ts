import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  observeClaudeCode,
  type ClaudeCodeRawResponse,
} from "../../../src/vnext/providers/anthropic/claude-code/normalize.js";
import {
  CLAUDE_CODE_AMBIENT_AUTH_ID,
  ClaudeCodeAdapter,
  claudeCodeInvocationArgs,
} from "../../../src/vnext/providers/anthropic/claude-code/adapter.js";
import { CLAUDE_CODE_OPUS_5_PROFILE } from "../../../src/vnext/providers/anthropic/claude-code/profiles.js";
import {
  CLAUDE_CODE_GUARDED_ENVIRONMENT,
  claudeCodeChildEnvironment,
  type ClaudeCodeCommandInput,
  type ClaudeCodeCommandResult,
  type ClaudeCodeProcess,
} from "../../../src/vnext/providers/anthropic/claude-code/process.js";
import type { SemanticRequest } from "../../../src/vnext/providers/contract.js";

const ambient = { kind: "ambient-session" as const, id: CLAUDE_CODE_AMBIENT_AUTH_ID };

function request(overrides: Partial<SemanticRequest> = {}): SemanticRequest {
  return {
    slice: "opaque-correlation-label",
    instructions: "CALLER-INSTRUCTIONS-ONLY",
    input: JSON.stringify({ items: [] }),
    schema: { type: "object", required: ["items"], properties: { items: { type: "array", items: {} } } },
    schemaName: "opaque_schema_name",
    limits: { maxOutputTokens: 512, deadlineMs: 5_000 },
    reasoning: { mode: "on", effort: "low" },
    signal: new AbortController().signal,
    ...overrides,
  };
}

function eventStream(input: {
  payload?: unknown;
  numTurns?: number;
  stepIds?: readonly string[];
  modelIds?: readonly string[];
  tools?: readonly string[];
  mcpServers?: readonly string[];
  usedTools?: readonly string[];
  subagentsSpawned?: number;
  omitStructuredOutput?: boolean;
  subtype?: string;
} = {}): string {
  const expected = input.modelIds ?? ["claude-opus-5"];
  const lines: unknown[] = [{
    type: "system",
    subtype: "init",
    model: expected[0],
    tools: input.tools ?? [],
    mcp_servers: input.mcpServers ?? [],
    session_id: "must-be-sanitized",
    cwd: "/must/be/sanitized",
  }];
  for (const id of input.stepIds ?? ["msg_cli_step_1"]) {
    lines.push({
      type: "assistant",
      message: {
        id,
        model: expected[0],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 3 },
        content: (input.usedTools ?? []).map((name) => ({ type: "tool_use", name, id: `tool-${name}`, input: {} })),
      },
    });
  }
  const result: Record<string, unknown> = {
    type: "result",
    subtype: input.subtype ?? "success",
    is_error: (input.subtype ?? "success") !== "success",
    num_turns: input.numTurns ?? 1,
    usage: {
      input_tokens: 10,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 1,
      output_tokens: 3,
    },
    modelUsage: Object.fromEntries(expected.map((id) => [id, { costUSD: 9.99 }])),
    subagent_stats: { spawned: input.subagentsSpawned ?? 0 },
    total_cost_usd: 9.99,
  };
  if (!input.omitStructuredOutput) result.structured_output = input.payload ?? { items: [] };
  lines.push(result);
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

function settled(overrides: Partial<ClaudeCodeCommandResult> = {}): ClaudeCodeCommandResult {
  return {
    stdout: "",
    stderr: "",
    exitCode: 0,
    exitSignal: null,
    startedAt: "2026-08-29T00:00:00.000Z",
    completedAt: "2026-08-29T00:00:00.100Z",
    firstOutputMs: 10,
    cancelled: false,
    timedOut: false,
    outputLimitExceeded: false,
    settlement: {
      observed: true,
      quiescent: true,
      verified: true,
      containment: { kind: "cgroup2", structural: true, reason: "test containment" },
      survivors: [],
    },
    ...overrides,
  };
}

class FakeClaudeProcess implements ClaudeCodeProcess {
  readonly calls: ClaudeCodeCommandInput[] = [];
  readonly systemPrompts: string[] = [];
  constructor(private readonly modelResult: (input: ClaudeCodeCommandInput) => ClaudeCodeCommandResult | Promise<ClaudeCodeCommandResult> = () => settled({ stdout: eventStream() })) {}

  async run(input: ClaudeCodeCommandInput): Promise<ClaudeCodeCommandResult> {
    this.calls.push(input);
    if (input.args.includes("--version")) return settled({ stdout: "2.1.251 (Claude Code)\n" });
    if (input.args[0] === "auth") {
      return settled({ stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max", email: "not-persisted@example.test" }) });
    }
    const promptIndex = input.args.indexOf("--system-prompt-file");
    if (promptIndex >= 0) this.systemPrompts.push(await readFile(input.args[promptIndex + 1]!, "utf8"));
    return this.modelResult(input);
  }
}

describe("Claude Code CLI adapter", () => {
  it("does not treat a CLI synthetic API-error message as model fallback participation", () => {
    const observation = observeClaudeCode({
      events: [
        { type: "system", subtype: "init", model: "claude-opus-5", tools: ["StructuredOutput"], mcp_servers: [] },
        { type: "assistant", is_api_error_message: true, message: { id: "synthetic", model: "<synthetic>", content: [] } },
        { type: "result", subtype: "success", is_error: true, num_turns: 1, modelUsage: {}, subagent_stats: { spawned: 0 } },
      ],
      exitCode: 1,
      exitSignal: null,
      startedAt: "x",
      completedAt: "y",
      streamComplete: true,
      treeQuiescent: true,
      treeVerified: true,
    } satisfies ClaudeCodeRawResponse);
    expect(observation.modelIds).toEqual(["claude-opus-5"]);
    expect(observation.assistantStepIds).toEqual([]);
  });

  it("builds one isolated exact-model transport invocation without adapter prompt text", async () => {
    const process = new FakeClaudeProcess();
    const adapter = new ClaudeCodeAdapter(process);
    const outcome = await adapter.request(CLAUDE_CODE_OPUS_5_PROFILE, ambient, request());
    expect(outcome).toMatchObject({
      ok: true,
      value: {
        payload: { items: [] },
        normalizations: [],
        usage: {
          inputTokens: { measured: true, value: 10 },
          cachedInputTokens: { measured: true, value: 2 },
          cacheWriteTokens: { measured: true, value: 1 },
          outputTokens: { measured: true, value: 3 },
          providerRequests: { measured: false, reason: "unsupported-by-provider" },
          reasoningTokens: { measured: false },
          costUsd: { measured: false },
        },
      },
    });
    const invocation = process.calls[2]!;
    expect(invocation.stdin).toBe(request().input);
    expect(invocation.args).toEqual(expect.arrayContaining([
      "-p", "--safe-mode", "--restricted", "--strict-mcp-config", "--disable-slash-commands",
      "--no-chrome", "--no-session-persistence", "--max-turns", "1", "--model", "claude-opus-5",
      "--effort", "low", "--tools", "", "--disallowedTools", "mcp__*", "--json-schema",
    ]));
    expect(invocation.args).not.toContain("--fallback-model");
    expect(invocation.args).not.toContain(request().input);
    const promptPath = invocation.args[invocation.args.indexOf("--system-prompt-file") + 1]!;
    expect(await readFile(promptPath, "utf8").catch(() => "removed")).toBe("removed");
    expect(process.systemPrompts).toEqual([request().instructions]);
    expect(JSON.stringify(invocation.args)).not.toMatch(/Return JSON|Harness requirements|repair your answer/i);
    expect(adapter.modelInvocations).toBe(1);
  });

  it("removes API, OAuth, backend routing and hidden retry controls from the child environment", () => {
    const inherited = Object.fromEntries(CLAUDE_CODE_GUARDED_ENVIRONMENT.map((name) => [name, "sentinel"]));
    const child = claudeCodeChildEnvironment({ ...inherited, PATH: "/bin", UNRELATED_VALUE: "preserved" }, 777);
    for (const name of CLAUDE_CODE_GUARDED_ENVIRONMENT) {
      if (name === "CLAUDE_CODE_MAX_RETRIES" || name === "MAX_STRUCTURED_OUTPUT_RETRIES") continue;
      expect(child[name], name).toBeUndefined();
    }
    expect(child.CLAUDE_CODE_MAX_RETRIES).toBe("0");
    expect(child.MAX_STRUCTURED_OUTPUT_RETRIES).toBe("0");
    expect(child.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("777");
    expect(child.UNRELATED_VALUE).toBe("preserved");
  });

  it("fails subscription auth closed and never accepts a vault credential", async () => {
    const badAuth = new FakeClaudeProcess();
    badAuth.run = vi.fn(async (input: ClaudeCodeCommandInput) => {
      if (input.args.includes("--version")) return settled({ stdout: "2.1.251 (Claude Code)\n" });
      return settled({ stdout: JSON.stringify({ loggedIn: true, authMethod: "apiKey", apiProvider: "firstParty" }) });
    });
    expect(await new ClaudeCodeAdapter(badAuth).request(CLAUDE_CODE_OPUS_5_PROFILE, ambient, request()))
      .toMatchObject({ ok: false, error: { kind: "auth" } });

    const never = new FakeClaudeProcess();
    const credential = { kind: "credential" as const, credential: { id: "vault", secret: "must-not-be-read", attributes: {} } };
    expect(await new ClaudeCodeAdapter(never).request(CLAUDE_CODE_OPUS_5_PROFILE, credential, request()))
      .toMatchObject({ ok: false, error: { kind: "auth" } });
    expect(never.calls).toHaveLength(0);
  });

  it("accepts opaque multi-turn diagnostics without fabricating provider request counts", async () => {
    const process = new FakeClaudeProcess(() => settled({ stdout: eventStream({ numTurns: 2, stepIds: ["step-1"] }) }));
    const adapter = new ClaudeCodeAdapter(process);
    const result = await adapter.request(CLAUDE_CODE_OPUS_5_PROFILE, ambient, request());
    expect(result).toMatchObject({
      ok: true,
      value: {
        payload: { items: [] },
        usage: { providerRequests: { measured: false, reason: "unsupported-by-provider" } },
      },
    });
    expect(adapter.modelInvocations).toBe(1);
    expect(process.calls.filter((call) => call.args.includes("--json-schema"))).toHaveLength(1);
  });

  it("rejects fallback models, initialized tools, MCP, subagents, missing output and provider failures", async () => {
    for (const stdout of [
      eventStream({ modelIds: ["claude-opus-5", "claude-sonnet-5"] }),
      eventStream({ tools: ["Read"] }),
      eventStream({ usedTools: ["Read"] }),
      eventStream({ mcpServers: ["project-server"] }),
      eventStream({ subagentsSpawned: 1 }),
      eventStream({ subtype: "error_max_structured_output_retries" }),
    ]) {
      const result = await new ClaudeCodeAdapter(new FakeClaudeProcess(() => settled({ stdout })))
        .request(CLAUDE_CODE_OPUS_5_PROFILE, ambient, request());
      expect(result).toMatchObject({ ok: false, error: { kind: "provider-error", transportRetryable: false } });
    }

    const missing = await new ClaudeCodeAdapter(new FakeClaudeProcess(() => settled({ stdout: eventStream({ omitStructuredOutput: true }) })))
      .request(CLAUDE_CODE_OPUS_5_PROFILE, ambient, request());
    expect(missing).toMatchObject({ ok: false, error: { kind: "malformed-syntax" } });
  });

  it("returns semantically incomplete structured_output unchanged and rejects malformed envelopes", async () => {
    const incomplete = await new ClaudeCodeAdapter(new FakeClaudeProcess(() => settled({ stdout: eventStream({ payload: { items: [] } }) })))
      .request(CLAUDE_CODE_OPUS_5_PROFILE, ambient, request());
    expect(incomplete).toMatchObject({ ok: true, value: { payload: { items: [] } } });

    const malformed = await new ClaudeCodeAdapter(new FakeClaudeProcess(() => settled({ stdout: "{not-json}\n" })))
      .request(CLAUDE_CODE_OPUS_5_PROFILE, ambient, request());
    expect(malformed).toMatchObject({ ok: false, error: { kind: "malformed-syntax" } });
  });

  it("maps cancellation and timeout without a second invocation", async () => {
    const cancelledController = new AbortController();
    const cancelledProcess = new FakeClaudeProcess((input) => new Promise((resolveResult) => {
      if (input.signal.aborted) {
        resolveResult(settled({ cancelled: true, exitCode: null, exitSignal: "SIGTERM" }));
        return;
      }
      input.signal.addEventListener("abort", () => resolveResult(settled({ cancelled: true, exitCode: null, exitSignal: "SIGTERM" })), { once: true });
    }));
    const pending = new ClaudeCodeAdapter(cancelledProcess).request(
      CLAUDE_CODE_OPUS_5_PROFILE,
      ambient,
      request({ signal: cancelledController.signal }),
    );
    setTimeout(() => cancelledController.abort(), 50);
    const cancelled = await pending;
    expect(cancelled).toMatchObject({ ok: false, error: { kind: "cancelled" } });
    expect(cancelledProcess.calls.filter((call) => call.args.includes("--json-schema"))).toHaveLength(1);

    const timeoutProcess = new FakeClaudeProcess(() => settled({ timedOut: true, exitCode: null, exitSignal: "SIGTERM" }));
    const timedOut = await new ClaudeCodeAdapter(timeoutProcess).request(CLAUDE_CODE_OPUS_5_PROFILE, ambient, request());
    expect(timedOut).toMatchObject({ ok: false, error: { kind: "timeout" } });
    expect(timeoutProcess.calls.filter((call) => call.args.includes("--json-schema"))).toHaveLength(1);
  });

  it("rejects unsupported effort before spawning any process", async () => {
    const process = new FakeClaudeProcess();
    const result = await new ClaudeCodeAdapter(process).request(
      CLAUDE_CODE_OPUS_5_PROFILE,
      ambient,
      request({ reasoning: { mode: "on", effort: "medium" } }),
    );
    expect(result).toMatchObject({ ok: false, error: { kind: "unsupported-capability" } });
    expect(process.calls).toHaveLength(0);
  });

  it("keeps the system prompt exactly caller-owned in the argument builder", () => {
    const value = request();
    const args = claudeCodeInvocationArgs({ profile: CLAUDE_CODE_OPUS_5_PROFILE, request: value, systemPromptFile: "/tmp/prompt" });
    expect(args).not.toContain(value.instructions);
    expect(args[args.indexOf("--system-prompt-file") + 1]).toBe("/tmp/prompt");
  });
});
