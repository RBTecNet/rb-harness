import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bootstrapRbCodexRuntime,
  calculateProgress,
  createProgressReporter,
} from "../src/runtime-bootstrap.js";
import {
  managedRuntimePlatformKey,
  RB_CODEX_RUNTIME,
  type ManagedExternalRuntime,
} from "../src/external-runtime-manifest.js";

const IDENTITY = "rb-codex fixture identity";

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function fixtureRuntime(
  downloadUrl: string,
  bytes: Buffer,
  overrides: { expectedSize?: number; sha?: string } = {},
): ManagedExternalRuntime {
  return {
    id: "rb-codex",
    version: "fixture-v1",
    semanticModeVersion: "v1",
    sourceFreezeCommit: "fixture-commit",
    upstreamVersion: "fixture-upstream",
    upstreamCommit: "fixture-upstream-commit",
    releaseRepository: "fixture/repository",
    releaseTag: "fixture-tag",
    installedFilename: "rb-codex",
    expectedIdentity: IDENTITY,
    platforms: {
      "linux-x86_64": {
        nodePlatform: "linux",
        nodeArchitecture: "x64",
        asset: "rb-codex-linux-x86_64",
        expectedSize: overrides.expectedSize ?? bytes.byteLength,
        sha256: overrides.sha ?? sha256(bytes),
        downloadUrl,
      },
    },
  };
}

function captureOutput(isTTY = false): { output: { isTTY: boolean; write(value: string): void }; lines: string[] } {
  const lines: string[] = [];
  return {
    output: {
      isTTY,
      write(value) {
        lines.push(value);
      },
    },
    lines,
  };
}

async function temporaryRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "rb-runtime-bootstrap-test-"));
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not expose a TCP address");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

const verifiedIdentity = async (): Promise<void> => {};

describe("managed RB Codex runtime bootstrap", () => {
  it("keeps the certified RB Codex release facts in one manifest authority", () => {
    expect(RB_CODEX_RUNTIME).toMatchObject({
      version: "0.151.0-rb.1",
      semanticModeVersion: "v1",
      sourceFreezeCommit: "0f4d33b4dd0eb7677663803e445ea5bcad64fe12",
      releaseRepository: "RBTecNet/rb-codex",
      releaseTag: "rb-codex-v0.151.0-rb.1",
    });
    expect(Object.keys(RB_CODEX_RUNTIME.platforms)).toEqual(["linux-x86_64"]);
    expect(RB_CODEX_RUNTIME.platforms["linux-x86_64"]).toMatchObject({
      asset: "rb-codex-linux-x86_64",
      expectedSize: 266_752_616,
      sha256: "b68d7cc25105d38cca12977164e45710ae4576a18f898269b563e743e100493d",
    });
  });

  it("maps only linux/x64 to the certified platform", () => {
    const runtime = fixtureRuntime("https://example.invalid/runtime", Buffer.from("runtime"));
    expect(managedRuntimePlatformKey(runtime, "linux", "x64")).toBe("linux-x86_64");
    expect(managedRuntimePlatformKey(runtime, "linux", "arm64")).toBeUndefined();
    expect(managedRuntimePlatformKey(runtime, "darwin", "x64")).toBeUndefined();
    expect(managedRuntimePlatformKey(runtime, "win32", "x64")).toBeUndefined();
  });

  it("reports unsupported platforms without attempting a download", async () => {
    const root = await temporaryRoot();
    const capture = captureOutput();
    const runtime = fixtureRuntime("https://example.invalid/must-not-run", Buffer.from("runtime"));
    const result = await bootstrapRbCodexRuntime({
      runtime,
      platform: "linux",
      architecture: "arm64",
      installRoot: root,
      output: capture.output,
    });
    expect(result).toMatchObject({ status: "unsupported", downloadedBytes: 0, networkRequestCount: 0 });
    expect(capture.lines.join("")).toContain("not available for this platform");
  });

  it("rejects non-HTTPS artifact URLs outside explicitly local tests", async () => {
    const bytes = Buffer.from("runtime");
    await expect(bootstrapRbCodexRuntime({
      runtime: fixtureRuntime("http://127.0.0.1:1/runtime", bytes),
      installRoot: await temporaryRoot(),
      output: captureOutput().output,
      verifyIdentity: verifiedIdentity,
      randomSuffix: () => "insecure-url",
    })).rejects.toThrow("requires HTTPS");
  });

  it("follows a redirect, installs atomically, and sets executable mode", async () => {
    const bytes = Buffer.from("certified runtime bytes");
    let requests = 0;
    const server = createServer((request, response) => {
      requests += 1;
      if (request.url === "/redirect") {
        response.writeHead(302, { Location: "/asset" }).end();
        return;
      }
      response.writeHead(200, { "Content-Length": String(bytes.byteLength) }).end(bytes);
    });
    const baseUrl = await listen(server);
    try {
      const root = await temporaryRoot();
      const runtime = fixtureRuntime(`${baseUrl}/redirect`, bytes);
      const result = await bootstrapRbCodexRuntime({
        runtime,
        installRoot: root,
        output: captureOutput().output,
        allowInsecureHttpForTests: true,
        verifyIdentity: verifiedIdentity,
        randomSuffix: () => "redirect-success",
      });
      expect(result).toMatchObject({ status: "installed", downloadedBytes: bytes.byteLength, networkRequestCount: 2 });
      expect(requests).toBe(2);
      expect(await readFile(result.installedPath!)).toEqual(bytes);
      expect((await stat(result.installedPath!)).mode & 0o111).not.toBe(0);
      expect(await readdir(join(root, "codex", runtime.version))).toEqual(["rb-codex"]);
    } finally {
      await close(server);
    }
  });

  it("reports semantic progress facts with clamped percentage, speed, and ETA", () => {
    expect(calculateProgress(50, 100, 0, 2_000)).toEqual({
      downloadedBytes: 50,
      totalBytes: 100,
      percentage: 50,
      bytesPerSecond: 25,
      etaSeconds: 2,
    });
    expect(calculateProgress(150, 100, 0, 1_000).percentage).toBe(100);
  });

  it("rejects an unexpected Content-Length", async () => {
    const bytes = Buffer.from("short");
    const server = createServer((_request, response) => {
      response.writeHead(200, { "Content-Length": String(bytes.byteLength) }).end(bytes);
    });
    const baseUrl = await listen(server);
    try {
      const runtime = fixtureRuntime(baseUrl, bytes, { expectedSize: bytes.byteLength + 1 });
      await expect(bootstrapRbCodexRuntime({
        runtime,
        installRoot: await temporaryRoot(),
        output: captureOutput().output,
        allowInsecureHttpForTests: true,
        verifyIdentity: verifiedIdentity,
        randomSuffix: () => "bad-content-length",
      })).rejects.toThrow("Content-Length mismatch");
    } finally {
      await close(server);
    }
  });

  it("removes a SHA-mismatched temporary file and preserves the existing final file", async () => {
    const existing = Buffer.from("existing-corrupt-runtime");
    const downloaded = Buffer.from("same-sized-wrong-bytes");
    const expected = Buffer.from("certified-right-bytes!");
    expect(downloaded.byteLength).toBe(expected.byteLength);
    const server = createServer((_request, response) => response.end(downloaded));
    const baseUrl = await listen(server);
    try {
      const root = await temporaryRoot();
      const runtime = fixtureRuntime(baseUrl, expected);
      const versionDirectory = join(root, "codex", runtime.version);
      const finalPath = join(versionDirectory, "rb-codex");
      await mkdir(versionDirectory, { recursive: true });
      await writeFile(finalPath, existing);
      await expect(bootstrapRbCodexRuntime({
        runtime,
        installRoot: root,
        output: captureOutput().output,
        allowInsecureHttpForTests: true,
        verifyIdentity: verifiedIdentity,
        randomSuffix: () => "sha-mismatch",
      })).rejects.toThrow("SHA-256 mismatch");
      expect(await readFile(finalPath)).toEqual(existing);
      expect(await readdir(versionDirectory)).toEqual(["rb-codex"]);
    } finally {
      await close(server);
    }
  });

  it("rejects a truncated download", async () => {
    const bytes = Buffer.from("truncated");
    const server = createServer((_request, response) => {
      response.setHeader("Transfer-Encoding", "chunked");
      response.write(bytes.subarray(0, 3));
      response.end();
    });
    const baseUrl = await listen(server);
    try {
      await expect(bootstrapRbCodexRuntime({
        runtime: fixtureRuntime(baseUrl, bytes),
        installRoot: await temporaryRoot(),
        output: captureOutput().output,
        allowInsecureHttpForTests: true,
        verifyIdentity: verifiedIdentity,
        randomSuffix: () => "truncated",
      })).rejects.toThrow("download size mismatch");
    } finally {
      await close(server);
    }
  });

  it("aborts when received bytes exceed the manifest bound", async () => {
    const expected = Buffer.from("bound");
    const server = createServer((_request, response) => {
      response.setHeader("Transfer-Encoding", "chunked");
      response.write(Buffer.from("beyond-bound"));
      response.end();
    });
    const baseUrl = await listen(server);
    try {
      await expect(bootstrapRbCodexRuntime({
        runtime: fixtureRuntime(baseUrl, expected),
        installRoot: await temporaryRoot(),
        output: captureOutput().output,
        allowInsecureHttpForTests: true,
        verifyIdentity: verifiedIdentity,
        randomSuffix: () => "exceeded",
      })).rejects.toThrow("exceeded expected size");
    } finally {
      await close(server);
    }
  });

  it("fails closed when the verified bytes report the wrong identity", async () => {
    const bytes = Buffer.from("runtime");
    const server = createServer((_request, response) => response.end(bytes));
    const baseUrl = await listen(server);
    try {
      await expect(bootstrapRbCodexRuntime({
        runtime: fixtureRuntime(baseUrl, bytes),
        installRoot: await temporaryRoot(),
        output: captureOutput().output,
        allowInsecureHttpForTests: true,
        verifyIdentity: async () => { throw new Error("identity rejected"); },
        randomSuffix: () => "identity-failure",
      })).rejects.toThrow("identity rejected");
    } finally {
      await close(server);
    }
  });

  it("skips every network request for an already verified runtime", async () => {
    const bytes = Buffer.from("already-installed");
    const root = await temporaryRoot();
    const runtime = fixtureRuntime("https://example.invalid/must-not-run", bytes);
    const finalPath = join(root, "codex", runtime.version, "rb-codex");
    await mkdir(join(root, "codex", runtime.version), { recursive: true });
    await writeFile(finalPath, bytes);
    await chmod(finalPath, 0o755);
    const capture = captureOutput();
    const result = await bootstrapRbCodexRuntime({
      runtime,
      installRoot: root,
      output: capture.output,
      verifyIdentity: verifiedIdentity,
    });
    expect(result).toMatchObject({ status: "already-installed", downloadedBytes: 0, networkRequestCount: 0 });
    expect(capture.lines.join("")).toContain("already installed and verified");
    expect(capture.lines.join("")).toContain("Skipping download");
  });

  it("replaces a corrupted runtime only after a valid replacement is verified", async () => {
    const existing = Buffer.from("corrupted");
    const certified = Buffer.from("certified");
    const server = createServer((_request, response) => response.end(certified));
    const baseUrl = await listen(server);
    try {
      const root = await temporaryRoot();
      const runtime = fixtureRuntime(baseUrl, certified);
      const versionDirectory = join(root, "codex", runtime.version);
      const finalPath = join(versionDirectory, "rb-codex");
      await mkdir(versionDirectory, { recursive: true });
      await writeFile(finalPath, existing);
      const capture = captureOutput();
      await bootstrapRbCodexRuntime({
        runtime,
        installRoot: root,
        output: capture.output,
        allowInsecureHttpForTests: true,
        verifyIdentity: async (path) => expect(await readFile(path)).toEqual(certified),
        randomSuffix: () => "corrupt-replacement",
      });
      expect(await readFile(finalPath)).toEqual(certified);
      expect(capture.lines.join("")).toContain("Reinstalling certified runtime");
    } finally {
      await close(server);
    }
  });

  it("leaves the legacy flat compatibility binary untouched", async () => {
    const bytes = Buffer.from("certified");
    const legacy = Buffer.from("legacy-manual-reference");
    const server = createServer((_request, response) => response.end(bytes));
    const baseUrl = await listen(server);
    try {
      const root = await temporaryRoot();
      const legacyPath = join(root, "rb-codex");
      await writeFile(legacyPath, legacy);
      await bootstrapRbCodexRuntime({
        runtime: fixtureRuntime(baseUrl, bytes),
        installRoot: root,
        output: captureOutput().output,
        allowInsecureHttpForTests: true,
        verifyIdentity: verifiedIdentity,
        randomSuffix: () => "legacy-preserved",
      });
      expect(await readFile(legacyPath)).toEqual(legacy);
    } finally {
      await close(server);
    }
  });

  it("emits bounded deterministic milestones for non-TTY output", () => {
    const capture = captureOutput(false);
    const reporter = createProgressReporter(capture.output, () => 1_000);
    reporter.start(100);
    reporter.update(55, 100);
    reporter.finish(100, 100);
    expect(capture.lines).toEqual([
      "Downloading RB Codex: 0%\n",
      "Downloading RB Codex: 10%\n",
      "Downloading RB Codex: 20%\n",
      "Downloading RB Codex: 30%\n",
      "Downloading RB Codex: 40%\n",
      "Downloading RB Codex: 50%\n",
      "Downloading RB Codex: 60%\n",
      "Downloading RB Codex: 70%\n",
      "Downloading RB Codex: 80%\n",
      "Downloading RB Codex: 90%\n",
      "Downloading RB Codex: 100%\n",
    ]);
  });

  it("rate-limits TTY output and includes bytes, total, speed, and ETA", () => {
    let clock = 0;
    const capture = captureOutput(true);
    const reporter = createProgressReporter(capture.output, () => clock);
    reporter.start(1024 * 1024);
    clock = 100;
    reporter.update(256 * 1024, 1024 * 1024);
    clock = 1_000;
    reporter.update(512 * 1024, 1024 * 1024);
    reporter.finish(1024 * 1024, 1024 * 1024);
    expect(capture.lines).toHaveLength(4);
    expect(capture.lines[1]).toContain("50%");
    expect(capture.lines[1]).toContain("0.5/1.0 MiB");
    expect(capture.lines[1]).toContain("MiB/s");
    expect(capture.lines[1]).toContain("ETA");
    expect(capture.lines.at(-1)).toBe("\n");
  });
});
