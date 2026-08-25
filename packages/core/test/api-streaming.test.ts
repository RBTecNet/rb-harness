/**
 * Streaming transport for the direct-API runtime (0.4.2).
 *
 * The runtime used to request `stream: false`, so the subprocess stayed silent
 * until the whole agent loop finished. `--first-output-timeout 300` therefore
 * killed a legitimate generation at exactly 300s and threw away an answer that
 * had already been paid for.
 *
 * Every case here runs against a local HTTP server started by the test. No
 * network, no credentials beyond a temporary vault, no paid provider.
 */

import { createServer, type Server } from "node:http";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDirectApiAgent } from "../src/api-agent.js";
import { saveCredential } from "../src/credential-store.js";
import {
  ACTIVITY_PREFIX,
  ActivityReporter,
  parseActivityLine,
  readSseEvents,
} from "../src/api-stream.js";
import { runProvider } from "../src/harness-provider.js";
import { emitsActivityEvents, providerCapabilities } from "../src/provider-capabilities.js";
import { directProvider } from "../src/provider-registry.js";

const servers: Server[] = [];
const originalCredentialHome = process.env.RB_CREDENTIAL_HOME;

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => {
    server.closeAllConnections?.();
    server.close(() => done());
  })));
  if (originalCredentialHome === undefined) delete process.env.RB_CREDENTIAL_HOME;
  else process.env.RB_CREDENTIAL_HOME = originalCredentialHome;
});

interface StreamServer {
  url: string;
  requests: Array<Record<string, unknown>>;
}

/** A local SSE server driven by a per-request script of writes. */
async function streamServer(
  script: (write: (chunk: string) => void, end: () => void, request: number) => void | Promise<void>,
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
      void script(
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
  process.env.RB_CREDENTIAL_HOME = await mkdtemp(resolve(tmpdir(), "rb-stream-auth-"));
  await saveCredential({ provider: "deepseek", protocol: "api-key", label: "default", secret: "local-fixture-secret" });
  await saveCredential({ provider: "anthropic", protocol: "api-key", label: "default", secret: "local-fixture-secret" });
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
  const root = await mkdtemp(resolve(tmpdir(), "rb-stream-project-"));
  await writeFile(resolve(root, "README.md"), "fixture\n", "utf8");
  return root;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((done) => setTimeout(done, milliseconds));
}

describe("direct-API streaming transport", () => {
  it("declares streaming per provider instead of inferring it from an id", () => {
    for (const id of ["openai", "anthropic", "gemini", "deepseek", "minimax", "openrouter"] as const) {
      expect(directProvider(id).streaming.supported).toBe(true);
      expect(emitsActivityEvents(id)).toBe(true);
      // The result channel is unchanged: stdout still carries final text only.
      expect(providerCapabilities(id).stdoutTransport).toBe("final-text");
    }
    // Provider-specific request shaping lives in the registry, not at call sites.
    // Reasoning is declared as a capability (see api-reasoning.test.ts); the
    // unconditional `thinking: enabled` that burned an output limit is gone.
    expect(directProvider("deepseek").requestExtensions).toBeUndefined();
    expect(directProvider("deepseek").reasoning?.defaultMode).toBe("disabled");
    expect(directProvider("openrouter").headers?.["http-referer"]).toContain("rb-harness");
  });

  it("requests a stream and reconstructs text split across many chunks", async () => {
    await credentialHome();
    const server = await streamServer((write, end) => {
      for (const piece of ["The ", "answer ", "arrives ", "in ", "pieces."]) write(delta({ content: piece }));
      write(finish());
      write(DONE);
      end();
    });
    await expect(runDirectApiAgent({
      provider: "deepseek", model: "fixture", effort: "", projectRoot: await project(),
      role: "harness-interview", permissionMode: "protected", prompt: "go", endpoint: server.url,
    })).resolves.toBe("The answer arrives in pieces.");
    expect(server.requests[0]).toMatchObject({ stream: true, stream_options: { include_usage: true } });
  }, 30_000);

  it("delivers a fragmented RB envelope byte-identically to the parser", async () => {
    await credentialHome();
    const envelope = `RB_HARNESS_DOCUMENTS_JSON_BEGIN\n${JSON.stringify({
      contract: "rb-harness-documents/v1",
      status: "complete",
      summary: "Streamed in fragments.",
      documents: [{ path: ".rb/init/PROJECT.md", content: "# Project\n\nLine one.\nLine two.\n" }],
    })}\nRB_HARNESS_DOCUMENTS_JSON_END`;
    const server = await streamServer((write, end) => {
      // Split at arbitrary boundaries, including inside the JSON body.
      for (let index = 0; index < envelope.length; index += 7) {
        write(delta({ content: envelope.slice(index, index + 7) }));
      }
      write(finish());
      write(DONE);
      end();
    });
    const answer = await runDirectApiAgent({
      provider: "deepseek", model: "fixture", effort: "", projectRoot: await project(),
      role: "harness-generation", permissionMode: "protected", prompt: "go", endpoint: server.url,
    });
    expect(answer).toBe(envelope);
    const { parseDocumentBundle } = await import("../src/harness-documents.js");
    expect(parseDocumentBundle(answer).documents[0]?.content).toBe("# Project\n\nLine one.\nLine two.\n");
  }, 30_000);

  it("consumes reasoning internally and never merges it into the answer", async () => {
    await credentialHome();
    const server = await streamServer((write, end) => {
      write(delta({ reasoning_content: "secret chain of thought" }));
      write(delta({ content: "PUBLIC" }));
      write(delta({ reasoning_content: " more private thinking" }));
      write(finish());
      write(DONE);
      end();
    });
    const answer = await runDirectApiAgent({
      provider: "deepseek", model: "fixture", effort: "", projectRoot: await project(),
      role: "harness-interview", permissionMode: "protected", prompt: "go", endpoint: server.url,
    });
    expect(answer).toBe("PUBLIC");
    expect(answer).not.toContain("chain of thought");
    expect(answer).not.toContain("private thinking");
  }, 30_000);

  it("reassembles a tool call whose name and JSON span several deltas, executing it once", async () => {
    await credentialHome();
    const server = await streamServer((write, end, request) => {
      if (request === 1) {
        write(delta({ tool_calls: [{ index: 0, id: "call-a", function: { name: "read_", arguments: "" } }] }));
        write(delta({ tool_calls: [{ index: 0, function: { name: "file", arguments: '{"pa' } }] }));
        write(delta({ tool_calls: [{ index: 0, function: { arguments: 'th":"README.md"' } }] }));
        write(delta({ tool_calls: [{ index: 0, function: { arguments: "}" } }] }));
        write(finish("tool_calls"));
      } else {
        write(delta({ content: "used the tool" }));
        write(finish());
      }
      write(DONE);
      end();
    });
    const answer = await runDirectApiAgent({
      provider: "deepseek", model: "fixture", effort: "", projectRoot: await project(),
      role: "harness-interview", permissionMode: "protected", prompt: "go", endpoint: server.url,
    });
    expect(answer).toBe("used the tool");
    expect(server.requests).toHaveLength(2);
    const followUp = JSON.stringify(server.requests[1]);
    // Exactly one tool result, carrying the file the reassembled call named.
    expect(followUp).toContain("fixture");
    expect((followUp.match(/"role":"tool"/g) ?? [])).toHaveLength(1);
  }, 30_000);

  it("preserves the order and IDs of multiple tool calls", async () => {
    await credentialHome();
    const server = await streamServer((write, end, request) => {
      if (request === 1) {
        write(delta({ tool_calls: [{ index: 0, id: "call-first", function: { name: "list_files", arguments: "{}" } }] }));
        write(delta({ tool_calls: [{ index: 1, id: "call-second", function: { name: "read_file", arguments: '{"path":"README.md"}' } }] }));
        write(finish("tool_calls"));
      } else {
        write(delta({ content: "both done" }));
        write(finish());
      }
      write(DONE);
      end();
    });
    await runDirectApiAgent({
      provider: "deepseek", model: "fixture", effort: "", projectRoot: await project(),
      role: "harness-interview", permissionMode: "protected", prompt: "go", endpoint: server.url,
    });
    const messages = (server.requests[1] as { messages: Array<Record<string, unknown>> }).messages;
    const toolResults = messages.filter((message) => message.role === "tool");
    expect(toolResults.map((message) => message.tool_call_id)).toEqual(["call-first", "call-second"]);
    const assistant = messages.find((message) => Array.isArray(message.tool_calls)) as Record<string, unknown>;
    const calls = assistant.tool_calls as Array<{ id: string; function: { name: string } }>;
    expect(calls.map((call) => `${call.id}:${call.function.name}`)).toEqual([
      "call-first:list_files",
      "call-second:read_file",
    ]);
  }, 30_000);

  it("counts usage exactly once per response and keeps cached tokens", async () => {
    await credentialHome();
    const usageFile = resolve(await mkdtemp(resolve(tmpdir(), "rb-stream-usage-")), "usage.json");
    process.env.RB_HARNESS_USAGE_FILE = usageFile;
    const server = await streamServer((write, end, request) => {
      if (request === 1) {
        write(delta({ tool_calls: [{ index: 0, id: "c1", function: { name: "list_files", arguments: "{}" } }] }));
        write(finish("tool_calls", {
          prompt_tokens: 100, completion_tokens: 10, total_tokens: 110,
          prompt_tokens_details: { cached_tokens: 90 },
        }));
      } else {
        write(delta({ content: "done" }));
        write(finish("stop", {
          prompt_tokens: 200, completion_tokens: 20, total_tokens: 220,
          prompt_tokens_details: { cached_tokens: 180 },
        }));
      }
      write(DONE);
      end();
    });
    try {
      await runDirectApiAgent({
        provider: "deepseek", model: "fixture", effort: "", projectRoot: await project(),
        role: "harness-interview", permissionMode: "protected", prompt: "go", endpoint: server.url,
      });
      expect(JSON.parse(await readFile(usageFile, "utf8"))).toMatchObject({
        requests: 2,
        inputTokens: 300,
        cachedInputTokens: 270,
        outputTokens: 30,
        totalTokens: 330,
      });
    } finally {
      delete process.env.RB_HARNESS_USAGE_FILE;
    }
  }, 30_000);

  it("fails explicitly on a stream truncated before its terminal event", async () => {
    await credentialHome();
    const server = await streamServer((write, end) => {
      write(delta({ content: "half an ans" }));
      end(); // No finish_reason, no [DONE].
    });
    await expect(runDirectApiAgent({
      provider: "deepseek", model: "fixture", effort: "", projectRoot: await project(),
      role: "harness-interview", permissionMode: "protected", prompt: "go", endpoint: server.url,
    })).rejects.toThrow(/ended before signalling completion|truncated/);
  }, 30_000);

  it("fails explicitly on a malformed streaming event", async () => {
    await credentialHome();
    const server = await streamServer((write, end) => {
      write("data: {\"choices\": [ this is not json\n\n");
      write(DONE);
      end();
    });
    await expect(runDirectApiAgent({
      provider: "deepseek", model: "fixture", effort: "", projectRoot: await project(),
      role: "harness-interview", permissionMode: "protected", prompt: "go", endpoint: server.url,
    })).rejects.toThrow(/malformed event/);
  }, 30_000);

  it("aborts the stream on cancellation without publishing a partial answer", async () => {
    await credentialHome();
    let closed = false;
    const server = await streamServer((write, end) => {
      write(delta({ content: "partial answer that must never be used" }));
      // Never completes; only cancellation ends it.
      const timer = setInterval(() => write(": keep-alive\n\n"), 20);
      setTimeout(() => { clearInterval(timer); closed = true; end(); }, 5_000).unref();
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300).unref();
    await expect(runDirectApiAgent({
      provider: "deepseek", model: "fixture", effort: "", projectRoot: await project(),
      role: "harness-interview", permissionMode: "protected", prompt: "go",
      endpoint: server.url, signal: controller.signal,
    })).rejects.toThrow();
    // The reader is gone; nothing keeps running on our side.
    await sleep(100);
    expect(closed).toBe(false);
  }, 30_000);

  it("reconstructs fragmented Anthropic text and tool use", async () => {
    await credentialHome();
    const server = await streamServer((write, end, request) => {
      if (request === 1) {
        write(frame({ type: "message_start", message: { usage: { input_tokens: 11, cache_read_input_tokens: 7 } } }));
        write(frame({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "read_file" } }));
        write(frame({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"pa' } }));
        write(frame({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: 'th":"READ' } }));
        write(frame({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: 'ME.md"}' } }));
        write(frame({ type: "content_block_stop", index: 0 }));
        write(frame({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 4 } }));
        write(frame({ type: "message_stop" }));
      } else {
        write(frame({ type: "message_start", message: { usage: { input_tokens: 5 } } }));
        write(frame({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
        for (const piece of ["An", "throp", "ic ", "answer"]) {
          write(frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: piece } }));
        }
        write(frame({ type: "content_block_stop", index: 0 }));
        write(frame({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }));
        write(frame({ type: "message_stop" }));
      }
      end();
    });
    const answer = await runDirectApiAgent({
      provider: "anthropic", model: "fixture", effort: "", projectRoot: await project(),
      role: "harness-interview", permissionMode: "protected", prompt: "go", endpoint: server.url,
    });
    expect(answer).toBe("Anthropic answer");
    const followUp = JSON.stringify(server.requests[1]);
    expect(followUp).toContain("toolu_1");
    expect(followUp).toContain("fixture");
    expect(server.requests[0]).toMatchObject({ stream: true });
  }, 30_000);
});

describe("SSE reading and activity markers", () => {
  function body(text: string): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    });
  }

  it("never surfaces keep-alive comments as events", async () => {
    const events = [];
    for await (const event of readSseEvents(body(": ping\n\n: ping\n\ndata: {\"a\":1}\n\n"))) events.push(event);
    expect(events).toEqual([{ data: '{"a":1}' }]);
  });

  it("does not renew progress from keep-alive traffic", async () => {
    const { ProviderStreamObserver } = await import("../src/provider-events.js");
    const observer = new ProviderStreamObserver({ mode: "opaque", noProgressMilliseconds: 40 });
    observer.push("initial\n");
    // A keep-alive produces no activity marker, so nothing renews the window.
    const start = Date.now();
    while (Date.now() - start < 60) { /* the socket is open, the provider is silent */ }
    expect(observer.stalled()).toBe(true);
    // A real remote event does renew it.
    observer.noteActivity();
    expect(observer.stalled()).toBe(false);
  });

  it("emits content-free markers and throttles the noisy ones", () => {
    const lines: string[] = [];
    let now = 0;
    const reporter = new ActivityReporter((line) => lines.push(line.trim()), 200, () => now);
    reporter.report("response-start");
    reporter.report("content-delta");
    reporter.report("content-delta");   // throttled
    now = 300;
    reporter.report("content-delta");   // window elapsed
    reporter.report("response-complete");
    expect(lines).toEqual([
      `${ACTIVITY_PREFIX} response-start`,
      `${ACTIVITY_PREFIX} content-delta`,
      `${ACTIVITY_PREFIX} content-delta`,
      `${ACTIVITY_PREFIX} response-complete`,
    ]);
    // Markers carry a kind and nothing else.
    for (const line of lines) expect(line.split(" ")).toHaveLength(2);
  });

  it("recognizes only the declared marker kinds", () => {
    expect(parseActivityLine(`${ACTIVITY_PREFIX} response-start`)).toBe("response-start");
    expect(parseActivityLine(`${ACTIVITY_PREFIX} tool-call-delta`)).toBe("tool-call-delta");
    expect(parseActivityLine(`${ACTIVITY_PREFIX} something-else`)).toBeUndefined();
    expect(parseActivityLine("[rb-tool] read_file")).toBeUndefined();
    expect(parseActivityLine("ordinary provider chatter")).toBeUndefined();
  });
});

describe("first-output and progress semantics at the orchestrator", () => {
  const fixture = resolve(process.cwd(), "test/fixtures/standalone/streaming-provider.mjs");

  it("does not kill a run whose stream starts before the first-output deadline", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "rb-stream-slow-"));
    await chmod(fixture, 0o755);
    process.env.RB_HARNESS_TEST_STREAM_MODE = "slow-finish";
    try {
      // The first remote event lands at ~300ms, the answer only at ~2.5s: a
      // first-output deadline of 1s must not end it.
      const result = await runProvider({
        configuration: { provider: "custom", model: "fixture", effort: "", command: fixture },
        mode: "interview",
        stage: "gap-analysis",
        projectRoot: directory,
        prompt: "go",
        logPath: resolve(directory, "provider.log"),
        timeoutSeconds: 30,
        firstOutputTimeoutSeconds: 1,
      });
      expect(result.exitCode).toBe(0);
      expect(result.remoteEvents).toBeGreaterThan(0);
      expect(result.stdout).toContain("RB_HARNESS_INTERVIEW_JSON_END");
      const log = await readFile(resolve(directory, "provider.log"), "utf8");
      expect(log).toMatch(/^remote_events=[1-9]/m);
      expect(log).toMatch(/^first_remote_event_ms=\d+$/m);
    } finally {
      delete process.env.RB_HARNESS_TEST_STREAM_MODE;
    }
  }, 30_000);

  it("reproduces the 0.4.1 loss: silence until the end is killed by the deadline", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "rb-stream-legacy-"));
    await chmod(fixture, 0o755);
    process.env.RB_HARNESS_TEST_STREAM_MODE = "legacy-silent";
    try {
      // Same timing as the streaming case above, but with `stream: false`
      // semantics: no activity at all until the answer is complete. The run
      // dies at the deadline and the finished answer is thrown away — the
      // exact failure recorded in the cron2 generation log.
      await expect(runProvider({
        configuration: { provider: "custom", model: "fixture", effort: "", command: fixture },
        mode: "interview",
        stage: "gap-analysis",
        projectRoot: directory,
        prompt: "go",
        logPath: resolve(directory, "provider.log"),
        timeoutSeconds: 30,
        firstOutputTimeoutSeconds: 1,
      })).rejects.toThrow(/no output within 1s/);
      const log = await readFile(resolve(directory, "provider.log"), "utf8");
      expect(log).toMatch(/^first_output_ms=none$/m);
      expect(log).toMatch(/^remote_events=0$/m);
    } finally {
      delete process.env.RB_HARNESS_TEST_STREAM_MODE;
    }
  }, 30_000);

  it("still ends a run whose provider accepts the connection and sends nothing", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "rb-stream-silent-"));
    await chmod(fixture, 0o755);
    process.env.RB_HARNESS_TEST_STREAM_MODE = "silent";
    try {
      await expect(runProvider({
        configuration: { provider: "custom", model: "fixture", effort: "", command: fixture },
        mode: "interview",
        stage: "gap-analysis",
        projectRoot: directory,
        prompt: "go",
        logPath: resolve(directory, "provider.log"),
        timeoutSeconds: 30,
        firstOutputTimeoutSeconds: 1,
      })).rejects.toThrow(/no output within 1s/);
      const log = await readFile(resolve(directory, "provider.log"), "utf8");
      expect(log).toMatch(/^remote_events=0$/m);
      expect(log).toMatch(/^first_remote_event_ms=none$/m);
    } finally {
      delete process.env.RB_HARNESS_TEST_STREAM_MODE;
    }
  }, 30_000);

  it("keeps stdout final-text and the log free of reasoning, arguments, and secrets", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "rb-stream-hygiene-"));
    await chmod(fixture, 0o755);
    process.env.RB_HARNESS_TEST_STREAM_MODE = "sensitive";
    try {
      const result = await runProvider({
        configuration: { provider: "custom", model: "fixture", effort: "", command: fixture },
        mode: "interview",
        stage: "gap-analysis",
        projectRoot: directory,
        prompt: "go",
        logPath: resolve(directory, "provider.log"),
        timeoutSeconds: 30,
        firstOutputTimeoutSeconds: 5,
      });
      // stdout is the final answer and nothing else.
      expect(result.stdout).toBe(result.rawStdout);
      expect(result.stdout).toContain("RB_HARNESS_INTERVIEW_JSON_BEGIN");
      const log = await readFile(resolve(directory, "provider.log"), "utf8");
      for (const forbidden of ["chain-of-thought", "tool-argument-payload", "super-secret-key"]) {
        expect(result.stdout).not.toContain(forbidden);
        expect(log).not.toContain(forbidden);
      }
      expect(log).toMatch(/^stdout_transport=final-text$/m);
    } finally {
      delete process.env.RB_HARNESS_TEST_STREAM_MODE;
    }
  }, 30_000);

  it("leaves CLI adapters without an activity channel untouched", () => {
    for (const provider of ["codex", "claude", "opencode", "custom"] as const) {
      expect(emitsActivityEvents(provider)).toBe(false);
    }
    expect(providerCapabilities("opencode").stdoutTransport).toBe("jsonl-events");
  });
});
