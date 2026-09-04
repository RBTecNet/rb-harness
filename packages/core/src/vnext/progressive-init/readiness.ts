import { inspectProgressiveInit, type ProgressiveStageSnapshot } from "./coordinator.js";
import { PROGRESSIVE_INIT_STAGES, progressiveInitStageDefinition } from "./stages.js";

export interface ProgressiveRalphReadiness {
  /** True only when every stage is complete/fresh and canonical closure is fresh. */
  readonly ready: boolean;
  readonly stages: readonly ProgressiveStageSnapshot[];
  readonly closureStatus?: "fresh" | "stale";
  readonly reasons: readonly string[];
}

export type ProgressiveStageReadiness =
  | { readonly ready: true }
  | { readonly ready: false; readonly issues: readonly { readonly kind: "stage" | "closure"; readonly reason: string }[] };

/** The single stage/closure predicate used by every Progressive READY caller. */
export function validateProgressiveStageReadiness(snapshot: ProgressiveStageSnapshot): ProgressiveStageReadiness {
  const issues: { kind: "stage" | "closure"; reason: string }[] = [];
  if (snapshot.status !== "complete-fresh") issues.push({ kind: "stage", reason: `${progressiveInitStageDefinition(snapshot.stage).label} is ${snapshot.status}` });
  if (snapshot.stage === "project-phases" && snapshot.closureStatus !== "fresh") {
    issues.push({ kind: "closure", reason: `canonical closure is ${snapshot.closureStatus ?? "absent"}` });
  }
  return issues.length ? { ready: false, issues } : { ready: true };
}

export function progressiveStageNeedsReadinessWork(snapshot: ProgressiveStageSnapshot): boolean {
  return !validateProgressiveStageReadiness(snapshot).ready;
}

export function assertProgressiveStageReadiness(snapshot: ProgressiveStageSnapshot): void {
  const readiness = validateProgressiveStageReadiness(snapshot);
  if (readiness.ready) return;
  if (readiness.issues[0]?.kind === "stage") {
    throw new Error(`PROGRESSIVE_INIT_STAGE_DID_NOT_COMPLETE: ${snapshot.stage} is ${snapshot.status}`);
  }
  throw new Error(`PROGRESSIVE_INIT_CLOSURE_DID_NOT_COMPLETE: canonical closure is ${snapshot.closureStatus ?? "missing"}`);
}

/**
 * A named projection of authority the coordinator already owns. It introduces
 * no new semantic rule: `complete-fresh` for every stage plus a fresh canonical
 * closure is exactly the condition under which `inspectProjectPhasesClosure`
 * has already proven that the manifest selects one Ralph READY execution plan.
 */
export function projectProgressiveRalphReadiness(
  snapshots: readonly ProgressiveStageSnapshot[],
): ProgressiveRalphReadiness {
  const reasons: string[] = [];
  for (const stage of PROGRESSIVE_INIT_STAGES) {
    const snapshot = snapshots.find((entry) => entry.stage === stage);
    if (!snapshot) {
      reasons.push(`${progressiveInitStageDefinition(stage).label} has no status authority`);
      continue;
    }
    const readiness = validateProgressiveStageReadiness(snapshot);
    if (!readiness.ready) reasons.push(...readiness.issues.map((issue) => issue.reason));
  }
  const closure = snapshots.find((entry) => entry.stage === "project-phases")?.closureStatus;
  return {
    ready: reasons.length === 0,
    stages: snapshots,
    ...(closure ? { closureStatus: closure } : {}),
    reasons,
  };
}

/** Fails with the established stage/closure diagnostics from the same predicate. */
export function assertProgressiveRalphReadiness(
  snapshots: readonly ProgressiveStageSnapshot[],
): ProgressiveRalphReadiness {
  const readiness = projectProgressiveRalphReadiness(snapshots);
  if (readiness.ready) return readiness;
  for (const stage of PROGRESSIVE_INIT_STAGES) {
    const snapshot = snapshots.find((entry) => entry.stage === stage);
    if (!snapshot) throw new Error(`PROGRESSIVE_INIT_STATUS_MISSING: no status authority exists for ${stage}`);
    assertProgressiveStageReadiness(snapshot);
  }
  throw new Error(`PROGRESSIVE_INIT_NOT_RALPH_READY: ${readiness.reasons.join("; ")}`);
}

/**
 * Authoritative readiness inspection. Never a cache and never a Dashboard
 * guess; a future Ralph entry point must revalidate through this same boundary.
 */
export async function inspectProgressiveRalphReadiness(
  root: string,
  request?: string,
): Promise<ProgressiveRalphReadiness> {
  return projectProgressiveRalphReadiness(await inspectProgressiveInit(root, request));
}
