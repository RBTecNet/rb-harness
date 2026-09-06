import type { RalphRuntimeFileSystem } from "../event-store.js";
import { assertV2EventForRun, createV2RunIdentity } from "../operational-v2/compatibility.js";
import { reduceRalphEventV2 } from "../operational-v2/reducer.js";
import { assertV2RuntimeState } from "../operational-v2/state.js";
import type { RalphRuntimeStateV2 } from "../operational-v2/contracts.js";
import type { RalphEventV2 } from "../operational-v2/events.js";
import { persistStateSnapshotV2, type StateSnapshotV2 } from "./state-snapshot.js";
import type { PublishDispositionV2, RalphEventStoreV2 } from "./event-store.js";

export interface CommitRalphEventV2Input {
  readonly store: RalphEventStoreV2;
  readonly state: RalphRuntimeStateV2;
  readonly event: RalphEventV2;
  readonly writtenAt: string;
  readonly nonce: string;
  readonly snapshotFileSystem?: RalphRuntimeFileSystem;
}

export type SnapshotCommitStatus = "CURRENT" | "STALE_OR_FAILED";

export interface CommitRalphEventV2Result {
  readonly state: RalphRuntimeStateV2;
  readonly eventDurability: "DURABLE";
  readonly publishDisposition: PublishDispositionV2;
  readonly snapshot?: StateSnapshotV2;
  /** STALE_OR_FAILED means the ledger event is authoritative and replay is required. */
  readonly snapshotStatus: SnapshotCommitStatus;
  readonly snapshotRecoveryRequired: boolean;
  readonly snapshotError?: unknown;
}

/**
 * V2 semantic commit boundary.  Reducer preflight occurs before publication;
 * the ledger is then authoritative, and snapshot failure is never rolled
 * back into another event or a lost transition.
 */
export async function commitRalphEventV2(input: CommitRalphEventV2Input): Promise<CommitRalphEventV2Result> {
  assertV2RuntimeState(input.state);
  assertV2EventForRun(input.event, createV2RunIdentity(input.store.runId));

  let nextState = input.state;
  if (input.state.lastSequence < input.event.sequence) {
    if (input.state.lastSequence + 1 !== input.event.sequence) throw new Error("RALPH_V2_COMMIT_STATE_NOT_AT_EVENT_PREDECESSOR");
    // Preflight is intentionally before any physical append.
    nextState = reduceRalphEventV2(input.state, input.event);
  } else if (input.state.lastSequence === input.event.sequence && input.state.lastEventHash === input.event.eventHash) {
    // The semantic transition is already applied locally; the physical
    // append below still proves/obtains the exact immutable ledger fact.
    nextState = input.state;
  } else if (input.state.lastSequence === input.event.sequence) {
    throw new Error("RALPH_V2_COMMIT_STATE_EVENT_CONFLICT");
  } else {
    throw new Error("RALPH_V2_COMMIT_EVENT_OLDER_THAN_STATE");
  }

  const append = await input.store.append(input.event);
  try {
    const snapshot = await persistStateSnapshotV2(
      input.store,
      nextState,
      input.writtenAt,
      input.nonce,
      input.snapshotFileSystem,
    );
    return {
      state: nextState,
      eventDurability: append.eventDurability,
      publishDisposition: append.publishDisposition,
      snapshot,
      snapshotStatus: "CURRENT",
      snapshotRecoveryRequired: false,
    };
  } catch (snapshotError) {
    return {
      state: nextState,
      eventDurability: append.eventDurability,
      publishDisposition: append.publishDisposition,
      snapshotStatus: "STALE_OR_FAILED",
      snapshotRecoveryRequired: true,
      snapshotError,
    };
  }
}
