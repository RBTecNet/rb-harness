import {
  ambiguousAcceptanceCriterion,
  ambiguousValidationInstruction,
  changeReferencesPlanningArtifacts,
  isVisualAcceptanceCriterion,
} from "../execution-contract.js";
import { goModulePaths, requiresDirectGoDependency } from "../go-plan-convergence.js";
import { scopeTokenCoversPath } from "../path-ownership.js";
import { sha256Text } from "../hash.js";
import {
  acceptanceId,
  phaseId,
  projectId,
  requirementId,
  taskId,
  type RelPath,
  type Sha256,
} from "./identity.js";
import type {
  DeterminationSource,
  InitProjectModel,
  ProtectedPath,
  SemanticTask,
} from "./ir.js";
import { INIT_PROJECT_MODEL_VERSION } from "./ir.js";
import { requestEvidenceIsVerified, userAnswerIsVerified } from "./provenance.js";
import type { Finding, FindingClass, IrInvariantId, ValidationOutcome } from "./result.js";

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function cleanText(value: string): string {
  return value.trim().replace(/ {2,}/g, " ");
}

function cleanPath(value: string): RelPath {
  if (/[\0\n\r\t`]/.test(value)) return value as RelPath;
  let normalized = value.trim().replaceAll("\\", "/").replace(/\/{2,}/g, "/");
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  if (normalized.length > 1) normalized = normalized.replace(/\/+$/g, "");
  return normalized as RelPath;
}

function uniqueSorted<T extends string>(values: readonly T[]): readonly T[] {
  return [...new Set(values)].sort(codeUnitCompare);
}

function canonicalSource(source: DeterminationSource): DeterminationSource {
  if (source.kind === "request") return { kind: "request", evidence: cleanText(source.evidence) };
  return source;
}

export function canonicalize(model: InitProjectModel): InitProjectModel {
  return {
    ...model,
    core: {
      ...model.core,
      identity: {
        ...model.core.identity,
        name: cleanText(model.core.identity.name),
        objective: cleanText(model.core.identity.objective),
      },
      determinations: model.core.determinations.map((entry) => ({
        ...entry,
        statement: cleanText(entry.statement),
        rationale: cleanText(entry.rationale),
        source: canonicalSource(entry.source),
      })),
      protectedPaths: model.core.protectedPaths.map((entry) => ({
        ...entry,
        path: cleanPath(entry.path),
        reason: cleanText(entry.reason),
        source: entry.source.kind === "request"
          ? { kind: "request" as const, evidence: cleanText(entry.source.evidence) }
          : entry.source,
      })),
      provenance: {
        ...model.core.provenance,
        answers: Object.fromEntries(Object.entries(model.core.provenance.answers)
          .sort(([left], [right]) => codeUnitCompare(left, right))),
      },
    },
    requirements: model.requirements.map((entry) => ({ ...entry, statement: cleanText(entry.statement) })),
    qualityCommands: model.qualityCommands.map((entry) => ({ ...entry, command: entry.command.trim() })),
    phases: model.phases.map((phase) => ({
      ...phase,
      title: cleanText(phase.title),
      goal: cleanText(phase.goal),
      dependsOn: uniqueSorted(phase.dependsOn),
      tasks: phase.tasks.map((task) => ({
        ...task,
        title: cleanText(task.title),
        intent: cleanText(task.intent),
        dependsOn: uniqueSorted(task.dependsOn),
        ownedPaths: uniqueSorted(task.ownedPaths.map(cleanPath)),
        covers: uniqueSorted(task.covers),
        acceptance: task.acceptance.map((entry) => ({ ...entry, statement: cleanText(entry.statement) })),
        validation: task.validation.map((entry) => {
          if (entry.kind === "command") return entry;
          if (entry.kind === "manual") return { kind: "manual" as const, inspection: cleanText(entry.inspection) };
          return { kind: "human" as const, evidence: cleanText(entry.evidence) };
        }),
        expectedEvidence: cleanText(task.expectedEvidence),
        parallelSafe: false as const,
      })),
    })),
  };
}

function add(
  findings: Finding[],
  invariant: IrInvariantId,
  message: string,
  pointer: string,
  classification: FindingClass = "fatal",
  offending?: readonly string[],
): void {
  findings.push({ invariant, classification, message, pointer, ...(offending ? { offending } : {}) });
}

function duplicates(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const result = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) result.add(value);
    seen.add(value);
  }
  return [...result].sort(codeUnitCompare);
}

function pathIsSafe(value: string): boolean {
  if (!value || /[\0\n\r\t`]/.test(value) || value.includes("\\")) return false;
  if (value.startsWith("/") || /^[A-Za-z]:\//.test(value)) return false;
  const parts = value.split("/");
  if (parts.some((part) => part === ".." || part === "." || part === "")) return false;
  return !["*", "**", "**/*"].includes(value);
}

function pathsIntersect(left: string, right: string): boolean {
  return scopeTokenCoversPath(left, right) || scopeTokenCoversPath(right, left);
}

function validSingleLine(value: string): boolean {
  return value.trim().length > 0 && !/[\n\r\t]/.test(value);
}

function interactiveCommand(command: string): boolean {
  return /(?:^|\s)(?:--interactive|--watch(?:=|\s|$)|-w(?:\s|$))(?:\s|$)/i.test(command)
    || /^(?:read|select)\b/i.test(command)
    || /^(?:npm|pnpm|yarn|bun)\s+init(?![^;&|]*\s(?:--yes|-y)(?:\s|$))/i.test(command)
    || /^(?:python3?|node)\s+-i(?:\s|$)/i.test(command);
}

function proseCommand(command: string): boolean {
  return /^(?:run|execute|invoke|verify|inspect|check|test)\s+(?:the|all|that|whether)\b/i.test(command)
    || /^(?:rodar|executar|verificar|inspecionar|testar)\s+(?:o|a|os|as|que)\b/i.test(command);
}

function commandSafetyIssue(command: string): string | undefined {
  if (!validSingleLine(command) || command.includes("`")) return "must be one non-empty single-line command without Markdown delimiters";
  if (interactiveCommand(command)) return "must be non-interactive";
  if (/(?:^|[;&|]\s*)exit\s+0(?:\s|$)/i.test(command)) return "must not force a successful exit";
  if (proseCommand(command)) return "is prose disguised as an executable command";
  return ambiguousValidationInstruction({ kind: "command", value: command });
}

function isIsoDateTime(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)
    && !Number.isNaN(Date.parse(value));
}

function sourceIsVerified(source: DeterminationSource, model: InitProjectModel): boolean {
  if (source.kind === "model-default") return true;
  if (source.kind === "request") return requestEvidenceIsVerified(model.core.provenance.originalRequest, source.evidence);
  return userAnswerIsVerified(model.core.provenance.answers, source.questionKey);
}

function protectedSourceIsVerified(path: ProtectedPath, model: InitProjectModel): boolean {
  if (path.source.kind === "built-in") return [".rb", ".rb-harness", ".git"].includes(path.path);
  if (path.source.kind === "request") return requestEvidenceIsVerified(model.core.provenance.originalRequest, path.source.evidence);
  return userAnswerIsVerified(model.core.provenance.answers, path.source.questionKey);
}

function graphHasCycle<T extends { readonly id: string; readonly dependsOn: readonly string[] }>(values: readonly T[]): boolean {
  const known = new Set(values.map((entry) => entry.id));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(values.map((entry) => [entry.id, entry]));
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      if (known.has(dependency) && visit(dependency)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return values.some((entry) => visit(entry.id));
}

function allTasks(model: InitProjectModel): readonly SemanticTask[] {
  return model.phases.flatMap((phase) => phase.tasks);
}

export function validate(model: InitProjectModel): ValidationOutcome {
  const findings: Finding[] = [];
  const tasks = allTasks(model);

  if (model.version !== INIT_PROJECT_MODEL_VERSION || model.workflow !== "init") add(findings, "I-01", "Unsupported vNext init model identity", "/version");

  if (!/^[a-z0-9][a-z0-9-]*$/.test(model.core.identity.id) || model.core.identity.id !== projectId(model.core.identity.name)) {
    add(findings, "I-01", "Project identity is invalid or was not derived from the project name", "/core/identity/id");
  }
  model.requirements.forEach((requirement, index) => {
    if (requirement.id !== requirementId(index + 1)) add(findings, "I-01", "Requirement identity is not declaration-order derived", `/requirements/${index}/id`);
  });
  let expectedTaskOrdinal = 0;
  model.phases.forEach((phase, phaseIndex) => {
    if (phase.number !== phaseIndex + 1 || phase.id !== phaseId(phaseIndex + 1)) add(findings, "I-01", "Phase identity or sequence is not Core-derived", `/phases/${phaseIndex}/id`);
    phase.tasks.forEach((task, taskIndex) => {
      expectedTaskOrdinal += 1;
      if (task.id !== taskId(expectedTaskOrdinal)) add(findings, "I-01", "Task identity is not globally ascending and Core-derived", `/phases/${phaseIndex}/tasks/${taskIndex}/id`);
      task.acceptance.forEach((entry, acceptanceIndex) => {
        if (entry.id !== acceptanceId(task.id, acceptanceIndex + 1)) add(findings, "I-01", "Acceptance identity is not task-ordinal derived", `/phases/${phaseIndex}/tasks/${taskIndex}/acceptance/${acceptanceIndex}/id`);
      });
    });
  });

  const keyGroups: Array<[string, readonly string[]]> = [
    ["/requirements", model.requirements.map((entry) => entry.key)],
    ["/qualityCommands", model.qualityCommands.map((entry) => entry.key)],
    ["/phases", model.phases.map((entry) => entry.key)],
    ["/phases/tasks", tasks.map((entry) => entry.key)],
  ];
  for (const [pointer, values] of keyGroups) {
    const repeated = duplicates(values);
    if (repeated.length) add(findings, "I-02", "Semantic keys must be unique within their kind", pointer, "fatal", repeated);
    const invalid = values.filter((value) => !/^[a-z][a-z0-9-]{1,47}$/.test(value));
    if (invalid.length) add(findings, "I-02", "Semantic keys must use the canonical key grammar", pointer, "fatal", invalid);
  }
  const invalidDeterminationKeys = model.core.determinations
    .map((entry) => entry.key)
    .filter((value) => !/^[a-z][a-z0-9-]{1,47}$/.test(value));
  if (invalidDeterminationKeys.length) {
    add(findings, "I-16", "Determination keys must use the canonical key grammar", "/core/determinations", "fatal", invalidDeterminationKeys);
  }

  const covered = new Set(tasks.flatMap((task) => task.covers));
  const knownRequirementIds = new Set(model.requirements.map((entry) => entry.id));
  for (const [taskIndex, task] of tasks.entries()) {
    const unknown = task.covers.filter((id) => !knownRequirementIds.has(id));
    if (unknown.length) add(findings, "I-02", `${task.id} covers unknown requirement identity`, `/phases/tasks/${taskIndex}/covers`, "fatal", unknown);
  }
  for (const [index, requirement] of model.requirements.entries()) {
    if (!covered.has(requirement.id)) add(findings, "I-03", `Requirement ${requirement.id} is not covered by any task`, `/requirements/${index}`, "user-decision-required");
  }

  if (graphHasCycle(model.phases) || graphHasCycle(tasks)) add(findings, "I-04", "Phase or task dependency graph contains a cycle", "/phases");

  const phaseOrder = new Map(model.phases.map((phase, index) => [phase.id, index]));
  for (const [index, phase] of model.phases.entries()) {
    for (const dependency of phase.dependsOn) {
      const dependencyIndex = phaseOrder.get(dependency);
      if (dependencyIndex === undefined || dependencyIndex >= index) add(findings, "I-02", `${phase.id} depends on an unknown or forward phase ${dependency}`, `/phases/${index}/dependsOn`, "fatal", [dependency]);
    }
  }

  const taskOrder = new Map(tasks.map((task, index) => [task.id, index]));
  for (const [index, task] of tasks.entries()) {
    for (const dependency of task.dependsOn) {
      const dependencyIndex = taskOrder.get(dependency);
      if (dependencyIndex === undefined || dependencyIndex >= index) {
        add(findings, "I-05", `${task.id} depends on an unknown or forward task ${dependency}`, `/phases/tasks/${index}/dependsOn`, "fatal", [dependency]);
      }
    }
  }

  for (const [taskIndex, task] of tasks.entries()) {
    if (task.ownedPaths.length === 0) add(findings, "I-06", `${task.id} has no executable owned-path scope`, `/phases/tasks/${taskIndex}/ownedPaths`);
    for (const [pathIndex, path] of task.ownedPaths.entries()) {
      if (!pathIsSafe(path)) add(findings, "I-06", `Unsafe owned path: ${path}`, `/phases/tasks/${taskIndex}/ownedPaths/${pathIndex}`, "fatal", [path]);
      const intersections = model.core.protectedPaths.filter((protectedPath) => pathsIntersect(path, protectedPath.path));
      if (intersections.length) add(findings, "I-07", `Owned path intersects protected authority: ${path}`, `/phases/tasks/${taskIndex}/ownedPaths/${pathIndex}`, "fatal", intersections.map((entry) => entry.path));
      if ([".rb", ".rb-harness", ".git"].some((control) => pathsIntersect(path, control))) {
        add(findings, "I-08", `Owned path mutates the control plane: ${path}`, `/phases/tasks/${taskIndex}/ownedPaths/${pathIndex}`, "fatal", [path]);
      }
    }
    if (changeReferencesPlanningArtifacts(task.intent)) {
      add(findings, "I-08", `${task.id} change intent directs a control-plane mutation`, `/phases/tasks/${taskIndex}/intent`);
    }
    if (!validSingleLine(task.intent) || task.ownedPaths.length === 0 || task.covers.length === 0 || task.acceptance.length === 0
      || task.validation.length === 0 || !validSingleLine(task.expectedEvidence)) {
      add(findings, "I-09", `${task.id} lacks required intent, scope, acceptance, validation, or evidence`, `/phases/tasks/${taskIndex}`);
    }
    for (const [acceptanceIndex, acceptance] of task.acceptance.entries()) {
      const referenceOnly = /^(?:R|RF|RNF|UI|CT|AC)-[A-Z0-9-]+\.?$/i.test(acceptance.statement.trim());
      const ambiguity = ambiguousAcceptanceCriterion(acceptance.statement);
      if (referenceOnly || ambiguity) add(findings, "I-10", `${task.id} acceptance is not self-contained${ambiguity ? `: ${ambiguity}` : ""}`, `/phases/tasks/${taskIndex}/acceptance/${acceptanceIndex}`, "semantic-invalid");
      if (requiresDirectGoDependency(acceptance.statement)) {
        const taskModules = goModulePaths(`${task.intent}\n${task.acceptance.map((entry) => entry.statement).join("\n")}`);
        const criterionModules = goModulePaths(acceptance.statement);
        if ((criterionModules.length ? criterionModules : taskModules).length === 0) {
          add(findings, "I-10", `${task.id} direct Go dependency acceptance names no verifiable module path`, `/phases/tasks/${taskIndex}/acceptance/${acceptanceIndex}`, "semantic-invalid");
        }
      }
      if (isVisualAcceptanceCriterion(acceptance.statement)) add(findings, "I-13", `${task.id} contains visual acceptance semantics outside the Phase 1 model`, `/phases/tasks/${taskIndex}/acceptance/${acceptanceIndex}`);
    }
  }

  const commands = new Map(model.qualityCommands.map((entry) => [entry.key, entry]));
  for (const [taskIndex, task] of tasks.entries()) {
    for (const [validationIndex, intent] of task.validation.entries()) {
      if (intent.kind === "command" && !commands.has(intent.commandKey)) add(findings, "I-11", `Unknown quality-command key ${intent.commandKey}`, `/phases/tasks/${taskIndex}/validation/${validationIndex}`);
      if (intent.kind === "manual" && !validSingleLine(intent.inspection)) add(findings, "I-09", "Manual validation inspection is empty or multiline", `/phases/tasks/${taskIndex}/validation/${validationIndex}`);
      if (intent.kind === "manual") {
        const issue = ambiguousValidationInstruction({ kind: "manual", value: intent.inspection });
        if (issue) add(findings, "I-12", `Manual validation ${issue}`, `/phases/tasks/${taskIndex}/validation/${validationIndex}`, "semantic-invalid");
      }
      if (intent.kind === "human" && !validSingleLine(intent.evidence)) add(findings, "I-09", "Human validation evidence is empty or multiline", `/phases/tasks/${taskIndex}/validation/${validationIndex}`);
    }
  }
  for (const [index, command] of model.qualityCommands.entries()) {
    const issue = commandSafetyIssue(command.command);
    if (issue) add(findings, "I-12", `Quality command ${command.key} ${issue}`, `/qualityCommands/${index}/command`, "semantic-invalid", [command.command]);
  }

  if (model.phases.length === 0) add(findings, "I-14", "At least one phase is required", "/phases");
  for (const [index, phase] of model.phases.entries()) {
    if (phase.tasks.length === 0) add(findings, "I-14", `${phase.id} must contain at least one task`, `/phases/${index}/tasks`);
    if (phase.tasks.length > 12) add(findings, "I-15", `${phase.id} exceeds the 12-task ceiling`, `/phases/${index}/tasks`, "semantic-invalid");
    for (const [taskIndex, task] of phase.tasks.entries()) {
      if (task.acceptance.length > 6) add(findings, "I-15", `${task.id} exceeds the acceptance ceiling`, `/phases/${index}/tasks/${taskIndex}/acceptance`, "semantic-invalid");
      if (task.ownedPaths.length > 8) add(findings, "I-15", `${task.id} exceeds the owned-path ceiling`, `/phases/${index}/tasks/${taskIndex}/ownedPaths`, "semantic-invalid");
    }
  }

  const duplicateDeterminations = duplicates(model.core.determinations.map((entry) => entry.key));
  if (duplicateDeterminations.length) add(findings, "I-16", "Determination keys must be unique", "/core/determinations", "fatal", duplicateDeterminations);

  for (const [index, determination] of model.core.determinations.entries()) {
    if (!sourceIsVerified(determination.source, model)) add(findings, "I-17", "Determination authority provenance is not verifiable", `/core/determinations/${index}/source`);
    if (determination.source.kind === "model-default" && determination.rigidity === "RIGID"
      && (determination.materiality === "product" || determination.materiality === "architecture")) {
      add(findings, "I-17", "A model default cannot decide a RIGID product or architecture determination", `/core/determinations/${index}/source`, "user-decision-required");
    }
  }
  for (const [index, path] of model.core.protectedPaths.entries()) {
    if (!pathIsSafe(path.path)) add(findings, "I-06", "Protected path is not a safe single-line project-relative path", `/core/protectedPaths/${index}/path`, "fatal", [path.path]);
    if (!protectedSourceIsVerified(path, model)) add(findings, "I-17", "Protected-path authority provenance is not verifiable", `/core/protectedPaths/${index}/source`);
  }
  const protectedRoots = new Set(model.core.protectedPaths.map((entry) => entry.path));
  for (const required of [".rb", ".rb-harness", ".git"]) {
    if (!protectedRoots.has(required as RelPath)) add(findings, "I-17", `Missing built-in protected path ${required}`, "/core/protectedPaths", "fatal", [required]);
  }
  const provenance = model.core.provenance;
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(provenance.runId)
    || provenance.requestSha256 !== sha256Text(provenance.originalRequest) as Sha256 || !isIsoDateTime(provenance.generatedAt)) {
    add(findings, "I-17", "Core provenance is incomplete, inconsistent, or not clock-valid", "/core/provenance");
  }

  const singleLines: Array<[string, string]> = [
    ["/core/identity/name", model.core.identity.name],
    ["/core/identity/objective", model.core.identity.objective],
    ...model.requirements.map((entry, index) => [`/requirements/${index}/statement`, entry.statement] as [string, string]),
    ...model.core.determinations.flatMap((entry, index) => [
      [`/core/determinations/${index}/statement`, entry.statement] as [string, string],
      [`/core/determinations/${index}/rationale`, entry.rationale] as [string, string],
    ]),
    ...model.core.protectedPaths.map((entry, index) => [`/core/protectedPaths/${index}/reason`, entry.reason] as [string, string]),
    ...model.phases.flatMap((phase, phaseIndex) => [
      [`/phases/${phaseIndex}/title`, phase.title] as [string, string],
      [`/phases/${phaseIndex}/goal`, phase.goal] as [string, string],
      ...phase.tasks.flatMap((task, taskIndex) => [
        [`/phases/${phaseIndex}/tasks/${taskIndex}/title`, task.title] as [string, string],
        [`/phases/${phaseIndex}/tasks/${taskIndex}/intent`, task.intent] as [string, string],
        [`/phases/${phaseIndex}/tasks/${taskIndex}/expectedEvidence`, task.expectedEvidence] as [string, string],
        ...task.acceptance.map((entry, acceptanceIndex) => [`/phases/${phaseIndex}/tasks/${taskIndex}/acceptance/${acceptanceIndex}`, entry.statement] as [string, string]),
      ]),
    ]),
  ];
  for (const [pointer, value] of singleLines) if (!validSingleLine(value)) add(findings, "I-18", "Rendered semantic field must be non-empty and single-line", pointer);

  for (const [index, task] of tasks.entries()) if (task.parallelSafe !== false) add(findings, "I-19", `${task.id} parallel safety must be code-owned false`, `/phases/tasks/${index}/parallelSafe`);
  if (model.requirements.length === 0) add(findings, "I-20", "At least one requirement is required", "/requirements", "user-decision-required");

  return { valid: findings.length === 0, findings };
}
