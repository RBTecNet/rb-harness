import { mkdtemp, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { apiAgentToolDefinitions, createToolGovernor, executeApiAgentTool } from "../src/api-agent-tools.js";
import { HARNESS_BUDGET } from "../src/harness-budget.js";
import { emptyUsage } from "../src/harness-telemetry.js";
import { probeDirectProvider, runDirectApiAgent } from "../src/api-agent.js";
import { credentialStorePaths, listCredentials, resolveCredential, saveCredential } from "../src/credential-store.js";
import { renderHarnessDashboard } from "../src/harness-dashboard.js";
import { providerInvocation } from "../src/harness-provider.js";
import { collectProviderTestWizardOptions, providerListValue } from "../src/provider-cli.js";

const originalCredentialHome = process.env.RB_CREDENTIAL_HOME;

/**
 * An SSE response body. The runtime streams now, so a mocked provider must
 * speak the incremental protocol its dialect really uses.
 */
function sse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** One OpenAI-compatible `data:` frame. */
function openAiFrame(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

afterEach(() => {
  vi.restoreAllMocks();
  if (originalCredentialHome === undefined) delete process.env.RB_CREDENTIAL_HOME;
  else process.env.RB_CREDENTIAL_HOME = originalCredentialHome;
});

describe("shared direct-provider credentials", () => {
  test("encrypts secrets at rest and resolves labels without exposing values in metadata", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rb-provider-credentials-"));
    process.env.RB_CREDENTIAL_HOME = root;
    await saveCredential({ provider: "deepseek", protocol: "api-key", label: "pessoal", secret: "sk-secret-value-123456789" });

    const metadata = await readFile(credentialStorePaths().metadata, "utf8");
    expect(metadata).not.toContain("sk-secret-value-123456789");
    expect((await stat(credentialStorePaths().metadata)).mode & 0o777).toBe(0o600);
    expect(await listCredentials()).toEqual([
      expect.objectContaining({ id: "deepseek:pessoal", provider: "deepseek", protocol: "api-key" }),
    ]);
    expect((await resolveCredential("deepseek", "pessoal")).secret).toBe("sk-secret-value-123456789");
    expect((await resolveCredential("deepseek", "deepseek:pessoal")).secret).toBe("sk-secret-value-123456789");
  });

  test("accepts the normalized credential slug and reports valid IDs for a mismatch", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rb-provider-selector-"));
    process.env.RB_CREDENTIAL_HOME = root;
    await saveCredential({ provider: "deepseek", protocol: "api-key", label: "DeepSeek Api Oficial", secret: "selector-secret-for-test" });

    expect((await resolveCredential("deepseek", "deepseek-api-oficial")).secret).toBe("selector-secret-for-test");
    await expect(resolveCredential("deepseek", "inexistente"))
      .rejects.toThrow("available IDs: deepseek:deepseek-api-oficial");
  });

  test("lists provider configuration without returning secret material", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rb-provider-list-"));
    process.env.RB_CREDENTIAL_HOME = root;
    await saveCredential({ provider: "openrouter", protocol: "api-key", label: "trabalho", secret: "openrouter-secret-for-test" });

    const value = await providerListValue();
    expect(value.contract).toBe("rb-provider-list/v1");
    expect(value.providers.find((entry) => entry.id === "codex")).toEqual(expect.objectContaining({ configuration: "external-login" }));
    expect(value.providers.find((entry) => entry.id === "openrouter")).toEqual(expect.objectContaining({
      configuration: "configured",
      credentials: [expect.objectContaining({ id: "openrouter:trabalho", protocol: "api-key", default: true })],
    }));
    expect(JSON.stringify(value)).not.toContain("openrouter-secret-for-test");
  });

  test("builds an interactive provider test from configured non-secret metadata", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rb-provider-test-wizard-"));
    process.env.RB_CREDENTIAL_HOME = root;
    await saveCredential({ provider: "deepseek", protocol: "api-key", label: "Produção", secret: "wizard-secret-for-test" });
    const answers = ["1", "deepseek-v4-pro", "high", "45", ""];
    let rendered = "";

    const options = await collectProviderTestWizardOptions({ timeout: 60 }, {
      interactive: true,
      question: async (prompt) => {
        rendered += prompt;
        return answers.shift() ?? "";
      },
      write: (value) => { rendered += value; },
    });

    expect(options).toEqual({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      credential: "deepseek:produ-o",
      effort: "high",
      timeout: 45,
    });
    expect(rendered).toContain("Provedores configurados");
    expect(rendered).toContain("Comando equivalente");
    expect(rendered).not.toContain("wizard-secret-for-test");
    expect(answers).toEqual([]);
  });

  test("refuses to wait for wizard answers outside a terminal", async () => {
    await expect(collectProviderTestWizardOptions({ timeout: 60 }, {
      interactive: false,
      question: async () => "",
      write: () => undefined,
    })).rejects.toThrow("requires --provider and --model outside an interactive terminal");
  });
});

describe("local API agent policy", () => {
  test("gives documentation roles three read tools and nothing else", async () => {
    const project = await mkdtemp(resolve(tmpdir(), "rb-provider-tools-"));
    await mkdir(resolve(project, ".rb"));
    await writeFile(resolve(project, "source.txt"), "hello\n", "utf8");
    const manager = { projectRoot: project, role: "ralph-manager" as const, permissionMode: "yolo" as const };

    for (const role of ["harness-interview", "harness-generation", "harness-repair"] as const) {
      const context = { projectRoot: project, role, permissionMode: "protected" as const, governor: createToolGovernor() };
      expect(apiAgentToolDefinitions(context).map((entry) => entry.name)).toEqual(["list_files", "read_file", "search_text"]);
      await expect(executeApiAgentTool(context, "write_file", { path: ".rb/SPEC.md", content: "x" })).rejects.toThrow("read-only");
      await expect(executeApiAgentTool(context, "run_command", { argv: ["ls"] })).rejects.toThrow("only to the Ralph executor");
      await expect(executeApiAgentTool(context, "git_diff", {})).resolves.toBeDefined();
    }
    expect(apiAgentToolDefinitions(manager).map((entry) => entry.name)).not.toContain("write_file");
    await expect(executeApiAgentTool(manager, "write_file", { path: "source.txt", content: "changed" })).rejects.toThrow("read-only");
  });

  test("refuses a repeated identical documentation tool call and an exhausted budget", async () => {
    const project = await mkdtemp(resolve(tmpdir(), "rb-provider-governor-"));
    await writeFile(resolve(project, "README.md"), "one\ntwo\n", "utf8");
    const context = {
      projectRoot: project,
      role: "harness-generation" as const,
      permissionMode: "protected" as const,
      governor: createToolGovernor(),
    };
    await executeApiAgentTool(context, "read_file", { path: "README.md" });
    await executeApiAgentTool(context, "read_file", { path: "README.md" });
    await expect(executeApiAgentTool(context, "read_file", { path: "README.md" }))
      .rejects.toThrow("without progress");

    const exhausted = {
      ...context,
      governor: { calls: HARNESS_BUDGET.tools.maxCalls, outputBytes: 0, repeats: 0 },
    };
    await expect(executeApiAgentTool(exhausted, "list_files", {})).rejects.toThrow("tool budget");
  });

  test("leaves the Ralph executor and manager roles exactly as they were", async () => {
    const project = await mkdtemp(resolve(tmpdir(), "rb-provider-ralph-roles-"));
    await mkdir(resolve(project, ".rb"));
    await writeFile(resolve(project, "source.txt"), "hello\n", "utf8");
    const executor = {
      projectRoot: project,
      role: "ralph-agent" as const,
      permissionMode: "yolo" as const,
      artifactDirectory: ".rb",
    };
    const manager = { projectRoot: project, role: "ralph-manager" as const, permissionMode: "yolo" as const };

    expect(apiAgentToolDefinitions(executor).map((entry) => entry.name)).toEqual([
      "list_files", "read_file", "search_text", "git_diff", "write_file", "replace_text", "run_command",
    ]);
    expect(apiAgentToolDefinitions(manager).map((entry) => entry.name)).toEqual([
      "list_files", "read_file", "search_text", "git_diff",
    ]);
    await expect(executeApiAgentTool(executor, "write_file", { path: "source.txt", content: "changed\n" }))
      .resolves.toContain("wrote source.txt");
    // Ralph planning artifacts and the control plane stay read-only for it.
    await expect(executeApiAgentTool(executor, "write_file", { path: ".rb/PLAN.md", content: "x" }))
      .rejects.toThrow("Ralph planning artifacts are read-only");
    await expect(executeApiAgentTool(executor, "write_file", { path: ".git/config", content: "x" }))
      .rejects.toThrow("control-plane paths are read-only");
  });

  test("confines optional Ralph evidence to its submission directory", async () => {
    const project = await mkdtemp(resolve(tmpdir(), "rb-provider-evidence-project-"));
    const evidence = await mkdtemp(resolve(tmpdir(), "rb-provider-evidence-submission-"));
    const executor = {
      projectRoot: project,
      role: "ralph-agent" as const,
      permissionMode: "yolo" as const,
      evidenceDirectory: evidence,
    };

    expect(apiAgentToolDefinitions(executor).map((entry) => entry.name)).toContain("write_evidence");
    await expect(executeApiAgentTool(executor, "write_evidence", { path: "proof/result.txt", content: "ok\n" }))
      .resolves.toContain("proof/result.txt");
    expect(await readFile(resolve(evidence, "proof/result.txt"), "utf8")).toBe("ok\n");
    await symlink(project, resolve(evidence, "escape"));
    await expect(executeApiAgentTool(executor, "write_evidence", { path: "escape/outside.txt", content: "no" }))
      .rejects.toThrow("outside the submission directory");
    await expect(executeApiAgentTool(executor, "write_evidence", { path: ".env", content: "SECRET=no" }))
      .rejects.toThrow("secret evidence files");
  });

  test("runs an OpenAI-compatible tool loop with a saved credential", async () => {
    const project = await mkdtemp(resolve(tmpdir(), "rb-provider-agent-"));
    const auth = await mkdtemp(resolve(tmpdir(), "rb-provider-auth-"));
    process.env.RB_CREDENTIAL_HOME = auth;
    await writeFile(resolve(project, "README.md"), "project\n", "utf8");
    await saveCredential({ provider: "deepseek", protocol: "api-key", label: "default", secret: "secret-for-test" });
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as Record<string, unknown>;
      requests.push(request);
      return requests.length === 1
        ? sse([
          openAiFrame({ choices: [{ delta: { role: "assistant", reasoning_content: "kept" } }] }),
          openAiFrame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "list_files", arguments: "" } }] } }] }),
          openAiFrame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] } }] }),
          openAiFrame({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }),
          "data: [DONE]\n\n",
        ])
        : sse([
          openAiFrame({ choices: [{ delta: { content: "done" } }] }),
          openAiFrame({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 } }),
          "data: [DONE]\n\n",
        ]);
    }));

    await expect(runDirectApiAgent({
      provider: "deepseek", model: "deepseek-v4-pro", effort: "high", projectRoot: project,
      role: "harness-generation", permissionMode: "protected", prompt: "inspect",
    })).resolves.toBe("done");
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1])).toContain("README.md");
    expect(JSON.stringify(requests[1])).toContain("reasoning_content");
    // Stable prefix: the system instruction, prompt, and tool catalog are
    // byte-identical across steps; only tool results are appended.
    const first = requests[0] as { messages: unknown[]; tools: unknown };
    const second = requests[1] as { messages: unknown[]; tools: unknown };
    expect(JSON.stringify(second.tools)).toBe(JSON.stringify(first.tools));
    expect(JSON.stringify(second.messages.slice(0, 2))).toBe(JSON.stringify(first.messages));
    expect(second.messages.length).toBeGreaterThan(first.messages.length);
  });

  test("records provider-reported usage including cache into the harness usage file", async () => {
    const project = await mkdtemp(resolve(tmpdir(), "rb-provider-usage-"));
    const auth = await mkdtemp(resolve(tmpdir(), "rb-provider-usage-auth-"));
    const usageFile = resolve(project, "usage.json");
    process.env.RB_CREDENTIAL_HOME = auth;
    process.env.RB_HARNESS_USAGE_FILE = usageFile;
    await saveCredential({ provider: "deepseek", protocol: "api-key", label: "default", secret: "secret-for-test" });
    vi.stubGlobal("fetch", vi.fn(async () => sse([
      openAiFrame({ choices: [{ delta: { content: "ok" } }] }),
      openAiFrame({
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 900, completion_tokens: 40, total_tokens: 940, prompt_tokens_details: { cached_tokens: 850 } },
      }),
      "data: [DONE]\n\n",
    ])));
    try {
      await runDirectApiAgent({
        provider: "deepseek", model: "deepseek-v4-pro", effort: "high", projectRoot: project,
        role: "harness-interview", permissionMode: "protected", prompt: "analyze",
      });
      expect(JSON.parse(await readFile(usageFile, "utf8"))).toMatchObject({
        schema: "rb-harness-usage/v1",
        requests: 1,
        inputTokens: 900,
        cachedInputTokens: 850,
        outputTokens: 40,
        totalTokens: 940,
        toolCalls: 0,
      });
    } finally {
      delete process.env.RB_HARNESS_USAGE_FILE;
    }
  });

  test("reports an HTTP failure with its provider message and retry hint", async () => {
    const project = await mkdtemp(resolve(tmpdir(), "rb-provider-http-error-"));
    const auth = await mkdtemp(resolve(tmpdir(), "rb-provider-http-error-auth-"));
    process.env.RB_CREDENTIAL_HOME = auth;
    await saveCredential({ provider: "deepseek", protocol: "api-key", label: "default", secret: "secret-for-test" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: { message: "rate limit reached" } }),
      { status: 429, headers: { "content-type": "application/json", "retry-after": "30" } },
    )));

    await expect(runDirectApiAgent({
      provider: "deepseek", model: "deepseek-v4-pro", effort: "", projectRoot: project,
      role: "harness-generation", permissionMode: "protected", prompt: "write",
    })).rejects.toThrow("provider HTTP 429: rate limit reached; retry after 30s");
  });

  test("probes a direct provider with one bounded PING/PONG request", async () => {
    const auth = await mkdtemp(resolve(tmpdir(), "rb-provider-probe-auth-"));
    process.env.RB_CREDENTIAL_HOME = auth;
    await saveCredential({ provider: "openai", protocol: "api-key", label: "teste", secret: "openai-secret-for-test" });
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer openai-secret-for-test");
      expect(String(init.body)).toContain("PING");
      return new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "PONG" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(probeDirectProvider({ provider: "openai", model: "test-model", credential: "teste", timeoutSeconds: 30 }))
      .resolves.toEqual(expect.objectContaining({
        provider: "openai", model: "test-model", credentialId: "openai:teste", protocol: "api-key",
        response: "PONG", pong: true, totalTokens: 9,
      }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("runs an Anthropic Messages tool loop with API-key headers and read-only tools", async () => {
    const project = await mkdtemp(resolve(tmpdir(), "rb-provider-anthropic-project-"));
    const auth = await mkdtemp(resolve(tmpdir(), "rb-provider-anthropic-auth-"));
    process.env.RB_CREDENTIAL_HOME = auth;
    await writeFile(resolve(project, "SPEC.md"), "contract\n", "utf8");
    await saveCredential({ provider: "anthropic", protocol: "api-key", label: "default", secret: "anthropic-secret-for-test" });
    const requests: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      requests.push({ headers: new Headers(init.headers), body: JSON.parse(String(init.body)) as Record<string, unknown> });
      const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
      return requests.length === 1
        ? sse([
          frame({ type: "message_start", message: { usage: { input_tokens: 8 } } }),
          frame({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool-1", name: "read_file" } }),
          frame({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":' } }),
          frame({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"SPEC.md"}' } }),
          frame({ type: "content_block_stop", index: 0 }),
          frame({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } }),
          frame({ type: "message_stop" }),
        ])
        : sse([
          frame({ type: "message_start", message: { usage: { input_tokens: 10 } } }),
          frame({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
          frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "approved" } }),
          frame({ type: "content_block_stop", index: 0 }),
          frame({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }),
          frame({ type: "message_stop" }),
        ]);
    }));

    await expect(runDirectApiAgent({
      provider: "anthropic", model: "claude-model", effort: "high", projectRoot: project,
      role: "ralph-manager", permissionMode: "yolo", prompt: "audit",
    })).resolves.toBe("approved");
    expect(requests).toHaveLength(2);
    expect(requests[0]!.headers.get("x-api-key")).toBe("anthropic-secret-for-test");
    expect(requests[0]!.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(JSON.stringify(requests[1]!.body)).toContain("tool_result");
    expect(JSON.stringify(requests[0]!.body)).not.toContain("write_file");
    // The stable system + tool prefix is marked cacheable and never mutated.
    expect(JSON.stringify(requests[0]!.body.system)).toContain("cache_control");
    expect(JSON.stringify(requests[1]!.body.tools)).toBe(JSON.stringify(requests[0]!.body.tools));
    expect(JSON.stringify(requests[1]!.body.system)).toBe(JSON.stringify(requests[0]!.body.system));
  });
});

test("direct providers invoke the installed runtime without placing secrets in argv", () => {
  const invocation = providerInvocation({ provider: "openrouter", model: "model/id", effort: "high", credential: "testes" }, "generation", "/tmp/project");
  expect(invocation.command).toBe(process.execPath);
  expect(invocation.args).toContain("_provider-run");
  expect(invocation.args).toContain("testes");
  expect(invocation.args.join(" ")).not.toMatch(/api.?key|secret-for-test/i);
});

test("Harness dashboard exposes documentation stages and telemetry without request content", () => {
  const output = renderHarnessDashboard({
    version: "0.2.4",
    startedAt: Date.now(),
    stage: "generation",
    providerCalls: 2,
    usage: { ...emptyUsage(), measured: true, requests: 3, inputTokens: 1200, cachedInputTokens: 900, outputTokens: 200, totalTokens: 1400, toolCalls: 4 },
    recent: ["etapa · Geração do pacote"],
    paused: false,
    final: false,
    provider: { name: "openrouter", model: "vendor/model", mode: "generation", startedAt: Date.now(), bytes: 42, firstOutputMilliseconds: 900 },
  }, 118);
  expect(output).toContain("RB HARNESS");
  expect(output).toContain("PIPELINE DOCUMENTAL");
  expect(output).toContain("Materialização");
  expect(output).toContain("TELEMETRIA");
  expect(output).toContain("cache 900");
  expect(output).toContain("openrouter/vendor/model");
  expect(output).toContain("capivara documentadora");
});

test("dashboard telemetry states plainly when a provider reports no usage", () => {
  const output = renderHarnessDashboard({
    version: "0.2.4", startedAt: Date.now(), stage: "generation", providerCalls: 1,
    usage: emptyUsage(), recent: [], paused: false, final: false,
  }, 118);
  expect(output).toContain("não medidos");
});
