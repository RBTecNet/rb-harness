import type { RalphRuntimeState, TaskState } from "./contracts.js";
import { activeTaskIds } from "./state.js";

export interface TaskProjection extends TaskState {
  readonly isActive: boolean;
}

export interface RunProjection {
  readonly runId: string;
  readonly disposition: RalphRuntimeState["disposition"];
  readonly hold: RalphRuntimeState["hold"];
  readonly activeTaskIds: readonly string[];
  readonly taskCount: number;
}

export function projectTask(state: RalphRuntimeState, taskId: string): TaskProjection {
  const task = state.tasks[taskId];
  if (!task) throw new Error("RALPH_PROJECTION_UNKNOWN_TASK");
  return { ...task, isActive: task.activity !== "IDLE" };
}

export function projectTasks(state: RalphRuntimeState): readonly TaskProjection[] {
  return state.taskIds.map((taskId) => projectTask(state, taskId));
}

export function projectRun(state: RalphRuntimeState): RunProjection {
  return {
    runId: state.runId,
    disposition: state.disposition,
    hold: state.hold,
    activeTaskIds: activeTaskIds(state),
    taskCount: state.taskIds.length,
  };
}
