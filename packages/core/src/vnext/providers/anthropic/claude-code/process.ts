import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnProcessTree, type SettleOutcome } from "../../../../process-tree.js";

export const CLAUDE_CODE_EXECUTABLE = "claude";

/** Variables that can replace subscription auth, redirect inference, or enable hidden retries/fallback. */
export const CLAUDE_CODE_GUARDED_ENVIRONMENT = Object.freeze([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_AWS_API_KEY",
  "ANTHROPIC_AWS_BASE_URL",
  "ANTHROPIC_AWS_WORKSPACE_ID",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
  "ANTHROPIC_BEDROCK_REGION_PREFIX",
  "ANTHROPIC_BEDROCK_SERVICE_TIER",
  "ANTHROPIC_BETAS",
  "ANTHROPIC_CUSTOM_MODEL_OPTION",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_ORGANIZATION_ID",
  "ANTHROPIC_PROFILE",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "ANTHROPIC_WORKSPACE_ID",
  "AWS_BEARER_TOKEN_BEDROCK",
  "CLAUDECODE",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_FORCE_SESSION_PERSISTENCE",
  "CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING",
  "CLAUDE_CODE_EFFORT_LEVEL",
  "CLAUDE_CODE_EXTRA_BODY",
  "CLAUDE_CODE_MAX_RETRIES",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_OAUTH_SCOPES",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
  "CLAUDE_CODE_RETRY_WATCHDOG",
  "CLAUDE_CODE_SIMPLE",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_VERTEX",
  "FALLBACK_FOR_ALL_PRIMARY_MODELS",
  "MAX_STRUCTURED_OUTPUT_RETRIES",
  "MAX_THINKING_TOKENS",
] as const);

export function claudeCodeChildEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  maxOutputTokens?: number,
): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { ...source };
  for (const name of CLAUDE_CODE_GUARDED_ENVIRONMENT) delete clean[name];
  clean.CLAUDE_CODE_SAFE_MODE = "1";
  clean.CLAUDE_CODE_MAX_RETRIES = "0";
  clean.MAX_STRUCTURED_OUTPUT_RETRIES = "0";
  clean.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  clean.DISABLE_TELEMETRY = "1";
  clean.DISABLE_ERROR_REPORTING = "1";
  if (maxOutputTokens !== undefined) clean.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(maxOutputTokens);
  return clean;
}

export interface ClaudeCodeCommandInput {
  readonly args: readonly string[];
  readonly stdin: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  readonly deadlineMs: number;
}

export interface ClaudeCodeCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly exitSignal: NodeJS.Signals | null;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly firstOutputMs?: number;
  readonly cancelled: boolean;
  readonly timedOut: boolean;
  readonly outputLimitExceeded: boolean;
  readonly settlement: SettleOutcome;
}

export interface ClaudeCodeProcess {
  run(input: ClaudeCodeCommandInput): Promise<ClaudeCodeCommandResult>;
}

const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;

export class SpawnClaudeCodeProcess implements ClaudeCodeProcess {
  async run(input: ClaudeCodeCommandInput): Promise<ClaudeCodeCommandResult> {
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    const handle = spawnProcessTree(CLAUDE_CODE_EXECUTABLE, [...input.args], {
      cwd: input.cwd,
      env: input.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let firstOutputMs: number | undefined;
    let cancelled = false;
    let timedOut = false;
    let outputLimitExceeded = false;
    let spawnError: Error | undefined;

    const observe = (target: "stdout" | "stderr", chunk: Buffer): void => {
      if (firstOutputMs === undefined) {
        firstOutputMs = Date.now() - started;
        handle.sample();
      }
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + chunk.byteLength > MAX_CAPTURE_BYTES) {
        outputLimitExceeded = true;
        handle.terminate("Claude Code output exceeded capture limit");
        return;
      }
      if (target === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };
    handle.child.stdout?.on("data", (chunk: Buffer) => observe("stdout", chunk));
    handle.child.stderr?.on("data", (chunk: Buffer) => observe("stderr", chunk));

    const onAbort = (): void => {
      cancelled = true;
      handle.terminate("Claude Code request cancelled");
    };
    input.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      handle.terminate("Claude Code request deadline elapsed");
    }, input.deadlineMs);

    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
      handle.child.once("error", (error) => {
        spawnError = error;
        resolveExit({ code: null, signal: null });
      });
      handle.child.once("close", (code, signal) => resolveExit({ code, signal }));
    });
    handle.child.stdin?.end(input.stdin, "utf8");

    try {
      const result = await exit;
      const settlement = await handle.settle("Claude Code command completed");
      if (spawnError) stderr = `${stderr}${stderr ? "\n" : ""}${spawnError.message}`;
      return {
        stdout,
        stderr,
        exitCode: result.code,
        exitSignal: result.signal,
        startedAt,
        completedAt: new Date().toISOString(),
        ...(firstOutputMs === undefined ? {} : { firstOutputMs }),
        cancelled,
        timedOut,
        outputLimitExceeded,
        settlement,
      };
    } finally {
      clearTimeout(timer);
      input.signal.removeEventListener("abort", onAbort);
      handle.dispose();
    }
  }
}

export async function withClaudeCodeIsolation<T>(
  instructions: string,
  run: (input: { readonly cwd: string; readonly systemPromptFile: string }) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(resolve(tmpdir(), "rb-vnext-claude-code-"));
  const systemPromptFile = resolve(root, "system-prompt.txt");
  try {
    await writeFile(systemPromptFile, instructions, { encoding: "utf8", mode: 0o600 });
    return await run({ cwd: root, systemPromptFile });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
