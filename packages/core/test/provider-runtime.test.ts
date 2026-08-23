import { mkdtemp, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { apiAgentToolDefinitions, executeApiAgentTool } from "../src/api-agent-tools.js";
import { runDirectApiAgent } from "../src/api-agent.js";
import { credentialStorePaths, listCredentials, resolveCredential, saveCredential } from "../src/credential-store.js";
import { renderHarnessDashboard } from "../src/harness-dashboard.js";
import { providerInvocation } from "../src/harness-provider.js";

const originalCredentialHome = process.env.RB_CREDENTIAL_HOME;

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
  });
});

describe("local API agent policy", () => {
  test("keeps managers read-only and Harness writers inside .rb", async () => {
    const project = await mkdtemp(resolve(tmpdir(), "rb-provider-tools-"));
    await mkdir(resolve(project, ".rb"));
    await writeFile(resolve(project, "source.txt"), "hello\n", "utf8");
    const manager = { projectRoot: project, role: "ralph-manager" as const, permissionMode: "yolo" as const };
    const writer = { projectRoot: project, role: "harness-generation" as const, permissionMode: "protected" as const };

    expect(apiAgentToolDefinitions(manager).map((entry) => entry.name)).not.toContain("write_file");
    await expect(executeApiAgentTool(manager, "write_file", { path: "source.txt", content: "changed" })).rejects.toThrow("read-only");
    await expect(executeApiAgentTool(writer, "write_file", { path: "source.txt", content: "changed" })).rejects.toThrow("only under .rb");
    await expect(executeApiAgentTool(writer, "write_file", { path: ".rb/SPEC.md", content: "ready\n" })).resolves.toContain("wrote .rb/SPEC.md");
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
      const payload = requests.length === 1
        ? {
          choices: [{ message: { role: "assistant", content: null, reasoning_content: "kept", tool_calls: [{ id: "call-1", type: "function", function: { name: "list_files", arguments: "{}" } }] }, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        }
        : { choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 } };
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    }));

    await expect(runDirectApiAgent({
      provider: "deepseek", model: "deepseek-v4-pro", effort: "high", projectRoot: project,
      role: "harness-audit", permissionMode: "protected", prompt: "inspect",
    })).resolves.toBe("done");
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1])).toContain("README.md");
    expect(JSON.stringify(requests[1])).toContain("reasoning_content");
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
      const payload = requests.length === 1
        ? {
          content: [{ type: "tool_use", id: "tool-1", name: "read_file", input: { path: "SPEC.md" } }],
          stop_reason: "tool_use", usage: { input_tokens: 8, output_tokens: 3 },
        }
        : { content: [{ type: "text", text: "approved" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 1 } };
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
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
  });
});

test("direct providers invoke the installed runtime without placing secrets in argv", () => {
  const invocation = providerInvocation({ provider: "openrouter", model: "model/id", effort: "high", credential: "testes" }, "audit", "/tmp/project");
  expect(invocation.command).toBe(process.execPath);
  expect(invocation.args).toContain("_provider-run");
  expect(invocation.args).toContain("testes");
  expect(invocation.args.join(" ")).not.toMatch(/api.?key|secret-for-test/i);
});

test("Harness dashboard exposes pipeline and provider state without request content", () => {
  const output = renderHarnessDashboard({
    version: "0.2.4", startedAt: Date.now(), recent: ["estado · auditing"], paused: false, final: false,
    provider: { name: "openrouter", model: "vendor/model", mode: "audit", startedAt: Date.now(), bytes: 42, firstOutputMilliseconds: 900 },
  }, 118);
  expect(output).toContain("RB HARNESS");
  expect(output).toContain("PIPELINE");
  expect(output).toContain("openrouter/vendor/model");
  expect(output).toContain("capivara documentadora");
});
