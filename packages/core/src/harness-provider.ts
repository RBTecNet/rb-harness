import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ProviderConfiguration } from "./standalone-types.js";
import { isDirectProvider } from "./provider-registry.js";
import { emitHarnessDashboard, harnessDashboardActive } from "./harness-dashboard.js";

export type ProviderMode = "interview" | "generation" | "audit";

export interface ProviderRunOptions {
  configuration: ProviderConfiguration;
  mode: ProviderMode;
  projectRoot: string;
  prompt: string;
  logPath: string;
  timeoutSeconds: number;
  firstOutputTimeoutSeconds: number;
  streamOutput?: boolean;
  /** Test/embedding override. Standalone workflows use the bounded mode default. */
  maxOutputBytes?: number;
}

export interface ProviderRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  firstOutputMilliseconds?: number;
}

function safeToken(value: string, label: string): string {
  if (value && !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(value)) {
    throw new Error(`${label} contains unsupported characters`);
  }
  return value;
}

export function providerInvocation(
  configuration: ProviderConfiguration,
  mode: ProviderMode,
  projectRoot: string,
): { command: string; args: string[]; environment: NodeJS.ProcessEnv } {
  const model = safeToken(configuration.model, "model");
  const effort = safeToken(configuration.effort, "effort");
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    RB_HARNESS_MODE: mode,
    RB_HARNESS_PROJECT_ROOT: projectRoot,
    RB_HARNESS_PROVIDER: configuration.provider,
    RB_HARNESS_MODEL: model,
    RB_HARNESS_EFFORT: effort,
  };
  if (configuration.provider === "custom") {
    if (!configuration.command) throw new Error("custom provider requires --adapter <executable>");
    return { command: configuration.command, args: [], environment };
  }
  if (configuration.provider === "codex") {
    const args = [
      "exec", "--cd", projectRoot, "--skip-git-repo-check", "--ephemeral", "--color", "never",
      "--sandbox", mode === "generation" ? "workspace-write" : "read-only",
    ];
    if (model) args.push("--model", model);
    if (effort) args.push("-c", `model_reasoning_effort=\"${effort}\"`);
    args.push("-");
    return { command: process.env.RB_HARNESS_CODEX_BIN ?? "codex", args, environment };
  }
  if (configuration.provider === "claude") {
    const permission = mode === "generation" ? "acceptEdits" : "plan";
    const args = ["-p", "--output-format", "text", "--permission-mode", permission, "--no-session-persistence"];
    if (model) args.push("--model", model);
    if (effort) args.push("--effort", effort);
    delete environment.CLAUDECODE;
    return { command: process.env.RB_HARNESS_CLAUDE_BIN ?? "claude", args, environment };
  }
  if (isDirectProvider(configuration.provider)) {
    const role = mode === "generation" ? "harness-generation" : mode === "audit" ? "harness-audit" : "harness-interview";
    const script = process.argv[1];
    if (!script) throw new Error("could not resolve the installed RB Harness executable for the direct API runtime");
    const args = [
      script, "_provider-run",
      "--provider", configuration.provider,
      "--model", model,
      "--role", role,
      "--project", projectRoot,
      "--permission", "protected",
    ];
    if (effort) args.push("--effort", effort);
    if (configuration.credential) args.push("--credential", configuration.credential);
    return { command: process.execPath, args, environment };
  }
  const args = ["run", "--dir", projectRoot];
  if (model) args.push("--model", model);
  if (effort) args.push("--variant", effort);
  if (mode === "generation") args.push("--auto");
  else environment.OPENCODE_PERMISSION = '{"edit":"deny","bash":"deny","task":"deny","external_directory":"deny"}';
  return { command: process.env.RB_HARNESS_OPENCODE_BIN ?? "opencode", args, environment };
}

export function providerOutputLimit(mode: ProviderMode): number {
  return mode === "generation" ? 128 * 1024 * 1024 : 32 * 1024 * 1024;
}

function descendantPids(rootPid: number): number[] {
  if (process.platform === "win32") return [];
  const listed = spawnSync("ps", ["-axo", "pid=,ppid="], {
    encoding: "utf8",
    timeout: 2_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (listed.status !== 0 || !listed.stdout) return [];
  const children = new Map<number, number[]>();
  for (const line of listed.stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const parent = Number(match[2]);
    const siblings = children.get(parent) ?? [];
    siblings.push(pid);
    children.set(parent, siblings);
  }
  const ordered: number[] = [];
  const seen = new Set<number>([rootPid]);
  const visit = (pid: number): void => {
    for (const childPid of children.get(pid) ?? []) {
      if (seen.has(childPid)) continue;
      seen.add(childPid);
      visit(childPid);
      ordered.push(childPid);
    }
  };
  visit(rootPid);
  return ordered;
}

function terminate(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals = "SIGTERM",
  rememberedDescendants: Set<number> = new Set(),
): void {
  const rootPid = child.pid;
  if (!rootPid) return;
  for (const pid of descendantPids(rootPid)) rememberedDescendants.add(pid);
  if (process.platform === "win32") {
    if (signal === "SIGKILL") {
      spawnSync("taskkill", ["/PID", String(rootPid), "/T", "/F"], { timeout: 5_000 });
      return;
    }
    try { child.kill(signal); } catch { /* already exited */ }
    return;
  }
  // Codex and similar CLIs may create nested sessions for sandboxed tools.
  // Killing only the provider process group leaves those descendants orphaned.
  for (const pid of rememberedDescendants) {
    try { process.kill(pid, signal); } catch { /* already exited */ }
  }
  try {
    process.kill(-rootPid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already exited */ }
  }
}

function outputLimitDiagnostic(bytes: number): string {
  if (bytes % (1024 * 1024) === 0) return `provider output exceeded ${bytes / (1024 * 1024)} MiB`;
  return `provider output exceeded ${bytes} bytes`;
}

function redactLog(value: string, environment: NodeJS.ProcessEnv): string {
  const secrets = Object.entries(environment)
    .filter(([name, secret]) => /(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name) && typeof secret === "string" && secret.length >= 8)
    .sort((left, right) => right[1]!.length - left[1]!.length);
  let redacted = value;
  for (const [name, secret] of secrets) redacted = redacted.split(secret!).join(`[REDACTED:${name}]`);
  return redacted;
}

async function writeProviderLog(
  options: ProviderRunOptions,
  environment: NodeJS.ProcessEnv,
  result: ProviderRunResult,
  diagnostic?: string,
): Promise<void> {
  await writeFile(options.logPath, [
    `provider=${options.configuration.provider}`,
    `model=${options.configuration.model || "provider-default"}`,
    `effort=${options.configuration.effort || "provider-default"}`,
    `mode=${options.mode}`,
    `exit_code=${result.exitCode}`,
    `first_output_ms=${result.firstOutputMilliseconds ?? "none"}`,
    ...(diagnostic ? [`diagnostic=${diagnostic}`] : []),
    "",
    "--- stdout ---",
    redactLog(result.stdout, environment),
    "--- stderr ---",
    redactLog(result.stderr, environment),
  ].join("\n"), { encoding: "utf8", mode: 0o600 });
  await chmod(options.logPath, 0o600).catch(() => undefined);
}

export async function runProvider(options: ProviderRunOptions): Promise<ProviderRunResult> {
  const invocation = providerInvocation(options.configuration, options.mode, options.projectRoot);
  emitHarnessDashboard({
    type: "provider-start",
    provider: options.configuration.provider,
    model: options.configuration.model || "provider-default",
    mode: options.mode,
  });
  await mkdir(dirname(options.logPath), { recursive: true });
  const started = Date.now();
  let firstOutputAt: number | undefined;
  let stdout = "";
  let stderr = "";
  const maxBytes = options.maxOutputBytes ?? providerOutputLimit(options.mode);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("provider output limit must be a positive safe integer");

  let result: ProviderRunResult;
  try {
    result = await new Promise<ProviderRunResult>((resolveRun, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.projectRoot,
      env: invocation.environment,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    let timedOut = "";
    let observedBytes = 0;
    const rememberedDescendants = new Set<number>();
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (reason: string) => {
      if (timedOut) return;
      timedOut = reason;
      terminate(child, "SIGTERM", rememberedDescendants);
      forceTimer = setTimeout(() => terminate(child, "SIGKILL", rememberedDescendants), 5_000);
      forceTimer.unref();
    };
    const wallTimer = options.timeoutSeconds > 0
      ? setTimeout(() => stop(`provider exceeded ${options.timeoutSeconds}s wall timeout`), options.timeoutSeconds * 1000)
      : undefined;
    const firstTimer = options.firstOutputTimeoutSeconds > 0
      ? setTimeout(() => stop(`provider produced no output within ${options.firstOutputTimeoutSeconds}s`), options.firstOutputTimeoutSeconds * 1000)
      : undefined;
    const showProgress = !harnessDashboardActive() && Boolean(options.streamOutput || process.stderr.isTTY);
    const heartbeat = showProgress ? setInterval(() => {
      const elapsed = Math.floor((Date.now() - started) / 1000);
      if (firstOutputAt === undefined) process.stderr.write(`[rb-harness] provider ativo há ${elapsed}s; aguardando a primeira saída...\n`);
      else process.stderr.write(`[rb-harness] provider ativo há ${elapsed}s; ${Buffer.byteLength(stdout) + Buffer.byteLength(stderr)} bytes observados.\n`);
    }, 15_000) : undefined;
    const observe = (chunk: Buffer, channel: "stdout" | "stderr") => {
      if (firstOutputAt === undefined) {
        firstOutputAt = Date.now();
        if (firstTimer) clearTimeout(firstTimer);
        if (!options.streamOutput && process.stderr.isTTY) {
          process.stderr.write(`[rb-harness] primeira saída do provider recebida após ${Math.max(1, Math.floor((firstOutputAt - started) / 1000))}s; analisando resposta...\n`);
        }
      }
      const text = chunk.toString("utf8");
      observedBytes += Buffer.byteLength(chunk);
      if (channel === "stdout") stdout += text; else stderr += text;
      emitHarnessDashboard({
        type: "provider-output",
        bytes: observedBytes,
        ...(firstOutputAt ? { firstOutputMilliseconds: firstOutputAt - started } : {}),
      });
      if (observedBytes > maxBytes) {
        stop(outputLimitDiagnostic(maxBytes));
      }
      if (options.streamOutput && !harnessDashboardActive()) (channel === "stdout" ? process.stdout : process.stderr).write(text);
    };
    child.stdout.on("data", (chunk: Buffer) => observe(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => observe(chunk, "stderr"));
    child.once("error", (error) => {
      if (wallTimer) clearTimeout(wallTimer);
      if (firstTimer) clearTimeout(firstTimer);
      if (forceTimer) clearTimeout(forceTimer);
      if (heartbeat) clearInterval(heartbeat);
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (wallTimer) clearTimeout(wallTimer);
      if (firstTimer) clearTimeout(firstTimer);
      if (forceTimer) clearTimeout(forceTimer);
      if (heartbeat) clearInterval(heartbeat);
      if (timedOut) {
        terminate(child, "SIGKILL", rememberedDescendants);
        return reject(new Error(timedOut));
      }
      resolveRun({
        exitCode: code ?? (signal ? 70 : 1),
        stdout,
        stderr,
        ...(firstOutputAt ? { firstOutputMilliseconds: firstOutputAt - started } : {}),
      });
    });
    child.stdin.end(options.prompt, "utf8");
    });
  } catch (error) {
    const diagnostic = error instanceof Error ? error.message : String(error);
    result = { exitCode: 70, stdout, stderr, ...(firstOutputAt ? { firstOutputMilliseconds: firstOutputAt - started } : {}) };
    await writeProviderLog(options, invocation.environment, result, diagnostic);
    emitHarnessDashboard({ type: "provider-end", exitCode: 70, bytes: Buffer.byteLength(stdout) + Buffer.byteLength(stderr) });
    throw new Error(`${diagnostic}; see ${options.logPath}`);
  }
  await writeProviderLog(options, invocation.environment, result);
  emitHarnessDashboard({ type: "provider-end", exitCode: result.exitCode, bytes: Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) });
  if (result.exitCode !== 0) throw new Error(`provider ${options.configuration.provider} exited with code ${result.exitCode}; see ${options.logPath}`);
  return result;
}
