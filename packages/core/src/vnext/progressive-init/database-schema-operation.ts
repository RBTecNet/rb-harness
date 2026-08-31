import {
  pendingQuestionEvidence,
  selectInterviewAnswer,
  type InterviewQuestionEvidence,
} from "../interview.js";
import type { InitInterviewMode } from "../init.js";
import type { ModelProfile, ProviderAdapter, ResolvedProviderAuth, SemanticRequest } from "../providers/contract.js";
import { progressiveCanonicalJson } from "./canonical-json.js";
import { renderDatabaseSchemaProposal } from "./database-schema-document.js";
import {
  DATABASE_SCHEMA_PERSISTENCE_QUESTIONS_SCHEMA,
  DATABASE_SCHEMA_PROPOSAL_SCHEMA,
  DATABASE_SCHEMA_CONTRACT,
  canonicalizeDatabaseSchema,
  decodeDatabaseSchemaProposalWire,
  decodeDatabaseSchemaQuestionSelection,
  deriveDatabaseSchemaDisposition,
  materializeStoryPersistenceAuthority,
  requiredStoryPersistenceSubjects,
  resolveDatabaseSchemaProposal,
  validateDatabaseSchema,
  type DatabaseSchema,
  type DatabaseSchemaFinding,
  type DatabaseSchemaForeignKey,
  type DatabaseSchemaStoryCoverage,
  type DatabaseSchemaUpstreamProjection,
  type StoryPersistenceRecommendation,
  type StoryPersistenceSubject,
} from "./database-schema-ir.js";

export const DATABASE_SCHEMA_PERSISTENCE_INSTRUCTIONS = [
  "Recommend exactly one Core-owned persistence option for every supplied storyPersistenceSubject.",
  "Core owns every subject, story identity, option key, structural decision, determination, and authority record.",
  "Return exactly one recommendation for each supplied subject. Do not add, omit, merge, or replace subjects.",
  "Use only the exact Core option keys persisted or not-persisted.",
  "Question wording and rationale are presentation only and cannot create database structure.",
  "Do not author tables, fields, schema, determinations, structural decisions, approval, or Markdown.",
].join("\n");

export const DATABASE_SCHEMA_PROPOSAL_INSTRUCTIONS = [
  "Produce one complete non-authoritative logical relational database-schema proposal using only the strict schema-body shape.",
  "The developer-selected story persistence decisions are authoritative. A not-persisted story must have no table mappings.",
  "Every persisted story must map to at least one proposed table, and every proposed table must serve at least one persisted story.",
  "Use only the supplied logical type vocabulary. Composite primary keys are allowed; foreign keys are single-field only.",
  "Foreign-key targets must be a single-field primary key or a single-field unique constraint and endpoint logical types must match.",
  "Many-to-many semantics require an explicit junction table. Do not emit relationship cardinality.",
  "Do not infer tables or fields by convention. Do not add timestamps, auth, audit, tenant, soft-delete, or generated IDs unless the exact approved upstream story semantics justify them.",
  "Do not emit contract, stage, projectKey, disposition, authority, determinations, structural decisions, approval, hashes, proposal IDs, or Markdown.",
  "Return a complete candidate, never a patch.",
].join("\n");

export interface DatabaseSchemaOperationOptions {
  readonly upstream: DatabaseSchemaUpstreamProjection;
  readonly existing?: DatabaseSchema;
  readonly profile: ModelProfile;
  readonly adapter: ProviderAdapter;
  readonly auth: ResolvedProviderAuth;
  readonly interview: InitInterviewMode;
  readonly deadlineMs: number;
  readonly signal?: AbortSignal;
  readonly onQuestion?: (question: InterviewQuestionEvidence) => void | Promise<void>;
}

export interface DatabaseSchemaOperationResult {
  readonly value: DatabaseSchema;
  readonly interviewEvidence: readonly InterviewQuestionEvidence[];
  readonly semanticOperations: number;
  readonly correctiveRegenerations: number;
  readonly findingsByAttempt: readonly (readonly DatabaseSchemaFinding[])[];
}

const STRUCTURAL_INTERACTIVE_ATTEMPTS = 3;

function requestFor(
  options: DatabaseSchemaOperationOptions,
  slice: string,
  instructions: string,
  input: unknown,
  schema: SemanticRequest["schema"],
  schemaName: string,
  signal: AbortSignal,
): SemanticRequest {
  return {
    slice,
    instructions,
    input: JSON.stringify(input, null, 2),
    schema,
    schemaName,
    limits: { maxOutputTokens: Math.min(options.profile.maxOutputTokens, 128_000), deadlineMs: options.deadlineMs },
    reasoning: options.profile.reasoning.supported && options.profile.reasoning.defaultMode === "on"
      ? { mode: "on", effort: options.profile.reasoning.efforts[0]! }
      : { mode: "off" },
    signal,
  };
}

async function providerRequest(
  options: DatabaseSchemaOperationOptions,
  request: SemanticRequest,
  failureCode: string,
): Promise<unknown> {
  const capability = options.adapter.checkCapabilities(options.profile, request);
  if (!capability.ok) throw new Error(`${failureCode}: ${capability.error.message}`);
  const outcome = await options.adapter.request(options.profile, options.auth, request);
  if (!outcome.ok) throw new Error(`${failureCode}: ${outcome.error.message}`);
  return outcome.value.payload;
}

function optionFromResponse<T extends { readonly key: string; readonly label?: string }>(values: readonly T[], response: string): T | undefined {
  const normalized = response.trim();
  const ordinal = /^\d+$/.test(normalized) ? Number(normalized) : 0;
  if (ordinal >= 1 && ordinal <= values.length) return values[ordinal - 1];
  const byKey = values.find((entry) => entry.key === normalized);
  if (byKey) return byKey;
  const normalizedLabel = normalized.toLowerCase();
  return values.find((entry) => entry.label?.trim().toLowerCase() === normalizedLabel);
}

function persistenceQuestion(
  subject: StoryPersistenceSubject,
  recommendation: StoryPersistenceRecommendation,
): InterviewQuestionEvidence {
  const recommended = subject.options.find((entry) => entry.key === recommendation.recommendedOptionKey)!;
  return {
    ...pendingQuestionEvidence({
      key: subject.key,
      question: recommendation.question,
      materiality: "architecture",
      rigidity: "RIGID",
      recommendedAnswer: { value: recommended.label, rationale: recommendation.rationale },
      alternatives: [],
    }),
    choices: subject.options.map((entry) => ({ label: entry.label, details: [`Story: ${subject.storyKey}`, `Option key: ${entry.key}`] })),
    recommendedLabel: recommended.label,
    answerPrompt: "Choice (blank accepts recommendation): ",
  };
}

async function resolvePersistenceQuestion(
  options: DatabaseSchemaOperationOptions,
  subject: StoryPersistenceSubject,
  pending: InterviewQuestionEvidence,
): Promise<InterviewQuestionEvidence> {
  if (options.interview.kind === "headless") {
    throw new Error("DATABASE_SCHEMA_INTERACTIVE_AUTHORITY_REQUIRED: incomplete or stale database-schema requires interactive developer authority");
  }
  for (let attempt = 0; attempt < STRUCTURAL_INTERACTIVE_ATTEMPTS; attempt += 1) {
    const prompt = attempt === 0 ? pending : { ...pending, question: `Invalid persistence selection. Enter a listed number, exact Core option key, exact displayed Core option label, or blank for the recommendation. ${pending.question}` };
    await options.onQuestion?.(prompt);
    const response = await options.interview.answer(prompt);
    if (!response.trim()) return selectInterviewAnswer(pending, { kind: "interactive", response: "" });
    const selected = optionFromResponse(subject.options, response);
    if (selected) return selectInterviewAnswer(pending, { kind: "interactive", response: selected.label });
  }
  throw new Error(`DATABASE_SCHEMA_PERSISTENCE_SELECTION_INVALID: story '${subject.storyKey}' requires a listed number, option key, or displayed option label`);
}

async function selectPersistenceAuthority(
  options: DatabaseSchemaOperationOptions,
  signal: AbortSignal,
): Promise<{ readonly evidence: readonly InterviewQuestionEvidence[]; readonly semanticOperations: number }> {
  const requiredSubjects = requiredStoryPersistenceSubjects(options.upstream, options.existing);
  if (!requiredSubjects.length) return { evidence: [], semanticOperations: 0 };
  const request = requestFor(
    options,
    "database-schema-persistence-questions",
    DATABASE_SCHEMA_PERSISTENCE_INSTRUCTIONS,
    {
      task: "Recommend one persistence disposition for every Core-owned User Story subject.",
      upstream: options.upstream,
      storyPersistenceSubjects: requiredSubjects,
      existingDeveloperAuthority: options.existing ?? null,
    },
    DATABASE_SCHEMA_PERSISTENCE_QUESTIONS_SCHEMA,
    "rb_database_schema_persistence_questions_v1",
    signal,
  );
  const decoded = decodeDatabaseSchemaQuestionSelection(
    await providerRequest(options, request, "DATABASE_SCHEMA_PERSISTENCE_RECOMMENDATION_PROVIDER_FAILURE"),
    requiredSubjects,
  );
  if (!decoded.ok) {
    throw new Error(`DATABASE_SCHEMA_PERSISTENCE_RECOMMENDATION_INVALID: ${decoded.findings.map((entry) => `${entry.pointer}: ${entry.message}`).join("; ")}`);
  }
  const bySubject = new Map(decoded.value.map((entry) => [entry.subjectKey, entry]));
  const evidence: InterviewQuestionEvidence[] = [];
  for (const subject of requiredSubjects) {
    evidence.push(await resolvePersistenceQuestion(options, subject, persistenceQuestion(subject, bySubject.get(subject.key)!)));
  }
  return { evidence, semanticOperations: 1 };
}

function notApplicableValue(
  options: DatabaseSchemaOperationOptions,
  determinations: DatabaseSchema["determinations"],
  structuralDecisions: DatabaseSchema["structuralDecisions"],
): DatabaseSchema {
  const storyCoverage: DatabaseSchemaStoryCoverage[] = structuralDecisions.map((decision) => ({
    storyKey: decision.storyKey,
    disposition: decision.disposition,
    tableKeys: [],
  }));
  return canonicalizeDatabaseSchema({
    contract: DATABASE_SCHEMA_CONTRACT,
    stage: "database-schema",
    projectKey: options.upstream.userStories.projectKey,
    determinations,
    structuralDecisions,
    disposition: "not-applicable",
    storyCoverage,
    tables: [],
    foreignKeys: [],
  });
}

interface DatabaseSchemaChangeSummary {
  readonly tablesAdded: readonly string[];
  readonly tablesRemoved: readonly string[];
  readonly tablesChanged: readonly string[];
  readonly storyMappingsChanged: readonly string[];
  readonly foreignKeysAdded: readonly string[];
  readonly foreignKeysRemoved: readonly string[];
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function foreignKeyLabel(value: DatabaseSchemaForeignKey): string {
  return `${value.fromTableKey}.${value.fromFieldKey} -> ${value.toTableKey}.${value.toFieldKey}`;
}

function databaseSchemaChangeSummary(existing: DatabaseSchema, candidate: DatabaseSchema): DatabaseSchemaChangeSummary | undefined {
  const existingTables = new Map(existing.tables.map((entry) => [entry.key, entry]));
  const candidateTables = new Map(candidate.tables.map((entry) => [entry.key, entry]));
  const tablesAdded = [...candidateTables.keys()].filter((key) => !existingTables.has(key)).sort(compare);
  const tablesRemoved = [...existingTables.keys()].filter((key) => !candidateTables.has(key)).sort(compare);
  const tablesChanged = [...candidateTables.keys()].filter((key) => {
    const previous = existingTables.get(key);
    return previous !== undefined && progressiveCanonicalJson(previous) !== progressiveCanonicalJson(candidateTables.get(key));
  }).sort(compare);

  const existingMappings = new Map(existing.storyCoverage.map((entry) => [entry.storyKey, entry]));
  const candidateMappings = new Map(candidate.storyCoverage.map((entry) => [entry.storyKey, entry]));
  const storyMappingsChanged = [...new Set([...existingMappings.keys(), ...candidateMappings.keys()])]
    .filter((key) => progressiveCanonicalJson(existingMappings.get(key) ?? null) !== progressiveCanonicalJson(candidateMappings.get(key) ?? null))
    .sort(compare);

  const existingForeignKeys = new Map(existing.foreignKeys.map((entry) => [progressiveCanonicalJson(entry), entry]));
  const candidateForeignKeys = new Map(candidate.foreignKeys.map((entry) => [progressiveCanonicalJson(entry), entry]));
  const foreignKeysAdded = [...candidateForeignKeys.entries()]
    .filter(([key]) => !existingForeignKeys.has(key))
    .map(([, value]) => foreignKeyLabel(value))
    .sort(compare);
  const foreignKeysRemoved = [...existingForeignKeys.entries()]
    .filter(([key]) => !candidateForeignKeys.has(key))
    .map(([, value]) => foreignKeyLabel(value))
    .sort(compare);
  const summary = { tablesAdded, tablesRemoved, tablesChanged, storyMappingsChanged, foreignKeysAdded, foreignKeysRemoved };
  return Object.values(summary).some((entries) => entries.length) ? summary : undefined;
}

function renderDatabaseSchemaChangeSummary(summary: DatabaseSchemaChangeSummary): string {
  const list = (values: readonly string[]): string => values.length ? values.join(", ") : "(none)";
  return [
    "Database schema change summary (Core-generated)",
    `Tables added: ${list(summary.tablesAdded)}`,
    `Tables removed: ${list(summary.tablesRemoved)}`,
    `Tables changed: ${list(summary.tablesChanged)}`,
    `Story mappings changed: ${list(summary.storyMappingsChanged)}`,
    `Foreign keys added: ${list(summary.foreignKeysAdded)}`,
    `Foreign keys removed: ${list(summary.foreignKeysRemoved)}`,
  ].join("\n");
}

function approvalQuestion(proposalSource: string, changeSummary?: string): InterviewQuestionEvidence {
  const presentation = changeSummary ? `${changeSummary}\n\n${proposalSource.trimEnd()}` : proposalSource.trimEnd();
  return {
    key: "approve-database-schema-proposal",
    question: `${presentation}\n\nApprove the exact validated database schema proposal displayed above?`,
    materiality: "architecture",
    rigidity: "RIGID",
    recommendedAnswer: {
      value: "Explicit selection required",
      rationale: "Core cannot recommend or silently approve provider-authored database structure.",
    },
    alternatives: [],
    persistedBeforeSelection: true,
    presented: false,
    response: null,
    selectedValue: null,
    acceptanceMode: null,
    choices: [
      { label: "Approve exact proposal", details: ["Option key: approve"] },
      { label: "Reject proposal", details: ["Option key: reject"] },
    ],
    showRecommendation: false,
    answerPrompt: "Choice (blank is not accepted): ",
  };
}

async function requireProposalApproval(
  options: DatabaseSchemaOperationOptions,
  proposalSource: string,
  changeSummary?: string,
): Promise<void> {
  if (options.interview.kind === "headless") {
    throw new Error("DATABASE_SCHEMA_INTERACTIVE_AUTHORITY_REQUIRED: provider-authored schema proposal requires explicit developer approval");
  }
  const base = approvalQuestion(proposalSource, changeSummary);
  const approvalOptions = [{ key: "approve" }, { key: "reject" }] as const;
  for (let attempt = 0; attempt < STRUCTURAL_INTERACTIVE_ATTEMPTS; attempt += 1) {
    const prompt = attempt === 0 ? base : { ...base, question: `Invalid approval selection. Enter 1, 2, approve, or reject; blank is not accepted. ${base.question}` };
    await options.onQuestion?.(prompt);
    const selected = optionFromResponse(approvalOptions, await options.interview.answer(prompt));
    if (selected?.key === "approve") return;
    if (selected?.key === "reject") {
      throw new Error(options.existing
        ? "DATABASE_SCHEMA_PROPOSAL_REJECTED: proposal rejected; the existing database-schema artifact was preserved unchanged"
        : "DATABASE_SCHEMA_PROPOSAL_REJECTED: proposal rejected; no database-schema artifact was written");
    }
  }
  throw new Error("DATABASE_SCHEMA_PROPOSAL_APPROVAL_INVALID: explicit approve or reject selection is required");
}

export async function runDatabaseSchemaOperation(options: DatabaseSchemaOperationOptions): Promise<DatabaseSchemaOperationResult> {
  if (options.interview.kind === "headless") {
    throw new Error("DATABASE_SCHEMA_INTERACTIVE_AUTHORITY_REQUIRED: incomplete or stale database-schema requires interactive developer authority");
  }
  const controller = options.signal ? undefined : new AbortController();
  const signal = options.signal ?? controller!.signal;
  const selection = await selectPersistenceAuthority(options, signal);
  const requiredSubjects = requiredStoryPersistenceSubjects(options.upstream, options.existing);
  const materialized = materializeStoryPersistenceAuthority(requiredSubjects, selection.evidence, options.existing);
  if (!materialized.ok) {
    throw new Error(`DATABASE_SCHEMA_PERSISTENCE_AUTHORITY_INVALID: ${materialized.findings.map((entry) => `${entry.pointer}: ${entry.message}`).join("; ")}`);
  }
  const disposition = deriveDatabaseSchemaDisposition(materialized.value.structuralDecisions);
  if (disposition === "not-applicable") {
    const value = notApplicableValue(options, materialized.value.determinations, materialized.value.structuralDecisions);
    const validated = validateDatabaseSchema(value, options.upstream, selection.evidence);
    if (!validated.ok) throw new Error(`DATABASE_SCHEMA_NOT_APPLICABLE_INVALID: ${validated.findings.map((entry) => `${entry.pointer}: ${entry.message}`).join("; ")}`);
    return {
      value: validated.value,
      interviewEvidence: selection.evidence,
      semanticOperations: selection.semanticOperations,
      correctiveRegenerations: 0,
      findingsByAttempt: [],
    };
  }

  const findingsByAttempt: DatabaseSchemaFinding[][] = [];
  let previous: readonly DatabaseSchemaFinding[] | undefined;
  for (let ordinal = 0; ordinal < 2; ordinal += 1) {
    const request = requestFor(
      options,
      "database-schema-proposal",
      DATABASE_SCHEMA_PROPOSAL_INSTRUCTIONS,
      {
        task: previous
          ? "Regenerate the COMPLETE logical relational schema proposal; do not patch the rejected candidate."
          : "Create one complete logical relational schema proposal for the approved persistence decisions.",
        upstream: options.upstream,
        storyPersistenceDecisions: materialized.value.structuralDecisions.map(({ storyKey, disposition: selectedDisposition }) => ({ storyKey, disposition: selectedDisposition })),
        existingDeveloperAuthority: options.existing ?? null,
        ...(previous ? { recovery: { completeCandidateRegeneration: true, immediatelyPrecedingFindings: previous.map(({ pointer, message }) => ({ pointer, message })) } } : {}),
      },
      DATABASE_SCHEMA_PROPOSAL_SCHEMA,
      "rb_database_schema_proposal_v1",
      signal,
    );
    const decoded = decodeDatabaseSchemaProposalWire(await providerRequest(options, request, "DATABASE_SCHEMA_PROPOSAL_PROVIDER_FAILURE"));
    let findings: readonly DatabaseSchemaFinding[];
    let candidate: DatabaseSchema | undefined;
    if (!decoded.ok) findings = decoded.findings;
    else {
      const resolved = resolveDatabaseSchemaProposal(
        decoded.value,
        options.upstream,
        materialized.value.determinations,
        materialized.value.structuralDecisions,
        selection.evidence,
      );
      if (!resolved.ok) findings = resolved.findings;
      else {
        findings = [];
        candidate = resolved.value;
      }
    }
    if (candidate) {
      const proposalSource = renderDatabaseSchemaProposal(candidate);
      const changeSummary = options.existing?.disposition === "applicable"
        ? databaseSchemaChangeSummary(options.existing, candidate)
        : undefined;
      await requireProposalApproval(options, proposalSource, changeSummary ? renderDatabaseSchemaChangeSummary(changeSummary) : undefined);
      return {
        value: candidate,
        interviewEvidence: selection.evidence,
        semanticOperations: selection.semanticOperations + ordinal + 1,
        correctiveRegenerations: ordinal,
        findingsByAttempt,
      };
    }
    findingsByAttempt.push([...findings]);
    previous = findings;
  }
  throw new Error(`DATABASE_SCHEMA_PROPOSAL_INVALID_AFTER_RECOVERY: ${previous?.map((entry) => `${entry.pointer}: ${entry.message}`).join("; ")}`);
}
