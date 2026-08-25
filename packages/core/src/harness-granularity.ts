/**
 * Deterministic decomposition gate for a generated `rb-execution/v1` plan.
 *
 * RB Ralph runs one ephemeral, context-free call per task: the executor sees
 * the validated task extract and the repository, never the conversation that
 * produced the plan. A task that carries a whole feature therefore has to be
 * re-derived from nothing inside a single window, which is where an executor
 * drops earlier requirements or invents them.
 *
 * Every check here reads a value the document itself declares — covered
 * requirement IDs, acceptance criteria, scope tokens, task counts. None of
 * them judges prose quality, estimates effort, or asks a model anything, so a
 * plan either violates a stated ceiling or it does not.
 */

import { HARNESS_BUDGET } from "./harness-budget.js";
import type { ExecutionDocument, Phase, Task, ValidationIssue } from "./types.js";

const REQUIREMENT_ID = /\b(?:RF|RNF|UI|CT)-\d+\b/g;

/** Requirement IDs a task declares in `Covers`. */
export function coveredRequirementIds(task: Task): string[] {
  return [...new Set(task.covers.match(REQUIREMENT_ID) ?? [])].sort();
}

/** Backtick-quoted path tokens a task declares in `Scope`. */
export function scopePathTokens(task: Task): string[] {
  return [...task.scope.matchAll(/`([^`]+)`/g)].map((match) => match[1]!.trim()).filter(Boolean);
}

function issue(code: string, message: string, line: number): ValidationIssue {
  return { code, message, severity: "error", line };
}

function taskIssues(task: Task): ValidationIssue[] {
  const found: ValidationIssue[] = [];
  const covered = coveredRequirementIds(task);
  const { decomposition } = HARNESS_BUDGET;
  if (covered.length > decomposition.maxCoveredRequirements) {
    found.push(issue(
      "execution.task.covers-too-many-requirements",
      `Task ${task.id} carries ${covered.length} requirements (${covered.join(", ")}); a task RB Ralph runs in one context-free call `
      + `covers at most ${decomposition.maxCoveredRequirements}. Split it into bounded tasks that each own a smaller observable change.`,
      task.line,
    ));
  }
  if (task.acceptanceCriteria.length > decomposition.maxAcceptanceCriteria) {
    found.push(issue(
      "execution.task.too-many-acceptance-criteria",
      `Task ${task.id} declares ${task.acceptanceCriteria.length} acceptance criteria; at most ${decomposition.maxAcceptanceCriteria} `
      + "fit one bounded task. Split the task so each part proves its own criteria.",
      task.line,
    ));
  }
  const paths = scopePathTokens(task);
  if (paths.length > decomposition.maxScopePaths) {
    found.push(issue(
      "execution.task.scope-too-broad",
      `Task ${task.id} declares ${paths.length} scope paths; at most ${decomposition.maxScopePaths} keep the change reviewable `
      + "and let the incremental validation cache prove bounded impact. Split it by the boundary the paths already suggest.",
      task.line,
    ));
  }
  return found;
}

function phaseIssues(phase: Phase): ValidationIssue[] {
  const found: ValidationIssue[] = [];
  const { decomposition } = HARNESS_BUDGET;
  if (phase.tasks.length > decomposition.maxTasksPerPhase) {
    found.push(issue(
      "execution.phase.too-many-tasks",
      `Phase ${phase.id} declares ${phase.tasks.length} tasks; a phase is one observable outcome and holds at most `
      + `${decomposition.maxTasksPerPhase}. Split it into ordered phases with their own goals.`,
      phase.line,
    ));
  }
  // A phase whose single task carries several requirements did not decompose
  // the feature at all: the executor receives the feature, not a step.
  if (phase.tasks.length === 1) {
    const only = phase.tasks[0]!;
    const covered = coveredRequirementIds(only);
    if (covered.length > decomposition.maxSingleTaskPhaseRequirements) {
      found.push(issue(
        "execution.phase.undecomposed-feature",
        `Phase ${phase.id} holds one task (${only.id}) covering ${covered.length} requirements (${covered.join(", ")}). `
        + "That hands a whole feature to a single context-free executor call. Break the phase into bounded tasks before publishing it.",
        phase.line,
      ));
    }
  }
  return found;
}

/**
 * Report every decomposition ceiling a plan violates.
 *
 * The result is ordered by document position so a repair reads top to bottom.
 */
export function assessDecomposition(document: ExecutionDocument): ValidationIssue[] {
  const found: ValidationIssue[] = [];
  for (const phase of document.phases) {
    found.push(...phaseIssues(phase));
    for (const task of phase.tasks) found.push(...taskIssues(task));
  }
  return found.sort((left, right) => (left.line ?? 0) - (right.line ?? 0));
}
