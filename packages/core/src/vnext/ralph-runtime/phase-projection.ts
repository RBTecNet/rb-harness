import type { PhaseState, RalphRuntimeState } from "./contracts.js";
import { derivePhaseState, phaseProgress } from "./state.js";

export interface PhaseProjection {
  readonly phaseId: string;
  readonly disposition: PhaseState["disposition"];
  readonly activity: PhaseState["activity"];
  readonly totalTasks: number;
  readonly completeTasks: number;
  readonly activeTaskIds: readonly string[];
  readonly blockedTasks: number;
  readonly failedTasks: number;
  readonly progress: number;
}

export function projectPhase(state: RalphRuntimeState, phaseId: string): PhaseProjection {
  const phase = state.phases[phaseId];
  if (!phase) throw new Error("RALPH_PROJECTION_UNKNOWN_PHASE");
  const derived = derivePhaseState(phase, state.tasks);
  const progress = phaseProgress(derived, state.tasks);
  return { phaseId, disposition: derived.disposition, activity: derived.activity, ...progress };
}

export function projectPhases(state: RalphRuntimeState): readonly PhaseProjection[] {
  return state.phaseIds.map((phaseId) => projectPhase(state, phaseId));
}
