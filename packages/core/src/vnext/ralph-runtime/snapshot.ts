import { join } from "node:path";
import type { RalphRuntimeState } from "./contracts.js";
import type { RalphEvent } from "./events.js";
import { canonicalJson } from "./canonical-json.js";
import { isSha256Digest, sha256Canonical } from "./hashing.js";
import { RalphEventStore, type RalphRuntimeFileSystem, writeAtomicRuntimeFile } from "./event-store.js";
import { reduceRalphEvent } from "./reducer.js";

export const RALPH_STATE_SNAPSHOT_SCHEMA = "rb-ralph-state/v1" as const;

export interface StateSnapshot {
  readonly snapshotSchemaVersion: typeof RALPH_STATE_SNAPSHOT_SCHEMA;
  readonly runId: string;
  readonly lastSequence: number;
  readonly lastEventHash: string | null;
  readonly stateHash: string;
  readonly writtenAt: string;
  readonly state: RalphRuntimeState;
}

export interface ReplayResult {
  readonly state: RalphRuntimeState;
  readonly ledgerLastSequence: number;
  readonly ledgerLastEventHash: string | null;
  readonly snapshotUsed: boolean;
  readonly snapshotRecovered?: boolean;
}

export class RalphStateSnapshotError extends Error {
  constructor(readonly code: string, readonly recoverable: boolean, message = code) {
    super(message);
    this.name = "RalphStateSnapshotError";
  }
}

export function createStateSnapshot(state: RalphRuntimeState, writtenAt: string): StateSnapshot {
  return {
    snapshotSchemaVersion: RALPH_STATE_SNAPSHOT_SCHEMA,
    runId: state.runId,
    lastSequence: state.lastSequence,
    lastEventHash: state.lastEventHash,
    stateHash: sha256Canonical(state),
    writtenAt,
    state,
  };
}

export async function persistStateSnapshot(
  store: RalphEventStore,
  state: RalphRuntimeState,
  writtenAt: string,
  nonce: string,
  snapshotFileSystem: RalphRuntimeFileSystem = store.fileSystem,
): Promise<StateSnapshot> {
  await store.ensureLayout();
  const snapshot = createStateSnapshot(state, writtenAt);
  await writeAtomicRuntimeFile(snapshotFileSystem, join(store.runDirectory, "state", "current.json"), Buffer.from(canonicalJson(snapshot), "utf8"), nonce);
  return snapshot;
}

export async function readStateSnapshot(store: RalphEventStore): Promise<StateSnapshot | undefined> {
  await store.ensureLayout();
  try {
    const bytes = await store.fileSystem.readFile(join(store.runDirectory, "state", "current.json"));
    let parsed: unknown;
    try { parsed = JSON.parse(bytes.toString("utf8")); } catch { throw new RalphStateSnapshotError("RALPH_STATE_SNAPSHOT_MALFORMED_JSON", true); }
    try { assertStateSnapshot(parsed); } catch (error) {
      if (error instanceof RalphStateSnapshotError) throw error;
      throw new RalphStateSnapshotError("RALPH_STATE_SNAPSHOT_MALFORMED", true, error instanceof Error ? error.message : String(error));
    }
    if (bytes.toString("utf8") !== canonicalJson(parsed)) throw new RalphStateSnapshotError("RALPH_STATE_SNAPSHOT_NON_CANONICAL", true);
    return parsed;
  } catch (error) {
    if (isMissing(error)) return undefined;
    if (error instanceof RalphStateSnapshotError) throw error;
    throw error;
  }
}

export function validateSnapshotAgainstLedger(snapshot: StateSnapshot, ledger: { readonly events: readonly RalphEvent[]; readonly lastSequence: number; readonly lastEventHash: string | null }): void {
  if (snapshot.lastSequence > ledger.lastSequence) throw new RalphStateSnapshotError("RALPH_STATE_SNAPSHOT_AHEAD", false);
  if (snapshot.lastSequence === 0 && snapshot.lastEventHash !== null) throw new RalphStateSnapshotError("RALPH_STATE_SNAPSHOT_GENESIS_HASH", false);
  if (snapshot.lastSequence > 0) {
    const event = ledger.events[snapshot.lastSequence - 1];
    if (!event || event.eventHash !== snapshot.lastEventHash) throw new RalphStateSnapshotError("RALPH_STATE_SNAPSHOT_HASH_POSITION_MISMATCH", false);
  }
  if (snapshot.lastSequence === ledger.lastSequence && snapshot.lastEventHash !== ledger.lastEventHash) throw new RalphStateSnapshotError("RALPH_STATE_SNAPSHOT_LAST_HASH_MISMATCH", false);
  if (sha256Canonical(snapshot.state) !== snapshot.stateHash) throw new RalphStateSnapshotError("RALPH_STATE_SNAPSHOT_STATE_HASH_MISMATCH", true);
  if (snapshot.state.lastSequence !== snapshot.lastSequence || snapshot.state.lastEventHash !== snapshot.lastEventHash) throw new RalphStateSnapshotError("RALPH_STATE_SNAPSHOT_STATE_POSITION_MISMATCH", true);
}

export async function replayRalphRuntime(store: RalphEventStore, genesis: RalphRuntimeState): Promise<ReplayResult> {
  const ledger = await store.inspect();
  let snapshot: StateSnapshot | undefined;
  let snapshotRecovered = false;
  try {
    snapshot = await readStateSnapshot(store);
  } catch (error) {
    if (!(error instanceof RalphStateSnapshotError) || !error.recoverable) throw error;
    snapshotRecovered = true;
  }
  if (snapshot) {
    try {
      return { ...replayFromRecords(genesis, ledger.events, snapshot), ...(snapshotRecovered ? { snapshotRecovered: true } : {}) };
    } catch (error) {
      if (!(error instanceof RalphStateSnapshotError) || !error.recoverable) throw error;
      snapshot = undefined;
      snapshotRecovered = true;
    }
  }
  return { ...replayFromRecords(genesis, ledger.events), ...(snapshotRecovered ? { snapshotRecovered: true } : {}) };
}

export function replayFromRecords(genesis: RalphRuntimeState, events: readonly RalphEvent[], snapshot?: StateSnapshot): ReplayResult {
  if (snapshot) {
    if (snapshot.runId !== genesis.runId) throw new RalphStateSnapshotError("RALPH_STATE_SNAPSHOT_FOREIGN_RUN", false);
    validateSnapshotAgainstLedger(snapshot, { events, lastSequence: events.length, lastEventHash: events.at(-1)?.eventHash ?? null });
    let verifiedSnapshotState = genesis;
    for (const event of events.slice(0, snapshot.lastSequence)) verifiedSnapshotState = reduceRalphEvent(verifiedSnapshotState, event);
    if (canonicalJson(verifiedSnapshotState) !== canonicalJson(snapshot.state)) throw new RalphStateSnapshotError("RALPH_STATE_SNAPSHOT_STATE_DIVERGENCE", true);
  }
  let state = snapshot?.state ?? genesis;
  const start = snapshot?.lastSequence ?? 0;
  for (const event of events.slice(start)) state = reduceRalphEvent(state, event);
  return { state, ledgerLastSequence: events.length, ledgerLastEventHash: events.at(-1)?.eventHash ?? null, snapshotUsed: snapshot !== undefined };
}

function assertStateSnapshot(value: unknown): asserts value is StateSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RalphStateSnapshotError("RALPH_STATE_SNAPSHOT_MALFORMED", true);
  const candidate = value as Partial<StateSnapshot>;
  const keys = Object.keys(candidate);
  const allowed = new Set(["snapshotSchemaVersion", "runId", "lastSequence", "lastEventHash", "stateHash", "writtenAt", "state"]);
  if (keys.some((key) => !allowed.has(key))) throw new RalphStateSnapshotError("RALPH_STATE_SNAPSHOT_UNKNOWN_FIELD", true);
  if (candidate.snapshotSchemaVersion !== RALPH_STATE_SNAPSHOT_SCHEMA) throw new RalphStateSnapshotError("RALPH_STATE_SNAPSHOT_UNSUPPORTED_SCHEMA", true);
  const lastSequence = candidate.lastSequence;
  if (typeof candidate.runId !== "string" || typeof lastSequence !== "number" || !Number.isSafeInteger(lastSequence) || lastSequence < 0) throw new RalphStateSnapshotError("RALPH_STATE_SNAPSHOT_INVALID_IDENTITY", true);
  if (candidate.lastEventHash !== null && !isSha256Digest(candidate.lastEventHash)) throw new RalphStateSnapshotError("RALPH_STATE_SNAPSHOT_INVALID_EVENT_HASH", true);
  if (!isSha256Digest(candidate.stateHash) || typeof candidate.writtenAt !== "string" || !candidate.state) throw new RalphStateSnapshotError("RALPH_STATE_SNAPSHOT_INVALID_ENVELOPE", true);
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT");
}
