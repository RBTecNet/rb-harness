import { createServer, type IncomingMessage, type RequestListener, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { sha256, sha256Canonical } from "../../src/vnext/ralph-runtime/hashing.js";
import { assertNoCredentialMaterial } from "../../src/vnext/ralph-runtime/operational-b1/secret-safety.js";
import type { WorkUnitV2 } from "../../src/vnext/ralph-runtime/operational-b3/index.js";
import {
  createOpenCodePromptArtifactV2,
  createOpenCodeProviderResultV2,
  validateOpenCodePromptArtifactV2,
  validateOpenCodeProviderResultV2,
} from "../../src/vnext/ralph-runtime/operational-b4/opencode-cli-result.js";
import {
  openCodeM4BChildEnvironment,
  openCodeM4BPermissionRulesV2,
} from "../../src/vnext/ralph-runtime/operational-b4/opencode-cli-process.js";
import {
  MAX_OPENCODE_HTTP_RESPONSE_BYTES_V2,
  OpenCodeCliHttpClientV2,
  parseExactAssistantTurnV2,
  parseAssistantResult,
} from "../../src/vnext/ralph-runtime/operational-b4/opencode-cli-session-inspector.js";
import { validateOpenCodeSessionExportTransportV2 } from "../../src/vnext/ralph-runtime/operational-b4/opencode-cli-transport-safety.js";
import { projectWorkUnitToOpenCodePromptV2 } from "../../src/vnext/ralph-runtime/operational-b4/opencode-cli-prompt.js";
import { projectObservableOpenCodeTurnV2 } from "../../src/vnext/ralph-runtime/operational-b4/opencode-cli-observable-turn.js";

const MODEL = "opencode-go/deepseek-v4-pro";
const SESSION = "ses_m4bDedicatedSession0001";
const USER_MESSAGE = "msg_ralph_m4b_core_owned_0001";
const ASSISTANT_MESSAGE = "msg_m4b_assistant_0001";
const PROJECT_ROOT = resolve("/tmp/rb-ralph-m4b-http-fixture");
// Derived with `opencode export ses_f8127251dffeek97LopgHplKoR --sanitize --pure`
// from the first real OpenCode 1.18.29 M4-B turn; no prompt was sent to capture it.
const REAL_TRANSCRIPT_SESSION = "ses_m4bRealSanitizedFixture001";
const REAL_TRANSCRIPT_USER = "msg_ralph_m4b_real_fixture_001";
const REAL_TRANSCRIPT_FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/opencode-cli-1.18.29-sanitized-tool-turn.json");
// Paired public views retrieved without a prompt from the same real OpenCode
// 1.18.29 session. The fixture retains the live-vs-sanitized redaction shape.
const DUAL_VIEW_SESSION = "ses_f80e11c17ffePBoHPiPJeH1wxf";
const DUAL_VIEW_USER = "msg_ralph_a7439ea788f86139dabe65cb15ed5e870e9bd381";
const DUAL_VIEW_FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/opencode-cli-1.18.29-dual-view-turn.json");
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolveClose) => server.close(() => resolveClose()))));
});

function workUnit(change = "create src/status.js"): WorkUnitV2 {
  const base = {
    schema: "rb-ralph-work-unit/v1" as const,
    workUnitId: `wu-${"1".repeat(64)}`,
    runId: "run-m4b-components",
    phaseId: "P01",
    taskId: "T001",
    attemptId: "attempt-m4b-components-001",
    ordinal: 1,
    planIdentity: "plan-m4b-components",
    planDigest: sha256("plan"),
    taskDigest: sha256("task"),
    title: "Create status module",
    goal: "Expose a deterministic ready status",
    change,
    scope: "src/status.js",
    covers: "src/status.js",
    acceptanceCriteria: ["src/status.js exports exactly ready"],
    validationSpecRefs: [],
    expectedEvidence: "a real src/status.js workspace delta",
    executorProfileIdentity: `opencode:cli:${MODEL}`,
    executorProfileDigest: sha256("profile"),
    timeoutPolicyDigest: sha256("timeout"),
    capabilityPolicyDigest: sha256("capabilities"),
    attemptBaseFingerprint: sha256("workspace"),
    createdAt: "2026-09-07T12:00:00.000Z",
  };
  return Object.freeze({ ...base, workUnitDigest: sha256Canonical(base) });
}

function bindParts(parts: readonly unknown[], session: string, messageId: string): readonly unknown[] {
  return parts.map((candidate, index) => {
    const part = candidate as Record<string, unknown>;
    return { ...part, id: part.id ?? `prt_fixture_${index}`, sessionID: session, messageID: messageId };
  });
}

function assistant(model = MODEL, session = SESSION, parent = USER_MESSAGE, parts: readonly unknown[] = [{ type: "text", text: "implemented" }]): unknown {
  const [providerID, modelID] = model.split("/");
  return { info: { id: ASSISTANT_MESSAGE, role: "assistant", sessionID: session, parentID: parent, providerID, modelID, finish: "stop" }, parts: bindParts(parts, session, ASSISTANT_MESSAGE) };
}

function userMessage(id = USER_MESSAGE, created?: number): unknown {
  return {
    info: { id, role: "user", sessionID: SESSION, time: { created: created ?? 1_000 } },
    parts: [{ type: "text", text: "bounded prompt", id: `prt_${id}`, sessionID: SESSION, messageID: id }],
  };
}

function turnAssistant(input: {
  readonly id: string;
  readonly finish: "tool-calls" | "stop";
  readonly model?: string;
  readonly session?: string;
  readonly parent?: string;
  readonly created?: number;
  readonly completed?: number;
  readonly error?: unknown;
  readonly text?: string;
}): unknown {
  const [providerID, modelID] = (input.model ?? MODEL).split("/");
  const timed = input.created === undefined && input.completed === undefined
    ? {}
    : { time: { created: input.created, completed: input.completed } };
  return {
    info: {
      id: input.id,
      role: "assistant",
      sessionID: input.session ?? SESSION,
      parentID: input.parent ?? USER_MESSAGE,
      providerID,
      modelID,
      finish: input.finish,
      ...timed,
      ...(input.error === undefined ? {} : { error: input.error }),
    },
    parts: bindParts(input.finish === "tool-calls"
      ? [
        { type: "step-start" },
        { type: "tool", tool: "write", callID: `call_${input.id}`, state: { status: "completed", input: {}, output: "written", title: "write", metadata: {}, time: { start: input.created ?? 1_001, end: input.completed ?? 1_002 } } },
        { type: "step-finish", reason: "tool-calls", cost: 0, tokens: { total: 1, input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
      ]
      : [
        { type: "step-start" },
        { type: "text", text: input.text ?? "implemented" },
        { type: "step-finish", reason: "stop", cost: 0, tokens: { total: 1, input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
      ], input.session ?? SESSION, input.id),
  };
}

async function realTranscriptFixture(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(REAL_TRANSCRIPT_FIXTURE, "utf8")) as Record<string, unknown>;
}

async function dualViewFixture(): Promise<{ readonly live: Record<string, unknown>; readonly sanitized: Record<string, unknown> }> {
  const value = JSON.parse(await readFile(DUAL_VIEW_FIXTURE, "utf8")) as Record<string, unknown>;
  return { live: value.live as Record<string, unknown>, sanitized: value.sanitized as Record<string, unknown> };
}

function cloneFixture<T>(value: T): T {
  return structuredClone(value);
}

async function listen(handler: RequestListener): Promise<{ readonly server: Server; readonly baseUrl: string }> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not bind TCP");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function jsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
}

describe("Ralph M4-B — deterministic OpenCode CLI transport components", () => {
  it("uses one exact dedicated session, Core message ID, model and project directory through the supported API", async () => {
    const calls: Array<{ readonly method: string; readonly path: string; readonly query: string; readonly body: Record<string, unknown> }> = [];
    const user = userMessage();
    const response = assistant();
    const { baseUrl } = await listen(async (request, reply) => {
      const url = new URL(request.url ?? "/", "http://fixture");
      const body = request.method === "POST" ? await jsonBody(request) : {};
      calls.push({ method: request.method ?? "", path: url.pathname, query: url.searchParams.get("directory") ?? "", body });
      reply.setHeader("content-type", "application/json");
      if (url.pathname === "/global/health") reply.end(JSON.stringify({ healthy: true, version: "1.18.29" }));
      else if (url.pathname === "/session" && request.method === "POST") reply.end(JSON.stringify({ id: SESSION, directory: PROJECT_ROOT, version: "1.18.29", model: { providerID: "opencode-go", id: "deepseek-v4-pro" } }));
      else if (url.pathname === `/session/${SESSION}`) reply.end(JSON.stringify({ id: SESSION, directory: PROJECT_ROOT, version: "1.18.29", model: { providerID: "opencode-go", id: "deepseek-v4-pro" } }));
      else if (url.pathname.endsWith("/message") && request.method === "POST") reply.end(JSON.stringify(response));
      else if (url.pathname.endsWith("/message")) reply.end(JSON.stringify([user, response]));
      else if (url.pathname.endsWith("/abort")) reply.end("true");
      else { reply.statusCode = 404; reply.end("{}"); }
    });
    const client = new OpenCodeCliHttpClientV2({ baseUrl, projectRoot: PROJECT_ROOT, deadlineMs: 5_000 });
    expect(await client.health()).toBe("1.18.29");
    expect(await client.createSession({ title: "ralph-invocation" })).toMatchObject({ id: SESSION, modelSelector: MODEL, directory: PROJECT_ROOT });
    expect(await client.getSession(SESSION)).toMatchObject({ id: SESSION, modelSelector: MODEL });
    await client.sendPrompt({ sessionId: SESSION, userMessageId: USER_MESSAGE, prompt: "bounded prompt" });
    expect(await client.readExactPromptResult({ sessionId: SESSION, userMessageId: USER_MESSAGE })).toMatchObject({ assistantMessageId: ASSISTANT_MESSAGE, modelSelector: MODEL });
    expect(await client.abort(SESSION)).toBe(true);
    expect(calls.filter((call) => call.path.endsWith("/message") && call.method === "POST")).toHaveLength(1);
    expect(calls.filter((call) => call.path !== "/global/health").every((call) => call.query === PROJECT_ROOT)).toBe(true);
    const createBody = calls.find((call) => call.path === "/session" && call.method === "POST")!.body;
    expect(createBody).toMatchObject({ agent: "build", model: { providerID: "opencode-go", id: "deepseek-v4-pro" } });
    const promptBody = calls.find((call) => call.path.endsWith("/message") && call.method === "POST")!.body;
    expect(promptBody).toMatchObject({ messageID: USER_MESSAGE, agent: "build", model: { providerID: "opencode-go", modelID: "deepseek-v4-pro" } });
    expect(JSON.stringify(promptBody)).not.toMatch(/zen|fallback|api[_-]?key|bearer/i);
  });

  it("M4B-3/M4B-5: rejects foreign session/message and exact-model mismatch", () => {
    expect(() => parseAssistantResult(assistant("opencode-go/other-model"), SESSION, USER_MESSAGE)).toThrow(expect.objectContaining({ m4bCode: "M4B_MODEL_MISMATCH" }));
    expect(() => parseAssistantResult(assistant(MODEL, "ses_foreignSession0000001"), SESSION, USER_MESSAGE)).toThrow(expect.objectContaining({ m4bCode: "M4B_PROVIDER_RESULT_INVALID" }));
    expect(() => parseAssistantResult(assistant(MODEL, SESSION, "msg_foreign_parent"), SESSION, USER_MESSAGE)).toThrow(expect.objectContaining({ m4bCode: "M4B_PROVIDER_RESULT_INVALID" }));
  });

  it("M4B-13: persists FAILED only from one explicit terminal stop, never from an intermediate error", () => {
    const user = userMessage();
    const terminalFailure = turnAssistant({ id: "msg_terminal_failure_001", finish: "stop", error: { name: "UnknownError", data: { message: "redacted" } } });
    expect(parseExactAssistantTurnV2([user, terminalFailure], SESSION, USER_MESSAGE))
      .toMatchObject({ assistantMessageId: "msg_terminal_failure_001", classification: "FAILED", modelSelector: MODEL });
    const intermediateFailure = turnAssistant({ id: "msg_intermediate_failure_001", finish: "tool-calls", error: { name: "UnknownError", data: { message: "redacted" } } });
    expect(() => parseExactAssistantTurnV2([user, intermediateFailure], SESSION, USER_MESSAGE))
      .toThrow(expect.objectContaining({ m4bCode: "M4B_PROVIDER_RESULT_INVALID" }));
  });

  it("terminal case A: accepts one tool-call segment followed by one terminal stop", () => {
    const result = parseExactAssistantTurnV2([
      userMessage(USER_MESSAGE, 1_000),
      turnAssistant({ id: "msg_tool_step_a", finish: "tool-calls", created: 1_001, completed: 1_002 }),
      turnAssistant({ id: "msg_terminal_a", finish: "stop", created: 1_003, completed: 1_004 }),
    ], SESSION, USER_MESSAGE);
    expect(result).toMatchObject({ assistantMessageId: "msg_terminal_a", classification: "SUCCEEDED", modelSelector: MODEL });
  });

  it("terminal case B: accepts the preserved first-real-turn shape with three tool calls and one stop", () => {
    const result = parseExactAssistantTurnV2([
      userMessage(USER_MESSAGE, 1_000),
      turnAssistant({ id: "msg_tool_step_b1", finish: "tool-calls", created: 1_001, completed: 1_002 }),
      turnAssistant({ id: "msg_tool_step_b2", finish: "tool-calls", created: 1_003, completed: 1_004 }),
      turnAssistant({ id: "msg_tool_step_b3", finish: "tool-calls", created: 1_005, completed: 1_006 }),
      turnAssistant({ id: "msg_terminal_b", finish: "stop", created: 1_007, completed: 1_008 }),
    ], SESSION, USER_MESSAGE);
    expect(result).toMatchObject({ assistantMessageId: "msg_terminal_b", classification: "SUCCEEDED", modelSelector: MODEL });
    expect(result.parts).toHaveLength(12);
  });

  it("M4B-11/M4B-12 terminal case C: rejects two terminal candidates for the same Core user turn", () => {
    expect(() => parseExactAssistantTurnV2([
      userMessage(),
      turnAssistant({ id: "msg_terminal_c1", finish: "stop" }),
      turnAssistant({ id: "msg_terminal_c2", finish: "stop" }),
    ], SESSION, USER_MESSAGE)).toThrow(expect.objectContaining({ m4bCode: "M4B_PROVIDER_RESULT_INVALID" }));
  });

  it("M4B-11 terminal case D: rejects a tool-call assistant after the terminal stop", () => {
    expect(() => parseExactAssistantTurnV2([
      userMessage(USER_MESSAGE, 1_000),
      turnAssistant({ id: "msg_terminal_d", finish: "stop", created: 1_001, completed: 1_002 }),
      turnAssistant({ id: "msg_tool_after_terminal_d", finish: "tool-calls", created: 1_003, completed: 1_004 }),
    ], SESSION, USER_MESSAGE)).toThrow(expect.objectContaining({ m4bCode: "M4B_PROVIDER_RESULT_INVALID" }));
  });

  it("terminal case E: keeps a later foreign user turn outside the original Core-bound turn", () => {
    const foreignUserId = "msg_foreign_user_turn_001";
    const original = turnAssistant({ id: "msg_terminal_e", finish: "stop" });
    const result = parseExactAssistantTurnV2([
      userMessage(), original, userMessage(foreignUserId),
      turnAssistant({ id: "msg_foreign_assistant_e", finish: "stop", parent: foreignUserId }),
    ], SESSION, USER_MESSAGE);
    expect(result).toMatchObject({ assistantMessageId: "msg_terminal_e", userMessageId: USER_MESSAGE });
  });

  it("terminal case F: rejects the wrong model on the terminal candidate", () => {
    expect(() => parseExactAssistantTurnV2([
      userMessage(), turnAssistant({ id: "msg_terminal_f", finish: "stop", model: "opencode-go/foreign-model" }),
    ], SESSION, USER_MESSAGE)).toThrow(expect.objectContaining({ m4bCode: "M4B_MODEL_MISMATCH" }));
  });

  it("terminal case G: rejects the wrong model on an intermediate assistant", () => {
    expect(() => parseExactAssistantTurnV2([
      userMessage(),
      turnAssistant({ id: "msg_tool_g", finish: "tool-calls", model: "opencode-go/foreign-model" }),
      turnAssistant({ id: "msg_terminal_g", finish: "stop" }),
    ], SESSION, USER_MESSAGE)).toThrow(expect.objectContaining({ m4bCode: "M4B_MODEL_MISMATCH" }));
  });

  it("terminal case H: rejects wrong session or parent lineage", () => {
    expect(() => parseExactAssistantTurnV2([
      userMessage(), turnAssistant({ id: "msg_terminal_h1", finish: "stop", session: "ses_foreignSession0000001" }),
    ], SESSION, USER_MESSAGE)).toThrow(expect.objectContaining({ m4bCode: "M4B_PROVIDER_RESULT_INVALID" }));
    expect(() => parseExactAssistantTurnV2([
      userMessage(), turnAssistant({ id: "msg_terminal_h2", finish: "stop", parent: "msg_foreign_parent" }),
    ], SESSION, USER_MESSAGE)).toThrow(expect.objectContaining({ m4bCode: "M4B_PROVIDER_RESULT_INVALID" }));
  });

  it("terminal case I: rejects a turn containing only tool-call messages", () => {
    expect(() => parseExactAssistantTurnV2([
      userMessage(), turnAssistant({ id: "msg_tool_i", finish: "tool-calls" }),
    ], SESSION, USER_MESSAGE)).toThrow(expect.objectContaining({ m4bCode: "M4B_PROVIDER_RESULT_INVALID" }));
  });

  it("M4B-12 terminal case J: rejects a foreign injected terminal with otherwise matching bindings", () => {
    expect(() => parseExactAssistantTurnV2([
      userMessage(),
      turnAssistant({ id: "msg_terminal_j1", finish: "stop" }),
      turnAssistant({ id: "msg_injected_terminal_j2", finish: "stop" }),
    ], SESSION, USER_MESSAGE)).toThrow(expect.objectContaining({ m4bCode: "M4B_PROVIDER_RESULT_INVALID" }));
  });

  it("terminal case K: preserves the legacy valid single-terminal shape without timestamps", () => {
    expect(parseExactAssistantTurnV2([userMessage(), assistant()], SESSION, USER_MESSAGE))
      .toMatchObject({ assistantMessageId: ASSISTANT_MESSAGE, classification: "SUCCEEDED", modelSelector: MODEL });
  });

  it("M4B-14: accepts the sanitized real OpenCode 1.18.29 multi-tool transcript and normalizes only bounded authority", async () => {
    const fixture = await realTranscriptFixture();
    expect(() => assertNoCredentialMaterial(fixture, "GENERIC_SCANNER_STILL_STRICT")).toThrow();
    const transport = validateOpenCodeSessionExportTransportV2(fixture);
    const parsed = parseExactAssistantTurnV2(transport.messages, REAL_TRANSCRIPT_SESSION, REAL_TRANSCRIPT_USER);
    const replayed = parseExactAssistantTurnV2(validateOpenCodeSessionExportTransportV2(await realTranscriptFixture()).messages, REAL_TRANSCRIPT_SESSION, REAL_TRANSCRIPT_USER);
    expect(parsed).toMatchObject({
      assistantMessageId: "msg_real_terminal_001",
      sessionId: REAL_TRANSCRIPT_SESSION,
      userMessageId: REAL_TRANSCRIPT_USER,
      modelSelector: MODEL,
      classification: "SUCCEEDED",
    });
    expect(parsed.parts).toHaveLength(13);
    expect(parsed.responseDigest).toBe(replayed.responseDigest);
    expect(parsed.assistantContentDigest).toBe(replayed.assistantContentDigest);
    expect(parsed.responseDigest).toBe("sha256:fb6db6283b493202f4aba2edfc9a4cd62fc271f8c9b2ba161b0a98122f8f9901");
    expect(parsed.assistantContentDigest).toBe("sha256:176e8ee7e31593f0ee1a9810ba54d2b9a0628bc4ab16294687db41edd88d6223");

    const persistedShape = createOpenCodeProviderResultV2({
      runId: "run-real-transcript", phaseId: "P01", taskId: "T001", attemptId: "attempt-real-transcript-001", invocationId: `inv-${"f".repeat(64)}`,
      descriptorDigest: sha256("descriptor"), dispatchIntentDigest: sha256("intent"), sessionBindingDigest: sha256("session"), promptArtifactDigest: sha256("prompt"),
      openCodeSessionId: REAL_TRANSCRIPT_SESSION, openCodeUserMessageId: REAL_TRANSCRIPT_USER,
      assistantMessageId: parsed.assistantMessageId, observedModelSelector: parsed.modelSelector, classification: parsed.classification,
      assistantContentDigest: parsed.assistantContentDigest, responseDigest: parsed.responseDigest,
      observableTurnDigest: parsed.observableTurnDigest,
      startedAt: "2026-09-07T12:00:00.000Z", finishedAt: "2026-09-07T12:01:00.000Z",
    });
    expect(persistedShape).not.toHaveProperty("raw");
    expect(persistedShape).not.toHaveProperty("parts");
    expect(JSON.stringify(persistedShape)).not.toMatch(/step-finish|reasoning|redacted|"tokens"/);
  });

  it("M4B-17/M4B-20: gives paired live and sanitized views one observable identity while content integrity differs", async () => {
    const pair = await dualViewFixture();
    const liveTransport = validateOpenCodeSessionExportTransportV2(pair.live);
    const sanitizedTransport = validateOpenCodeSessionExportTransportV2(pair.sanitized);
    const live = parseExactAssistantTurnV2(liveTransport.messages, DUAL_VIEW_SESSION, DUAL_VIEW_USER);
    const sanitized = parseExactAssistantTurnV2(sanitizedTransport.messages, DUAL_VIEW_SESSION, DUAL_VIEW_USER);

    expect(live).toMatchObject({
      assistantMessageId: "msg_07f1f0454001dLgLiNdVbF8oUX",
      modelSelector: MODEL,
      classification: "SUCCEEDED",
    });
    expect(live.observableTurnDigest).toBe(sanitized.observableTurnDigest);
    expect(live.observableTurnDigest).toBe("sha256:d6f3dd3e5afe32b37f6905cce164e25f9e3afd2e72970309344ea73fce88ef5f");
    expect(live.responseDigest).not.toBe(sanitized.responseDigest);
    expect(live.assistantContentDigest).not.toBe(sanitized.assistantContentDigest);
    expect(projectObservableOpenCodeTurnV2({ user: liveTransport.messages[0], assistants: liveTransport.messages.slice(1) }))
      .toEqual(projectObservableOpenCodeTurnV2({ user: sanitizedTransport.messages[0], assistants: sanitizedTransport.messages.slice(1) }));
  });

  it("M4B-19: binds every structural turn identity fact retained across sanitization", async () => {
    const pair = await dualViewFixture();
    const baselineTransport = validateOpenCodeSessionExportTransportV2(pair.sanitized);
    const baseline = parseExactAssistantTurnV2(baselineTransport.messages, DUAL_VIEW_SESSION, DUAL_VIEW_USER);
    const expectMismatchOrReject = (mutate: (fixture: Record<string, unknown>) => { sessionId?: string; userMessageId?: string }): void => {
      const fixture = cloneFixture(pair.sanitized);
      const expected = mutate(fixture);
      try {
        const transport = validateOpenCodeSessionExportTransportV2(fixture);
        const parsed = parseExactAssistantTurnV2(
          transport.messages,
          expected.sessionId ?? DUAL_VIEW_SESSION,
          expected.userMessageId ?? DUAL_VIEW_USER,
        );
        expect(parsed.observableTurnDigest).not.toBe(baseline.observableTurnDigest);
      } catch (error) {
        expect(error).toMatchObject({ m4bCode: expect.stringMatching(/^M4B_/) });
      }
    };
    const messagesOf = (fixture: Record<string, unknown>) => fixture.messages as Array<Record<string, unknown>>;
    const partsOf = (message: Record<string, unknown>) => message.parts as Array<Record<string, unknown>>;

    expectMismatchOrReject((fixture) => {
      const sessionId = "ses_structurally_foreign_0001";
      for (const message of messagesOf(fixture)) {
        (message.info as Record<string, unknown>).sessionID = sessionId;
        for (const part of partsOf(message)) part.sessionID = sessionId;
      }
      return { sessionId };
    });
    expectMismatchOrReject((fixture) => {
      const userMessageId = "msg_ralph_structurally_foreign_0001";
      const messages = messagesOf(fixture);
      (messages[0]!.info as Record<string, unknown>).id = userMessageId;
      for (const part of partsOf(messages[0]!)) part.messageID = userMessageId;
      for (const message of messages.slice(1)) (message.info as Record<string, unknown>).parentID = userMessageId;
      return { userMessageId };
    });
    expectMismatchOrReject((fixture) => {
      const terminal = messagesOf(fixture).at(-1)!;
      (terminal.info as Record<string, unknown>).id = "msg_structurally_foreign_terminal_001";
      for (const part of partsOf(terminal)) part.messageID = "msg_structurally_foreign_terminal_001";
      return {};
    });
    expectMismatchOrReject((fixture) => { (messagesOf(fixture).at(-1)!.info as Record<string, unknown>).modelID = "foreign-model"; return {}; });
    expectMismatchOrReject((fixture) => { const messages = messagesOf(fixture); [messages[1], messages[2]] = [messages[2]!, messages[1]!]; return {}; });
    expectMismatchOrReject((fixture) => { messagesOf(fixture).splice(2, 1); return {}; });
    expectMismatchOrReject((fixture) => { const messages = messagesOf(fixture); messages.splice(3, 0, cloneFixture(messages[2]!)); return {}; });
    expectMismatchOrReject((fixture) => { (messagesOf(fixture)[1]!.info as Record<string, unknown>).finish = "stop"; return {}; });
    expectMismatchOrReject((fixture) => {
      const tool = partsOf(messagesOf(fixture)[1]!).find((part) => part.type === "tool")!;
      tool.callID = "call_structurally_foreign_001";
      return {};
    });
    expectMismatchOrReject((fixture) => {
      const tool = partsOf(messagesOf(fixture)[1]!).find((part) => part.type === "tool")!;
      const state = tool.state as Record<string, unknown>;
      tool.state = { status: "running", input: state.input, title: state.title, metadata: state.metadata, time: { start: 1788839129812 } };
      return {};
    });
    expectMismatchOrReject((fixture) => { partsOf(messagesOf(fixture)[1]!)[0]!.id = "prt_structurally_foreign_001"; return {}; });
    expectMismatchOrReject((fixture) => { (messagesOf(fixture).at(-1)!.info as Record<string, unknown>).parentID = "msg_foreign_parent"; return {}; });
  });

  it("keeps deliberately redacted provider content outside observable identity", async () => {
    const pair = await dualViewFixture();
    const liveTransport = validateOpenCodeSessionExportTransportV2(pair.live);
    const baseline = parseExactAssistantTurnV2(liveTransport.messages, DUAL_VIEW_SESSION, DUAL_VIEW_USER);
    const changed = cloneFixture(pair.live);
    const messages = changed.messages as Array<Record<string, unknown>>;
    const userText = (messages[0]!.parts as Array<Record<string, unknown>>)[0]!;
    userText.text = "Different safe user text that sanitization intentionally redacts.";
    const firstTool = (messages[1]!.parts as Array<Record<string, unknown>>).find((part) => part.type === "tool")!;
    const state = firstTool.state as Record<string, unknown>;
    state.input = { command: "different-safe-command" };
    state.output = "different safe tool output";
    state.title = "Different safe title";
    state.metadata = { exit: 0, output: "different safe metadata output", truncated: false };
    const terminalText = (messages.at(-1)!.parts as Array<Record<string, unknown>>).find((part) => part.type === "text")!;
    terminalText.text = "Different safe assistant content.";
    (messages[1]!.info as Record<string, unknown>).path = { cwd: "/different/safe/project", root: "/different/safe/root" };
    const changedTransport = validateOpenCodeSessionExportTransportV2(changed);
    const reparsed = parseExactAssistantTurnV2(changedTransport.messages, DUAL_VIEW_SESSION, DUAL_VIEW_USER);
    expect(reparsed.observableTurnDigest).toBe(baseline.observableTurnDigest);
    expect(reparsed.responseDigest).not.toBe(baseline.responseDigest);
    expect(reparsed.assistantContentDigest).not.toBe(baseline.assistantContentDigest);
  });

  it("real-shape A: accepts unchanged numeric usage at assistant and step-finish locations", async () => {
    const fixture = await realTranscriptFixture();
    const transport = validateOpenCodeSessionExportTransportV2(fixture);
    expect(parseExactAssistantTurnV2(transport.messages, REAL_TRANSCRIPT_SESSION, REAL_TRANSCRIPT_USER).assistantMessageId)
      .toBe("msg_real_terminal_001");
  });

  it("M4B-15 real-shape B: rejects an unexpected field inside step-finish usage", async () => {
    const fixture = cloneFixture(await realTranscriptFixture());
    const messages = fixture.messages as Array<Record<string, unknown>>;
    const parts = messages[1]!.parts as Array<Record<string, unknown>>;
    const finish = parts.find((part) => part.type === "step-finish")!;
    (finish.tokens as Record<string, unknown>).unexpected = 1;
    expect(() => validateOpenCodeSessionExportTransportV2(fixture)).toThrow(expect.objectContaining({ m4bCode: "M4B_PROVIDER_RESULT_INVALID" }));
  });

  it("M4B-15 real-shape C: rejects credential-like strings inside the numeric usage object", async () => {
    const fixture = cloneFixture(await realTranscriptFixture());
    const messages = fixture.messages as Array<Record<string, unknown>>;
    const parts = messages[1]!.parts as Array<Record<string, unknown>>;
    const finish = parts.find((part) => part.type === "step-finish")!;
    (finish.tokens as Record<string, unknown>).input = "sk-forbidden-credential";
    expect(() => validateOpenCodeSessionExportTransportV2(fixture)).toThrow(expect.objectContaining({ m4bCode: "M4B_PROVIDER_RESULT_INVALID" }));
    for (const invalidMetric of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const malformed = cloneFixture(await realTranscriptFixture());
      const malformedMessages = malformed.messages as Array<Record<string, unknown>>;
      const malformedFinish = (malformedMessages[1]!.parts as Array<Record<string, unknown>>).find((part) => part.type === "step-finish")!;
      (malformedFinish.tokens as Record<string, unknown>).output = invalidMetric;
      expect(() => validateOpenCodeSessionExportTransportV2(malformed)).toThrow(expect.objectContaining({ m4bCode: "M4B_PROVIDER_RESULT_INVALID" }));
    }
  });

  it("M4B-16 real-shape D: rejects credential material in assistant text before normalization", async () => {
    const fixture = cloneFixture(await realTranscriptFixture());
    const messages = fixture.messages as Array<Record<string, unknown>>;
    const terminalParts = messages.at(-1)!.parts as Array<Record<string, unknown>>;
    terminalParts.find((part) => part.type === "text")!.text = "Authorization: Bearer sk-forbidden-material";
    expect(() => validateOpenCodeSessionExportTransportV2(fixture)).toThrow(expect.objectContaining({ m4bCode: "M4B_PROVIDER_CREDENTIAL_MATERIAL" }));
  });

  it("M4B-16 real-shape E: rejects credential material in tool output before normalization", async () => {
    const fixture = cloneFixture(await realTranscriptFixture());
    const messages = fixture.messages as Array<Record<string, unknown>>;
    const tool = (messages[1]!.parts as Array<Record<string, unknown>>).find((part) => part.type === "tool")!;
    (tool.state as Record<string, unknown>).output = "secret sk-forbidden-material";
    expect(() => validateOpenCodeSessionExportTransportV2(fixture)).toThrow(expect.objectContaining({ m4bCode: "M4B_PROVIDER_CREDENTIAL_MATERIAL" }));
  });

  it("M4B-15 real-shape F: rejects unknown provider credential fields outside the exact usage path", async () => {
    const fixture = cloneFixture(await realTranscriptFixture());
    const messages = fixture.messages as Array<Record<string, unknown>>;
    (messages.at(-1)!.info as Record<string, unknown>).api_token = "unsafe";
    expect(() => validateOpenCodeSessionExportTransportV2(fixture)).toThrow(expect.objectContaining({ m4bCode: "M4B_PROVIDER_RESULT_INVALID" }));

    const misplaced = cloneFixture(await realTranscriptFixture());
    const misplacedMessages = misplaced.messages as Array<Record<string, unknown>>;
    const tool = (misplacedMessages[1]!.parts as Array<Record<string, unknown>>).find((part) => part.type === "tool")!;
    ((tool.state as Record<string, unknown>).input as Record<string, unknown>).tokens = { input: 1 };
    expect(() => validateOpenCodeSessionExportTransportV2(misplaced)).toThrow(expect.objectContaining({ m4bCode: "M4B_PROVIDER_CREDENTIAL_MATERIAL" }));
  });

  it("real-shape G: rejects two terminal assistant messages", async () => {
    const fixture = cloneFixture(await realTranscriptFixture());
    const messages = fixture.messages as Array<Record<string, unknown>>;
    const injected = cloneFixture(messages.at(-1)!);
    (injected.info as Record<string, unknown>).id = "msg_real_terminal_injected_002";
    for (const [index, part] of (injected.parts as Array<Record<string, unknown>>).entries()) {
      part.id = `prt_real_injected_${index}`;
      part.messageID = "msg_real_terminal_injected_002";
    }
    messages.push(injected);
    const transport = validateOpenCodeSessionExportTransportV2(fixture);
    expect(() => parseExactAssistantTurnV2(transport.messages, REAL_TRANSCRIPT_SESSION, REAL_TRANSCRIPT_USER))
      .toThrow(expect.objectContaining({ m4bCode: "M4B_PROVIDER_RESULT_INVALID" }));
  });

  it("real-shape H: rejects the real turn when terminal stop is absent", async () => {
    const fixture = cloneFixture(await realTranscriptFixture());
    (fixture.messages as unknown[]).pop();
    const transport = validateOpenCodeSessionExportTransportV2(fixture);
    expect(() => parseExactAssistantTurnV2(transport.messages, REAL_TRANSCRIPT_SESSION, REAL_TRANSCRIPT_USER))
      .toThrow(expect.objectContaining({ m4bCode: "M4B_PROVIDER_RESULT_INVALID" }));
  });

  it("real-shape I: rejects a wrong model on the real terminal message", async () => {
    const fixture = cloneFixture(await realTranscriptFixture());
    const messages = fixture.messages as Array<Record<string, unknown>>;
    (messages.at(-1)!.info as Record<string, unknown>).modelID = "foreign-model";
    const transport = validateOpenCodeSessionExportTransportV2(fixture);
    expect(() => parseExactAssistantTurnV2(transport.messages, REAL_TRANSCRIPT_SESSION, REAL_TRANSCRIPT_USER))
      .toThrow(expect.objectContaining({ m4bCode: "M4B_MODEL_MISMATCH" }));
  });

  it("real-shape J: rejects foreign parent/session lineage", async () => {
    const foreignParent = cloneFixture(await realTranscriptFixture());
    const parentMessages = foreignParent.messages as Array<Record<string, unknown>>;
    (parentMessages.at(-1)!.info as Record<string, unknown>).parentID = "msg_foreign_parent";
    const parentTransport = validateOpenCodeSessionExportTransportV2(foreignParent);
    expect(() => parseExactAssistantTurnV2(parentTransport.messages, REAL_TRANSCRIPT_SESSION, REAL_TRANSCRIPT_USER))
      .toThrow(expect.objectContaining({ m4bCode: "M4B_PROVIDER_RESULT_INVALID" }));

    const foreignSession = cloneFixture(await realTranscriptFixture());
    const sessionMessages = foreignSession.messages as Array<Record<string, unknown>>;
    (sessionMessages.at(-1)!.info as Record<string, unknown>).sessionID = "ses_foreignSession0000001";
    expect(() => validateOpenCodeSessionExportTransportV2(foreignSession))
      .toThrow(expect.objectContaining({ m4bCode: "M4B_PROVIDER_RESULT_INVALID" }));
  });

  it("rejects malformed or non-monotonic supported OpenCode timestamps", () => {
    expect(() => parseExactAssistantTurnV2([
      userMessage(USER_MESSAGE, 1_000),
      turnAssistant({ id: "msg_tool_time", finish: "tool-calls", created: 1_003, completed: 1_004 }),
      turnAssistant({ id: "msg_terminal_time", finish: "stop", created: 1_002, completed: 1_005 }),
    ], SESSION, USER_MESSAGE)).toThrow(expect.objectContaining({ m4bCode: "M4B_PROVIDER_RESULT_INVALID" }));
    expect(() => parseExactAssistantTurnV2([
      userMessage(), turnAssistant({ id: "msg_terminal_bad_time", finish: "stop", created: 1_001 }),
    ], SESSION, USER_MESSAGE)).toThrow(expect.objectContaining({ m4bCode: "M4B_PROVIDER_RESULT_INVALID" }));
  });

  it("rejects credential-like or oversized provider output without persisting it", async () => {
    expect(() => parseAssistantResult(assistant(MODEL, SESSION, USER_MESSAGE, [{ type: "text", text: "Authorization: Bearer sk-super-secret-material" }]), SESSION, USER_MESSAGE))
      .toThrow(expect.objectContaining({ m4bCode: "M4B_PROVIDER_CREDENTIAL_MATERIAL" }));
    const { baseUrl } = await listen((_request, reply) => {
      reply.setHeader("content-type", "application/json");
      reply.end(JSON.stringify({ healthy: true, version: "x".repeat(MAX_OPENCODE_HTTP_RESPONSE_BYTES_V2 + 1) }));
    });
    await expect(new OpenCodeCliHttpClientV2({ baseUrl, projectRoot: PROJECT_ROOT, deadlineMs: 5_000 }).health())
      .rejects.toMatchObject({ m4bCode: "M4B_PROVIDER_OUTPUT_LIMIT" });
  });

  it("derives a bounded prompt only from the WorkUnit and changes its digest with Core input", () => {
    const first = projectWorkUnitToOpenCodePromptV2(workUnit());
    const same = projectWorkUnitToOpenCodePromptV2(workUnit());
    const changed = projectWorkUnitToOpenCodePromptV2(workUnit("create src/status.js and export exactly ready"));
    expect(first).toEqual(same);
    expect(first.promptDigest).not.toBe(changed.promptDigest);
    expect(first.text).toContain("Create status module");
    expect(first.text).toContain("Do not modify .rb/**, .rb-harness/**, or .git/**");
    expect(first.text).toContain("final textual response is informational only");
    expect(first.byteLength).toBeLessThanOrEqual(64 * 1024);
    expect(Object.keys(projectWorkUnitToOpenCodePromptV2)).not.toContain("promptOverride");
  });

  it("M4B-9: builds an explicit environment and never inherits arbitrary caller state", () => {
    const environment = openCodeM4BChildEnvironment({
      PATH: "/usr/bin", HOME: "/safe/home", XDG_CONFIG_HOME: "/safe/config", LANG: "C.UTF-8",
      OPENAI_API_KEY: "forbidden", ANTHROPIC_API_KEY: "forbidden", RANDOM_SECRET: "forbidden", NODE_OPTIONS: "--inspect",
    });
    expect(environment).toMatchObject({ PATH: "/usr/bin", HOME: "/safe/home", XDG_CONFIG_HOME: "/safe/config", LANG: "C.UTF-8", OPENCODE_DISABLE_CLAUDE_CODE: "1" });
    expect(environment).not.toHaveProperty("OPENAI_API_KEY");
    expect(environment).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(environment).not.toHaveProperty("RANDOM_SECRET");
    expect(environment).not.toHaveProperty("NODE_OPTIONS");
    expect(JSON.parse(environment.OPENCODE_CONFIG_CONTENT!)).toMatchObject({ instructions: [], permission: { bash: "deny", external_directory: "deny" } });
  });

  it("keeps edit tools workspace-scoped and exposes only a tiny non-escaping command allowlist", () => {
    const rules = openCodeM4BPermissionRulesV2();
    for (const permission of ["edit", "write", "patch"]) {
      expect(rules).toContainEqual({ permission, pattern: "*", action: "allow" });
      expect(rules).toContainEqual({ permission, pattern: ".rb/**", action: "deny" });
      expect(rules).toContainEqual({ permission, pattern: ".rb-harness/**", action: "deny" });
      expect(rules).toContainEqual({ permission, pattern: ".git/**", action: "deny" });
    }
    expect(rules).toContainEqual({ permission: "external_directory", pattern: "*", action: "deny" });
    const bashRules = rules.filter((rule) => rule.permission === "bash");
    expect(bashRules).toEqual([
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "pwd", action: "allow" },
      { permission: "bash", pattern: "ls", action: "allow" },
      { permission: "bash", pattern: "git status --short", action: "allow" },
    ]);
  });

  it("persists only bounded digest-bound prompt/result records and rejects tamper, extra fields and secrets", () => {
    const prompt = createOpenCodePromptArtifactV2({
      runId: "run-m4b", phaseId: "P01", taskId: "T001", attemptId: "attempt-m4b-001", invocationId: `inv-${"a".repeat(64)}`,
      descriptorDigest: sha256("descriptor"), dispatchIntentDigest: sha256("intent"), sessionBindingDigest: sha256("session"),
      openCodeSessionId: SESSION, openCodeUserMessageId: USER_MESSAGE, modelSelector: MODEL, promptDigest: sha256("prompt"), promptBytes: 42,
      preparedAt: "2026-09-07T12:00:00.000Z",
    });
    const result = createOpenCodeProviderResultV2({
      runId: prompt.runId, phaseId: prompt.phaseId, taskId: prompt.taskId, attemptId: prompt.attemptId, invocationId: prompt.invocationId,
      descriptorDigest: prompt.descriptorDigest, dispatchIntentDigest: prompt.dispatchIntentDigest, sessionBindingDigest: prompt.sessionBindingDigest,
      promptArtifactDigest: prompt.artifactDigest, openCodeSessionId: SESSION, openCodeUserMessageId: USER_MESSAGE,
      assistantMessageId: ASSISTANT_MESSAGE, observedModelSelector: MODEL, classification: "SUCCEEDED",
      assistantContentDigest: sha256("assistant"), responseDigest: sha256("response"), observableTurnDigest: sha256("observable-turn"),
      startedAt: prompt.preparedAt, finishedAt: "2026-09-07T12:01:00.000Z",
    });
    expect(() => validateOpenCodePromptArtifactV2(prompt)).not.toThrow();
    expect(() => validateOpenCodeProviderResultV2(result)).not.toThrow();
    expect(JSON.stringify({ prompt, result })).not.toContain("implemented");
    expect(() => validateOpenCodeProviderResultV2({ ...result, resultDigest: sha256("tampered") })).toThrow();
    expect(() => validateOpenCodeProviderResultV2({ ...result, rawTranscript: "forbidden" })).toThrow();
    const missingObservation = { ...result } as Record<string, unknown>;
    delete missingObservation.observableTurnDigest;
    expect(() => validateOpenCodeProviderResultV2(missingObservation)).toThrow();
    expect(() => createOpenCodeProviderResultV2({ ...result, responseDigest: "sk-forbidden", resultDigest: undefined } as never)).toThrow();
  });

  it("keeps process execution and network surfaces in the explicit OpenCode transport boundaries", async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = resolve(here, "../../src/vnext/ralph-runtime/operational-b4");
    const files = ["opencode-cli-executor.ts", "opencode-cli-prompt.ts", "opencode-cli-result.ts", "opencode-cli-session-inspector.ts", "provider-process-tree-inspector.ts"];
    const joined = (await Promise.all(files.map((file) => readFile(resolve(source, file), "utf8")))).join("\n");
    expect(joined).not.toMatch(/from\s+["']node:child_process["']/);
    expect(await readFile(resolve(source, "opencode-cli-process.ts"), "utf8")).toMatch(/from\s+["']node:child_process["']/);
    expect(joined).not.toMatch(/openai|anthropic|claude|deepseek.*api|zen\/v1/i);
  });
});
