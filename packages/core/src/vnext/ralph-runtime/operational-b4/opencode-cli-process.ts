import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { spawnProcessTree, type ProcessTreeHandle, type SettleOutcome } from "../../../process-tree.js";
import { defaultProcessIdentityProvider, type ProcessIdentity, type ProcessIdentityProvider } from "../operational-b2/index.js";
import { SpawnOpenCodeProcess } from "../../providers/opencode/cli-adapter.js";
import {
  OPENCODE_CLI_EXECUTOR_PATH_V2,
  OPENCODE_CLI_EXECUTOR_TRANSPORT_VERSION_V2,
  RalphM4BError,
} from "./opencode-cli-contract.js";

const LOOPBACK_URL = /^http:\/\/127\.0\.0\.1:(\d{1,5})$/;

export interface OpenCodeCliExecutablePreflightV2 {
  readonly executablePath: typeof OPENCODE_CLI_EXECUTOR_PATH_V2;
  readonly executableVersion: typeof OPENCODE_CLI_EXECUTOR_TRANSPORT_VERSION_V2;
}

export interface OpenCodeCliWorkerV2 {
  readonly processIdentity: ProcessIdentity;
  readonly processGroupId: number;
  readonly startedAt: string;
  startServer(): Promise<string>;
  settle(reason: string): Promise<SettleOutcome>;
}

export function openCodeM4BChildEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed = new Set([
    "PATH", "HOME", "TMPDIR", "TEMP", "TMP", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME",
    "LANG", "LANGUAGE", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
    "SystemRoot", "WINDIR", "ComSpec", "PATHEXT",
  ]);
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && (allowed.has(key) || /^LC_[A-Z_]+$/.test(key))) environment[key] = value;
  }
  environment.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    instructions: [],
    permission: {
      read: "allow", glob: "allow", grep: "allow", list: "allow",
      edit: "allow", write: "allow", patch: "allow", bash: "deny",
      task: "deny", webfetch: "deny", websearch: "deny", codesearch: "deny",
      external_directory: "deny",
    },
  });
  environment.OPENCODE_DISABLE_CLAUDE_CODE = "1";
  environment.DO_NOT_TRACK = "1";
  return environment;
}

/**
 * Supported session-scoped permission rules. OpenCode applies the last
 * matching rule, so broad defaults precede narrow control-plane denials and
 * the tiny local-command allowlist follows the deny-all bash rule.
 */
export function openCodeM4BPermissionRulesV2(): readonly Readonly<Record<string, string>>[] {
  return Object.freeze([
    { permission: "read", pattern: "*", action: "allow" },
    { permission: "glob", pattern: "*", action: "allow" },
    { permission: "grep", pattern: "*", action: "allow" },
    { permission: "list", pattern: "*", action: "allow" },
    { permission: "edit", pattern: "*", action: "allow" },
    { permission: "edit", pattern: ".rb", action: "deny" },
    { permission: "edit", pattern: ".rb/**", action: "deny" },
    { permission: "edit", pattern: ".rb-harness", action: "deny" },
    { permission: "edit", pattern: ".rb-harness/**", action: "deny" },
    { permission: "edit", pattern: ".git", action: "deny" },
    { permission: "edit", pattern: ".git/**", action: "deny" },
    { permission: "write", pattern: "*", action: "allow" },
    { permission: "write", pattern: ".rb", action: "deny" },
    { permission: "write", pattern: ".rb/**", action: "deny" },
    { permission: "write", pattern: ".rb-harness", action: "deny" },
    { permission: "write", pattern: ".rb-harness/**", action: "deny" },
    { permission: "write", pattern: ".git", action: "deny" },
    { permission: "write", pattern: ".git/**", action: "deny" },
    { permission: "patch", pattern: "*", action: "allow" },
    { permission: "patch", pattern: ".rb", action: "deny" },
    { permission: "patch", pattern: ".rb/**", action: "deny" },
    { permission: "patch", pattern: ".rb-harness", action: "deny" },
    { permission: "patch", pattern: ".rb-harness/**", action: "deny" },
    { permission: "patch", pattern: ".git", action: "deny" },
    { permission: "patch", pattern: ".git/**", action: "deny" },
    { permission: "bash", pattern: "*", action: "deny" },
    { permission: "bash", pattern: "pwd", action: "allow" },
    { permission: "bash", pattern: "ls", action: "allow" },
    { permission: "bash", pattern: "git status --short", action: "allow" },
    { permission: "task", pattern: "*", action: "deny" },
    { permission: "webfetch", pattern: "*", action: "deny" },
    { permission: "websearch", pattern: "*", action: "deny" },
    { permission: "codesearch", pattern: "*", action: "deny" },
    { permission: "external_directory", pattern: "*", action: "deny" },
  ].map((rule) => Object.freeze(rule)));
}

export async function inspectExactOpenCodeCliExecutableV2(projectRoot: string, deadlineMs: number): Promise<OpenCodeCliExecutablePreflightV2> {
  if (resolve(projectRoot) !== projectRoot) throw new RalphM4BError("M4B_WORKSPACE_BINDING_INVALID");
  const controller = new AbortController();
  const processClient = new SpawnOpenCodeProcess();
  const result = await processClient.run({
    executable: OPENCODE_CLI_EXECUTOR_PATH_V2,
    args: ["--version"],
    stdin: "",
    cwd: projectRoot,
    env: openCodeM4BChildEnvironment(),
    signal: controller.signal,
    deadlineMs,
  });
  const version = result.stdout.trim().match(/^(?:OpenCode\s+)?(\d+\.\d+\.\d+)$/i)?.[1];
  if (result.exitCode !== 0 || result.spawnFailed || result.timedOut || result.cancelled || !result.settlement.quiescent || !result.settlement.verified || version !== OPENCODE_CLI_EXECUTOR_TRANSPORT_VERSION_V2) {
    throw new RalphM4BError("M4B_EXECUTABLE_IDENTITY_INVALID");
  }
  return Object.freeze({ executablePath: OPENCODE_CLI_EXECUTOR_PATH_V2, executableVersion: OPENCODE_CLI_EXECUTOR_TRANSPORT_VERSION_V2 });
}

export async function startOpenCodeCliWorkerV2(input: {
  readonly projectRoot: string;
  readonly deadlineMs: number;
  readonly processIdentityProvider?: ProcessIdentityProvider;
  readonly clock?: () => string;
}): Promise<OpenCodeCliWorkerV2> {
  if (process.platform === "win32") throw new RalphM4BError("M4B_PROCESS_IDENTITY_INVALID");
  if (resolve(input.projectRoot) !== input.projectRoot || !Number.isSafeInteger(input.deadlineMs) || input.deadlineMs < 1) throw new RalphM4BError("M4B_WORKSPACE_BINDING_INVALID");
  const workerPath = await resolveOpenCodeCliWorkerPathV2();
  const handle = spawnProcessTree(process.execPath, [workerPath], {
    cwd: input.projectRoot,
    env: openCodeM4BChildEnvironment(),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const startedAt = (input.clock ?? (() => new Date().toISOString()))();
  try {
    const ready = await waitForWorkerMessage(handle, input.deadlineMs, "WORKER_READY");
    const identity = parseProcessIdentity(ready.processIdentity);
    if (identity.pid !== handle.pid || handle.pid < 1) throw new RalphM4BError("M4B_PROCESS_IDENTITY_INVALID");
    const inspection = await (input.processIdentityProvider ?? defaultProcessIdentityProvider).inspect(identity);
    if (inspection !== "MATCH") throw new RalphM4BError("M4B_PROCESS_IDENTITY_INVALID");
    let serverStarted = false;
    return Object.freeze({
      processIdentity: identity,
      processGroupId: handle.pid,
      startedAt,
      async startServer(): Promise<string> {
        if (serverStarted) throw new RalphM4BError("M4B_REDISPATCH_FORBIDDEN");
        serverStarted = true;
        handle.child.send?.({ kind: "START_SERVER", requestId: randomUUID() });
        const message = await waitForWorkerMessage(handle, input.deadlineMs, "SERVER_READY");
        if (typeof message.baseUrl !== "string" || !LOOPBACK_URL.test(message.baseUrl)) throw new RalphM4BError("M4B_SERVER_START_FAILED");
        return message.baseUrl;
      },
      async settle(reason: string): Promise<SettleOutcome> {
        handle.terminate(reason);
        const outcome = await handle.settle(reason, input.deadlineMs);
        handle.dispose();
        return outcome;
      },
    });
  } catch (error) {
    handle.terminate("M4-B worker startup failed");
    await handle.settle("M4-B worker startup failed", input.deadlineMs);
    handle.dispose();
    throw error instanceof RalphM4BError ? error : new RalphM4BError("M4B_PROCESS_START_FAILED", undefined, error);
  }
}

async function resolveOpenCodeCliWorkerPathV2(): Promise<string> {
  const bundledSibling = fileURLToPath(new URL("./opencode-cli-worker.js", import.meta.url));
  try { await access(bundledSibling); return bundledSibling; }
  catch {
    const builtWorker = fileURLToPath(new URL("../../../../dist/opencode-cli-worker.js", import.meta.url));
    try { await access(builtWorker); return builtWorker; }
    catch (error) { throw new RalphM4BError("M4B_PROCESS_START_FAILED", "M4B_PROCESS_START_FAILED: built OpenCode worker is unavailable", error); }
  }
}

interface WorkerMessage { readonly kind: string; readonly processIdentity?: unknown; readonly baseUrl?: unknown; readonly message?: unknown }

function waitForWorkerMessage(handle: ProcessTreeHandle, deadlineMs: number, expectedKind: string): Promise<WorkerMessage> {
  return new Promise((resolveMessage, rejectMessage) => {
    let settled = false;
    const finish = (error?: Error, value?: WorkerMessage): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      handle.child.off("message", onMessage);
      handle.child.off("error", onError);
      handle.child.off("exit", onExit);
      if (error) rejectMessage(error);
      else resolveMessage(value!);
    };
    const onMessage = (value: unknown): void => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return;
      const message = value as WorkerMessage;
      if (message.kind === "WORKER_FAILED") finish(new RalphM4BError("M4B_SERVER_START_FAILED"));
      else if (message.kind === expectedKind) finish(undefined, message);
    };
    const onError = (error: Error): void => finish(new RalphM4BError("M4B_PROCESS_START_FAILED", undefined, error));
    const onExit = (): void => finish(new RalphM4BError(expectedKind === "WORKER_READY" ? "M4B_PROCESS_START_FAILED" : "M4B_SERVER_START_FAILED"));
    const timer = setTimeout(() => finish(new RalphM4BError(expectedKind === "WORKER_READY" ? "M4B_PROCESS_START_FAILED" : "M4B_SERVER_START_FAILED")), deadlineMs);
    handle.child.on("message", onMessage);
    handle.child.once("error", onError);
    handle.child.once("exit", onExit);
  });
}

function parseProcessIdentity(value: unknown): ProcessIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RalphM4BError("M4B_PROCESS_IDENTITY_INVALID");
  const record = value as Record<string, unknown>;
  if (!Number.isSafeInteger(record.pid) || Number(record.pid) < 1
    || typeof record.processStartIdentity !== "string" || !record.processStartIdentity
    || typeof record.hostIdentity !== "string" || !record.hostIdentity
    || typeof record.bootSessionIdentity !== "string" || !record.bootSessionIdentity) throw new RalphM4BError("M4B_PROCESS_IDENTITY_INVALID");
  return Object.freeze({ pid: Number(record.pid), processStartIdentity: record.processStartIdentity, hostIdentity: record.hostIdentity, bootSessionIdentity: record.bootSessionIdentity });
}

export async function runOpenCodeCliWorkerProcessV2(): Promise<void> {
  if (!process.send) process.exit(70);
  try {
    const identity = await defaultProcessIdentityProvider.current();
    process.send({ kind: "WORKER_READY", processIdentity: identity });
  } catch {
    process.send({ kind: "WORKER_FAILED" });
    process.exit(70);
  }
  let server: ReturnType<typeof spawn> | undefined;
  let outputBytes = 0;
  let buffer = "";
  const fail = (): void => { process.send?.({ kind: "WORKER_FAILED" }); };
  process.on("message", (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value) || (value as { kind?: unknown }).kind !== "START_SERVER" || server) return;
    server = spawn(OPENCODE_CLI_EXECUTOR_PATH_V2, ["serve", "--pure", "--hostname", "127.0.0.1", "--port", "0"], {
      cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"], detached: false,
    });
    const consume = (chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > 64 * 1024) { fail(); server?.kill("SIGTERM"); return; }
      buffer += chunk.toString("utf8");
      const match = buffer.match(/listening on (http:\/\/127\.0\.0\.1:\d{1,5})/);
      if (match?.[1]) process.send?.({ kind: "SERVER_READY", baseUrl: match[1] });
    };
    server.stdout?.on("data", consume);
    server.stderr?.on("data", consume);
    server.once("error", fail);
    server.once("exit", () => process.exit(0));
  });
  const terminate = (): void => {
    try { server?.kill("SIGTERM"); } catch { /* parent process tree settlement remains authoritative */ }
    setTimeout(() => process.exit(0), 250).unref();
  };
  process.once("SIGTERM", terminate);
  process.once("SIGINT", terminate);
}
