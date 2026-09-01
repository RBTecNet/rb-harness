import { sha256Text } from "../../hash.js";
import {
  ambiguousAcceptanceCriterion,
  ambiguousValidationInstruction,
  changeReferencesPlanningArtifacts,
  isVisualAcceptanceCriterion,
} from "../../execution-contract.js";
import { semanticKey, SEMANTIC_KEY_PATTERN, type SemanticKey } from "../identity.js";
import type { ValidationIntentInput } from "../ir.js";
import { PROJECT_RELATIVE_PATH_PATTERN } from "../path-contract.js";
import type { JsonSchemaDocument } from "../providers/contract.js";
import { TASK_ACCEPTANCE_MAX_ITEMS } from "../task-contract.js";
import { projectRelativePathIsSafe, semanticSingleLineIsValid } from "../validate.js";
import { progressiveCanonicalJson } from "./canonical-json.js";
import {
  canonicalizeDatabaseSchema,
  type DatabaseSchema,
} from "./database-schema-ir.js";
import {
  canonicalizeProjectDescription,
  type ProjectDescription,
} from "./project-description-ir.js";
import {
  canonicalizeUserStories,
  type UserStories,
} from "./user-stories-ir.js";

export const PROJECT_PHASES_CONTRACT = "rb-project-phases/v1" as const;
export const PROJECT_PHASES_UPSTREAM_CONTRACT = "rb-project-phases-upstream/v1" as const;

export type ImplementationSubjectKind = "constraint" | "story" | "table";

/** Closed, Core-created implementation authority exposed read-only to the provider. */
export interface ImplementationSubject {
  readonly key: SemanticKey;
  readonly kind: ImplementationSubjectKind;
  readonly sourceKey: SemanticKey;
  readonly requirement: string;
}

export interface ProjectPhasesTask {
  readonly key: SemanticKey;
  readonly title: string;
  readonly intent: string;
  readonly dependsOn: readonly SemanticKey[];
  readonly ownedPaths: readonly string[];
  readonly coverageKeys: readonly SemanticKey[];
  readonly acceptance: readonly string[];
  readonly validation: readonly ValidationIntentInput[];
  readonly expectedEvidence: string;
}

export interface ProjectPhasesPhase {
  readonly key: SemanticKey;
  readonly title: string;
  readonly goal: string;
  readonly tasks: readonly ProjectPhasesTask[];
}

/** Strict developer-owned Phase-4 semantic IR. */
export interface ProjectPhases {
  readonly contract: typeof PROJECT_PHASES_CONTRACT;
  readonly stage: "project-phases";
  readonly projectKey: SemanticKey;
  readonly phases: readonly ProjectPhasesPhase[];
}

/** Provider wire intentionally omits all Core-owned root authority. */
export interface ProjectPhasesProposalWire {
  readonly phases: readonly {
    readonly key: string;
    readonly title: string;
    readonly goal: string;
    readonly tasks: readonly {
      readonly key: string;
      readonly title: string;
      readonly intent: string;
      readonly dependsOn: readonly string[];
      readonly ownedPaths: readonly string[];
      readonly coverageKeys: readonly string[];
      readonly acceptance: readonly string[];
      readonly validation: readonly (
        | { readonly kind: "command"; readonly commandKey: string }
        | { readonly kind: "manual"; readonly inspection: string }
        | { readonly kind: "human"; readonly evidence: string }
      )[];
      readonly expectedEvidence: string;
    }[];
  }[];
}

export interface ProjectPhasesUpstreamLineage {
  readonly projectDescriptionAuthoritativeInputSha256: string;
  readonly userStoriesUpstreamProjectionSha256: string;
  readonly userStoriesAuthoritativeInputSha256: string;
  readonly databaseSchemaUpstreamProjectionSha256: string;
  readonly databaseSchemaAuthoritativeInputSha256: string;
}

/** Coarse projection of every frozen semantic input consumed by the P4 compiler. */
export interface ProjectPhasesUpstreamProjection {
  readonly contract: typeof PROJECT_PHASES_UPSTREAM_CONTRACT;
  readonly projectDescription: ProjectDescription;
  readonly userStories: UserStories;
  readonly databaseSchema: DatabaseSchema;
  readonly lineage: ProjectPhasesUpstreamLineage;
}

export type ProjectPhasesFindingCode = "shape" | "semantic" | "coverage" | "upstream" | "authority";
export interface ProjectPhasesFinding {
  readonly code: ProjectPhasesFindingCode;
  readonly pointer: string;
  readonly message: string;
}

export type ProjectPhasesOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly findings: readonly ProjectPhasesFinding[] };

const keySchema = { type: "string", pattern: SEMANTIC_KEY_PATTERN } as const;
const lineSchema = { type: "string", minLength: 1, pattern: "^[^\\n\\r\\t]+$" } as const;
const validationSchema = {
  oneOf: [
    {
      type: "object", additionalProperties: false, required: ["kind", "commandKey"],
      properties: { kind: { type: "string", enum: ["command"] }, commandKey: keySchema },
    },
    {
      type: "object", additionalProperties: false, required: ["kind", "inspection"],
      properties: { kind: { type: "string", enum: ["manual"] }, inspection: lineSchema },
    },
    {
      type: "object", additionalProperties: false, required: ["kind", "evidence"],
      properties: { kind: { type: "string", enum: ["human"] }, evidence: lineSchema },
    },
  ],
} as const;

export const PROJECT_PHASES_PROPOSAL_SCHEMA: JsonSchemaDocument = {
  type: "object",
  additionalProperties: false,
  required: ["phases"],
  properties: {
    phases: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "title", "goal", "tasks"],
        properties: {
          key: keySchema,
          title: lineSchema,
          goal: lineSchema,
          tasks: {
            type: "array",
            minItems: 1,
            maxItems: 12,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["key", "title", "intent", "dependsOn", "ownedPaths", "coverageKeys", "acceptance", "validation", "expectedEvidence"],
              properties: {
                key: keySchema,
                title: lineSchema,
                intent: lineSchema,
                dependsOn: { type: "array", items: keySchema },
                ownedPaths: { type: "array", minItems: 1, maxItems: 8, items: { type: "string", pattern: PROJECT_RELATIVE_PATH_PATTERN } },
                coverageKeys: { type: "array", minItems: 1, items: keySchema },
                acceptance: { type: "array", minItems: 1, maxItems: TASK_ACCEPTANCE_MAX_ITEMS, items: lineSchema },
                validation: { type: "array", minItems: 1, items: validationSchema },
                expectedEvidence: lineSchema,
              },
            },
          },
        },
      },
    },
  },
};

const SHA256 = /^[a-f0-9]{64}$/;
const SUBJECT_KEY = /^(?:constraint|story|table)-[a-f0-9]{32}$/;

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exact(record: Record<string, unknown>, fields: readonly string[], pointer: string, findings: ProjectPhasesFinding[]): boolean {
  let valid = true;
  const allowed = new Set(fields);
  const child = (key: string): string => pointer === "/" ? `/${key}` : `${pointer}/${key}`;
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      findings.push({ code: "authority", pointer: child(key), message: "unknown provider field is forbidden" });
      valid = false;
    }
  }
  for (const key of fields) {
    if (!(key in record)) {
      findings.push({ code: "shape", pointer: child(key), message: "required field is missing" });
      valid = false;
    }
  }
  return valid;
}

function record(value: unknown, pointer: string, findings: ProjectPhasesFinding[]): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    findings.push({ code: "shape", pointer, message: "expected object" });
    return undefined;
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, pointer: string, findings: ProjectPhasesFinding[]): readonly unknown[] {
  if (!Array.isArray(value)) {
    findings.push({ code: "shape", pointer, message: "expected array" });
    return [];
  }
  return value;
}

function string(value: unknown, pointer: string, findings: ProjectPhasesFinding[]): string {
  if (typeof value !== "string") {
    findings.push({ code: "shape", pointer, message: "expected string" });
    return "";
  }
  return value;
}

function key(value: unknown, pointer: string, findings: ProjectPhasesFinding[]): SemanticKey {
  const raw = string(value, pointer, findings);
  const parsed = semanticKey(raw);
  if (!parsed) findings.push({ code: "shape", pointer, message: `invalid SemanticKey '${raw}'` });
  return (parsed ?? "invalid-key") as SemanticKey;
}

function decodeValidation(value: unknown, pointer: string, findings: ProjectPhasesFinding[]): ValidationIntentInput {
  const item = record(value, pointer, findings) ?? {};
  if (item.kind === "command") {
    exact(item, ["kind", "commandKey"], pointer, findings);
    return { kind: "command", commandKey: key(item.commandKey, `${pointer}/commandKey`, findings) };
  }
  if (item.kind === "manual") {
    exact(item, ["kind", "inspection"], pointer, findings);
    return { kind: "manual", inspection: string(item.inspection, `${pointer}/inspection`, findings) };
  }
  if (item.kind === "human") {
    exact(item, ["kind", "evidence"], pointer, findings);
    return { kind: "human", evidence: string(item.evidence, `${pointer}/evidence`, findings) };
  }
  exact(item, ["kind"], pointer, findings);
  findings.push({ code: "shape", pointer: `${pointer}/kind`, message: "expected command, manual, or human" });
  return { kind: "manual", inspection: "" };
}

/** Hand decoder remains authoritative even when provider schema enforcement is bypassed. */
export function decodeProjectPhasesProposalWire(payload: unknown): ProjectPhasesOutcome<ProjectPhasesProposalWire> {
  const findings: ProjectPhasesFinding[] = [];
  const root = record(payload, "/", findings);
  if (!root) return { ok: false, findings };
  exact(root, ["phases"], "/", findings);
  const phases = array(root.phases, "/phases", findings).map((value, phaseIndex) => {
    const pointer = `/phases/${phaseIndex}`;
    const phase = record(value, pointer, findings) ?? {};
    exact(phase, ["key", "title", "goal", "tasks"], pointer, findings);
    return {
      key: key(phase.key, `${pointer}/key`, findings),
      title: string(phase.title, `${pointer}/title`, findings),
      goal: string(phase.goal, `${pointer}/goal`, findings),
      tasks: array(phase.tasks, `${pointer}/tasks`, findings).map((taskValue, taskIndex) => {
        const taskPointer = `${pointer}/tasks/${taskIndex}`;
        const task = record(taskValue, taskPointer, findings) ?? {};
        exact(task, ["key", "title", "intent", "dependsOn", "ownedPaths", "coverageKeys", "acceptance", "validation", "expectedEvidence"], taskPointer, findings);
        return {
          key: key(task.key, `${taskPointer}/key`, findings),
          title: string(task.title, `${taskPointer}/title`, findings),
          intent: string(task.intent, `${taskPointer}/intent`, findings),
          dependsOn: array(task.dependsOn, `${taskPointer}/dependsOn`, findings).map((item, index) => key(item, `${taskPointer}/dependsOn/${index}`, findings)),
          ownedPaths: array(task.ownedPaths, `${taskPointer}/ownedPaths`, findings).map((item, index) => string(item, `${taskPointer}/ownedPaths/${index}`, findings)),
          coverageKeys: array(task.coverageKeys, `${taskPointer}/coverageKeys`, findings).map((item, index) => key(item, `${taskPointer}/coverageKeys/${index}`, findings)),
          acceptance: array(task.acceptance, `${taskPointer}/acceptance`, findings).map((item, index) => string(item, `${taskPointer}/acceptance/${index}`, findings)),
          validation: array(task.validation, `${taskPointer}/validation`, findings).map((item, index) => decodeValidation(item, `${taskPointer}/validation/${index}`, findings)),
          expectedEvidence: string(task.expectedEvidence, `${taskPointer}/expectedEvidence`, findings),
        };
      }),
    };
  });
  return findings.length ? { ok: false, findings } : { ok: true, value: { phases } };
}

export function projectPhasesUpstreamProjection(
  projectDescription: ProjectDescription,
  userStories: UserStories,
  databaseSchema: DatabaseSchema,
  lineage: ProjectPhasesUpstreamLineage,
): ProjectPhasesUpstreamProjection {
  for (const [name, value] of Object.entries(lineage)) {
    if (!SHA256.test(value)) throw new Error(`PROJECT_PHASES_UPSTREAM_INVALID: ${name} is not a lowercase SHA-256`);
  }
  return {
    contract: PROJECT_PHASES_UPSTREAM_CONTRACT,
    projectDescription: canonicalizeProjectDescription(projectDescription),
    userStories: canonicalizeUserStories(userStories),
    databaseSchema: canonicalizeDatabaseSchema(databaseSchema),
    lineage: { ...lineage },
  };
}

export function projectPhasesUpstreamProjectionSha256(upstream: ProjectPhasesUpstreamProjection): string {
  return sha256Text(progressiveCanonicalJson(upstream));
}

export function projectPhasesAuthoritativeInputSha256(upstreamProjectionSha256: string): string {
  if (!SHA256.test(upstreamProjectionSha256)) throw new Error("PROJECT_PHASES_AUTHORITATIVE_INPUT_INVALID: upstream projection hash is invalid");
  return sha256Text(progressiveCanonicalJson({
    contract: PROJECT_PHASES_CONTRACT,
    stage: "project-phases",
    upstreamProjectionSha256,
  }));
}

function subjectKey(kind: ImplementationSubjectKind, sourceKey: SemanticKey): SemanticKey {
  const value = `${kind}-${sha256Text(`${kind}\u0000${sourceKey}`).slice(0, 32)}`;
  const parsed = semanticKey(value);
  if (!parsed) throw new Error(`PROJECT_PHASES_SUBJECT_KEY_INVALID: ${value}`);
  return parsed;
}

function json(value: unknown): string {
  return progressiveCanonicalJson(value);
}

function constraintRequirement(upstream: ProjectPhasesUpstreamProjection, sourceKey: SemanticKey): string {
  const constraint = upstream.projectDescription.constraints.find((entry) => entry.key === sourceKey)!;
  return `P1 constraint ${json({ key: constraint.key, statement: constraint.statement })}`;
}

function storyRequirement(upstream: ProjectPhasesUpstreamProjection, sourceKey: SemanticKey): string {
  const story = upstream.userStories.stories.find((entry) => entry.key === sourceKey)!;
  const actor = upstream.projectDescription.actors.find((entry) => entry.key === story.actorKey)!;
  const operator = upstream.projectDescription.actors.find((entry) => entry.key === story.operatorActorKey)!;
  const workflow = upstream.projectDescription.workflows.find((entry) => entry.key === story.workflowKey)!;
  const capabilities = story.capabilityKeys.map((capabilityKey) => upstream.projectDescription.capabilities.find((entry) => entry.key === capabilityKey)!);
  return `P2 user story ${json({
    storyId: story.storyId,
    key: story.key,
    actor: { key: actor.key, name: actor.name, responsibility: actor.responsibility },
    operator: { key: operator.key, name: operator.name, responsibility: operator.responsibility },
    workflow: { key: workflow.key, statement: workflow.statement },
    capabilities: capabilities.map((entry) => ({ key: entry.key, statement: entry.statement })),
    intent: story.intent,
    outcome: story.outcome,
    acceptance: story.acceptance,
  })}`;
}

function tableRequirement(upstream: ProjectPhasesUpstreamProjection, sourceKey: SemanticKey): string {
  const table = upstream.databaseSchema.tables.find((entry) => entry.key === sourceKey)!;
  const foreignKeys = upstream.databaseSchema.foreignKeys.filter((entry) => entry.fromTableKey === sourceKey || entry.toTableKey === sourceKey);
  return `P3 logical table ${json({
    key: table.key,
    name: table.name,
    purpose: table.purpose,
    fields: table.fields.map((field) => ({ key: field.key, name: field.name, logicalType: field.logicalType, required: field.required })),
    primaryKeyFieldKeys: table.primaryKeyFieldKeys,
    uniqueConstraints: table.uniqueConstraints,
    foreignKeys,
  })}`;
}

/** Declaration order is constraints, stories, then applicable tables; each category is keyed deterministically. */
export function deriveImplementationSubjects(upstream: ProjectPhasesUpstreamProjection): readonly ImplementationSubject[] {
  const inputs: readonly { readonly kind: ImplementationSubjectKind; readonly sourceKey: SemanticKey }[] = [
    ...[...upstream.projectDescription.constraints].sort((a, b) => compare(a.key, b.key)).map((entry) => ({ kind: "constraint" as const, sourceKey: entry.key })),
    ...[...upstream.userStories.stories].sort((a, b) => compare(a.key, b.key)).map((entry) => ({ kind: "story" as const, sourceKey: entry.key })),
    ...(upstream.databaseSchema.disposition === "applicable"
      ? [...upstream.databaseSchema.tables].sort((a, b) => compare(a.key, b.key)).map((entry) => ({ kind: "table" as const, sourceKey: entry.key }))
      : []),
  ];
  const seenSource = new Set<string>();
  const seenSubject = new Set<string>();
  return inputs.map((entry) => {
    const sourceIdentity = `${entry.kind}\u0000${entry.sourceKey}`;
    if (seenSource.has(sourceIdentity)) throw new Error(`PROJECT_PHASES_SUBJECT_COLLISION: duplicate ${entry.kind} source '${entry.sourceKey}'`);
    seenSource.add(sourceIdentity);
    const generated = subjectKey(entry.kind, entry.sourceKey);
    if (seenSubject.has(generated)) throw new Error(`PROJECT_PHASES_SUBJECT_COLLISION: generated key '${generated}' is not unique`);
    seenSubject.add(generated);
    const requirement = entry.kind === "constraint"
      ? constraintRequirement(upstream, entry.sourceKey)
      : entry.kind === "story"
        ? storyRequirement(upstream, entry.sourceKey)
        : tableRequirement(upstream, entry.sourceKey);
    if (!semanticSingleLineIsValid(requirement)) throw new Error(`PROJECT_PHASES_REQUIREMENT_INVALID: ${generated}`);
    return { key: generated, kind: entry.kind, sourceKey: entry.sourceKey, requirement };
  });
}

export function resolveProjectPhasesProposal(
  wire: ProjectPhasesProposalWire,
  upstream: ProjectPhasesUpstreamProjection,
): ProjectPhases {
  return {
    contract: PROJECT_PHASES_CONTRACT,
    stage: "project-phases",
    projectKey: upstream.projectDescription.project.key,
    phases: wire.phases.map((phase) => ({
      key: phase.key as SemanticKey,
      title: phase.title,
      goal: phase.goal,
      tasks: phase.tasks.map((task) => ({
        ...task,
        key: task.key as SemanticKey,
        dependsOn: task.dependsOn as readonly SemanticKey[],
        coverageKeys: task.coverageKeys as readonly SemanticKey[],
      })),
    })),
  };
}

function duplicates(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const duplicate = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicate.add(value);
    seen.add(value);
  }
  return [...duplicate].sort(compare);
}

function pathsIntersect(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function graphHasCycle(tasks: readonly ProjectPhasesTask[]): boolean {
  const byKey = new Map<string, ProjectPhasesTask>(tasks.map((task) => [task.key, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (taskKey: string): boolean => {
    if (visiting.has(taskKey)) return true;
    if (visited.has(taskKey)) return false;
    visiting.add(taskKey);
    for (const dependency of byKey.get(taskKey)?.dependsOn ?? []) if (byKey.has(dependency) && visit(dependency)) return true;
    visiting.delete(taskKey);
    visited.add(taskKey);
    return false;
  };
  return tasks.some((task) => visit(task.key));
}

export function validateProjectPhases(
  value: ProjectPhases,
  upstream: ProjectPhasesUpstreamProjection,
  options: {
    readonly allowMissingUpstreamSubjects?: boolean;
    readonly allowProjectKeyMismatch?: boolean;
    readonly allowUncoveredUpstreamSubjects?: boolean;
  } = {},
): ProjectPhasesOutcome<ProjectPhases> {
  const findings: ProjectPhasesFinding[] = [];
  const add = (code: ProjectPhasesFindingCode, pointer: string, message: string): void => { findings.push({ code, pointer, message }); };
  if (value.contract !== PROJECT_PHASES_CONTRACT) add("shape", "/contract", `expected ${PROJECT_PHASES_CONTRACT}`);
  if (value.stage !== "project-phases") add("shape", "/stage", "expected project-phases");
  if (value.projectKey !== upstream.projectDescription.project.key) {
    add(options.allowProjectKeyMismatch ? "upstream" : "semantic", "/projectKey", "project key does not match current P1 authority");
  }
  if (!value.phases.length) add("semantic", "/phases", "at least one phase is required");
  for (const duplicate of duplicates(value.phases.map((phase) => phase.key))) add("semantic", "/phases", `duplicate phase key '${duplicate}'`);
  const tasks = value.phases.flatMap((phase) => phase.tasks);
  for (const duplicate of duplicates(tasks.map((task) => task.key))) add("semantic", "/phases/tasks", `duplicate task key '${duplicate}'`);
  const taskByKey = new Map(tasks.map((task) => [task.key, task]));
  const taskLocation = new Map<string, { phase: number; ordinal: number }>();
  value.phases.forEach((phase, phaseIndex) => phase.tasks.forEach((task, taskIndex) => taskLocation.set(task.key, { phase: phaseIndex, ordinal: taskIndex })));
  const subjects = deriveImplementationSubjects(upstream);
  const subjectKeys = new Set(subjects.map((subject) => subject.key));
  const commandKeys = new Set(upstream.projectDescription.qualityCommands.map((command) => command.key));

  value.phases.forEach((phase, phaseIndex) => {
    const phasePointer = `/phases/${phaseIndex}`;
    if (!semanticKey(phase.key)) add("shape", `${phasePointer}/key`, "invalid phase SemanticKey");
    if (!semanticSingleLineIsValid(phase.title)) add("semantic", `${phasePointer}/title`, "phase title must be non-empty and single-line");
    if (!semanticSingleLineIsValid(phase.goal)) add("semantic", `${phasePointer}/goal`, "phase goal must be non-empty and single-line");
    if (!phase.tasks.length) add("semantic", `${phasePointer}/tasks`, "phase must contain at least one task");
    if (phase.tasks.length > 12) add("semantic", `${phasePointer}/tasks`, "phase exceeds the canonical 12-task ceiling");
    phase.tasks.forEach((task, taskIndex) => {
      const pointer = `${phasePointer}/tasks/${taskIndex}`;
      if (!semanticKey(task.key)) add("shape", `${pointer}/key`, "invalid task SemanticKey");
      if (!semanticSingleLineIsValid(task.title)) add("semantic", `${pointer}/title`, "task title must be non-empty and single-line");
      if (!semanticSingleLineIsValid(task.intent)) add("semantic", `${pointer}/intent`, "task intent must be non-empty and single-line");
      if (changeReferencesPlanningArtifacts(task.intent)) add("semantic", `${pointer}/intent`, "task intent must not mutate planning/control-plane artifacts");
      if (!semanticSingleLineIsValid(task.expectedEvidence)) add("semantic", `${pointer}/expectedEvidence`, "expected evidence must be non-empty and single-line");
      for (const duplicate of duplicates(task.dependsOn)) add("semantic", `${pointer}/dependsOn`, `duplicate dependency '${duplicate}'`);
      for (const dependency of task.dependsOn) {
        if (dependency === task.key) add("semantic", `${pointer}/dependsOn`, "task must not depend on itself");
        const dependencyLocation = taskLocation.get(dependency);
        if (!dependencyLocation) add("semantic", `${pointer}/dependsOn`, `unknown task dependency '${dependency}'`);
        else if (dependencyLocation.phase > phaseIndex) add("semantic", `${pointer}/dependsOn`, `task dependency '${dependency}' belongs to a later phase`);
        else if (dependencyLocation.phase === phaseIndex && dependencyLocation.ordinal >= taskIndex) add("semantic", `${pointer}/dependsOn`, `task dependency '${dependency}' is not earlier in declaration order`);
      }
      if (!task.ownedPaths.length) add("semantic", `${pointer}/ownedPaths`, "task must own at least one path");
      if (task.ownedPaths.length > 8) add("semantic", `${pointer}/ownedPaths`, "task exceeds the canonical 8-path ceiling");
      for (const duplicate of duplicates(task.ownedPaths)) add("semantic", `${pointer}/ownedPaths`, `duplicate owned path '${duplicate}'`);
      task.ownedPaths.forEach((path, pathIndex) => {
        if (!projectRelativePathIsSafe(path)) add("semantic", `${pointer}/ownedPaths/${pathIndex}`, `unsafe project-relative path '${path}'`);
        if ([".rb", ".rb-harness", ".git", ".spec/init"].some((root) => pathsIntersect(path, root))) {
          add("semantic", `${pointer}/ownedPaths/${pathIndex}`, `owned path '${path}' intersects the Core control plane`);
        }
      });
      if (!task.coverageKeys.length) add("coverage", `${pointer}/coverageKeys`, "task must cover at least one ImplementationSubject");
      for (const duplicate of duplicates(task.coverageKeys)) add("coverage", `${pointer}/coverageKeys`, `duplicate coverage key '${duplicate}'`);
      task.coverageKeys.forEach((coverageKey, coverageIndex) => {
        if (!subjectKeys.has(coverageKey)) {
          const removedUpstream = options.allowMissingUpstreamSubjects && SUBJECT_KEY.test(coverageKey);
          add(removedUpstream ? "upstream" : "coverage", `${pointer}/coverageKeys/${coverageIndex}`, `unknown ImplementationSubject '${coverageKey}'`);
        }
      });
      if (!task.acceptance.length) add("semantic", `${pointer}/acceptance`, "task must contain acceptance criteria");
      if (task.acceptance.length > TASK_ACCEPTANCE_MAX_ITEMS) add("semantic", `${pointer}/acceptance`, `task exceeds the canonical ${TASK_ACCEPTANCE_MAX_ITEMS}-item acceptance ceiling`);
      task.acceptance.forEach((acceptance, acceptanceIndex) => {
        const ambiguity = ambiguousAcceptanceCriterion(acceptance);
        if (!semanticSingleLineIsValid(acceptance) || ambiguity) add("semantic", `${pointer}/acceptance/${acceptanceIndex}`, `task acceptance must be self-contained${ambiguity ? `: ${ambiguity}` : ""}`);
        if (/^(?:R|RF|RNF|UI|CT|AC)-[A-Z0-9-]+\.?$/i.test(acceptance.trim())) add("semantic", `${pointer}/acceptance/${acceptanceIndex}`, "task acceptance cannot consist only of an authority ID");
        if (isVisualAcceptanceCriterion(acceptance)) add("semantic", `${pointer}/acceptance/${acceptanceIndex}`, "visual/aesthetic authority belongs in the P2 requirement, not task acceptance");
      });
      if (!task.validation.length) add("semantic", `${pointer}/validation`, "task must contain validation");
      task.validation.forEach((validation, validationIndex) => {
        const validationPointer = `${pointer}/validation/${validationIndex}`;
        if (validation.kind === "command") {
          if (!commandKeys.has(validation.commandKey as SemanticKey)) add("semantic", `${validationPointer}/commandKey`, `unknown P1 quality command '${validation.commandKey}'`);
        } else {
          const text = validation.kind === "manual" ? validation.inspection : validation.evidence;
          if (!semanticSingleLineIsValid(text)) add("semantic", validationPointer, `${validation.kind} validation must be non-empty and single-line`);
          if (validation.kind === "manual") {
            const ambiguity = ambiguousValidationInstruction({ kind: "manual", value: text });
            if (ambiguity) add("semantic", validationPointer, `manual validation ${ambiguity}`);
          }
        }
      });
    });
  });
  if (graphHasCycle(tasks)) add("semantic", "/phases/tasks", "task dependency graph contains a cycle");
  const covered = new Set(tasks.flatMap((task) => task.coverageKeys));
  subjects.forEach((subject) => {
    if (!covered.has(subject.key) && options.allowUncoveredUpstreamSubjects !== true) {
      add("coverage", "/phases/tasks/coverageKeys", `ImplementationSubject '${subject.key}' is not covered by any task`);
    }
  });
  return findings.length ? { ok: false, findings } : { ok: true, value };
}

export function projectPhasesSemanticSha256(value: ProjectPhases): string {
  return sha256Text(progressiveCanonicalJson(value));
}
