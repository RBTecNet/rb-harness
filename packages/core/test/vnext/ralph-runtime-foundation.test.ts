import { describe, expect, it } from "vitest";
import {
  RALPH_EVENT_SCHEMA,
  activeTaskIds,
  canCompleteRun,
  createInitialRuntimeState,
  createRalphEvent,
  deriveBudgetUsage,
  derivePhaseState,
  phaseProgress,
  reduceRalphEvent,
  validateAuditBinding,
  transitionFinding,
  type AuditResult,
  type EventPayloadMap,
  type RalphEvent,
  type RalphEventType,
  type RalphRuntimeState,
  type UnsignedRalphEvent,
  type Finding,
} from "../../src/vnext/ralph-runtime/index.js";

function event<TType extends RalphEventType>(sequence: number, eventType: TType, payload: EventPayloadMap[TType], entity: { kind: "run" | "phase" | "task" | "attempt" | "finding" | "workspace"; id: string } = { kind: "run", id: "run-1" }, actor: "CORE" | "AUDITOR" = "CORE"): RalphEvent {
  return createRalphEvent({
    eventId: `event-${sequence}`,
    eventType,
    schemaVersion: RALPH_EVENT_SCHEMA,
    runId: "run-1",
    sequence,
    occurredAt: `2026-09-05T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    recordedAt: `2026-09-05T00:00:${String(sequence).padStart(2, "0")}.100Z`,
    entity,
    taskId: entity.kind === "task" ? entity.id : undefined,
    attemptId: entity.kind === "attempt" ? entity.id : undefined,
    actor,
    causationId: null,
    correlationId: "correlation-1",
    payload,
    previousEventHash: null,
  } as UnsignedRalphEvent<TType>) as RalphEvent;
}

function reduce(state: RalphRuntimeState, next: RalphEvent): RalphRuntimeState {
  const { eventHash: _eventHash, ...unsigned } = next;
  const rechained = createRalphEvent({ ...unsigned, previousEventHash: state.lastEventHash } as UnsignedRalphEvent<typeof next.eventType>) as RalphEvent;
  return reduceRalphEvent(state, rechained);
}

function startedState(taskIds = ["T01", "T02", "T03"]): RalphRuntimeState {
  let state = createInitialRuntimeState({
    runId: "run-1",
    phases: [{ phaseId: "P01", taskIds }],
    tasks: taskIds.map((taskId) => ({ taskId, phaseId: "P01", dependsOn: [] })),
  });
  state = reduce(state, event(1, "run.created", { phaseIds: ["P01"], taskIds }));
  return reduce(state, event(2, "run.started", {}));
}

describe("Ralph Runtime Foundation contracts and reducers", () => {
  it("keeps local blocked work from blocking the Run while another Task is active", () => {
    let state = startedState();
    state = reduce(state, event(3, "task.state-changed", { disposition: "BLOCKED", activity: "IDLE", owner: "NONE", hold: "DEPENDENCY_UNAVAILABLE" }, { kind: "task", id: "T01" }));
    state = reduce(state, event(4, "task.state-changed", { disposition: "READY", activity: "IDLE", owner: "NONE", hold: "NONE" }, { kind: "task", id: "T02" }));
    state = reduce(state, event(5, "task.state-changed", { disposition: "READY", activity: "IDLE", owner: "NONE", hold: "NONE" }, { kind: "task", id: "T03" }));
    state = reduce(state, event(6, "workspace.checkpointed", { checkpoint: { kind: "runStartFingerprint", fingerprintDigest: "fp-0", emittedAt: "2026-09-05T00:00:30.000Z" } }));
    state = reduce(state, event(7, "attempt.started", { taskId: "T02", attemptId: "A01", ordinal: 1, strategyGeneration: 0, attemptBaseFingerprint: "fp-0", startedAt: "2026-09-05T00:01:00.000Z" }, { kind: "attempt", id: "A01" }));

    expect(state.hold).toBe("NONE");
    expect(state.disposition).toBe("ACTIVE");
    expect(state.phases.P01).toMatchObject({ disposition: "READY", activity: "ACTIVE" });
    expect(activeTaskIds(state)).toEqual(["T02"]);
    expect(phaseProgress(state.phases.P01!, state.tasks)).toMatchObject({ totalTasks: 3, completeTasks: 0, activeTaskIds: ["T02"], blockedTasks: 1 });
  });

  it("only accepts global BLOCKED when no Task can advance", () => {
    let state = startedState(["T01", "T02"]);
    state = reduce(state, event(3, "task.state-changed", { disposition: "BLOCKED", activity: "IDLE", owner: "NONE", hold: "DEPENDENCY_UNAVAILABLE" }, { kind: "task", id: "T01" }));
    state = reduce(state, event(4, "task.state-changed", { disposition: "BLOCKED", activity: "IDLE", owner: "NONE", hold: "DEPENDENCY_UNAVAILABLE" }, { kind: "task", id: "T02" }));
    state = reduce(state, event(5, "run.hold-set", { hold: "BLOCKED", reason: "external dependency" }));
    expect(state.hold).toBe("BLOCKED");
    expect(() => reduce(startedState(["T01"]), event(3, "run.hold-set", { hold: "BLOCKED", reason: "premature" }))).toThrow("RALPH_GLOBAL_BLOCKED_PRECONDITION");
  });

  it("rejects Run completion through the reducer whenever a hold remains", () => {
    for (const hold of ["PAUSED", "HUMAN_REQUIRED", "RECONCILIATION_REQUIRED"] as const) {
      const base = startedState(["T01"]);
      const eligibleForCompletion = {
        ...base,
        hold,
        phases: { P01: { ...base.phases.P01!, disposition: "COMPLETE" as const, activity: "IDLE" as const } },
        tasks: { T01: { ...base.tasks.T01!, disposition: "COMPLETE" as const, activity: "IDLE" as const, owner: "NONE" as const, hold: "NONE" as const } },
      };
      expect(() => reduce(eligibleForCompletion, event(3, "run.completed", { finalStatePersisted: true }))).toThrow("RALPH_RUN_COMPLETION_PRECONDITION");
    }
  });

  it("completes a Task immediately after the Core has all required authorities", () => {
    let state = startedState(["T01"]);
    state = reduce(state, event(3, "task.state-changed", { disposition: "READY", activity: "IDLE", owner: "NONE", hold: "NONE" }, { kind: "task", id: "T01" }));
    state = reduce(state, event(4, "workspace.checkpointed", { checkpoint: { kind: "runStartFingerprint", fingerprintDigest: "fp-0", emittedAt: "2026-09-05T00:00:30.000Z" } }));
    state = reduce(state, event(5, "attempt.started", { taskId: "T01", attemptId: "A01", ordinal: 1, strategyGeneration: 0, attemptBaseFingerprint: "fp-0", startedAt: "2026-09-05T00:01:00.000Z" }, { kind: "attempt", id: "A01" }));
    const audit: AuditResult = {
      auditId: "audit-1",
      binding: {
        runId: "run-1", phaseId: "P01", taskId: "T01", attemptId: "A01", auditReviewOrdinal: 1,
        evidenceSetId: "evidence-1", evidenceDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        validationSetDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        postExecutorFingerprint: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        criterionSetVersion: "v1", criterionSetDigest: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        auditorProfileDigest: "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      },
      result: "PASS",
      criteria: [{
        criterionId: "C01", result: "PASS",
        evidenceRefs: [{ evidenceId: "E01", evidenceSetId: "evidence-1", digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", kind: "validation-artifact", provenance: "CORE", integrity: "VERIFIED", storageRef: "evidence/E01", capturedAt: "2026-09-05T00:02:00.000Z" }],
        findingIds: [],
      }],
      issuedAt: "2026-09-05T00:02:00.000Z",
    };
    state = reduce(state, event(6, "attempt.closed", { attemptId: "A01", completionReason: "AUDIT_APPROVED", finishedAt: "2026-09-05T00:03:00.000Z", auditResult: audit, evidenceRefs: [], validationRefs: [] }, { kind: "attempt", id: "A01" }));
    state = reduce(state, event(7, "task.state-changed", {
      disposition: "COMPLETE", activity: "IDLE", owner: "NONE", hold: "NONE", currentAttemptId: "A01",
      evidenceSetId: "evidence-1", validationSetDigest: audit.binding.validationSetDigest,
      postExecutorFingerprint: audit.binding.postExecutorFingerprint, acceptedCheckpointFingerprint: audit.binding.postExecutorFingerprint,
    }, { kind: "task", id: "T01" }));
    expect(state.tasks.T01?.disposition).toBe("COMPLETE");
    expect(state.phases.P01).toMatchObject({ disposition: "COMPLETE", activity: "IDLE" });
    expect(canCompleteRun(state, true)).toBe(true);
    state = reduce(state, event(8, "run.completed", { finalStatePersisted: true }));
    expect(state.disposition).toBe("COMPLETE");
  });

  it("rejects Task completion without the current Attempt's audit proof", () => {
    let state = startedState(["T01"]);
    state = reduce(state, event(3, "task.state-changed", { disposition: "READY", activity: "IDLE", owner: "NONE", hold: "NONE" }, { kind: "task", id: "T01" }));
    state = reduce(state, event(4, "workspace.checkpointed", { checkpoint: { kind: "runStartFingerprint", fingerprintDigest: "fp-0", emittedAt: "2026-09-05T00:00:30.000Z" } }));
    state = reduce(state, event(5, "attempt.started", { taskId: "T01", attemptId: "A01", ordinal: 1, strategyGeneration: 0, attemptBaseFingerprint: "fp-0", startedAt: "2026-09-05T00:01:00.000Z" }, { kind: "attempt", id: "A01" }));
    expect(() => reduce(state, event(6, "task.state-changed", { disposition: "COMPLETE", activity: "IDLE", owner: "NONE", hold: "NONE", currentAttemptId: "A01" }, { kind: "task", id: "T01" }))).toThrow("RALPH_TASK_COMPLETION_PROOF_MISSING");
  });

  it("uses dimensional budget semantics at the exact limit", () => {
    expect(deriveBudgetUsage(2, 3)).toEqual({ used: 2, limit: 3, remaining: 1, exhausted: false, exceeded: false });
    expect(deriveBudgetUsage(3, 3)).toEqual({ used: 3, limit: 3, remaining: 0, exhausted: true, exceeded: false });
    expect(deriveBudgetUsage(4, 3).exceeded).toBe(true);
  });

  it("does not let an Auditor resolve a Finding directly, while Core can resolve with newer proof", () => {
    const base = {
      id: "F01", criterionId: "C01", phaseId: "P01", taskId: "T01", scope: ["src/a.ts"], severity: "BLOCKER" as const,
      expectation: "must pass", observed: "failed", evidenceRefs: [], openedAtAttempt: "A01",
    } satisfies Omit<Finding, "status">;
    const open: Finding = { ...base, status: "OPEN" };
    const candidate: Finding = { ...open, status: "CANDIDATE_RESOLVED", evidenceRefs: [] };
    expect(() => transitionFinding(open, { ...candidate, status: "RESOLVED" })).toThrow("RALPH_INVALID_FINDING_TRANSITION");

    let state = startedState(["T01"]);
    state = reduce(state, event(3, "finding.state-changed", { finding: open }, { kind: "finding", id: "F01" }, "CORE"));
    state = reduce(state, event(4, "finding.state-changed", { finding: candidate }, { kind: "finding", id: "F01" }, "AUDITOR"));
    const proof = {
      evidenceId: "E02", evidenceSetId: "ES02", digest: "digest-2", kind: "validation-artifact" as const,
      provenance: "CORE" as const, integrity: "VERIFIED" as const, storageRef: "evidence/E02", capturedAt: "2026-09-05T00:04:00.000Z",
    };
    const resolved: Finding = {
      ...candidate, status: "RESOLVED", evidenceRefs: [proof], resolutionEvidenceDigest: proof.digest,
      resolutionAuditId: "AUDIT-02", resolutionValidationSetDigest: "validation-02", resolutionCriterionResult: "PASS",
    };
    expect(() => reduce(state, event(5, "finding.state-changed", { finding: resolved }, { kind: "finding", id: "F01" }, "AUDITOR"))).toThrow("RALPH_AUDITOR_CANNOT_RESOLVE_FINDING");
    state = reduce(state, event(5, "finding.state-changed", { finding: resolved }, { kind: "finding", id: "F01" }, "CORE"));
    expect(state.findings.F01?.status).toBe("RESOLVED");
  });

  it("rejects a foreign-run event at the reducer authority boundary", () => {
    const state = startedState(["T01"]);
    const foreign = createRalphEvent({
      eventId: "foreign", eventType: "run.started", schemaVersion: RALPH_EVENT_SCHEMA, runId: "run-B", sequence: 3,
      occurredAt: "2026-09-05T00:05:00.000Z", recordedAt: "2026-09-05T00:05:00.100Z", entity: { kind: "run", id: "run-B" },
      actor: "CORE", causationId: null, correlationId: "foreign", payload: {}, previousEventHash: state.lastEventHash,
    });
    expect(() => reduceRalphEvent(state, foreign)).toThrow("RALPH_REDUCER_FOREIGN_RUN");
  });

  it("rejects Audit approval bound to stale evidence or failed deterministic validation", () => {
    const result = {
      auditId: "audit-1",
      binding: { runId: "run-1", phaseId: "P01", taskId: "T01", attemptId: "A01", auditReviewOrdinal: 1, evidenceSetId: "E1", evidenceDigest: "D1", validationSetDigest: "V1", postExecutorFingerprint: "F1", criterionSetVersion: "v1", criterionSetDigest: "C1", auditorProfileDigest: "P1" },
      result: "PASS",
      criteria: [],
      issuedAt: "2026-09-05T00:00:00.000Z",
    } as AuditResult;
    const context = { ...result.binding, currentAttemptId: "A01", currentEvidenceSetId: "E1", currentEvidenceDigest: "D1", currentValidationSetDigest: "V1", currentPostExecutorFingerprint: "F1", criterionSetVersion: "v1", criterionSetDigest: "C1", auditorProfileDigest: "P1", validationResults: [], newerEvidenceExists: true };
    expect(validateAuditBinding(result, context)).toEqual({ valid: false, reason: "EVIDENCE_STALE" });
  });
});
