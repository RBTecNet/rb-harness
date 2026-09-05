import { pendingQuestionEvidence, selectInterviewAnswer, type InterviewQuestionEvidence } from "../interview.js";
import type { ModelProfile, ProviderAdapter, ResolvedProviderAuth, SemanticRequest } from "../providers/contract.js";
import type { InitInterviewMode } from "../init.js";
import type { ProjectDescriptionDiscovery } from "./discovery.js";
import {
  PROJECT_DESCRIPTION_SCHEMA,
  decodeProjectDescriptionWire,
  resolveProjectDescriptionWire,
  validateProjectDescriptionCapabilityWorkflowConsistency,
  validateProjectDescriptionPreservation,
  type ProjectDescription,
  type ProjectDescriptionFinding,
  type ProjectDescriptionWire,
} from "./project-description-ir.js";

export const PROJECT_DESCRIPTION_INSTRUCTIONS = [
  "Produce the complete project-description stage object described by the schema.",
  "This stage owns project identity, objective, actors, MVP capabilities and workflows, constraints, determinations, and terminating quality commands only.",
  "Use stable lower-case kebab-case semantic keys. Do not emit phases, tasks, paths, machine IDs, document syntax, or future-stage semantics.",
  "Repository discovery is bounded evidence, not permission to copy secrets or invent requirements.",
  "Every material ambiguity must be a stage-specific question with one concrete recommendation, rationale, and alternatives.",
  "Core materializes every resolved question as an authority-bearing determination. Do not restate interview-backed determinations in determinations.",
  "Provider-authored determinations may use only request or model-default authority.",
  "Every approved capability must be referenced by at least one approved workflow.",
  "A RIGID product or architecture determination cannot use silent model-default authority.",
  "For source.kind=request, omit statement and select the smallest useful complete contiguous request clause or span that expresses the fact to preserve; Core derives the authority-bearing statement from verified evidence.",
  "Do not present interpretations beyond the literal request span as request authority; use model-default where permitted or a material question where stronger authority is required.",
  "Provider output cannot claim developer authority; developer authority exists only in a validated persisted project-description document.",
  "Return a complete candidate. Never return a patch or Markdown.",
].join("\n");

export interface ProjectDescriptionOperationOptions {
  readonly originalRequest: string;
  readonly discovery: ProjectDescriptionDiscovery;
  readonly existing?: ProjectDescription;
  readonly profile: ModelProfile;
  readonly adapter: ProviderAdapter;
  readonly auth: ResolvedProviderAuth;
  readonly interview: InitInterviewMode;
  readonly deadlineMs: number;
  readonly signal?: AbortSignal;
  readonly onQuestion?: (question: InterviewQuestionEvidence) => void | Promise<void>;
}

export interface ProjectDescriptionOperationResult {
  readonly value: ProjectDescription;
  readonly semanticOperations: number;
  readonly correctiveRegenerations: number;
  readonly findingsByAttempt: readonly (readonly ProjectDescriptionFinding[])[];
}

function input(options: ProjectDescriptionOperationOptions, findings?: readonly ProjectDescriptionFinding[]): string {
  return JSON.stringify({
    task: findings ? "Regenerate the COMPLETE project-description candidate; do not patch the rejected candidate." : "Create the complete project-description stage candidate.",
    originalRequest: options.originalRequest,
    repositoryDiscovery: options.discovery,
    existingDeveloperAuthority: options.existing ?? null,
    ...(findings ? { recovery: { completeStageRegeneration: true, previousFindings: findings.map(({ pointer, message }) => ({ pointer, message })) } } : {}),
  }, null, 2);
}

async function resolveQuestions(wire: ProjectDescriptionWire, options: ProjectDescriptionOperationOptions): Promise<readonly InterviewQuestionEvidence[]> {
  const questions = wire.questions.map(pendingQuestionEvidence);
  const resolved: InterviewQuestionEvidence[] = [];
  for (const question of questions) {
    await options.onQuestion?.(question);
    resolved.push(selectInterviewAnswer(question, options.interview.kind === "headless"
      ? { kind: "headless" }
      : { kind: "interactive", response: await options.interview.answer(question) }));
  }
  return resolved;
}

export async function runProjectDescriptionOperation(options: ProjectDescriptionOperationOptions): Promise<ProjectDescriptionOperationResult> {
  const controller = options.signal ? undefined : new AbortController();
  const signal = options.signal ?? controller!.signal;
  const findingsByAttempt: ProjectDescriptionFinding[][] = [];
  let previous: readonly ProjectDescriptionFinding[] | undefined;
  for (let ordinal = 0; ordinal < 2; ordinal += 1) {
    const request: SemanticRequest = {
      slice: "project-description",
      instructions: PROJECT_DESCRIPTION_INSTRUCTIONS,
      input: input(options, previous),
      schema: PROJECT_DESCRIPTION_SCHEMA,
      schemaName: "rb_project_description_v1",
      limits: { maxOutputTokens: Math.min(options.profile.maxOutputTokens, 128_000), deadlineMs: options.deadlineMs },
      reasoning: options.profile.reasoning.supported && options.profile.reasoning.defaultMode === "on" ? { mode: "on", effort: options.profile.reasoning.efforts[0]! } : { mode: "off" },
      signal,
    };
    const capability = options.adapter.checkCapabilities(options.profile, request);
    if (!capability.ok) throw new Error(`PROJECT_DESCRIPTION_PROVIDER_FAILURE: ${capability.error.message}`);
    const outcome = await options.adapter.request(options.profile, options.auth, request);
    if (!outcome.ok) throw new Error(`PROJECT_DESCRIPTION_PROVIDER_FAILURE: ${outcome.error.message}`);
    const decoded = decodeProjectDescriptionWire(outcome.value.payload, options.originalRequest);
    let findings: readonly ProjectDescriptionFinding[];
    if (!decoded.ok) findings = decoded.findings;
    else {
      const resolved = resolveProjectDescriptionWire(decoded.value, await resolveQuestions(decoded.value, options), options.existing);
      if (!resolved.ok) findings = resolved.findings;
      else {
        const consistency = validateProjectDescriptionCapabilityWorkflowConsistency(resolved.value);
        const preservation = validateProjectDescriptionPreservation(options.existing, resolved.value);
        findings = [...consistency, ...preservation];
      }
      if (resolved.ok && !findings.length) {
        return { value: resolved.value, semanticOperations: ordinal + 1, correctiveRegenerations: ordinal, findingsByAttempt };
      }
    }
    findingsByAttempt.push([...findings]);
    previous = findings;
  }
  throw new Error(`PROJECT_DESCRIPTION_INVALID_AFTER_RECOVERY: ${previous?.map((entry) => `${entry.pointer}: ${entry.message}`).join("; ")}`);
}
