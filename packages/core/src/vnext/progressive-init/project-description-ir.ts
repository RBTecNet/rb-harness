import { sha256Text } from "../../hash.js";
import { progressiveCanonicalJson } from "./canonical-json.js";
import { semanticKey, SEMANTIC_KEY_PATTERN, type SemanticKey } from "../identity.js";
import {
  questionProblem,
  type InterviewQuestionEvidence,
  type ProposedQuestion,
  verifyInterviewEvidence,
} from "../interview.js";
import type { Materiality, QualityCommandKind, Rigidity } from "../ir.js";
import { canonicalEvidenceText, requestEvidenceIsVerified } from "../provenance.js";
import type { JsonSchemaDocument } from "../providers/contract.js";
import { qualityCommandSafetyIssue, semanticSingleLineIsValid } from "../validate.js";

export const PROJECT_DESCRIPTION_CONTRACT = "rb-project-description/v1" as const;

export type ProjectDescriptionAuthority =
  | { readonly kind: "request"; readonly evidence: string }
  | { readonly kind: "user-answer"; readonly questionKey: SemanticKey; readonly value: string }
  | {
      readonly kind: "accepted-recommendation";
      readonly questionKey: SemanticKey;
      readonly value: string;
      readonly acceptanceMode: "blank-interactive" | "non-interactive-policy";
    }
  | { readonly kind: "model-default" }
  | { readonly kind: "developer" };

export interface ProjectDescriptionActor {
  readonly key: SemanticKey;
  readonly name: string;
  readonly responsibility: string;
}

export interface ProjectDescriptionCapability {
  readonly key: SemanticKey;
  readonly statement: string;
}

export interface ProjectDescriptionWorkflow {
  readonly key: SemanticKey;
  readonly statement: string;
  readonly actorKeys: readonly SemanticKey[];
  readonly capabilityKeys: readonly SemanticKey[];
}

export interface ProjectDescriptionConstraint {
  readonly key: SemanticKey;
  readonly statement: string;
}

export interface ProjectDescriptionDetermination {
  readonly key: SemanticKey;
  readonly statement: string;
  readonly rationale: string;
  readonly materiality: Materiality;
  readonly rigidity: Rigidity;
  readonly source: ProjectDescriptionAuthority;
}

export interface ProjectDescriptionQualityCommand {
  readonly key: SemanticKey;
  readonly kind: QualityCommandKind;
  readonly command: string;
}

/** Developer-owned semantics for the first Progressive Init stage only. */
export interface ProjectDescription {
  readonly contract: typeof PROJECT_DESCRIPTION_CONTRACT;
  readonly stage: "project-description";
  readonly originalRequest: string;
  readonly project: {
    readonly key: SemanticKey;
    readonly name: string;
    readonly objective: string;
  };
  readonly actors: readonly ProjectDescriptionActor[];
  readonly capabilities: readonly ProjectDescriptionCapability[];
  readonly workflows: readonly ProjectDescriptionWorkflow[];
  readonly constraints: readonly ProjectDescriptionConstraint[];
  readonly determinations: readonly ProjectDescriptionDetermination[];
  readonly qualityCommands: readonly ProjectDescriptionQualityCommand[];
}

type WireAuthority =
  | { readonly kind: "request"; readonly evidence: string }
  | { readonly kind: "user-answer"; readonly questionKey: string; readonly value: string }
  | {
      readonly kind: "accepted-recommendation";
      readonly questionKey: string;
      readonly value: string;
      readonly acceptanceMode: "blank-interactive" | "non-interactive-policy";
    }
  | { readonly kind: "model-default" }
  | { readonly kind: "question"; readonly questionKey: string };

export interface ProjectDescriptionWire {
  readonly contract: typeof PROJECT_DESCRIPTION_CONTRACT;
  readonly stage: "project-description";
  readonly originalRequest: string;
  readonly project: { readonly key: string; readonly name: string; readonly objective: string };
  readonly actors: readonly { readonly key: string; readonly name: string; readonly responsibility: string }[];
  readonly capabilities: readonly { readonly key: string; readonly statement: string }[];
  readonly workflows: readonly {
    readonly key: string;
    readonly statement: string;
    readonly actorKeys: readonly string[];
    readonly capabilityKeys: readonly string[];
  }[];
  readonly constraints: readonly { readonly key: string; readonly statement: string }[];
  readonly determinations: readonly {
    readonly key: string;
    readonly statement: string;
    readonly rationale: string;
    readonly materiality: Materiality;
    readonly rigidity: Rigidity;
    readonly source: WireAuthority;
  }[];
  readonly qualityCommands: readonly { readonly key: string; readonly kind: QualityCommandKind; readonly command: string }[];
  readonly questions: readonly ProposedQuestion[];
}

export interface ProjectDescriptionFinding {
  readonly code: "shape" | "semantic" | "authority" | "preservation";
  readonly pointer: string;
  readonly message: string;
}

export type ProjectDescriptionOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly findings: readonly ProjectDescriptionFinding[] };

const keySchema = { type: "string", pattern: SEMANTIC_KEY_PATTERN } as const;
const textSchema = { type: "string", minLength: 1 } as const;
const keyArraySchema = { type: "array", items: keySchema } as const;
const authoritySchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind"],
  properties: {
    kind: { type: "string", enum: ["request", "user-answer", "accepted-recommendation", "model-default", "question"] },
    evidence: { type: "string" },
    questionKey: keySchema,
    value: { type: "string" },
    acceptanceMode: { type: "string", enum: ["blank-interactive", "non-interactive-policy"] },
  },
} as const;

export const PROJECT_DESCRIPTION_SCHEMA: JsonSchemaDocument = {
  type: "object",
  additionalProperties: false,
  required: [
    "contract", "stage", "originalRequest", "project", "actors", "capabilities", "workflows",
    "constraints", "determinations", "qualityCommands", "questions",
  ],
  properties: {
    contract: { type: "string", enum: [PROJECT_DESCRIPTION_CONTRACT] },
    stage: { type: "string", enum: ["project-description"] },
    originalRequest: textSchema,
    project: {
      type: "object",
      additionalProperties: false,
      required: ["key", "name", "objective"],
      properties: { key: keySchema, name: textSchema, objective: textSchema },
    },
    actors: {
      type: "array", minItems: 1,
      items: { type: "object", additionalProperties: false, required: ["key", "name", "responsibility"], properties: { key: keySchema, name: textSchema, responsibility: textSchema } },
    },
    capabilities: {
      type: "array", minItems: 1,
      items: { type: "object", additionalProperties: false, required: ["key", "statement"], properties: { key: keySchema, statement: textSchema } },
    },
    workflows: {
      type: "array", minItems: 1,
      items: {
        type: "object", additionalProperties: false,
        required: ["key", "statement", "actorKeys", "capabilityKeys"],
        properties: { key: keySchema, statement: textSchema, actorKeys: { ...keyArraySchema, minItems: 1 }, capabilityKeys: { ...keyArraySchema, minItems: 1 } },
      },
    },
    constraints: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["key", "statement"], properties: { key: keySchema, statement: textSchema } },
    },
    determinations: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["key", "statement", "rationale", "materiality", "rigidity", "source"],
        properties: {
          key: keySchema, statement: textSchema, rationale: textSchema,
          materiality: { type: "string", enum: ["product", "architecture", "implementation", "preference"] },
          rigidity: { type: "string", enum: ["RIGID", "FLEXIBLE"] },
          source: authoritySchema,
        },
      },
    },
    qualityCommands: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["key", "kind", "command"],
        properties: { key: keySchema, kind: { type: "string", enum: ["test", "build", "lint", "typecheck", "run"] }, command: textSchema },
      },
    },
    questions: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["key", "question", "materiality", "rigidity", "recommendedAnswer", "alternatives"],
        properties: {
          key: keySchema, question: textSchema,
          materiality: { type: "string", enum: ["product", "architecture", "implementation", "preference"] },
          rigidity: { type: "string", enum: ["RIGID", "FLEXIBLE"] },
          recommendedAnswer: {
            type: "object", additionalProperties: false, required: ["value", "rationale"],
            properties: { value: textSchema, rationale: textSchema },
          },
          alternatives: { type: "array", items: textSchema },
        },
      },
    },
  },
};

function clean(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ");
}

function sortedUnique(values: readonly SemanticKey[]): readonly SemanticKey[] {
  return [...new Set(values)].sort();
}

function sortByKey<T extends { readonly key: string }>(values: readonly T[]): readonly T[] {
  return [...values].sort((left, right) => left.key.localeCompare(right.key));
}

function canonicalAuthority(source: ProjectDescriptionAuthority): ProjectDescriptionAuthority {
  if (source.kind === "request") return { kind: "request", evidence: clean(source.evidence) };
  if (source.kind === "user-answer") return { ...source, value: clean(source.value) };
  if (source.kind === "accepted-recommendation") return { ...source, value: clean(source.value) };
  return source;
}

export function canonicalizeProjectDescription(value: ProjectDescription): ProjectDescription {
  return {
    contract: PROJECT_DESCRIPTION_CONTRACT,
    stage: "project-description",
    originalRequest: value.originalRequest.trim(),
    project: { key: value.project.key, name: clean(value.project.name), objective: clean(value.project.objective) },
    actors: sortByKey(value.actors).map((entry) => ({ ...entry, name: clean(entry.name), responsibility: clean(entry.responsibility) })),
    capabilities: sortByKey(value.capabilities).map((entry) => ({ ...entry, statement: clean(entry.statement) })),
    workflows: sortByKey(value.workflows).map((entry) => ({
      ...entry,
      statement: clean(entry.statement),
      actorKeys: sortedUnique(entry.actorKeys),
      capabilityKeys: sortedUnique(entry.capabilityKeys),
    })),
    constraints: sortByKey(value.constraints).map((entry) => ({ ...entry, statement: clean(entry.statement) })),
    determinations: sortByKey(value.determinations).map((entry) => ({
      ...entry,
      statement: clean(entry.statement),
      rationale: clean(entry.rationale),
      source: canonicalAuthority(entry.source),
    })),
    qualityCommands: sortByKey(value.qualityCommands).map((entry) => ({ ...entry, command: entry.command.trim() })),
  };
}

/** The validated Markdown boundary turns accepted live semantics into developer-owned authority. */
export function projectDescriptionForPersistence(value: ProjectDescription): ProjectDescription {
  return canonicalizeProjectDescription({
    ...value,
    determinations: value.determinations.map((entry) => ({
      ...entry,
      source: { kind: "developer" as const },
    })),
  });
}

/** Request authority is an exact, meaningful request span—not an inferred interpretation. */
export function progressiveRequestDeterminationIsVerified(
  originalRequest: string,
  evidence: string,
  statement: string,
): boolean {
  return requestEvidenceIsVerified(originalRequest, evidence)
    && canonicalEvidenceText(evidence) === canonicalEvidenceText(statement);
}

function add(findings: ProjectDescriptionFinding[], code: ProjectDescriptionFinding["code"], pointer: string, message: string): void {
  findings.push({ code, pointer, message });
}

function validateKeys(values: readonly { readonly key: string }[], pointer: string, findings: ProjectDescriptionFinding[]): void {
  const seen = new Set<string>();
  values.forEach((entry, index) => {
    if (!semanticKey(entry.key)) add(findings, "semantic", `${pointer}/${index}/key`, `invalid SemanticKey '${entry.key}'`);
    if (seen.has(entry.key)) add(findings, "semantic", `${pointer}/${index}/key`, `duplicate SemanticKey '${entry.key}'`);
    seen.add(entry.key);
  });
}

function authorityIsValid(
  determination: ProjectDescriptionDetermination,
  originalRequest: string,
  interviewDecisions: ReadonlyMap<string, ReturnType<typeof verifyInterviewEvidence>>,
): boolean {
  const source = determination.source;
  if (source.kind === "developer") return true;
  if (source.kind === "model-default") {
    return determination.rigidity !== "RIGID" || !["product", "architecture"].includes(determination.materiality);
  }
  if (source.kind === "request") return progressiveRequestDeterminationIsVerified(originalRequest, source.evidence, determination.statement);
  const verified = interviewDecisions.get(source.questionKey);
  if (!verified || verified.selectedValue.trim() !== determination.statement.trim() || source.value.trim() !== verified.selectedValue.trim()) return false;
  return source.kind === "user-answer"
    ? verified.source.kind === "user-answer"
    : verified.source.kind === "accepted-recommendation" && verified.acceptanceMode === source.acceptanceMode;
}

export function validateProjectDescription(
  input: ProjectDescription,
  interviewEvidence: readonly InterviewQuestionEvidence[] = [],
): ProjectDescriptionOutcome<ProjectDescription> {
  const value = canonicalizeProjectDescription(input);
  const findings: ProjectDescriptionFinding[] = [];
  const interviewDecisions = new Map(interviewEvidence.map((entry) => [entry.key, verifyInterviewEvidence(entry)]));
  if (value.contract !== PROJECT_DESCRIPTION_CONTRACT || value.stage !== "project-description") add(findings, "shape", "/contract", "unsupported project-description contract");
  if (!value.originalRequest.trim()) add(findings, "semantic", "/originalRequest", "original request authority is required");
  if (!semanticKey(value.project.key)) add(findings, "semantic", "/project/key", "project key must be a SemanticKey");
  if (value.project.name.length < 2) add(findings, "semantic", "/project/name", "project name is not useful");
  if (value.project.objective.length < 12) add(findings, "semantic", "/project/objective", "project objective is not useful");
  if (!value.actors.length) add(findings, "semantic", "/actors", "at least one actor is required");
  if (!value.capabilities.length) add(findings, "semantic", "/capabilities", "at least one capability is required");
  if (!value.workflows.length) add(findings, "semantic", "/workflows", "at least one workflow is required");
  for (const [pointer, values] of [
    ["/actors", value.actors], ["/capabilities", value.capabilities], ["/workflows", value.workflows],
    ["/constraints", value.constraints], ["/determinations", value.determinations], ["/qualityCommands", value.qualityCommands],
  ] as const) validateKeys(values, pointer, findings);
  const allKeys = [value.project.key, ...value.actors, ...value.capabilities, ...value.workflows, ...value.constraints, ...value.determinations, ...value.qualityCommands]
    .map((entry) => typeof entry === "string" ? entry : entry.key);
  const globalSeen = new Set<string>();
  for (const key of allKeys) {
    if (globalSeen.has(key)) add(findings, "semantic", "/", `SemanticKey '${key}' is reused across project-description kinds`);
    globalSeen.add(key);
  }
  const actors = new Set(value.actors.map((entry) => entry.key));
  const capabilities = new Set(value.capabilities.map((entry) => entry.key));
  value.workflows.forEach((workflow, index) => {
    if (!workflow.actorKeys.length) add(findings, "semantic", `/workflows/${index}/actorKeys`, "workflow must reference at least one actor");
    if (!workflow.capabilityKeys.length) add(findings, "semantic", `/workflows/${index}/capabilityKeys`, "workflow must reference at least one capability");
    workflow.actorKeys.forEach((key) => { if (!actors.has(key)) add(findings, "semantic", `/workflows/${index}/actorKeys`, `unknown actor key '${key}'`); });
    workflow.capabilityKeys.forEach((key) => { if (!capabilities.has(key)) add(findings, "semantic", `/workflows/${index}/capabilityKeys`, `unknown capability key '${key}'`); });
  });
  value.determinations.forEach((entry, index) => {
    if (!authorityIsValid(entry, value.originalRequest, interviewDecisions)) add(findings, "authority", `/determinations/${index}/source`, "determination authority is not verifiable");
  });
  value.qualityCommands.forEach((entry, index) => {
    const issue = qualityCommandSafetyIssue(entry.command);
    if (issue) add(findings, "semantic", `/qualityCommands/${index}/command`, `quality command ${issue}`);
  });
  const lines: Array<[string, string]> = [
    ["/project/name", value.project.name], ["/project/objective", value.project.objective],
    ...value.actors.flatMap((entry, index) => [[`/actors/${index}/name`, entry.name], [`/actors/${index}/responsibility`, entry.responsibility]] as Array<[string, string]>),
    ...value.capabilities.map((entry, index) => [`/capabilities/${index}/statement`, entry.statement] as [string, string]),
    ...value.workflows.map((entry, index) => [`/workflows/${index}/statement`, entry.statement] as [string, string]),
    ...value.constraints.map((entry, index) => [`/constraints/${index}/statement`, entry.statement] as [string, string]),
    ...value.determinations.flatMap((entry, index) => [[`/determinations/${index}/statement`, entry.statement], [`/determinations/${index}/rationale`, entry.rationale]] as Array<[string, string]>),
  ];
  lines.forEach(([pointer, text]) => { if (!semanticSingleLineIsValid(text)) add(findings, "semantic", pointer, "field must be non-empty and single-line"); });
  return findings.length ? { ok: false, findings } : { ok: true, value };
}

export function projectDescriptionSemanticSha256(value: ProjectDescription): string {
  return sha256Text(progressiveCanonicalJson(canonicalizeProjectDescription(value)));
}

export function projectDescriptionAcceptedDecisionProjection(value: ProjectDescription): readonly unknown[] {
  return value.determinations.flatMap((entry) => {
    if (!["request", "user-answer", "accepted-recommendation", "developer"].includes(entry.source.kind)) return [];
    return [{
      key: entry.key,
      statement: entry.statement,
      rationale: entry.rationale,
      materiality: entry.materiality,
      rigidity: entry.rigidity,
    }];
  });
}

export function projectDescriptionAuthoritativeInputSha256(input: {
  readonly originalRequest: string;
  readonly discoverySha256: string;
  readonly acceptedDecisions: readonly unknown[];
  readonly contractVersion?: string;
}): string {
  return sha256Text(progressiveCanonicalJson({
    stage: "project-description",
    contract: input.contractVersion ?? PROJECT_DESCRIPTION_CONTRACT,
    originalRequestSha256: sha256Text(input.originalRequest.trim()),
    discoverySha256: input.discoverySha256,
    acceptedDecisions: input.acceptedDecisions,
  }));
}

function asRecord(value: unknown, pointer: string, findings: ProjectDescriptionFinding[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    add(findings, "shape", pointer, "expected object");
    return {};
  }
  return value as Record<string, unknown>;
}

function exact(record: Record<string, unknown>, allowed: readonly string[], pointer: string, findings: ProjectDescriptionFinding[]): void {
  const unexpected = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unexpected.length) add(findings, "shape", pointer, `unexpected fields: ${unexpected.join(", ")}`);
}

function text(value: unknown, pointer: string, findings: ProjectDescriptionFinding[]): string {
  if (typeof value !== "string" || !value.trim()) {
    add(findings, "shape", pointer, "expected non-empty string");
    return "";
  }
  return value.trim();
}

function list(value: unknown, pointer: string, findings: ProjectDescriptionFinding[]): readonly unknown[] {
  if (!Array.isArray(value)) {
    add(findings, "shape", pointer, "expected array");
    return [];
  }
  return value;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], pointer: string, findings: ProjectDescriptionFinding[]): T {
  if (typeof value === "string" && allowed.includes(value as T)) return value as T;
  add(findings, "shape", pointer, `expected one of ${allowed.join(", ")}`);
  return allowed[0]!;
}

function decodeSource(value: unknown, pointer: string, findings: ProjectDescriptionFinding[]): WireAuthority {
  const source = asRecord(value, pointer, findings);
  exact(source, ["kind", "evidence", "questionKey", "value", "acceptanceMode"], pointer, findings);
  const kind = enumValue(source.kind, ["request", "user-answer", "accepted-recommendation", "model-default", "question"] as const, `${pointer}/kind`, findings);
  if (kind === "request") return { kind, evidence: text(source.evidence, `${pointer}/evidence`, findings) };
  if (kind === "user-answer") return { kind, questionKey: text(source.questionKey, `${pointer}/questionKey`, findings), value: text(source.value, `${pointer}/value`, findings) };
  if (kind === "accepted-recommendation") return {
    kind,
    questionKey: text(source.questionKey, `${pointer}/questionKey`, findings),
    value: text(source.value, `${pointer}/value`, findings),
    acceptanceMode: enumValue(source.acceptanceMode, ["blank-interactive", "non-interactive-policy"] as const, `${pointer}/acceptanceMode`, findings),
  };
  if (kind === "question") return { kind, questionKey: text(source.questionKey, `${pointer}/questionKey`, findings) };
  return { kind };
}

export function decodeProjectDescriptionWire(payload: unknown, authoritativeRequest: string): ProjectDescriptionOutcome<ProjectDescriptionWire> {
  const findings: ProjectDescriptionFinding[] = [];
  const root = asRecord(payload, "", findings);
  exact(root, ["contract", "stage", "originalRequest", "project", "actors", "capabilities", "workflows", "constraints", "determinations", "qualityCommands", "questions"], "", findings);
  if (root.contract !== PROJECT_DESCRIPTION_CONTRACT) add(findings, "shape", "/contract", `expected ${PROJECT_DESCRIPTION_CONTRACT}`);
  if (root.stage !== "project-description") add(findings, "shape", "/stage", "expected project-description");
  const originalRequest = text(root.originalRequest, "/originalRequest", findings);
  if (originalRequest !== authoritativeRequest.trim()) add(findings, "authority", "/originalRequest", "candidate changed original request authority");
  const projectRecord = asRecord(root.project, "/project", findings);
  exact(projectRecord, ["key", "name", "objective"], "/project", findings);
  const project = { key: text(projectRecord.key, "/project/key", findings), name: text(projectRecord.name, "/project/name", findings), objective: text(projectRecord.objective, "/project/objective", findings) };
  const actors = list(root.actors, "/actors", findings).map((raw, index) => {
    const value = asRecord(raw, `/actors/${index}`, findings); exact(value, ["key", "name", "responsibility"], `/actors/${index}`, findings);
    return { key: text(value.key, `/actors/${index}/key`, findings), name: text(value.name, `/actors/${index}/name`, findings), responsibility: text(value.responsibility, `/actors/${index}/responsibility`, findings) };
  });
  const capabilities = list(root.capabilities, "/capabilities", findings).map((raw, index) => {
    const value = asRecord(raw, `/capabilities/${index}`, findings); exact(value, ["key", "statement"], `/capabilities/${index}`, findings);
    return { key: text(value.key, `/capabilities/${index}/key`, findings), statement: text(value.statement, `/capabilities/${index}/statement`, findings) };
  });
  const workflows = list(root.workflows, "/workflows", findings).map((raw, index) => {
    const value = asRecord(raw, `/workflows/${index}`, findings); exact(value, ["key", "statement", "actorKeys", "capabilityKeys"], `/workflows/${index}`, findings);
    return {
      key: text(value.key, `/workflows/${index}/key`, findings), statement: text(value.statement, `/workflows/${index}/statement`, findings),
      actorKeys: list(value.actorKeys, `/workflows/${index}/actorKeys`, findings).map((entry, item) => text(entry, `/workflows/${index}/actorKeys/${item}`, findings)),
      capabilityKeys: list(value.capabilityKeys, `/workflows/${index}/capabilityKeys`, findings).map((entry, item) => text(entry, `/workflows/${index}/capabilityKeys/${item}`, findings)),
    };
  });
  const constraints = list(root.constraints, "/constraints", findings).map((raw, index) => {
    const value = asRecord(raw, `/constraints/${index}`, findings); exact(value, ["key", "statement"], `/constraints/${index}`, findings);
    return { key: text(value.key, `/constraints/${index}/key`, findings), statement: text(value.statement, `/constraints/${index}/statement`, findings) };
  });
  const determinations = list(root.determinations, "/determinations", findings).map((raw, index) => {
    const value = asRecord(raw, `/determinations/${index}`, findings); exact(value, ["key", "statement", "rationale", "materiality", "rigidity", "source"], `/determinations/${index}`, findings);
    return {
      key: text(value.key, `/determinations/${index}/key`, findings), statement: text(value.statement, `/determinations/${index}/statement`, findings), rationale: text(value.rationale, `/determinations/${index}/rationale`, findings),
      materiality: enumValue(value.materiality, ["product", "architecture", "implementation", "preference"] as const, `/determinations/${index}/materiality`, findings),
      rigidity: enumValue(value.rigidity, ["RIGID", "FLEXIBLE"] as const, `/determinations/${index}/rigidity`, findings),
      source: decodeSource(value.source, `/determinations/${index}/source`, findings),
    };
  });
  const qualityCommands = list(root.qualityCommands, "/qualityCommands", findings).map((raw, index) => {
    const value = asRecord(raw, `/qualityCommands/${index}`, findings); exact(value, ["key", "kind", "command"], `/qualityCommands/${index}`, findings);
    return { key: text(value.key, `/qualityCommands/${index}/key`, findings), kind: enumValue(value.kind, ["test", "build", "lint", "typecheck", "run"] as const, `/qualityCommands/${index}/kind`, findings), command: text(value.command, `/qualityCommands/${index}/command`, findings) };
  });
  const questions = list(root.questions, "/questions", findings).map((raw, index): ProposedQuestion => {
    const value = asRecord(raw, `/questions/${index}`, findings); exact(value, ["key", "question", "materiality", "rigidity", "recommendedAnswer", "alternatives"], `/questions/${index}`, findings);
    const recommended = asRecord(value.recommendedAnswer, `/questions/${index}/recommendedAnswer`, findings); exact(recommended, ["value", "rationale"], `/questions/${index}/recommendedAnswer`, findings);
    const question: ProposedQuestion = {
      key: text(value.key, `/questions/${index}/key`, findings), question: text(value.question, `/questions/${index}/question`, findings),
      materiality: enumValue(value.materiality, ["product", "architecture", "implementation", "preference"] as const, `/questions/${index}/materiality`, findings),
      rigidity: enumValue(value.rigidity, ["RIGID", "FLEXIBLE"] as const, `/questions/${index}/rigidity`, findings),
      recommendedAnswer: { value: text(recommended.value, `/questions/${index}/recommendedAnswer/value`, findings), rationale: text(recommended.rationale, `/questions/${index}/recommendedAnswer/rationale`, findings) },
      alternatives: list(value.alternatives, `/questions/${index}/alternatives`, findings).map((entry, item) => text(entry, `/questions/${index}/alternatives/${item}`, findings)),
    };
    const problem = questionProblem(question); if (problem) add(findings, "semantic", `/questions/${index}`, problem);
    return question;
  });
  const questionKeys = new Set(questions.map((entry) => entry.key));
  determinations.forEach((entry, index) => {
    if (entry.source.kind === "question" && !questionKeys.has(entry.source.questionKey)) add(findings, "authority", `/determinations/${index}/source/questionKey`, "unknown project-description question key");
  });
  const wire: ProjectDescriptionWire = { contract: PROJECT_DESCRIPTION_CONTRACT, stage: "project-description", originalRequest, project, actors, capabilities, workflows, constraints, determinations, qualityCommands, questions };
  return findings.length ? { ok: false, findings } : { ok: true, value: wire };
}

export function resolveProjectDescriptionWire(
  wire: ProjectDescriptionWire,
  evidence: readonly InterviewQuestionEvidence[],
  existingDeveloperAuthority?: ProjectDescription,
): ProjectDescriptionOutcome<ProjectDescription> {
  const findings: ProjectDescriptionFinding[] = [];
  const decisions = new Map(evidence.map((entry) => [entry.key, verifyInterviewEvidence(entry)]));
  const determinations: ProjectDescriptionDetermination[] = wire.determinations.flatMap((entry, index) => {
    let source: ProjectDescriptionAuthority;
    let statement = entry.statement;
    if (entry.source.kind === "question") {
      const decision = decisions.get(entry.source.questionKey);
      if (!decision) {
        add(findings, "authority", `/determinations/${index}/source`, "question-backed determination has no resolved stage decision");
        return [];
      }
      statement = decision.selectedValue;
      source = decision.source.kind === "user-answer"
        ? { kind: "user-answer", questionKey: decision.questionKey, value: decision.selectedValue }
        : {
            kind: "accepted-recommendation",
            questionKey: decision.questionKey,
            value: decision.selectedValue,
            acceptanceMode: decision.acceptanceMode as "blank-interactive" | "non-interactive-policy",
          };
    } else if (entry.source.kind === "request") source = entry.source;
    else if (entry.source.kind === "user-answer") {
      const key = semanticKey(entry.source.questionKey);
      const decision = decisions.get(entry.source.questionKey);
      if (!key || decision?.source.kind !== "user-answer" || decision.selectedValue.trim() !== entry.source.value.trim()) {
        add(findings, "authority", `/determinations/${index}/source`, "user-answer authority has no matching current verified interview evidence");
        return [];
      }
      source = { ...entry.source, questionKey: key };
    } else if (entry.source.kind === "accepted-recommendation") {
      const key = semanticKey(entry.source.questionKey);
      const decision = decisions.get(entry.source.questionKey);
      if (!key || decision?.source.kind !== "accepted-recommendation"
        || decision.selectedValue.trim() !== entry.source.value.trim()
        || decision.acceptanceMode !== entry.source.acceptanceMode) {
        add(findings, "authority", `/determinations/${index}/source`, "accepted-recommendation authority has no matching current verified interview evidence");
        return [];
      }
      source = { ...entry.source, questionKey: key };
    } else source = entry.source;
    const key = semanticKey(entry.key); if (!key) return [];
    return [{ ...entry, key, statement, source }];
  });
  const key = semanticKey(wire.project.key);
  const actors = wire.actors.flatMap((entry) => { const parsed = semanticKey(entry.key); return parsed ? [{ ...entry, key: parsed }] : []; });
  const capabilities = wire.capabilities.flatMap((entry) => { const parsed = semanticKey(entry.key); return parsed ? [{ ...entry, key: parsed }] : []; });
  const workflows = wire.workflows.flatMap((entry) => {
    const parsed = semanticKey(entry.key); const actorKeys = entry.actorKeys.map(semanticKey); const capabilityKeys = entry.capabilityKeys.map(semanticKey);
    return parsed && actorKeys.every(Boolean) && capabilityKeys.every(Boolean) ? [{ ...entry, key: parsed, actorKeys: actorKeys as SemanticKey[], capabilityKeys: capabilityKeys as SemanticKey[] }] : [];
  });
  const constraints = wire.constraints.flatMap((entry) => { const parsed = semanticKey(entry.key); return parsed ? [{ ...entry, key: parsed }] : []; });
  const qualityCommands = wire.qualityCommands.flatMap((entry) => { const parsed = semanticKey(entry.key); return parsed ? [{ ...entry, key: parsed }] : []; });
  if (!key) add(findings, "semantic", "/project/key", "project key is invalid");
  if (findings.length || !key) return { ok: false, findings };
  const candidate: ProjectDescription = {
    contract: PROJECT_DESCRIPTION_CONTRACT,
    stage: "project-description",
    originalRequest: wire.originalRequest,
    project: { ...wire.project, key },
    actors,
    capabilities,
    workflows,
    constraints,
    determinations,
    qualityCommands,
  };
  return validateProjectDescription(preservePersistedDeveloperAuthority(existingDeveloperAuthority, candidate), evidence);
}

function semanticComparable(value: unknown): string {
  return progressiveCanonicalJson(value);
}

/** A complete candidate may add semantics, but it may not change or delete developer-owned keyed values. */
export function validateProjectDescriptionPreservation(existing: ProjectDescription | undefined, candidate: ProjectDescription): readonly ProjectDescriptionFinding[] {
  if (!existing) return [];
  const findings: ProjectDescriptionFinding[] = [];
  if (candidate.originalRequest !== existing.originalRequest) add(findings, "preservation", "/originalRequest", "candidate changed developer-owned request authority");
  if (semanticComparable(candidate.project) !== semanticComparable(existing.project)) add(findings, "preservation", "/project", "candidate changed developer-owned project identity or purpose");
  for (const [field, oldValues, newValues] of [
    ["actors", existing.actors, candidate.actors], ["capabilities", existing.capabilities, candidate.capabilities],
    ["workflows", existing.workflows, candidate.workflows], ["constraints", existing.constraints, candidate.constraints],
    ["determinations", existing.determinations, candidate.determinations], ["qualityCommands", existing.qualityCommands, candidate.qualityCommands],
  ] as const) {
    const current = new Map(newValues.map((entry) => [entry.key as string, entry]));
    oldValues.forEach((entry) => {
      const replacement = current.get(entry.key as string);
      if (!replacement) add(findings, "preservation", `/${field}/${entry.key}`, "candidate silently deleted developer-owned semantics");
      else {
        const oldComparable = field === "determinations" ? { ...entry, source: { kind: "developer" } } : entry;
        const replacementComparable = field === "determinations" ? { ...replacement, source: { kind: "developer" } } : replacement;
        if (semanticComparable(replacementComparable) !== semanticComparable(oldComparable)) {
          add(findings, "preservation", `/${field}/${entry.key}`, "candidate silently changed developer-owned semantics");
        }
      }
    });
  }
  return findings;
}

/** Reapply authority proven by the loaded developer-owned document after the provider candidate is independently validated. */
export function preservePersistedDeveloperAuthority(
  existing: ProjectDescription | undefined,
  candidate: ProjectDescription,
): ProjectDescription {
  if (!existing) return candidate;
  const developerByKey = new Map(existing.determinations
    .filter((entry) => entry.source.kind === "developer")
    .map((entry) => [entry.key, entry]));
  return canonicalizeProjectDescription({
    ...candidate,
    determinations: candidate.determinations.map((entry) => {
      const existingEntry = developerByKey.get(entry.key);
      if (!existingEntry) return entry;
      const existingComparable = { ...existingEntry, source: { kind: "developer" } };
      const candidateComparable = { ...entry, source: { kind: "developer" } };
      return semanticComparable(existingComparable) === semanticComparable(candidateComparable)
        ? { ...entry, source: { kind: "developer" as const } }
        : entry;
    }),
  });
}
