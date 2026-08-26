/**
 * Deterministic decomposition gate for a generated `rb-execution/v1` plan.
 *
 * RB Ralph runs one ephemeral, context-free call per task: the executor sees
 * the validated task extract and the repository, never the conversation that
 * produced the plan. A task that carries a whole feature therefore has to be
 * re-derived from nothing inside a single window, which is where an executor
 * drops earlier requirements or invents them.
 *
 * Every check here reads a value the document itself declares — acceptance
 * criteria, scope tokens, task counts. None of them judges prose quality,
 * estimates effort, or asks a model anything, so a plan either violates a
 * stated ceiling or it does not.
 *
 * `Covers` is deliberately not one of those values. It records traceability,
 * not size: an observed task that added a single `npm run quality` script to
 * `package.json` legitimately covered seven requirements because the script
 * proves them, and a one-file frontend flow test covered four. Gating on the
 * count rejected both, and worse, it rewarded listing fewer requirements —
 * degrading the very coverage the requirement-coverage check depends on.
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

/**
 * How to actually perform a split.
 *
 * Task IDs are one global ascending sequence, so inserting a task renumbers
 * every later one and rewrites the `Depends on` fields that referenced them.
 * Without saying so, a repair edits the offending task in place, leaves the
 * sequence broken or the split undone, and the run fails the same gate twice.
 */
const SPLIT_INSTRUCTION =
  "Splitting renumbers the plan: task IDs are one global ascending sequence, so inserting a task shifts every later T### "
  + "and every `Depends on` and `AC-` prefix that refers to them. Re-emit the whole document with the new numbering, keep each "
  + "requirement covered by exactly one of the resulting tasks, and give each new task its own Scope, criteria, and validation.";

/**
 * A scope token that names a whole area rather than the files it will change.
 *
 * `src/` or `src/**` is what "implement the feature" looks like in a Scope
 * field; `src/server/routes.ts` is what a bounded task looks like.
 */
function wholeAreaToken(token: string): boolean {
  return /(?:^|\/)\*{1,2}$/.test(token) || token.endsWith("/") || !/\.[A-Za-z0-9]+$/.test(token);
}

function issue(code: string, message: string, line: number): ValidationIssue {
  return { code, message, severity: "error", line };
}

function taskIssues(task: Task): ValidationIssue[] {
  const found: ValidationIssue[] = [];
  const { decomposition } = HARNESS_BUDGET;
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
  // "Implement the whole feature" has three signals at once: the phase has a
  // single task, that task claims an area rather than files, and it carries
  // enough criteria to be substantial work. Any two of them describe a
  // perfectly good small phase — the contract's own minimal example is one task
  // scoped to `src/`, `tests/` with a single criterion — so all three are
  // required before the run is stopped.
  if (phase.tasks.length === 1) {
    const only = phase.tasks[0]!;
    const tokens = scopePathTokens(only);
    const areas = tokens.filter(wholeAreaToken);
    const substantial = only.acceptanceCriteria.length >= decomposition.undecomposedFeatureCriteria;
    if (tokens.length > 0 && areas.length === tokens.length && substantial) {
      found.push(issue(
        "execution.phase.undecomposed-feature",
        `Phase ${phase.id} holds one task (${only.id}) that proves ${only.acceptanceCriteria.length} criteria while scoping whole `
        + `areas rather than files: ${areas.join(", ")}. That hands a whole feature to a single context-free executor call. `
        + "Break the phase into bounded tasks that each name the files they change. " + SPLIT_INSTRUCTION,
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
