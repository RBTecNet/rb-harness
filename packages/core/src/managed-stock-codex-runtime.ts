import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, cp, lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { spawn } from "node:child_process";

/**
 * Harness-managed STOCK Codex CLI runtime.
 *
 * This is deliberately a second, independent managed runtime alongside the
 * semantic `rb-codex` fork in `external-runtime-manifest.ts`.  It shares that
 * runtime's install conventions — the same `~/.local/libexec/rb-harness`
 * root, the same version-directory layout, the same size/SHA/identity
 * verification — and none of its semantics: there is no semantic mode, no
 * app-server transport and no patched binary.  `rb.1` is a pure
 * byte-for-byte pin of an already-qualified upstream stock release.
 *
 * The point of pinning is isolation.  A `npm i -g @openai/codex` upgrade
 * changes what `codex` on PATH resolves to; it must have no effect at all on
 * a frozen Harness provider runtime.  Nothing in this module ever consults
 * PATH, `npm`, nvm, `/usr/local/bin` or a "latest" channel.
 */
export const MANAGED_STOCK_CODEX_RUNTIME_KIND = "stock-codex-cli-managed" as const;

export interface ManagedStockCodexPayloadEntry {
  /** POSIX-relative path inside the version directory. */
  readonly relativePath: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly executable: boolean;
}

export interface ManagedStockCodexPlatform {
  readonly nodePlatform: NodeJS.Platform;
  readonly nodeArchitecture: string;
  readonly executableSizeBytes: number;
  readonly executableSha256: string;
  /**
   * Every regular file the qualified upstream runtime tree contains,
   * including the executable itself.  Codex re-execs its own binary as an
   * arg0 helper and resolves `codex-resources` and `codex-path` relative to
   * it, so the supporting tree is part of the runtime identity rather than
   * incidental packaging.
   */
  readonly payload: readonly ManagedStockCodexPayloadEntry[];
}

export interface ManagedStockCodexRuntime {
  readonly kind: typeof MANAGED_STOCK_CODEX_RUNTIME_KIND;
  readonly id: string;
  /** Exact upstream `codex-cli` release these bytes come from. */
  readonly upstreamVersion: string;
  /** Harness revision of the pin. `rb.1` patches nothing. */
  readonly rbRevision: string;
  /** Install directory name: `<upstreamVersion>-<rbRevision>`. */
  readonly version: string;
  readonly transport: "codex-exec";
  readonly installedRelativePath: string;
  /** Exact `--version` stdout the installed executable must print. */
  readonly expectedIdentity: string;
  readonly platforms: Readonly<Record<string, ManagedStockCodexPlatform>>;
}

export const STOCK_CODEX_CLI_RUNTIME: ManagedStockCodexRuntime = Object.freeze({
  kind: MANAGED_STOCK_CODEX_RUNTIME_KIND,
  id: "codex-cli",
  upstreamVersion: "0.153.4",
  rbRevision: "rb.1",
  version: "0.153.4-rb.1",
  transport: "codex-exec",
  installedRelativePath: "bin/codex",
  expectedIdentity: "codex-cli 0.153.4",
  platforms: Object.freeze({
    "linux-x86_64": Object.freeze({
      nodePlatform: "linux",
      nodeArchitecture: "x64",
      executableSizeBytes: 258_659_424,
      executableSha256: "56ef98ab4032d317ab26e9b5e5a175650717351edb16ed9cde0cb6d1734d62da",
      payload: Object.freeze([
        Object.freeze({ relativePath: "bin/codex", sizeBytes: 258_659_424, sha256: "56ef98ab4032d317ab26e9b5e5a175650717351edb16ed9cde0cb6d1734d62da", executable: true }),
        Object.freeze({ relativePath: "bin/codex-code-mode-host", sizeBytes: 69_460_032, sha256: "3e85d67471825f73d02ff5f7e047ca1f6ca8caa3f59e4c6e8d9ca6ca7302cb45", executable: true }),
        Object.freeze({ relativePath: "codex-package.json", sizeBytes: 205, sha256: "43f8735a93a7947c6dc082c550d2ff2d795fccfd1c7eb27c93aa91cbead1e3f4", executable: false }),
        Object.freeze({ relativePath: "codex-path/rg", sizeBytes: 5_408_904, sha256: "e62198eb19b136b88c330af83647b5a962cb99b6b1f066758568f12de1974849", executable: true }),
        Object.freeze({ relativePath: "codex-resources/bwrap", sizeBytes: 529_776, sha256: "77360cb751ccedc5971391444ac86a8a33c15b04d6b4a6fe45f5d25496e62c4c", executable: true }),
        Object.freeze({ relativePath: "codex-resources/zsh/bin/zsh", sizeBytes: 898_480, sha256: "67faaaa89242c4a332e16e508a1977cffc24bf7fca31d4411cdfd101f3831ef3", executable: true }),
      ]),
    }),
  }),
});

export function managedStockCodexPlatformKey(
  runtime: ManagedStockCodexRuntime = STOCK_CODEX_CLI_RUNTIME,
  platform: NodeJS.Platform | string = process.platform,
  architecture: string = process.arch,
): string | undefined {
  return Object.entries(runtime.platforms).find(
    ([, candidate]) => candidate.nodePlatform === platform && candidate.nodeArchitecture === architecture,
  )?.[0];
}

/** The single install root both managed Harness runtimes share. */
export function managedRuntimeInstallRoot(installRoot?: string): string {
  return installRoot ?? join(homedir(), ".local", "libexec", "rb-harness");
}

/** `<root>/codex-cli/0.153.4-rb.1` — the whole runtime tree, not just a file. */
export function managedStockCodexVersionDirectory(
  installRoot?: string,
  runtime: ManagedStockCodexRuntime = STOCK_CODEX_CLI_RUNTIME,
): string {
  return join(managedRuntimeInstallRoot(installRoot), runtime.id, runtime.version);
}

export function managedStockCodexExecutablePath(
  installRoot?: string,
  runtime: ManagedStockCodexRuntime = STOCK_CODEX_CLI_RUNTIME,
): string {
  return join(managedStockCodexVersionDirectory(installRoot, runtime), ...runtime.installedRelativePath.split("/"));
}

export interface ManagedStockCodexIdentity {
  readonly kind: typeof MANAGED_STOCK_CODEX_RUNTIME_KIND;
  readonly id: string;
  readonly upstreamVersion: string;
  readonly rbRevision: string;
  readonly version: string;
  readonly transport: "codex-exec";
  readonly executablePath: string;
  readonly executableSizeBytes: number;
  readonly executableSha256: string;
  readonly reportedIdentity: string;
  readonly payloadEntryCount: number;
  /** Digest over every payload path, size and SHA-256 actually on disk. */
  readonly payloadDigest: string;
}

export type ManagedStockCodexVerification =
  | { readonly ok: true; readonly value: ManagedStockCodexIdentity }
  | { readonly ok: false; readonly reason: string };

export interface VerifyManagedStockCodexInput {
  readonly installRoot?: string;
  readonly runtime?: ManagedStockCodexRuntime;
  readonly platform?: NodeJS.Platform | string;
  readonly architecture?: string;
  /** Set false to skip the `--version` probe; identity then stays unproven. */
  readonly probeIdentity?: boolean;
  readonly probeTimeoutMs?: number;
}

/**
 * Read-only verification of an already-installed managed runtime.  It never
 * downloads, never repairs and never upgrades: drift is reported, not fixed.
 */
export async function verifyManagedStockCodexRuntime(
  input: VerifyManagedStockCodexInput = {},
): Promise<ManagedStockCodexVerification> {
  const runtime = input.runtime ?? STOCK_CODEX_CLI_RUNTIME;
  const platformKey = managedStockCodexPlatformKey(runtime, input.platform ?? process.platform, input.architecture ?? process.arch);
  const platform = platformKey ? runtime.platforms[platformKey] : undefined;
  if (!platform) return { ok: false, reason: `unsupported platform ${String(input.platform ?? process.platform)}-${input.architecture ?? process.arch}` };

  const versionDirectory = managedStockCodexVersionDirectory(input.installRoot, runtime);
  const executable = managedStockCodexExecutablePath(input.installRoot, runtime);
  try {
    const directory = await lstat(versionDirectory);
    if (!directory.isDirectory()) return { ok: false, reason: "managed version directory is not a directory" };
  } catch {
    return { ok: false, reason: `managed runtime is not installed at ${versionDirectory}` };
  }

  // The tree is a closed set: an unexpected extra file inside the managed
  // runtime directory is drift, not a harmless addition.
  const observed = await listRegularFiles(versionDirectory);
  const expected = platform.payload.map((entry) => entry.relativePath).sort();
  if (observed.length !== expected.length || observed.some((path, index) => path !== expected[index])) {
    return { ok: false, reason: "managed runtime payload tree does not match the pinned file set" };
  }

  const payload: ManagedStockCodexPayloadEntry[] = [];
  for (const entry of [...platform.payload].sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    const absolute = join(versionDirectory, ...entry.relativePath.split("/"));
    const stats = await lstat(absolute).catch(() => undefined);
    if (!stats) return { ok: false, reason: `managed runtime payload is missing ${entry.relativePath}` };
    if (stats.isSymbolicLink() || !stats.isFile()) return { ok: false, reason: `managed runtime payload ${entry.relativePath} is not a regular file` };
    if (stats.size !== entry.sizeBytes) return { ok: false, reason: `managed runtime payload size mismatch on ${entry.relativePath}` };
    if (entry.executable && (stats.mode & 0o111) === 0) return { ok: false, reason: `managed runtime payload ${entry.relativePath} is not executable` };
    const digest = await sha256File(absolute);
    if (digest !== entry.sha256) return { ok: false, reason: `managed runtime payload SHA-256 mismatch on ${entry.relativePath}` };
    payload.push({ relativePath: entry.relativePath, sizeBytes: entry.sizeBytes, sha256: digest, executable: entry.executable });
  }

  const executableEntry = payload.find((entry) => entry.relativePath === runtime.installedRelativePath);
  if (!executableEntry || executableEntry.sha256 !== platform.executableSha256 || executableEntry.sizeBytes !== platform.executableSizeBytes) {
    return { ok: false, reason: "managed runtime executable identity mismatch" };
  }

  let reportedIdentity = "";
  if (input.probeIdentity !== false) {
    const probe = await probeRuntimeIdentity(executable, input.probeTimeoutMs ?? 120_000);
    if (probe === null) return { ok: false, reason: "managed runtime --version probe failed" };
    reportedIdentity = probe;
    if (reportedIdentity !== runtime.expectedIdentity) return { ok: false, reason: `managed runtime reports ${reportedIdentity}, expected ${runtime.expectedIdentity}` };
  }

  return {
    ok: true,
    value: Object.freeze({
      kind: runtime.kind,
      id: runtime.id,
      upstreamVersion: runtime.upstreamVersion,
      rbRevision: runtime.rbRevision,
      version: runtime.version,
      transport: runtime.transport,
      executablePath: executable,
      executableSizeBytes: executableEntry.sizeBytes,
      executableSha256: executableEntry.sha256,
      reportedIdentity,
      payloadEntryCount: payload.length,
      payloadDigest: managedStockCodexPayloadDigest(payload),
    }),
  };
}

/** Deterministic digest of an observed or pinned payload tree. */
export function managedStockCodexPayloadDigest(payload: readonly ManagedStockCodexPayloadEntry[]): string {
  const canonical = [...payload]
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
    .map((entry) => `${entry.relativePath}:${entry.sizeBytes}:${entry.sha256}:${entry.executable ? "x" : "-"}`)
    .join("\n");
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

export interface InstallManagedStockCodexInput {
  /**
   * Directory holding the already-qualified upstream runtime tree — the one
   * whose bytes were physically recon'd and accepted.  Install is a byte copy
   * from this exact tree; nothing is downloaded and nothing is patched.
   */
  readonly sourceDirectory: string;
  readonly installRoot?: string;
  readonly runtime?: ManagedStockCodexRuntime;
  readonly probeTimeoutMs?: number;
}

export interface InstallManagedStockCodexResult {
  readonly status: "installed" | "already-installed";
  readonly versionDirectory: string;
  readonly identity: ManagedStockCodexIdentity;
}

/**
 * Install the pinned stock runtime by copying the exact qualified bytes.
 *
 * The source is verified against the pin BEFORE anything is written, the copy
 * lands in a staging directory and is renamed into place atomically, and the
 * installed tree is verified again afterwards.  A pre-existing install that
 * already verifies is left untouched.
 */
export async function installManagedStockCodexRuntime(input: InstallManagedStockCodexInput): Promise<InstallManagedStockCodexResult> {
  const runtime = input.runtime ?? STOCK_CODEX_CLI_RUNTIME;
  const platformKey = managedStockCodexPlatformKey(runtime);
  const platform = platformKey ? runtime.platforms[platformKey] : undefined;
  if (!platform) throw new Error(`Managed stock Codex runtime is unavailable for ${process.platform}-${process.arch}`);
  const source = resolve(input.sourceDirectory);
  if (!isAbsolute(source)) throw new Error("Managed stock Codex source directory must be absolute");

  const versionDirectory = managedStockCodexVersionDirectory(input.installRoot, runtime);
  const existing = await verifyManagedStockCodexRuntime({ installRoot: input.installRoot, runtime, probeTimeoutMs: input.probeTimeoutMs });
  if (existing.ok) return { status: "already-installed", versionDirectory, identity: existing.value };

  // Verify the SOURCE against the pin first: an install never carries bytes
  // that were not already qualified.
  for (const entry of platform.payload) {
    const absolute = join(source, ...entry.relativePath.split("/"));
    const stats = await lstat(absolute).catch(() => undefined);
    if (!stats || stats.isSymbolicLink() || !stats.isFile()) throw new Error(`Managed stock Codex source is missing a regular file at ${entry.relativePath}`);
    if (stats.size !== entry.sizeBytes) throw new Error(`Managed stock Codex source size mismatch on ${entry.relativePath}`);
    const digest = await sha256File(absolute);
    if (digest !== entry.sha256) throw new Error(`Managed stock Codex source SHA-256 mismatch on ${entry.relativePath}`);
  }
  const sourceFiles = await listRegularFiles(source);
  const expected = platform.payload.map((entry) => entry.relativePath).sort();
  if (sourceFiles.length !== expected.length || sourceFiles.some((path, index) => path !== expected[index])) {
    throw new Error("Managed stock Codex source tree does not match the pinned file set");
  }

  const parent = join(versionDirectory, "..");
  await mkdir(parent, { recursive: true, mode: 0o755 });
  const staging = `${versionDirectory}.install-${process.pid}-${Date.now().toString(36)}`;
  await rm(staging, { recursive: true, force: true });
  try {
    await mkdir(staging, { recursive: true, mode: 0o755 });
    for (const entry of platform.payload) {
      const segments = entry.relativePath.split("/");
      const destination = join(staging, ...segments);
      await mkdir(join(destination, ".."), { recursive: true, mode: 0o755 });
      await cp(join(source, ...segments), destination, { dereference: false, preserveTimestamps: false });
      await chmod(destination, entry.executable ? 0o755 : 0o644);
    }
    await rm(versionDirectory, { recursive: true, force: true });
    await rename(staging, versionDirectory);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }

  const verified = await verifyManagedStockCodexRuntime({ installRoot: input.installRoot, runtime, probeTimeoutMs: input.probeTimeoutMs });
  if (!verified.ok) throw new Error(`Managed stock Codex runtime failed verification after install: ${verified.reason}`);
  return { status: "installed", versionDirectory, identity: verified.value };
}

async function listRegularFiles(root: string, prefix = ""): Promise<string[]> {
  const names = await readdir(join(root, prefix), { withFileTypes: true }).catch(() => []);
  const found: string[] = [];
  for (const entry of names) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...await listRegularFiles(root, relative));
    else found.push(relative);
  }
  return found.sort();
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function probeRuntimeIdentity(executable: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolveProbe) => {
    const child = spawn(executable, ["--version"], { stdio: ["ignore", "pipe", "ignore"], env: { PATH: "/usr/bin:/bin", HOME: homedir() } });
    let stdout = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolveProbe(null); }, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (chunk: Buffer) => { if (stdout.length < 4096) stdout += chunk.toString("utf8"); });
    child.once("error", () => { clearTimeout(timer); resolveProbe(null); });
    child.once("close", (code) => { clearTimeout(timer); resolveProbe(code === 0 ? stdout.trim() : null); });
  });
}
