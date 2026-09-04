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

export type ProgressiveInitWizardOptions = Omit<ProgressiveInitCliOptions, "stage">;

export interface ProgressiveInitWizardResult {
  readonly executedStages: readonly ProgressiveInitStage[];
  readonly skippedStages: readonly ProgressiveInitStage[];
  readonly semanticOperations: number;
  readonly correctiveRegenerations: number;
  readonly alreadyComplete: boolean;
  readonly closureStatus: "fresh";
}

export interface ProgressiveInitWizardRuntime {
  readonly inspect: (root: string, request?: string) => Promise<readonly ProgressiveStageSnapshot[]>;
  readonly runStage: (options: ProgressiveInitCliOptions) => Promise<ProgressiveInitResult>;
  readonly write: (value: string) => void;
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

function needsWork(snapshot: ProgressiveStageSnapshot): boolean {
  return snapshot.status !== "complete-fresh"
    || snapshot.stage === "project-phases" && snapshot.closureStatus !== "fresh";
}

function requireCompleted(snapshot: ProgressiveStageSnapshot): void {
  if (snapshot.status !== "complete-fresh") {
    throw new Error(`PROGRESSIVE_INIT_STAGE_DID_NOT_COMPLETE: ${snapshot.stage} is ${snapshot.status}`);
  }
  if (snapshot.stage === "project-phases" && snapshot.closureStatus !== "fresh") {
    throw new Error(`PROGRESSIVE_INIT_CLOSURE_DID_NOT_COMPLETE: canonical closure is ${snapshot.closureStatus ?? "missing"}`);
  }
}

/** Wizard-only orchestration. Stage semantics, prerequisites, freshness, and closure remain coordinator-owned. */
export async function executeProgressiveInitWizard(
  options: ProgressiveInitWizardOptions,
  runtime: ProgressiveInitWizardRuntime,
): Promise<ProgressiveInitWizardResult> {
  const request = await resolveProgressiveInitRequest(options);
  const initial = await runtime.inspect(options.projectRoot, request);
  const alreadyComplete = PROGRESSIVE_INIT_STAGES.every((stage) => !needsWork(snapshotFor(initial, stage)));
  const executedStages: ProgressiveInitStage[] = [];
  const skippedStages: ProgressiveInitStage[] = [];
  let semanticOperations = 0;
  let correctiveRegenerations = 0;

  runtime.write("\nProgressive Init\n\n");
  for (const [index, stage] of PROGRESSIVE_INIT_STAGES.entries()) {
    const label = progressiveInitStageDefinition(stage).label;
    const statuses = await runtime.inspect(options.projectRoot, request);
    const before = snapshotFor(statuses, stage);
    if (!needsWork(before)) {
      skippedStages.push(stage);
      runtime.write(`[${index + 1}/${PROGRESSIVE_INIT_STAGES.length}] ${label}\n      COMPLETE (already fresh; skipped)\n\n`);
      continue;
    }

    runtime.write(`[${index + 1}/${PROGRESSIVE_INIT_STAGES.length}] ${label}\n      RUNNING\n`);
    try {
      const result = await runtime.runStage({ ...options, stage });
      semanticOperations += result.semanticOperations;
      correctiveRegenerations += result.correctiveRegenerations;
      const after = snapshotFor(await runtime.inspect(options.projectRoot, request), stage);
      requireCompleted(after);
      executedStages.push(stage);
      runtime.write("      COMPLETE\n\n");
    } catch (error) {
      runtime.write(`\nProgressive Init stopped at:\n${stage}\n\nReason:\n${failureMessage(error)}\n`);
      throw error;
    }
  }

  const finalStatuses = await runtime.inspect(options.projectRoot, request);
  for (const stage of PROGRESSIVE_INIT_STAGES) requireCompleted(snapshotFor(finalStatuses, stage));
  runtime.write(alreadyComplete
    ? "Progressive Init already complete and fresh.\nCanonical closure: COMPLETE\nRalph: READY\n"
    : "Progressive Init complete.\nCanonical closure: COMPLETE\nRalph: READY\n");
  runtime.write(`Semantic operations: ${semanticOperations}\nCorrective regenerations: ${correctiveRegenerations}\n`);
  return {
    executedStages,
    skippedStages,
    semanticOperations,
    correctiveRegenerations,
    alreadyComplete,
    closureStatus: "fresh",
  };
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
