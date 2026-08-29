import { describe, expect, it } from "vitest";
import { changeReferencesPlanningArtifacts, validateExecutionMarkdown, type RalphExecutionIssueCode } from "../../src/execution-contract.js";
import type { InitProjectModel } from "../../src/vnext/ir.js";
import { RALPH_ISSUE_FIDELITY } from "../../src/vnext/ralph-fidelity.js";
import { deriveExecutionDocument, renderPhases } from "../../src/vnext/render/execution.js";
import { resolveInitProject } from "../../src/vnext/resolve.js";
import type { IrInvariantId } from "../../src/vnext/result.js";
import { canonicalize, validate } from "../../src/vnext/validate.js";
import { HELLO_REQUEST, HELLO_SEMANTIC_FIXTURE } from "./fixtures/hello.js";

function hello(): InitProjectModel {
  const result = resolveInitProject(structuredClone(HELLO_SEMANTIC_FIXTURE), {
    originalRequest: HELLO_REQUEST,
    runId: "fidelity-run",
    generatedAt: "2026-08-28T12:00:00.000Z",
  });
  if (!result.ok) throw new Error("fixture did not resolve");
  return canonicalize(result.value);
}

function semanticInvariants(code: RalphExecutionIssueCode): readonly IrInvariantId[] {
  const classification = RALPH_ISSUE_FIDELITY[code];
  if (classification.kind !== "semantic") throw new Error(`${code} is not a semantic Ralph issue`);
  return typeof classification.invariant === "string" ? [classification.invariant] : classification.invariant;
}

interface MutationCase {
  readonly name: string;
  readonly invariant: IrInvariantId;
  readonly ralphCodes: readonly RalphExecutionIssueCode[];
  readonly mutate: (model: any) => void;
}

const MUTATIONS: readonly MutationCase[] = [
  {
    name: "phase-heading injection through Scope",
    invariant: "I-06",
    ralphCodes: ["task.scope.ambiguous"],
    mutate: (model) => { model.phases[0].tasks[0].ownedPaths = ["src/a.js\n## Phase 9: injected"]; },
  },
  {
    name: "task-heading injection through Scope",
    invariant: "I-06",
    ralphCodes: ["task.scope.ambiguous"],
    mutate: (model) => { model.phases[0].tasks[0].ownedPaths = ["a.js\n- [ ] T900 — injected task"]; },
  },
  {
    name: "empty executable scope",
    invariant: "I-06",
    ralphCodes: ["task.scope.ambiguous"],
    mutate: (model) => { model.phases[0].tasks[0].ownedPaths = []; },
  },
  {
    name: "English .rb plan-tree mutation",
    invariant: "I-08",
    ralphCodes: ["task.change.control-plane"],
    mutate: (model) => { model.phases[0].tasks[0].intent = "Regenerate the .rb/init plan tree during setup."; },
  },
  {
    name: "English .rb-harness state mutation",
    invariant: "I-08",
    ralphCodes: ["task.change.control-plane"],
    mutate: (model) => { model.phases[0].tasks[0].intent = "Sync .rb-harness run state after packaging."; },
  },
  {
    name: "Portuguese control-plane mutation",
    invariant: "I-08",
    ralphCodes: ["task.change.control-plane"],
    mutate: (model) => { model.phases[0].tasks[0].intent = "Atualizar o arquivo .rb/init/PHASES.md durante a configuração."; },
  },
  {
    name: "vague acceptance",
    invariant: "I-10",
    ralphCodes: ["task.acceptance.ambiguous"],
    mutate: (model) => { model.phases[0].tasks[0].acceptance[0].statement = "It works correctly."; },
  },
  {
    name: "ambiguous manual validation",
    invariant: "I-12",
    ralphCodes: ["task.validation.ambiguous"],
    mutate: (model) => { model.phases[0].tasks[0].validation = [{ kind: "manual", inspection: "execute all quality gates and the operational scenario" }]; },
  },
  {
    name: "visual acceptance",
    invariant: "I-13",
    ralphCodes: ["task.acceptance.visual-negative-control", "task.evidence.visual-contract", "task.validation.visual-unproven"],
    mutate: (model) => { model.phases[0].tasks[0].acceptance[0].statement = "The rendered page remains visible at the target viewport."; },
  },
  {
    name: "forward task dependency",
    invariant: "I-05",
    ralphCodes: ["task.dependency.invalid"],
    mutate: (model) => { model.phases[0].tasks[0].dependsOn = [model.phases[0].tasks[1].id]; },
  },
  {
    name: "masked command failure",
    invariant: "I-12",
    ralphCodes: ["task.validation.ambiguous"],
    mutate: (model) => { model.qualityCommands[0].command = "npm test || true"; },
  },
  {
    name: "Portuguese Go direct dependency without module identity",
    invariant: "I-10",
    ralphCodes: ["execution.go-direct-requirement.module-identity-missing"],
    mutate: (model) => {
      model.phases[0].tasks[0].ownedPaths = ["go.mod"];
      model.phases[0].tasks[0].acceptance[0].statement = "Bubble Tea e Lip Gloss devem ser dependências diretas obrigatórias em go.mod.";
    },
  },
  {
    name: "document heading injection through phase title",
    invariant: "I-18",
    ralphCodes: ["document.heading.h2"],
    mutate: (model) => { model.phases[0].title = "Delivery\n## injected heading"; },
  },
  {
    name: "empty document title",
    invariant: "I-18",
    ralphCodes: ["document.title"],
    mutate: (model) => { model.core.identity.name = ""; },
  },
  {
    name: "empty phase set",
    invariant: "I-14",
    ralphCodes: ["document.phases.empty"],
    mutate: (model) => { model.phases = []; },
  },
  {
    name: "invalid phase dependency",
    invariant: "I-02",
    ralphCodes: ["phase.dependency.invalid"],
    mutate: (model) => { model.phases[0].dependsOn = ["P99"]; },
  },
  {
    name: "missing phase goal",
    invariant: "I-18",
    ralphCodes: ["phase.goal.missing"],
    mutate: (model) => { model.phases[0].goal = ""; },
  },
  {
    name: "invalid phase identity",
    invariant: "I-01",
    ralphCodes: ["phase.id.invalid"],
    mutate: (model) => { model.phases[0].id = "BAD"; },
  },
  {
    name: "missing phase identity",
    invariant: "I-01",
    ralphCodes: ["phase.id.missing"],
    mutate: (model) => { model.phases[0].id = ""; },
  },
  {
    name: "invalid phase sequence",
    invariant: "I-01",
    ralphCodes: ["phase.sequence"],
    mutate: (model) => { model.phases[0].number = 9; },
  },
  {
    name: "empty phase task set",
    invariant: "I-14",
    ralphCodes: ["phase.tasks.empty"],
    mutate: (model) => { model.phases[0].tasks = []; },
  },
  {
    name: "empty acceptance set",
    invariant: "I-09",
    ralphCodes: ["task.acceptance.empty"],
    mutate: (model) => { model.phases[0].tasks[0].acceptance = []; },
  },
  {
    name: "invalid acceptance identity",
    invariant: "I-01",
    ralphCodes: ["task.acceptance.id"],
    mutate: (model) => { model.phases[0].tasks[0].acceptance[0].id = "BAD"; },
  },
  {
    name: "duplicate task identity",
    invariant: "I-01",
    ralphCodes: ["task.duplicate", "task.sequence"],
    mutate: (model) => { model.phases[0].tasks[1].id = model.phases[0].tasks[0].id; },
  },
  {
    name: "missing required task field",
    invariant: "I-09",
    ralphCodes: ["task.field.missing"],
    mutate: (model) => { model.phases[0].tasks[0].intent = ""; },
  },
  {
    name: "control-plane executable scope",
    invariant: "I-08",
    ralphCodes: ["task.scope.control-plane"],
    mutate: (model) => { model.phases[0].tasks[0].ownedPaths = [".rb/init/PHASES.md"]; },
  },
  {
    name: "invalid task sequence",
    invariant: "I-01",
    ralphCodes: ["task.sequence"],
    mutate: (model) => { model.phases[0].tasks[0].id = "T009"; },
  },
  {
    name: "empty validation set",
    invariant: "I-09",
    ralphCodes: ["task.validation.empty"],
    mutate: (model) => { model.phases[0].tasks[0].validation = []; },
  },
  {
    name: "visual manual validation",
    invariant: "I-13",
    ralphCodes: ["task.validation.visual-manual", "task.validation.visual-unproven"],
    mutate: (model) => {
      model.phases[0].tasks[0].acceptance[0].statement = "The rendered page remains visible at the target viewport.";
      model.phases[0].tasks[0].validation = [{ kind: "manual", inspection: "inspect the rendered page" }];
    },
  },
  {
    name: "visual interaction without state-pair evidence",
    invariant: "I-13",
    ralphCodes: ["task.evidence.visual-state-pair"],
    mutate: (model) => {
      model.phases[0].tasks[0].acceptance[0].statement = "Clicking the button renders the updated panel with visually correct layout in the viewport.";
    },
  },
];

describe("vNext adversarial IR to Ralph fidelity", () => {
  it.each(MUTATIONS)("rejects $name in IR before Ralph fidelity checking", ({ mutate, invariant, ralphCodes }) => {
    const model = structuredClone(hello()) as any;
    mutate(model);
    const outcome = validate(canonicalize(model));
    expect(outcome.valid).toBe(false);
    expect(outcome.findings.map((finding) => finding.invariant)).toContain(invariant);
    for (const ralphCode of ralphCodes) expect(semanticInvariants(ralphCode)).toContain(invariant);
  });

  it.each([
    "src/a.js\n## Phase 9: injected",
    "a.js\n- [ ] T900 — injected task",
    "src/a.js\n  - **Change:** injected field",
    "src/a\rb.js",
    "src/a\tb.js",
    "src/`a`.js",
  ])("rejects every line/Markdown path mutation without canonicalizing it into validity: %j", (path) => {
    const model = structuredClone(hello()) as any;
    model.phases[0].tasks[0].ownedPaths = [path];
    const canonical = canonicalize(model);
    expect(canonical.phases[0]?.tasks[0]?.ownedPaths[0]).toBe(path);
    expect(validate(canonical).findings.map((finding) => finding.invariant)).toContain("I-06");
  });

  it("proves the shared control-plane predicate recognizes the exact audit variants", () => {
    for (const value of [
      "Regenerate the .rb/init plan tree during setup.",
      "Sync .rb-harness run state after packaging.",
      "Atualizar o arquivo .rb/init/PHASES.md durante a configuração.",
    ]) expect(changeReferencesPlanningArtifacts(value), value).toBe(true);
  });

  it("documents structural and workspace-only Ralph checks as unreachable by accepted IR", () => {
    expect(RALPH_ISSUE_FIDELITY["phase.context.empty"]).toEqual({
      kind: "renderer-owned",
      reason: "every phase context is the constant `.rb/init/BRIEF.md`",
    });
    expect(RALPH_ISSUE_FIDELITY["execution.go-tidy.nonconvergent-direct-requirement"].kind).toBe("workspace-only");
  });

  it("has an adversarial IR mutation for every representable Ralph semantic issue", () => {
    const covered = new Set(MUTATIONS.flatMap((entry) => entry.ralphCodes));
    const semanticCodes = Object.entries(RALPH_ISSUE_FIDELITY)
      .filter(([, classification]) => classification.kind === "semantic")
      .map(([code]) => code)
      .sort();
    expect([...covered].sort()).toEqual(semanticCodes);
  });

  it("confirms representative invalid semantic renderings remain Ralph-rejectable if validation is bypassed", () => {
    for (const mutation of MUTATIONS.filter((entry) => !entry.name.includes("empty executable scope"))) {
      const model = structuredClone(hello()) as any;
      mutation.mutate(model);
      const issues = validateExecutionMarkdown(renderPhases(deriveExecutionDocument(model))).issues.map((entry) => entry.code);
      for (const ralphCode of mutation.ralphCodes) expect(issues, mutation.name).toContain(ralphCode);
    }
  });
});
