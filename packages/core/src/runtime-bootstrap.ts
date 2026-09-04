import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { get as httpGet, type IncomingMessage } from "node:http";
import { get as httpsGet } from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  managedRuntimePlatformKey,
  RB_CODEX_RUNTIME,
  type ManagedExternalRuntime,
  type ManagedRuntimePlatform,
} from "./external-runtime-manifest.js";

const execFile = promisify(execFileCallback);
const MAX_REDIRECTS = 5;
const PROGRESS_INTERVAL_MS = 200;
const NON_TTY_MILESTONES = Object.freeze([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);

export interface ProgressSnapshot {
  readonly downloadedBytes: number;
  readonly totalBytes: number;
  readonly percentage: number;
  readonly bytesPerSecond: number;
  readonly etaSeconds?: number;
}

export interface ProgressOutput {
  readonly isTTY?: boolean;
  write(value: string): unknown;
}

export interface RuntimeProgressReporter {
  start(totalBytes: number): void;
  update(downloadedBytes: number, totalBytes: number): void;
  finish(downloadedBytes: number, totalBytes: number): void;
}

export interface DownloadResult {
  readonly downloadedBytes: number;
  readonly sha256: string;
  readonly requestCount: number;
}

export interface RuntimeInstallResult {
  readonly status: "installed" | "already-installed" | "unsupported";
  readonly platformKey: string;
  readonly installedPath?: string;
  readonly downloadedBytes: number;
  readonly networkRequestCount: number;
}

export interface BootstrapRuntimeOptions {
  readonly runtime?: ManagedExternalRuntime;
  readonly platform?: NodeJS.Platform | string;
  readonly architecture?: string;
  readonly installRoot?: string;
  readonly output?: ProgressOutput;
  readonly allowInsecureHttpForTests?: boolean;
  readonly now?: () => number;
  readonly randomSuffix?: () => string;
  readonly verifyIdentity?: (binaryPath: string, expectedIdentity: string) => Promise<void>;
}

export interface DownloadRuntimeOptions {
  readonly source: ManagedRuntimePlatform;
  readonly destination: string;
  readonly progress: RuntimeProgressReporter;
  readonly allowInsecureHttpForTests?: boolean;
}

export function calculateProgress(
  downloadedBytes: number,
  totalBytes: number,
  startedAtMs: number,
  nowMs: number,
): ProgressSnapshot {
  const boundedDownloaded = Math.max(0, Math.min(downloadedBytes, totalBytes));
  const percentage = totalBytes === 0 ? 100 : Math.max(0, Math.min(100, (boundedDownloaded / totalBytes) * 100));
  const elapsedSeconds = Math.max(0, nowMs - startedAtMs) / 1_000;
  const bytesPerSecond = elapsedSeconds > 0 ? boundedDownloaded / elapsedSeconds : 0;
  const remainingBytes = Math.max(0, totalBytes - boundedDownloaded);
  const etaSeconds = bytesPerSecond > 0 && elapsedSeconds >= 0.5 ? remainingBytes / bytesPerSecond : undefined;
  return { downloadedBytes, totalBytes, percentage, bytesPerSecond, etaSeconds };
}

function formatMebibytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

function formatTtyProgress(snapshot: ProgressSnapshot): string {
  const width = 20;
  const completed = Math.round((snapshot.percentage / 100) * width);
  const bar = `${"█".repeat(completed)}${"░".repeat(width - completed)}`;
  const speed = `${formatMebibytes(snapshot.bytesPerSecond)} MiB/s`;
  const eta = snapshot.etaSeconds === undefined ? "" : ` ETA ${Math.ceil(snapshot.etaSeconds)}s`;
  return `Downloading [${bar}] ${Math.floor(snapshot.percentage)}% ${formatMebibytes(snapshot.downloadedBytes)}/${formatMebibytes(snapshot.totalBytes)} MiB ${speed}${eta}`;
}

export function createProgressReporter(
  output: ProgressOutput,
  now: () => number = Date.now,
): RuntimeProgressReporter {
  const tty = output.isTTY === true;
  let startedAtMs = 0;
  let lastRenderMs = Number.NEGATIVE_INFINITY;
  let lastTtyLength = 0;
  let nextMilestoneIndex = 0;

  const render = (downloadedBytes: number, totalBytes: number, force: boolean): void => {
    const current = now();
    const snapshot = calculateProgress(downloadedBytes, totalBytes, startedAtMs, current);
    if (tty) {
      if (!force && current - lastRenderMs < PROGRESS_INTERVAL_MS) return;
      const line = formatTtyProgress(snapshot);
      output.write(`\r${line}${" ".repeat(Math.max(0, lastTtyLength - line.length))}`);
      lastTtyLength = line.length;
      lastRenderMs = current;
      return;
    }
    while (
      nextMilestoneIndex < NON_TTY_MILESTONES.length
      && snapshot.percentage >= (NON_TTY_MILESTONES[nextMilestoneIndex] ?? 101)
    ) {
      output.write(`Downloading RB Codex: ${NON_TTY_MILESTONES[nextMilestoneIndex]}%\n`);
      nextMilestoneIndex += 1;
    }
  };

  return {
    start(totalBytes) {
      startedAtMs = now();
      render(0, totalBytes, true);
    },
    update(downloadedBytes, totalBytes) {
      render(downloadedBytes, totalBytes, false);
    },
    finish(downloadedBytes, totalBytes) {
      render(downloadedBytes, totalBytes, true);
      if (tty) output.write("\n");
    },
  };
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function responseFor(url: URL, allowInsecureHttpForTests: boolean): Promise<IncomingMessage> {
  if (url.protocol !== "https:" && !(allowInsecureHttpForTests && url.protocol === "http:")) {
    return Promise.reject(new Error(`RB Codex download requires HTTPS: ${url.protocol}`));
  }
  const get = url.protocol === "https:" ? httpsGet : httpGet;
  return new Promise((resolve, reject) => {
    const request = get(
      url,
      {
        headers: {
          Accept: "application/octet-stream",
          "User-Agent": "rb-harness-runtime-bootstrap/1",
        },
      },
      resolve,
    );
    request.on("error", reject);
  });
}

async function followedResponse(
  initialUrl: string,
  allowInsecureHttpForTests: boolean,
): Promise<{ response: IncomingMessage; requestCount: number }> {
  let url = new URL(initialUrl);
  let requestCount = 0;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = await responseFor(url, allowInsecureHttpForTests);
    requestCount += 1;
    if (response.statusCode !== undefined && response.statusCode >= 300 && response.statusCode < 400) {
      const location = response.headers.location;
      response.resume();
      if (!location) throw new Error("RB Codex download redirect omitted Location");
      if (redirects === MAX_REDIRECTS) throw new Error(`RB Codex download exceeded ${MAX_REDIRECTS} redirects`);
      const redirected = new URL(location, url);
      if (url.protocol === "https:" && redirected.protocol !== "https:") {
        throw new Error("RB Codex download refused an HTTPS downgrade redirect");
      }
      url = redirected;
      continue;
    }
    if (response.statusCode !== 200) {
      response.resume();
      throw new Error(`RB Codex download failed with HTTP ${response.statusCode ?? "unknown"}`);
    }
    return { response, requestCount };
  }
  throw new Error("RB Codex download redirect limit exhausted");
}

export async function downloadRuntimeAsset(options: DownloadRuntimeOptions): Promise<DownloadResult> {
  const { response, requestCount } = await followedResponse(
    options.source.downloadUrl,
    options.allowInsecureHttpForTests === true,
  );
  const contentLength = response.headers["content-length"];
  if (contentLength !== undefined) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared !== options.source.expectedSize) {
      response.resume();
      throw new Error(
        `RB Codex Content-Length mismatch: expected ${options.source.expectedSize}, received ${contentLength}`,
      );
    }
  }

  const handle = await open(options.destination, "wx", 0o600);
  let downloadedBytes = 0;
  options.progress.start(options.source.expectedSize);
  try {
    for await (const rawChunk of response) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      downloadedBytes += chunk.byteLength;
      if (downloadedBytes > options.source.expectedSize) {
        response.destroy();
        throw new Error(`RB Codex download exceeded expected size ${options.source.expectedSize}`);
      }
      await handle.write(chunk);
      options.progress.update(downloadedBytes, options.source.expectedSize);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  options.progress.finish(downloadedBytes, options.source.expectedSize);
  if (downloadedBytes !== options.source.expectedSize) {
    throw new Error(
      `RB Codex download size mismatch: expected ${options.source.expectedSize}, received ${downloadedBytes}`,
    );
  }
  return {
    downloadedBytes,
    sha256: await sha256File(options.destination),
    requestCount,
  };
}

async function defaultVerifyIdentity(binaryPath: string, expectedIdentity: string): Promise<void> {
  const result = await execFile(binaryPath, ["--version"], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 64 * 1024,
  });
  const actual = result.stdout.trim();
  if (actual !== expectedIdentity) {
    throw new Error(`RB Codex runtime identity mismatch: expected ${expectedIdentity}; received ${actual}`);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function bootstrapRbCodexRuntime(
  options: BootstrapRuntimeOptions = {},
): Promise<RuntimeInstallResult> {
  const runtime = options.runtime ?? RB_CODEX_RUNTIME;
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  const platformKey = managedRuntimePlatformKey(runtime, platform, architecture);
  const displayPlatform = `${platform}-${architecture}`;
  const output = options.output ?? process.stdout;
  if (!platformKey) {
    output.write("RB-Codex runtime is not available for this platform.\n");
    output.write(`Codex subscription runtime is unavailable for ${displayPlatform}.\n`);
    return {
      status: "unsupported",
      platformKey: displayPlatform,
      downloadedBytes: 0,
      networkRequestCount: 0,
    };
  }

  const source = runtime.platforms[platformKey];
  if (!source) throw new Error(`RB Codex manifest is missing platform ${platformKey}`);
  const installRoot = options.installRoot ?? join(homedir(), ".local", "libexec", "rb-harness");
  const versionDirectory = join(installRoot, "codex", runtime.version);
  const finalPath = join(versionDirectory, runtime.installedFilename);
  const verifyIdentity = options.verifyIdentity ?? defaultVerifyIdentity;
  output.write(`      Platform: ${platformKey}\n`);

  if (await pathExists(finalPath)) {
    const existingSha = await sha256File(finalPath);
    if (existingSha === source.sha256) {
      await verifyIdentity(finalPath, runtime.expectedIdentity);
      const metadata = await stat(finalPath);
      if ((metadata.mode & 0o111) === 0) throw new Error("Verified RB Codex runtime is not executable");
      output.write(`RB Codex ${runtime.version} already installed and verified.\n`);
      output.write("Skipping download.\n");
      return {
        status: "already-installed",
        platformKey,
        installedPath: finalPath,
        downloadedBytes: 0,
        networkRequestCount: 0,
      };
    }
    output.write("Existing RB Codex runtime failed integrity verification.\n");
    output.write("Reinstalling certified runtime...\n");
  }

  await mkdir(versionDirectory, { recursive: true, mode: 0o755 });
  const suffix = options.randomSuffix?.() ?? `${process.pid}-${randomBytes(8).toString("hex")}`;
  const temporaryPath = join(versionDirectory, `${runtime.installedFilename}.download-${suffix}`);
  const progress = createProgressReporter(output, options.now);
  let download: DownloadResult | undefined;
  try {
    download = await downloadRuntimeAsset({
      source,
      destination: temporaryPath,
      progress,
      allowInsecureHttpForTests: options.allowInsecureHttpForTests,
    });
    if (download.sha256 !== source.sha256) {
      throw new Error(`RB Codex SHA-256 mismatch: expected ${source.sha256}, received ${download.sha256}`);
    }
    output.write("      Verifying SHA-256... OK\n");
    await chmod(temporaryPath, 0o755);
    await rename(temporaryPath, finalPath);
    await syncDirectory(versionDirectory);

    const installedSha = await sha256File(finalPath);
    if (installedSha !== source.sha256) throw new Error("Installed RB Codex SHA-256 changed after atomic rename");
    const metadata = await stat(finalPath);
    if ((metadata.mode & 0o111) === 0) throw new Error("Installed RB Codex runtime is not executable");
    await verifyIdentity(finalPath, runtime.expectedIdentity);
    output.write("      Verifying runtime identity... OK\n");
    output.write(`      Installed: ${finalPath}\n`);
    return {
      status: "installed",
      platformKey,
      installedPath: finalPath,
      downloadedBytes: download.downloadedBytes,
      networkRequestCount: download.requestCount,
    };
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export function managedRbCodexInstallPath(installRoot?: string): string {
  const root = installRoot ?? join(homedir(), ".local", "libexec", "rb-harness");
  return join(root, "codex", RB_CODEX_RUNTIME.version, RB_CODEX_RUNTIME.installedFilename);
}

export { RB_CODEX_RUNTIME } from "./external-runtime-manifest.js";
