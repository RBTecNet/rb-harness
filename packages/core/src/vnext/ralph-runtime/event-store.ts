import { dirname, join, parse, resolve } from "node:path";
import { mkdir, open, readdir, readFile, rename, writeFile, lstat, readlink, link, unlink } from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";
import { canonicalEventBytes, type RalphEvent } from "./events.js";
import { validateRalphEvent } from "./events.js";
import { DurableLedgerDurabilityUnknownError, DurableOneEventPerFileLedger, type DurableLedgerCursor } from "./durable-ledger.js";

export const RALPH_EVENT_MAX = 100_000;
export const RALPH_EVENT_DIGITS = 12;
const EVENT_FILENAME = /^[0-9]{12}\.json$/;
const TEMP_FILENAME = /^\.[0-9]{12}\.json\.tmp-/;
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface RalphRuntimeStorageCapabilities {
  readonly sameFilesystemTemp: boolean;
  readonly fsyncFile: boolean;
  readonly exclusiveAtomicPublish: boolean;
  readonly fsyncDirectory: boolean;
}

export interface RalphRuntimeFileSystem {
  readonly capabilities: RalphRuntimeStorageCapabilities;
  readonly mkdir: (path: string, options?: { readonly recursive?: boolean; readonly mode?: number }) => Promise<void>;
  readonly writeFile: (path: string, data: string | Buffer, options?: { readonly flag?: string; readonly mode?: number }) => Promise<void>;
  readonly readFile: (path: string) => Promise<Buffer>;
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly link: (from: string, to: string) => Promise<void>;
  readonly unlink: (path: string) => Promise<void>;
  readonly readdir: (path: string) => Promise<readonly string[]>;
  readonly lstat: (path: string) => Promise<Stats>;
  readonly readlink: (path: string) => Promise<string>;
  readonly fsyncFile: (path: string) => Promise<void>;
  readonly fsyncDirectory: (path: string) => Promise<void>;
}

export const nodeRalphRuntimeFileSystem: RalphRuntimeFileSystem = {
  capabilities: { sameFilesystemTemp: true, fsyncFile: true, exclusiveAtomicPublish: true, fsyncDirectory: true },
  mkdir: async (path, options) => { await mkdir(path, options); },
  writeFile: async (path, data, options) => { await writeFile(path, data, options); },
  readFile: async (path) => readFile(path),
  rename,
  link,
  unlink,
  readdir: async (path) => (await readdir(path)).map((entry) => typeof entry === "string" ? entry : (entry as Dirent).name),
  lstat,
  readlink: async (path) => readlink(path, "utf8"),
  fsyncFile: async (path) => {
    const handle = await open(path, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  },
  fsyncDirectory: async (path) => {
    const handle = await open(path, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  },
};

export interface EventStoreOptions {
  /** Project root; runtime authority is derived below this boundary. */
  readonly projectRoot: string;
  readonly runId: string;
  readonly fs?: RalphRuntimeFileSystem;
  readonly nonce?: () => string;
}

export interface AppendEventResult {
  readonly sequence: number;
  readonly committed: boolean;
  readonly event: RalphEvent;
}

export interface LedgerInspection {
  readonly events: readonly RalphEvent[];
  readonly lastSequence: number;
  readonly lastEventHash: string | null;
}

type VerifiedLedgerCursor = DurableLedgerCursor;

export class RalphEventStoreError extends Error {
  constructor(readonly code: string, message = code) {
    super(message);
    this.name = "RalphEventStoreError";
  }
}

export function eventFileName(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > RALPH_EVENT_MAX) throw new Error("RALPH_INVALID_EVENT_SEQUENCE");
  return `${String(sequence).padStart(RALPH_EVENT_DIGITS, "0")}.json`;
}

export function isEventFileName(name: string): boolean { return EVENT_FILENAME.test(name); }
export function isEventTempFileName(name: string): boolean { return TEMP_FILENAME.test(name); }

export function validateRalphRunId(runId: string): void {
  if (!SAFE_RUN_ID.test(runId)) throw new RalphEventStoreError("RALPH_INVALID_RUN_ID");
}

export function resolveRalphRunDirectory(projectRoot: string, runId: string): string {
  validateRalphRunId(runId);
  return join(resolve(projectRoot), ".rb-harness", "ralph", "runs", runId);
}

export async function ensureRalphRuntimeLayout(
  fs: RalphRuntimeFileSystem,
  projectRoot: string,
  runtimeRoot: string,
  runDirectory: string,
  eventsDirectory: string,
  quarantineDirectory: string,
  stateDirectory: string,
): Promise<void> {
  assertDurabilityCapabilities(fs);
  await ensureNoSymlinkAncestors(fs, projectRoot);
  await ensureDirectory(fs, projectRoot, true);
  await ensureDirectory(fs, join(projectRoot, ".rb-harness"), false);
  await ensureDirectory(fs, runtimeRoot, false);
  await ensureDirectory(fs, join(runtimeRoot, "runs"), false);
  await ensureDirectory(fs, runDirectory, false);
  await ensureDirectory(fs, eventsDirectory, false);
  await ensureDirectory(fs, quarantineDirectory, false);
  await ensureDirectory(fs, stateDirectory, false);
}

export class RalphEventStore {
  readonly projectRoot: string;
  readonly runtimeRoot: string;
  readonly runDirectory: string;
  readonly eventsDirectory: string;
  readonly quarantineDirectory: string;
  readonly stateDirectory: string;
  private readonly fs: RalphRuntimeFileSystem;
  private readonly nonce: () => string;
  private readonly ledger: DurableOneEventPerFileLedger<RalphEvent>;

  constructor(private readonly options: EventStoreOptions) {
    if (typeof options.projectRoot !== "string" || options.projectRoot.length === 0) throw new RalphEventStoreError("RALPH_PROJECT_ROOT_INVALID");
    this.projectRoot = resolve(options.projectRoot);
    validateRalphRunId(options.runId);
    this.runtimeRoot = join(this.projectRoot, ".rb-harness", "ralph");
    this.runDirectory = resolveRalphRunDirectory(this.projectRoot, options.runId);
    this.eventsDirectory = join(this.runDirectory, "events");
    this.quarantineDirectory = join(this.runDirectory, "quarantine");
    this.stateDirectory = join(this.runDirectory, "state");
    this.fs = options.fs ?? nodeRalphRuntimeFileSystem;
    this.nonce = options.nonce ?? (() => `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    this.ledger = new DurableOneEventPerFileLedger({
      runId: options.runId,
      eventsDirectory: this.eventsDirectory,
      quarantineDirectory: this.quarantineDirectory,
      fileSystem: this.fs,
      nonce: this.nonce,
      maxEvents: RALPH_EVENT_MAX,
      eventFileName,
      isEventFileName,
      isEventTempFileName,
      createError: (code, message) => new RalphEventStoreError(code, message),
      codec: {
        validate: validateRalphEvent,
        canonicalBytes: canonicalEventBytes,
        runId: (event) => event.runId,
        sequence: (event) => event.sequence,
        eventHash: (event) => event.eventHash,
        previousEventHash: (event) => event.previousEventHash,
      },
      digits: RALPH_EVENT_DIGITS,
    });
  }

  get runId(): string { return this.options.runId; }
  get fileSystem(): RalphRuntimeFileSystem { return this.fs; }
  get verifiedCursor(): VerifiedLedgerCursor | undefined { return this.ledger.verifiedCursor; }

  async ensureLayout(): Promise<void> {
    await ensureRalphRuntimeLayout(
      this.fs,
      this.projectRoot,
      this.runtimeRoot,
      this.runDirectory,
      this.eventsDirectory,
      this.quarantineDirectory,
      this.stateDirectory,
    );
    await assertV1RunFamily(this.fs, this.runDirectory);
  }

  async inspect(): Promise<LedgerInspection> {
    await this.ensureLayout();
    return this.ledger.inspect();
  }

  async append(event: RalphEvent): Promise<AppendEventResult> {
    validateRalphEvent(event);
    if (event.runId !== this.runId) throw new RalphEventStoreError("RALPH_EVENT_FOREIGN_RUN");
    await this.ensureLayout();
    try {
      const result = await this.ledger.append(event);
      return { sequence: result.sequence, committed: result.committed, event: result.event };
    } catch (error) {
      // Preserve V1's established raw failure surface. V2 consumes the
      // richer typed uncertainty from the shared physical primitive.
      if (error instanceof DurableLedgerDurabilityUnknownError) throw error.cause;
      throw error;
    }
  }

  async quarantineTemporaryFiles(): Promise<readonly string[]> {
    await this.ensureLayout();
    return this.ledger.quarantineTemporaryFiles();
  }
}

async function assertV1RunFamily(fs: RalphRuntimeFileSystem, runDirectory: string): Promise<void> {
  const snapshotPath = join(runDirectory, "run-snapshot.json");
  let bytes: Buffer;
  try { bytes = await fs.readFile(snapshotPath); }
  catch (error) {
    if (isMissing(error)) return;
    throw error;
  }

  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); }
  catch { return; }
  if (
    parsed !== null
    && typeof parsed === "object"
    && "snapshotSchemaVersion" in parsed
    && (parsed as { snapshotSchemaVersion?: unknown }).snapshotSchemaVersion === "rb-ralph-run-snapshot/v2"
  ) {
    throw new RalphEventStoreError("RALPH_V1_RUN_SCHEMA_FAMILY_MISMATCH");
  }
}

export async function writeAtomicRuntimeFile(
  fs: RalphRuntimeFileSystem,
  finalPath: string,
  bytes: Buffer,
  nonce: string,
): Promise<void> {
  assertDurabilityCapabilities(fs);
  const directory = dirname(finalPath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${finalPath}.tmp-${nonce}`;
  await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
  await fs.fsyncFile(temporary);
  await fs.rename(temporary, finalPath);
  await fs.fsyncDirectory(directory);
}

/** Publish an immutable runtime file without a replace-capable rename race. */
export async function writeExclusiveRuntimeFile(
  fs: RalphRuntimeFileSystem,
  finalPath: string,
  bytes: Buffer,
  nonce: string,
): Promise<"created" | "already-present"> {
  assertDurabilityCapabilities(fs);
  const directory = dirname(finalPath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${finalPath}.tmp-${nonce}`;
  await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
  await fs.fsyncFile(temporary);
  try {
    await fs.link(temporary, finalPath);
  } catch (error) {
    if (!isExisting(error)) throw new RalphEventStoreError("RALPH_EXCLUSIVE_RUNTIME_PUBLISH_UNAVAILABLE", error instanceof Error ? error.message : String(error));
    const existing = await readRequired(fs, finalPath);
    await removeTemporary(fs, temporary, directory);
    if (!existing.equals(bytes)) throw new RalphEventStoreError("RALPH_RUNTIME_IMMUTABLE_VIOLATION");
    return "already-present";
  }
  await fs.fsyncDirectory(directory);
  await fs.unlink(temporary);
  await fs.fsyncDirectory(directory);
  return "created";
}

export async function readRuntimeFile(fs: RalphRuntimeFileSystem, path: string): Promise<Buffer> {
  return fs.readFile(path);
}

function assertDurabilityCapabilities(fs: RalphRuntimeFileSystem): void {
  if (!fs.capabilities.sameFilesystemTemp || !fs.capabilities.fsyncFile || !fs.capabilities.exclusiveAtomicPublish || !fs.capabilities.fsyncDirectory) {
    throw new RalphEventStoreError("RALPH_STORAGE_DURABILITY_UNSUPPORTED");
  }
}

async function ensureNoSymlinkAncestors(fs: RalphRuntimeFileSystem, path: string): Promise<void> {
  const parsed = parse(path);
  let current = parsed.root;
  for (const component of parsed.dir.split("/").filter(Boolean).concat(parsed.base ? [parsed.base] : [])) {
    current = join(current, component);
    try {
      const stats = await fs.lstat(current);
      if (stats.isSymbolicLink()) throw new RalphEventStoreError("RALPH_RUNTIME_PATH_SYMLINK_ESCAPE", `RALPH_RUNTIME_PATH_SYMLINK_ESCAPE: ${current}`);
    } catch (error) {
      if (isMissing(error)) break;
      throw error;
    }
  }
}

async function ensureDirectory(fs: RalphRuntimeFileSystem, path: string, projectRoot: boolean): Promise<void> {
  try {
    const stats = await fs.lstat(path);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new RalphEventStoreError(projectRoot ? "RALPH_PROJECT_ROOT_INVALID" : "RALPH_RUNTIME_PATH_SYMLINK_ESCAPE", `${projectRoot ? "RALPH_PROJECT_ROOT_INVALID" : "RALPH_RUNTIME_PATH_SYMLINK_ESCAPE"}: ${path}`);
    return;
  } catch (error) {
    if (!isMissing(error)) throw error;
    if (projectRoot) throw new RalphEventStoreError("RALPH_PROJECT_ROOT_INVALID");
  }
  try { await fs.mkdir(path, { recursive: false, mode: 0o700 }); } catch (error) { if (!isExisting(error)) throw error; }
  const stats = await fs.lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new RalphEventStoreError("RALPH_RUNTIME_PATH_SYMLINK_ESCAPE", `RALPH_RUNTIME_PATH_SYMLINK_ESCAPE: ${path}`);
}

async function readRequired(fs: RalphRuntimeFileSystem, path: string): Promise<Buffer> {
  try { return await fs.readFile(path); } catch { throw new RalphEventStoreError("RALPH_EVENT_TARGET_DISAPPEARED"); }
}

async function removeTemporary(fs: RalphRuntimeFileSystem, path: string, directory: string): Promise<void> {
  try { await fs.unlink(path); } catch (error) { if (!isMissing(error)) throw error; }
  await fs.fsyncDirectory(directory);
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT");
}

function isExisting(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "EEXIST");
}
