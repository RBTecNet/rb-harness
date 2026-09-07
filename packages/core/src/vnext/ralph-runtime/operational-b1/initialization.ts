import type { RalphRuntimeFileSystem } from "../event-store.js";
import type { RalphRuntimeStateV2 } from "../operational-v2/contracts.js";
import type { RalphEventV2 } from "../operational-v2/events.js";
import { persistRunSnapshotV2, type RunSnapshotV2 } from "./run-snapshot.js";
import { commitRalphEventV2, type CommitRalphEventV2Result } from "./commit.js";
import type { RalphEventStoreV2 } from "./event-store.js";
import {
  assertGenesisRetryPolicyBindingV1,
  assertRetryPolicySnapshotBindingV1,
  persistRetryPolicyV1,
  type RalphRetryPolicyV1,
} from "./retry-policy.js";

export interface InitializeOperationalRunV2Input {
  readonly store: RalphEventStoreV2;
  readonly snapshot: RunSnapshotV2;
  readonly retryPolicy: RalphRetryPolicyV1;
  readonly genesisState: RalphRuntimeStateV2;
  readonly runCreatedEvent: RalphEventV2;
  readonly createdAt: string;
  readonly nonce: string;
  readonly snapshotFileSystem?: RalphRuntimeFileSystem;
}

export interface InitializeOperationalRunV2Result {
  readonly initialization: "COMPLETE" | "INCOMPLETE_INITIALIZATION" | "RECOVERABLE_STATE_SNAPSHOT";
  readonly snapshotCreated: boolean;
  readonly eventDurability: "DURABLE";
  readonly publishDisposition: "PUBLISHED_BY_THIS_CALL" | "ALREADY_PRESENT";
  readonly state: RalphRuntimeStateV2;
  readonly commit: CommitRalphEventV2Result;
}

/**
 * Narrow V2 birth sequence: immutable identity, run.created, derived state.
 * It has no scheduler, lease, attempt, or execution capability.
 */
export async function initializeOperationalRunV2(
  input: InitializeOperationalRunV2Input,
): Promise<InitializeOperationalRunV2Result> {
  assertRetryPolicySnapshotBindingV1(input.snapshot, input.retryPolicy);
  assertGenesisRetryPolicyBindingV1(input.genesisState, input.retryPolicy);
  await persistRetryPolicyV1(input.store, input.retryPolicy, `${input.nonce}-retry-policy`);
  const snapshotResult = await persistRunSnapshotV2(input.store, input.snapshot, input.nonce);
  if (input.runCreatedEvent.eventType !== "run.created") throw new Error("RALPH_V2_INITIALIZATION_REQUIRES_RUN_CREATED");
  if (input.runCreatedEvent.runId !== input.store.runId) throw new Error("RALPH_V2_INITIALIZATION_FOREIGN_RUN");
  const commit = await commitRalphEventV2({
    store: input.store,
    state: input.genesisState,
    event: input.runCreatedEvent,
    writtenAt: input.createdAt,
    nonce: `${input.nonce}-state`,
    snapshotFileSystem: input.snapshotFileSystem,
  });
  return {
    initialization: commit.snapshotStatus === "CURRENT" ? "COMPLETE" : "RECOVERABLE_STATE_SNAPSHOT",
    snapshotCreated: snapshotResult === "created",
    eventDurability: commit.eventDurability,
    publishDisposition: commit.publishDisposition,
    state: commit.state,
    commit,
  };
}
