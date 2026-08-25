/**
 * Reasoning as a declared, explicit provider mode (0.4.3).
 *
 * A real run lost 65.536 output tokens to `reasoning_content` and produced no
 * document at all: the DeepSeek entry in the registry forced
 * `thinking: { type: "enabled" }` on every request, so a run that named no
 * `--effort` silently bought the provider's own high-intensity default. The
 * stream was healthy, the parser was correct, and `.rb` stayed empty.
 *
 * Reasoning is now a capability the registry declares and the runtime obeys.
 * Every case here runs against a local SSE server; no provider is paid.
 */

import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDirectApiAgent } from "../src/api-agent.js";
import { saveCredential } from "../src/credential-store.js";
import { directProvider, DIRECT_PROVIDERS } from "../src/provider-registry.js";
import { providerInvocation } from "../src/harness-provider.js";

const servers: Server[] = [];
const originalCredentialHome = process.env.RB_CREDENTIAL_HOME;
const originalUsageFile = process.env.RB_HARNESS_USAGE_FILE;

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => {
    server.closeAllConnections?.();
    server.close(() => done());
  })));
  if (originalCredentialHome === undefined) delete process.env.RB_CREDENTIAL_HOME;
  else process.env.RB_CREDENTIAL_HOME = originalCredentialHome;
  if (originalUsageFile === undefined) delete process.env.RB_HARNESS_USAGE_FILE;
  else process.env.RB_HARNESS_USAGE_FILE = originalUsageFile;
});

interface StreamServer {
  url: string;
  requests: Array<Record<string, unknown>>;
}

async function streamServer(
  script: (write: (chunk: string) => void, end: () => void, request: number) => void,
): Promise<StreamServer> {
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      try {
        requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      } catch {
        requests.push({});
      }
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      script(
        (chunk) => { if (!response.writableEnded) response.write(chunk); },
        () => { if (!response.writableEnded) response.end(); },
        requests.length,
      );
    });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}/v1/chat/completions`, requests };
}

async function credentialHome(): Promise<void> {
  process.env.RB_CREDENTIAL_HOME = await mkdtemp(resolve(tmpdir(), "rb-reasoning-auth-"));
  for (const provider of ["deepseek", "openai", "gemini", "minimax", "openrouter", "anthropic"] as const) {
    await saveCredential({ provider, protocol: "api-key", label: "default", secret: "local-fixture-secret" });
  }
}

function frame(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function delta(value: unknown): string {
  return frame({ choices: [{ delta: value }] });
}

function finish(reason = "stop", usage?: unknown): string {
  return frame({ choices: [{ delta: {}, finish_reason: reason }], ...(usage ? { usage } : {}) });
}

const DONE = "data: [DONE]\n\n";

async function project(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "rb-reasoning-project-"));
  await writeFile(resolve(root, "README.md"), "fixture\n", "utf8");
  return root;
}

/** A server that answers plainly, used when only the request shape matters. */
async function plainServer(): Promise<StreamServer> {
  return streamServer((write, end) => {
    write(delta({ content: "ok" }));
    write(finish());
    write(DONE);
    end();
  });
}

async function askDeepSeek(effort: string, endpoint: string, projectRoot: string): Promise<string> {
  return runDirectApiAgent({
    provider: "deepseek", model: "deepseek-v4-flash", effort, projectRoot,
    role: "harness-interview", permissionMode: "protected", prompt: "go", endpoint,
  });
}

describe("declared reasoning mode", () => {
  it("declares the thinking toggle in the registry instead of forcing it on every request", () => {
    const deepseek = directProvider("deepseek");
    expect(deepseek.reasoning).toEqual({
      protocol: "thinking-toggle",
      defaultMode: "disabled",
      disabledEffort: "none",
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
    });
    // The unconditional `thinking: enabled` that caused the loss is gone.
    expect(deepseek.requestExtensions).toBeUndefined();
  });

  it("disables thinking when no effort is given", async () => {
    await credentialHome();
    const server = await plainServer();
    await expect(askDeepSeek("", server.url, await project())).resolves.toBe("ok");
    expect(server.requests[0]).toMatchObject({ thinking: { type: "disabled" } });
    expect(server.requests[0]).not.toHaveProperty("reasoning_effort");
  }, 30_000);

  it("disables thinking for --effort none", async () => {
    await credentialHome();
    const server = await plainServer();
    await expect(askDeepSeek("none", server.url, await project())).resolves.toBe("ok");
    expect(server.requests[0]).toMatchObject({ thinking: { type: "disabled" } });
  }, 30_000);

  it("never sends reasoning_effort=none, because the toggle owns the shutdown", async () => {
    await credentialHome();
    const server = await plainServer();
    await askDeepSeek("none", server.url, await project());
    expect(JSON.stringify(server.requests[0])).not.toContain('"reasoning_effort"');
  }, 30_000);

  it("enables thinking and sends the intensity for --effort low", async () => {
    await credentialHome();
    const server = await plainServer();
    await expect(askDeepSeek("low", server.url, await project())).resolves.toBe("ok");
    expect(server.requests[0]).toMatchObject({
      thinking: { type: "enabled" },
      reasoning_effort: "low",
    });
  }, 30_000);

  it("follows the declared capability for every enabling effort", async () => {
    await credentialHome();
    const root = await project();
    for (const effort of directProvider("deepseek").reasoning?.supportedEfforts ?? []) {
      const server = await plainServer();
      await expect(askDeepSeek(effort, server.url, root)).resolves.toBe("ok");
      expect(server.requests[0]).toMatchObject({
        thinking: { type: "enabled" },
        reasoning_effort: effort,
      });
    }
  }, 60_000);

  it("rejects an unsupported effort before opening any connection", async () => {
    await credentialHome();
    const server = await plainServer();
    await expect(askDeepSeek("ultra", server.url, await project())).rejects.toThrow(
      /provider deepseek does not accept --effort "ultra".*none, low, medium, high, xhigh, max.*No request was started/s,
    );
    // The decisive assertion: nothing was sent, so nothing could be charged.
    expect(server.requests).toEqual([]);
  }, 30_000);
});

describe("reasoning that never becomes an answer", () => {
  /** The observed failure: thousands of reasoning deltas, no content, length. */
  async function exhaustedServer(): Promise<StreamServer> {
    return streamServer((write, end) => {
      for (let index = 0; index < 2280; index += 1) {
        write(delta({ reasoning_content: `step ${index} ` }));
      }
      write(finish("length", { prompt_tokens: 9501, completion_tokens: 65536, total_tokens: 75037 }));
      write(DONE);
      end();
    });
  }

  it("reproduces the observed run and names the cause exactly", async () => {
    await credentialHome();
    const server = await exhaustedServer();
    await expect(askDeepSeek("high", server.url, await project())).rejects.toThrow(
      /provider exhausted its output limit using reasoning without producing a final response/,
    );
  }, 60_000);

  it("reports finish reason, both event counts, usage, and that nothing was published", async () => {
    await credentialHome();
    const server = await exhaustedServer();
    const failure = await askDeepSeek("high", server.url, await project()).catch((error: Error) => error.message);
    expect(failure).toContain("finish_reason=length");
    expect(failure).toContain("reasoning events=2280");
    expect(failure).toContain("content events=0");
    expect(failure).toContain("input=9501");
    expect(failure).toContain("output=65536");
    expect(failure).toContain("no partial response was published");
  }, 60_000);

  it("does not invent a token count the provider never reported", async () => {
    await credentialHome();
    const server = await streamServer((write, end) => {
      write(delta({ reasoning_content: "thinking" }));
      write(finish("length"));
      write(DONE);
      end();
    });
    const failure = await askDeepSeek("high", server.url, await project()).catch((error: Error) => error.message);
    expect(failure).toContain("usage not reported by the provider");
    expect(failure).not.toMatch(/input=\d/);
  }, 30_000);

  it("publishes no partial answer and writes no artifact when reasoning exhausts the limit", async () => {
    await credentialHome();
    const root = await project();
    const before = await readdir(root);
    const server = await streamServer((write, end) => {
      write(delta({ reasoning_content: "RB_HARNESS_DOCUMENTS_JSON_BEGIN {\"contract\"" }));
      write(finish("length"));
      write(DONE);
      end();
    });
    const outcome = await runDirectApiAgent({
      provider: "deepseek", model: "deepseek-v4-flash", effort: "high", projectRoot: root,
      role: "harness-generation", permissionMode: "protected", prompt: "go",
      endpoint: server.url, artifactDirectory: resolve(root, ".rb"),
    }).then(() => "resolved", (error: Error) => error.message);
    expect(outcome).toContain("provider exhausted its output limit using reasoning");
    // No `.rb`, and not a single new entry in the project.
    expect(await readdir(root)).toEqual(before);
  }, 30_000);

  it("separates reasoning events from content events in the usage record", async () => {
    await credentialHome();
    const root = await project();
    const usageFile = resolve(await mkdtemp(resolve(tmpdir(), "rb-reasoning-usage-")), "usage.json");
    process.env.RB_HARNESS_USAGE_FILE = usageFile;
    const server = await streamServer((write, end) => {
      write(delta({ reasoning_content: "aaa" }));
      write(delta({ reasoning_content: "bb" }));
      write(delta({ content: "final" }));
      write(finish("stop", { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }));
      write(DONE);
      end();
    });
    await expect(askDeepSeek("low", server.url, root)).resolves.toBe("final");
    const usage = JSON.parse(await readFile(usageFile, "utf8")) as Record<string, number>;
    expect(usage.reasoningEvents).toBe(2);
    expect(usage.contentEvents).toBe(1);
    expect(usage.reasoningBytes).toBe(5);
    expect(usage.contentBytes).toBe(5);
  }, 30_000);

  it("records no reasoning text, prompt, or secret in the usage record", async () => {
    await credentialHome();
    const root = await project();
    const usageFile = resolve(await mkdtemp(resolve(tmpdir(), "rb-reasoning-hygiene-")), "usage.json");
    process.env.RB_HARNESS_USAGE_FILE = usageFile;
    const server = await streamServer((write, end) => {
      write(delta({ reasoning_content: "chain-of-thought-payload" }));
      write(delta({ content: "final" }));
      write(finish());
      write(DONE);
      end();
    });
    await askDeepSeek("low", server.url, root);
    const raw = await readFile(usageFile, "utf8");
    for (const forbidden of ["chain-of-thought-payload", "local-fixture-secret", "final"]) {
      expect(raw).not.toContain(forbidden);
    }
  }, 30_000);

  it("still delivers a normal answer byte for byte", async () => {
    await credentialHome();
    const envelope = "RB_HARNESS_DOCUMENTS_JSON_BEGIN\n{\"contract\":\"rb-harness-documents/v1\"}\nRB_HARNESS_DOCUMENTS_JSON_END";
    const server = await streamServer((write, end) => {
      write(delta({ reasoning_content: "private" }));
      for (let index = 0; index < envelope.length; index += 5) {
        write(delta({ content: envelope.slice(index, index + 5) }));
      }
      write(finish());
      write(DONE);
      end();
    });
    const answer = await runDirectApiAgent({
      provider: "deepseek", model: "deepseek-v4-flash", effort: "low", projectRoot: await project(),
      role: "harness-generation", permissionMode: "protected", prompt: "go", endpoint: server.url,
    });
    expect(answer).toBe(envelope);
    expect(answer).not.toContain("private");
  }, 30_000);
});

describe("providers that declare no reasoning capability", () => {
  it("keeps the OpenAI-compatible request each of them had before", async () => {
    await credentialHome();
    const root = await project();
    for (const id of ["openai", "gemini", "minimax", "openrouter"] as const) {
      expect(directProvider(id).reasoning).toBeUndefined();
      const server = await plainServer();
      await expect(runDirectApiAgent({
        provider: id, model: "fixture", effort: "high", projectRoot: root,
        role: "harness-interview", permissionMode: "protected", prompt: "go", endpoint: server.url,
      })).resolves.toBe("ok");
      const request = server.requests[0] as Record<string, unknown>;
      expect(request.reasoning_effort).toBe("high");
      expect(request).not.toHaveProperty("thinking");

      const bare = await plainServer();
      await runDirectApiAgent({
        provider: id, model: "fixture", effort: "", projectRoot: root,
        role: "harness-interview", permissionMode: "protected", prompt: "go", endpoint: bare.url,
      });
      // No effort, no capability: the body is untouched, exactly as before.
      expect(bare.requests[0]).not.toHaveProperty("reasoning_effort");
      expect(bare.requests[0]).not.toHaveProperty("thinking");
    }
  }, 60_000);

  it("keeps the Anthropic request untouched", async () => {
    await credentialHome();
    const root = await project();
    const server = await streamServer((write, end) => {
      write(`data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 4 } } })}\n\n`);
      write(`data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`);
      write(`data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n`);
      write(`data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`);
      write(`data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } })}\n\n`);
      write(`data: ${JSON.stringify({ type: "message_stop" })}\n\n`);
      end();
    });
    expect(directProvider("anthropic").reasoning).toBeUndefined();
    await expect(runDirectApiAgent({
      provider: "anthropic", model: "fixture", effort: "high", projectRoot: root,
      role: "harness-interview", permissionMode: "protected", prompt: "go", endpoint: server.url,
    })).resolves.toBe("ok");
    expect(server.requests[0]).toMatchObject({ output_config: { effort: "high" } });
    expect(server.requests[0]).not.toHaveProperty("thinking");
  }, 30_000);

  it("leaves every CLI adapter invocation unchanged", () => {
    const root = resolve(tmpdir(), "rb-reasoning-cli");
    const codex = providerInvocation({ provider: "codex", model: "gpt-5.6-sol", effort: "xhigh" }, "generation", root);
    expect(codex.args).toContain('model_reasoning_effort="xhigh"');
    const claude = providerInvocation({ provider: "claude", model: "opus", effort: "high" }, "generation", root);
    expect(claude.args).toEqual(expect.arrayContaining(["--effort", "high"]));
    const opencode = providerInvocation({ provider: "opencode", model: "m", effort: "low" }, "generation", root);
    expect(opencode.args).toEqual(expect.arrayContaining(["--variant", "low"]));
    // None of them learns about a thinking toggle.
    for (const invocation of [codex, claude, opencode]) {
      expect(JSON.stringify(invocation.args)).not.toContain("thinking");
    }
  });

  it("keeps exactly one provider declaring the capability", () => {
    const declaring = DIRECT_PROVIDERS.filter((entry) => entry.reasoning).map((entry) => entry.id);
    expect(declaring).toEqual(["deepseek"]);
  });
});
