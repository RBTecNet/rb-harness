import type { InterviewQuestionEvidence } from "../interview.js";
import type { InitInterviewMode } from "../init.js";
import type { ModelProfile, ProviderAdapter, ResolvedProviderAuth, SemanticRequest } from "../providers/contract.js";
import { progressiveCanonicalJson } from "./canonical-json.js";
import { validateCompiledProjectPhases } from "./project-phases-compiler.js";
import { renderProjectPhasesProposal } from "./project-phases-document.js";
import {
  PROJECT_PHASES_PROPOSAL_SCHEMA,
  decodeProjectPhasesProposalWire,
  deriveImplementationSubjects,
  resolveProjectPhasesProposal,
  validateProjectPhases,
  type ProjectPhases,
  type ProjectPhasesFinding,
  type ProjectPhasesUpstreamProjection,
} from "./project-phases-ir.js";

export const PROJECT_PHASES_PROPOSAL_INSTRUCTIONS = [
  "Produce ONE complete non-authoritative Project Phases proposal using only the supplied provider-wire fields.",
  "ImplementationSubjects are a closed Core-owned universe. Choose coverageKeys only from the exact supplied subject keys; do not create, rename, define, rewrite, or omit subjects.",
  "Every supplied ImplementationSubject must be covered by at least one task, and every task must cover at least one subject.",
  "A table subject means the task implements or modifies that approved logical table structure; read-only frontend, API, or documentation work must not claim table coverage merely because it reads persisted data.",
  "Task dependencies may reference only supplied task keys in the same or an earlier phase, must be acyclic, and must point backward in declaration order. Do not invent dependencies.",
  "ownedPaths may name existing or future safe project-relative implementation paths. Never use .rb, .rb-harness, .git, .spec/init, traversal, absolute paths, or project-wide globs.",
  "Command validation may reference only an exact supplied P1 quality-command key. Never emit shell command strings. Manual and human validation are legal when no command applies.",
  "Task acceptance is implementation acceptance, not a rewrite of P2 business acceptance. Keep it self-contained, functional, non-visual, and within the supplied canonical ceilings.",
  "Do not author contract, stage, projectKey, subjects, requirements, covers IDs, determinations, developer provenance, protected paths, numeric P/R/T/AC IDs, parallelSafe, hashes, approval, runId, generatedAt, manifest data, provider metadata, or Markdown.",
  "Return the complete candidate, never a patch, summary, rationale, or partial task update.",
].join("\n");

export interface ProjectPhasesOperationOptions {
  readonly upstream: ProjectPhasesUpstreamProjection;
  readonly existing?: ProjectPhases;
  readonly existingRepositoryPaths?: readonly string[];
  readonly profile: ModelProfile;
  readonly adapter: ProviderAdapter;
  readonly auth: ResolvedProviderAuth;
  readonly interview: InitInterviewMode;
  readonly deadlineMs: number;
  readonly signal?: AbortSignal;
  readonly onQuestion?: (question: InterviewQuestionEvidence) => void | Promise<void>;
}

export interface ProjectPhasesOperationResult {
  readonly value: ProjectPhases;
  readonly semanticOperations: number;
  readonly correctiveRegenerations: number;
  readonly findingsByAttempt: readonly (readonly ProjectPhasesFinding[])[];
}

interface ProjectPhasesChangeSummary {
  readonly phasesAdded: readonly string[];
  readonly phasesRemoved: readonly string[];
  readonly phasesChanged: readonly string[];
  readonly tasksAdded: readonly string[];
  readonly tasksRemoved: readonly string[];
  readonly tasksChanged: readonly string[];
  readonly coverageAssignmentsChanged: readonly string[];
  readonly ownedPathsChanged: readonly string[];
  readonly dependenciesChanged: readonly string[];
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function changeSummary(existing: ProjectPhases, candidate: ProjectPhases): ProjectPhasesChangeSummary {
  const oldPhases = new Map(existing.phases.map((phase) => [phase.key, phase]));
  const newPhases = new Map(candidate.phases.map((phase) => [phase.key, phase]));
  const oldTasks = new Map(existing.phases.flatMap((phase) => phase.tasks.map((task) => [task.key, { phaseKey: phase.key, task }] as const)));
  const newTasks = new Map(candidate.phases.flatMap((phase) => phase.tasks.map((task) => [task.key, { phaseKey: phase.key, task }] as const)));
  const phasesAdded = [...newPhases.keys()].filter((key) => !oldPhases.has(key)).sort(compare);
  const phasesRemoved = [...oldPhases.keys()].filter((key) => !newPhases.has(key)).sort(compare);
  const phasesChanged = [...newPhases.keys()].filter((key) => {
    const previous = oldPhases.get(key);
    const next = newPhases.get(key)!;
    return previous !== undefined && progressiveCanonicalJson({ title: previous.title, goal: previous.goal }) !== progressiveCanonicalJson({ title: next.title, goal: next.goal });
  }).sort(compare);
  const tasksAdded = [...newTasks.keys()].filter((key) => !oldTasks.has(key)).sort(compare);
  const tasksRemoved = [...oldTasks.keys()].filter((key) => !newTasks.has(key)).sort(compare);
  const tasksChanged = [...newTasks.keys()].filter((key) => {
    const previous = oldTasks.get(key);
    const next = newTasks.get(key)!;
    if (!previous) return false;
    const shape = (entry: typeof next) => ({
      phaseKey: entry.phaseKey,
      title: entry.task.title,
      intent: entry.task.intent,
      acceptance: entry.task.acceptance,
      validation: entry.task.validation,
      expectedEvidence: entry.task.expectedEvidence,
    });
    return progressiveCanonicalJson(shape(previous)) !== progressiveCanonicalJson(shape(next));
  }).sort(compare);
  const changedBy = (field: "coverageKeys" | "ownedPaths" | "dependsOn") => [...newTasks.keys()].filter((key) => {
    const previous = oldTasks.get(key)?.task;
    const next = newTasks.get(key)?.task;
    return previous !== undefined && next !== undefined && progressiveCanonicalJson(previous[field]) !== progressiveCanonicalJson(next[field]);
  }).sort(compare);
  return {
    phasesAdded,
    phasesRemoved,
    phasesChanged,
    tasksAdded,
    tasksRemoved,
    tasksChanged,
    coverageAssignmentsChanged: changedBy("coverageKeys"),
    ownedPathsChanged: changedBy("ownedPaths"),
    dependenciesChanged: changedBy("dependsOn"),
  };
}

function renderChangeSummary(summary: ProjectPhasesChangeSummary): string {
  const list = (values: readonly string[]): string => values.length ? values.join(", ") : "(none)";
  return [
    "Project phases change summary (Core-generated)",
    `Phases added: ${list(summary.phasesAdded)}`,
    `Phases removed: ${list(summary.phasesRemoved)}`,
    `Phases changed: ${list(summary.phasesChanged)}`,
    `Tasks added: ${list(summary.tasksAdded)}`,
    `Tasks removed: ${list(summary.tasksRemoved)}`,
    `Tasks changed: ${list(summary.tasksChanged)}`,
    `Coverage assignments changed: ${list(summary.coverageAssignmentsChanged)}`,
    `Owned paths changed: ${list(summary.ownedPathsChanged)}`,
    `Dependencies changed: ${list(summary.dependenciesChanged)}`,
  ].join("\n");
}

function approvalQuestion(proposal: string, summary?: string): InterviewQuestionEvidence {
  const presentation = summary ? `${summary}\n\n${proposal.trimEnd()}` : proposal.trimEnd();
  return {
    key: "approve-project-phases-proposal",
    question: `${presentation}\n\nApprove the exact validated Project Phases candidate displayed above?`,
    materiality: "implementation",
    rigidity: "RIGID",
    recommendedAnswer: {
      value: "Explicit selection required",
      rationale: "Core cannot recommend or silently approve provider-authored execution structure.",
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

function approvalSelection(response: string): "approve" | "reject" | undefined {
  const normalized = response.trim().toLowerCase();
  if (normalized === "1" || normalized === "approve" || normalized === "approve exact proposal") return "approve";
  if (normalized === "2" || normalized === "reject" || normalized === "reject proposal") return "reject";
  return undefined;
}

async function requireApproval(options: ProjectPhasesOperationOptions, proposal: string, summary?: string): Promise<void> {
  if (options.interview.kind === "headless") throw new Error("PROJECT_PHASES_INTERACTIVE_AUTHORITY_REQUIRED: provider-authored Project Phases requires explicit developer approval");
  const base = approvalQuestion(proposal, summary);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const question = attempt === 0 ? base : {
      ...base,
      question: `Invalid approval selection. Enter 1, 2, approve, reject, or an exact displayed Core label; blank is not accepted. ${base.question}`,
    };
    await options.onQuestion?.(question);
    const selected = approvalSelection(await options.interview.answer(question));
    if (selected === "approve") return;
    if (selected === "reject") {
      throw new Error(options.existing
        ? "PROJECT_PHASES_PROPOSAL_REJECTED: proposal rejected; the existing project-phases artifact was preserved unchanged"
        : "PROJECT_PHASES_PROPOSAL_REJECTED: proposal rejected; no project-phases artifact was written");
    }
  }
  throw new Error("PROJECT_PHASES_PROPOSAL_APPROVAL_INVALID: explicit approve or reject selection is required");
}

function requestFor(
  options: ProjectPhasesOperationOptions,
  input: unknown,
  signal: AbortSignal,
): SemanticRequest {
  return {
    slice: "project-phases",
    instructions: PROJECT_PHASES_PROPOSAL_INSTRUCTIONS,
    input: JSON.stringify(input, null, 2),
    schema: PROJECT_PHASES_PROPOSAL_SCHEMA,
    schemaName: "rb_project_phases_proposal_v1",
    limits: { maxOutputTokens: Math.min(options.profile.maxOutputTokens, 128_000), deadlineMs: options.deadlineMs },
    reasoning: options.profile.reasoning.supported && options.profile.reasoning.defaultMode === "on"
      ? { mode: "on", effort: options.profile.reasoning.efforts[0]! }
      : { mode: "off" },
    signal,
  };
}

async function providerPayload(options: ProjectPhasesOperationOptions, request: SemanticRequest): Promise<unknown> {
  const capability = options.adapter.checkCapabilities(options.profile, request);
  if (!capability.ok) throw new Error(`PROJECT_PHASES_PROVIDER_FAILURE: ${capability.error.message}`);
  const response = await options.adapter.request(options.profile, options.auth, request);
  if (!response.ok) throw new Error(`PROJECT_PHASES_PROVIDER_FAILURE: ${response.error.message}`);
  return response.value.payload;
}

export async function runProjectPhasesOperation(options: ProjectPhasesOperationOptions): Promise<ProjectPhasesOperationResult> {
  if (options.interview.kind === "headless") {
    throw new Error("PROJECT_PHASES_INTERACTIVE_AUTHORITY_REQUIRED: incomplete or stale project-phases requires interactive developer authority");
  }
  const controller = options.signal ? undefined : new AbortController();
  const signal = options.signal ?? controller!.signal;
  const subjects = deriveImplementationSubjects(options.upstream);
  const findingsByAttempt: ProjectPhasesFinding[][] = [];
  let previous: readonly ProjectPhasesFinding[] | undefined;
  for (let ordinal = 0; ordinal < 2; ordinal += 1) {
    const input = {
      task: previous
        ? "Regenerate the COMPLETE Project Phases candidate; do not patch or splice the rejected candidate."
        : "Create one complete Project Phases candidate for exact developer approval.",
      upstreamAuthority: options.upstream,
      implementationSubjects: subjects,
      qualityCommandKeys: options.upstream.projectDescription.qualityCommands.map((command) => command.key),
      pathContract: {
        pathsMayBeFuture: true,
        protectedRoots: [".rb", ".rb-harness", ".git", ".spec/init"],
        ownedPathsPerTaskMaximum: 8,
      },
      canonicalCeilings: { tasksPerPhase: 12, acceptanceItemsPerTask: 6 },
      existingDeveloperAuthority: options.existing ?? null,
      repositoryPathContext: (options.existingRepositoryPaths ?? []).slice(0, 1_000).map((path) => ({ path, disposition: "existing" })),
      ...(previous ? { recovery: { completeCandidateRegeneration: true, immediatelyPrecedingFindings: previous.map(({ pointer, message }) => ({ pointer, message })) } } : {}),
    };
    const decoded = decodeProjectPhasesProposalWire(await providerPayload(options, requestFor(options, input, signal)));
    let candidate: ProjectPhases | undefined;
    let findings: readonly ProjectPhasesFinding[];
    if (!decoded.ok) findings = decoded.findings;
    else {
      const resolved = resolveProjectPhasesProposal(decoded.value, options.upstream);
      const validation = validateProjectPhases(resolved, options.upstream);
      if (!validation.ok) findings = validation.findings;
      else {
        const canonical = validateCompiledProjectPhases(options.upstream, resolved, {
          originalRequest: options.upstream.projectDescription.originalRequest,
          runId: "candidate-validation",
          generatedAt: "2000-01-01T00:00:00.000Z",
        });
        if (!canonical.ok) {
          findings = canonical.findings.map((entry) => ({ code: "semantic" as const, pointer: entry.pointer, message: `${entry.invariant}: ${entry.message}` }));
        } else {
          findings = [];
          candidate = resolved;
        }
      }
    }
    if (candidate) {
      const proposal = renderProjectPhasesProposal(candidate);
      const summary = options.existing ? renderChangeSummary(changeSummary(options.existing, candidate)) : undefined;
      await requireApproval(options, proposal, summary);
      return {
        value: candidate,
        semanticOperations: ordinal + 1,
        correctiveRegenerations: ordinal,
        findingsByAttempt,
      };
    }
    findingsByAttempt.push([...findings]);
    previous = findings;
  }
  throw new Error(`PROJECT_PHASES_PROPOSAL_INVALID_AFTER_RECOVERY: ${previous?.map((entry) => `${entry.pointer}: ${entry.message}`).join("; ")}`);
}
