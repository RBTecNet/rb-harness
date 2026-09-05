import type { RalphEvent as RalphEventV1 } from "../events.js";
import {
  EVENT_SCHEMA_V2,
  OPERATIONAL_CONTRACT_V2,
  STATE_SCHEMA_V2,
  type RalphRuntimeStateV2,
  type V2RunIdentity,
} from "./contracts.js";
import { validateRalphEventV2, type RalphEventV2 } from "./events.js";
import { assertV2RuntimeState } from "./state.js";
import { reduceRalphEventV2 } from "./reducer.js";

export type RalphRunSchemaClassification = "V1" | "V2" | "UNKNOWN";

export function createV2RunIdentity(runId: string): V2RunIdentity {
  if (typeof runId !== "string" || runId.length === 0) throw new Error("RALPH_V2_RUN_IDENTITY_INVALID");
  return {
    runId,
    eventSchema: EVENT_SCHEMA_V2,
    stateSchema: STATE_SCHEMA_V2,
    operationalContract: OPERATIONAL_CONTRACT_V2,
  };
}

export function assertV2RunIdentity(value: unknown): asserts value is V2RunIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("RALPH_V2_RUN_IDENTITY_MALFORMED");
  const candidate = value as Record<string, unknown>;
  assertExactKeys(candidate, ["runId", "eventSchema", "stateSchema", "operationalContract"], "RALPH_V2_RUN_IDENTITY_UNKNOWN_FIELD");
  if (typeof candidate.runId !== "string" || candidate.runId.length === 0) throw new Error("RALPH_V2_RUN_IDENTITY_INVALID");
  if (candidate.eventSchema !== EVENT_SCHEMA_V2) throw new Error("RALPH_V2_RUN_EVENT_SCHEMA_MISMATCH");
  if (candidate.stateSchema !== STATE_SCHEMA_V2) throw new Error("RALPH_V2_RUN_STATE_SCHEMA_MISMATCH");
  if (candidate.operationalContract !== OPERATIONAL_CONTRACT_V2) throw new Error("RALPH_V2_RUN_OPERATIONAL_CONTRACT_MISMATCH");
}

export function assertV2StateIdentity(state: RalphRuntimeStateV2, runId = state.runId): void {
  assertV2RuntimeState(state);
  if (state.runId !== runId || state.eventSchema !== EVENT_SCHEMA_V2 || state.stateSchema !== STATE_SCHEMA_V2 || state.operationalContract !== OPERATIONAL_CONTRACT_V2) {
    throw new Error("RALPH_V2_STATE_RUN_IDENTITY_MISMATCH");
  }
}

export function assertV2EventForRun(event: unknown, identity: V2RunIdentity): asserts event is RalphEventV2 {
  assertV2RunIdentity(identity);
  validateRalphEventV2(event);
  if (event.runId !== identity.runId || event.schemaVersion !== identity.eventSchema) throw new Error("RALPH_V2_EVENT_RUN_IDENTITY_MISMATCH");
}

export function classifyRalphRun(value: unknown): RalphRunSchemaClassification {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "UNKNOWN";
  const candidate = value as Record<string, unknown>;
  const v1Format = candidate.format === "rb-ralph-runtime-state/v1";
  const v1Schema = candidate.stateSchema === "rb-ralph-runtime-state/v1";
  const v2Format = candidate.format === STATE_SCHEMA_V2;
  const v2Schema = candidate.stateSchema === STATE_SCHEMA_V2;
  if ((v1Format || v1Schema) && !(v2Format || v2Schema)) return "V1";
  if ((v2Format || v2Schema) && !(v1Format || v1Schema)) return "V2";
  return "UNKNOWN";
}

export function isV1RalphEvent(value: unknown): value is RalphEventV1 {
  return Boolean(value && typeof value === "object" && (value as { schemaVersion?: unknown }).schemaVersion === "rb-ralph-event/v1");
}

export function isV2RalphEvent(value: unknown): value is RalphEventV2 {
  return Boolean(value && typeof value === "object" && (value as { schemaVersion?: unknown }).schemaVersion === EVENT_SCHEMA_V2);
}

export function validateV2EventSequence(events: readonly unknown[], runId?: string): asserts events is readonly RalphEventV2[] {
  let previousHash: string | null = null;
  let sequence = 1;
  for (const event of events) {
    validateRalphEventV2(event);
    if (runId !== undefined && event.runId !== runId) throw new Error("RALPH_V2_EVENT_FOREIGN_RUN");
    if (event.sequence !== sequence) throw new Error("RALPH_V2_EVENT_SEQUENCE_MISMATCH");
    if (event.previousEventHash !== previousHash) throw new Error("RALPH_V2_EVENT_HASH_CHAIN_MISMATCH");
    previousHash = event.eventHash;
    sequence += 1;
  }
}

/** Replay stays in memory in Slice A; the V1 physical EventStore is untouched. */
export function replayV2Events(
  genesis: RalphRuntimeStateV2,
  events: readonly unknown[],
): RalphRuntimeStateV2 {
  assertV2StateIdentity(genesis);
  validateV2EventSequence(events, genesis.runId);
  let state = genesis;
  for (const event of events) state = reduceRalphEventV2(state, event);
  return state;
}

export const replayRalphEventsV2 = replayV2Events;
export const replayV2Runtime = replayV2Events;

function assertExactKeys(value: object, allowed: readonly string[], code: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) throw new Error(`${code}: ${unknown.sort().join(",")}`);
}
