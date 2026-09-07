import { join, resolve } from "node:path";
import {
  ensureRalphRuntimeLayout,
  eventFileName,
  isEventFileName,
  isEventTempFileName,
  nodeRalphRuntimeFileSystem,
  RALPH_EVENT_DIGITS,
  RALPH_EVENT_MAX,
  resolveRalphRunDirectory,
  type RalphRuntimeFileSystem,
  validateRalphRunId,
} from "../event-store.js";
import {
  DurableLedgerDurabilityUnknownError,
  DurableLedgerInspectionRequiredError,
  DurableOneEventPerFileLedger,
  type DurableLedgerCursor,
  type DurableLedgerInspection,
} from "../durable-ledger.js";
import { canonicalEventBytesV2, validateRalphEventV2, type RalphEventV2 } from "../operational-v2/events.js";
import { readRunSnapshotV2File, type OperationalRunV2Storage, type RunSnapshotV2 } from "./run-snapshot.js";
import { readBoundRetryPolicyV1 } from "./retry-policy.js";
import { assertNoCredentialMaterial, RalphCredentialSafetyError } from "./secret-safety.js";

export interface EventStoreV2Options {
  readonly projectRoot: string;
  readonly runId: string;
  readonly fs?: RalphRuntimeFileSystem;
  readonly nonce?: () => string;
}

export type LedgerInspectionV2 = DurableLedgerInspection<RalphEventV2>;
export interface AppendEventResultV2 {
  readonly sequence: number;
  readonly event: RalphEventV2;
  readonly eventDurability: "DURABLE";
  readonly publishDisposition: PublishDispositionV2;
}
export type VerifiedLedgerCursorV2 = DurableLedgerCursor;
export type EventDurabilityV2 = "DURABLE" | "UNKNOWN_REQUIRES_INSPECTION";
export type PublishDispositionV2 = "PUBLISHED_BY_THIS_CALL" | "ALREADY_PRESENT";

export class RalphEventStoreV2Error extends Error {
  constructor(readonly code: string, message = code) {
    super(message);
    this.name = "RalphEventStoreV2Error";
  }
}

export class RalphEventStoreV2DurabilityUnknownError extends RalphEventStoreV2Error {
  readonly eventDurability = "UNKNOWN_REQUIRES_INSPECTION" as const;
  readonly requiresInspection = true as const;

  constructor(
    readonly sequence: number,
    readonly eventHash: string,
    readonly cause: unknown,
  ) {
    super("RALPH_EVENT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION", `RALPH_EVENT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION: sequence=${sequence}`);
    this.name = "RalphEventStoreV2DurabilityUnknownError";
  }
}

export class RalphEventStoreV2InspectionRequiredError extends RalphEventStoreV2Error {
  readonly eventDurability = "UNKNOWN_REQUIRES_INSPECTION" as const;
  readonly requiresInspection = true as const;

  constructor() {
    super("RALPH_EVENT_DURABILITY_INSPECTION_REQUIRED");
    this.name = "RalphEventStoreV2InspectionRequiredError";
  }
}

/**
 * V2 facade over the schema-neutral durable ledger.  The facade owns V2
 * identity admission; the physical primitive owns no-replace publication,
 * fsync ordering, chain inspection and the verified tail cursor.
 */
export class RalphEventStoreV2 implements OperationalRunV2Storage {
  readonly projectRoot: string;
  readonly runtimeRoot: string;
  readonly runDirectory: string;
  readonly eventsDirectory: string;
  readonly quarantineDirectory: string;
  readonly stateDirectory: string;
  readonly fileSystem: RalphRuntimeFileSystem;
  private readonly ledger: DurableOneEventPerFileLedger<RalphEventV2>;

  constructor(private readonly options: EventStoreV2Options) {
    if (typeof options.projectRoot !== "string" || options.projectRoot.length === 0) throw new RalphEventStoreV2Error("RALPH_PROJECT_ROOT_INVALID");
    this.projectRoot = resolve(options.projectRoot);
    validateRalphRunId(options.runId);
    this.runtimeRoot = join(this.projectRoot, ".rb-harness", "ralph");
    this.runDirectory = resolveRalphRunDirectory(this.projectRoot, options.runId);
    this.eventsDirectory = join(this.runDirectory, "events");
    this.quarantineDirectory = join(this.runDirectory, "quarantine");
    this.stateDirectory = join(this.runDirectory, "state");
    this.fileSystem = options.fs ?? nodeRalphRuntimeFileSystem;
    const nonce = options.nonce ?? (() => `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    this.ledger = new DurableOneEventPerFileLedger({
      runId: options.runId,
      eventsDirectory: this.eventsDirectory,
      quarantineDirectory: this.quarantineDirectory,
      fileSystem: this.fileSystem,
      nonce,
      maxEvents: RALPH_EVENT_MAX,
      digits: RALPH_EVENT_DIGITS,
      eventFileName,
      isEventFileName,
      isEventTempFileName,
      createError: (code, message) => new RalphEventStoreV2Error(code, message),
      codec: {
        validate: validateV2EventForStorage,
        canonicalBytes: canonicalEventBytesV2,
        runId: (event) => event.runId,
        sequence: (event) => event.sequence,
        eventHash: (event) => event.eventHash,
        previousEventHash: (event) => event.previousEventHash,
      },
      requireExplicitInspectionAfterUnknown: true,
    });
  }

  get runId(): string { return this.options.runId; }
  get verifiedCursor(): VerifiedLedgerCursorV2 | undefined { return this.ledger.verifiedCursor; }

  async ensureLayout(): Promise<void> {
    await ensureRalphRuntimeLayout(
      this.fileSystem,
      this.projectRoot,
      this.runtimeRoot,
      this.runDirectory,
      this.eventsDirectory,
      this.quarantineDirectory,
      this.stateDirectory,
    );
  }

  /** Physical inspection is intentionally exposed only for open diagnostics. */
  async inspectPhysicalLedgerForOpen(): Promise<LedgerInspectionV2> {
    await this.ensureLayout();
    return this.ledger.inspect();
  }

  /** Normal V2 ledger access is gated by the immutable V2 RunSnapshot. */
  async inspect(): Promise<LedgerInspectionV2> {
    await this.ensureLayout();
    await this.verifyRunSnapshot();
    return this.ledger.inspect();
  }

  async append(event: RalphEventV2): Promise<AppendEventResultV2> {
    validateV2EventForStorage(event);
    if (event.runId !== this.runId) throw new RalphEventStoreV2Error("RALPH_EVENT_FOREIGN_RUN");
    await this.ensureLayout();
    await this.verifyRunSnapshot();
    try {
      const result = await this.ledger.append(event);
      return {
        sequence: result.sequence,
        event: result.event,
        eventDurability: result.eventDurability,
        publishDisposition: result.publishDisposition,
      };
    } catch (error) {
      if (error instanceof DurableLedgerDurabilityUnknownError) {
        throw new RalphEventStoreV2DurabilityUnknownError(error.sequence, error.eventHash, error.cause);
      }
      if (error instanceof DurableLedgerInspectionRequiredError) {
        throw new RalphEventStoreV2InspectionRequiredError();
      }
      throw error;
    }
  }

  async quarantineTemporaryFiles(): Promise<readonly string[]> {
    await this.ensureLayout();
    await this.verifyRunSnapshot();
    return this.ledger.quarantineTemporaryFiles();
  }

  async verifyRunSnapshot(): Promise<RunSnapshotV2> {
    const snapshot = await readRunSnapshotV2File(this);
    await readBoundRetryPolicyV1(this, snapshot);
    return snapshot;
  }
}

function validateV2EventForStorage(value: unknown): asserts value is RalphEventV2 {
  validateRalphEventV2(value);
  try { assertNoCredentialMaterial(value, "RALPH_V2_EVENT_CREDENTIAL"); }
  catch (error) {
    if (error instanceof RalphCredentialSafetyError) throw new RalphEventStoreV2Error(error.code);
    throw error;
  }
}
