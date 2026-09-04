import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, lstat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { managedRuntimePlatformKey, RB_CODEX_RUNTIME } from "./external-runtime-manifest.js";
import { managedRbCodexInstallPath } from "./runtime-bootstrap.js";

export type ManagedCodexRuntimeResult = {
  readonly ok: true;
  readonly value: {
    readonly executable: string;
    readonly version: string;
    readonly sha256: string;
    readonly semanticModeVersion: string;
    readonly semanticRuntimeVersion: string;
    readonly identity: string;
  };
} | {
  readonly ok: false;
  readonly error: {
    readonly kind: "unsupported-capability";
    readonly message: string;
    readonly transportRetryable: false;
  };
};

function unavailable(detail: string): ManagedCodexRuntimeResult {
  return { ok: false, error: { kind: "unsupported-capability", message: `Managed RB-Codex runtime is not certified (${detail}); run or re-run rb-harness-install`, transportRetryable: false } };
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function runtimeIdentity(path: string): Promise<{ code: number; stdout: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(path, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => { if (stdout.length < 4096) stdout += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code) => resolveRun({ code: code ?? 1, stdout }));
  });
}

/** Read-only verification of the existing managed runtime. It never downloads or repairs. */
export async function verifyManagedCodexRuntime(): Promise<ManagedCodexRuntimeResult> {
  const executable = managedRbCodexInstallPath();
  try {
    const platformKey = managedRuntimePlatformKey(RB_CODEX_RUNTIME, process.platform, process.arch);
    const platform = platformKey ? RB_CODEX_RUNTIME.platforms[platformKey] : undefined;
    if (!platform) return unavailable(`unsupported platform ${process.platform}-${process.arch}`);
    const metadata = await lstat(executable);
    if (!metadata.isFile()) return unavailable("managed executable is not a regular file");
    await access(executable, constants.X_OK);
    if (metadata.size !== platform.expectedSize) return unavailable("managed executable size mismatch");
    const digest = await sha256(executable);
    if (digest !== platform.sha256) return unavailable("managed executable SHA-256 mismatch");
    const identity = await runtimeIdentity(executable);
    if (identity.code !== 0 || identity.stdout.trim() !== RB_CODEX_RUNTIME.expectedIdentity) return unavailable("managed executable identity mismatch");
    return { ok: true, value: {
      executable, version: RB_CODEX_RUNTIME.version, sha256: digest,
      semanticModeVersion: RB_CODEX_RUNTIME.semanticModeVersion,
      semanticRuntimeVersion: `${RB_CODEX_RUNTIME.id} ${RB_CODEX_RUNTIME.version} (upstream ${RB_CODEX_RUNTIME.upstreamCommit})`,
      identity: identity.stdout.trim(),
    } };
  } catch {
    return unavailable("managed executable is missing or unreadable");
  }
}
