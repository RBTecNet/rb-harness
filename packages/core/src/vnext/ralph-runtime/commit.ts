import type { RalphRuntimeState } from "./contracts.js";
import type { RalphEvent } from "./events.js";
import { RalphEventStore, type RalphRuntimeFileSystem } from "./event-store.js";
import { reduceRalphEvent } from "./reducer.js";
import { persistStateSnapshot, type StateSnapshot } from "./snapshot.js";

export interface CommitRalphEventInput {
  readonly store: RalphEventStore;
  readonly state: RalphRuntimeState;
  readonly event: RalphEvent;
  readonly writtenAt: string;
  readonly fs: RalphRuntimeFileSystem;
  readonly nonce: string;
}

export interface CommitRalphEventResult {
  readonly state: RalphRuntimeState;
  readonly snapshot: StateSnapshot;
  readonly eventCommitted: boolean;
}

/**
 * Core-owned ordering boundary: a final event is durable before semantic
 * reduction and a snapshot can advance only after that event commit.
 */
export async function commitRalphEvent(input: CommitRalphEventInput): Promise<CommitRalphEventResult> {
  const append = await input.store.append(input.event);
  let nextState = input.state;
  if (input.state.lastSequence < input.event.sequence) {
    if (input.state.lastSequence + 1 !== input.event.sequence) throw new Error("RALPH_COMMIT_STATE_NOT_AT_EVENT_PREDECESSOR");
    nextState = reduceRalphEvent(input.state, input.event);
  } else if (input.state.lastSequence === input.event.sequence && input.state.lastEventHash !== input.event.eventHash) {
    throw new Error("RALPH_COMMIT_STATE_EVENT_CONFLICT");
  } else if (input.state.lastSequence > input.event.sequence) {
    throw new Error("RALPH_COMMIT_EVENT_OLDER_THAN_STATE");
  }
  const snapshot = await persistStateSnapshot(input.store, nextState, input.writtenAt, input.nonce, input.fs);
  return { state: nextState, snapshot, eventCommitted: append.committed };
}
