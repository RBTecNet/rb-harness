import { semanticKey } from "./identity.js";
import { questionProblem, type ProposedQuestion } from "./interview.js";
import type {
  Materiality,
  QualityCommandKind,
  Rigidity,
  SemanticDeterminationInput,
  SemanticPhaseInput,
  SemanticProtectedPathInput,
  SemanticQualityCommandInput,
  SemanticRequirementInput,
  ValidationIntentInput,
} from "./ir.js";
import type { JsonSchemaDocument } from "./providers/contract.js";
import { requestEvidenceIsVerified } from "./provenance.js";
import { projectRelativePathIsSafe, qualityCommandSafetyIssue, semanticSingleLineIsValid } from "./validate.js";

export const INIT_INTENT_WIRE_VERSION = "rb-init-intent/v1" as const;
export const INIT_WORK_WIRE_VERSION = "rb-init-work/v1" as const;

export interface WireFinding {
  readonly code: "wire-shape" | "semantic-invalid";
  readonly pointer: string;
  readonly message: string;
}

export type WireOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly findings: readonly WireFinding[] };

export interface IntentWire {
  readonly format: typeof INIT_INTENT_WIRE_VERSION;
  readonly project: { readonly name: string; readonly objective: string };
  readonly determinations: readonly SemanticDeterminationInput[];
  readonly requirements: readonly SemanticRequirementInput[];
  readonly qualityCommands: readonly SemanticQualityCommandInput[];
  readonly proposedProtectedPaths: readonly SemanticProtectedPathInput[];
  readonly questions: readonly ProposedQuestion[];
  readonly contradictions: readonly string[];
}

export interface WorkWire {
  readonly format: typeof INIT_WORK_WIRE_VERSION;
  readonly phases: readonly SemanticPhaseInput[];
}

// Keep provider-facing schemas within the structured-output subset already proven
// by conformance. Core below owns key grammar and non-empty semantic validation.
const semanticKeySchema = { type: "string" } as const;
const nonEmptyString = { type: "string" } as const;
const stringArray = { type: "array", items: nonEmptyString } as const;

export const INIT_INTENT_SCHEMA: JsonSchemaDocument = {
  type: "object",
  additionalProperties: false,
  required: ["format", "project", "determinations", "requirements", "qualityCommands", "proposedProtectedPaths", "questions", "contradictions"],
  properties: {
    format: { type: "string", enum: [INIT_INTENT_WIRE_VERSION] },
    project: {
      type: "object",
      additionalProperties: false,
      required: ["name", "objective"],
      properties: { name: nonEmptyString, objective: nonEmptyString },
    },
    determinations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "statement", "rationale", "materiality", "rigidity", "sourceKind"],
        properties: {
          key: semanticKeySchema,
          statement: nonEmptyString,
          rationale: nonEmptyString,
          materiality: { type: "string", enum: ["product", "architecture", "implementation", "preference"] },
          rigidity: { type: "string", enum: ["RIGID", "FLEXIBLE"] },
          sourceKind: { type: "string", enum: ["request", "model-default"] },
          evidence: { type: "string" },
        },
      },
    },
    requirements: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "statement"],
        properties: { key: semanticKeySchema, statement: nonEmptyString },
      },
    },
    qualityCommands: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "kind", "command"],
        properties: {
          key: semanticKeySchema,
          kind: { type: "string", enum: ["test", "build", "lint", "typecheck", "run"] },
          command: nonEmptyString,
        },
      },
    },
    proposedProtectedPaths: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "reason", "sourceKind"],
        properties: {
          path: nonEmptyString,
          reason: nonEmptyString,
          sourceKind: { type: "string", enum: ["request", "question"] },
          evidence: { type: "string" },
          questionKey: { type: "string" },
        },
      },
    },
    questions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "question", "materiality", "rigidity", "recommendedAnswer"],
        properties: {
          key: semanticKeySchema,
          question: nonEmptyString,
          materiality: { type: "string", enum: ["product", "architecture", "implementation", "preference"] },
          rigidity: { type: "string", enum: ["RIGID", "FLEXIBLE"] },
          recommendedAnswer: {
            type: "object",
            additionalProperties: false,
            required: ["value", "rationale"],
            properties: { value: nonEmptyString, rationale: nonEmptyString },
          },
          alternatives: stringArray,
        },
      },
    },
    contradictions: stringArray,
  },
};

function workSchema(requirementKeys: readonly string[], commandKeys: readonly string[]): JsonSchemaDocument {
  const keyArray = (values: readonly string[]) => ({ type: "array", items: { type: "string", enum: values } });
  return {
    type: "object",
    additionalProperties: false,
    required: ["format", "phases"],
    properties: {
      format: { type: "string", enum: [INIT_WORK_WIRE_VERSION] },
      phases: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["key", "title", "goal", "dependsOn", "tasks"],
          properties: {
            key: semanticKeySchema,
            title: nonEmptyString,
            goal: nonEmptyString,
            dependsOn: { type: "array", items: semanticKeySchema },
            tasks: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["key", "title", "intent", "dependsOn", "ownedPaths", "covers", "acceptance", "validation", "expectedEvidence"],
                properties: {
                  key: semanticKeySchema,
                  title: nonEmptyString,
                  intent: nonEmptyString,
                  dependsOn: { type: "array", items: semanticKeySchema },
                  ownedPaths: stringArray,
                  covers: keyArray(requirementKeys),
                  acceptance: stringArray,
                  validation: {
                    type: "array",
                    minItems: 1,
                    items: {
                      oneOf: [
                        {
                          type: "object",
                          additionalProperties: false,
                          required: ["kind", "value"],
                          properties: { kind: { type: "string", enum: ["command"] }, value: { type: "string", enum: commandKeys } },
                        },
                        {
                          type: "object",
                          additionalProperties: false,
                          required: ["kind", "value"],
                          properties: { kind: { type: "string", enum: ["manual"] }, value: nonEmptyString },
                        },
                        {
                          type: "object",
                          additionalProperties: false,
                          required: ["kind", "value"],
                          properties: { kind: { type: "string", enum: ["human"] }, value: nonEmptyString },
                        },
                      ],
                    },
                  },
                  expectedEvidence: nonEmptyString,
                },
              },
            },
          },
        },
      },
    },
  };
}

export function deriveWorkSchema(intent: Pick<IntentWire, "requirements" | "qualityCommands">): JsonSchemaDocument {
  return workSchema(intent.requirements.map((entry) => entry.key), intent.qualityCommands.map((entry) => entry.key));
}

function object(value: unknown, pointer: string, findings: WireFinding[]): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    findings.push({ code: "wire-shape", pointer, message: "expected object" });
    return undefined;
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], pointer: string, findings: WireFinding[]): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) findings.push({ code: "wire-shape", pointer, message: `unknown fields: ${unknown.join(", ")}` });
}

function text(value: unknown, pointer: string, findings: WireFinding[], allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) {
    findings.push({ code: "wire-shape", pointer, message: allowEmpty ? "expected string" : "expected non-empty string" });
    return "";
  }
  return value.trim();
}

function list(value: unknown, pointer: string, findings: WireFinding[]): readonly unknown[] {
  if (!Array.isArray(value)) {
    findings.push({ code: "wire-shape", pointer, message: "expected array" });
    return [];
  }
  return value;
}

function texts(value: unknown, pointer: string, findings: WireFinding[]): readonly string[] {
  return list(value, pointer, findings).map((entry, index) => text(entry, `${pointer}/${index}`, findings));
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], pointer: string, findings: WireFinding[]): T {
  if (typeof value === "string" && allowed.includes(value as T)) return value as T;
  findings.push({ code: "wire-shape", pointer, message: `expected one of ${allowed.join(", ")}` });
  return allowed[0]!;
}

function uniqueKeys(values: readonly { readonly key: string }[], pointer: string, findings: WireFinding[]): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (!semanticKey(value.key)) findings.push({ code: "semantic-invalid", pointer: `${pointer}/${index}/key`, message: `invalid semantic key ${value.key}` });
    if (seen.has(value.key)) findings.push({ code: "semantic-invalid", pointer: `${pointer}/${index}/key`, message: `duplicate semantic key ${value.key}` });
    seen.add(value.key);
  }
}

export function decodeIntentWire(payload: unknown, originalRequest: string): WireOutcome<IntentWire> {
  const findings: WireFinding[] = [];
  const root = object(payload, "", findings);
  if (!root) return { ok: false, findings };
  exactKeys(root, ["format", "project", "determinations", "requirements", "qualityCommands", "proposedProtectedPaths", "questions", "contradictions"], "", findings);
  if (root.format !== INIT_INTENT_WIRE_VERSION) findings.push({ code: "wire-shape", pointer: "/format", message: `expected ${INIT_INTENT_WIRE_VERSION}` });
  const projectValue = object(root.project, "/project", findings) ?? {};
  exactKeys(projectValue, ["name", "objective"], "/project", findings);
  const project = {
    name: text(projectValue.name, "/project/name", findings),
    objective: text(projectValue.objective, "/project/objective", findings),
  };
  if (!semanticSingleLineIsValid(project.name)) findings.push({ code: "semantic-invalid", pointer: "/project/name", message: "project name must be one non-empty line" });
  if (!semanticSingleLineIsValid(project.objective)) findings.push({ code: "semantic-invalid", pointer: "/project/objective", message: "project objective must be one non-empty line" });

  const determinations = list(root.determinations, "/determinations", findings).map((raw, index): SemanticDeterminationInput => {
    const value = object(raw, `/determinations/${index}`, findings) ?? {};
    exactKeys(value, ["key", "statement", "rationale", "materiality", "rigidity", "sourceKind", "evidence"], `/determinations/${index}`, findings);
    const sourceKind = oneOf(value.sourceKind, ["request", "model-default"] as const, `/determinations/${index}/sourceKind`, findings);
    const evidence = value.evidence === undefined
      ? ""
      : text(value.evidence, `/determinations/${index}/evidence`, findings, true);
    if (sourceKind === "request" && !requestEvidenceIsVerified(originalRequest, evidence)) {
      findings.push({ code: "semantic-invalid", pointer: `/determinations/${index}/evidence`, message: "request evidence is not verifiable in the original request" });
    }
    const materiality = oneOf(value.materiality, ["product", "architecture", "implementation", "preference"] as const, `/determinations/${index}/materiality`, findings) as Materiality;
    const rigidity = oneOf(value.rigidity, ["RIGID", "FLEXIBLE"] as const, `/determinations/${index}/rigidity`, findings) as Rigidity;
    if (sourceKind === "model-default" && rigidity === "RIGID" && (materiality === "product" || materiality === "architecture")) {
      findings.push({ code: "semantic-invalid", pointer: `/determinations/${index}/sourceKind`, message: "RIGID product/architecture decisions require a question instead of a silent model default" });
    }
    const result: SemanticDeterminationInput = {
      key: text(value.key, `/determinations/${index}/key`, findings),
      statement: text(value.statement, `/determinations/${index}/statement`, findings),
      rationale: text(value.rationale, `/determinations/${index}/rationale`, findings),
      materiality,
      rigidity,
      source: sourceKind === "request" ? { kind: "request", evidence } : { kind: "model-default" },
    };
    if (!semanticSingleLineIsValid(result.statement) || !semanticSingleLineIsValid(result.rationale)) {
      findings.push({ code: "semantic-invalid", pointer: `/determinations/${index}`, message: "determination statement and rationale must be single-line" });
    }
    return result;
  });

  const requirements = list(root.requirements, "/requirements", findings).map((raw, index): SemanticRequirementInput => {
    const value = object(raw, `/requirements/${index}`, findings) ?? {};
    exactKeys(value, ["key", "statement"], `/requirements/${index}`, findings);
    const result = { key: text(value.key, `/requirements/${index}/key`, findings), statement: text(value.statement, `/requirements/${index}/statement`, findings) };
    if (!semanticSingleLineIsValid(result.statement)) findings.push({ code: "semantic-invalid", pointer: `/requirements/${index}/statement`, message: "requirement must be single-line" });
    return result;
  });
  if (!requirements.length) findings.push({ code: "semantic-invalid", pointer: "/requirements", message: "at least one requirement is required" });

  const qualityCommands = list(root.qualityCommands, "/qualityCommands", findings).map((raw, index): SemanticQualityCommandInput => {
    const value = object(raw, `/qualityCommands/${index}`, findings) ?? {};
    exactKeys(value, ["key", "kind", "command"], `/qualityCommands/${index}`, findings);
    const result: SemanticQualityCommandInput = {
      key: text(value.key, `/qualityCommands/${index}/key`, findings),
      kind: oneOf(value.kind, ["test", "build", "lint", "typecheck", "run"] as const, `/qualityCommands/${index}/kind`, findings) as QualityCommandKind,
      command: text(value.command, `/qualityCommands/${index}/command`, findings),
    };
    const issue = qualityCommandSafetyIssue(result.command);
    if (issue) findings.push({ code: "semantic-invalid", pointer: `/qualityCommands/${index}/command`, message: `quality command ${issue}` });
    return result;
  });
  if (!qualityCommands.length) findings.push({ code: "semantic-invalid", pointer: "/qualityCommands", message: "at least one usable quality command is required" });

  const questions = list(root.questions, "/questions", findings).map((raw, index): ProposedQuestion => {
    const value = object(raw, `/questions/${index}`, findings) ?? {};
    exactKeys(value, ["key", "question", "materiality", "rigidity", "recommendedAnswer", "alternatives"], `/questions/${index}`, findings);
    const recommended = object(value.recommendedAnswer, `/questions/${index}/recommendedAnswer`, findings) ?? {};
    exactKeys(recommended, ["value", "rationale"], `/questions/${index}/recommendedAnswer`, findings);
    const question: ProposedQuestion = {
      key: text(value.key, `/questions/${index}/key`, findings),
      question: text(value.question, `/questions/${index}/question`, findings),
      materiality: oneOf(value.materiality, ["product", "architecture", "implementation", "preference"] as const, `/questions/${index}/materiality`, findings),
      rigidity: oneOf(value.rigidity, ["RIGID", "FLEXIBLE"] as const, `/questions/${index}/rigidity`, findings),
      recommendedAnswer: {
        value: text(recommended.value, `/questions/${index}/recommendedAnswer/value`, findings),
        rationale: text(recommended.rationale, `/questions/${index}/recommendedAnswer/rationale`, findings),
      },
      alternatives: value.alternatives === undefined ? [] : texts(value.alternatives, `/questions/${index}/alternatives`, findings),
    };
    const problem = questionProblem(question);
    if (problem) findings.push({ code: "semantic-invalid", pointer: `/questions/${index}`, message: problem });
    return question;
  });

  const questionKeys = new Set(questions.map((entry) => entry.key));
  const proposedProtectedPaths = list(root.proposedProtectedPaths, "/proposedProtectedPaths", findings).map((raw, index): SemanticProtectedPathInput => {
    const value = object(raw, `/proposedProtectedPaths/${index}`, findings) ?? {};
    exactKeys(value, ["path", "reason", "sourceKind", "evidence", "questionKey"], `/proposedProtectedPaths/${index}`, findings);
    const sourceKind = oneOf(value.sourceKind, ["request", "question"] as const, `/proposedProtectedPaths/${index}/sourceKind`, findings);
    const evidence = value.evidence === undefined
      ? ""
      : text(value.evidence, `/proposedProtectedPaths/${index}/evidence`, findings, true);
    const questionKey = value.questionKey === undefined
      ? ""
      : text(value.questionKey, `/proposedProtectedPaths/${index}/questionKey`, findings, true);
    if (sourceKind === "request" && !requestEvidenceIsVerified(originalRequest, evidence)) {
      findings.push({ code: "semantic-invalid", pointer: `/proposedProtectedPaths/${index}/evidence`, message: "protected-path request evidence is not verifiable" });
    }
    if (sourceKind === "question" && !questionKeys.has(questionKey)) {
      findings.push({ code: "semantic-invalid", pointer: `/proposedProtectedPaths/${index}/questionKey`, message: "protected-path question reference is unknown" });
    }
    const path = text(value.path, `/proposedProtectedPaths/${index}/path`, findings);
    const reason = text(value.reason, `/proposedProtectedPaths/${index}/reason`, findings);
    if (!projectRelativePathIsSafe(path)) findings.push({ code: "semantic-invalid", pointer: `/proposedProtectedPaths/${index}/path`, message: "protected path must be safe and project-relative" });
    if (!semanticSingleLineIsValid(reason)) findings.push({ code: "semantic-invalid", pointer: `/proposedProtectedPaths/${index}/reason`, message: "protected-path reason must be single-line" });
    return {
      path,
      reason,
      source: sourceKind === "request" ? { kind: "request", evidence } : { kind: "accepted-recommendation", questionKey },
    };
  });

  const contradictions = texts(root.contradictions, "/contradictions", findings);
  if (contradictions.length) findings.push({ code: "semantic-invalid", pointer: "/contradictions", message: `unresolved contradictions: ${contradictions.join("; ")}` });
  uniqueKeys(determinations, "/determinations", findings);
  uniqueKeys(requirements, "/requirements", findings);
  uniqueKeys(qualityCommands, "/qualityCommands", findings);
  uniqueKeys(questions, "/questions", findings);
  const authorityKeys = new Set(determinations.map((entry) => entry.key));
  for (const question of questions) if (authorityKeys.has(question.key)) findings.push({ code: "semantic-invalid", pointer: "/questions", message: `question key collides with determination key ${question.key}` });

  return findings.length ? { ok: false, findings } : {
    ok: true,
    value: {
      format: INIT_INTENT_WIRE_VERSION,
      project,
      determinations,
      requirements,
      qualityCommands,
      proposedProtectedPaths,
      questions,
      contradictions,
    },
  };
}

export function decodeWorkWire(
  payload: unknown,
  authority: Pick<IntentWire, "requirements" | "qualityCommands">,
): WireOutcome<WorkWire> {
  const findings: WireFinding[] = [];
  const root = object(payload, "", findings);
  if (!root) return { ok: false, findings };
  exactKeys(root, ["format", "phases"], "", findings);
  if (root.format !== INIT_WORK_WIRE_VERSION) findings.push({ code: "wire-shape", pointer: "/format", message: `expected ${INIT_WORK_WIRE_VERSION}` });
  const requirementKeys = new Set(authority.requirements.map((entry) => entry.key));
  const commandKeys = new Set(authority.qualityCommands.map((entry) => entry.key));

  const phases = list(root.phases, "/phases", findings).map((raw, phaseIndex): SemanticPhaseInput => {
    const phase = object(raw, `/phases/${phaseIndex}`, findings) ?? {};
    exactKeys(phase, ["key", "title", "goal", "dependsOn", "tasks"], `/phases/${phaseIndex}`, findings);
    const tasks = list(phase.tasks, `/phases/${phaseIndex}/tasks`, findings).map((rawTask, taskIndex) => {
      const pointer = `/phases/${phaseIndex}/tasks/${taskIndex}`;
      const task = object(rawTask, pointer, findings) ?? {};
      exactKeys(task, ["key", "title", "intent", "dependsOn", "ownedPaths", "covers", "acceptance", "validation", "expectedEvidence"], pointer, findings);
      const covers = texts(task.covers, `${pointer}/covers`, findings);
      for (const [index, key] of covers.entries()) if (!requirementKeys.has(key)) findings.push({ code: "semantic-invalid", pointer: `${pointer}/covers/${index}`, message: `unknown requirement key ${key}` });
      const validation = list(task.validation, `${pointer}/validation`, findings).map((rawValidation, validationIndex): ValidationIntentInput => {
        const value = object(rawValidation, `${pointer}/validation/${validationIndex}`, findings) ?? {};
        exactKeys(value, ["kind", "value"], `${pointer}/validation/${validationIndex}`, findings);
        const kind = oneOf(value.kind, ["command", "manual", "human"] as const, `${pointer}/validation/${validationIndex}/kind`, findings);
        const content = text(value.value, `${pointer}/validation/${validationIndex}/value`, findings);
        if (kind === "command") {
          if (!commandKeys.has(content)) findings.push({ code: "semantic-invalid", pointer: `${pointer}/validation/${validationIndex}/value`, message: `unknown quality-command key ${content}` });
          return { kind: "command", commandKey: content };
        }
        return kind === "manual" ? { kind: "manual", inspection: content } : { kind: "human", evidence: content };
      });
      return {
        key: text(task.key, `${pointer}/key`, findings),
        title: text(task.title, `${pointer}/title`, findings),
        intent: text(task.intent, `${pointer}/intent`, findings),
        dependsOn: texts(task.dependsOn, `${pointer}/dependsOn`, findings),
        ownedPaths: texts(task.ownedPaths, `${pointer}/ownedPaths`, findings),
        covers,
        acceptance: texts(task.acceptance, `${pointer}/acceptance`, findings),
        validation,
        expectedEvidence: text(task.expectedEvidence, `${pointer}/expectedEvidence`, findings),
      };
    });
    if (!tasks.length) findings.push({ code: "semantic-invalid", pointer: `/phases/${phaseIndex}/tasks`, message: "phase must contain at least one task" });
    uniqueKeys(tasks, `/phases/${phaseIndex}/tasks`, findings);
    return {
      key: text(phase.key, `/phases/${phaseIndex}/key`, findings),
      title: text(phase.title, `/phases/${phaseIndex}/title`, findings),
      goal: text(phase.goal, `/phases/${phaseIndex}/goal`, findings),
      dependsOn: texts(phase.dependsOn, `/phases/${phaseIndex}/dependsOn`, findings),
      tasks,
    };
  });
  if (!phases.length) findings.push({ code: "semantic-invalid", pointer: "/phases", message: "at least one phase is required" });
  uniqueKeys(phases, "/phases", findings);
  uniqueKeys(phases.flatMap((phase) => phase.tasks), "/phases/tasks", findings);
  const phaseKeys = new Set(phases.map((entry) => entry.key));
  const taskKeys = new Set(phases.flatMap((entry) => entry.tasks.map((task) => task.key)));
  for (const [phaseIndex, phase] of phases.entries()) {
    phase.dependsOn.forEach((key, index) => {
      if (!phaseKeys.has(key)) findings.push({ code: "semantic-invalid", pointer: `/phases/${phaseIndex}/dependsOn/${index}`, message: `unknown phase key ${key}` });
    });
    phase.tasks.forEach((task, taskIndex) => task.dependsOn.forEach((key, index) => {
      if (!taskKeys.has(key)) findings.push({ code: "semantic-invalid", pointer: `/phases/${phaseIndex}/tasks/${taskIndex}/dependsOn/${index}`, message: `unknown task key ${key}` });
    }));
  }
  return findings.length ? { ok: false, findings } : { ok: true, value: { format: INIT_WORK_WIRE_VERSION, phases } };
}
