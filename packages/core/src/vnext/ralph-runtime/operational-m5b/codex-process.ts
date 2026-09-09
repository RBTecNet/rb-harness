import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { spawnProcessTree, type SettleOutcome } from "../../../process-tree.js";
import {
  LinuxProcessIdentityProvider,
  type ProcessIdentity,
} from "../operational-b2/process-identity.js";
import {
  CODEX_CLI_EXECUTOR_CLI_VERSION_V2,
  CODEX_CLI_EXECUTOR_REASONING_EFFORT_V2,
  CODEX_CLI_EXECUTOR_REQUESTED_MODEL_V2,
  CODEX_CLI_NATIVE_EXECUTABLE_PATH_V2,
  CODEX_CLI_NATIVE_EXECUTABLE_SHA256_V2,
  CODEX_CLI_NATIVE_EXECUTABLE_SIZE_BYTES_V2,
  M5B_LIMITS_V2,
} from "./contract.js";
import { RalphM5BError } from "./contract-errors.js";
import {
  assertCodexManagedExecutablePathV2,
  assertCodexManagedRuntimeV2,
  codexManagedRuntimeDirectoryV2,
  type CodexManagedRuntimeIdentityV2,
} from "./codex-managed-runtime.js";
import {
  CODEX_PERMISSION_PROFILE_NAME_V2,
  assertCodexPermissionProfileV2,
  codexPermissionProfileOverridesV2,
  type CodexPermissionProfileV2,
} from "./codex-permission-profile.js";
import { CODEX_PARENT_PATH_V2 } from "./codex-sandbox-backend.js";

/**
 * The directory the sandbox must be able to read so a model-spawned command
 * can start at all: Codex re-execs the pinned binary as its own arg0 helper
 * from the vendor tree that also holds `codex-resources`.  Derived from the
 * single pinned executable path so it can never drift away from it.
 */
export function codexRuntimeReadRootV2(executablePath: string = CODEX_CLI_NATIVE_EXECUTABLE_PATH_V2): string {
  if (!isAbsolute(executablePath) || resolve(executablePath) !== executablePath) {
    throw new RalphM5BError("M5B_EXECUTABLE_IDENTITY_INVALID", "M5B_EXECUTABLE_IDENTITY_INVALID: runtime read root");
  }
  const root = resolve(executablePath, "..", "..");
  // For the managed runtime this is the version directory itself, which holds
  // `bin/`, `codex-resources/` and `codex-path/` — the tree Codex re-execs
  // and resolves its helpers from.
  if (executablePath === CODEX_CLI_NATIVE_EXECUTABLE_PATH_V2 && root !== codexManagedRuntimeDirectoryV2()) {
    throw new RalphM5BError("M5B_MANAGED_RUNTIME_INVALID", "M5B_MANAGED_RUNTIME_INVALID: the runtime read root is not the managed runtime directory");
  }
  return root;
}

/** Exact physical identity of the stock native Codex executable. */
export interface CodexExecutableIdentityV2 {
  readonly executablePath: string;
  readonly executableVersion: string;
  readonly executableSizeBytes: number;
  readonly executableSha256: string;
}

export const codexProcessIdentityProvider = new LinuxProcessIdentityProvider();

/**
 * Environment for the Codex PARENT process only.
 *
 * Nothing is inherited: the parent receives exactly three variables.  PATH is
 * pinned to the proven minimal value because Codex resolves `bwrap` through
 * it — M5-B.1 showed that an absent PATH makes Codex silently select its
 * bundled bwrap, which AppArmor then denies, killing every provider command
 * before it runs.  HOME is required by the Codex parent itself, and
 * CODEX_HOME is a path to the already-authenticated Codex home, never a
 * credential value.  Token-bearing variables are refused outright.
 */
export const CODEX_PARENT_ENVIRONMENT_KEYS_V2: readonly string[] = Object.freeze(["CODEX_HOME", "HOME", "PATH"]);

/** Never copied into a child value or an artifact, under any circumstance. */
export const CODEX_FORBIDDEN_ENVIRONMENT_KEYS_V2: readonly string[] = Object.freeze([
  "OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "OPENAI_ACCESS_TOKEN",
  "OPENAI_REFRESH_TOKEN", "CODEX_REFRESH_TOKEN", "OPENAI_ID_TOKEN", "CODEX_ID_TOKEN",
  "OPENAI_IDENTITY_TOKEN_FILE", "ANTHROPIC_API_KEY",
]);

const FORBIDDEN_ENVIRONMENT_PATTERN = /(?:^|_)(?:API_?KEY|ACCESS_?TOKEN|REFRESH_?TOKEN|ID_?TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)(?:$|_)/i;

export function codexParentEnvironmentV2(codexHome: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!isAbsolute(codexHome) || resolve(codexHome) !== codexHome) throw new RalphM5BError("M5B_CHILD_ENVIRONMENT_INVALID", "M5B_CHILD_ENVIRONMENT_INVALID: CODEX_HOME must be an absolute path");
  const home = source.HOME;
  if (typeof home !== "string" || !isAbsolute(home) || resolve(home) !== home) {
    throw new RalphM5BError("M5B_CHILD_ENVIRONMENT_INVALID", "M5B_CHILD_ENVIRONMENT_INVALID: HOME must be an absolute path");
  }
  const environment: NodeJS.ProcessEnv = Object.freeze({
    PATH: CODEX_PARENT_PATH_V2,
    HOME: home,
    CODEX_HOME: codexHome,
  });
  assertNoForbiddenEnvironmentV2(environment);
  assertCodexParentEnvironmentPolicyV2(environment);
  return environment;
}

/**
 * The parent environment is a closed set: an extra inherited variable, a
 * widened PATH or a missing CODEX_HOME are all refused before dispatch.
 */
export function assertCodexParentEnvironmentPolicyV2(environment: NodeJS.ProcessEnv): void {
  const keys = Object.keys(environment).sort();
  if (keys.length !== CODEX_PARENT_ENVIRONMENT_KEYS_V2.length || keys.some((key, index) => key !== CODEX_PARENT_ENVIRONMENT_KEYS_V2[index])) {
    throw new RalphM5BError("M5B_CHILD_ENVIRONMENT_INVALID", `M5B_CHILD_ENVIRONMENT_INVALID: parent environment must be exactly ${CODEX_PARENT_ENVIRONMENT_KEYS_V2.join(",")}`);
  }
  if (environment.PATH !== CODEX_PARENT_PATH_V2) {
    throw new RalphM5BError("M5B_CHILD_ENVIRONMENT_INVALID", `M5B_CHILD_ENVIRONMENT_INVALID: parent PATH must be exactly ${CODEX_PARENT_PATH_V2}`);
  }
}

export function assertNoForbiddenEnvironmentV2(environment: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(environment)) {
    if (CODEX_FORBIDDEN_ENVIRONMENT_KEYS_V2.includes(key) || FORBIDDEN_ENVIRONMENT_PATTERN.test(key)) {
      throw new RalphM5BError("M5B_CHILD_ENVIRONMENT_INVALID", `M5B_CHILD_ENVIRONMENT_INVALID: ${key}`);
    }
  }
}

/**
 * Environment exposed to MODEL-SPAWNED commands.  This is a different
 * boundary from the parent's: stock `shell_environment_policy` inherits
 * nothing and receives only the explicit safe variables a command needs.
 * CODEX_HOME is deliberately absent.
 */
export function codexShellEnvironmentPolicyV2(): Readonly<Record<string, string>> {
  return Object.freeze({ PATH: CODEX_PARENT_PATH_V2 });
}

/**
 * The model-command environment is a closed set too.  CODEX_HOME, HOME and
 * every token-bearing name are refused here, so a widened shell policy fails
 * before dispatch rather than leaking a path to the credential store.
 */
export function assertCodexShellEnvironmentPolicyV2(set: Readonly<Record<string, string>>): void {
  const keys = Object.keys(set).sort();
  if (keys.length !== 1 || keys[0] !== "PATH") {
    throw new RalphM5BError("M5B_CHILD_ENVIRONMENT_INVALID", "M5B_CHILD_ENVIRONMENT_INVALID: the model command environment must set exactly PATH");
  }
  if (set.PATH !== CODEX_PARENT_PATH_V2) {
    throw new RalphM5BError("M5B_CHILD_ENVIRONMENT_INVALID", `M5B_CHILD_ENVIRONMENT_INVALID: model command PATH must be exactly ${CODEX_PARENT_PATH_V2}`);
  }
  assertNoForbiddenEnvironmentV2(set);
}

export function codexShellEnvironmentPolicyOverridesV2(): readonly string[] {
  const set = codexShellEnvironmentPolicyV2();
  assertCodexShellEnvironmentPolicyV2(set);
  return Object.freeze([
    `shell_environment_policy.inherit="none"`,
    `shell_environment_policy.ignore_default_excludes=false`,
    ...Object.entries(set).map(([key, value]) => `shell_environment_policy.set.${key}=${JSON.stringify(value)}`),
  ]);
}

/**
 * Argv tokens that must never appear in an M5-B invocation.
 *
 * `--sandbox` is forbidden outright: M5-B binds a named `default_permissions`
 * profile, and the legacy sandbox is a distinct system whose
 * `workspace-write` mode grants full-disk read — the exact hole M5-B.1 was
 * opened to close.  `--strict-config` is forbidden because M5-B.1 proved it
 * silently accepts unknown fields inside a permission profile; allowing it
 * here would invite it to be read as a security proof it cannot provide.
 */
export const CODEX_FORBIDDEN_ARGV_TOKENS_V2: readonly string[] = Object.freeze([
  "resume", "fork", "review", "--last", "--search", "--add-dir", "--oss", "--local-provider",
  "--profile", "-p", "--approve-for-me", "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-bypass-hook-trust", "danger-full-access", "--enable", "--disable",
  "--permission-profile", "--sandbox-state-json", "--image", "-i", "--thread-source",
  "--sandbox", "-s", "--full-auto", "--strict-config",
]);

export interface CodexExecArgvInputV2 {
  readonly stagingWorkspace: string;
  readonly outputSchemaPath: string;
  readonly finalOutputPath: string;
  /** The typed, sealed permission profile this invocation must select. */
  readonly permissionProfile: CodexPermissionProfileV2;
}

/**
 * The complete, deterministic argv.  There is no caller-supplied argv seam:
 * everything is derived from the typed input and the frozen profile.
 */
export function buildCodexExecArgvV2(input: CodexExecArgvInputV2): readonly string[] {
  for (const path of [input.stagingWorkspace, input.outputSchemaPath, input.finalOutputPath]) {
    if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) throw new RalphM5BError("M5B_ARGV_POLICY_INVALID", "M5B_ARGV_POLICY_INVALID: argv paths must be absolute and normalized");
  }
  assertCodexPermissionProfileV2(input.permissionProfile);
  const argv = Object.freeze([
    "exec",
    "--cd", input.stagingWorkspace,
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--ephemeral",
    "--color", "never",
    "--model", CODEX_CLI_EXECUTOR_REQUESTED_MODEL_V2,
    "-c", `model_reasoning_effort="${CODEX_CLI_EXECUTOR_REASONING_EFFORT_V2}"`,
    ...codexPermissionProfileOverridesV2(input.permissionProfile).flatMap((override) => ["-c", override]),
    ...codexShellEnvironmentPolicyOverridesV2().flatMap((override) => ["-c", override]),
    "--output-schema", input.outputSchemaPath,
    "-o", input.finalOutputPath,
    "--json",
    "-",
  ]);
  assertCodexArgvPolicyV2(argv, input.permissionProfile);
  return argv;
}

/**
 * The argv is the physical boundary selection.  It must select the exact
 * named permission profile and must carry no legacy sandbox flag at all.
 */
export function assertCodexArgvPolicyV2(argv: readonly string[], permissionProfile?: CodexPermissionProfileV2): void {
  if (argv[0] !== "exec") throw new RalphM5BError("M5B_ARGV_POLICY_INVALID", "M5B_ARGV_POLICY_INVALID: only `codex exec` is permitted");
  if (argv[argv.length - 1] !== "-") throw new RalphM5BError("M5B_ARGV_POLICY_INVALID", "M5B_ARGV_POLICY_INVALID: the prompt must be read from stdin");
  for (const token of argv.slice(1)) {
    if (CODEX_FORBIDDEN_ARGV_TOKENS_V2.includes(token)) throw new RalphM5BError("M5B_ARGV_POLICY_INVALID", `M5B_ARGV_POLICY_INVALID: ${token}`);
  }
  for (const required of ["--ignore-user-config", "--ignore-rules", "--ephemeral", "--json", "--skip-git-repo-check"]) {
    if (!argv.includes(required)) throw new RalphM5BError("M5B_ARGV_POLICY_INVALID", `M5B_ARGV_POLICY_INVALID: missing ${required}`);
  }
  const model = argv.indexOf("--model");
  if (model < 0 || argv[model + 1] !== CODEX_CLI_EXECUTOR_REQUESTED_MODEL_V2) throw new RalphM5BError("M5B_ARGV_POLICY_INVALID", "M5B_ARGV_POLICY_INVALID: model");

  const overrides = argv.reduce<string[]>((accumulated, token, index) => {
    if (token === "-c" && typeof argv[index + 1] === "string") accumulated.push(argv[index + 1]!);
    return accumulated;
  }, []);
  const profileName = permissionProfile?.name ?? CODEX_PERMISSION_PROFILE_NAME_V2;
  if (!overrides.includes(`default_permissions="${profileName}"`)) {
    throw new RalphM5BError("M5B_ARGV_POLICY_INVALID", `M5B_ARGV_POLICY_INVALID: missing default_permissions="${profileName}"`);
  }
  if (!overrides.some((override) => override.startsWith(`permissions.${profileName}=`))) {
    throw new RalphM5BError("M5B_ARGV_POLICY_INVALID", `M5B_ARGV_POLICY_INVALID: the ${profileName} profile definition is not supplied on the command line`);
  }
  if (!overrides.includes(`shell_environment_policy.inherit="none"`)) {
    throw new RalphM5BError("M5B_ARGV_POLICY_INVALID", "M5B_ARGV_POLICY_INVALID: the model command environment must inherit nothing");
  }
  if (overrides.some((override) => /(^|\.)sandbox_mode\s*=/.test(override) || override.startsWith("sandbox_workspace_write"))) {
    throw new RalphM5BError("M5B_ARGV_POLICY_INVALID", "M5B_ARGV_POLICY_INVALID: legacy sandbox configuration is forbidden");
  }
  if (permissionProfile) {
    assertCodexPermissionProfileV2(permissionProfile);
    for (const override of codexPermissionProfileOverridesV2(permissionProfile)) {
      if (!overrides.includes(override)) throw new RalphM5BError("M5B_ARGV_POLICY_INVALID", "M5B_ARGV_POLICY_INVALID: the argv does not carry the sealed permission profile");
    }
  }
}

/** Bounded, credential-free typed facts describing the exact invocation. */
export function codexArgvPolicyFactsV2(argv: readonly string[], permissionProfile?: CodexPermissionProfileV2): Readonly<Record<string, string>> {
  return Object.freeze({
    subcommand: "exec",
    legacySandbox: "absent",
    permissionProfileName: permissionProfile?.name ?? CODEX_PERMISSION_PROFILE_NAME_V2,
    permissionProfileDigest: permissionProfile?.profileDigest ?? "",
    ignoreUserConfig: "true",
    ignoreRules: "true",
    ephemeral: "true",
    json: "true",
    color: "never",
    requestedModel: CODEX_CLI_EXECUTOR_REQUESTED_MODEL_V2,
    reasoningEffort: CODEX_CLI_EXECUTOR_REASONING_EFFORT_V2,
    stdinPrompt: "true",
    argvTokenCount: String(argv.length),
  });
}

/** The exact identity a stock Codex executable must present. */
export interface CodexExecutablePinV2 {
  readonly executablePath: string;
  readonly executableVersion: string;
  readonly executableSizeBytes: number;
  readonly executableSha256: string;
}

export const CODEX_STOCK_EXECUTABLE_PIN_V2: CodexExecutablePinV2 = Object.freeze({
  executablePath: CODEX_CLI_NATIVE_EXECUTABLE_PATH_V2,
  executableVersion: CODEX_CLI_EXECUTOR_CLI_VERSION_V2,
  executableSizeBytes: CODEX_CLI_NATIVE_EXECUTABLE_SIZE_BYTES_V2,
  executableSha256: CODEX_CLI_NATIVE_EXECUTABLE_SHA256_V2,
});

/**
 * Verify the exact stock native executable.  Bare names, launcher scripts,
 * symlinks and any digest/size/version drift fail before dispatch.  The pin
 * is a parameter only so a permanent test can prove the check actually
 * rejects a drifted identity; production always uses the frozen pin.
 *
 * The pinned path is the HARNESS-MANAGED runtime.  `codex` on PATH, an nvm
 * global package path and `/usr/local/bin/codex` are refused here by
 * identity, so a global Codex upgrade cannot reach a frozen Executor.
 */
export async function inspectExactCodexCliExecutableV2(
  deadlineMs: number,
  pin: CodexExecutablePinV2 = CODEX_STOCK_EXECUTABLE_PIN_V2,
): Promise<CodexExecutableIdentityV2> {
  if (process.platform !== "linux") throw new RalphM5BError("M5B_EXECUTABLE_IDENTITY_INVALID", "M5B_EXECUTABLE_IDENTITY_INVALID: unsupported platform");
  const path = pin.executablePath;
  if (pin === CODEX_STOCK_EXECUTABLE_PIN_V2) assertCodexManagedExecutablePathV2(path);
  if (!isAbsolute(path) || resolve(path) !== path || path.endsWith(".js")) throw new RalphM5BError("M5B_EXECUTABLE_IDENTITY_INVALID", "M5B_EXECUTABLE_IDENTITY_INVALID: path");
  let stats;
  try { stats = await lstat(path); }
  catch (error) { throw new RalphM5BError("M5B_EXECUTABLE_IDENTITY_INVALID", "M5B_EXECUTABLE_IDENTITY_INVALID: unreadable", error); }
  if (stats.isSymbolicLink() || !stats.isFile()) throw new RalphM5BError("M5B_EXECUTABLE_IDENTITY_INVALID", "M5B_EXECUTABLE_IDENTITY_INVALID: not a regular native file");
  if (stats.size !== pin.executableSizeBytes) throw new RalphM5BError("M5B_EXECUTABLE_IDENTITY_INVALID", "M5B_EXECUTABLE_IDENTITY_INVALID: size");
  const digest = await sha256File(path);
  if (digest !== pin.executableSha256) throw new RalphM5BError("M5B_EXECUTABLE_IDENTITY_INVALID", "M5B_EXECUTABLE_IDENTITY_INVALID: digest");
  // The version probe also proves the process-tree containment wrapper still
  // `exec`s the pinned binary in place, so a later exit code belongs to Codex
  // and never to a wrapper shell.
  const probe = await runCodexProcessV2({
    executablePath: path,
    argv: ["--version"],
    cwd: resolve(process.cwd()),
    environment: codexParentEnvironmentV2(resolveCodexHomeV2()),
    stdin: "",
    deadlineMs,
  });
  const version = probe.stdout.trim().match(/^codex-cli\s+(\d+\.\d+\.\d+)$/)?.[1];
  if (probe.exitCode !== 0 || probe.signal !== null || probe.timedOut || !probe.settlement.quiescent || version !== pin.executableVersion) {
    throw new RalphM5BError("M5B_EXECUTABLE_IDENTITY_INVALID", "M5B_EXECUTABLE_IDENTITY_INVALID: version");
  }
  return Object.freeze({
    executablePath: path,
    executableVersion: pin.executableVersion,
    executableSizeBytes: pin.executableSizeBytes,
    executableSha256: pin.executableSha256,
  });
}

export interface CodexRuntimeInspectionV2 {
  readonly executable: CodexExecutableIdentityV2;
  readonly managedRuntime: CodexManagedRuntimeIdentityV2;
}

/**
 * The single runtime resolution an Executor may use.
 *
 * Two independent checks must agree: the managed-runtime authority verifies
 * the whole installed tree — every payload file's size and SHA-256, no extra
 * files, and the exact `--version` — and the M5-B pin re-verifies the
 * executable itself through the contained process-tree spawn, which also
 * proves the containment wrapper still `exec`s the binary in place.
 */
export async function inspectManagedCodexRuntimeV2(deadlineMs: number): Promise<CodexRuntimeInspectionV2> {
  const managedRuntime = await assertCodexManagedRuntimeV2({ probeTimeoutMs: deadlineMs });
  const executable = await inspectExactCodexCliExecutableV2(deadlineMs);
  if (executable.executablePath !== managedRuntime.executablePath
    || executable.executableSizeBytes !== managedRuntime.executableSizeBytes
    || executable.executableSha256.replace(/^sha256:/, "") !== managedRuntime.executableSha256) {
    throw new RalphM5BError("M5B_MANAGED_RUNTIME_INVALID", "M5B_MANAGED_RUNTIME_INVALID: the pinned executable is not the managed runtime executable");
  }
  return Object.freeze({ executable, managedRuntime });
}

export function resolveCodexHomeV2(source: NodeJS.ProcessEnv = process.env): string {
  const explicit = source.CODEX_HOME;
  if (explicit) {
    if (!isAbsolute(explicit) || resolve(explicit) !== explicit) throw new RalphM5BError("M5B_CHILD_ENVIRONMENT_INVALID", "M5B_CHILD_ENVIRONMENT_INVALID: CODEX_HOME");
    return explicit;
  }
  const home = source.HOME;
  if (!home || !isAbsolute(home)) throw new RalphM5BError("M5B_CHILD_ENVIRONMENT_INVALID", "M5B_CHILD_ENVIRONMENT_INVALID: HOME");
  return resolve(home, ".codex");
}

export interface CodexProcessRunInputV2 {
  readonly executablePath: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly stdin: string;
  readonly deadlineMs: number;
  /**
   * Invoked once the OS child exists and its identity has been read, before
   * any prompt byte is written.  A durable process receipt is persisted here.
   */
  readonly onSpawned?: (spawned: CodexProcessSpawnV2) => Promise<void>;
  readonly cancellation?: { cancelled: boolean };
  /**
   * Bounded stdout notifier used to bind the first public `thread.started`
   * while the provider run is still in flight.  It is transport plumbing
   * only: it never decides an outcome.
   */
  readonly onStdoutChunk?: (chunk: string) => void;
}

export interface CodexProcessSpawnV2 {
  readonly processIdentity: ProcessIdentity;
  readonly processGroupId: number;
  readonly containmentKind: string;
  readonly containmentStructural: boolean;
  readonly startedAt: string;
}

export interface CodexProcessRunV2 extends Omit<CodexProcessSpawnV2, "processIdentity"> {
  /** Null only when the child settled before its identity could be read. */
  readonly processIdentity: ProcessIdentity | null;
  readonly finishedAt: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly settlement: SettleOutcome;
}

/**
 * Spawn the native Codex binary as a supervised process group and capture the
 * ACTUAL child settlement.  The containment wrapper `exec`s the binary in
 * place, so the observed pid, exit code and signal belong to Codex itself.
 */
export async function runCodexProcessV2(input: CodexProcessRunInputV2): Promise<CodexProcessRunV2> {
  if (process.platform === "win32") throw new RalphM5BError("M5B_PROCESS_IDENTITY_INVALID", "M5B_PROCESS_IDENTITY_INVALID: unsupported platform");
  if (!Number.isSafeInteger(input.deadlineMs) || input.deadlineMs < 1) throw new RalphM5BError("M5B_TIMEOUT_POLICY_INVALID");
  if (resolve(input.cwd) !== input.cwd) throw new RalphM5BError("M5B_WORKSPACE_BINDING_INVALID", "M5B_WORKSPACE_BINDING_INVALID: cwd");
  assertNoForbiddenEnvironmentV2(input.environment);
  const handle = spawnProcessTree(input.executablePath, [...input.argv], {
    cwd: input.cwd,
    env: input.environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const startedAt = new Date().toISOString();

  // Output and settlement listeners are attached before anything is awaited:
  // a short-lived child can exit while the parent is still reading procfs,
  // and a lost stdout byte or a missed exit event would be an invented fact.
  let stdout = "";
  let stderr = "";
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stdoutTruncated = false;
  let stderrTruncated = false;
  handle.child.stdout?.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.byteLength;
    if (stdoutBytes > M5B_LIMITS_V2.eventStreamMaxBytes) { stdoutTruncated = true; handle.terminate("M5-B stdout limit"); return; }
    const text = chunk.toString("utf8");
    stdout += text;
    try { input.onStdoutChunk?.(text); } catch { /* transport plumbing never decides an outcome */ }
  });
  handle.child.stderr?.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.byteLength;
    if (stderrBytes > M5B_LIMITS_V2.stderrMaxBytes) { stderrTruncated = true; return; }
    stderr += chunk.toString("utf8");
  });
  const exited = new Promise<{ readonly exitCode: number | null; readonly signal: string | null }>((resolveExit) => {
    if (handle.child.exitCode !== null || handle.child.signalCode !== null) {
      resolveExit({ exitCode: handle.child.exitCode, signal: handle.child.signalCode ?? null });
      return;
    }
    handle.child.once("exit", (code, signal) => resolveExit({ exitCode: code, signal: signal ?? null }));
  });

  if (!handle.pid || handle.pid < 1) {
    handle.terminate("M5-B spawn failed");
    await handle.settle("M5-B spawn failed", input.deadlineMs);
    handle.dispose();
    throw new RalphM5BError("M5B_PROCESS_START_FAILED");
  }
  handle.sample();
  // A child that already settled cannot report a genuine identity. That is
  // recorded as absent, never fabricated; the dispatch path refuses it.
  let processIdentity: ProcessIdentity | null = null;
  try { processIdentity = await codexProcessIdentityProvider.identify(handle.pid); }
  catch { processIdentity = null; }

  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; handle.terminate("M5-B wall timeout"); }, input.deadlineMs);
  try {
    if (input.onSpawned) {
      if (!processIdentity) throw new RalphM5BError("M5B_PROCESS_IDENTITY_INVALID", "M5B_PROCESS_IDENTITY_INVALID: the provider child settled before its identity could be read");
      await input.onSpawned(Object.freeze({
        processIdentity,
        processGroupId: handle.pid,
        containmentKind: handle.containment.kind,
        containmentStructural: handle.containment.structural,
        startedAt,
      }));
    }
    await writeStdin(handle.child.stdin, input.stdin);
    const outcome = await exited;
    clearTimeout(timer);
    const settlement = await handle.settle("M5-B provider settled", input.deadlineMs);
    return Object.freeze({
      processIdentity,
      processGroupId: handle.pid,
      containmentKind: handle.containment.kind,
      containmentStructural: handle.containment.structural,
      startedAt,
      finishedAt: new Date().toISOString(),
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      timedOut,
      cancelled: input.cancellation?.cancelled === true,
      stdout,
      stderr,
      stdoutTruncated,
      stderrTruncated,
      settlement,
    });
  } catch (error) {
    clearTimeout(timer);
    handle.terminate("M5-B provider run failed");
    await handle.settle("M5-B provider run failed", input.deadlineMs);
    throw error;
  } finally {
    handle.dispose();
  }
}

async function writeStdin(stream: NodeJS.WritableStream | null, value: string): Promise<void> {
  if (!stream) throw new RalphM5BError("M5B_PROCESS_START_FAILED", "M5B_PROCESS_START_FAILED: stdin unavailable");
  await new Promise<void>((resolveWrite, rejectWrite) => {
    stream.on("error", rejectWrite);
    stream.end(value, () => resolveWrite());
  }).catch((error: unknown) => {
    // A provider that exits before consuming stdin is a physical outcome, not
    // a host failure; the exit code and the terminal event remain authority.
    if ((error as NodeJS.ErrnoException)?.code === "EPIPE") return;
    throw new RalphM5BError("M5B_PROCESS_START_FAILED", "M5B_PROCESS_START_FAILED: stdin", error);
  });
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolveHash, rejectHash) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", rejectHash);
    stream.on("end", () => resolveHash());
  });
  return `sha256:${hash.digest("hex")}`;
}
