import {
  RALPH_EXECUTION_ISSUE_CODES,
  parseExecutionMarkdown,
  validateExecutionMarkdown,
  type RalphExecutionIssueCode,
} from "../execution-contract.js";
import type { ArtifactManifest, ExecutionDocument } from "../types.js";
import type { IrInvariantId } from "./result.js";

export type RalphIssueFidelity =
  | { readonly kind: "semantic"; readonly invariant: IrInvariantId | readonly IrInvariantId[] }
  | { readonly kind: "renderer-owned"; readonly reason: string }
  | { readonly kind: "workspace-only"; readonly reason: string };

/** Exhaustive classification: semantic prevention is distinguished from unreachable renderer structure and workspace gates. */
export const RALPH_ISSUE_FIDELITY: Readonly<Record<RalphExecutionIssueCode, RalphIssueFidelity>> = {
  "document.artifact-id": { kind: "renderer-owned", reason: "the renderer always emits the code-derived execution artifact marker" },
  "document.contract": { kind: "renderer-owned", reason: "ExecutionDocument derivation fixes rb-execution/v1" },
  "document.heading.h2": { kind: "semantic", invariant: ["I-06", "I-18"] },
  "document.phases.empty": { kind: "semantic", invariant: "I-14" },
  "document.title": { kind: "semantic", invariant: "I-18" },
  "phase.context.empty": { kind: "renderer-owned", reason: "every phase context is the constant `.rb/init/BRIEF.md`" },
  "phase.dependency.invalid": { kind: "semantic", invariant: "I-02" },
  "phase.depends.missing": { kind: "renderer-owned", reason: "the renderer always emits Depends on, including none" },
  "phase.goal.missing": { kind: "semantic", invariant: "I-18" },
  "phase.id.invalid": { kind: "semantic", invariant: "I-01" },
  "phase.id.missing": { kind: "semantic", invariant: "I-01" },
  "phase.sequence": { kind: "semantic", invariant: "I-01" },
  "phase.tasks.empty": { kind: "semantic", invariant: "I-14" },
  "task.acceptance.ambiguous": { kind: "semantic", invariant: "I-10" },
  "task.acceptance.empty": { kind: "semantic", invariant: "I-09" },
  "task.acceptance.id": { kind: "semantic", invariant: "I-01" },
  "task.acceptance.visual-negative-control": { kind: "semantic", invariant: "I-13" },
  "task.change.control-plane": { kind: "semantic", invariant: "I-08" },
  "task.dependency.invalid": { kind: "semantic", invariant: "I-05" },
  "task.duplicate": { kind: "semantic", invariant: "I-01" },
  "task.evidence.visual-contract": { kind: "semantic", invariant: "I-13" },
  "task.evidence.visual-state-pair": { kind: "semantic", invariant: "I-13" },
  "task.field.missing": { kind: "semantic", invariant: "I-09" },
  "task.parallel.invalid": { kind: "renderer-owned", reason: "canonicalization and ExecutionDocument derivation always set parallel safety to false" },
  "task.scope.ambiguous": { kind: "semantic", invariant: ["I-06", "I-09"] },
  "task.scope.control-plane": { kind: "semantic", invariant: "I-08" },
  "task.sequence": { kind: "semantic", invariant: "I-01" },
  "task.validation.ambiguous": { kind: "semantic", invariant: "I-12" },
  "task.validation.empty": { kind: "semantic", invariant: "I-09" },
  "task.validation.format": { kind: "renderer-owned", reason: "typed validation variants have fixed Markdown forms and unresolved commands throw" },
  "task.validation.visual-manual": { kind: "semantic", invariant: "I-13" },
  "task.validation.visual-unproven": { kind: "semantic", invariant: "I-13" },
  "execution.go-direct-requirement.module-identity-missing": { kind: "semantic", invariant: "I-10" },
  "execution.go-tidy.nonconvergent-direct-requirement": { kind: "workspace-only", reason: "non-convergence requires an injected checkout import inventory and is not inferred by the pure IR closure" },
};

export const RALPH_ISSUE_TO_IR_INVARIANT: Readonly<Partial<Record<RalphExecutionIssueCode, IrInvariantId>>> = Object.fromEntries(
  Object.entries(RALPH_ISSUE_FIDELITY).flatMap(([code, classification]) => classification.kind === "semantic"
    ? [[code, Array.isArray(classification.invariant) ? classification.invariant[0] : classification.invariant]]
    : []),
);

export function executionWithoutLocations(document: ExecutionDocument): ExecutionDocument {
  return {
    ...document,
    phases: document.phases.map((phase) => ({
      ...phase,
      line: 0,
      tasks: phase.tasks.map((task) => ({ ...task, line: 0 })),
    })),
  };
}

export function assertExecutionRoundTrip(source: string, expected: ExecutionDocument): void {
  const validation = validateExecutionMarkdown(source);
  if (!validation.document) throw new Error(`Ralph parser did not produce a document: ${validation.issues.map((entry) => entry.code).join(", ")}`);
  const actual = JSON.stringify(executionWithoutLocations(parseExecutionMarkdown(source)));
  const wanted = JSON.stringify(executionWithoutLocations(expected));
  if (actual !== wanted) throw new Error("PHASES.md parse/render round-trip changed execution semantics");
  if (!validation.valid) {
    const unmapped = validation.issues.filter((issue) => !(issue.code in RALPH_ISSUE_FIDELITY));
    const detail = validation.issues.map((issue) => {
      const classification = RALPH_ISSUE_FIDELITY[issue.code as RalphExecutionIssueCode];
      return `${issue.code}→${classification?.kind === "semantic" ? String(classification.invariant) : classification?.kind ?? "unmapped"}`;
    }).join(", ");
    throw new Error(`Ralph rejected semantics accepted by the IR validator (${detail}; unmapped=${unmapped.length})`);
  }
}

export function assertRalphIssueMapExhaustive(): void {
  const mapped = Object.keys(RALPH_ISSUE_FIDELITY).sort();
  const exported = [...RALPH_EXECUTION_ISSUE_CODES].sort();
  if (JSON.stringify(mapped) !== JSON.stringify(exported)) throw new Error("Ralph issue-code invariant map is not exhaustive");
}

export function selectReadyExecutionPlan(manifest: ArtifactManifest, phasesSource: string): ArtifactManifest["artifacts"][number] {
  const plans = manifest.artifacts.filter((entry) => entry.kind === "execution-plan"
    && entry.status === "ready" && entry.contract === "rb-execution/v1");
  if (plans.length !== 1) throw new Error(`Expected exactly one selectable READY execution plan, found ${plans.length}`);
  const marker = phasesSource.match(/^<!-- rb-artifact-id:\s*([^>]+?)\s*-->$/m)?.[1];
  if (!marker || plans[0]!.id !== marker) throw new Error("Manifest execution artifact ID does not match PHASES.md marker");
  return plans[0]!;
}
