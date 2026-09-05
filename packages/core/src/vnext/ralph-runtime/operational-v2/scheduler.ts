import type { ExecutionDocument, Task } from "../../../types.js";
import type { PhaseDisposition, RunHold, TaskHold } from "../contracts.js";
import { assertV2RuntimeState, hasOpenAttemptV2 } from "./state.js";
import type { RalphRuntimeStateV2 } from "./contracts.js";

export interface RuntimeIntegrityFacts {
  readonly valid: boolean;
  readonly controlPlaneValid?: boolean;
  readonly admissionValid?: boolean;
  readonly reason?: string;
}

export interface FingerprintComparison {
  readonly valid: boolean;
  readonly checkpointValid?: boolean;
  readonly reason?: string;
  readonly expectedFingerprint?: string;
  readonly observedFingerprint?: string;
}

export interface AttemptBudgetView {
  readonly attemptAvailable?: boolean;
  readonly available?: boolean;
  readonly exhausted?: boolean;
  readonly reason?: string;
}

export interface SequentialSchedulerInput {
  readonly plan: ExecutionDocument;
  readonly state: RalphRuntimeStateV2;
  readonly runtimeIntegrity?: RuntimeIntegrityFacts;
  readonly runtimeIntegrityFacts?: RuntimeIntegrityFacts;
  readonly admissionFacts?: RuntimeIntegrityFacts;
  readonly fingerprintComparison?: FingerprintComparison;
  readonly workspaceComparison?: FingerprintComparison;
  readonly budget?: AttemptBudgetView;
  readonly budgetView?: AttemptBudgetView;
}

export interface SchedulerCandidate {
  readonly taskId: string;
  readonly phaseId: string;
  readonly reason: "FIRST_ELIGIBLE_TASK_IN_PLAN_ORDER";
  readonly parallelSafe: boolean;
}

export const SEQUENTIAL_PHASE_REASONS = {
  incomplete: "PREVIOUS_PHASE_INCOMPLETE",
  terminallyUnavailable: "PREVIOUS_PHASE_TERMINALLY_UNAVAILABLE",
} as const;
export type SequentialPhaseReason = typeof SEQUENTIAL_PHASE_REASONS[keyof typeof SEQUENTIAL_PHASE_REASONS];

export const EXPLICIT_PHASE_DEPENDENCY_REASONS = {
  incomplete: "PHASE_DEPENDENCY_INCOMPLETE",
  terminallyUnavailable: "PHASE_DEPENDENCY_TERMINALLY_UNAVAILABLE",
} as const;
export type ExplicitPhaseDependencyReason = typeof EXPLICIT_PHASE_DEPENDENCY_REASONS[keyof typeof EXPLICIT_PHASE_DEPENDENCY_REASONS];

export type SchedulerDecision =
  | { readonly kind: "CANDIDATE"; readonly candidate: SchedulerCandidate; readonly reason: SchedulerCandidate["reason"] }
  | { readonly kind: "NO_WORK"; readonly reason: string }
  | { readonly kind: "WAITING"; readonly reason: string; readonly phaseId?: string; readonly taskId?: string; readonly dependencyId?: string }
  | { readonly kind: "BLOCKED"; readonly reason: string; readonly phaseId?: string; readonly taskId?: string; readonly dependencyId?: string }
  | { readonly kind: "HOLD"; readonly hold: RunHold | TaskHold; readonly reason: string; readonly taskId?: string }
  | { readonly kind: "RECONCILIATION_REQUIRED"; readonly reason: string };

/**
 * Pure, sequential V2 planner.  It selects at most one plan Task and has no
 * event, lease, attempt, filesystem, clock, or execution side effect.
 */
export function scheduleNextTask(input: SequentialSchedulerInput): SchedulerDecision {
  assertV2RuntimeState(input.state);
  assertValidatedPlanShape(input.plan);

  if (input.state.disposition !== "ACTIVE") return { kind: "NO_WORK", reason: "RUN_NOT_ACTIVE" };
  if (input.state.hold !== "NONE") return { kind: "HOLD", hold: input.state.hold, reason: "RUN_HOLD_ACTIVE" };

  const integrityFacts = [input.runtimeIntegrityFacts, input.runtimeIntegrity, input.admissionFacts].filter((facts): facts is RuntimeIntegrityFacts => facts !== undefined);
  const invalidIntegrity = integrityFacts.find((facts) => !facts.valid || facts.controlPlaneValid === false || facts.admissionValid === false);
  if (invalidIntegrity) {
    return { kind: "RECONCILIATION_REQUIRED", reason: invalidIntegrity.reason ?? "RUNTIME_INTEGRITY_INVALID" };
  }
  const fingerprint = input.fingerprintComparison ?? input.workspaceComparison;
  if (fingerprint && (!fingerprint.valid || fingerprint.checkpointValid === false)) {
    return { kind: "RECONCILIATION_REQUIRED", reason: fingerprint.reason ?? "WORKSPACE_OR_CHECKPOINT_MISMATCH" };
  }

  // The Attempt barrier is evaluated before any Task eligibility.  An
  // AWAITING_AUDIT Attempt is still OPEN and therefore blocks every Task.
  if (hasOpenAttemptV2(input.state)) return { kind: "WAITING", reason: "OPEN_ATTEMPT_BARRIER" };

  const budget = input.budgetView ?? input.budget;
  if (budget && !budgetAvailable(budget)) return { kind: "NO_WORK", reason: budget.reason ?? "NEW_ATTEMPT_BUDGET_EXHAUSTED" };

  let waiting: SchedulerDecision | undefined;
  let blocked: SchedulerDecision | undefined;
  let taskHold: SchedulerDecision | undefined;
  let busy: SchedulerDecision | undefined;
  let phaseUnavailable: SchedulerDecision | undefined;
  let sequentialBarrier: SchedulerDecision | undefined;

  for (let phaseIndex = 0; phaseIndex < input.plan.phases.length; phaseIndex += 1) {
    const phase = input.plan.phases[phaseIndex];
    if (!phase) continue;
    const phaseState = input.state.phases[phase.id];
    if (!phaseState) return { kind: "RECONCILIATION_REQUIRED", reason: `UNKNOWN_PHASE:${phase.id}` };

    // rb-execution/v1: Phases are always executed sequentially.  This is an
    // operational ordering barrier, not an entry in phase.dependsOn.
    const previousPhase = input.plan.phases[phaseIndex - 1];
    if (previousPhase) {
      const previousPhaseState = input.state.phases[previousPhase.id];
      if (!previousPhaseState) return { kind: "RECONCILIATION_REQUIRED", reason: `UNKNOWN_PHASE:${previousPhase.id}` };
      if (previousPhaseState.disposition === "FAILED" || previousPhaseState.disposition === "BLOCKED") {
        sequentialBarrier ??= {
          kind: "BLOCKED",
          reason: SEQUENTIAL_PHASE_REASONS.terminallyUnavailable,
          phaseId: phase.id,
          dependencyId: previousPhase.id,
        };
      } else if (previousPhaseState.disposition !== "COMPLETE") {
        sequentialBarrier ??= {
          kind: "WAITING",
          reason: SEQUENTIAL_PHASE_REASONS.incomplete,
          phaseId: phase.id,
          dependencyId: previousPhase.id,
        };
      }
      if (previousPhaseState.disposition !== "COMPLETE") continue;
    }

    // Explicit phase dependencies remain an independent plan relation.  The
    // previous phase is intentionally not inserted into this collection.
    let explicitPhaseBlocked = false;
    let explicitPhaseWaiting = false;
    for (const dependencyId of phase.dependsOn) {
      const dependency = input.state.phases[dependencyId];
      if (!dependency) return { kind: "RECONCILIATION_REQUIRED", reason: `UNKNOWN_PHASE_DEPENDENCY:${dependencyId}` };
      if (dependency.disposition === "FAILED" || dependency.disposition === "BLOCKED") {
        explicitPhaseBlocked = true;
        blocked ??= { kind: "BLOCKED", reason: EXPLICIT_PHASE_DEPENDENCY_REASONS.terminallyUnavailable, phaseId: phase.id, dependencyId };
      } else if (dependency.disposition !== "COMPLETE") {
        explicitPhaseWaiting = true;
        waiting ??= { kind: "WAITING", reason: EXPLICIT_PHASE_DEPENDENCY_REASONS.incomplete, phaseId: phase.id, dependencyId };
      }
    }
    if (phaseState.disposition === "FAILED" || phaseState.disposition === "BLOCKED") {
      const heldTask = phase.tasks
        .map((planTask) => input.state.tasks[planTask.id])
        .find((task): task is NonNullable<typeof task> => task !== undefined && task.hold !== "NONE");
      if (heldTask) {
        taskHold ??= { kind: "HOLD", hold: heldTask.hold, reason: "TASK_HOLD_ACTIVE", taskId: heldTask.taskId };
        continue;
      }
      phaseUnavailable ??= { kind: "BLOCKED", reason: "PHASE_TERMINALLY_UNAVAILABLE", phaseId: phase.id };
      continue;
    }
    if (explicitPhaseBlocked || explicitPhaseWaiting) continue;

    for (const planTask of phase.tasks) {
      const task = input.state.tasks[planTask.id];
      if (!task) return { kind: "RECONCILIATION_REQUIRED", reason: `UNKNOWN_TASK:${planTask.id}` };
      if (task.phaseId !== phase.id) return { kind: "RECONCILIATION_REQUIRED", reason: `TASK_PHASE_MISMATCH:${planTask.id}` };
      if (!sameIds(task.dependsOn, planTask.dependsOn)) return { kind: "RECONCILIATION_REQUIRED", reason: `TASK_DEPENDENCY_VIEW_MISMATCH:${planTask.id}` };

      if (task.disposition === "COMPLETE") continue;
      if (task.disposition === "FAILED" || task.disposition === "BLOCKED") {
        blocked ??= { kind: "BLOCKED", reason: "TASK_TERMINALLY_UNAVAILABLE", phaseId: phase.id, taskId: task.taskId };
        continue;
      }
      if (task.hold !== "NONE") {
        taskHold ??= { kind: "HOLD", hold: task.hold, reason: "TASK_HOLD_ACTIVE", taskId: task.taskId };
        continue;
      }
      if (task.activity !== "IDLE" || task.owner !== "NONE") {
        busy ??= { kind: "HOLD", hold: "RECONCILIATION_REQUIRED", reason: "TASK_NOT_IDLE_OR_UNOWNED", taskId: task.taskId };
        continue;
      }
      if (task.disposition !== "READY") {
        waiting ??= { kind: "WAITING", reason: "TASK_NOT_READY", phaseId: phase.id, taskId: task.taskId };
        continue;
      }

      let dependencyWaiting = false;
      let dependencyBlocked = false;
      for (const dependencyId of planTask.dependsOn) {
        const dependency = input.state.tasks[dependencyId];
        if (!dependency) return { kind: "RECONCILIATION_REQUIRED", reason: `UNKNOWN_TASK_DEPENDENCY:${dependencyId}` };
        if (dependency.disposition === "FAILED" || dependency.disposition === "BLOCKED") {
          dependencyBlocked = true;
          blocked ??= { kind: "BLOCKED", reason: "TASK_DEPENDENCY_TERMINALLY_UNAVAILABLE", phaseId: phase.id, taskId: task.taskId, dependencyId };
        } else if (dependency.disposition !== "COMPLETE") {
          dependencyWaiting = true;
          waiting ??= { kind: "WAITING", reason: "TASK_DEPENDENCY_INCOMPLETE", phaseId: phase.id, taskId: task.taskId, dependencyId };
        }
      }
      if (dependencyBlocked || dependencyWaiting) continue;

      return {
        kind: "CANDIDATE",
        reason: "FIRST_ELIGIBLE_TASK_IN_PLAN_ORDER",
        candidate: { taskId: task.taskId, phaseId: phase.id, reason: "FIRST_ELIGIBLE_TASK_IN_PLAN_ORDER", parallelSafe: planTask.parallelSafe },
      };
    }
  }

  return sequentialBarrier ?? blocked ?? phaseUnavailable ?? taskHold ?? busy ?? waiting ?? { kind: "NO_WORK", reason: "NO_ELIGIBLE_TASK" };
}

export function selectNextTask(input: SequentialSchedulerInput): SchedulerDecision;
export function selectNextTask(plan: ExecutionDocument, state: RalphRuntimeStateV2, facts?: Omit<SequentialSchedulerInput, "plan" | "state">): SchedulerDecision;
export function selectNextTask(
  inputOrPlan: SequentialSchedulerInput | ExecutionDocument,
  maybeState?: RalphRuntimeStateV2,
  facts: Omit<SequentialSchedulerInput, "plan" | "state"> = {},
): SchedulerDecision {
  return "plan" in inputOrPlan
    ? scheduleNextTask(inputOrPlan as SequentialSchedulerInput)
    : scheduleNextTask({ ...facts, plan: inputOrPlan, state: maybeState as RalphRuntimeStateV2 });
}

export const planNextTask = scheduleNextTask;

function budgetAvailable(budget: AttemptBudgetView): boolean {
  if (budget.attemptAvailable !== undefined) return budget.attemptAvailable;
  if (budget.available !== undefined) return budget.available;
  return budget.exhausted !== true;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertValidatedPlanShape(plan: ExecutionDocument): void {
  if (plan.contract !== "rb-execution/v1" || !plan.artifactId || !Array.isArray(plan.phases) || plan.phases.length === 0) throw new Error("RALPH_V2_SCHEDULER_PLAN_INVALID");
  const phases = new Set<string>();
  const tasks = new Set<string>();
  let previousTaskNumber = 0;
  for (let phaseIndex = 0; phaseIndex < plan.phases.length; phaseIndex += 1) {
    const phase = plan.phases[phaseIndex];
    if (!phase || !phase.id || phases.has(phase.id) || phase.number !== phaseIndex + 1 || phase.tasks.length === 0) throw new Error("RALPH_V2_SCHEDULER_PLAN_INVALID");
    phases.add(phase.id);
    for (const dependency of phase.dependsOn) if (!phases.has(dependency)) throw new Error("RALPH_V2_SCHEDULER_PLAN_INVALID");
    for (const task of phase.tasks) {
      const number = Number(task.id.slice(1));
      if (!task.id || tasks.has(task.id) || !Number.isSafeInteger(number) || number <= previousTaskNumber) throw new Error("RALPH_V2_SCHEDULER_PLAN_INVALID");
      tasks.add(task.id);
      previousTaskNumber = number;
      for (const dependency of task.dependsOn) if (!tasks.has(dependency)) throw new Error("RALPH_V2_SCHEDULER_PLAN_INVALID");
      if (typeof task.parallelSafe !== "boolean") throw new Error("RALPH_V2_SCHEDULER_PLAN_INVALID");
    }
  }
}

// Retained as a type-only reference to make it explicit that phase state is a
// Foundation dimension, not a scheduler-owned replacement.
export type FoundationPhaseDisposition = PhaseDisposition;
