import { chmod, copyFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ProviderOutcome, SemanticRequest } from "../../../src/vnext/providers/contract.js";
import { CODEX_SUBSCRIPTION_AUTH_ID, codexAuthStorePath, resolveCodexSubscriptionAuth } from "../../../src/vnext/providers/openai/codex/auth.js";
import { CodexSubscriptionAdapter } from "../../../src/vnext/providers/openai/codex/adapter.js";
import type { CodexRuntimeVerifier, VerifiedCodexRuntime } from "../../../src/vnext/providers/openai/codex/managed-runtime.js";
import { EMPTY_TOOL_MANIFEST_SHA256, type CodexAppServerRawResponse, type CodexSemanticPreflight } from "../../../src/vnext/providers/openai/codex/normalize.js";
import { codexThreadStartParams, codexTurnStartParams, type CodexAppServerInvocation, type CodexAppServerTransport } from "../../../src/vnext/providers/openai/codex/process.js";
import { CODEX_SUBSCRIPTION_PROFILE } from "../../../src/vnext/providers/openai/codex/profiles.js";
import { CODEX_SUBSCRIPTION_LOGIN } from "../../../src/vnext/providers/openai/codex/login.js";

const runtime: VerifiedCodexRuntime = {
  executable: "/managed/libexec/rb-codex",
  version: "0.151.0-rb.1",
  sha256: "b68d7cc25105d38cca12977164e45710ae4576a18f898269b563e743e100493d",
  semanticModeVersion: "v1",
  semanticRuntimeVersion: "rb-codex 0.151.0-rb.1 (upstream 78c290807ce710180111df227df3b7a4fe845452)",
  identity: "rb-codex 0.151.0-rb.1 (upstream 78c290807ce710180111df227df3b7a4fe845452; semantic-mode v1)",
};

const auth = { kind: "external-auth-store" as const, id: CODEX_SUBSCRIPTION_AUTH_ID, storeKind: "file" as const, path: "/home/test/.codex/auth.json" };

function request(overrides: Partial<SemanticRequest> = {}): SemanticRequest {
  return {
    slice: "codex-offline",
    instructions: "CALLER INSTRUCTIONS",
    input: JSON.stringify({ items: [] }),
    schema: { type: "object", required: ["items"], properties: { items: { type: "array", items: {} } } },
    schemaName: "codex_offline",
    limits: { maxOutputTokens: 512, deadlineMs: 5_000 },
    reasoning: { mode: "off" },
    signal: new AbortController().signal,
    ...overrides,
  };
}

function preflight(overrides: Partial<CodexSemanticPreflight> = {}): CodexSemanticPreflight {
  return {
    semanticMode: true, semanticModeVersion: "v1", runtimeVersion: "rb-codex 0.151.0-rb.1 (upstream 78c290807ce710180111df227df3b7a4fe845452)",
    model: "gpt-5.6-sol", modelProvider: "openai", toolPolicy: "none", effectiveToolCount: 0,
    toolManifestDigest: EMPTY_TOOL_MANIFEST_SHA256, instructionPolicy: "isolated", outputSchemaStrict: false,
    authenticated: true, authMode: "chatgpt", authStoreKind: "file", sessionMode: "ephemeral",
    requestedCodexTurns: 1, requestAccounting: "opaque", ...overrides,
  };
}

function raw(overrides: Partial<CodexAppServerRawResponse> = {}): CodexAppServerRawResponse {
  return {
    preflight: preflight(),
    completion: { initialModel: "gpt-5.6-sol", initialModelProvider: "openai", finalModel: "gpt-5.6-sol", finalModelProvider: "openai", rerouted: false },
    terminalStatus: "completed",
    finalMessages: [JSON.stringify({ items: [] })],
    actionCounts: { commandExecutionEvents: 0, fileChangeEvents: 0, mcpToolEvents: 0, appToolEvents: 0, webSearchEvents: 0, otherToolEvents: 0 },
    usage: { inputTokens: 10, cachedInputTokens: 2, cacheWriteInputTokens: 0, outputTokens: 3, reasoningOutputTokens: 1 },
    startedAt: "2026-09-04T00:00:00.000Z", completedAt: "2026-09-04T00:00:01.000Z",
    firstOutputMs: 10, streamComplete: true, processCompleted: true, ...overrides,
  };
}

class FixedVerifier implements CodexRuntimeVerifier {
  constructor(private readonly result: ProviderOutcome<VerifiedCodexRuntime> = { ok: true, value: runtime }) {}
  verify(): Promise<ProviderOutcome<VerifiedCodexRuntime>> { return Promise.resolve(this.result); }
}

class FakeTransport implements CodexAppServerTransport {
  readonly calls: CodexAppServerInvocation[] = [];
  turnStarted = 0;
  constructor(private readonly result: CodexAppServerRawResponse = raw()) {}
  async run(input: CodexAppServerInvocation): Promise<CodexAppServerRawResponse> {
    this.calls.push(input);
    input.acceptPreflight(this.result.preflight);
    this.turnStarted += 1;
    return this.result;
  }
}

function runtimeFailure(message: string): ProviderOutcome<VerifiedCodexRuntime> {
  return { ok: false, error: { kind: "unsupported-capability", message, transportRetryable: false } };
}

describe("Codex Subscription app-server adapter", () => {
  it("exposes a distinct non-credential login choice", () => {
    expect(CODEX_SUBSCRIPTION_LOGIN).toEqual({ id: "codex-subscription", label: "Codex / ChatGPT Subscription" });
  });
  it.each([
    "managed executable is missing",
    "managed executable SHA-256 mismatch",
    "managed executable identity mismatch",
  ])("fails closed before app-server when runtime verification reports %s", async (message) => {
    const transport = new FakeTransport();
    const result = await new CodexSubscriptionAdapter(transport, new FixedVerifier(runtimeFailure(message)))
      .request(CODEX_SUBSCRIPTION_PROFILE, auth, request());
    expect(result).toMatchObject({ ok: false, error: { kind: "unsupported-capability" } });
    expect(transport.calls).toHaveLength(0);
  });

  it("resolves only the HOME-derived auth file without reading or copying its contents", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "rb-codex-auth-"));
    const path = codexAuthStorePath(home);
    await import("node:fs/promises").then(({ mkdir }) => mkdir(resolve(home, ".codex"), { recursive: true }));
    await writeFile(path, "TOKEN-CONTENTS-MUST-REMAIN-RB-CODEX-OWNED", "utf8");
    await expect(resolveCodexSubscriptionAuth(home)).resolves.toEqual({ ...auth, path });
    expect(await readFile(path, "utf8")).toBe("TOKEN-CONTENTS-MUST-REMAIN-RB-CODEX-OWNED");
    await expect(resolveCodexSubscriptionAuth(resolve(home, "absent"))).rejects.toThrow(/rb-harness --login/);
  });

  it.each([
    ["tool count", { effectiveToolCount: 1 }],
    ["wrong model", { model: "gpt-5.6-terra" }],
    ["wrong provider", { modelProvider: "other" }],
    ["strict schema", { outputSchemaStrict: true }],
    ["non-ephemeral session", { sessionMode: "persistent" }],
    ["auth absent", { authenticated: false }],
  ])("rejects %s at semantic preflight before turn/start", async (_label, override) => {
    const transport = new FakeTransport(raw({ preflight: preflight(override) }));
    const result = await new CodexSubscriptionAdapter(transport, new FixedVerifier()).request(CODEX_SUBSCRIPTION_PROFILE, auth, request());
    expect(result.ok).toBe(false);
    expect(transport.turnStarted).toBe(0);
  });

  it.each([
    ["action event", raw({ actionCounts: { commandExecutionEvents: 1, fileChangeEvents: 0, mcpToolEvents: 0, appToolEvents: 0, webSearchEvents: 0, otherToolEvents: 0 } })],
    ["zero final messages", raw({ finalMessages: [] })],
    ["multiple final messages", raw({ finalMessages: ["{}", "{}"] })],
    ["rerouted model", raw({ completion: { initialModel: "gpt-5.6-sol", initialModelProvider: "openai", finalModel: "gpt-5.6-terra", finalModelProvider: "openai", rerouted: true } })],
  ])("fails closed on %s", async (_label, response) => {
    const result = await new CodexSubscriptionAdapter(new FakeTransport(response), new FixedVerifier()).request(CODEX_SUBSCRIPTION_PROFILE, auth, request());
    expect(result).toMatchObject({ ok: false, error: { kind: "provider-error" } });
  });

  it("accepts valid final JSON and rejects malformed JSON without normalization", async () => {
    const valid = await new CodexSubscriptionAdapter(new FakeTransport(), new FixedVerifier()).request(CODEX_SUBSCRIPTION_PROFILE, auth, request());
    expect(valid).toMatchObject({ ok: true, value: { payload: { items: [] }, normalizations: [], usage: { providerRequests: { measured: false } } } });
    const malformed = await new CodexSubscriptionAdapter(new FakeTransport(raw({ finalMessages: ["{bad"] })), new FixedVerifier())
      .request(CODEX_SUBSCRIPTION_PROFILE, auth, request());
    expect(malformed).toMatchObject({ ok: false, error: { kind: "malformed-syntax" } });
  });

  it("passes the schema unchanged, selects the exact model only at thread/start, and has no PATH fallback", async () => {
    const semantic = request();
    const transport = new FakeTransport();
    const result = await new CodexSubscriptionAdapter(transport, new FixedVerifier()).request(CODEX_SUBSCRIPTION_PROFILE, auth, semantic);
    expect(result.ok).toBe(true);
    expect(transport.calls[0]!.executable).toBe(runtime.executable);
    expect(transport.calls[0]!.outputSchema).toBe(semantic.schema);
    expect(codexThreadStartParams(transport.calls[0]!, "/isolated")).toEqual({ semanticMode: true, model: "gpt-5.6-sol", cwd: "/isolated", ephemeral: true });
    const turn = codexTurnStartParams("thread-id", transport.calls[0]!);
    expect(turn.outputSchema).toBe(semantic.schema);
    expect(turn).not.toHaveProperty("model");
    expect(JSON.stringify(turn)).not.toMatch(/personality|config|tool/i);
  });

  it("never accepts a vault credential or arbitrary ambient executable", async () => {
    const transport = new FakeTransport();
    const result = await new CodexSubscriptionAdapter(transport, new FixedVerifier()).request(CODEX_SUBSCRIPTION_PROFILE, {
      kind: "credential", credential: { id: "openai:default", secret: "must-not-enter-codex", attributes: {} },
    }, request());
    expect(result).toMatchObject({ ok: false, error: { kind: "auth" } });
    expect(transport.calls).toHaveLength(0);
  });

  it("uses the foreground JSONL app-server protocol with isolated state and completed-message authority", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rb-codex-app-server-fixture-"));
    const executable = resolve(root, "rb-codex.mjs");
    await copyFile(fileURLToPath(new URL("../../fixtures/fake-rb-codex-app-server.mjs", import.meta.url)), executable);
    await chmod(executable, 0o755);
    const semantic = request();
    const result = await new CodexSubscriptionAdapter(
      new (await import("../../../src/vnext/providers/openai/codex/process.js")).SpawnCodexAppServerTransport(),
      new FixedVerifier({ ok: true, value: { ...runtime, executable } }),
    ).request(CODEX_SUBSCRIPTION_PROFILE, auth, semantic);
    if (!result.ok) throw new Error(`${result.error.kind}: ${result.error.message}`);
    expect(result).toMatchObject({
      ok: true,
      value: { payload: { schema: semantic.schema, turnHasModel: false, inputCount: 2 } },
    });
  });
});
