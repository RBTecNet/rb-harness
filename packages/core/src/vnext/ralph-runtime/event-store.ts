import { dirname, join, parse, resolve } from "node:path";
import { mkdir, open, readdir, readFile, rename, writeFile, lstat, readlink, link, unlink } from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";
import { canonicalEventBytes, type RalphEvent } from "./events.js";
import { canonicalJson } from "./canonical-json.js";
import { validateRalphEvent } from "./events.js";

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

interface VerifiedLedgerCursor {
  readonly runId: string;
  readonly lastSequence: number;
  readonly lastEventHash: string | null;
}

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

export class RalphEventStore {
  readonly projectRoot: string;
  readonly runtimeRoot: string;
  readonly runDirectory: string;
  readonly eventsDirectory: string;
  readonly quarantineDirectory: string;
  readonly stateDirectory: string;
  private readonly fs: RalphRuntimeFileSystem;
  private readonly nonce: () => string;
  private cursor: VerifiedLedgerCursor | undefined;

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
  }

  get runId(): string { return this.options.runId; }
  get fileSystem(): RalphRuntimeFileSystem { return this.fs; }
  get verifiedCursor(): VerifiedLedgerCursor | undefined { return this.cursor; }

  async ensureLayout(): Promise<void> {
    assertDurabilityCapabilities(this.fs);
    await ensureNoSymlinkAncestors(this.fs, this.projectRoot);
    await ensureDirectory(this.fs, this.projectRoot, true);
    await ensureDirectory(this.fs, join(this.projectRoot, ".rb-harness"), false);
    await ensureDirectory(this.fs, this.runtimeRoot, false);
    await ensureDirectory(this.fs, join(this.runtimeRoot, "runs"), false);
    await ensureDirectory(this.fs, this.runDirectory, false);
    await ensureDirectory(this.fs, this.eventsDirectory, false);
    await ensureDirectory(this.fs, this.quarantineDirectory, false);
    await ensureDirectory(this.fs, this.stateDirectory, false);
  }

  async inspect(): Promise<LedgerInspection> {
    await this.ensureLayout();
    let names: readonly string[];
    try { names = await this.fs.readdir(this.eventsDirectory); }
    catch (error) {
      if (isMissing(error)) {
        const empty = { events: [], lastSequence: 0, lastEventHash: null } as const;
        this.cursor = { runId: this.runId, lastSequence: 0, lastEventHash: null };
        return empty;
      }
      throw error;
    }
    const finalNames = names.filter(isEventFileName).sort();
    const unknownNames = names.filter((name) => !isEventFileName(name) && !isEventTempFileName(name));
    if (unknownNames.length > 0) throw new RalphEventStoreError("RALPH_EVENT_LEDGER_INVALID_FILENAME", `RALPH_EVENT_LEDGER_INVALID_FILENAME: ${unknownNames.sort().join(",")}`);
    if (finalNames.length > RALPH_EVENT_MAX) throw new RalphEventStoreError("RALPH_EVENT_LEDGER_CAPACITY_EXCEEDED");

    const events: RalphEvent[] = [];
    let previousHash: string | null = null;
    for (let index = 0; index < finalNames.length; index += 1) {
      const name = finalNames[index];
      if (name === undefined) throw new RalphEventStoreError("RALPH_EVENT_LEDGER_INTERNAL_INDEX");
      const sequence = Number(name.slice(0, RALPH_EVENT_DIGITS));
      if (sequence !== index + 1) throw new RalphEventStoreError("RALPH_EVENT_LEDGER_GAP");
      const path = join(this.eventsDirectory, name);
      let bytes: Buffer;
      try { bytes = await this.fs.readFile(path); } catch { throw new RalphEventStoreError("RALPH_EVENT_LEDGER_READ_FAILED", `RALPH_EVENT_LEDGER_READ_FAILED: ${name}`); }
      let parsed: unknown;
      try { parsed = JSON.parse(bytes.toString("utf8")); } catch { throw new RalphEventStoreError("RALPH_EVENT_LEDGER_MALFORMED_JSON", `RALPH_EVENT_LEDGER_MALFORMED_JSON: ${name}`); }
      try { validateRalphEvent(parsed); } catch (error) { throw new RalphEventStoreError("RALPH_EVENT_LEDGER_SCHEMA_INVALID", `${name}: ${error instanceof Error ? error.message : String(error)}`); }
      const event = parsed as RalphEvent;
      if (event.runId !== this.runId) throw new RalphEventStoreError("RALPH_EVENT_LEDGER_FOREIGN_RUN");
      if (event.sequence !== sequence) throw new RalphEventStoreError("RALPH_EVENT_LEDGER_SEQUENCE_MISMATCH");
      if (event.previousEventHash !== previousHash) throw new RalphEventStoreError("RALPH_EVENT_LEDGER_HASH_CHAIN_MISMATCH");
      if (bytes.toString("utf8") !== canonicalJson(event)) throw new RalphEventStoreError("RALPH_EVENT_LEDGER_NON_CANONICAL", `RALPH_EVENT_LEDGER_NON_CANONICAL: ${name}`);
      events.push(event);
      previousHash = event.eventHash;
    }
    const result = { events, lastSequence: events.length, lastEventHash: previousHash };
    this.cursor = { runId: this.runId, lastSequence: result.lastSequence, lastEventHash: result.lastEventHash };
    return result;
  }

  async append(event: RalphEvent): Promise<AppendEventResult> {
    validateRalphEvent(event);
    if (event.runId !== this.runId) throw new RalphEventStoreError("RALPH_EVENT_FOREIGN_RUN");
    await this.ensureLayout();
    const cursor = await this.ensureVerifiedCursor();
    await this.verifyCursorTail(cursor);
    if (event.sequence > RALPH_EVENT_MAX) throw new RalphEventStoreError("RALPH_EVENT_LEDGER_CAPACITY_EXCEEDED");
    const target = join(this.eventsDirectory, eventFileName(event.sequence));
    const bytes = canonicalEventBytes(event);

    if (event.sequence <= cursor.lastSequence) {
      const existing = await readRequired(this.fs, target);
      if (existing.equals(bytes)) return { sequence: event.sequence, committed: false, event };
      throw new RalphEventStoreError("RALPH_EVENT_SEQUENCE_FORK");
    }
    if (event.sequence !== cursor.lastSequence + 1) throw new RalphEventStoreError("RALPH_EVENT_SEQUENCE_NOT_NEXT");
    if (event.previousEventHash !== cursor.lastEventHash) throw new RalphEventStoreError("RALPH_EVENT_PREVIOUS_HASH_MISMATCH");

    const temporary = join(this.eventsDirectory, `.${eventFileName(event.sequence)}.tmp-${this.nonce()}`);
    await this.fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await this.fs.fsyncFile(temporary);
    try {
      await this.fs.link(temporary, target);
    } catch (error) {
      if (!isExisting(error)) {
        this.cursor = undefined;
        throw new RalphEventStoreError("RALPH_EVENT_EXCLUSIVE_PUBLISH_UNAVAILABLE", error instanceof Error ? error.message : String(error));
      }
      const existing = await readRequired(this.fs, target);
      await removeTemporary(this.fs, temporary, this.eventsDirectory);
      await this.inspect();
      if (existing.equals(bytes)) return { sequence: event.sequence, committed: false, event };
      throw new RalphEventStoreError("RALPH_EVENT_SEQUENCE_FORK");
    }

    try {
      await this.fs.fsyncDirectory(this.eventsDirectory);
      await this.fs.unlink(temporary);
      await this.fs.fsyncDirectory(this.eventsDirectory);
    } catch (error) {
      this.cursor = undefined;
      throw error;
    }
    this.cursor = { runId: this.runId, lastSequence: event.sequence, lastEventHash: event.eventHash };
    return { sequence: event.sequence, committed: true, event };
  }

  async quarantineTemporaryFiles(): Promise<readonly string[]> {
    await this.ensureLayout();
    const names = (await this.fs.readdir(this.eventsDirectory)).filter(isEventTempFileName).sort();
    const quarantined: string[] = [];
    for (const name of names) {
      const destination = join(this.quarantineDirectory, `event-${name.slice(1)}`);
      await this.fs.rename(join(this.eventsDirectory, name), destination);
      quarantined.push(destination);
    }
    if (quarantined.length > 0) await this.fs.fsyncDirectory(this.quarantineDirectory);
    if (quarantined.length > 0) await this.fs.fsyncDirectory(this.eventsDirectory);
    return quarantined;
  }

  private async ensureVerifiedCursor(): Promise<VerifiedLedgerCursor> {
    if (this.cursor?.runId === this.runId) return this.cursor;
    const ledger = await this.inspect();
    return { runId: this.runId, lastSequence: ledger.lastSequence, lastEventHash: ledger.lastEventHash };
  }

  private async verifyCursorTail(cursor: VerifiedLedgerCursor): Promise<void> {
    if (cursor.lastSequence === 0) return;
    try {
      const bytes = await readRequired(this.fs, join(this.eventsDirectory, eventFileName(cursor.lastSequence)));
      let parsed: unknown;
      try { parsed = JSON.parse(bytes.toString("utf8")); } catch { throw new RalphEventStoreError("RALPH_EVENT_LEDGER_MALFORMED_JSON"); }
      validateRalphEvent(parsed);
      const event = parsed as RalphEvent;
      if (event.runId !== this.runId || event.sequence !== cursor.lastSequence || event.eventHash !== cursor.lastEventHash || bytes.toString("utf8") !== canonicalJson(event)) {
        throw new RalphEventStoreError("RALPH_EVENT_LEDGER_CURSOR_INVALID");
      }
    } catch (error) {
      this.cursor = undefined;
      throw error;
    }
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
