import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import type { JsonSchemaDocument } from "../../contract.js";
import { HARNESS_VERSION } from "../../../../version.js";
import type {
  CodexActionCounts,
  CodexAppServerRawResponse,
  CodexSemanticCompletion,
  CodexSemanticPreflight,
  CodexTokenUsage,
} from "./normalize.js";

export interface CodexAppServerInvocation {
  readonly executable: string;
  readonly authFile: string;
  readonly model: string;
  readonly instructions: string;
  readonly input: string;
  readonly outputSchema: JsonSchemaDocument;
  readonly deadlineMs: number;
  readonly signal: AbortSignal;
  readonly acceptPreflight: (value: unknown) => CodexSemanticPreflight;
}

export interface CodexAppServerTransport {
  run(input: CodexAppServerInvocation): Promise<CodexAppServerRawResponse>;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function codexThreadStartParams(input: Pick<CodexAppServerInvocation, "model">, cwd: string): Record<string, unknown> {
  return { semanticMode: true, model: input.model, cwd, ephemeral: true };
}

export function codexTurnStartParams(
  threadId: string,
  input: Pick<CodexAppServerInvocation, "instructions" | "input" | "outputSchema">,
): Record<string, unknown> {
  return {
    threadId,
    input: [
      { type: "text", text: input.instructions, text_elements: [] },
      { type: "text", text: input.input, text_elements: [] },
    ],
    outputSchema: input.outputSchema,
  };
}

function childEnvironment(codexHome: string): NodeJS.ProcessEnv {
  const names = ["LANG", "LC_ALL", "TZ", "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR"] as const;
  const env: NodeJS.ProcessEnv = { CODEX_HOME: codexHome, HOME: codexHome };
  for (const name of names) if (process.env[name] !== undefined) env[name] = process.env[name];
  return env;
}

function actionCategory(item: Record<string, unknown>): keyof CodexActionCounts | undefined {
  if (item.type === "commandExecution") return "commandExecutionEvents";
  if (item.type === "fileChange") return "fileChangeEvents";
  if (item.type === "mcpToolCall") return item.appContext ? "appToolEvents" : "mcpToolEvents";
  if (item.type === "webSearch") return "webSearchEvents";
  if (["dynamicToolCall", "collabAgentToolCall", "subAgentActivity", "functionCallOutput", "imageGeneration"].includes(String(item.type))) return "otherToolEvents";
  return undefined;
}

function tokenUsage(value: unknown): CodexTokenUsage | undefined {
  const last = object(object(value).last);
  const fields = ["inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningOutputTokens"] as const;
  if (!fields.every((key) => typeof last[key] === "number" && Number.isFinite(last[key]) && Number(last[key]) >= 0)) return undefined;
  return Object.fromEntries(fields.map((key) => [key, last[key]])) as unknown as CodexTokenUsage;
}

export class SpawnCodexAppServerTransport implements CodexAppServerTransport {
  async run(input: CodexAppServerInvocation): Promise<CodexAppServerRawResponse> {
    const root = await mkdtemp(resolve(tmpdir(), "rb-harness-codex-"));
    const codexHome = resolve(root, "codex-home");
    const cwd = resolve(root, "workspace");
    await mkdir(codexHome, { recursive: true });
    await mkdir(cwd, { recursive: true });
    const startedAt = new Date().toISOString();
    const child = spawn(input.executable, ["app-server", "--stdio", "--auth-file", input.authFile], {
      cwd,
      env: childEnvironment(codexHome),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 8192) stderr += chunk.toString("utf8"); });
    const rl = createInterface({ input: child.stdout });
    let requestId = 1;
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    let preflight: CodexSemanticPreflight | undefined;
    let completion: CodexSemanticCompletion | undefined;
    let terminalStatus: string | undefined;
    let usage: CodexTokenUsage | undefined;
    let firstOutputMs: number | undefined;
    const finalMessages: string[] = [];
    const actionSets: Record<keyof CodexActionCounts, Set<string>> = {
      commandExecutionEvents: new Set(), fileChangeEvents: new Set(), mcpToolEvents: new Set(),
      appToolEvents: new Set(), webSearchEvents: new Set(), otherToolEvents: new Set(),
    };
    let itemSequence = 0;
    let streamComplete = false;
    let turnId: string | undefined;
    let threadId: string | undefined;
    let cancelled = false;
    let timedOut = false;

    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const call = (method: string, params?: unknown): Promise<unknown> => {
      const id = requestId++;
      send({ method, id, ...(params === undefined ? {} : { params }) });
      return new Promise((resolveCall, reject) => pending.set(id, { resolve: resolveCall, reject }));
    };
    const lineError = new Promise<never>((_, reject) => {
      rl.on("line", (line) => {
        if (!line.trim()) return;
        let message: Record<string, unknown>;
        try { message = object(JSON.parse(line)); }
        catch { reject(new Error("rb-codex app-server emitted malformed JSONL")); return; }
        if (firstOutputMs === undefined) firstOutputMs = Date.now() - Date.parse(startedAt);
        if (typeof message.id === "number") {
          const waiter = pending.get(message.id);
          if (!waiter) return;
          pending.delete(message.id);
          if (message.error) waiter.reject(new Error(`rb-codex app-server request failed: ${String(object(message.error).message ?? "unknown error")}`));
          else waiter.resolve(message.result);
          return;
        }
        const params = object(message.params);
        if (message.method === "item/started" || message.method === "item/completed") {
          const item = object(params.item);
          const category = actionCategory(item);
          if (category) actionSets[category].add(typeof item.id === "string" ? item.id : `${String(item.type)}-${++itemSequence}`);
          if (message.method === "item/completed" && item.type === "agentMessage" && item.phase !== "commentary" && typeof item.text === "string") {
            finalMessages.push(item.text);
          }
        } else if (message.method === "thread/tokenUsage/updated") {
          usage = tokenUsage(params.tokenUsage) ?? usage;
        } else if (message.method === "model/rerouted") {
          if (completion) completion = { ...completion, rerouted: true, rerouteReason: typeof params.reason === "string" ? params.reason : undefined };
        } else if (message.method === "turn/completed") {
          const turn = object(params.turn);
          terminalStatus = typeof turn.status === "string" ? turn.status : undefined;
          const semantic = object(params.semanticCompletion);
          if (["initialModel", "initialModelProvider", "finalModel", "finalModelProvider"].every((key) => typeof semantic[key] === "string") && typeof semantic.rerouted === "boolean") {
            completion = semantic as unknown as CodexSemanticCompletion;
          }
          streamComplete = true;
        }
      });
      child.once("error", reject);
      child.once("close", (code) => {
        if (!streamComplete) reject(new Error(`rb-codex app-server exited before turn completion (${String(code)})`));
      });
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => child.once("close", (code, signal) => resolveExit({ code, signal })));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      cancelled = true;
      if (threadId && turnId) send({ method: "turn/interrupt", id: requestId++, params: { threadId, turnId } });
      setTimeout(() => child.kill("SIGTERM"), 250).unref();
    };
    input.signal.addEventListener("abort", abort, { once: true });
    if (input.signal.aborted) abort();
    let runError: unknown;
    try {
      timeout = setTimeout(() => {
        timedOut = true;
        abort();
      }, input.deadlineMs);
      timeout.unref();
      await Promise.race([
        (async () => {
          await call("initialize", { clientInfo: { name: "rb-harness", title: "RB Harness", version: HARNESS_VERSION }, capabilities: { experimentalApi: true, requestAttestation: false } });
          send({ method: "initialized" });
          const started = object(await call("thread/start", codexThreadStartParams(input, cwd)));
          preflight = input.acceptPreflight(started.semanticPreflight);
          const thread = object(started.thread);
          if (typeof thread.id !== "string") throw new Error("rb-codex thread/start omitted thread id");
          threadId = thread.id;
          const turn = object(object(await call("turn/start", codexTurnStartParams(threadId, input))).turn);
          if (typeof turn.id !== "string") throw new Error("rb-codex turn/start omitted turn id");
          turnId = turn.id;
          while (!streamComplete) await new Promise((resolveWait) => setTimeout(resolveWait, 10));
        })(),
        lineError,
      ]);
    } catch (error) {
      runError = error;
    } finally {
      if (timeout) clearTimeout(timeout);
      input.signal.removeEventListener("abort", abort);
      child.stdin.end();
      let outcome = await Promise.race([exited, new Promise<undefined>((resolveWait) => setTimeout(() => resolveWait(undefined), 500))]);
      if (!outcome) {
        child.kill("SIGTERM");
        outcome = await Promise.race([exited, new Promise<undefined>((resolveWait) => setTimeout(() => resolveWait(undefined), 2_000))]);
      }
      if (!outcome) {
        child.kill("SIGKILL");
        outcome = await exited;
      }
      rl.close();
      await rm(root, { recursive: true, force: true });
      if ((cancelled || timedOut) && !streamComplete) {
        const error = new Error(timedOut ? "rb-codex semantic request timed out" : "rb-codex semantic request was cancelled");
        error.name = timedOut ? "TimeoutError" : "AbortError";
        runError = error;
      }
      if (!runError && !preflight) runError = new Error(stderr.trim() ? "rb-codex app-server failed before semantic preflight" : "rb-codex semantic preflight was not received");
      if (runError) throw runError;
      return {
        preflight: preflight!, ...(completion ? { completion } : {}), ...(terminalStatus ? { terminalStatus } : {}),
        finalMessages,
        actionCounts: Object.fromEntries(Object.entries(actionSets).map(([key, set]) => [key, set.size])) as unknown as CodexActionCounts,
        ...(usage ? { usage } : {}), startedAt, completedAt: new Date().toISOString(), ...(firstOutputMs === undefined ? {} : { firstOutputMs }),
        streamComplete, processCompleted: outcome.code === 0 || outcome.signal === "SIGTERM" || outcome.signal === "SIGKILL",
      };
    }
  }
}
