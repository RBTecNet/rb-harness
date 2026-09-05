import type {
  Finding,
  PhaseActivity,
  PhaseDisposition,
  PhaseState,
  RalphRuntimeState,
  RunHold,
  RunState,
  TaskActivity,
  TaskDisposition,
  TaskState,
} from "./contracts.js";

export interface InitialPhase {
  readonly phaseId: string;
  readonly taskIds: readonly string[];
}

export type InitialTask = Pick<TaskState, "taskId" | "phaseId" | "dependsOn">;

export function createInitialRuntimeState(input: {
  readonly runId: string;
  readonly phases: readonly InitialPhase[];
  readonly tasks: readonly InitialTask[];
}): RalphRuntimeState {
  const phaseIds = input.phases.map((phase) => phase.phaseId);
  const taskIds = input.tasks.map((task) => task.taskId);
  const tasks: Record<string, TaskState> = Object.fromEntries(input.tasks.map((task) => [task.taskId, {
    ...task,
    disposition: "PENDING" as const,
    activity: "IDLE" as const,
    owner: "NONE" as const,
    hold: "NONE" as const,
    attemptsUsed: 0,
    findingIds: [],
    updatedAt: "",
  }]));
  const phases: Record<string, PhaseState> = Object.fromEntries(input.phases.map((phase) => [phase.phaseId, {
    ...phase,
    disposition: "PENDING" as const,
    activity: "IDLE" as const,
  }]));
  return {
    format: "rb-ralph-runtime-state/v1",
    runId: input.runId,
    disposition: "CREATED",
    hold: "NONE",
    phaseIds,
    taskIds,
    phases,
    tasks,
    attempts: {},
    findings: {},
    checkpoints: {},
    lastSequence: 0,
    lastEventHash: null,
    finalStatePersisted: false,
  };
}

export function taskIsActive(task: Pick<TaskState, "activity">): boolean {
  return task.activity !== "IDLE";
}

export function taskDependenciesSatisfied(task: Pick<TaskState, "dependsOn">, tasks: Readonly<Record<string, TaskState>>): boolean {
  return task.dependsOn.every((dependencyId) => tasks[dependencyId]?.disposition === "COMPLETE");
}

export function taskIsExecutableReady(task: TaskState, tasks: Readonly<Record<string, TaskState>>): boolean {
  return task.disposition === "READY" && task.activity === "IDLE" && task.hold === "NONE" && taskDependenciesSatisfied(task, tasks);
}

export function phaseHasExecutableReadyTask(phase: Pick<PhaseState, "taskIds">, tasks: Readonly<Record<string, TaskState>>): boolean {
  return phase.taskIds.some((taskId) => {
    const task = tasks[taskId];
    return task !== undefined && taskIsExecutableReady(task, tasks);
  });
}

export function phaseHasActiveTask(phase: Pick<PhaseState, "taskIds">, tasks: Readonly<Record<string, TaskState>>): boolean {
  return phase.taskIds.some((taskId) => {
    const task = tasks[taskId];
    return task !== undefined && taskIsActive(task);
  });
}

export function derivePhaseState(phase: Pick<PhaseState, "phaseId" | "taskIds">, tasks: Readonly<Record<string, TaskState>>): PhaseState {
  const phaseTasks = phase.taskIds.map((taskId) => tasks[taskId]).filter((task): task is TaskState => task !== undefined);
  const allTasksComplete = phaseTasks.length > 0 && phaseTasks.every((task) => task.disposition === "COMPLETE");
  const hasFailedTask = phaseTasks.some((task) => task.disposition === "FAILED");
  const hasActiveTask = phaseTasks.some(taskIsActive);
  const hasExecutableReadyTask = phaseTasks.some((task) => taskIsExecutableReady(task, tasks));
  const hasBlockingCondition = phaseTasks.some((task) => task.disposition === "BLOCKED" || task.hold !== "NONE");

  let disposition: PhaseDisposition;
  if (allTasksComplete) disposition = "COMPLETE";
  else if (hasFailedTask) disposition = "FAILED";
  else if (!hasActiveTask && !hasExecutableReadyTask && hasBlockingCondition) disposition = "BLOCKED";
  else if (hasExecutableReadyTask) disposition = "READY";
  else disposition = "PENDING";

  const activity: PhaseActivity = hasActiveTask ? "ACTIVE" : "IDLE";
  return { phaseId: phase.phaseId, taskIds: [...phase.taskIds], disposition, activity };
}

export function deriveAllPhases(state: Pick<RalphRuntimeState, "phases" | "tasks">): Readonly<Record<string, PhaseState>> {
  return Object.fromEntries(Object.values(state.phases).map((phase) => [phase.phaseId, derivePhaseState(phase, state.tasks)]));
}

export function runHasEligibleWork(state: Pick<RalphRuntimeState, "tasks">): boolean {
  return Object.values(state.tasks).some((task) => taskIsActive(task) || taskIsExecutableReady(task, state.tasks));
}

export function runHasKnownBlockingCondition(state: Pick<RalphRuntimeState, "tasks">): boolean {
  return Object.values(state.tasks).some((task) => task.disposition === "BLOCKED" || task.hold !== "NONE");
}

export function deriveLocalBlockingRunHold(state: Pick<RalphRuntimeState, "disposition" | "hold" | "tasks">): RunHold {
  if (state.disposition === "COMPLETE" || state.disposition === "FAILED" || state.hold !== "NONE") return state.hold;
  return !runHasEligibleWork(state) && runHasKnownBlockingCondition(state) ? "BLOCKED" : "NONE";
}

function isBlockingFinding(finding: Finding): boolean {
  return finding.severity === "BLOCKER" && !["RESOLVED", "SUPERSEDED"].includes(finding.status);
}

export function canCompleteRun(state: RalphRuntimeState, finalStatePersisted = false): boolean {
  const allPhasesComplete = state.phaseIds.every((phaseId) => state.phases[phaseId]?.disposition === "COMPLETE");
  const noOpenBlockingFindings = !Object.values(state.findings).some(isBlockingFinding);
  const noPendingHumanGate = Object.values(state.findings).every((finding) => finding.status !== "HUMAN_PENDING")
    && Object.values(state.tasks).every((task) => task.hold !== "HUMAN_REQUIRED");
  const noActiveAttempt = Object.values(state.attempts).every((attempt) => attempt.closed);
  const noProviderFailurePending = state.hold !== "PROVIDER_UNAVAILABLE"
    && Object.values(state.tasks).every((task) => task.hold !== "PROVIDER_UNAVAILABLE");
  const noReconciliationRequired = state.hold !== "RECONCILIATION_REQUIRED"
    && Object.values(state.tasks).every((task) => task.hold !== "WORKSPACE_DRIFT" && task.activity !== "RECONCILING");
  return state.hold === "NONE"
    && allPhasesComplete
    && noOpenBlockingFindings
    && noPendingHumanGate
    && noActiveAttempt
    && noProviderFailurePending
    && noReconciliationRequired
    && (finalStatePersisted || state.finalStatePersisted);
}

export function activeTaskIds(state: Pick<RalphRuntimeState, "tasks">): readonly string[] {
  return Object.values(state.tasks).filter(taskIsActive).map((task) => task.taskId).sort();
}

export function phaseProgress(phase: PhaseState, tasks: Readonly<Record<string, TaskState>>): {
  readonly totalTasks: number;
  readonly completeTasks: number;
  readonly activeTaskIds: readonly string[];
  readonly blockedTasks: number;
  readonly failedTasks: number;
  readonly progress: number;
} {
  const phaseTasks = phase.taskIds.map((id) => tasks[id]).filter((task): task is TaskState => task !== undefined);
  const completeTasks = phaseTasks.filter((task) => task.disposition === "COMPLETE").length;
  return {
    totalTasks: phaseTasks.length,
    completeTasks,
    activeTaskIds: phaseTasks.filter(taskIsActive).map((task) => task.taskId).sort(),
    blockedTasks: phaseTasks.filter((task) => task.disposition === "BLOCKED").length,
    failedTasks: phaseTasks.filter((task) => task.disposition === "FAILED").length,
    progress: phaseTasks.length === 0 ? 0 : completeTasks / phaseTasks.length,
  };
}

export function assertRunCombination(disposition: RunState["disposition"], hold: RunHold): void {
  if ((disposition === "CREATED" || disposition === "COMPLETE" || disposition === "FAILED") && hold !== "NONE") {
    throw new Error(`RALPH_INVALID_RUN_COMBINATION: ${disposition}+${hold}`);
  }
}

export function assertTaskState(task: Pick<TaskState, "disposition" | "activity" | "owner" | "hold">): void {
  if ((task.disposition === "PENDING" || task.disposition === "COMPLETE" || task.disposition === "FAILED") && task.activity !== "IDLE") {
    throw new Error(`RALPH_INVALID_TASK_ACTIVITY: ${task.disposition}+${task.activity}`);
  }
  if (task.disposition === "COMPLETE" && (task.owner !== "NONE" || task.hold !== "NONE")) throw new Error("RALPH_COMPLETE_TASK_HAS_OWNER_OR_HOLD");
  if (task.disposition === "PENDING" && (task.owner !== "NONE" || task.hold !== "NONE")) throw new Error("RALPH_PENDING_TASK_HAS_OWNER_OR_HOLD");
  if (task.disposition === "BLOCKED" && task.hold === "NONE") throw new Error("RALPH_BLOCKED_TASK_MISSING_HOLD");
  if (task.activity !== "IDLE" && task.owner === "NONE") throw new Error("RALPH_ACTIVE_TASK_MISSING_OWNER");
}
