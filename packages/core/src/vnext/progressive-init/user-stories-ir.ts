import { sha256Text } from "../../hash.js";
import { semanticKey, SEMANTIC_KEY_PATTERN, type SemanticKey } from "../identity.js";
import {
  questionProblem,
  verifyInterviewEvidence,
  type InterviewQuestionEvidence,
  type ProposedQuestion,
} from "../interview.js";
import type { Materiality, Rigidity } from "../ir.js";
import type { JsonSchemaDocument } from "../providers/contract.js";
import { semanticSingleLineIsValid } from "../validate.js";
import { progressiveCanonicalJson } from "./canonical-json.js";
import {
  validateProjectDescriptionCapabilityWorkflowConsistency,
  type ProjectDescription,
} from "./project-description-ir.js";

export const USER_STORIES_CONTRACT = "rb-user-stories/v1" as const;
export const USER_STORIES_QUESTIONS_CONTRACT = "rb-user-stories-questions/v1" as const;
export const USER_STORIES_UPSTREAM_CONTRACT = "rb-user-stories-upstream/v1" as const;

export type UserStoriesAuthority =
  | { readonly kind: "user-answer"; readonly questionKey: SemanticKey; readonly value: string }
  | {
      readonly kind: "accepted-recommendation";
      readonly questionKey: SemanticKey;
      readonly value: string;
      readonly acceptanceMode: "blank-interactive" | "non-interactive-policy";
    }
  | { readonly kind: "developer" };

export interface UserStoriesDetermination {
  readonly key: SemanticKey;
  readonly statement: string;
  readonly rationale: string;
  readonly materiality: Materiality;
  readonly rigidity: Rigidity;
  readonly source: UserStoriesAuthority;
}

export interface UserStoriesCapabilityParticipation {
  readonly kind: "capability-participation";
  readonly key: SemanticKey;
  readonly workflowKey: SemanticKey;
  readonly capabilityKey: SemanticKey;
  readonly actorKey: SemanticKey;
  readonly operatorActorKey: SemanticKey;
  readonly source: UserStoriesAuthority;
}

export interface UserStory {
  readonly key: SemanticKey;
  readonly storyId: string;
  readonly workflowKey: SemanticKey;
  readonly capabilityKeys: readonly SemanticKey[];
  readonly actorKey: SemanticKey;
  readonly operatorActorKey: SemanticKey;
  readonly intent: string;
  readonly outcome: string;
  readonly acceptance: readonly string[];
}

export interface UserStories {
  readonly contract: typeof USER_STORIES_CONTRACT;
  readonly stage: "user-stories";
  readonly projectKey: SemanticKey;
  readonly determinations: readonly UserStoriesDetermination[];
  readonly structuralDecisions: readonly UserStoriesCapabilityParticipation[];
  readonly stories: readonly UserStory[];
}

export interface UserStoriesUpstreamProjection {
  readonly contract: typeof USER_STORIES_UPSTREAM_CONTRACT;
  readonly project: { readonly key: SemanticKey; readonly name: string; readonly objective: string };
  readonly actors: readonly { readonly key: SemanticKey; readonly name: string; readonly responsibility: string }[];
  readonly capabilities: readonly { readonly key: SemanticKey; readonly statement: string }[];
  readonly workflows: readonly {
    readonly key: SemanticKey;
    readonly statement: string;
    readonly actorKeys: readonly SemanticKey[];
    readonly capabilityKeys: readonly SemanticKey[];
  }[];
  readonly constraints: readonly { readonly key: SemanticKey; readonly statement: string }[];
  readonly determinations: readonly {
    readonly key: SemanticKey;
    readonly statement: string;
    readonly rationale: string;
    readonly materiality: "product" | "architecture";
    readonly rigidity: Rigidity;
  }[];
}

export interface UserStoriesWire {
  readonly contract: typeof USER_STORIES_CONTRACT;
  readonly stage: "user-stories";
  readonly projectKey: string;
  readonly stories: readonly {
    readonly key: string;
    readonly workflowKey: string;
    readonly capabilityKeys: readonly string[];
    readonly actorKey: string;
    readonly operatorActorKey: string;
    readonly intent: string;
    readonly outcome: string;
    readonly acceptance: readonly string[];
  }[];
}

export interface UserStoriesCapabilityParticipationPairOption {
  readonly kind: "pair";
  readonly key: SemanticKey;
  readonly label: string;
  readonly actorKey: SemanticKey;
  readonly operatorActorKey: SemanticKey;
}

export interface UserStoriesCapabilityParticipationEscapeOption {
  readonly kind: "escape";
  readonly key: SemanticKey;
  readonly label: string;
}

export type UserStoriesCapabilityParticipationStepOneOption =
  | UserStoriesCapabilityParticipationPairOption
  | UserStoriesCapabilityParticipationEscapeOption;

export interface UserStoriesCapabilityParticipationSubject {
  readonly key: SemanticKey;
  readonly workflowKey: SemanticKey;
  readonly capabilityKey: SemanticKey;
  readonly stepOneOptions: readonly UserStoriesCapabilityParticipationStepOneOption[];
  readonly pairOptions: readonly UserStoriesCapabilityParticipationPairOption[];
}

export interface UserStoriesCapabilityParticipationRecommendation {
  readonly subjectKey: string;
  readonly recommendedOptionKey: string;
  readonly question: string;
  readonly rationale: string;
}

export interface UserStoriesCapabilityParticipationQuestion {
  readonly kind: "capability-participation";
  readonly key: string;
  readonly question: string;
  readonly materiality: Materiality;
  readonly rigidity: Rigidity;
  readonly workflowKey: string;
  readonly capabilityKey: string;
  readonly recommendedOptionKey: string;
  readonly rationale: string;
  readonly stepOneOptions: readonly UserStoriesCapabilityParticipationStepOneOption[];
  readonly pairOptions: readonly UserStoriesCapabilityParticipationPairOption[];
}

export type UserStoriesQuestion = ProposedQuestion | UserStoriesCapabilityParticipationQuestion;

export interface UserStoriesQuestionSelection {
  readonly contract: typeof USER_STORIES_QUESTIONS_CONTRACT;
  readonly stage: "user-stories";
  readonly questions: readonly UserStoriesQuestion[];
}

export interface UserStoriesFinding {
  readonly code: "shape" | "semantic" | "authority" | "coverage" | "preservation" | "upstream";
  readonly pointer: string;
  readonly message: string;
}

export type UserStoriesOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly findings: readonly UserStoriesFinding[] };

const keySchema = { type: "string", pattern: SEMANTIC_KEY_PATTERN } as const;
const textSchema = { type: "string", minLength: 1 } as const;
const materialitySchema = { type: "string", enum: ["product", "architecture", "implementation", "preference"] } as const;
const rigiditySchema = { type: "string", enum: ["RIGID", "FLEXIBLE"] } as const;
const questionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["key", "question", "materiality", "rigidity", "recommendedAnswer", "alternatives"],
  properties: {
    key: keySchema,
    question: textSchema,
    materiality: materialitySchema,
    rigidity: rigiditySchema,
    recommendedAnswer: {
      type: "object",
      additionalProperties: false,
      required: ["value", "rationale"],
      properties: { value: textSchema, rationale: textSchema },
    },
    alternatives: { type: "array", items: textSchema },
  },
} as const;

const capabilityParticipationRecommendationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["subjectKey", "recommendedOptionKey", "question", "rationale"],
  properties: {
    subjectKey: keySchema,
    recommendedOptionKey: keySchema,
    question: textSchema,
    rationale: textSchema,
  },
} as const;

export const USER_STORIES_QUESTIONS_SCHEMA: JsonSchemaDocument = {
  type: "object",
  additionalProperties: false,
  required: ["contract", "stage", "participationRecommendations", "questions"],
  properties: {
    contract: { type: "string", enum: [USER_STORIES_QUESTIONS_CONTRACT] },
    stage: { type: "string", enum: ["user-stories"] },
    participationRecommendations: { type: "array", items: capabilityParticipationRecommendationSchema },
    questions: { type: "array", items: questionSchema },
  },
};

export const USER_STORIES_SCHEMA: JsonSchemaDocument = {
  type: "object",
  additionalProperties: false,
  required: ["contract", "stage", "projectKey", "stories"],
  properties: {
    contract: { type: "string", enum: [USER_STORIES_CONTRACT] },
    stage: { type: "string", enum: ["user-stories"] },
    projectKey: keySchema,
    stories: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "workflowKey", "capabilityKeys", "actorKey", "operatorActorKey", "intent", "outcome", "acceptance"],
        properties: {
          key: keySchema,
          workflowKey: keySchema,
          capabilityKeys: { type: "array", minItems: 1, items: keySchema },
          actorKey: keySchema,
          operatorActorKey: keySchema,
          intent: textSchema,
          outcome: textSchema,
          acceptance: { type: "array", minItems: 1, items: textSchema },
        },
      },
    },
  },
};

const STORY_ID = /^US-([1-9]\d*)\.([1-9]\d*)$/;

function clean(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ");
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortByKey<T extends { readonly key: string }>(values: readonly T[]): readonly T[] {
  return [...values].sort((left, right) => compare(left.key, right.key));
}

function canonicalAuthority(source: UserStoriesAuthority): UserStoriesAuthority {
  if (source.kind === "user-answer" || source.kind === "accepted-recommendation") {
    return { ...source, value: clean(source.value) };
  }
  return source;
}

export function parseStoryId(value: string): { readonly workflowGroup: number; readonly storyNumber: number } | undefined {
  const match = STORY_ID.exec(value);
  if (!match) return undefined;
  const workflowGroup = Number(match[1]);
  const storyNumber = Number(match[2]);
  return Number.isSafeInteger(workflowGroup) && Number.isSafeInteger(storyNumber)
    ? { workflowGroup, storyNumber }
    : undefined;
}

export function canonicalizeUserStories(value: UserStories): UserStories {
  return {
    contract: USER_STORIES_CONTRACT,
    stage: "user-stories",
    projectKey: value.projectKey,
    determinations: sortByKey(value.determinations).map((entry) => ({
      ...entry,
      statement: clean(entry.statement),
      rationale: clean(entry.rationale),
      source: canonicalAuthority(entry.source),
    })),
    structuralDecisions: sortByKey(value.structuralDecisions).map((entry) => ({
      ...entry,
      source: canonicalAuthority(entry.source),
    })),
    stories: [...value.stories].map((entry) => ({
      ...entry,
      capabilityKeys: [...entry.capabilityKeys].sort(compare),
      intent: clean(entry.intent),
      outcome: clean(entry.outcome),
      acceptance: entry.acceptance.map(clean),
    })).sort((left, right) => {
      const leftId = parseStoryId(left.storyId);
      const rightId = parseStoryId(right.storyId);
      if (leftId && rightId) {
        return leftId.workflowGroup - rightId.workflowGroup
          || leftId.storyNumber - rightId.storyNumber
          || compare(left.key, right.key);
      }
      return compare(left.storyId, right.storyId) || compare(left.key, right.key);
    }),
  };
}

export function userStoriesForPersistence(value: UserStories): UserStories {
  return canonicalizeUserStories({
    ...value,
    determinations: value.determinations.map((entry) => ({ ...entry, source: { kind: "developer" as const } })),
    structuralDecisions: value.structuralDecisions.map((entry) => ({ ...entry, source: { kind: "developer" as const } })),
  });
}

export function userStoriesUpstreamProjection(project: ProjectDescription): UserStoriesUpstreamProjection {
  return {
    contract: USER_STORIES_UPSTREAM_CONTRACT,
    project: { ...project.project },
    actors: sortByKey(project.actors).map((entry) => ({ ...entry })),
    capabilities: sortByKey(project.capabilities).map((entry) => ({ ...entry })),
    workflows: sortByKey(project.workflows).map((entry) => ({
      ...entry,
      actorKeys: [...entry.actorKeys].sort(compare),
      capabilityKeys: [...entry.capabilityKeys].sort(compare),
    })),
    constraints: sortByKey(project.constraints).map((entry) => ({ ...entry })),
    determinations: sortByKey(project.determinations
      .filter((entry): entry is typeof entry & { readonly materiality: "product" | "architecture" } =>
        entry.materiality === "product" || entry.materiality === "architecture"))
      .map(({ key, statement, rationale, materiality, rigidity }) => ({ key, statement, rationale, materiality, rigidity })),
  };
}

export function userStoriesUpstreamProjectionSha256(projection: UserStoriesUpstreamProjection): string {
  return sha256Text(progressiveCanonicalJson(projection));
}

export function validateUserStoriesUpstreamReadiness(
  projection: UserStoriesUpstreamProjection,
): readonly UserStoriesFinding[] {
  return validateProjectDescriptionCapabilityWorkflowConsistency(projection)
    .map(({ pointer, message }) => ({ code: "upstream" as const, pointer, message }));
}

const PARTICIPATION_ESCAPE_KEY = semanticKey("another-participant-combination")!;

function participationSubjectKey(workflowKey: SemanticKey, capabilityKey: SemanticKey): SemanticKey {
  return semanticKey(`participation-${sha256Text(`${workflowKey}\u0000${capabilityKey}`).slice(0, 34)}`)!;
}

function participationPairKey(actorKey: SemanticKey, operatorActorKey: SemanticKey): SemanticKey {
  return semanticKey(`pair-${sha256Text(`${actorKey}\u0000${operatorActorKey}`).slice(0, 43)}`)!;
}

function participationPairLabel(
  actor: UserStoriesUpstreamProjection["actors"][number],
  operator: UserStoriesUpstreamProjection["actors"][number],
): string {
  return `${actor.name} (${actor.key}) / ${operator.name} (${operator.key})`;
}

/** Core-owned enumeration. Provider output cannot add, merge, or omit these upstream subjects. */
export function enumerateUserStoriesParticipationSubjects(
  upstream: UserStoriesUpstreamProjection,
): readonly UserStoriesCapabilityParticipationSubject[] {
  const actors = [...upstream.actors].sort((left, right) => compare(left.key, right.key));
  const actorByKey = new Map(actors.map((actor) => [actor.key, actor]));
  const subjects = [...upstream.workflows]
    .sort((left, right) => compare(left.key, right.key))
    .flatMap((workflow) => [...workflow.capabilityKeys]
      .sort(compare)
      .map((capabilityKey): UserStoriesCapabilityParticipationSubject => {
        const workflowActors = [...workflow.actorKeys].sort(compare);
        const eligible = new Set(workflowActors);
        const pairOptions = actors.flatMap((actor) => actors.map((operator): UserStoriesCapabilityParticipationPairOption => ({
          kind: "pair",
          key: participationPairKey(actor.key, operator.key),
          label: participationPairLabel(actor, operator),
          actorKey: actor.key,
          operatorActorKey: operator.key,
        }))).sort((left, right) => {
          const leftClass = left.actorKey === left.operatorActorKey
            ? 0
            : eligible.has(left.actorKey) && eligible.has(left.operatorActorKey) ? 1 : 2;
          const rightClass = right.actorKey === right.operatorActorKey
            ? 0
            : eligible.has(right.actorKey) && eligible.has(right.operatorActorKey) ? 1 : 2;
          return leftClass - rightClass
            || compare(left.actorKey, right.actorKey)
            || compare(left.operatorActorKey, right.operatorActorKey);
        });
        const stepOneOptions: UserStoriesCapabilityParticipationStepOneOption[] = workflowActors.map((actorKey) => {
          const actor = actorByKey.get(actorKey);
          if (!actor) {
            throw new Error(`USER_STORIES_PARTICIPATION_ENUMERATION_INVALID: workflow '${workflow.key}' references unknown actor '${actorKey}'`);
          }
          return {
            kind: "pair",
            key: participationPairKey(actorKey, actorKey),
            label: participationPairLabel(actor, actor),
            actorKey,
            operatorActorKey: actorKey,
          };
        });
        stepOneOptions.push({
          kind: "escape",
          key: PARTICIPATION_ESCAPE_KEY,
          label: "Another actor/operator combination",
        });
        return {
          key: participationSubjectKey(workflow.key, capabilityKey),
          workflowKey: workflow.key,
          capabilityKey,
          stepOneOptions,
          pairOptions,
        };
      }));
  const subjectKeys = new Set<string>();
  const bindings = new Set<string>();
  for (const subject of subjects) {
    const binding = `${subject.workflowKey}\u0000${subject.capabilityKey}`;
    if (subjectKeys.has(subject.key) || bindings.has(binding)) {
      throw new Error(`USER_STORIES_PARTICIPATION_ENUMERATION_INVALID: duplicate subject '${subject.workflowKey}/${subject.capabilityKey}'`);
    }
    subjectKeys.add(subject.key);
    bindings.add(binding);
    const optionKeys = new Set(subject.pairOptions.map((option) => option.key));
    const optionPairs = new Set(subject.pairOptions.map((option) => `${option.actorKey}\u0000${option.operatorActorKey}`));
    if (!subject.pairOptions.length || optionKeys.size !== subject.pairOptions.length || optionPairs.size !== subject.pairOptions.length) {
      throw new Error(`USER_STORIES_PARTICIPATION_ENUMERATION_INVALID: pair options for '${subject.workflowKey}/${subject.capabilityKey}' are empty or non-unique`);
    }
  }
  return subjects;
}

function persistedParticipationIsValid(
  subject: UserStoriesCapabilityParticipationSubject,
  upstream: UserStoriesUpstreamProjection,
  existing: UserStories | undefined,
): boolean {
  if (!existing) return false;
  const matching = existing.structuralDecisions.filter((decision) =>
    decision.workflowKey === subject.workflowKey && decision.capabilityKey === subject.capabilityKey);
  if (matching.length !== 1 || matching[0]!.source.kind !== "developer") return false;
  const decision = matching[0]!;
  const determination = existing.determinations.find((entry) => entry.key === decision.key);
  const globalActors = new Set(upstream.actors.map((actor) => actor.key));
  const workflow = upstream.workflows.find((entry) => entry.key === subject.workflowKey)!;
  return determination?.source.kind === "developer"
    && globalActors.has(decision.actorKey)
    && globalActors.has(decision.operatorActorKey)
    && workflow.actorKeys.includes(decision.actorKey)
    && workflow.actorKeys.includes(decision.operatorActorKey);
}

/** Multiple-actor subjects require authority; valid persisted bindings are subtracted exactly by workflow+capability. */
export function requiredUserStoriesParticipationSubjects(
  upstream: UserStoriesUpstreamProjection,
  existing?: UserStories,
): readonly UserStoriesCapabilityParticipationSubject[] {
  const workflowByKey = new Map(upstream.workflows.map((workflow) => [workflow.key, workflow]));
  return enumerateUserStoriesParticipationSubjects(upstream).filter((subject) => {
    const workflow = workflowByKey.get(subject.workflowKey)!;
    return workflow.actorKeys.length > 1 && !persistedParticipationIsValid(subject, upstream, existing);
  });
}

function add(
  findings: UserStoriesFinding[],
  code: UserStoriesFinding["code"],
  pointer: string,
  message: string,
): void {
  findings.push({ code, pointer, message });
}

function authorityIsValid(
  determination: UserStoriesDetermination,
  interviewDecisions: ReadonlyMap<string, ReturnType<typeof verifyInterviewEvidence>>,
): boolean {
  const source = determination.source;
  if (source.kind === "developer") return true;
  const verified = interviewDecisions.get(source.questionKey);
  if (!verified || verified.selectedValue.trim() !== determination.statement.trim() || source.value.trim() !== verified.selectedValue.trim()) return false;
  return source.kind === "user-answer"
    ? verified.source.kind === "user-answer"
    : verified.source.kind === "accepted-recommendation" && verified.acceptanceMode === source.acceptanceMode;
}

export function validateUserStories(
  input: UserStories,
  upstream: UserStoriesUpstreamProjection,
  interviewEvidence: readonly InterviewQuestionEvidence[] = [],
  options: { readonly requireWorkflowCoverage?: boolean } = {},
): UserStoriesOutcome<UserStories> {
  const value = canonicalizeUserStories(input);
  const findings: UserStoriesFinding[] = [];
  const decisions = new Map(interviewEvidence.map((entry) => [entry.key, verifyInterviewEvidence(entry)]));
  if (value.contract !== USER_STORIES_CONTRACT || value.stage !== "user-stories") add(findings, "shape", "/contract", "unsupported user-stories contract");
  if (value.projectKey !== upstream.project.key) add(findings, "upstream", "/projectKey", "project key does not match the fresh project-description");
  if (!value.stories.length) add(findings, "semantic", "/stories", "at least one user story is required");

  const globalKeys = new Set<string>();
  for (const [kind, entries] of [["determinations", value.determinations], ["stories", value.stories]] as const) {
    entries.forEach((entry, index) => {
      if (!semanticKey(entry.key)) add(findings, "semantic", `/${kind}/${index}/key`, `invalid SemanticKey '${entry.key}'`);
      if (globalKeys.has(entry.key)) add(findings, "semantic", `/${kind}/${index}/key`, `duplicate stage SemanticKey '${entry.key}'`);
      globalKeys.add(entry.key);
    });
  }

  value.determinations.forEach((entry, index) => {
    if (!semanticSingleLineIsValid(entry.statement)) add(findings, "semantic", `/determinations/${index}/statement`, "field must be non-empty and single-line");
    if (!semanticSingleLineIsValid(entry.rationale)) add(findings, "semantic", `/determinations/${index}/rationale`, "field must be non-empty and single-line");
    if (!authorityIsValid(entry, decisions)) add(findings, "authority", `/determinations/${index}/source`, "determination authority is not verifiable");
  });

  const workflows = new Map(upstream.workflows.map((entry) => [entry.key, entry]));
  const actors = new Set(upstream.actors.map((entry) => entry.key));
  const capabilities = new Set(upstream.capabilities.map((entry) => entry.key));
  const determinations = new Map(value.determinations.map((entry) => [entry.key, entry]));
  const structuralByBinding = new Map<string, UserStoriesCapabilityParticipation>();
  const structuralKeys = new Set<string>();
  value.structuralDecisions.forEach((decision, index) => {
    const pointer = `/structuralDecisions/${index}`;
    if (!semanticKey(decision.key)) add(findings, "semantic", `${pointer}/key`, `invalid SemanticKey '${decision.key}'`);
    if (structuralKeys.has(decision.key)) add(findings, "semantic", `${pointer}/key`, `duplicate structural decision key '${decision.key}'`);
    structuralKeys.add(decision.key);
    const matchingDetermination = determinations.get(decision.key);
    if (!matchingDetermination) {
      add(findings, "authority", `${pointer}/key`, `structural decision '${decision.key}' requires one matching determination key`);
    } else if (progressiveCanonicalJson(matchingDetermination.source) !== progressiveCanonicalJson(decision.source)) {
      add(findings, "authority", `${pointer}/source`, `structural decision '${decision.key}' must share the matching determination authority`);
    }
    const binding = `${decision.workflowKey}\u0000${decision.capabilityKey}`;
    if (structuralByBinding.has(binding)) {
      add(findings, "semantic", pointer, `duplicate capability-participation decision for workflow '${decision.workflowKey}' capability '${decision.capabilityKey}'`);
    } else {
      structuralByBinding.set(binding, decision);
    }
    const workflow = workflows.get(decision.workflowKey);
    if (!workflow) add(findings, "upstream", `${pointer}/workflowKey`, `unknown workflow key '${decision.workflowKey}'`);
    if (!capabilities.has(decision.capabilityKey)) add(findings, "upstream", `${pointer}/capabilityKey`, `unknown capability key '${decision.capabilityKey}'`);
    if (workflow && !workflow.capabilityKeys.includes(decision.capabilityKey)) {
      add(findings, "upstream", `${pointer}/capabilityKey`, `capability '${decision.capabilityKey}' no longer belongs to workflow '${decision.workflowKey}'`);
    }
    if (!actors.has(decision.actorKey)) add(findings, "upstream", `${pointer}/actorKey`, `unknown actor key '${decision.actorKey}'`);
    if (!actors.has(decision.operatorActorKey)) add(findings, "upstream", `${pointer}/operatorActorKey`, `unknown operator actor key '${decision.operatorActorKey}'`);
    if (workflow && !workflow.actorKeys.includes(decision.actorKey)) {
      add(findings, "upstream", `${pointer}/actorKey`, `structural actor '${decision.actorKey}' is not eligible for workflow '${decision.workflowKey}'`);
    }
    if (workflow && !workflow.actorKeys.includes(decision.operatorActorKey)) {
      add(findings, "upstream", `${pointer}/operatorActorKey`, `structural operator '${decision.operatorActorKey}' is not eligible for workflow '${decision.workflowKey}'`);
    }
  });

  const coveredWorkflows = new Set<SemanticKey>();
  const coveredCapabilities = new Set<SemanticKey>();
  const ids = new Set<string>();
  const workflowGroups = new Map<SemanticKey, number>();
  const groupWorkflows = new Map<number, SemanticKey>();
  value.stories.forEach((story, index) => {
    const pointer = `/stories/${index}`;
    const id = parseStoryId(story.storyId);
    if (!id) add(findings, "semantic", `${pointer}/storyId`, `invalid stable story ID '${story.storyId}'`);
    if (ids.has(story.storyId)) add(findings, "semantic", `${pointer}/storyId`, `duplicate stable story ID '${story.storyId}'`);
    ids.add(story.storyId);
    const workflow = workflows.get(story.workflowKey);
    if (!workflow) add(findings, "coverage", `${pointer}/workflowKey`, `unknown workflow key '${story.workflowKey}'`);
    else {
      coveredWorkflows.add(story.workflowKey);
      if (!workflow.actorKeys.includes(story.actorKey)) {
        add(findings, "coverage", `${pointer}/actorKey`, `actor '${story.actorKey}' is not eligible for workflow '${story.workflowKey}'`);
      }
      if (!workflow.actorKeys.includes(story.operatorActorKey)) {
        add(findings, "coverage", `${pointer}/operatorActorKey`, `operator '${story.operatorActorKey}' is not eligible for workflow '${story.workflowKey}'`);
      }
    }
    if (!actors.has(story.actorKey)) add(findings, "coverage", `${pointer}/actorKey`, `unknown actor key '${story.actorKey}'`);
    if (!actors.has(story.operatorActorKey)) add(findings, "coverage", `${pointer}/operatorActorKey`, `unknown operator actor key '${story.operatorActorKey}'`);
    if (!story.capabilityKeys.length) add(findings, "semantic", `${pointer}/capabilityKeys`, "at least one explicit capability key is required");
    const storyCapabilities = new Set<SemanticKey>();
    const boundPairs = new Map<string, UserStoriesCapabilityParticipation>();
    let hasUnboundCapability = false;
    story.capabilityKeys.forEach((capabilityKey, capabilityIndex) => {
      const capabilityPointer = `${pointer}/capabilityKeys/${capabilityIndex}`;
      if (storyCapabilities.has(capabilityKey)) add(findings, "semantic", capabilityPointer, `duplicate capability key '${capabilityKey}'`);
      storyCapabilities.add(capabilityKey);
      if (!capabilities.has(capabilityKey)) add(findings, "coverage", capabilityPointer, `unknown capability key '${capabilityKey}'`);
      if (workflow && !workflow.capabilityKeys.includes(capabilityKey)) {
        add(findings, "coverage", capabilityPointer, `capability '${capabilityKey}' does not belong to workflow '${story.workflowKey}'`);
      }
      if (capabilities.has(capabilityKey)) coveredCapabilities.add(capabilityKey);
      const participation = structuralByBinding.get(`${story.workflowKey}\u0000${capabilityKey}`);
      if (participation) {
        boundPairs.set(`${participation.actorKey}\u0000${participation.operatorActorKey}`, participation);
        if (story.actorKey !== participation.actorKey || story.operatorActorKey !== participation.operatorActorKey) {
          add(
            findings,
            "authority",
            capabilityPointer,
            `capability '${capabilityKey}' requires Actor '${participation.actorKey}' and Operator '${participation.operatorActorKey}' from structural decision '${participation.key}'`,
          );
        }
      } else {
        hasUnboundCapability = true;
        if (story.actorKey !== story.operatorActorKey) {
          add(findings, "authority", capabilityPointer, `capability '${capabilityKey}' has no capability-participation decision; Actor and Operator must be equal`);
        }
      }
    });
    if (boundPairs.size > 1 || (hasUnboundCapability && [...boundPairs.values()].some((entry) => entry.actorKey !== entry.operatorActorKey))) {
      add(findings, "authority", `${pointer}/capabilityKeys`, "claimed capabilities require incompatible participation pairs; split the story");
    }
    if (!semanticSingleLineIsValid(story.intent)) add(findings, "semantic", `${pointer}/intent`, "intent must be non-empty and single-line");
    if (!semanticSingleLineIsValid(story.outcome)) add(findings, "semantic", `${pointer}/outcome`, "outcome must be non-empty and single-line");
    if (!story.acceptance.length) add(findings, "semantic", `${pointer}/acceptance`, "at least one observable story acceptance outcome is required");
    story.acceptance.forEach((entry, acceptanceIndex) => {
      if (!semanticSingleLineIsValid(entry)) add(findings, "semantic", `${pointer}/acceptance/${acceptanceIndex}`, "acceptance must be non-empty and single-line");
    });
    if (id) {
      const previousGroup = workflowGroups.get(story.workflowKey);
      const previousWorkflow = groupWorkflows.get(id.workflowGroup);
      if (previousGroup !== undefined && previousGroup !== id.workflowGroup) {
        add(findings, "semantic", `${pointer}/storyId`, `workflow '${story.workflowKey}' maps to more than one story group`);
      }
      if (previousWorkflow !== undefined && previousWorkflow !== story.workflowKey) {
        add(findings, "semantic", `${pointer}/storyId`, `story group ${id.workflowGroup} maps to more than one workflow`);
      }
      workflowGroups.set(story.workflowKey, id.workflowGroup);
      groupWorkflows.set(id.workflowGroup, story.workflowKey);
    }
  });
  if (options.requireWorkflowCoverage !== false) {
    upstream.workflows.forEach((workflow, index) => {
      if (!coveredWorkflows.has(workflow.key)) add(findings, "coverage", `/upstream/workflows/${index}`, `workflow '${workflow.key}' is not covered by any user story`);
    });
    upstream.capabilities.forEach((capability, index) => {
      if (!coveredCapabilities.has(capability.key)) add(findings, "coverage", `/upstream/capabilities/${index}`, `capability '${capability.key}' is not explicitly covered by any user story`);
    });
  }
  return findings.length ? { ok: false, findings } : { ok: true, value };
}

export function userStoriesSemanticSha256(value: UserStories): string {
  return sha256Text(progressiveCanonicalJson(canonicalizeUserStories(value)));
}

export function userStoriesAcceptedDecisionProjection(value: UserStories): readonly unknown[] {
  const canonical = canonicalizeUserStories(value);
  return [
    ...canonical.determinations.map(({ key, statement, rationale, materiality, rigidity }) => ({
      kind: "determination",
      key, statement, rationale, materiality, rigidity,
    })),
    ...canonical.structuralDecisions.map(({ key, workflowKey, capabilityKey, actorKey, operatorActorKey }) => ({
      kind: "capability-participation",
      key, workflowKey, capabilityKey, actorKey, operatorActorKey,
    })),
  ];
}

export function userStoriesAuthoritativeInputSha256(input: {
  readonly upstreamProjectionSha256: string;
  readonly acceptedDecisions: readonly unknown[];
  readonly contractVersion?: string;
}): string {
  return sha256Text(progressiveCanonicalJson({
    stage: "user-stories",
    contract: input.contractVersion ?? USER_STORIES_CONTRACT,
    upstreamProjectionSha256: input.upstreamProjectionSha256,
    acceptedDecisions: input.acceptedDecisions,
  }));
}

function record(value: unknown, pointer: string, findings: UserStoriesFinding[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    add(findings, "shape", pointer, "expected object");
    return {};
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, fields: readonly string[], pointer: string, findings: UserStoriesFinding[]): void {
  const allowed = new Set(fields);
  Object.keys(value).forEach((key) => { if (!allowed.has(key)) add(findings, "shape", `${pointer}/${key}`, "unknown field"); });
  fields.forEach((key) => { if (!(key in value)) add(findings, "shape", `${pointer}/${key}`, "required field is missing"); });
}

function text(value: unknown, pointer: string, findings: UserStoriesFinding[]): string {
  if (typeof value !== "string") { add(findings, "shape", pointer, "expected string"); return ""; }
  return value;
}

function array(value: unknown, pointer: string, findings: UserStoriesFinding[]): readonly unknown[] {
  if (!Array.isArray(value)) { add(findings, "shape", pointer, "expected array"); return []; }
  return value;
}

function enumeration<T extends string>(value: unknown, allowed: readonly T[], pointer: string, findings: UserStoriesFinding[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    add(findings, "shape", pointer, `expected one of ${allowed.join(", ")}`);
    return allowed[0]!;
  }
  return value as T;
}

function decodeQuestion(value: unknown, index: number, findings: UserStoriesFinding[]): ProposedQuestion {
  const pointer = `/questions/${index}`;
  const item = record(value, pointer, findings);
  exact(item, ["key", "question", "materiality", "rigidity", "recommendedAnswer", "alternatives"], pointer, findings);
  const recommended = record(item.recommendedAnswer, `${pointer}/recommendedAnswer`, findings);
  exact(recommended, ["value", "rationale"], `${pointer}/recommendedAnswer`, findings);
  const question: ProposedQuestion = {
    key: text(item.key, `${pointer}/key`, findings),
    question: text(item.question, `${pointer}/question`, findings),
    materiality: enumeration(item.materiality, ["product", "architecture", "implementation", "preference"] as const, `${pointer}/materiality`, findings),
    rigidity: enumeration(item.rigidity, ["RIGID", "FLEXIBLE"] as const, `${pointer}/rigidity`, findings),
    recommendedAnswer: {
      value: text(recommended.value, `${pointer}/recommendedAnswer/value`, findings),
      rationale: text(recommended.rationale, `${pointer}/recommendedAnswer/rationale`, findings),
    },
    alternatives: array(item.alternatives, `${pointer}/alternatives`, findings).map((entry, alternative) => text(entry, `${pointer}/alternatives/${alternative}`, findings)),
  };
  const problem = questionProblem(question);
  if (problem) add(findings, "semantic", pointer, problem);
  return question;
}

export function isCapabilityParticipationQuestion(
  question: UserStoriesQuestion,
): question is UserStoriesCapabilityParticipationQuestion {
  return "kind" in question && question.kind === "capability-participation";
}

function decodeCapabilityParticipationRecommendation(
  value: unknown,
  index: number,
  findings: UserStoriesFinding[],
): UserStoriesCapabilityParticipationRecommendation {
  const pointer = `/participationRecommendations/${index}`;
  const item = record(value, pointer, findings);
  exact(item, ["subjectKey", "recommendedOptionKey", "question", "rationale"], pointer, findings);
  return {
    subjectKey: text(item.subjectKey, `${pointer}/subjectKey`, findings),
    recommendedOptionKey: text(item.recommendedOptionKey, `${pointer}/recommendedOptionKey`, findings),
    question: text(item.question, `${pointer}/question`, findings),
    rationale: text(item.rationale, `${pointer}/rationale`, findings),
  };
}

export function decodeUserStoriesQuestionSelection(
  payload: unknown,
  requiredSubjects: readonly UserStoriesCapabilityParticipationSubject[],
): UserStoriesOutcome<UserStoriesQuestionSelection> {
  const findings: UserStoriesFinding[] = [];
  const root = record(payload, "/", findings);
  exact(root, ["contract", "stage", "participationRecommendations", "questions"], "/", findings);
  if (root.contract !== USER_STORIES_QUESTIONS_CONTRACT) add(findings, "shape", "/contract", `expected ${USER_STORIES_QUESTIONS_CONTRACT}`);
  if (root.stage !== "user-stories") add(findings, "shape", "/stage", "expected user-stories");
  const recommendations = array(root.participationRecommendations, "/participationRecommendations", findings)
    .map((entry, index) => decodeCapabilityParticipationRecommendation(entry, index, findings));
  const requiredByKey = new Map(requiredSubjects.map((subject) => [subject.key, subject]));
  const recommendationBySubject = new Map<string, UserStoriesCapabilityParticipationRecommendation>();
  recommendations.forEach((recommendation, index) => {
    if (recommendationBySubject.has(recommendation.subjectKey)) {
      add(findings, "semantic", `/participationRecommendations/${index}/subjectKey`, `duplicate recommendation for Core subject '${recommendation.subjectKey}'`);
    } else if (!requiredByKey.has(recommendation.subjectKey as SemanticKey)) {
      add(findings, "semantic", `/participationRecommendations/${index}/subjectKey`, `recommendation references non-Core participation subject '${recommendation.subjectKey}'`);
    }
    recommendationBySubject.set(recommendation.subjectKey, recommendation);
  });
  const structuralQuestions = requiredSubjects.flatMap((subject, index): UserStoriesCapabilityParticipationQuestion[] => {
    const recommendation = recommendationBySubject.get(subject.key);
    if (!recommendation) {
      add(findings, "semantic", `/requiredParticipationSubjects/${index}`, `missing recommendation for Core subject '${subject.key}' (${subject.workflowKey}/${subject.capabilityKey})`);
      return [];
    }
    const recommended = subject.stepOneOptions.find((option) => option.key === recommendation.recommendedOptionKey);
    if (!recommended) {
      add(findings, "semantic", `/participationRecommendations/${index}/recommendedOptionKey`, `recommended option '${recommendation.recommendedOptionKey}' is not a Core-owned Step-1 option for subject '${subject.key}'`);
    }
    const question: UserStoriesCapabilityParticipationQuestion = {
      kind: "capability-participation",
      key: subject.key,
      question: recommendation.question,
      materiality: "product",
      rigidity: "RIGID",
      workflowKey: subject.workflowKey,
      capabilityKey: subject.capabilityKey,
      recommendedOptionKey: recommendation.recommendedOptionKey,
      rationale: recommendation.rationale,
      stepOneOptions: subject.stepOneOptions,
      pairOptions: subject.pairOptions,
    };
    const proposed: ProposedQuestion = {
      key: question.key,
      question: question.question,
      materiality: question.materiality,
      rigidity: question.rigidity,
      recommendedAnswer: { value: recommended?.label ?? "", rationale: question.rationale },
      alternatives: subject.stepOneOptions.filter((option) => option.key !== recommended?.key).map((option) => option.label),
    };
    const problem = questionProblem(proposed);
    if (problem) add(findings, "semantic", `/participationRecommendations/${index}`, problem);
    return [question];
  });
  const ordinaryQuestions = array(root.questions, "/questions", findings)
    .map((entry, index) => decodeQuestion(entry, index, findings));
  const questions: UserStoriesQuestion[] = [...structuralQuestions, ...ordinaryQuestions];
  const keys = new Set<string>();
  questions.forEach((question, index) => {
    if (keys.has(question.key)) add(findings, "semantic", `/questions/${index}/key`, `duplicate question key '${question.key}'`);
    keys.add(question.key);
  });
  const value: UserStoriesQuestionSelection = { contract: USER_STORIES_QUESTIONS_CONTRACT, stage: "user-stories", questions };
  return findings.length ? { ok: false, findings } : { ok: true, value };
}

export function decodeUserStoriesWire(payload: unknown): UserStoriesOutcome<UserStoriesWire> {
  const findings: UserStoriesFinding[] = [];
  const root = record(payload, "/", findings);
  exact(root, ["contract", "stage", "projectKey", "stories"], "", findings);
  if (root.contract !== USER_STORIES_CONTRACT) add(findings, "shape", "/contract", `expected ${USER_STORIES_CONTRACT}`);
  if (root.stage !== "user-stories") add(findings, "shape", "/stage", "expected user-stories");
  const stories = array(root.stories, "/stories", findings).map((value, index) => {
    const pointer = `/stories/${index}`;
    const entry = record(value, pointer, findings);
    exact(entry, ["key", "workflowKey", "capabilityKeys", "actorKey", "operatorActorKey", "intent", "outcome", "acceptance"], pointer, findings);
    return {
      key: text(entry.key, `${pointer}/key`, findings),
      workflowKey: text(entry.workflowKey, `${pointer}/workflowKey`, findings),
      capabilityKeys: array(entry.capabilityKeys, `${pointer}/capabilityKeys`, findings).map((item, capability) => text(item, `${pointer}/capabilityKeys/${capability}`, findings)),
      actorKey: text(entry.actorKey, `${pointer}/actorKey`, findings),
      operatorActorKey: text(entry.operatorActorKey, `${pointer}/operatorActorKey`, findings),
      intent: text(entry.intent, `${pointer}/intent`, findings),
      outcome: text(entry.outcome, `${pointer}/outcome`, findings),
      acceptance: array(entry.acceptance, `${pointer}/acceptance`, findings).map((item, acceptance) => text(item, `${pointer}/acceptance/${acceptance}`, findings)),
    };
  });
  const value: UserStoriesWire = {
    contract: USER_STORIES_CONTRACT,
    stage: "user-stories",
    projectKey: text(root.projectKey, "/projectKey", findings),
    stories,
  };
  return findings.length ? { ok: false, findings } : { ok: true, value };
}

function comparable(value: unknown): string {
  return progressiveCanonicalJson(value);
}

function allocateStoryIds(wire: UserStoriesWire, existing: UserStories | undefined): readonly UserStory[] {
  const existingByKey = new Map(existing?.stories.map((story) => [story.key, story]) ?? []);
  const workflowGroups = new Map<SemanticKey, number>();
  const maximumStoryNumber = new Map<number, number>();
  let maximumGroup = 0;
  for (const story of existing?.stories ?? []) {
    const id = parseStoryId(story.storyId)!;
    workflowGroups.set(story.workflowKey, id.workflowGroup);
    maximumGroup = Math.max(maximumGroup, id.workflowGroup);
    maximumStoryNumber.set(id.workflowGroup, Math.max(maximumStoryNumber.get(id.workflowGroup) ?? 0, id.storyNumber));
  }
  const parsed = wire.stories.map((story) => ({
    ...story,
    key: semanticKey(story.key),
    workflowKey: semanticKey(story.workflowKey),
    capabilityKeys: story.capabilityKeys.map(semanticKey),
    actorKey: semanticKey(story.actorKey),
    operatorActorKey: semanticKey(story.operatorActorKey),
  }));
  const newWorkflowKeys = [...new Set(parsed
    .filter((story) => story.workflowKey && !workflowGroups.has(story.workflowKey))
    .map((story) => story.workflowKey!))].sort(compare);
  for (const workflowKey of newWorkflowKeys) {
    maximumGroup += 1;
    workflowGroups.set(workflowKey, maximumGroup);
    maximumStoryNumber.set(maximumGroup, 0);
  }
  const newStoriesByWorkflow = new Map<SemanticKey, typeof parsed>();
  for (const story of parsed) {
    if (!story.key || !story.workflowKey || !story.actorKey || !story.operatorActorKey || story.capabilityKeys.some((entry) => !entry) || existingByKey.has(story.key)) continue;
    const values = newStoriesByWorkflow.get(story.workflowKey) ?? [];
    values.push(story);
    newStoriesByWorkflow.set(story.workflowKey, values);
  }
  const newIds = new Map<SemanticKey, string>();
  for (const [workflowKey, stories] of [...newStoriesByWorkflow.entries()].sort(([left], [right]) => compare(left, right))) {
    const group = workflowGroups.get(workflowKey)!;
    let next = maximumStoryNumber.get(group) ?? 0;
    for (const story of [...stories].sort((left, right) => compare(left.key!, right.key!))) {
      next += 1;
      newIds.set(story.key!, `US-${group}.${next}`);
    }
    maximumStoryNumber.set(group, next);
  }
  return parsed.flatMap((story) => {
    if (!story.key || !story.workflowKey || !story.actorKey || !story.operatorActorKey || story.capabilityKeys.some((entry) => !entry)) return [];
    return [{
      key: story.key,
      storyId: existingByKey.get(story.key)?.storyId ?? newIds.get(story.key)!,
      workflowKey: story.workflowKey,
      capabilityKeys: story.capabilityKeys as SemanticKey[],
      actorKey: story.actorKey,
      operatorActorKey: story.operatorActorKey,
      intent: story.intent,
      outcome: story.outcome,
      acceptance: story.acceptance,
    }];
  });
}

const EXPLICIT_ANSWER_RATIONALE = "Selected through an explicit user answer to a material interview question.";

function authorityFromVerifiedDecision(
  decision: ReturnType<typeof verifyInterviewEvidence>,
): UserStoriesAuthority | undefined {
  if (decision.source.kind === "user-answer") {
    return { kind: "user-answer", questionKey: decision.questionKey, value: decision.selectedValue };
  }
  if (decision.source.kind === "accepted-recommendation") {
    return {
      kind: "accepted-recommendation",
      questionKey: decision.questionKey,
      value: decision.selectedValue,
      acceptanceMode: decision.acceptanceMode as "blank-interactive" | "non-interactive-policy",
    };
  }
  return undefined;
}

export function materializeUserStoriesInterviewDeterminations(
  evidence: readonly InterviewQuestionEvidence[],
  existing?: UserStories,
): UserStoriesOutcome<readonly UserStoriesDetermination[]> {
  const findings: UserStoriesFinding[] = [];
  const determinations: UserStoriesDetermination[] = [...(existing?.determinations ?? [])];
  const existingKeys = new Set(determinations.map((entry) => entry.key));
  evidence.forEach((question, index) => {
    let decision: ReturnType<typeof verifyInterviewEvidence>;
    try {
      decision = verifyInterviewEvidence(question);
    } catch (error) {
      add(findings, "authority", `/questions/${index}`, error instanceof Error ? error.message : String(error));
      return;
    }
    if (existingKeys.has(decision.questionKey)) {
      add(
        findings,
        "preservation",
        `/questions/${index}/key`,
        `question key '${decision.questionKey}' conflicts with an existing developer-owned user-stories determination`,
      );
      return;
    }
    if (decision.source.kind !== "user-answer" && decision.source.kind !== "accepted-recommendation") {
      add(findings, "authority", `/questions/${index}`, "interview decision did not produce answer authority");
      return;
    }
    const source = authorityFromVerifiedDecision(decision)!;
    determinations.push({
      key: decision.questionKey,
      statement: decision.selectedValue,
      rationale: decision.source.kind === "user-answer" ? EXPLICIT_ANSWER_RATIONALE : question.recommendedAnswer.rationale,
      materiality: question.materiality,
      rigidity: question.rigidity,
      source,
    });
    existingKeys.add(decision.questionKey);
  });
  return findings.length ? { ok: false, findings } : { ok: true, value: determinations };
}

export function materializeUserStoriesStructuralDecisions(
  questions: readonly UserStoriesQuestion[],
  evidence: readonly InterviewQuestionEvidence[],
  existing?: UserStories,
): UserStoriesOutcome<readonly UserStoriesCapabilityParticipation[]> {
  const findings: UserStoriesFinding[] = [];
  const decisions: UserStoriesCapabilityParticipation[] = [...(existing?.structuralDecisions ?? [])];
  const keys = new Set(decisions.map((entry) => entry.key));
  const bindings = new Set(decisions.map((entry) => `${entry.workflowKey}\u0000${entry.capabilityKey}`));
  const evidenceByKey = new Map(evidence.map((entry) => [entry.key, entry]));
  questions.forEach((question, index) => {
    if (!isCapabilityParticipationQuestion(question)) return;
    const selectedEvidence = evidenceByKey.get(question.key);
    if (!selectedEvidence) {
      add(findings, "authority", `/questions/${index}`, `structural question '${question.key}' has no resolved interview evidence`);
      return;
    }
    let verified: ReturnType<typeof verifyInterviewEvidence>;
    try {
      verified = verifyInterviewEvidence(selectedEvidence);
    } catch (error) {
      add(findings, "authority", `/questions/${index}`, error instanceof Error ? error.message : String(error));
      return;
    }
    const option = question.pairOptions.find((entry) => clean(entry.label) === clean(verified.selectedValue));
    if (!option) {
      add(findings, "authority", `/questions/${index}`, `selected value for '${question.key}' is not one enumerated typed option`);
      return;
    }
    const key = semanticKey(question.key);
    const workflowKey = semanticKey(question.workflowKey);
    const capabilityKey = semanticKey(question.capabilityKey);
    const actorKey = semanticKey(option.actorKey);
    const operatorActorKey = semanticKey(option.operatorActorKey);
    if (!key || !workflowKey || !capabilityKey || !actorKey || !operatorActorKey) {
      add(findings, "authority", `/questions/${index}`, `structural question '${question.key}' contains invalid SemanticKeys`);
      return;
    }
    const binding = `${workflowKey}\u0000${capabilityKey}`;
    if (keys.has(key)) {
      add(findings, "preservation", `/questions/${index}/key`, `question key '${key}' conflicts with an existing developer-owned structural decision`);
      return;
    }
    if (bindings.has(binding)) {
      add(findings, "preservation", `/questions/${index}`, `capability participation for workflow '${workflowKey}' capability '${capabilityKey}' already has developer-owned authority`);
      return;
    }
    const source = authorityFromVerifiedDecision(verified);
    if (!source) {
      add(findings, "authority", `/questions/${index}`, "structural interview decision did not produce answer authority");
      return;
    }
    decisions.push({
      kind: "capability-participation",
      key,
      workflowKey,
      capabilityKey,
      actorKey,
      operatorActorKey,
      source,
    });
    keys.add(key);
    bindings.add(binding);
  });
  return findings.length ? { ok: false, findings } : { ok: true, value: decisions };
}

export function validateUserStoriesUpstreamRefinement(
  decisions: readonly UserStoriesCapabilityParticipation[],
  upstream: UserStoriesUpstreamProjection,
): readonly UserStoriesFinding[] {
  const findings: UserStoriesFinding[] = [];
  const workflows = new Map(upstream.workflows.map((entry) => [entry.key, entry]));
  decisions.forEach((decision, index) => {
    const pointer = `/structuralDecisions/${index}`;
    const workflow = workflows.get(decision.workflowKey);
    if (!workflow || !workflow.capabilityKeys.includes(decision.capabilityKey)) {
      add(findings, "upstream", `${pointer}/capabilityKey`, `workflow '${decision.workflowKey}' does not contain selected capability '${decision.capabilityKey}'`);
      return;
    }
    if (!workflow.actorKeys.includes(decision.actorKey)) {
      add(findings, "upstream", `${pointer}/actorKey`, `selected Actor '${decision.actorKey}' is not eligible for workflow '${decision.workflowKey}' whose upstream actors are [${workflow.actorKeys.join(", ")}]`);
    }
    if (!workflow.actorKeys.includes(decision.operatorActorKey)) {
      add(findings, "upstream", `${pointer}/operatorActorKey`, `selected Operator '${decision.operatorActorKey}' is not eligible for workflow '${decision.workflowKey}' whose upstream actors are [${workflow.actorKeys.join(", ")}]`);
    }
  });
  return findings;
}

export function resolveUserStoriesWire(
  wire: UserStoriesWire,
  upstream: UserStoriesUpstreamProjection,
  evidence: readonly InterviewQuestionEvidence[],
  existing?: UserStories,
  structuralDecisions: readonly UserStoriesCapabilityParticipation[] = existing?.structuralDecisions ?? [],
): UserStoriesOutcome<UserStories> {
  const findings: UserStoriesFinding[] = [];
  const projectKey = semanticKey(wire.projectKey);
  if (!projectKey) add(findings, "semantic", "/projectKey", "project key must be a SemanticKey");
  const ownedDeterminations = materializeUserStoriesInterviewDeterminations(evidence, existing);
  if (!ownedDeterminations.ok) return { ok: false, findings: [...findings, ...ownedDeterminations.findings] };
  if (!projectKey || findings.length) return { ok: false, findings };
  const candidate: UserStories = {
    contract: USER_STORIES_CONTRACT,
    stage: "user-stories",
    projectKey,
    determinations: ownedDeterminations.value,
    structuralDecisions,
    stories: allocateStoryIds(wire, existing),
  };
  return validateUserStories(candidate, upstream, evidence);
}

export function validateUserStoriesPreservation(
  existing: UserStories | undefined,
  candidate: UserStories,
): readonly UserStoriesFinding[] {
  if (!existing) return [];
  const findings: UserStoriesFinding[] = [];
  if (existing.projectKey !== candidate.projectKey) add(findings, "preservation", "/projectKey", "candidate changed developer-owned project binding");
  for (const [field, oldValues, newValues] of [
    ["determinations", existing.determinations, candidate.determinations],
    ["structuralDecisions", existing.structuralDecisions, candidate.structuralDecisions],
    ["stories", existing.stories, candidate.stories],
  ] as const) {
    const current = new Map(newValues.map((entry) => [entry.key as string, entry]));
    oldValues.forEach((entry) => {
      const replacement = current.get(entry.key as string);
      if (!replacement) add(findings, "preservation", `/${field}/${entry.key}`, "candidate silently deleted developer-owned semantics");
      else {
        const authorityOwned = field === "determinations" || field === "structuralDecisions";
        const oldComparable = authorityOwned ? { ...entry, source: { kind: "developer" } } : entry;
        const newComparable = authorityOwned ? { ...replacement, source: { kind: "developer" } } : replacement;
        if (comparable(oldComparable) !== comparable(newComparable)) {
          add(findings, "preservation", `/${field}/${entry.key}`, "candidate silently changed developer-owned semantics");
        }
      }
    });
  }
  return findings;
}
