import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, open, readlink, readdir, realpath, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { sha256Canonical } from "./hashing.js";
import { revalidateQualifiedNodeNpmRuntimeV1, type QualifiedNodeNpmRuntimeV1 } from "./node-npm-runtime.js";

export const RALPH_LINUX_VALIDATION_SANDBOX_PATH_V1 = "/usr/bin/bwrap" as const;
export const RALPH_VALIDATION_SANDBOX_WORKSPACE_V1 = "/workspace" as const;
export const RALPH_VALIDATION_SANDBOX_RUNTIME_ROOT_V1 = "/opt/rb-node" as const;
const RALPH_VALIDATION_SANDBOX_BIN_ROOT_V1 = "/opt/rb-validation-bin" as const;
const RALPH_VALIDATION_SANDBOX_AMBIENT_NPM_V1 = "/usr/bin/npm" as const;
const CORE_NPM_WRAPPER_SOURCE_V1 = "#!/bin/sh\nexec /opt/rb-node/bin/node /opt/rb-node/lib/node_modules/npm/bin/npm-cli.js \"$@\"\n";

export class RalphLinuxValidationSandboxErrorV1 extends Error {
  constructor(readonly code: "D_VALIDATION_SANDBOX_UNAVAILABLE" | "D_VALIDATION_SANDBOX_POLICY_INVALID", readonly cause?: unknown) {
    super(code);
    this.name = "RalphLinuxValidationSandboxErrorV1";
  }
}

export interface ValidationSandboxWritableMountV1 {
  readonly source: string;
  readonly destination: string;
}

export interface LinuxValidationSandboxLaunchV1 {
  readonly executable: typeof RALPH_LINUX_VALIDATION_SANDBOX_PATH_V1;
  readonly argv: readonly string[];
  readonly backendIdentityDigest: string;
}

export async function prepareLinuxValidationSandboxLaunchV1(input: {
  readonly workspaceRoot: string;
  readonly shellExecutable: string;
  readonly shellArgs: readonly string[];
  readonly command: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly runtime: QualifiedNodeNpmRuntimeV1;
  readonly writableMounts?: readonly ValidationSandboxWritableMountV1[];
}): Promise<LinuxValidationSandboxLaunchV1> {
  const sandboxBackendIdentityDigest = await inspectValidationSandboxBackendV1();
  await revalidateQualifiedNodeNpmRuntimeV1(input.runtime);
  const workspace = await requireRealDirectory(input.workspaceRoot, "D_VALIDATION_SANDBOX_POLICY_INVALID");
  if (!["/bin/sh", "/bin/bash", "/usr/bin/sh", "/usr/bin/bash"].includes(input.shellExecutable)
    || input.shellArgs.length !== 1 || input.shellArgs[0] !== "-c") {
    throw new RalphLinuxValidationSandboxErrorV1("D_VALIDATION_SANDBOX_POLICY_INVALID");
  }
  const mounts = await validateWritableMounts(workspace, input.writableMounts ?? []);
  const runtimeRoot = await requireRealDirectory(input.runtime.runtimeRoot, "D_VALIDATION_SANDBOX_POLICY_INVALID");
  if (runtimeRoot === workspace || runtimeRoot.startsWith(`${workspace}${sep}`)) throw new RalphLinuxValidationSandboxErrorV1("D_VALIDATION_SANDBOX_POLICY_INVALID");
  const npmWrapper = await prepareCoreOwnedNpmWrapperV1(workspace);
  const backendIdentityDigest = sha256Canonical({ sandboxBackendIdentityDigest, npmWrapperIdentityDigest: npmWrapper.identityDigest });

  const argv: string[] = [
    "--die-with-parent", "--unshare-all", "--new-session", "--cap-drop", "ALL", "--clearenv",
    "--ro-bind", "/usr", "/usr",
    "--symlink", "usr/bin", "/bin",
    "--symlink", "usr/lib", "/lib",
    "--symlink", "usr/lib64", "/lib64",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    "--dir", "/tmp/rb-validation-home",
    "--dir", "/opt",
    "--dir", RALPH_VALIDATION_SANDBOX_RUNTIME_ROOT_V1,
  ];
  argv.push("--ro-bind", runtimeRoot, RALPH_VALIDATION_SANDBOX_RUNTIME_ROOT_V1);
  argv.push("--ro-bind", npmWrapper.root, RALPH_VALIDATION_SANDBOX_BIN_ROOT_V1);
  // A package script may replace PATH entirely. Overlay the ambient host npm
  // entry with the same Core wrapper so it can never select /usr/bin/npm's
  // host Node/npm pair, even when /usr/bin is placed first.
  argv.push("--ro-bind", npmWrapper.path, RALPH_VALIDATION_SANDBOX_AMBIENT_NPM_V1);
  argv.push("--dir", RALPH_VALIDATION_SANDBOX_WORKSPACE_V1);
  argv.push("--bind", workspace, RALPH_VALIDATION_SANDBOX_WORKSPACE_V1);
  for (const mount of mounts) argv.push("--bind", mount.source, `${RALPH_VALIDATION_SANDBOX_WORKSPACE_V1}/node_modules`);
  for (const controlPath of [".rb", ".rb-harness", ".git"] as const) {
    const absolute = resolve(workspace, controlPath);
    const stats = await lstat(absolute);
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (!stats.isDirectory() || stats.isSymbolicLink() || await realpath(absolute) !== absolute
      || (stats.mode & 0o777) !== 0o700 || (uid !== undefined && stats.uid !== uid)
      || (await readdir(absolute)).length !== 0) {
      throw new RalphLinuxValidationSandboxErrorV1("D_VALIDATION_SANDBOX_POLICY_INVALID");
    }
    const destination = `${RALPH_VALIDATION_SANDBOX_WORKSPACE_V1}/${controlPath}`;
    argv.push("--tmpfs", destination, "--remount-ro", destination);
  }
  const environment = validationSandboxEnvironment(input.environment, mounts.length === 1 ? `${RALPH_VALIDATION_SANDBOX_WORKSPACE_V1}/node_modules/.bin` : undefined);
  for (const [key, value] of Object.entries(environment).sort(([left], [right]) => left.localeCompare(right))) argv.push("--setenv", key, value);
  argv.push("--chdir", RALPH_VALIDATION_SANDBOX_WORKSPACE_V1, "--", input.shellExecutable, ...input.shellArgs, input.command);
  return Object.freeze({ executable: RALPH_LINUX_VALIDATION_SANDBOX_PATH_V1, argv: Object.freeze(argv), backendIdentityDigest });
}

export async function inspectValidationSandboxBackendV1(): Promise<string> {
  try {
    if (process.platform !== "linux") throw new Error("platform");
    const path = RALPH_LINUX_VALIDATION_SANDBOX_PATH_V1;
    const stats = await lstat(path, { bigint: true });
    if (!stats.isFile() || stats.isSymbolicLink() || await realpath(path) !== path || stats.uid !== 0n || (Number(stats.mode) & 0o022) !== 0) throw new Error("identity");
    await access(path, constants.X_OK);
    return sha256Canonical({
      path,
      dev: stats.dev.toString(),
      ino: stats.ino.toString(),
      mode: Number(stats.mode),
      uid: stats.uid.toString(),
      gid: stats.gid.toString(),
      size: stats.size.toString(),
      mtimeNs: stats.mtimeNs.toString(),
    });
  } catch (error) {
    if (error instanceof RalphLinuxValidationSandboxErrorV1) throw error;
    throw new RalphLinuxValidationSandboxErrorV1("D_VALIDATION_SANDBOX_UNAVAILABLE", error);
  }
}

function validationSandboxEnvironment(input: Readonly<Record<string, string>>, localBinRoot?: string): Readonly<Record<string, string>> {
  const allowed = new Set(["CI", "LANG", "LC_ALL", "PATH"]);
  const result: Record<string, string> = {
    HOME: "/tmp/rb-validation-home",
    TMPDIR: "/tmp",
    PATH: `${RALPH_VALIDATION_SANDBOX_BIN_ROOT_V1}${localBinRoot ? `:${localBinRoot}` : ""}:/usr/bin:/bin`,
  };
  for (const [key, value] of Object.entries(input)) {
    if (!allowed.has(key)) continue;
    if (key === "PATH") continue;
    if (typeof value !== "string" || value.length > 1_024 || value.includes("\0")) throw new RalphLinuxValidationSandboxErrorV1("D_VALIDATION_SANDBOX_POLICY_INVALID");
    result[key] = value;
  }
  return Object.freeze(result);
}

async function prepareCoreOwnedNpmWrapperV1(workspace: string): Promise<{ readonly root: string; readonly path: string; readonly identityDigest: string }> {
  try {
    const sessionRoot = dirname(workspace);
    if (resolve(sessionRoot, "projection") !== workspace) throw new Error("projection structure");
    await requireCoreOwnedDirectory(sessionRoot);
    const wrapperRoot = join(sessionRoot, "validation-runtime-bin");
    try { await mkdir(wrapperRoot, { mode: 0o700 }); }
    catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
    await requireCoreOwnedDirectory(wrapperRoot);

    const nodePath = join(wrapperRoot, "node");
    try { await symlink(`${RALPH_VALIDATION_SANDBOX_RUNTIME_ROOT_V1}/bin/node`, nodePath); }
    catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
    const nodeStats = await lstat(nodePath);
    if (!nodeStats.isSymbolicLink() || await readlink(nodePath, "utf8") !== `${RALPH_VALIDATION_SANDBOX_RUNTIME_ROOT_V1}/bin/node`) {
      throw new Error("node shim identity");
    }

    const wrapperPath = join(wrapperRoot, "npm");
    let created = false;
    try {
      const handle = await open(wrapperPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o500);
      try {
        await handle.writeFile(CORE_NPM_WRAPPER_SOURCE_V1, "utf8");
        await handle.sync();
      } finally { await handle.close(); }
      created = true;
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
    }
    if (created) await chmod(wrapperPath, 0o500);

    const handle = await open(wrapperPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      const bytes = await handle.readFile({ encoding: "utf8" });
      const after = await handle.stat();
      const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
      if (!before.isFile() || before.isSymbolicLink() || (before.mode & 0o777) !== 0o500
        || (uid !== undefined && before.uid !== uid) || bytes !== CORE_NPM_WRAPPER_SOURCE_V1
        || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
        || await realpath(wrapperPath) !== wrapperPath) throw new Error("wrapper identity");
      return Object.freeze({
        root: wrapperRoot,
        path: wrapperPath,
        identityDigest: sha256Canonical({
          schema: "rb-harness-validation-npm-wrapper/v1",
          source: CORE_NPM_WRAPPER_SOURCE_V1,
          nodeTarget: `${RALPH_VALIDATION_SANDBOX_RUNTIME_ROOT_V1}/bin/node`,
          mode: before.mode & 0o777,
          uid: before.uid,
        }),
      });
    } finally { await handle.close(); }
  } catch (error) {
    if (error instanceof RalphLinuxValidationSandboxErrorV1) throw error;
    throw new RalphLinuxValidationSandboxErrorV1("D_VALIDATION_SANDBOX_POLICY_INVALID", error);
  }
}

async function requireCoreOwnedDirectory(path: string): Promise<void> {
  const stats = await lstat(path);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!stats.isDirectory() || stats.isSymbolicLink() || await realpath(path) !== path
    || (stats.mode & 0o777) !== 0o700 || (uid !== undefined && stats.uid !== uid)) throw new Error("Core-owned directory");
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function validateWritableMounts(workspace: string, values: readonly ValidationSandboxWritableMountV1[]): Promise<readonly ValidationSandboxWritableMountV1[]> {
  if (values.length > 1) throw new RalphLinuxValidationSandboxErrorV1("D_VALIDATION_SANDBOX_POLICY_INVALID");
  const result: ValidationSandboxWritableMountV1[] = [];
  for (const value of values) {
    const source = await requireRealDirectory(value.source, "D_VALIDATION_SANDBOX_POLICY_INVALID");
    const destination = await requireRealDirectory(value.destination, "D_VALIDATION_SANDBOX_POLICY_INVALID");
    if (destination !== resolve(workspace, "node_modules") || source === workspace || source.startsWith(`${workspace}${sep}`) || workspace.startsWith(`${source}${sep}`)) {
      throw new RalphLinuxValidationSandboxErrorV1("D_VALIDATION_SANDBOX_POLICY_INVALID");
    }
    result.push(Object.freeze({ source, destination }));
  }
  return Object.freeze(result);
}

async function requireRealDirectory(path: string, code: "D_VALIDATION_SANDBOX_POLICY_INVALID"): Promise<string> {
  if (!isAbsolute(path) || resolve(path) !== path || path.includes("\0")) throw new RalphLinuxValidationSandboxErrorV1(code);
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink() || await realpath(path) !== path) throw new RalphLinuxValidationSandboxErrorV1(code);
  return path;
}
