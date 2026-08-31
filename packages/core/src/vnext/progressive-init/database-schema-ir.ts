import { sha256Text } from "../../hash.js";
import { semanticKey, SEMANTIC_KEY_PATTERN, type SemanticKey } from "../identity.js";
import { verifyInterviewEvidence, type InterviewQuestionEvidence } from "../interview.js";
import { semanticSingleLineIsValid } from "../validate.js";
import { progressiveCanonicalJson } from "./canonical-json.js";
import {
  canonicalizeUserStories,
  userStoriesAcceptedDecisionProjection,
  userStoriesAuthoritativeInputSha256,
  type UserStories,
} from "./user-stories-ir.js";

export const DATABASE_SCHEMA_CONTRACT = "rb-database-schema/v1" as const;
export const DATABASE_SCHEMA_QUESTIONS_CONTRACT = "rb-database-schema-persistence-questions/v1" as const;
export const DATABASE_SCHEMA_UPSTREAM_CONTRACT = "rb-database-schema-upstream/v1" as const;

export const DATABASE_SCHEMA_LOGICAL_TYPES = [
  "string",
  "integer",
  "decimal",
  "boolean",
  "date",
  "datetime",
  "uuid",
  "json",
  "binary",
] as const;

export type DatabaseSchemaLogicalType = typeof DATABASE_SCHEMA_LOGICAL_TYPES[number];
export type StoryPersistenceDisposition = "persisted" | "not-persisted";
export type DatabaseSchemaDisposition = "applicable" | "not-applicable";

export type DatabaseSchemaAuthority =
  | { readonly kind: "user-answer"; readonly questionKey: SemanticKey; readonly value: string }
  | {
      readonly kind: "accepted-recommendation";
      readonly questionKey: SemanticKey;
      readonly value: string;
      readonly acceptanceMode: "blank-interactive";
    }
  | { readonly kind: "developer" };

export interface DatabaseSchemaDetermination {
  readonly key: SemanticKey;
  readonly statement: string;
  readonly rationale: string;
  readonly materiality: "architecture";
  readonly rigidity: "RIGID";
  readonly source: DatabaseSchemaAuthority;
}

export interface DatabaseSchemaStoryPersistence {
  readonly kind: "story-persistence";
  readonly key: SemanticKey;
  readonly storyKey: SemanticKey;
  readonly decisionInputSha256: string;
  readonly disposition: StoryPersistenceDisposition;
  readonly source: DatabaseSchemaAuthority;
}

export interface DatabaseSchemaStoryCoverage {
  readonly storyKey: SemanticKey;
  readonly disposition: StoryPersistenceDisposition;
  readonly tableKeys: readonly SemanticKey[];
}

export interface DatabaseSchemaField {
  readonly key: SemanticKey;
  readonly name: string;
  readonly logicalType: DatabaseSchemaLogicalType;
  readonly required: boolean;
}

export interface DatabaseSchemaUniqueConstraint {
  readonly fieldKeys: readonly SemanticKey[];
}

export interface DatabaseSchemaTable {
  readonly key: SemanticKey;
  readonly name: string;
  readonly purpose: string;
  readonly fields: readonly DatabaseSchemaField[];
  readonly primaryKeyFieldKeys: readonly SemanticKey[];
  readonly uniqueConstraints: readonly DatabaseSchemaUniqueConstraint[];
}

export interface DatabaseSchemaForeignKey {
  readonly fromTableKey: SemanticKey;
  readonly fromFieldKey: SemanticKey;
  readonly toTableKey: SemanticKey;
  readonly toFieldKey: SemanticKey;
}

export interface DatabaseSchema {
  readonly contract: typeof DATABASE_SCHEMA_CONTRACT;
  readonly stage: "database-schema";
  readonly projectKey: SemanticKey;
  readonly determinations: readonly DatabaseSchemaDetermination[];
  readonly structuralDecisions: readonly DatabaseSchemaStoryPersistence[];
  readonly disposition: DatabaseSchemaDisposition;
  readonly storyCoverage: readonly DatabaseSchemaStoryCoverage[];
  readonly tables: readonly DatabaseSchemaTable[];
  readonly foreignKeys: readonly DatabaseSchemaForeignKey[];
}

export interface DatabaseSchemaUpstreamProjection {
  readonly contract: typeof DATABASE_SCHEMA_UPSTREAM_CONTRACT;
  readonly userStoriesUpstreamProjectionSha256: string;
  readonly userStoriesAuthoritativeInputSha256: string;
  readonly userStories: UserStories;
}

export interface StoryPersistenceOption {
  readonly key: StoryPersistenceDisposition;
  readonly label: string;
}

export interface StoryPersistenceSubject {
  readonly key: SemanticKey;
  readonly storyKey: SemanticKey;
  readonly decisionInputSha256: string;
  readonly options: readonly StoryPersistenceOption[];
}

export interface StoryPersistenceRecommendation {
  readonly subjectKey: string;
  readonly recommendedOptionKey: string;
  readonly question: string;
  readonly rationale: string;
}

export interface DatabaseSchemaQuestionSelectionWire {
  readonly contract: typeof DATABASE_SCHEMA_QUESTIONS_CONTRACT;
  readonly stage: "database-schema";
  readonly recommendations: readonly StoryPersistenceRecommendation[];
}

export interface DatabaseSchemaProposalWire {
  readonly storyCoverage: readonly {
    readonly storyKey: string;
    readonly tableKeys: readonly string[];
  }[];
  readonly tables: readonly {
    readonly key: string;
    readonly name: string;
    readonly purpose: string;
    readonly fields: readonly {
      readonly key: string;
      readonly name: string;
      readonly logicalType: string;
      readonly required: boolean;
    }[];
    readonly primaryKeyFieldKeys: readonly string[];
    readonly uniqueConstraints: readonly { readonly fieldKeys: readonly string[] }[];
  }[];
  readonly foreignKeys: readonly {
    readonly fromTableKey: string;
    readonly fromFieldKey: string;
    readonly toTableKey: string;
    readonly toFieldKey: string;
  }[];
}

export type DatabaseSchemaFindingCode = "shape" | "semantic" | "authority" | "upstream" | "coverage" | "preservation";
export interface DatabaseSchemaFinding {
  readonly code: DatabaseSchemaFindingCode;
  readonly pointer: string;
  readonly message: string;
}

export type DatabaseSchemaOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly findings: readonly DatabaseSchemaFinding[] };

const SHA256 = /^[a-f0-9]{64}$/;
const STORY_PERSISTENCE_OPTIONS: readonly StoryPersistenceOption[] = [
  { key: "persisted", label: "Persisted" },
  { key: "not-persisted", label: "Not persisted" },
] as const;

function clean(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ");
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortByKey<T extends { readonly key: string }>(values: readonly T[]): readonly T[] {
  return [...values].sort((left, right) => compare(left.key, right.key));
}

function add(findings: DatabaseSchemaFinding[], code: DatabaseSchemaFindingCode, pointer: string, message: string): void {
  findings.push({ code, pointer, message });
}

function canonicalAuthority(source: DatabaseSchemaAuthority): DatabaseSchemaAuthority {
  return source.kind === "developer" ? source : { ...source, value: clean(source.value) };
}

function canonicalConstraintKey(constraint: DatabaseSchemaUniqueConstraint): string {
  return [...constraint.fieldKeys].sort(compare).join("\u0000");
}

export function canonicalizeDatabaseSchema(value: DatabaseSchema): DatabaseSchema {
  return {
    contract: DATABASE_SCHEMA_CONTRACT,
    stage: "database-schema",
    projectKey: value.projectKey,
    determinations: sortByKey(value.determinations).map((entry) => ({
      ...entry,
      statement: clean(entry.statement),
      rationale: clean(entry.rationale),
      source: canonicalAuthority(entry.source),
    })),
    structuralDecisions: sortByKey(value.structuralDecisions).map((entry) => ({ ...entry, source: canonicalAuthority(entry.source) })),
    disposition: value.disposition,
    storyCoverage: [...value.storyCoverage]
      .map((entry) => ({ ...entry, tableKeys: [...entry.tableKeys].sort(compare) }))
      .sort((left, right) => compare(left.storyKey, right.storyKey)),
    tables: sortByKey(value.tables).map((table) => ({
      ...table,
      name: clean(table.name),
      purpose: clean(table.purpose),
      fields: sortByKey(table.fields).map((field) => ({ ...field, name: clean(field.name) })),
      primaryKeyFieldKeys: [...table.primaryKeyFieldKeys].sort(compare),
      uniqueConstraints: [...table.uniqueConstraints]
        .map((constraint) => ({ fieldKeys: [...constraint.fieldKeys].sort(compare) }))
        .sort((left, right) => compare(canonicalConstraintKey(left), canonicalConstraintKey(right))),
    })),
    foreignKeys: [...value.foreignKeys].sort((left, right) =>
      compare(left.fromTableKey, right.fromTableKey)
      || compare(left.fromFieldKey, right.fromFieldKey)
      || compare(left.toTableKey, right.toTableKey)
      || compare(left.toFieldKey, right.toFieldKey)),
  };
}

export function databaseSchemaForPersistence(value: DatabaseSchema): DatabaseSchema {
  return canonicalizeDatabaseSchema({
    ...value,
    determinations: value.determinations.map((entry) => ({ ...entry, source: { kind: "developer" as const } })),
    structuralDecisions: value.structuralDecisions.map((entry) => ({ ...entry, source: { kind: "developer" as const } })),
  });
}

export function databaseSchemaUpstreamProjection(
  userStories: UserStories,
  userStoriesUpstreamProjectionSha256: string,
): DatabaseSchemaUpstreamProjection {
  if (!SHA256.test(userStoriesUpstreamProjectionSha256)) {
    throw new Error("DATABASE_SCHEMA_UPSTREAM_INVALID: user-stories upstream projection hash is invalid");
  }
  const canonicalUserStories = canonicalizeUserStories(userStories);
  return {
    contract: DATABASE_SCHEMA_UPSTREAM_CONTRACT,
    userStoriesUpstreamProjectionSha256,
    userStoriesAuthoritativeInputSha256: userStoriesAuthoritativeInputSha256({
      upstreamProjectionSha256: userStoriesUpstreamProjectionSha256,
      acceptedDecisions: userStoriesAcceptedDecisionProjection(canonicalUserStories),
    }),
    userStories: canonicalUserStories,
  };
}

export function databaseSchemaUpstreamProjectionSha256(projection: DatabaseSchemaUpstreamProjection): string {
  return sha256Text(progressiveCanonicalJson(projection));
}

function persistenceSubjectKey(storyKey: SemanticKey): SemanticKey {
  return semanticKey(`persistence-${sha256Text(storyKey).slice(0, 36)}`)!;
}

export function storyPersistenceDecisionInputSha256(
  upstream: DatabaseSchemaUpstreamProjection,
  storyKey: SemanticKey,
): string {
  const story = upstream.userStories.stories.find((entry) => entry.key === storyKey);
  if (!story) throw new Error(`DATABASE_SCHEMA_DECISION_INPUT_INVALID: unknown upstream story '${storyKey}'`);
  return sha256Text(progressiveCanonicalJson({
    userStoriesAuthoritativeInputSha256: upstream.userStoriesAuthoritativeInputSha256,
    story,
  }));
}

export function enumerateStoryPersistenceSubjects(
  upstream: DatabaseSchemaUpstreamProjection,
): readonly StoryPersistenceSubject[] {
  return [...upstream.userStories.stories]
    .sort((left, right) => compare(left.key, right.key))
    .map((story) => ({
      key: persistenceSubjectKey(story.key),
      storyKey: story.key,
      decisionInputSha256: storyPersistenceDecisionInputSha256(upstream, story.key),
      options: STORY_PERSISTENCE_OPTIONS,
    }));
}

function settledPersistenceSubject(
  subject: StoryPersistenceSubject,
  existing: DatabaseSchema | undefined,
): boolean {
  if (!existing) return false;
  const decisions = existing.structuralDecisions.filter((entry) => entry.storyKey === subject.storyKey);
  if (decisions.length !== 1
    || decisions[0]!.key !== subject.key
    || decisions[0]!.decisionInputSha256 !== subject.decisionInputSha256
    || decisions[0]!.source.kind !== "developer") return false;
  const determinations = existing.determinations.filter((entry) => entry.key === subject.key);
  const determination = determinations[0];
  const expectedStatement = STORY_PERSISTENCE_OPTIONS.find((entry) => entry.key === decisions[0]!.disposition)!.label;
  return determinations.length === 1
    && determination?.source.kind === "developer"
    && determination.statement === expectedStatement
    && determination.materiality === "architecture"
    && determination.rigidity === "RIGID";
}

export function requiredStoryPersistenceSubjects(
  upstream: DatabaseSchemaUpstreamProjection,
  existing?: DatabaseSchema,
): readonly StoryPersistenceSubject[] {
  return enumerateStoryPersistenceSubjects(upstream).filter((subject) => !settledPersistenceSubject(subject, existing));
}

export function deriveDatabaseSchemaDisposition(
  decisions: readonly DatabaseSchemaStoryPersistence[],
): DatabaseSchemaDisposition {
  return decisions.some((entry) => entry.disposition === "persisted") ? "applicable" : "not-applicable";
}

export function materializeStoryPersistenceAuthority(
  subjects: readonly StoryPersistenceSubject[],
  evidence: readonly InterviewQuestionEvidence[],
  existing?: DatabaseSchema,
): DatabaseSchemaOutcome<{
  readonly determinations: readonly DatabaseSchemaDetermination[];
  readonly structuralDecisions: readonly DatabaseSchemaStoryPersistence[];
}> {
  const findings: DatabaseSchemaFinding[] = [];
  const replacedSubjectKeys = new Set(subjects.map((entry) => entry.key));
  const replacedStoryKeys = new Set(subjects.map((entry) => entry.storyKey));
  const determinations: DatabaseSchemaDetermination[] = (existing?.determinations ?? [])
    .filter((entry) => !replacedSubjectKeys.has(entry.key));
  const structuralDecisions: DatabaseSchemaStoryPersistence[] = (existing?.structuralDecisions ?? [])
    .filter((entry) => !replacedSubjectKeys.has(entry.key) && !replacedStoryKeys.has(entry.storyKey));
  const determinationKeys = new Set(determinations.map((entry) => entry.key));
  const decisionStories = new Set(structuralDecisions.map((entry) => entry.storyKey));
  const evidenceByKey = new Map(evidence.map((entry) => [entry.key, entry]));
  subjects.forEach((subject, index) => {
    const selectedEvidence = evidenceByKey.get(subject.key);
    if (!selectedEvidence) {
      add(findings, "authority", `/subjects/${index}`, `Core persistence subject '${subject.key}' has no resolved interview evidence`);
      return;
    }
    let verified: ReturnType<typeof verifyInterviewEvidence>;
    try {
      verified = verifyInterviewEvidence(selectedEvidence);
    } catch (error) {
      add(findings, "authority", `/subjects/${index}`, error instanceof Error ? error.message : String(error));
      return;
    }
    const option = subject.options.find((entry) => entry.label === verified.selectedValue);
    if (!option) {
      add(findings, "authority", `/subjects/${index}`, `selected value for '${subject.key}' is not a Core-owned persistence option`);
      return;
    }
    if (determinationKeys.has(subject.key) || decisionStories.has(subject.storyKey)) {
      add(findings, "authority", `/subjects/${index}`, `persistence authority for story '${subject.storyKey}' is not uniquely replaceable`);
      return;
    }
    let source: DatabaseSchemaAuthority;
    if (verified.source.kind === "user-answer") {
      source = { kind: "user-answer", questionKey: subject.key, value: option.label };
    } else if (verified.source.kind === "accepted-recommendation" && verified.acceptanceMode === "blank-interactive") {
      source = {
        kind: "accepted-recommendation",
        questionKey: subject.key,
        value: option.label,
        acceptanceMode: "blank-interactive",
      };
    } else {
      add(findings, "authority", `/subjects/${index}`, "headless persistence authority is forbidden in database-schema V1");
      return;
    }
    determinations.push({
      key: subject.key,
      statement: option.label,
      rationale: verified.source.kind === "user-answer"
        ? "Selected through an explicit developer answer to a Core-owned story persistence question."
        : selectedEvidence.recommendedAnswer.rationale,
      materiality: "architecture",
      rigidity: "RIGID",
      source,
    });
    structuralDecisions.push({
      kind: "story-persistence",
      key: subject.key,
      storyKey: subject.storyKey,
      decisionInputSha256: subject.decisionInputSha256,
      disposition: option.key,
      source,
    });
    determinationKeys.add(subject.key);
    decisionStories.add(subject.storyKey);
  });
  return findings.length
    ? { ok: false, findings }
    : { ok: true, value: { determinations, structuralDecisions } };
}

function authorityIsValid(
  authority: DatabaseSchemaAuthority,
  statement: string,
  interviewDecisions: ReadonlyMap<string, ReturnType<typeof verifyInterviewEvidence>>,
): boolean {
  if (authority.kind === "developer") return true;
  const verified = interviewDecisions.get(authority.questionKey);
  if (!verified || verified.selectedValue !== statement || authority.value !== statement) return false;
  if (authority.kind === "user-answer") return verified.source.kind === "user-answer";
  return verified.source.kind === "accepted-recommendation"
    && verified.acceptanceMode === "blank-interactive"
    && authority.acceptanceMode === "blank-interactive";
}

export function validateDatabaseSchema(
  input: DatabaseSchema,
  upstream: DatabaseSchemaUpstreamProjection,
  interviewEvidence: readonly InterviewQuestionEvidence[] = [],
  options: { readonly allowMissingUpstreamStories?: boolean; readonly allowStaleDecisionInputs?: boolean } = {},
): DatabaseSchemaOutcome<DatabaseSchema> {
  const value = canonicalizeDatabaseSchema(input);
  const findings: DatabaseSchemaFinding[] = [];
  const interviewDecisions = new Map(interviewEvidence.map((entry) => [entry.key, verifyInterviewEvidence(entry)]));
  if (input.contract !== DATABASE_SCHEMA_CONTRACT || input.stage !== "database-schema") {
    add(findings, "shape", "/contract", "unsupported database-schema contract");
  }
  if (value.projectKey !== upstream.userStories.projectKey) {
    add(findings, "upstream", "/projectKey", "project key does not match the fresh user-stories authority");
  }

  const upstreamStories = new Set(upstream.userStories.stories.map((story) => story.key));
  const determinationByKey = new Map<SemanticKey, DatabaseSchemaDetermination>();
  value.determinations.forEach((entry, index) => {
    const pointer = `/determinations/${index}`;
    if (!semanticKey(entry.key)) add(findings, "semantic", `${pointer}/key`, `invalid SemanticKey '${entry.key}'`);
    if (determinationByKey.has(entry.key)) add(findings, "semantic", `${pointer}/key`, `duplicate determination key '${entry.key}'`);
    determinationByKey.set(entry.key, entry);
    if (!semanticSingleLineIsValid(entry.statement)) add(findings, "semantic", `${pointer}/statement`, "field must be non-empty and single-line");
    if (!semanticSingleLineIsValid(entry.rationale)) add(findings, "semantic", `${pointer}/rationale`, "field must be non-empty and single-line");
    if (entry.materiality !== "architecture" || entry.rigidity !== "RIGID") add(findings, "shape", pointer, "story persistence determinations must be architecture/RIGID");
    if (!authorityIsValid(entry.source, entry.statement, interviewDecisions)) add(findings, "authority", `${pointer}/source`, "determination authority is not verifiable");
  });

  const decisionByStory = new Map<SemanticKey, DatabaseSchemaStoryPersistence>();
  const decisionKeys = new Set<SemanticKey>();
  value.structuralDecisions.forEach((decision, index) => {
    const pointer = `/structuralDecisions/${index}`;
    if (!semanticKey(decision.key)) add(findings, "semantic", `${pointer}/key`, `invalid SemanticKey '${decision.key}'`);
    if (decisionKeys.has(decision.key)) add(findings, "semantic", `${pointer}/key`, `duplicate structural decision key '${decision.key}'`);
    decisionKeys.add(decision.key);
    if (decisionByStory.has(decision.storyKey)) add(findings, "semantic", `${pointer}/storyKey`, `duplicate persistence decision for story '${decision.storyKey}'`);
    decisionByStory.set(decision.storyKey, decision);
    if (!upstreamStories.has(decision.storyKey)) add(findings, "upstream", `${pointer}/storyKey`, `unknown upstream story '${decision.storyKey}'`);
    const expectedKey = persistenceSubjectKey(decision.storyKey);
    if (decision.key !== expectedKey) add(findings, "authority", `${pointer}/key`, `story '${decision.storyKey}' requires Core subject key '${expectedKey}'`);
    if (!SHA256.test(decision.decisionInputSha256)) {
      add(findings, "shape", `${pointer}/decisionInputSha256`, "decision input must be lowercase SHA-256");
    } else if (upstreamStories.has(decision.storyKey)
      && options.allowStaleDecisionInputs !== true
      && decision.decisionInputSha256 !== storyPersistenceDecisionInputSha256(upstream, decision.storyKey)) {
      add(findings, "authority", `${pointer}/decisionInputSha256`, `persistence decision for story '${decision.storyKey}' is bound to stale semantic input`);
    }
    const determination = determinationByKey.get(decision.key);
    if (!determination) add(findings, "authority", `${pointer}/key`, `structural decision '${decision.key}' requires one matching determination`);
    else {
      const expectedStatement = STORY_PERSISTENCE_OPTIONS.find((entry) => entry.key === decision.disposition)!.label;
      if (determination.statement !== expectedStatement) add(findings, "authority", `${pointer}/disposition`, `matching determination must state '${expectedStatement}'`);
      if (progressiveCanonicalJson(determination.source) !== progressiveCanonicalJson(decision.source)) {
        add(findings, "authority", `${pointer}/source`, "structural decision must share its determination authority");
      }
    }
  });
  for (const story of upstream.userStories.stories) {
    if (!decisionByStory.has(story.key) && options.allowMissingUpstreamStories !== true) {
      add(findings, "coverage", "/structuralDecisions", `upstream story '${story.key}' has no persistence decision`);
    }
  }
  for (const determination of value.determinations) {
    if (!value.structuralDecisions.some((entry) => entry.key === determination.key)) {
      add(findings, "authority", "/determinations", `determination '${determination.key}' has no matching structural decision`);
    }
  }

  const tableByKey = new Map<SemanticKey, DatabaseSchemaTable>();
  const tableNames = new Set<string>();
  value.tables.forEach((table, tableIndex) => {
    const pointer = `/tables/${tableIndex}`;
    if (!semanticKey(table.key)) add(findings, "semantic", `${pointer}/key`, `invalid SemanticKey '${table.key}'`);
    if (tableByKey.has(table.key)) add(findings, "semantic", `${pointer}/key`, `duplicate table key '${table.key}'`);
    tableByKey.set(table.key, table);
    if (!semanticSingleLineIsValid(table.name)) add(findings, "semantic", `${pointer}/name`, "table name must be non-empty and single-line");
    if (tableNames.has(table.name)) add(findings, "semantic", `${pointer}/name`, `duplicate table name '${table.name}'`);
    tableNames.add(table.name);
    if (!semanticSingleLineIsValid(table.purpose)) add(findings, "semantic", `${pointer}/purpose`, "table purpose must be non-empty and single-line");
    if (!table.fields.length) add(findings, "semantic", `${pointer}/fields`, "table must contain at least one field");
    const fields = new Map<SemanticKey, DatabaseSchemaField>();
    const fieldNames = new Set<string>();
    table.fields.forEach((field, fieldIndex) => {
      const fieldPointer = `${pointer}/fields/${fieldIndex}`;
      if (!semanticKey(field.key)) add(findings, "semantic", `${fieldPointer}/key`, `invalid SemanticKey '${field.key}'`);
      if (fields.has(field.key)) add(findings, "semantic", `${fieldPointer}/key`, `duplicate field key '${field.key}' in table '${table.key}'`);
      fields.set(field.key, field);
      if (!semanticSingleLineIsValid(field.name)) add(findings, "semantic", `${fieldPointer}/name`, "field name must be non-empty and single-line");
      if (fieldNames.has(field.name)) add(findings, "semantic", `${fieldPointer}/name`, `duplicate field name '${field.name}' in table '${table.key}'`);
      fieldNames.add(field.name);
      if (!(DATABASE_SCHEMA_LOGICAL_TYPES as readonly string[]).includes(field.logicalType)) {
        add(findings, "shape", `${fieldPointer}/logicalType`, `unsupported logical type '${field.logicalType}'`);
      }
      if (typeof field.required !== "boolean") add(findings, "shape", `${fieldPointer}/required`, "required must be boolean");
    });
    if (!table.primaryKeyFieldKeys.length) add(findings, "semantic", `${pointer}/primaryKeyFieldKeys`, "table must contain at least one primary-key field");
    const primary = new Set<SemanticKey>();
    table.primaryKeyFieldKeys.forEach((fieldKey, fieldIndex) => {
      if (primary.has(fieldKey)) add(findings, "semantic", `${pointer}/primaryKeyFieldKeys/${fieldIndex}`, `duplicate primary-key field '${fieldKey}'`);
      primary.add(fieldKey);
      if (!fields.has(fieldKey)) add(findings, "semantic", `${pointer}/primaryKeyFieldKeys/${fieldIndex}`, `unknown primary-key field '${fieldKey}'`);
    });
    const constraintIdentities = new Set<string>();
    table.uniqueConstraints.forEach((constraint, constraintIndex) => {
      const constraintPointer = `${pointer}/uniqueConstraints/${constraintIndex}/fieldKeys`;
      if (!constraint.fieldKeys.length) add(findings, "semantic", constraintPointer, "unique constraint must reference at least one field");
      const local = new Set<SemanticKey>();
      constraint.fieldKeys.forEach((fieldKey, fieldIndex) => {
        if (local.has(fieldKey)) add(findings, "semantic", `${constraintPointer}/${fieldIndex}`, `duplicate unique field '${fieldKey}'`);
        local.add(fieldKey);
        if (!fields.has(fieldKey)) add(findings, "semantic", `${constraintPointer}/${fieldIndex}`, `unknown unique field '${fieldKey}'`);
      });
      const identity = [...local].sort(compare).join("\u0000");
      if (constraintIdentities.has(identity)) add(findings, "semantic", constraintPointer, "duplicate equivalent unique constraint");
      constraintIdentities.add(identity);
    });
  });

  const coverageByStory = new Map<SemanticKey, DatabaseSchemaStoryCoverage>();
  const coveredTables = new Set<SemanticKey>();
  value.storyCoverage.forEach((coverage, index) => {
    const pointer = `/storyCoverage/${index}`;
    if (coverageByStory.has(coverage.storyKey)) add(findings, "semantic", `${pointer}/storyKey`, `duplicate story coverage for '${coverage.storyKey}'`);
    coverageByStory.set(coverage.storyKey, coverage);
    if (!upstreamStories.has(coverage.storyKey)) add(findings, "upstream", `${pointer}/storyKey`, `unknown upstream story '${coverage.storyKey}'`);
    const decision = decisionByStory.get(coverage.storyKey);
    if (!decision) {
      if (upstreamStories.has(coverage.storyKey)) add(findings, "authority", `${pointer}/storyKey`, `story '${coverage.storyKey}' has no persistence authority`);
    } else if (coverage.disposition !== decision.disposition) {
      add(findings, "authority", `${pointer}/disposition`, `coverage cannot change developer-selected '${decision.disposition}' disposition`);
    }
    const localTables = new Set<SemanticKey>();
    coverage.tableKeys.forEach((tableKey, tableIndex) => {
      if (localTables.has(tableKey)) add(findings, "semantic", `${pointer}/tableKeys/${tableIndex}`, `duplicate table reference '${tableKey}'`);
      localTables.add(tableKey);
      if (!tableByKey.has(tableKey)) add(findings, "semantic", `${pointer}/tableKeys/${tableIndex}`, `unknown table '${tableKey}'`);
      coveredTables.add(tableKey);
    });
    if (coverage.disposition === "persisted" && !coverage.tableKeys.length) add(findings, "coverage", `${pointer}/tableKeys`, "persisted story must reference at least one table");
    if (coverage.disposition === "not-persisted" && coverage.tableKeys.length) add(findings, "authority", `${pointer}/tableKeys`, "not-persisted story must not reference tables");
  });
  for (const story of upstream.userStories.stories) {
    if (!coverageByStory.has(story.key) && options.allowMissingUpstreamStories !== true) {
      add(findings, "coverage", "/storyCoverage", `upstream story '${story.key}' has no database-schema coverage entry`);
    }
  }
  value.tables.forEach((table, index) => {
    if (!coveredTables.has(table.key)) add(findings, "coverage", `/tables/${index}`, `table '${table.key}' is not referenced by any persisted story`);
  });

  const foreignIdentity = new Set<string>();
  value.foreignKeys.forEach((foreignKey, index) => {
    const pointer = `/foreignKeys/${index}`;
    const identity = `${foreignKey.fromTableKey}\u0000${foreignKey.fromFieldKey}`;
    if (foreignIdentity.has(identity)) add(findings, "semantic", pointer, `duplicate foreign key source '${foreignKey.fromTableKey}.${foreignKey.fromFieldKey}'`);
    foreignIdentity.add(identity);
    const fromTable = tableByKey.get(foreignKey.fromTableKey);
    const toTable = tableByKey.get(foreignKey.toTableKey);
    if (!fromTable) add(findings, "semantic", `${pointer}/fromTableKey`, `unknown source table '${foreignKey.fromTableKey}'`);
    if (!toTable) add(findings, "semantic", `${pointer}/toTableKey`, `unknown target table '${foreignKey.toTableKey}'`);
    const fromField = fromTable?.fields.find((field) => field.key === foreignKey.fromFieldKey);
    const toField = toTable?.fields.find((field) => field.key === foreignKey.toFieldKey);
    if (fromTable && !fromField) add(findings, "semantic", `${pointer}/fromFieldKey`, `unknown source field '${foreignKey.fromFieldKey}'`);
    if (toTable && !toField) add(findings, "semantic", `${pointer}/toFieldKey`, `unknown target field '${foreignKey.toFieldKey}'`);
    if (toTable && toField) {
      const singlePrimary = toTable.primaryKeyFieldKeys.length === 1 && toTable.primaryKeyFieldKeys[0] === toField.key;
      const singleUnique = toTable.uniqueConstraints.some((constraint) => constraint.fieldKeys.length === 1 && constraint.fieldKeys[0] === toField.key);
      if (!singlePrimary && !singleUnique) add(findings, "semantic", `${pointer}/toFieldKey`, "foreign-key target must be a single-field primary or unique candidate key");
    }
    if (fromField && toField && fromField.logicalType !== toField.logicalType) {
      add(findings, "semantic", pointer, `foreign-key logical types differ: '${fromField.logicalType}' vs '${toField.logicalType}'`);
    }
  });

  const derived = deriveDatabaseSchemaDisposition(value.structuralDecisions);
  if (value.disposition !== derived) add(findings, "semantic", "/disposition", `derived disposition must be '${derived}'`);
  if (derived === "not-applicable") {
    if (value.tables.length || value.foreignKeys.length) add(findings, "semantic", "/tables", "not-applicable schema must contain no tables or foreign keys");
  } else {
    if (!value.tables.length) add(findings, "coverage", "/tables", "applicable schema must contain at least one table");
    if (![...decisionByStory.values()].some((entry) => entry.disposition === "persisted")) add(findings, "coverage", "/structuralDecisions", "applicable schema requires a persisted story");
  }

  return findings.length ? { ok: false, findings } : { ok: true, value };
}

export function databaseSchemaSemanticSha256(value: DatabaseSchema): string {
  return sha256Text(progressiveCanonicalJson(canonicalizeDatabaseSchema(value)));
}

export function databaseSchemaAcceptedDecisionProjection(value: DatabaseSchema): readonly unknown[] {
  const canonical = canonicalizeDatabaseSchema(value);
  return [
    ...canonical.determinations.map(({ key, statement, rationale, materiality, rigidity }) => ({
      kind: "determination", key, statement, rationale, materiality, rigidity,
    })),
    ...canonical.structuralDecisions.map(({ key, storyKey, decisionInputSha256, disposition }) => ({
      kind: "story-persistence", key, storyKey, decisionInputSha256, disposition,
    })),
  ];
}

export function databaseSchemaAuthoritativeInputSha256(input: {
  readonly upstreamProjectionSha256: string;
  readonly acceptedDecisions: readonly unknown[];
  readonly contractVersion?: string;
}): string {
  return sha256Text(progressiveCanonicalJson({
    stage: "database-schema",
    contract: input.contractVersion ?? DATABASE_SCHEMA_CONTRACT,
    upstreamProjectionSha256: input.upstreamProjectionSha256,
    acceptedDecisions: input.acceptedDecisions,
  }));
}

function record(value: unknown, pointer: string, findings: DatabaseSchemaFinding[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    add(findings, "shape", pointer, "expected object");
    return {};
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, fields: readonly string[], pointer: string, findings: DatabaseSchemaFinding[]): void {
  const allowed = new Set(fields);
  Object.keys(value).forEach((key) => { if (!allowed.has(key)) add(findings, "shape", `${pointer}/${key}`, "unknown field"); });
  fields.forEach((key) => { if (!(key in value)) add(findings, "shape", `${pointer}/${key}`, "required field is missing"); });
}

function text(value: unknown, pointer: string, findings: DatabaseSchemaFinding[]): string {
  if (typeof value !== "string") { add(findings, "shape", pointer, "expected string"); return ""; }
  return value;
}

function array(value: unknown, pointer: string, findings: DatabaseSchemaFinding[]): readonly unknown[] {
  if (!Array.isArray(value)) { add(findings, "shape", pointer, "expected array"); return []; }
  return value;
}

function bool(value: unknown, pointer: string, findings: DatabaseSchemaFinding[]): boolean {
  if (typeof value !== "boolean") { add(findings, "shape", pointer, "expected boolean"); return false; }
  return value;
}

export const DATABASE_SCHEMA_PERSISTENCE_QUESTIONS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["contract", "stage", "recommendations"],
  properties: {
    contract: { type: "string", enum: [DATABASE_SCHEMA_QUESTIONS_CONTRACT] },
    stage: { type: "string", enum: ["database-schema"] },
    recommendations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["subjectKey", "recommendedOptionKey", "question", "rationale"],
        properties: {
          subjectKey: { type: "string", pattern: SEMANTIC_KEY_PATTERN },
          recommendedOptionKey: { type: "string", enum: ["persisted", "not-persisted"] },
          question: { type: "string", minLength: 1 },
          rationale: { type: "string", minLength: 1 },
        },
      },
    },
  },
} as const;

const SEMANTIC_KEY_SCHEMA = { type: "string", pattern: SEMANTIC_KEY_PATTERN } as const;
const NON_EMPTY_SCHEMA = { type: "string", minLength: 1 } as const;

export const DATABASE_SCHEMA_PROPOSAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["storyCoverage", "tables", "foreignKeys"],
  properties: {
    storyCoverage: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["storyKey", "tableKeys"],
        properties: { storyKey: SEMANTIC_KEY_SCHEMA, tableKeys: { type: "array", items: SEMANTIC_KEY_SCHEMA } },
      },
    },
    tables: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["key", "name", "purpose", "fields", "primaryKeyFieldKeys", "uniqueConstraints"],
        properties: {
          key: SEMANTIC_KEY_SCHEMA, name: NON_EMPTY_SCHEMA, purpose: NON_EMPTY_SCHEMA,
          fields: {
            type: "array", minItems: 1,
            items: {
              type: "object", additionalProperties: false, required: ["key", "name", "logicalType", "required"],
              properties: {
                key: SEMANTIC_KEY_SCHEMA, name: NON_EMPTY_SCHEMA,
                logicalType: { type: "string", enum: DATABASE_SCHEMA_LOGICAL_TYPES }, required: { type: "boolean" },
              },
            },
          },
          primaryKeyFieldKeys: { type: "array", minItems: 1, items: SEMANTIC_KEY_SCHEMA },
          uniqueConstraints: {
            type: "array",
            items: {
              type: "object", additionalProperties: false, required: ["fieldKeys"],
              properties: { fieldKeys: { type: "array", minItems: 1, items: SEMANTIC_KEY_SCHEMA } },
            },
          },
        },
      },
    },
    foreignKeys: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["fromTableKey", "fromFieldKey", "toTableKey", "toFieldKey"],
        properties: {
          fromTableKey: SEMANTIC_KEY_SCHEMA, fromFieldKey: SEMANTIC_KEY_SCHEMA,
          toTableKey: SEMANTIC_KEY_SCHEMA, toFieldKey: SEMANTIC_KEY_SCHEMA,
        },
      },
    },
  },
} as const;

export function decodeDatabaseSchemaQuestionSelection(
  payload: unknown,
  requiredSubjects: readonly StoryPersistenceSubject[],
): DatabaseSchemaOutcome<readonly StoryPersistenceRecommendation[]> {
  const findings: DatabaseSchemaFinding[] = [];
  const root = record(payload, "/", findings);
  exact(root, ["contract", "stage", "recommendations"], "/", findings);
  if (root.contract !== DATABASE_SCHEMA_QUESTIONS_CONTRACT) add(findings, "shape", "/contract", `expected ${DATABASE_SCHEMA_QUESTIONS_CONTRACT}`);
  if (root.stage !== "database-schema") add(findings, "shape", "/stage", "expected database-schema");
  const recommendations = array(root.recommendations, "/recommendations", findings).map((raw, index) => {
    const pointer = `/recommendations/${index}`;
    const entry = record(raw, pointer, findings);
    exact(entry, ["subjectKey", "recommendedOptionKey", "question", "rationale"], pointer, findings);
    return {
      subjectKey: text(entry.subjectKey, `${pointer}/subjectKey`, findings),
      recommendedOptionKey: text(entry.recommendedOptionKey, `${pointer}/recommendedOptionKey`, findings),
      question: text(entry.question, `${pointer}/question`, findings),
      rationale: text(entry.rationale, `${pointer}/rationale`, findings),
    };
  });
  const requiredByKey = new Map(requiredSubjects.map((subject) => [subject.key, subject]));
  const seen = new Set<string>();
  recommendations.forEach((recommendation, index) => {
    if (seen.has(recommendation.subjectKey)) add(findings, "semantic", `/recommendations/${index}/subjectKey`, `duplicate recommendation for Core subject '${recommendation.subjectKey}'`);
    seen.add(recommendation.subjectKey);
    const subject = requiredByKey.get(recommendation.subjectKey as SemanticKey);
    if (!subject) add(findings, "authority", `/recommendations/${index}/subjectKey`, `recommendation references non-Core subject '${recommendation.subjectKey}'`);
    else if (!subject.options.some((option) => option.key === recommendation.recommendedOptionKey)) {
      add(findings, "authority", `/recommendations/${index}/recommendedOptionKey`, `recommended option '${recommendation.recommendedOptionKey}' is not Core-owned`);
    }
    if (clean(recommendation.question).length < 8) add(findings, "semantic", `/recommendations/${index}/question`, "question must be concrete");
    if (clean(recommendation.rationale).length < 8) add(findings, "semantic", `/recommendations/${index}/rationale`, "rationale must be useful");
  });
  requiredSubjects.forEach((subject, index) => {
    if (!seen.has(subject.key)) add(findings, "authority", `/requiredSubjects/${index}`, `missing recommendation for Core subject '${subject.key}' (${subject.storyKey})`);
  });
  return findings.length ? { ok: false, findings } : { ok: true, value: recommendations };
}

export function decodeDatabaseSchemaProposalWire(payload: unknown): DatabaseSchemaOutcome<DatabaseSchemaProposalWire> {
  const findings: DatabaseSchemaFinding[] = [];
  const root = record(payload, "/", findings);
  exact(root, ["storyCoverage", "tables", "foreignKeys"], "/", findings);
  const storyCoverage = array(root.storyCoverage, "/storyCoverage", findings).map((raw, index) => {
    const pointer = `/storyCoverage/${index}`;
    const entry = record(raw, pointer, findings);
    exact(entry, ["storyKey", "tableKeys"], pointer, findings);
    return {
      storyKey: text(entry.storyKey, `${pointer}/storyKey`, findings),
      tableKeys: array(entry.tableKeys, `${pointer}/tableKeys`, findings).map((item, itemIndex) => text(item, `${pointer}/tableKeys/${itemIndex}`, findings)),
    };
  });
  const tables = array(root.tables, "/tables", findings).map((raw, index) => {
    const pointer = `/tables/${index}`;
    const entry = record(raw, pointer, findings);
    exact(entry, ["key", "name", "purpose", "fields", "primaryKeyFieldKeys", "uniqueConstraints"], pointer, findings);
    const fields = array(entry.fields, `${pointer}/fields`, findings).map((fieldRaw, fieldIndex) => {
      const fieldPointer = `${pointer}/fields/${fieldIndex}`;
      const field = record(fieldRaw, fieldPointer, findings);
      exact(field, ["key", "name", "logicalType", "required"], fieldPointer, findings);
      return {
        key: text(field.key, `${fieldPointer}/key`, findings),
        name: text(field.name, `${fieldPointer}/name`, findings),
        logicalType: text(field.logicalType, `${fieldPointer}/logicalType`, findings),
        required: bool(field.required, `${fieldPointer}/required`, findings),
      };
    });
    const uniqueConstraints = array(entry.uniqueConstraints, `${pointer}/uniqueConstraints`, findings).map((constraintRaw, constraintIndex) => {
      const constraintPointer = `${pointer}/uniqueConstraints/${constraintIndex}`;
      const constraint = record(constraintRaw, constraintPointer, findings);
      exact(constraint, ["fieldKeys"], constraintPointer, findings);
      return { fieldKeys: array(constraint.fieldKeys, `${constraintPointer}/fieldKeys`, findings).map((item, itemIndex) => text(item, `${constraintPointer}/fieldKeys/${itemIndex}`, findings)) };
    });
    return {
      key: text(entry.key, `${pointer}/key`, findings),
      name: text(entry.name, `${pointer}/name`, findings),
      purpose: text(entry.purpose, `${pointer}/purpose`, findings),
      fields,
      primaryKeyFieldKeys: array(entry.primaryKeyFieldKeys, `${pointer}/primaryKeyFieldKeys`, findings).map((item, itemIndex) => text(item, `${pointer}/primaryKeyFieldKeys/${itemIndex}`, findings)),
      uniqueConstraints,
    };
  });
  const foreignKeys = array(root.foreignKeys, "/foreignKeys", findings).map((raw, index) => {
    const pointer = `/foreignKeys/${index}`;
    const entry = record(raw, pointer, findings);
    exact(entry, ["fromTableKey", "fromFieldKey", "toTableKey", "toFieldKey"], pointer, findings);
    return {
      fromTableKey: text(entry.fromTableKey, `${pointer}/fromTableKey`, findings),
      fromFieldKey: text(entry.fromFieldKey, `${pointer}/fromFieldKey`, findings),
      toTableKey: text(entry.toTableKey, `${pointer}/toTableKey`, findings),
      toFieldKey: text(entry.toFieldKey, `${pointer}/toFieldKey`, findings),
    };
  });
  const value: DatabaseSchemaProposalWire = { storyCoverage, tables, foreignKeys };
  return findings.length ? { ok: false, findings } : { ok: true, value };
}

function parsedKey(value: string, pointer: string, findings: DatabaseSchemaFinding[]): SemanticKey {
  const key = semanticKey(value);
  if (!key) add(findings, "semantic", pointer, `invalid SemanticKey '${value}'`);
  return key ?? semanticKey("invalid-key")!;
}

export function resolveDatabaseSchemaProposal(
  wire: DatabaseSchemaProposalWire,
  upstream: DatabaseSchemaUpstreamProjection,
  determinations: readonly DatabaseSchemaDetermination[],
  structuralDecisions: readonly DatabaseSchemaStoryPersistence[],
  interviewEvidence: readonly InterviewQuestionEvidence[] = [],
): DatabaseSchemaOutcome<DatabaseSchema> {
  const findings: DatabaseSchemaFinding[] = [];
  const decisionByStory = new Map(structuralDecisions.map((entry) => [entry.storyKey, entry]));
  const storyCoverage: DatabaseSchemaStoryCoverage[] = wire.storyCoverage.map((entry, index) => {
    const storyKey = parsedKey(entry.storyKey, `/storyCoverage/${index}/storyKey`, findings);
    return {
      storyKey,
      disposition: decisionByStory.get(storyKey)?.disposition ?? "not-persisted",
      tableKeys: entry.tableKeys.map((tableKey, tableIndex) => parsedKey(tableKey, `/storyCoverage/${index}/tableKeys/${tableIndex}`, findings)),
    };
  });
  const tables: DatabaseSchemaTable[] = wire.tables.map((table, tableIndex) => ({
    key: parsedKey(table.key, `/tables/${tableIndex}/key`, findings),
    name: table.name,
    purpose: table.purpose,
    fields: table.fields.map((field, fieldIndex) => ({
      key: parsedKey(field.key, `/tables/${tableIndex}/fields/${fieldIndex}/key`, findings),
      name: field.name,
      logicalType: field.logicalType as DatabaseSchemaLogicalType,
      required: field.required,
    })),
    primaryKeyFieldKeys: table.primaryKeyFieldKeys.map((fieldKey, fieldIndex) => parsedKey(fieldKey, `/tables/${tableIndex}/primaryKeyFieldKeys/${fieldIndex}`, findings)),
    uniqueConstraints: table.uniqueConstraints.map((constraint, constraintIndex) => ({
      fieldKeys: constraint.fieldKeys.map((fieldKey, fieldIndex) => parsedKey(fieldKey, `/tables/${tableIndex}/uniqueConstraints/${constraintIndex}/fieldKeys/${fieldIndex}`, findings)),
    })),
  }));
  const foreignKeys: DatabaseSchemaForeignKey[] = wire.foreignKeys.map((entry, index) => ({
    fromTableKey: parsedKey(entry.fromTableKey, `/foreignKeys/${index}/fromTableKey`, findings),
    fromFieldKey: parsedKey(entry.fromFieldKey, `/foreignKeys/${index}/fromFieldKey`, findings),
    toTableKey: parsedKey(entry.toTableKey, `/foreignKeys/${index}/toTableKey`, findings),
    toFieldKey: parsedKey(entry.toFieldKey, `/foreignKeys/${index}/toFieldKey`, findings),
  }));
  if (findings.length) return { ok: false, findings };
  return validateDatabaseSchema({
    contract: DATABASE_SCHEMA_CONTRACT,
    stage: "database-schema",
    projectKey: upstream.userStories.projectKey,
    determinations,
    structuralDecisions,
    disposition: deriveDatabaseSchemaDisposition(structuralDecisions),
    storyCoverage,
    tables,
    foreignKeys,
  }, upstream, interviewEvidence);
}

export type DerivedRelationshipCardinality = "many-to-one" | "one-to-one" | "zero-or-one-to-one" | "zero-or-more-to-one";

export function deriveForeignKeyRelationship(
  schema: DatabaseSchema,
  foreignKey: DatabaseSchemaForeignKey,
): DerivedRelationshipCardinality {
  const table = schema.tables.find((entry) => entry.key === foreignKey.fromTableKey);
  const field = table?.fields.find((entry) => entry.key === foreignKey.fromFieldKey);
  if (!table || !field) throw new Error("DATABASE_SCHEMA_RELATIONSHIP_INVALID: foreign-key source does not exist");
  const unique = (table.primaryKeyFieldKeys.length === 1 && table.primaryKeyFieldKeys[0] === field.key)
    || table.uniqueConstraints.some((constraint) => constraint.fieldKeys.length === 1 && constraint.fieldKeys[0] === field.key);
  if (field.required && unique) return "one-to-one";
  if (field.required) return "many-to-one";
  if (unique) return "zero-or-one-to-one";
  return "zero-or-more-to-one";
}
