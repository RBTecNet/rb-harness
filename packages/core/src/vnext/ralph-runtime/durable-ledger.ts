import { join } from "node:path";
import type { RalphRuntimeFileSystem } from "./event-store.js";

export interface DurableLedgerCodec<T> {
  readonly validate: (value: unknown) => asserts value is T;
  readonly canonicalBytes: (value: T) => Buffer;
  readonly runId: (value: T) => string;
  readonly sequence: (value: T) => number;
  readonly eventHash: (value: T) => string;
  readonly previousEventHash: (value: T) => string | null;
}

export interface DurableLedgerCursor {
  readonly runId: string;
  readonly lastSequence: number;
  readonly lastEventHash: string | null;
}

export interface DurableLedgerInspection<T> {
  readonly events: readonly T[];
  readonly lastSequence: number;
  readonly lastEventHash: string | null;
}

export interface DurableLedgerAppendResult<T> {
  readonly sequence: number;
  readonly committed: boolean;
  readonly event: T;
  readonly eventDurability: "DURABLE";
  readonly publishDisposition: "PUBLISHED_BY_THIS_CALL" | "ALREADY_PRESENT";
}

export class DurableLedgerDurabilityUnknownError extends Error {
  readonly code = "RALPH_EVENT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION" as const;
  readonly eventDurability = "UNKNOWN_REQUIRES_INSPECTION" as const;
  readonly requiresInspection = true as const;

  constructor(
    readonly sequence: number,
    readonly eventHash: string,
    readonly cause: unknown,
  ) {
    super(`RALPH_EVENT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION: sequence=${sequence}`);
    this.name = "DurableLedgerDurabilityUnknownError";
  }
}

export class DurableLedgerInspectionRequiredError extends Error {
  readonly code = "RALPH_EVENT_DURABILITY_INSPECTION_REQUIRED" as const;
  readonly eventDurability = "UNKNOWN_REQUIRES_INSPECTION" as const;
  readonly requiresInspection = true as const;

  constructor() {
    super("RALPH_EVENT_DURABILITY_INSPECTION_REQUIRED");
    this.name = "DurableLedgerInspectionRequiredError";
  }
}

export interface DurableLedgerOptions<T> {
  readonly runId: string;
  readonly eventsDirectory: string;
  readonly quarantineDirectory: string;
  readonly fileSystem: RalphRuntimeFileSystem;
  readonly nonce: () => string;
  readonly codec: DurableLedgerCodec<T>;
  readonly maxEvents: number;
  readonly digits: number;
  readonly eventFileName: (sequence: number) => string;
  readonly isEventFileName: (name: string) => boolean;
  readonly isEventTempFileName: (name: string) => boolean;
  readonly createError: (code: string, message?: string) => Error;
  readonly requireExplicitInspectionAfterUnknown?: boolean;
}

/**
 * Schema-neutral physical one-event-per-file ledger.
 *
 * Semantic validation, canonicalization, identity extraction and error
 * vocabulary remain supplied by the facade. This class owns only the
 * audited physical ordering and verified-tail optimization.
 */
export class DurableOneEventPerFileLedger<T> {
  private cursor: DurableLedgerCursor | undefined;
  private inspectionRequired = false;

  constructor(private readonly options: DurableLedgerOptions<T>) {}

  get verifiedCursor(): DurableLedgerCursor | undefined { return this.cursor; }

  async inspect(): Promise<DurableLedgerInspection<T>> {
    this.assertDurabilityCapabilities();
    let names: readonly string[];
    try { names = await this.options.fileSystem.readdir(this.options.eventsDirectory); }
    catch (error) {
      if (isMissing(error)) {
        const empty = { events: [], lastSequence: 0, lastEventHash: null } as const;
        this.cursor = { runId: this.options.runId, lastSequence: 0, lastEventHash: null };
        this.inspectionRequired = false;
        return empty;
      }
      throw error;
    }

    const finalNames = names.filter(this.options.isEventFileName).sort();
    const unknownNames = names.filter((name) => !this.options.isEventFileName(name) && !this.options.isEventTempFileName(name));
    if (unknownNames.length > 0) {
      throw this.options.createError("RALPH_EVENT_LEDGER_INVALID_FILENAME", `RALPH_EVENT_LEDGER_INVALID_FILENAME: ${unknownNames.sort().join(",")}`);
    }
    if (finalNames.length > this.options.maxEvents) throw this.options.createError("RALPH_EVENT_LEDGER_CAPACITY_EXCEEDED");

    const events: T[] = [];
    let previousHash: string | null = null;
    for (let index = 0; index < finalNames.length; index += 1) {
      const name = finalNames[index];
      if (name === undefined) throw this.options.createError("RALPH_EVENT_LEDGER_INTERNAL_INDEX");
      const sequence = Number(name.slice(0, this.options.digits));
      if (sequence !== index + 1) throw this.options.createError("RALPH_EVENT_LEDGER_GAP");

      const path = join(this.options.eventsDirectory, name);
      let bytes: Buffer;
      try { bytes = await this.options.fileSystem.readFile(path); }
      catch { throw this.options.createError("RALPH_EVENT_LEDGER_READ_FAILED", `RALPH_EVENT_LEDGER_READ_FAILED: ${name}`); }

      let parsed: unknown;
      try { parsed = JSON.parse(bytes.toString("utf8")); }
      catch { throw this.options.createError("RALPH_EVENT_LEDGER_MALFORMED_JSON", `RALPH_EVENT_LEDGER_MALFORMED_JSON: ${name}`); }

      try { this.options.codec.validate(parsed); }
      catch (error) {
        throw this.options.createError("RALPH_EVENT_LEDGER_SCHEMA_INVALID", `${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
      const event = parsed as T;
      if (this.options.codec.runId(event) !== this.options.runId) throw this.options.createError("RALPH_EVENT_LEDGER_FOREIGN_RUN");
      if (this.options.codec.sequence(event) !== sequence) throw this.options.createError("RALPH_EVENT_LEDGER_SEQUENCE_MISMATCH");
      if (this.options.codec.previousEventHash(event) !== previousHash) throw this.options.createError("RALPH_EVENT_LEDGER_HASH_CHAIN_MISMATCH");
      if (!bytes.equals(this.options.codec.canonicalBytes(event))) {
        throw this.options.createError("RALPH_EVENT_LEDGER_NON_CANONICAL", `RALPH_EVENT_LEDGER_NON_CANONICAL: ${name}`);
      }
      events.push(event);
      previousHash = this.options.codec.eventHash(event);
    }

    const result = { events, lastSequence: events.length, lastEventHash: previousHash };
    this.cursor = { runId: this.options.runId, lastSequence: result.lastSequence, lastEventHash: result.lastEventHash };
    this.inspectionRequired = false;
    return result;
  }

  async append(event: T): Promise<DurableLedgerAppendResult<T>> {
    if (this.options.requireExplicitInspectionAfterUnknown && this.inspectionRequired) {
      throw new DurableLedgerInspectionRequiredError();
    }
    this.options.codec.validate(event);
    if (this.options.codec.runId(event) !== this.options.runId) throw this.options.createError("RALPH_EVENT_FOREIGN_RUN");

    const cursor = await this.ensureVerifiedCursor();
    await this.verifyCursorTail(cursor);
    const sequence = this.options.codec.sequence(event);
    if (sequence > this.options.maxEvents) throw this.options.createError("RALPH_EVENT_LEDGER_CAPACITY_EXCEEDED");

    const target = join(this.options.eventsDirectory, this.options.eventFileName(sequence));
    const bytes = this.options.codec.canonicalBytes(event);

    if (sequence <= cursor.lastSequence) {
      const existing = await readRequired(this.options.fileSystem, target, this.options.createError);
      if (existing.equals(bytes)) {
        return {
          sequence,
          committed: false,
          event,
          eventDurability: "DURABLE",
          publishDisposition: "ALREADY_PRESENT",
        };
      }
      throw this.options.createError("RALPH_EVENT_SEQUENCE_FORK");
    }
    if (sequence !== cursor.lastSequence + 1) throw this.options.createError("RALPH_EVENT_SEQUENCE_NOT_NEXT");
    if (this.options.codec.previousEventHash(event) !== cursor.lastEventHash) {
      throw this.options.createError("RALPH_EVENT_PREVIOUS_HASH_MISMATCH");
    }

    const temporary = join(this.options.eventsDirectory, `.${this.options.eventFileName(sequence)}.tmp-${this.options.nonce()}`);
    await this.options.fileSystem.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await this.options.fileSystem.fsyncFile(temporary);
    try {
      await this.options.fileSystem.link(temporary, target);
    } catch (error) {
      if (!isExisting(error)) {
        this.cursor = undefined;
        throw this.options.createError("RALPH_EVENT_EXCLUSIVE_PUBLISH_UNAVAILABLE", error instanceof Error ? error.message : String(error));
      }
      const existing = await readRequired(this.options.fileSystem, target, this.options.createError);
      await removeTemporary(this.options.fileSystem, temporary, this.options.eventsDirectory);
      await this.inspect();
      if (existing.equals(bytes)) {
        return {
          sequence,
          committed: false,
          event,
          eventDurability: "DURABLE",
          publishDisposition: "ALREADY_PRESENT",
        };
      }
      throw this.options.createError("RALPH_EVENT_SEQUENCE_FORK");
    }

    try {
      await this.options.fileSystem.fsyncDirectory(this.options.eventsDirectory);
    } catch (error) {
      this.cursor = undefined;
      this.inspectionRequired = true;
      throw new DurableLedgerDurabilityUnknownError(sequence, this.options.codec.eventHash(event), error);
    }
    try {
      await this.options.fileSystem.unlink(temporary);
      await this.options.fileSystem.fsyncDirectory(this.options.eventsDirectory);
    } catch (error) {
      this.cursor = undefined;
      throw error;
    }

    this.cursor = {
      runId: this.options.runId,
      lastSequence: sequence,
      lastEventHash: this.options.codec.eventHash(event),
    };
    return {
      sequence,
      committed: true,
      event,
      eventDurability: "DURABLE",
      publishDisposition: "PUBLISHED_BY_THIS_CALL",
    };
  }

  async quarantineTemporaryFiles(): Promise<readonly string[]> {
    const names = (await this.options.fileSystem.readdir(this.options.eventsDirectory))
      .filter(this.options.isEventTempFileName)
      .sort();
    const quarantined: string[] = [];
    for (const name of names) {
      const destination = join(this.options.quarantineDirectory, `event-${name.slice(1)}`);
      await this.options.fileSystem.rename(join(this.options.eventsDirectory, name), destination);
      quarantined.push(destination);
    }
    if (quarantined.length > 0) await this.options.fileSystem.fsyncDirectory(this.options.quarantineDirectory);
    if (quarantined.length > 0) await this.options.fileSystem.fsyncDirectory(this.options.eventsDirectory);
    return quarantined;
  }

  private async ensureVerifiedCursor(): Promise<DurableLedgerCursor> {
    if (this.cursor?.runId === this.options.runId) return this.cursor;
    const ledger = await this.inspect();
    return { runId: this.options.runId, lastSequence: ledger.lastSequence, lastEventHash: ledger.lastEventHash };
  }

  private async verifyCursorTail(cursor: DurableLedgerCursor): Promise<void> {
    if (cursor.lastSequence === 0) return;
    try {
      const bytes = await readRequired(
        this.options.fileSystem,
        join(this.options.eventsDirectory, this.options.eventFileName(cursor.lastSequence)),
        this.options.createError,
      );
      let parsed: unknown;
      try { parsed = JSON.parse(bytes.toString("utf8")); }
      catch { throw this.options.createError("RALPH_EVENT_LEDGER_MALFORMED_JSON"); }
      this.options.codec.validate(parsed);
      const event = parsed as T;
      if (
        this.options.codec.runId(event) !== this.options.runId
        || this.options.codec.sequence(event) !== cursor.lastSequence
        || this.options.codec.eventHash(event) !== cursor.lastEventHash
        || !bytes.equals(this.options.codec.canonicalBytes(event))
      ) {
        throw this.options.createError("RALPH_EVENT_LEDGER_CURSOR_INVALID");
      }
    } catch (error) {
      this.cursor = undefined;
      throw error;
    }
  }

  private assertDurabilityCapabilities(): void {
    const capabilities = this.options.fileSystem.capabilities;
    if (!capabilities.sameFilesystemTemp || !capabilities.fsyncFile || !capabilities.exclusiveAtomicPublish || !capabilities.fsyncDirectory) {
      throw this.options.createError("RALPH_STORAGE_DURABILITY_UNSUPPORTED");
    }
  }
}

async function readRequired(
  fileSystem: RalphRuntimeFileSystem,
  path: string,
  createError: (code: string, message?: string) => Error,
): Promise<Buffer> {
  try { return await fileSystem.readFile(path); }
  catch { throw createError("RALPH_EVENT_TARGET_DISAPPEARED"); }
}

async function removeTemporary(fileSystem: RalphRuntimeFileSystem, path: string, directory: string): Promise<void> {
  try { await fileSystem.unlink(path); }
  catch (error) { if (!isMissing(error)) throw error; }
  await fileSystem.fsyncDirectory(directory);
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT");
}

function isExisting(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "EEXIST");
}
