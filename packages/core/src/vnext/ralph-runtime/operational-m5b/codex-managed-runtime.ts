import { isAbsolute, resolve } from "node:path";
import {
  MANAGED_STOCK_CODEX_RUNTIME_KIND,
  STOCK_CODEX_CLI_RUNTIME,
  managedStockCodexExecutablePath,
  managedStockCodexPayloadDigest,
  managedStockCodexPlatformKey,
  managedStockCodexVersionDirectory,
  verifyManagedStockCodexRuntime,
  type ManagedStockCodexRuntime,
} from "../../../managed-stock-codex-runtime.js";
import { sha256Canonical } from "../hashing.js";
import { RalphM5BError } from "./contract-errors.js";

/**
 * Ralph M5-B — binding to the HARNESS-MANAGED stock Codex runtime.
 *
 * M5-B originally pinned the binary where npm/nvm happened to place it.  That
 * made a frozen provider Executor hostage to an unrelated
 * `npm i -g @openai/codex`: the same absolute path would silently become a
 * different binary.  The runtime is now Harness-managed — installed, pinned
 * and verified under `~/.local/libexec/rb-harness` — and this module is the
 * only place M5-B may learn where Codex lives.
 *
 * Nothing here consults PATH, `npm`, nvm, `/usr/local/bin`, a bare `codex`
 * name or a "latest" channel, and there is no auto-upgrade: drift fails
 * closed and a future upgrade is a deliberate new managed version.
 *
 * This is a PIN, not a transport change.  The managed runtime is stock
 * `codex exec`; the semantic `rb-codex` app-server fork is a different
 * runtime and is never selected here.
 */
export { MANAGED_STOCK_CODEX_RUNTIME_KIND, STOCK_CODEX_CLI_RUNTIME } from "../../../managed-stock-codex-runtime.js";

export const CODEX_MANAGED_RUNTIME_SCHEMA_V2 = "rb-ralph-codex-managed-runtime/v1" as const;

/** The managed runtime M5-B is frozen against. */
export const CODEX_MANAGED_RUNTIME_V2: ManagedStockCodexRuntime = STOCK_CODEX_CLI_RUNTIME;

/** Absolute path of the managed executable. Never PATH-resolved. */
export function codexManagedRuntimeExecutablePathV2(installRoot?: string): string {
  return managedStockCodexExecutablePath(installRoot, CODEX_MANAGED_RUNTIME_V2);
}

/** The runtime tree the sandbox must be able to read to re-exec arg0. */
export function codexManagedRuntimeDirectoryV2(installRoot?: string): string {
  return managedStockCodexVersionDirectory(installRoot, CODEX_MANAGED_RUNTIME_V2);
}

export interface CodexManagedRuntimeIdentityV2 {
  readonly schema: typeof CODEX_MANAGED_RUNTIME_SCHEMA_V2;
  readonly kind: typeof MANAGED_STOCK_CODEX_RUNTIME_KIND;
  readonly runtimeId: string;
  readonly upstreamVersion: string;
  readonly rbRevision: string;
  readonly version: string;
  readonly transport: "codex-exec";
  readonly executablePath: string;
  readonly executableSizeBytes: number;
  readonly executableSha256: string;
  readonly reportedIdentity: string;
  readonly payloadEntryCount: number;
  readonly payloadDigest: string;
  readonly identityDigest: string;
}

/**
 * The pinned identity, independent of whether anything is installed yet.
 * Used by declarations (the capability record) that must state the identity
 * they require before a physical verification has happened.
 */
export function codexManagedRuntimeExpectedIdentityDigestV2(installRoot?: string): string {
  const platformKey = managedStockCodexPlatformKey(CODEX_MANAGED_RUNTIME_V2);
  const platform = platformKey ? CODEX_MANAGED_RUNTIME_V2.platforms[platformKey] : undefined;
  if (!platform) {
    throw new RalphM5BError("M5B_MANAGED_RUNTIME_INVALID", `M5B_MANAGED_RUNTIME_INVALID: unsupported platform ${process.platform}-${process.arch}`);
  }
  return identityDigestOf({
    kind: CODEX_MANAGED_RUNTIME_V2.kind,
    runtimeId: CODEX_MANAGED_RUNTIME_V2.id,
    upstreamVersion: CODEX_MANAGED_RUNTIME_V2.upstreamVersion,
    rbRevision: CODEX_MANAGED_RUNTIME_V2.rbRevision,
    version: CODEX_MANAGED_RUNTIME_V2.version,
    transport: CODEX_MANAGED_RUNTIME_V2.transport,
    executablePath: codexManagedRuntimeExecutablePathV2(installRoot),
    executableSizeBytes: platform.executableSizeBytes,
    executableSha256: platform.executableSha256,
    reportedIdentity: CODEX_MANAGED_RUNTIME_V2.expectedIdentity,
    payloadEntryCount: platform.payload.length,
    payloadDigest: managedStockCodexPayloadDigest(platform.payload),
  });
}

/**
 * Refuse any executable that is not the managed one.
 *
 * This is the concrete defence against a global Codex upgrade reaching a
 * frozen Executor: `codex`, `/usr/local/bin/codex`, an nvm global package
 * path and an rb-codex fork are all rejected by identity, not by hope.
 */
export function assertCodexManagedExecutablePathV2(executablePath: string, installRoot?: string): void {
  const expected = codexManagedRuntimeExecutablePathV2(installRoot);
  if (typeof executablePath !== "string" || !isAbsolute(executablePath) || resolve(executablePath) !== executablePath) {
    throw new RalphM5BError("M5B_MANAGED_RUNTIME_INVALID", "M5B_MANAGED_RUNTIME_INVALID: the Codex executable must be an absolute normalized path");
  }
  if (executablePath !== expected) {
    throw new RalphM5BError(
      "M5B_MANAGED_RUNTIME_INVALID",
      `M5B_MANAGED_RUNTIME_INVALID: only the Harness-managed runtime may be executed; ${executablePath} is not ${expected}`,
    );
  }
}

export interface AssertCodexManagedRuntimeInputV2 {
  readonly installRoot?: string;
  readonly probeTimeoutMs?: number;
  /** Set false only where the caller has already probed `--version` itself. */
  readonly probeIdentity?: boolean;
}

/**
 * Verify the managed runtime completely and fail closed on any drift: a
 * missing install, a changed payload file, a size or SHA-256 mismatch, an
 * unexpected extra file in the tree, or a `--version` that is not exactly the
 * pinned upstream identity.
 */
export async function assertCodexManagedRuntimeV2(input: AssertCodexManagedRuntimeInputV2 = {}): Promise<CodexManagedRuntimeIdentityV2> {
  const verification = await verifyManagedStockCodexRuntime({
    installRoot: input.installRoot,
    runtime: CODEX_MANAGED_RUNTIME_V2,
    ...(input.probeIdentity === undefined ? {} : { probeIdentity: input.probeIdentity }),
    ...(input.probeTimeoutMs === undefined ? {} : { probeTimeoutMs: input.probeTimeoutMs }),
  });
  if (!verification.ok) {
    throw new RalphM5BError("M5B_MANAGED_RUNTIME_INVALID", `M5B_MANAGED_RUNTIME_INVALID: ${verification.reason}`);
  }
  const value = verification.value;
  assertCodexManagedExecutablePathV2(value.executablePath, input.installRoot);
  if (value.kind !== MANAGED_STOCK_CODEX_RUNTIME_KIND || value.transport !== "codex-exec") {
    throw new RalphM5BError("M5B_MANAGED_RUNTIME_INVALID", "M5B_MANAGED_RUNTIME_INVALID: runtime kind or transport");
  }
  if (value.upstreamVersion !== CODEX_MANAGED_RUNTIME_V2.upstreamVersion || value.rbRevision !== CODEX_MANAGED_RUNTIME_V2.rbRevision) {
    throw new RalphM5BError("M5B_MANAGED_RUNTIME_INVALID", "M5B_MANAGED_RUNTIME_INVALID: runtime version");
  }
  if (input.probeIdentity !== false && value.reportedIdentity !== CODEX_MANAGED_RUNTIME_V2.expectedIdentity) {
    throw new RalphM5BError("M5B_MANAGED_RUNTIME_INVALID", "M5B_MANAGED_RUNTIME_INVALID: reported identity");
  }
  const base = {
    kind: value.kind,
    runtimeId: value.id,
    upstreamVersion: value.upstreamVersion,
    rbRevision: value.rbRevision,
    version: value.version,
    transport: value.transport,
    executablePath: value.executablePath,
    executableSizeBytes: value.executableSizeBytes,
    executableSha256: value.executableSha256,
    reportedIdentity: input.probeIdentity === false ? CODEX_MANAGED_RUNTIME_V2.expectedIdentity : value.reportedIdentity,
    payloadEntryCount: value.payloadEntryCount,
    payloadDigest: value.payloadDigest,
  };
  const identity: CodexManagedRuntimeIdentityV2 = Object.freeze({
    schema: CODEX_MANAGED_RUNTIME_SCHEMA_V2,
    ...base,
    identityDigest: identityDigestOf(base),
  });
  if (identity.identityDigest !== codexManagedRuntimeExpectedIdentityDigestV2(input.installRoot)) {
    throw new RalphM5BError("M5B_MANAGED_RUNTIME_INVALID", "M5B_MANAGED_RUNTIME_INVALID: observed identity does not match the pinned identity");
  }
  return identity;
}

/** Bounded credential-free facts about the managed runtime. */
export function codexManagedRuntimeFactsV2(identity: CodexManagedRuntimeIdentityV2): Readonly<Record<string, string>> {
  return Object.freeze({
    kind: identity.kind,
    runtimeId: identity.runtimeId,
    version: identity.version,
    upstreamVersion: identity.upstreamVersion,
    rbRevision: identity.rbRevision,
    transport: identity.transport,
    executableSizeBytes: String(identity.executableSizeBytes),
    executableSha256: identity.executableSha256,
    reportedIdentity: identity.reportedIdentity,
    payloadDigest: identity.payloadDigest,
    identityDigest: identity.identityDigest,
  });
}

function identityDigestOf(base: Omit<CodexManagedRuntimeIdentityV2, "schema" | "identityDigest">): string {
  return sha256Canonical({ schema: CODEX_MANAGED_RUNTIME_SCHEMA_V2, ...base });
}
