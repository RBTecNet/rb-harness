import { access, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { sha256Canonical } from "../hashing.js";
import { RalphM5BError } from "./contract.js";

/**
 * Ralph M5-B — the sandbox backend gate.
 *
 * M5-B.1 established a decisive environmental fact.  The Codex permission
 * profile is enforced by bubblewrap, and Codex resolves `bwrap` through the
 * PARENT process PATH.  When PATH is empty Codex silently falls back to the
 * copy bundled inside its own package, which carries no AppArmor profile; on
 * an AppArmor host that binary is denied CAP_NET_ADMIN and every sandboxed
 * command fails to start with:
 *
 *   bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted
 *
 * That failure is silent from the model's point of view — it simply reports
 * that its commands did not run — so M5-B refuses to dispatch unless the
 * system bwrap is the binary that will actually be selected.
 */
export const CODEX_SYSTEM_SANDBOX_BACKEND_PATH_V2 = "/usr/bin/bwrap" as const;

/** The exact PATH the Codex parent receives; also how `bwrap` is resolved. */
export const CODEX_PARENT_PATH_V2 = "/usr/bin:/bin" as const;

export interface CodexSandboxBackendFactsV2 {
  readonly backendPath: string;
  readonly resolvedFromPath: string;
  readonly executable: true;
  readonly bundledFallbackSelected: false;
  readonly factsDigest: string;
}

/**
 * Resolve `bwrap` exactly the way a child process would, using only the
 * explicit parent PATH.  The ambient `process.env.PATH` is never consulted:
 * the point of the gate is to observe what Codex itself will find.
 */
export async function resolveSandboxBackendOnPathV2(pathValue: string = CODEX_PARENT_PATH_V2): Promise<string | null> {
  if (typeof pathValue !== "string" || pathValue.length === 0) return null;
  for (const directory of pathValue.split(":")) {
    if (directory.length === 0 || !isAbsolute(directory)) continue;
    const candidate = join(directory, "bwrap");
    try {
      const stats = await lstat(candidate);
      if (!stats.isFile()) continue;
      await access(candidate, constants.X_OK);
      return candidate;
    } catch { continue; }
  }
  return null;
}

/**
 * Fail before any model-bearing dispatch unless the system bubblewrap is the
 * binary Codex will select under the exact parent PATH.  Only safe structural
 * facts are returned; no command output is captured or persisted.
 */
export async function inspectCodexSandboxBackendV2(
  pathValue: string = CODEX_PARENT_PATH_V2,
  expectedBackendPath: string = CODEX_SYSTEM_SANDBOX_BACKEND_PATH_V2,
): Promise<CodexSandboxBackendFactsV2> {
  if (process.platform !== "linux") {
    throw new RalphM5BError("M5B_SANDBOX_BACKEND_INVALID", "M5B_SANDBOX_BACKEND_INVALID: unsupported platform");
  }
  if (!isAbsolute(expectedBackendPath) || resolve(expectedBackendPath) !== expectedBackendPath) {
    throw new RalphM5BError("M5B_SANDBOX_BACKEND_INVALID", "M5B_SANDBOX_BACKEND_INVALID: expected backend path");
  }
  const resolved = await resolveSandboxBackendOnPathV2(pathValue);
  if (resolved === null) {
    throw new RalphM5BError(
      "M5B_SANDBOX_BACKEND_INVALID",
      `M5B_SANDBOX_BACKEND_INVALID: no bwrap is reachable on the parent PATH (${pathValue}); Codex would fall back to its bundled copy`,
    );
  }
  if (resolved !== expectedBackendPath) {
    // A bundled or otherwise unexpected bwrap is exactly the M5-B.1 failure
    // mode: it starts, then dies without running a single provider command.
    throw new RalphM5BError(
      "M5B_SANDBOX_BACKEND_INVALID",
      `M5B_SANDBOX_BACKEND_INVALID: the parent PATH selects ${resolved}, not ${expectedBackendPath}`,
    );
  }
  const base = {
    backendPath: resolved,
    resolvedFromPath: pathValue,
    executable: true as const,
    bundledFallbackSelected: false as const,
  };
  return Object.freeze({ ...base, factsDigest: sha256Canonical(base) });
}
