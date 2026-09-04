import { stdout } from "node:process";
import {
  resolveProgressiveInitRequest,
  runProgressiveInitWizardStageCommand,
  type ProgressiveInitCliOptions,
} from "./cli.js";
import {
  inspectProgressiveInit,
  type ProgressiveInitResult,
  type ProgressiveStageSnapshot,
} from "./coordinator.js";
import {
  PROGRESSIVE_INIT_STAGES,
  progressiveInitStageDefinition,
  type ProgressiveInitStage,
} from "./stages.js";
import {
  assertProgressiveRalphReadiness,
  assertProgressiveStageReadiness,
  progressiveStageNeedsReadinessWork,
  projectProgressiveRalphReadiness,
} from "./readiness.js";

export type ProgressiveInitWizardOptions = Omit<ProgressiveInitCliOptions, "stage">;

export interface ProgressiveInitWizardResult {
  readonly executedStages: readonly ProgressiveInitStage[];
  readonly skippedStages: readonly ProgressiveInitStage[];
  readonly semanticOperations: number;
  readonly correctiveRegenerations: number;
  readonly alreadyComplete: boolean;
  readonly closureStatus: "fresh";
}

/**
 * Additive presentation observability. Orchestration performs exactly the same
 * work whether or not an observer is attached, and an observer never influences
 * a stage decision, a skip, or closure.
 */
export type ProgressiveInitWizardObservation =
  | { readonly kind: "run-started"; readonly alreadyComplete: boolean }
  | { readonly kind: "stage-snapshot"; readonly snapshots: readonly ProgressiveStageSnapshot[] }
  | { readonly kind: "stage-skipped"; readonly stage: ProgressiveInitStage }
  | { readonly kind: "stage-started"; readonly stage: ProgressiveInitStage }
  | { readonly kind: "stage-finished"; readonly stage: ProgressiveInitStage; readonly result: ProgressiveInitResult }
  | { readonly kind: "stage-failed"; readonly stage: ProgressiveInitStage; readonly reason: string }
  | { readonly kind: "run-completed"; readonly result: ProgressiveInitWizardResult };

export interface ProgressiveInitWizardRuntime {
  readonly inspect: (root: string, request?: string) => Promise<readonly ProgressiveStageSnapshot[]>;
  readonly runStage: (options: ProgressiveInitCliOptions) => Promise<ProgressiveInitResult>;
  readonly write: (value: string) => void;
  readonly observe?: (observation: ProgressiveInitWizardObservation) => void;
}

function notify(
  runtime: ProgressiveInitWizardRuntime,
  observation: ProgressiveInitWizardObservation,
): void {
  // Presentation must never fail semantic execution.
  try { runtime.observe?.(observation); } catch { /* observation is cosmetic */ }
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function snapshotFor(
  statuses: readonly ProgressiveStageSnapshot[],
  stage: ProgressiveInitStage,
): ProgressiveStageSnapshot {
  const snapshot = statuses.find((entry) => entry.stage === stage);
  if (!snapshot) throw new Error(`PROGRESSIVE_INIT_STATUS_MISSING: no status authority exists for ${stage}`);
  return snapshot;
}

/** Wizard-only orchestration. Stage semantics, prerequisites, freshness, and closure remain coordinator-owned. */
export async function executeProgressiveInitWizard(
  options: ProgressiveInitWizardOptions,
  runtime: ProgressiveInitWizardRuntime,
): Promise<ProgressiveInitWizardResult> {
  const request = await resolveProgressiveInitRequest(options);
  const initial = await runtime.inspect(options.projectRoot, request);
  const alreadyComplete = projectProgressiveRalphReadiness(initial).ready;
  const executedStages: ProgressiveInitStage[] = [];
  const skippedStages: ProgressiveInitStage[] = [];
  let semanticOperations = 0;
  let correctiveRegenerations = 0;

  runtime.write("\nProgressive Init\n\n");
  notify(runtime, { kind: "run-started", alreadyComplete });
  notify(runtime, { kind: "stage-snapshot", snapshots: initial });
  for (const [index, stage] of PROGRESSIVE_INIT_STAGES.entries()) {
    const label = progressiveInitStageDefinition(stage).label;
    const statuses = await runtime.inspect(options.projectRoot, request);
    notify(runtime, { kind: "stage-snapshot", snapshots: statuses });
    const before = snapshotFor(statuses, stage);
    if (!progressiveStageNeedsReadinessWork(before)) {
      skippedStages.push(stage);
      notify(runtime, { kind: "stage-skipped", stage });
      runtime.write(`[${index + 1}/${PROGRESSIVE_INIT_STAGES.length}] ${label}\n      COMPLETE (already fresh; skipped)\n\n`);
      continue;
    }

    runtime.write(`[${index + 1}/${PROGRESSIVE_INIT_STAGES.length}] ${label}\n      RUNNING\n`);
    notify(runtime, { kind: "stage-started", stage });
    try {
      const result = await runtime.runStage({ ...options, stage });
      semanticOperations += result.semanticOperations;
      correctiveRegenerations += result.correctiveRegenerations;
      const afterStatuses = await runtime.inspect(options.projectRoot, request);
      notify(runtime, { kind: "stage-snapshot", snapshots: afterStatuses });
      const after = snapshotFor(afterStatuses, stage);
      assertProgressiveStageReadiness(after);
      executedStages.push(stage);
      notify(runtime, { kind: "stage-finished", stage, result });
      runtime.write("      COMPLETE\n\n");
    } catch (error) {
      notify(runtime, { kind: "stage-failed", stage, reason: failureMessage(error) });
      runtime.write(`\nProgressive Init stopped at:\n${stage}\n\nReason:\n${failureMessage(error)}\n`);
      throw error;
    }
  }

  const finalStatuses = await runtime.inspect(options.projectRoot, request);
  notify(runtime, { kind: "stage-snapshot", snapshots: finalStatuses });
  assertProgressiveRalphReadiness(finalStatuses);
  runtime.write(alreadyComplete
    ? "Progressive Init already complete and fresh.\nCanonical closure: COMPLETE\nRalph: READY\n"
    : "Progressive Init complete.\nCanonical closure: COMPLETE\nRalph: READY\n");
  runtime.write(`Semantic operations: ${semanticOperations}\nCorrective regenerations: ${correctiveRegenerations}\n`);
  const result: ProgressiveInitWizardResult = {
    executedStages,
    skippedStages,
    semanticOperations,
    correctiveRegenerations,
    alreadyComplete,
    closureStatus: "fresh",
  };
  notify(runtime, { kind: "run-completed", result });
  return result;
}

export async function runProgressiveInitWizardCommand(
  options: ProgressiveInitWizardOptions,
): Promise<ProgressiveInitWizardResult> {
  return executeProgressiveInitWizard(options, {
    inspect: inspectProgressiveInit,
    runStage: runProgressiveInitWizardStageCommand,
    write: (value) => void stdout.write(value),
  });
}
