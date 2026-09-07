import { spawn, type ChildProcess } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { sha256Canonical } from "../hashing.js";
import { assertNoCredentialMaterial, RalphCredentialSafetyError } from "../operational-b1/secret-safety.js";

export const VALIDATION_PROCESS_INFRASTRUCTURE_STATUSES = [
  "NONE",
  "SPAWN_FAILURE",
  "PROCESS_SUPERVISION_FAILURE",
  "UNKNOWN_TERMINATION",
  "RUNNER_PROTOCOL_FAILURE",
  "TIMEOUT",
  "CANCELLED",
] as const;
export type ValidationProcessInfrastructureStatusV2 = typeof VALIDATION_PROCESS_INFRASTRUCTURE_STATUSES[number];

export const VALIDATION_DEFAULT_SHELL_POLICY_V2 = Object.freeze({
  executable: "/bin/sh",
  args: Object.freeze(["-c"]),
  identity: "posix-sh-c-v1",
  policyDigest: sha256Canonical({ executable: "/bin/sh", args: ["-c"], identity: "posix-sh-c-v1" }),
});

export interface ValidationShellPolicyV2 {
  readonly executable: string;
  readonly args: readonly string[];
  readonly identity: string;
  readonly policyDigest: string;
}

export interface ValidationEnvironmentPolicyV2 {
  readonly allowedKeys: readonly string[];
  readonly inheritedKeys: readonly string[];
  readonly explicit: Readonly<Record<string, string>>;
  readonly policyDigest: string;
}

export interface ValidationProcessPolicyV2 {
  readonly shell: ValidationShellPolicyV2;
  readonly environment: ValidationEnvironmentPolicyV2;
  readonly timeoutMs: number;
  readonly killGraceMs: number;
  readonly maxOutputBytes: number;
}

export interface ValidationProcessInputV2 {
  readonly command: string;
  readonly cwd: string;
  /** D supplies the verified project root; the supervisor never selects it. */
  readonly expectedProjectRoot?: string;
  readonly policy?: Partial<ValidationProcessPolicyV2> & {
    readonly shell?: ValidationShellPolicyV2;
    readonly environment?: ValidationEnvironmentPolicyV2;
  };
  readonly signal?: AbortSignal;
}

export interface ValidationProcessResultV2 {
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly infrastructureStatus: ValidationProcessInfrastructureStatusV2;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly startedAt: string;
  readonly finishedAt: string;
}

export interface ValidationProcessSupervisorV2Like {
  readonly run: (input: ValidationProcessInputV2) => Promise<ValidationProcessResultV2>;
}

export const VALIDATION_DEFAULT_ENVIRONMENT_POLICY_V2: ValidationEnvironmentPolicyV2 = Object.freeze({
  allowedKeys: Object.freeze(["PATH", "LANG", "LC_ALL", "TMPDIR", "TMP", "TEMP", "CI"]),
  inheritedKeys: Object.freeze(["PATH", "LANG", "LC_ALL", "TMPDIR", "TMP", "TEMP", "CI"]),
  explicit: Object.freeze({}),
  policyDigest: sha256Canonical({
    allowedKeys: ["PATH", "LANG", "LC_ALL", "TMPDIR", "TMP", "TEMP", "CI"],
    inheritedKeys: ["PATH", "LANG", "LC_ALL", "TMPDIR", "TMP", "TEMP", "CI"],
    explicit: {},
  }),
});

export const VALIDATION_DEFAULT_PROCESS_POLICY_V2: ValidationProcessPolicyV2 = Object.freeze({
  shell: VALIDATION_DEFAULT_SHELL_POLICY_V2,
  environment: VALIDATION_DEFAULT_ENVIRONMENT_POLICY_V2,
  timeoutMs: 30_000,
  killGraceMs: 500,
  maxOutputBytes: 8_192,
});

export class RalphValidationProcessError extends Error {
  constructor(readonly code: "D_VALIDATION_PROCESS_POLICY_INVALID" | "D_VALIDATION_CWD_INVALID" | "D_VALIDATION_DIAGNOSTIC_UNSAFE", message: string = code, readonly cause?: unknown) {
    super(message);
    this.name = "RalphValidationProcessError";
  }
}

export function createValidationShellPolicyV2(input: {
  readonly executable?: string;
  readonly args?: readonly string[];
  readonly identity?: string;
} = {}): ValidationShellPolicyV2 {
  const executable = input.executable ?? VALIDATION_DEFAULT_SHELL_POLICY_V2.executable;
  const args = [...(input.args ?? VALIDATION_DEFAULT_SHELL_POLICY_V2.args)];
  const identity = input.identity ?? `posix-shell-${executable.replaceAll("/", "_")}-c-v1`;
  assertShellExecutable(executable);
  if (args.length !== 1 || args[0] !== "-c") throw new RalphValidationProcessError("D_VALIDATION_PROCESS_POLICY_INVALID", "D_VALIDATION_PROCESS_POLICY_INVALID: shell must receive command as one -c argument");
  assertSafeToken(identity);
  const base = { executable, args, identity };
  return Object.freeze({ ...base, policyDigest: sha256Canonical(base) });
}

export function createValidationEnvironmentPolicyV2(input: {
  readonly allowedKeys?: readonly string[];
  readonly inheritedKeys?: readonly string[];
  readonly explicit?: Readonly<Record<string, string>>;
} = {}): ValidationEnvironmentPolicyV2 {
  const allowedKeys = [...(input.allowedKeys ?? VALIDATION_DEFAULT_ENVIRONMENT_POLICY_V2.allowedKeys)];
  const inheritedKeys = [...(input.inheritedKeys ?? allowedKeys)];
  const explicit = { ...(input.explicit ?? {}) };
  const allowed = new Set(allowedKeys);
  for (const key of allowedKeys) {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(key) || isSecretEnvironmentKey(key)) throw new RalphValidationProcessError("D_VALIDATION_PROCESS_POLICY_INVALID", "D_VALIDATION_PROCESS_POLICY_INVALID: unsafe environment key");
  }
  for (const key of inheritedKeys) if (!allowed.has(key)) throw new RalphValidationProcessError("D_VALIDATION_PROCESS_POLICY_INVALID", "D_VALIDATION_PROCESS_POLICY_INVALID: inherited environment key is not allowlisted");
  for (const [key, value] of Object.entries(explicit)) {
    if (!allowed.has(key) || typeof value !== "string" || value.length > 1024 || value.includes("\0")) throw new RalphValidationProcessError("D_VALIDATION_PROCESS_POLICY_INVALID", "D_VALIDATION_PROCESS_POLICY_INVALID: explicit environment value");
  }
  const base = { allowedKeys, inheritedKeys, explicit };
  return Object.freeze({ ...base, policyDigest: sha256Canonical(base) });
}

export function createValidationProcessPolicyV2(input: Partial<ValidationProcessPolicyV2> = {}): ValidationProcessPolicyV2 {
  const shell = input.shell ?? VALIDATION_DEFAULT_PROCESS_POLICY_V2.shell;
  const environment = input.environment ?? VALIDATION_DEFAULT_PROCESS_POLICY_V2.environment;
  validateValidationShellPolicyV2(shell);
  validateValidationEnvironmentPolicyV2(environment);
  const timeoutMs = input.timeoutMs ?? VALIDATION_DEFAULT_PROCESS_POLICY_V2.timeoutMs;
  const killGraceMs = input.killGraceMs ?? VALIDATION_DEFAULT_PROCESS_POLICY_V2.killGraceMs;
  const maxOutputBytes = input.maxOutputBytes ?? VALIDATION_DEFAULT_PROCESS_POLICY_V2.maxOutputBytes;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000
    || !Number.isSafeInteger(killGraceMs) || killGraceMs < 1 || killGraceMs > 10_000
    || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 1_048_576) {
    throw new RalphValidationProcessError("D_VALIDATION_PROCESS_POLICY_INVALID", "D_VALIDATION_PROCESS_POLICY_INVALID: bounded process policy required");
  }
  return Object.freeze({ shell, environment, timeoutMs, killGraceMs, maxOutputBytes });
}

export function validateValidationShellPolicyV2(value: ValidationShellPolicyV2): void {
  if (!value || typeof value !== "object") throw new RalphValidationProcessError("D_VALIDATION_PROCESS_POLICY_INVALID");
  assertShellExecutable(value.executable);
  if (!Array.isArray(value.args) || value.args.length !== 1 || value.args[0] !== "-c") throw new RalphValidationProcessError("D_VALIDATION_PROCESS_POLICY_INVALID", "D_VALIDATION_PROCESS_POLICY_INVALID: shell args");
  assertSafeToken(value.identity);
  if (sha256Canonical({ executable: value.executable, args: [...value.args], identity: value.identity }) !== value.policyDigest) throw new RalphValidationProcessError("D_VALIDATION_PROCESS_POLICY_INVALID", "D_VALIDATION_PROCESS_POLICY_INVALID: shell policy digest");
}

export function validateValidationEnvironmentPolicyV2(value: ValidationEnvironmentPolicyV2): void {
  if (!value || typeof value !== "object" || !Array.isArray(value.allowedKeys) || !Array.isArray(value.inheritedKeys) || !isRecord(value.explicit)) throw new RalphValidationProcessError("D_VALIDATION_PROCESS_POLICY_INVALID");
  const expected = createValidationEnvironmentPolicyV2({ allowedKeys: value.allowedKeys, inheritedKeys: value.inheritedKeys, explicit: value.explicit });
  if (expected.policyDigest !== value.policyDigest) throw new RalphValidationProcessError("D_VALIDATION_PROCESS_POLICY_INVALID", "D_VALIDATION_PROCESS_POLICY_INVALID: environment policy digest");
}

export async function verifyValidationCwdV2(cwd: string, expectedProjectRoot?: string): Promise<string> {
  if (!isAbsolute(cwd) || cwd.includes("\0")) throw new RalphValidationProcessError("D_VALIDATION_CWD_INVALID");
  let stats;
  try { stats = await lstat(cwd); }
  catch (error) { throw new RalphValidationProcessError("D_VALIDATION_CWD_INVALID", "D_VALIDATION_CWD_INVALID: cwd cannot be inspected", error); }
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new RalphValidationProcessError("D_VALIDATION_CWD_INVALID", "D_VALIDATION_CWD_INVALID: cwd must be a real directory");
  const resolved = await realpath(cwd);
  if (expectedProjectRoot !== undefined) {
    const expected = await realpath(expectedProjectRoot);
    if (resolved !== expected) throw new RalphValidationProcessError("D_VALIDATION_CWD_INVALID", "D_VALIDATION_CWD_INVALID: cwd is not the verified project root");
  }
  return resolved;
}

export class ValidationProcessSupervisorV2 implements ValidationProcessSupervisorV2Like {
  private readonly clock: () => string;
  private readonly defaultPolicy: ValidationProcessPolicyV2;

  constructor(input: { readonly clock?: () => string; readonly policy?: ValidationProcessPolicyV2 } = {}) {
    this.clock = input.clock ?? (() => new Date().toISOString());
    this.defaultPolicy = createValidationProcessPolicyV2(input.policy);
  }

  async run(input: ValidationProcessInputV2): Promise<ValidationProcessResultV2> {
    const policy = createValidationProcessPolicyV2({ ...this.defaultPolicy, ...(input.policy ?? {}) });
    if (typeof input.command !== "string" || input.command.length === 0 || input.command.length > 4_096 || input.command.includes("\0")) {
      return protocolFailure(this.clock);
    }
    const cwd = await verifyValidationCwdV2(input.cwd, input.expectedProjectRoot);
    const environment = boundedEnvironment(policy.environment);
    if (input.signal?.aborted) return cancelledResult(this.clock);
    const startedAt = this.clock();
    let child: ChildProcess;
    try {
      // The entire trusted command is exactly one argument after -c.  It is
      // never split into argv by the Core boundary.
      child = spawn(policy.shell.executable, [...policy.shell.args, input.command], {
        cwd,
        env: environment,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      return processFailure("SPAWN_FAILURE", startedAt, this.clock());
    }

    return superviseChild(child, policy, input.signal, startedAt, this.clock);
  }
}

export const runValidationCommandV2 = async (input: ValidationProcessInputV2 & { readonly supervisor?: ValidationProcessSupervisorV2Like }): Promise<ValidationProcessResultV2> => {
  const supervisor = input.supervisor ?? new ValidationProcessSupervisorV2();
  return supervisor.run(input);
};

async function superviseChild(
  child: ChildProcess,
  policy: ValidationProcessPolicyV2,
  signal: AbortSignal | undefined,
  startedAt: string,
  clock: () => string,
): Promise<ValidationProcessResultV2> {
  const stdout = boundedStream(policy.maxOutputBytes);
  const stderr = boundedStream(policy.maxOutputBytes);
  let settled = false;
  let didStart = false;
  let timeout = false;
  let cancelled = false;
  let infrastructureStatus: ValidationProcessInfrastructureStatusV2 = "NONE";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;

  const stop = (reason: "TIMEOUT" | "CANCELLED") => {
    // The first terminal infrastructure fact wins.  In particular, an abort
    // racing a timeout must not produce contradictory timeout+cancel facts or
    // change the immutable classification after the boundary was crossed.
    if (settled || infrastructureStatus !== "NONE") return;
    if (reason === "TIMEOUT") timeout = true;
    else cancelled = true;
    infrastructureStatus = reason;
    terminateProcessTree(child, "SIGTERM");
    killTimer = setTimeout(() => terminateProcessTree(child, "SIGKILL"), policy.killGraceMs);
  };

  if (child.stdout) child.stdout.on("data", (chunk: Buffer | string) => stdout.push(chunk));
  if (child.stderr) child.stderr.on("data", (chunk: Buffer | string) => stderr.push(chunk));
  const abort = () => stop("CANCELLED");
  signal?.addEventListener("abort", abort, { once: true });
  timer = setTimeout(() => stop("TIMEOUT"), policy.timeoutMs);

  return await new Promise<ValidationProcessResultV2>((resolve) => {
    const finish = (result: ValidationProcessResultV2) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
      resolve(result);
    };
    child.once("spawn", () => { didStart = true; });
    child.once("error", () => {
      if (settled || infrastructureStatus !== "NONE") return;
      if (!didStart) infrastructureStatus = "SPAWN_FAILURE";
      else infrastructureStatus = "PROCESS_SUPERVISION_FAILURE";
    });
    child.once("close", (exitCode: number | null, exitSignal: NodeJS.Signals | null) => {
      const pid = child.pid;
      const groupHasDescendants = pid !== undefined && pid !== null && processGroupAlive(pid);
      if (groupHasDescendants && infrastructureStatus === "NONE") {
        // A shell can close its own stdio while a background descendant keeps
        // the invocation alive.  Do not publish semantic PASS/FAIL until the
        // entire detached process group is quiescent; contain the descendants
        // and classify the boundary as infrastructure failure.
        infrastructureStatus = "PROCESS_SUPERVISION_FAILURE";
        terminateProcessTree(child, "SIGTERM");
        killTimer = setTimeout(() => terminateProcessTree(child, "SIGKILL"), policy.killGraceMs);
      }
      const wait = groupHasDescendants && pid !== undefined && pid !== null
        ? waitForProcessGroupQuiescence(pid, policy.killGraceMs)
        : Promise.resolve();
      void wait.then(() => {
        const finalInfrastructure = infrastructureStatus === "NONE" && exitCode === null && exitSignal === null
          ? "UNKNOWN_TERMINATION"
          : infrastructureStatus;
        finish({
          stdout: sanitizeDiagnostic(stdout.value()),
          stderr: sanitizeDiagnostic(stderr.value()),
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
          exitCode,
          signal: exitSignal,
          infrastructureStatus: finalInfrastructure,
          timedOut: timeout,
          cancelled,
          startedAt,
          finishedAt: clock(),
        });
      });
    });
  });
}

function boundedEnvironment(policy: ValidationEnvironmentPolicyV2): NodeJS.ProcessEnv {
  validateValidationEnvironmentPolicyV2(policy);
  const result: NodeJS.ProcessEnv = {};
  for (const key of policy.inheritedKeys) {
    const value = process.env[key];
    if (value !== undefined && value.length <= 1024 && !value.includes("\0")) result[key] = value;
  }
  for (const [key, value] of Object.entries(policy.explicit)) result[key] = value;
  return result;
}

function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (!pid) return;
  try {
    // detached:true makes the child a process-group leader on POSIX; a
    // negative pid asks the kernel to terminate descendants as one group.
    process.kill(-pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* the process may already be gone */ }
  }
}

function processGroupAlive(pid: number): boolean {
  if (process.platform === "win32") return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    // EPERM means the group exists but is not signalable by this process;
    // that is still non-quiescent and must fail closed.
    return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForProcessGroupQuiescence(pid: number, graceMs: number): Promise<void> {
  const deadline = Date.now() + Math.max(10, graceMs);
  while (processGroupAlive(pid) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function boundedStream(maxBytes: number): { readonly push: (chunk: Buffer | string) => void; readonly value: () => string; readonly truncated: boolean } {
  let bytes = Buffer.alloc(0);
  let wasTruncated = false;
  return {
    push(chunk) {
      const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (bytes.length >= maxBytes) { wasTruncated = true; return; }
      const remaining = maxBytes - bytes.length;
      if (incoming.length > remaining) wasTruncated = true;
      bytes = Buffer.concat([bytes, incoming.subarray(0, remaining)]);
    },
    value: () => bytes.toString("utf8"),
    get truncated() { return wasTruncated; },
  };
}

function sanitizeDiagnostic(value: string): string {
  const redacted = value
    .replace(/bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/gi, "[REDACTED_PRIVATE_KEY]")
    .replace(/(api[_-]?key|password|passwd|secret|token)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");
  try { assertNoCredentialMaterial(redacted, "D_VALIDATION_DIAGNOSTIC_UNSAFE"); }
  catch (error) {
    if (error instanceof RalphCredentialSafetyError) return "[REDACTED_DIAGNOSTIC]";
    throw new RalphValidationProcessError("D_VALIDATION_DIAGNOSTIC_UNSAFE", "D_VALIDATION_DIAGNOSTIC_UNSAFE", error);
  }
  return redacted.length > 4_096 ? `${redacted.slice(0, 4_096)}…` : redacted;
}

function protocolFailure(clock: () => string): ValidationProcessResultV2 {
  return processFailure("RUNNER_PROTOCOL_FAILURE", clock(), clock());
}

function processFailure(status: ValidationProcessInfrastructureStatusV2, startedAt: string, finishedAt: string): ValidationProcessResultV2 {
  return { stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false, exitCode: null, signal: null, infrastructureStatus: status, timedOut: status === "TIMEOUT", cancelled: status === "CANCELLED", startedAt, finishedAt };
}

function cancelledResult(clock: () => string): ValidationProcessResultV2 {
  const now = clock();
  return processFailure("CANCELLED", now, now);
}

function assertShellExecutable(value: unknown): asserts value is string {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0") || !["/bin/sh", "/bin/bash", "/usr/bin/sh", "/usr/bin/bash"].includes(value)) {
    throw new RalphValidationProcessError("D_VALIDATION_PROCESS_POLICY_INVALID", "D_VALIDATION_PROCESS_POLICY_INVALID: only an explicit POSIX shell is allowed");
  }
}

function assertSafeToken(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || !/^[A-Za-z0-9._:-]+$/.test(value)) throw new RalphValidationProcessError("D_VALIDATION_PROCESS_POLICY_INVALID", "D_VALIDATION_PROCESS_POLICY_INVALID: unsafe policy identity");
}

function isSecretEnvironmentKey(value: string): boolean {
  return /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|COOKIE)/i.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
