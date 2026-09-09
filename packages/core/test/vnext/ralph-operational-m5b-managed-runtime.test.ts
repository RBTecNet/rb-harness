import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  STOCK_CODEX_CLI_RUNTIME,
  installManagedStockCodexRuntime,
  managedStockCodexExecutablePath,
  managedStockCodexPayloadDigest,
  managedStockCodexPlatformKey,
  managedStockCodexVersionDirectory,
  verifyManagedStockCodexRuntime,
} from "../../src/managed-stock-codex-runtime.js";
import { RB_CODEX_RUNTIME } from "../../src/external-runtime-manifest.js";
import {
  CODEX_MANAGED_RUNTIME_V2,
  assertCodexManagedExecutablePathV2,
  assertCodexManagedRuntimeV2,
  codexManagedRuntimeDirectoryV2,
  codexManagedRuntimeExecutablePathV2,
  codexManagedRuntimeExpectedIdentityDigestV2,
} from "../../src/vnext/ralph-runtime/operational-m5b/codex-managed-runtime.js";
import {
  CODEX_CLI_NATIVE_EXECUTABLE_PATH_V2,
  CODEX_CLI_NATIVE_EXECUTABLE_SHA256_V2,
  CODEX_CLI_NATIVE_EXECUTABLE_SIZE_BYTES_V2,
  CODEX_MANAGED_RUNTIME_RB_REVISION_V2,
  CODEX_MANAGED_RUNTIME_UPSTREAM_VERSION_V2,
  CODEX_MANAGED_RUNTIME_VERSION_V2,
} from "../../src/vnext/ralph-runtime/operational-m5b/contract.js";
import { CODEX_CLI_CAPABILITY_RECORD_V2 } from "../../src/vnext/ralph-runtime/operational-m5b/codex-capability.js";
import { codexRuntimeReadRootV2 } from "../../src/vnext/ralph-runtime/operational-m5b/codex-process.js";

/**
 * Ralph M5-B — the Harness-managed stock Codex runtime.
 *
 * The strategic requirement this file enforces: upgrading Codex on the
 * machine must not change or break a frozen Harness runtime.  M5-B used to
 * pin whatever path npm/nvm happened to install into, which made the frozen
 * Executor hostage to an unrelated `npm i -g @openai/codex`.  It now executes
 * ONLY the managed install, verified whole.
 *
 * This pins a proven stock binary; it does NOT revert the transport.  The
 * semantic `rb-codex` app-server fork is a different runtime and must never
 * be selected here.
 */
const MANAGED_INSTALLED = existsSync(managedStockCodexExecutablePath());

const temporaries: string[] = [];
afterEach(async () => {
  await Promise.all(temporaries.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function scratch(prefix: string): Promise<string> {
  const path = await mkdtemp(resolve(tmpdir(), prefix));
  temporaries.push(path);
  return path;
}

/** A stand-in runtime tree, so install/verify are testable without 320 MiB. */
async function fixtureRuntime() {
  const source = await scratch("rb-ralph-m5b-runtime-source-");
  const installRoot = await scratch("rb-ralph-m5b-runtime-install-");
  const payload = [
    { relativePath: "bin/codex", content: "#!/bin/sh\necho \"codex-cli 9.9.9\"\n", executable: true },
    { relativePath: "codex-resources/marker.txt", content: "resource\n", executable: false },
  ];
  for (const entry of payload) {
    const absolute = join(source, ...entry.relativePath.split("/"));
    await mkdir(join(absolute, ".."), { recursive: true });
    await writeFile(absolute, entry.content);
    await chmod(absolute, entry.executable ? 0o755 : 0o644);
  }
  const { createHash } = await import("node:crypto");
  const runtime = {
    ...STOCK_CODEX_CLI_RUNTIME,
    version: "9.9.9-rb.1",
    upstreamVersion: "9.9.9",
    expectedIdentity: "codex-cli 9.9.9",
    platforms: {
      [managedStockCodexPlatformKey()!]: {
        ...STOCK_CODEX_CLI_RUNTIME.platforms[managedStockCodexPlatformKey()!]!,
        executableSizeBytes: Buffer.byteLength(payload[0]!.content),
        executableSha256: createHash("sha256").update(payload[0]!.content).digest("hex"),
        payload: payload.map((entry) => ({
          relativePath: entry.relativePath,
          sizeBytes: Buffer.byteLength(entry.content),
          sha256: createHash("sha256").update(entry.content).digest("hex"),
          executable: entry.executable,
        })),
      },
    },
  } as typeof STOCK_CODEX_CLI_RUNTIME;
  return { source, installRoot, runtime };
}

describe("Ralph M5-B — managed runtime identity", () => {
  it("pins the exact qualified stock coordinates", () => {
    expect(CODEX_MANAGED_RUNTIME_V2).toMatchObject({
      kind: "stock-codex-cli-managed",
      id: "codex-cli",
      upstreamVersion: "0.153.4",
      rbRevision: "rb.1",
      version: "0.153.4-rb.1",
      transport: "codex-exec",
      expectedIdentity: "codex-cli 0.153.4",
    });
    expect(CODEX_MANAGED_RUNTIME_UPSTREAM_VERSION_V2).toBe("0.153.4");
    expect(CODEX_MANAGED_RUNTIME_RB_REVISION_V2).toBe("rb.1");
    expect(CODEX_MANAGED_RUNTIME_VERSION_V2).toBe("0.153.4-rb.1");
    const platform = CODEX_MANAGED_RUNTIME_V2.platforms[managedStockCodexPlatformKey()!]!;
    // rb.1 patches no byte: the pinned size and SHA are the upstream ones.
    expect(platform.executableSizeBytes).toBe(258_659_424);
    expect(platform.executableSha256).toBe("56ef98ab4032d317ab26e9b5e5a175650717351edb16ed9cde0cb6d1734d62da");
    expect(CODEX_CLI_NATIVE_EXECUTABLE_SIZE_BYTES_V2).toBe(platform.executableSizeBytes);
    expect(CODEX_CLI_NATIVE_EXECUTABLE_SHA256_V2).toBe(`sha256:${platform.executableSha256}`);
  });

  it("is a different runtime from the semantic rb-codex fork", () => {
    // M5-B pins the proven STOCK binary. Reverting to the app-server fork
    // would be a transport change, and nothing here may express one.
    expect(CODEX_MANAGED_RUNTIME_V2.id).not.toBe(RB_CODEX_RUNTIME.id);
    expect(CODEX_MANAGED_RUNTIME_V2.version).not.toBe(RB_CODEX_RUNTIME.version);
    expect(CODEX_MANAGED_RUNTIME_V2.transport).toBe("codex-exec");
    expect(JSON.stringify(CODEX_MANAGED_RUNTIME_V2)).not.toMatch(/semanticMode|app-server|rb-codex/);
    expect(managedStockCodexExecutablePath()).not.toBe(join(RB_CODEX_RUNTIME.installedFilename));
  });

  it("resolves the executable and the runtime read root under the managed install", () => {
    const executable = codexManagedRuntimeExecutablePathV2();
    expect(executable).toBe(managedStockCodexExecutablePath());
    expect(executable).toBe(join(managedStockCodexVersionDirectory(), "bin", "codex"));
    expect(executable).toContain(join(".local", "libexec", "rb-harness", "codex-cli", "0.153.4-rb.1"));
    expect(CODEX_CLI_NATIVE_EXECUTABLE_PATH_V2).toBe(executable);
    // The sandbox read grant must be the version directory: Codex re-execs
    // its own binary as arg0 and resolves `codex-resources` beside it.
    expect(codexRuntimeReadRootV2(executable)).toBe(codexManagedRuntimeDirectoryV2());
  });

  it("binds the managed identity into the capability record", () => {
    expect(CODEX_CLI_CAPABILITY_RECORD_V2.managedRuntimeKind).toBe("stock-codex-cli-managed");
    expect(CODEX_CLI_CAPABILITY_RECORD_V2.managedRuntimeVersion).toBe("0.153.4-rb.1");
    expect(CODEX_CLI_CAPABILITY_RECORD_V2.managedRuntimeIdentityDigest).toBe(codexManagedRuntimeExpectedIdentityDigestV2());
    expect(CODEX_CLI_CAPABILITY_RECORD_V2.executablePath).toBe(codexManagedRuntimeExecutablePathV2());
  });
});

describe("Ralph M5-B — global Codex drift isolation", () => {
  it("refuses every runtime that is not the managed one", () => {
    for (const candidate of [
      "codex",
      "/usr/local/bin/codex",
      "/usr/bin/codex",
      "/home/bruno/.nvm/versions/node/v20.19.5/bin/codex",
      "/home/bruno/.nvm/versions/node/v20.19.5/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex",
      join(managedStockCodexVersionDirectory(), "bin", "codex-code-mode-host"),
    ]) {
      expect(() => assertCodexManagedExecutablePathV2(candidate), candidate).toThrow(/M5B_MANAGED_RUNTIME_INVALID/);
    }
    expect(() => assertCodexManagedExecutablePathV2(codexManagedRuntimeExecutablePathV2())).not.toThrow();
  });

  it("keeps the managed selection identical while a PATH Codex drifts", async () => {
    // Simulate a global upgrade: a different `codex` appears earlier on PATH
    // and the environment points at it. The managed selection is derived from
    // the install root, never from PATH, so nothing moves.
    const drift = await scratch("rb-ralph-m5b-path-drift-");
    await writeFile(join(drift, "codex"), "#!/bin/sh\necho \"codex-cli 0.999.0\"\n", { mode: 0o755 });
    const before = codexManagedRuntimeExecutablePathV2();
    const originalPath = process.env.PATH;
    const originalHome = process.env.CODEX_CLI_PATH;
    try {
      process.env.PATH = `${drift}:${originalPath ?? ""}`;
      process.env.CODEX_CLI_PATH = join(drift, "codex");
      expect(codexManagedRuntimeExecutablePathV2()).toBe(before);
      expect(CODEX_CLI_NATIVE_EXECUTABLE_PATH_V2).toBe(before);
      expect(codexManagedRuntimeExpectedIdentityDigestV2()).toBe(CODEX_CLI_CAPABILITY_RECORD_V2.managedRuntimeIdentityDigest);
      expect(() => assertCodexManagedExecutablePathV2(join(drift, "codex"))).toThrow(/M5B_MANAGED_RUNTIME_INVALID/);
    } finally {
      if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
      if (originalHome === undefined) delete process.env.CODEX_CLI_PATH; else process.env.CODEX_CLI_PATH = originalHome;
    }
  });
});

describe("Ralph M5-B — managed runtime install and verification", () => {
  it("installs the exact source bytes and verifies the whole tree", async () => {
    const { source, installRoot, runtime } = await fixtureRuntime();
    const installed = await installManagedStockCodexRuntime({ sourceDirectory: source, installRoot, runtime });
    expect(installed.status).toBe("installed");
    expect(installed.identity).toMatchObject({ kind: "stock-codex-cli-managed", version: "9.9.9-rb.1", transport: "codex-exec", reportedIdentity: "codex-cli 9.9.9" });
    // Byte-for-byte: install is a copy of already-qualified bytes.
    expect(await readFile(join(installRoot, "codex-cli", "9.9.9-rb.1", "bin", "codex"), "utf8"))
      .toBe(await readFile(join(source, "bin", "codex"), "utf8"));
    // Re-running is idempotent and never re-downloads or re-copies.
    expect((await installManagedStockCodexRuntime({ sourceDirectory: source, installRoot, runtime })).status).toBe("already-installed");
  });

  it("refuses a source whose bytes are not the qualified ones", async () => {
    const { source, installRoot, runtime } = await fixtureRuntime();
    await writeFile(join(source, "bin", "codex"), "#!/bin/sh\necho \"codex-cli 0.0.0\"\n", { mode: 0o755 });
    await expect(installManagedStockCodexRuntime({ sourceDirectory: source, installRoot, runtime })).rejects.toThrow(/SHA-256|size/);
  });

  it("refuses a source tree carrying an unexpected extra file", async () => {
    const { source, installRoot, runtime } = await fixtureRuntime();
    await writeFile(join(source, "smuggled.txt"), "extra\n");
    await expect(installManagedStockCodexRuntime({ sourceDirectory: source, installRoot, runtime })).rejects.toThrow(/pinned file set/);
  });

  it("reports every kind of post-install drift instead of repairing it", async () => {
    const { source, installRoot, runtime } = await fixtureRuntime();
    await installManagedStockCodexRuntime({ sourceDirectory: source, installRoot, runtime });
    const versionDirectory = join(installRoot, "codex-cli", "9.9.9-rb.1");
    const executable = join(versionDirectory, "bin", "codex");

    await writeFile(executable, "#!/bin/sh\necho \"codex-cli 0.0.1\"\n", { mode: 0o755 });
    expect(await verifyManagedStockCodexRuntime({ installRoot, runtime })).toMatchObject({ ok: false });

    await installManagedStockCodexRuntime({ sourceDirectory: source, installRoot, runtime });
    await writeFile(join(versionDirectory, "extra.txt"), "x\n");
    expect(await verifyManagedStockCodexRuntime({ installRoot, runtime })).toMatchObject({ ok: false });

    await rm(join(versionDirectory, "extra.txt"), { force: true });
    await rm(executable, { force: true });
    await symlink(join(source, "bin", "codex"), executable);
    // A symlink is never accepted, even pointing at the correct bytes.
    expect(await verifyManagedStockCodexRuntime({ installRoot, runtime })).toMatchObject({ ok: false });

    await rm(versionDirectory, { recursive: true, force: true });
    expect(await verifyManagedStockCodexRuntime({ installRoot, runtime })).toMatchObject({ ok: false });
  });

  it("detects a payload edit that preserves the file size", async () => {
    // A size check alone is not integrity: an attacker patching a binary in
    // place keeps the length. Only the SHA-256 catches this.
    const { source, installRoot, runtime } = await fixtureRuntime();
    await installManagedStockCodexRuntime({ sourceDirectory: source, installRoot, runtime });
    const executable = join(installRoot, "codex-cli", "9.9.9-rb.1", "bin", "codex");
    const original = await readFile(executable, "utf8");
    const tampered = `${original.slice(0, -2)}#\n`;
    expect(Buffer.byteLength(tampered)).toBe(Buffer.byteLength(original));
    await writeFile(executable, tampered, { mode: 0o755 });
    const verified = await verifyManagedStockCodexRuntime({ installRoot, runtime });
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.reason).toMatch(/SHA-256/);
  });

  it("never auto-upgrades or accepts a foreign version directory", async () => {
    const { source, installRoot, runtime } = await fixtureRuntime();
    await installManagedStockCodexRuntime({ sourceDirectory: source, installRoot, runtime });
    // A newer runtime appearing beside it is simply a different, unselected
    // install: verification stays bound to the pinned version directory.
    await mkdir(join(installRoot, "codex-cli", "9.9.9-rb.2", "bin"), { recursive: true });
    await writeFile(join(installRoot, "codex-cli", "9.9.9-rb.2", "bin", "codex"), "#!/bin/sh\necho \"codex-cli 9.9.10\"\n", { mode: 0o755 });
    const verified = await verifyManagedStockCodexRuntime({ installRoot, runtime });
    expect(verified.ok).toBe(true);
    if (verified.ok) expect(verified.value.version).toBe("9.9.9-rb.1");
  });

  it("computes a payload digest that changes with any payload change", () => {
    const platform = CODEX_MANAGED_RUNTIME_V2.platforms[managedStockCodexPlatformKey()!]!;
    const baseline = managedStockCodexPayloadDigest(platform.payload);
    expect(baseline).toMatch(/^sha256:[0-9a-f]{64}$/);
    // Order is normalized, content is not.
    expect(managedStockCodexPayloadDigest([...platform.payload].reverse())).toBe(baseline);
    expect(managedStockCodexPayloadDigest(platform.payload.map((entry, index) => (index === 0 ? { ...entry, sha256: "0".repeat(64) } : entry)))).not.toBe(baseline);
  });
});

describe.runIf(MANAGED_INSTALLED)("Ralph M5-B — the real managed install", () => {
  it("verifies the physically installed stock runtime end to end", async () => {
    const identity = await assertCodexManagedRuntimeV2({ probeTimeoutMs: 120_000 });
    expect(identity).toMatchObject({
      kind: "stock-codex-cli-managed",
      upstreamVersion: "0.153.4",
      rbRevision: "rb.1",
      version: "0.153.4-rb.1",
      transport: "codex-exec",
      executablePath: codexManagedRuntimeExecutablePathV2(),
      executableSizeBytes: 258_659_424,
      executableSha256: "56ef98ab4032d317ab26e9b5e5a175650717351edb16ed9cde0cb6d1734d62da",
      reportedIdentity: "codex-cli 0.153.4",
    });
    expect(identity.identityDigest).toBe(CODEX_CLI_CAPABILITY_RECORD_V2.managedRuntimeIdentityDigest);
  }, 180_000);
});
