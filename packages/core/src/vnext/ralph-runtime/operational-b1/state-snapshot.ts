import { join } from "node:path";
import type { RalphRuntimeFileSystem } from "../event-store.js";
import { writeAtomicRuntimeFile } from "../event-store.js";
import { canonicalJson } from "../canonical-json.js";
import { isSha256Digest, sha256Canonical } from "../hashing.js";
import {
  EVENT_SCHEMA_V2,
  OPERATIONAL_CONTRACT_V2,
  STATE_SCHEMA_V2,
  type RalphRuntimeStateV2,
} from "../operational-v2/contracts.js";
import { validateV2EventSequence } from "../operational-v2/compatibility.js";
import type { RalphEventV2 } from "../operational-v2/events.js";
import { reduceRalphEventV2 } from "../operational-v2/reducer.js";
import { assertV2RuntimeState } from "../operational-v2/state.js";
import type { RalphEventStoreV2, LedgerInspectionV2 } from "./event-store.js";
import { assertNoCredentialMaterial, RalphCredentialSafetyError } from "./secret-safety.js";

export const RALPH_STATE_SNAPSHOT_V2_SCHEMA = "rb-ralph-state/v2" as const;

export interface StateSnapshotV2 {
  readonly snapshotSchemaVersion: typeof RALPH_STATE_SNAPSHOT_V2_SCHEMA;
  readonly runId: string;
  readonly eventSchema: typeof EVENT_SCHEMA_V2;
  readonly stateSchema: typeof STATE_SCHEMA_V2;
  readonly operationalContract: typeof OPERATIONAL_CONTRACT_V2;
  readonly lastSequence: number;
  readonly lastEventHash: string | null;
  readonly stateHash: string;
  readonly writtenAt: string;
  readonly state: RalphRuntimeStateV2;
}

export interface ReplayOperationalRunV2Result {
  readonly state: RalphRuntimeStateV2;
  readonly ledgerLastSequence: number;
  readonly ledgerLastEventHash: string | null;
  readonly snapshotUsed: boolean;
  readonly snapshotRecovered: boolean;
  readonly snapshotRepairRequired: boolean;
}

export class RalphStateSnapshotV2Error extends Error {
  constructor(readonly code: string, readonly recoverable = false, message = code) {
    super(message);
    this.name = "RalphStateSnapshotV2Error";
  }
}

export function createStateSnapshotV2(state: RalphRuntimeStateV2, writtenAt: string): StateSnapshotV2 {
  assertV2RuntimeState(state);
  assertNoCredentialMaterial(state, "RALPH_V2_STATE_SNAPSHOT_CREDENTIAL");
  if (typeof writtenAt !== "string" || writtenAt.length === 0) throw new RalphStateSnapshotV2Error("RALPH_V2_STATE_SNAPSHOT_WRITTEN_AT_INVALID");
  return {
    snapshotSchemaVersion: RALPH_STATE_SNAPSHOT_V2_SCHEMA,
    runId: state.runId,
    eventSchema: EVENT_SCHEMA_V2,
    stateSchema: STATE_SCHEMA_V2,
    operationalContract: OPERATIONAL_CONTRACT_V2,
    lastSequence: state.lastSequence,
    lastEventHash: state.lastEventHash,
    stateHash: sha256Canonical(state),
    writtenAt,
    state,
  };
}

export async function persistStateSnapshotV2(
  store: RalphEventStoreV2,
  state: RalphRuntimeStateV2,
  writtenAt: string,
  nonce: string,
  snapshotFileSystem: RalphRuntimeFileSystem = store.fileSystem,
): Promise<StateSnapshotV2> {
  assertV2RuntimeState(state);
  if (state.runId !== store.runId) throw new RalphStateSnapshotV2Error("RALPH_V2_STATE_SNAPSHOT_FOREIGN_RUN");
  await store.ensureLayout();
  await store.verifyRunSnapshot();
  const snapshot = createStateSnapshotV2(state, writtenAt);
  await writeAtomicRuntimeFile(
    snapshotFileSystem,
    join(store.runDirectory, "state", "current.json"),
    Buffer.from(canonicalJson(snapshot), "utf8"),
    nonce,
  );
  return snapshot;
}

export async function readStateSnapshotV2(store: RalphEventStoreV2): Promise<StateSnapshotV2 | undefined> {
  await store.ensureLayout();
  await store.verifyRunSnapshot();
  const path = join(store.runDirectory, "state", "current.json");
  let bytes: Buffer;
  try {
    const stats = await store.fileSystem.lstat(path);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new RalphStateSnapshotV2Error("RALPH_V2_STATE_SNAPSHOT_FILE_UNSAFE");
    }
    bytes = await store.fileSystem.readFile(path);
  } catch (error) {
    if (error instanceof RalphStateSnapshotV2Error) throw error;
    if (error instanceof RalphCredentialSafetyError) throw new RalphStateSnapshotV2Error(error.code, false);
    if (isMissing(error)) return undefined;
    throw error;
  }

  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); }
  catch { throw new RalphStateSnapshotV2Error("RALPH_V2_STATE_SNAPSHOT_MALFORMED_JSON", true); }
  try {
    assertNoCredentialMaterial(parsed, "RALPH_V2_STATE_SNAPSHOT_CREDENTIAL");
    assertStateSnapshotV2(parsed, store.runId);
  } catch (error) {
    if (error instanceof RalphStateSnapshotV2Error) throw error;
    if (error instanceof RalphCredentialSafetyError) throw new RalphStateSnapshotV2Error(error.code, false);
    const message = error instanceof Error ? error.message : String(error);
    if (isFatalStateError(message)) throw new RalphStateSnapshotV2Error(message, false);
    throw new RalphStateSnapshotV2Error("RALPH_V2_STATE_SNAPSHOT_MALFORMED", true, message);
  }
  if (bytes.toString("utf8") !== canonicalJson(parsed)) throw new RalphStateSnapshotV2Error("RALPH_V2_STATE_SNAPSHOT_NON_CANONICAL", true);
  return parsed;
}

export function validateStateSnapshotV2AgainstLedger(
  snapshot: StateSnapshotV2,
  ledger: Pick<LedgerInspectionV2, "events" | "lastSequence" | "lastEventHash">,
): void {
  if (snapshot.lastSequence > ledger.lastSequence) throw new RalphStateSnapshotV2Error("RALPH_V2_STATE_SNAPSHOT_AHEAD");
  if (snapshot.lastSequence === 0 && snapshot.lastEventHash !== null) throw new RalphStateSnapshotV2Error("RALPH_V2_STATE_SNAPSHOT_GENESIS_HASH");
  if (snapshot.lastSequence > 0) {
    const event = ledger.events[snapshot.lastSequence - 1];
    if (!event || event.eventHash !== snapshot.lastEventHash) throw new RalphStateSnapshotV2Error("RALPH_V2_STATE_SNAPSHOT_HASH_POSITION_MISMATCH");
  }
  if (snapshot.lastSequence === ledger.lastSequence && snapshot.lastEventHash !== ledger.lastEventHash) {
    throw new RalphStateSnapshotV2Error("RALPH_V2_STATE_SNAPSHOT_LAST_HASH_MISMATCH");
  }
  if (sha256Canonical(snapshot.state) !== snapshot.stateHash) throw new RalphStateSnapshotV2Error("RALPH_V2_STATE_SNAPSHOT_STATE_HASH_MISMATCH", true);
  if (snapshot.state.lastSequence !== snapshot.lastSequence || snapshot.state.lastEventHash !== snapshot.lastEventHash) {
    throw new RalphStateSnapshotV2Error("RALPH_V2_STATE_SNAPSHOT_STATE_POSITION_MISMATCH", true);
  }
}

export async function replayOperationalRunV2(
  store: RalphEventStoreV2,
  genesis: RalphRuntimeStateV2,
): Promise<ReplayOperationalRunV2Result> {
  const ledger = await store.inspect();
  let snapshot: StateSnapshotV2 | undefined;
  let snapshotRecovered = false;
  let snapshotRepairRequired = false;
  try {
    snapshot = await readStateSnapshotV2(store);
  } catch (error) {
    if (!(error instanceof RalphStateSnapshotV2Error) || !error.recoverable) throw error;
    snapshotRecovered = true;
    snapshotRepairRequired = true;
  }

  if (snapshot) {
    try {
      const result = replayFromRecordsV2(genesis, ledger.events, snapshot);
      snapshotRepairRequired = snapshot.lastSequence < ledger.lastSequence;
      return {
        ...result,
        ledgerLastSequence: ledger.lastSequence,
        ledgerLastEventHash: ledger.lastEventHash,
        snapshotRecovered,
        snapshotRepairRequired,
      };
    } catch (error) {
      if (!(error instanceof RalphStateSnapshotV2Error) || !error.recoverable) throw error;
      snapshot = undefined;
      snapshotRecovered = true;
      snapshotRepairRequired = true;
    }
  } else if (ledger.lastSequence > 0) {
    snapshotRepairRequired = true;
  }

  const result = replayFromRecordsV2(genesis, ledger.events);
  return {
    ...result,
    ledgerLastSequence: ledger.lastSequence,
    ledgerLastEventHash: ledger.lastEventHash,
    snapshotRecovered,
    snapshotRepairRequired,
  };
}

export function replayFromRecordsV2(
  genesis: RalphRuntimeStateV2,
  events: readonly RalphEventV2[],
  snapshot?: StateSnapshotV2,
): Pick<ReplayOperationalRunV2Result, "state" | "snapshotUsed"> {
  assertV2RuntimeState(genesis);
  if (genesis.lastSequence !== 0 || genesis.lastEventHash !== null) throw new RalphStateSnapshotV2Error("RALPH_V2_GENESIS_NOT_ZERO");
  validateV2EventSequence(events, genesis.runId);
  if (snapshot) {
    if (snapshot.runId !== genesis.runId) throw new RalphStateSnapshotV2Error("RALPH_V2_STATE_SNAPSHOT_FOREIGN_RUN");
    validateStateSnapshotV2AgainstLedger(snapshot, {
      events,
      lastSequence: events.length,
      lastEventHash: events.at(-1)?.eventHash ?? null,
    });
    let verifiedSnapshotState = genesis;
    for (const event of events.slice(0, snapshot.lastSequence)) verifiedSnapshotState = reduceRalphEventV2(verifiedSnapshotState, event);
    if (canonicalJson(verifiedSnapshotState) !== canonicalJson(snapshot.state)) {
      throw new RalphStateSnapshotV2Error("RALPH_V2_STATE_SNAPSHOT_STATE_DIVERGENCE", true);
    }
  }
  let state = snapshot?.state ?? genesis;
  const start = snapshot?.lastSequence ?? 0;
  for (const event of events.slice(start)) state = reduceRalphEventV2(state, event);
  return { state, snapshotUsed: snapshot !== undefined };
}

export const replayRalphRuntimeV2 = replayOperationalRunV2;

function assertStateSnapshotV2(value: unknown, runId: string): asserts value is StateSnapshotV2 {
  if (!isRecord(value)) throw new Error("RALPH_V2_STATE_SNAPSHOT_MALFORMED");
  assertExactKeys(value, [
    "snapshotSchemaVersion", "runId", "eventSchema", "stateSchema", "operationalContract", "lastSequence", "lastEventHash", "stateHash", "writtenAt", "state",
  ], "RALPH_V2_STATE_SNAPSHOT_UNKNOWN_FIELD");
  if (value.snapshotSchemaVersion !== RALPH_STATE_SNAPSHOT_V2_SCHEMA) throw new RalphStateSnapshotV2Error("RALPH_V2_STATE_SNAPSHOT_UNSUPPORTED_SCHEMA");
  if (value.runId !== runId) throw new RalphStateSnapshotV2Error("RALPH_V2_STATE_SNAPSHOT_FOREIGN_RUN");
  if (value.eventSchema !== EVENT_SCHEMA_V2 || value.stateSchema !== STATE_SCHEMA_V2 || value.operationalContract !== OPERATIONAL_CONTRACT_V2) {
    throw new RalphStateSnapshotV2Error("RALPH_V2_STATE_SNAPSHOT_IDENTITY_MISMATCH");
  }
  const lastSequence = value.lastSequence;
  if (typeof lastSequence !== "number" || !Number.isSafeInteger(lastSequence) || lastSequence < 0) throw new Error("RALPH_V2_STATE_SNAPSHOT_INVALID_SEQUENCE");
  if ((lastSequence === 0 && value.lastEventHash !== null) || (lastSequence > 0 && !isSha256Digest(value.lastEventHash))) {
    throw new Error("RALPH_V2_STATE_SNAPSHOT_INVALID_EVENT_HASH");
  }
  if (!isSha256Digest(value.stateHash) || typeof value.writtenAt !== "string" || value.writtenAt.length === 0) throw new Error("RALPH_V2_STATE_SNAPSHOT_INVALID_ENVELOPE");
  try { assertV2RuntimeState(value.state); }
  catch (error) {
    if (error instanceof RalphStateSnapshotV2Error) throw error;
    throw new Error(error instanceof Error ? error.message : String(error));
  }
  if (value.state.runId !== value.runId || value.state.eventSchema !== EVENT_SCHEMA_V2 || value.state.stateSchema !== STATE_SCHEMA_V2 || value.state.operationalContract !== OPERATIONAL_CONTRACT_V2) {
    throw new RalphStateSnapshotV2Error("RALPH_V2_STATE_SNAPSHOT_STATE_IDENTITY_MISMATCH");
  }
}

function assertExactKeys(value: object, allowed: readonly string[], code: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) throw new Error(`${code}: ${unknown.sort().join(",")}`);
}

function isFatalStateError(message: string): boolean {
  return [
    "RALPH_V2_STATE_SNAPSHOT_UNSUPPORTED_SCHEMA",
    "RALPH_V2_STATE_SNAPSHOT_IDENTITY_MISMATCH",
    "RALPH_V2_STATE_SNAPSHOT_FOREIGN_RUN",
    "RALPH_V2_STATE_SNAPSHOT_STATE_IDENTITY_MISMATCH",
    "RALPH_V2_STATE_UNSUPPORTED_SCHEMA",
    "RALPH_V2_STATE_EVENT_SCHEMA_MISMATCH",
    "RALPH_V2_STATE_OPERATIONAL_CONTRACT_MISMATCH",
  ].some((code) => message.includes(code));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT");
}
