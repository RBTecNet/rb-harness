import { sha256Text } from "../../hash.js";
import type { InitInterviewMode } from "../init.js";
import type { InterviewQuestionEvidence } from "../interview.js";
import type { ModelProfile, ProviderAdapter, ResolvedProviderAuth } from "../providers/contract.js";
import { discoverProjectDescriptionEnvironment, projectDescriptionDiscoverySha256 } from "./discovery.js";
import { renderProjectDescriptionDocument } from "./project-description-document.js";
import {
  PROJECT_DESCRIPTION_CONTRACT,
  projectDescriptionForPersistence,
  projectDescriptionAcceptedDecisionProjection,
  projectDescriptionAuthoritativeInputSha256,
  projectDescriptionSemanticSha256,
} from "./project-description-ir.js";
import { runProjectDescriptionOperation } from "./project-description-operation.js";
import { loadProjectDescription, writeProjectDescriptionAtomically, writeProjectDescriptionStageRecord } from "./project-description-store.js";
import { PROGRESSIVE_INIT_STAGES, progressiveInitPrerequisites, progressiveInitStageDefinition, type ProgressiveInitStage } from "./stages.js";

export type ProgressiveStageStatus = "complete-fresh" | "complete-stale" | "incomplete";
export interface ProgressiveStageSnapshot { readonly stage: ProgressiveInitStage; readonly status: ProgressiveStageStatus }
export interface ProgressiveInitPresentation {
  readonly stage: (stage: ProgressiveInitStage, statuses: readonly ProgressiveStageSnapshot[]) => void | Promise<void>;
  readonly question?: (question: InterviewQuestionEvidence) => void | Promise<void>;
  readonly complete?: (stage: ProgressiveInitStage) => void | Promise<void>;
  readonly transition?: (next: ProgressiveInitStage) => void | Promise<void>;
}
export interface ProgressiveInitOptions {
  readonly projectRoot: string;
  readonly originalRequest?: string;
  readonly selectedStage?: ProgressiveInitStage;
  readonly profile?: ModelProfile;
  readonly adapter?: ProviderAdapter;
  readonly auth?: ResolvedProviderAuth;
  readonly interview?: InitInterviewMode;
  readonly deadlineMs?: number;
  readonly signal?: AbortSignal;
  readonly presentation?: ProgressiveInitPresentation;
  /** Deterministic test seam used only to prove concurrent-edit rejection. */
  readonly beforeWrite?: () => void | Promise<void>;
}
export interface ProgressiveInitResult {
  readonly mode: "automatic" | "focused";
  readonly selectedStage: ProgressiveInitStage;
  readonly completedStage?: "project-description";
  readonly nextStage?: ProgressiveInitStage;
  readonly artifactPath?: string;
  readonly semanticOperations: number;
  readonly correctiveRegenerations: number;
}

function boundary(stage: ProgressiveInitStage): never {
  throw new Error(`PROGRESSIVE_INIT_STAGE_NOT_IMPLEMENTED_PHASE_1: ${stage}`);
}

export async function inspectProgressiveInit(root: string, request?: string): Promise<readonly ProgressiveStageSnapshot[]> {
  const discovery = await discoverProjectDescriptionEnvironment(root);
  const discoverySha256 = projectDescriptionDiscoverySha256(discovery);
  const existing = await loadProjectDescription(root);
  let projectDescription: ProgressiveStageStatus = "incomplete";
  if (existing) {
    const originalRequest = request?.trim() || existing.document.value.originalRequest;
    const expected = projectDescriptionAuthoritativeInputSha256({
      originalRequest,
      discoverySha256,
      acceptedDecisions: projectDescriptionAcceptedDecisionProjection(existing.document.value),
    });
    projectDescription = expected === existing.document.metadata.authoritativeInputSha256 ? "complete-fresh" : "complete-stale";
  }
  return PROGRESSIVE_INIT_STAGES.map((stage) => ({ stage, status: stage === "project-description" ? projectDescription : "incomplete" }));
}

function requireOperation(options: ProgressiveInitOptions): asserts options is ProgressiveInitOptions & Required<Pick<ProgressiveInitOptions, "profile" | "adapter" | "auth" | "interview">> {
  if (!options.profile || !options.adapter || !options.auth || !options.interview) throw new Error("PROGRESSIVE_INIT_PROVIDER_CONFIGURATION_REQUIRED: --profile is required when a stage needs semantic generation");
}

export async function runProgressiveInit(options: ProgressiveInitOptions): Promise<ProgressiveInitResult> {
  const mode = options.selectedStage ? "focused" : "automatic";
  const statuses = await inspectProgressiveInit(options.projectRoot, options.originalRequest);
  const selectedStage = options.selectedStage ?? statuses.find((entry) => entry.status !== "complete-fresh")?.stage;
  if (!selectedStage) throw new Error("PROGRESSIVE_INIT_COMPLETE: all stages are complete and fresh");
  for (const prerequisite of progressiveInitPrerequisites(selectedStage)) {
    if (statuses.find((entry) => entry.stage === prerequisite)?.status !== "complete-fresh") {
      throw new Error(`PROGRESSIVE_INIT_PREREQUISITE_INVALID: ${selectedStage} requires complete/fresh ${prerequisite}`);
    }
  }
  await options.presentation?.stage(selectedStage, statuses);
  if (selectedStage !== "project-description") return boundary(selectedStage);
  requireOperation(options);
  const loaded = await loadProjectDescription(options.projectRoot);
  const originalRequest = options.originalRequest?.trim() || loaded?.document.value.originalRequest;
  if (!originalRequest) throw new Error("PROGRESSIVE_INIT_REQUEST_REQUIRED: project-description requires request text or --file");
  const discovery = await discoverProjectDescriptionEnvironment(options.projectRoot);
  const discoverySha256 = projectDescriptionDiscoverySha256(discovery);
  const operation = await runProjectDescriptionOperation({
    originalRequest, discovery, existing: loaded?.document.value,
    profile: options.profile, adapter: options.adapter, auth: options.auth, interview: options.interview,
    deadlineMs: options.deadlineMs ?? 120_000, signal: options.signal,
    onQuestion: options.presentation?.question,
  });
  const persistedValue = projectDescriptionForPersistence(operation.value);
  const authoritativeInputSha256 = projectDescriptionAuthoritativeInputSha256({
    originalRequest,
    discoverySha256,
    acceptedDecisions: projectDescriptionAcceptedDecisionProjection(persistedValue),
  });
  const source = renderProjectDescriptionDocument(persistedValue, {
    originalRequestSha256: sha256Text(originalRequest), discoverySha256, authoritativeInputSha256,
  });
  await options.beforeWrite?.();
  const artifactPath = await writeProjectDescriptionAtomically(options.projectRoot, source, loaded?.sourceSha256);
  await writeProjectDescriptionStageRecord(options.projectRoot, {
    contract: "rb-progressive-init-stage-record/v1", stage: "project-description", completion: "complete",
    semanticSha256: projectDescriptionSemanticSha256(persistedValue), authoritativeInputSha256,
  });
  await options.presentation?.complete?.("project-description");
  if (mode === "focused") return { mode, selectedStage, completedStage: "project-description", artifactPath, semanticOperations: operation.semanticOperations, correctiveRegenerations: operation.correctiveRegenerations };
  const nextStage = "user-stories";
  await options.presentation?.transition?.(nextStage);
  return { mode, selectedStage, completedStage: "project-description", nextStage, artifactPath, semanticOperations: operation.semanticOperations, correctiveRegenerations: operation.correctiveRegenerations };
}

export function formatProgressiveStagePresentation(stage: ProgressiveInitStage, statuses: readonly ProgressiveStageSnapshot[]): string {
  const definition = progressiveInitStageDefinition(stage);
  const lines = [`RB Harness Init`, "", `Stage ${PROGRESSIVE_INIT_STAGES.indexOf(stage) + 1}/${PROGRESSIVE_INIT_STAGES.length} — ${definition.label}`, definition.purpose, ""];
  for (const item of statuses) {
    const marker = item.stage === stage ? "→" : item.status === "complete-fresh" ? "✓" : item.status === "complete-stale" ? "!" : "○";
    lines.push(`${marker} ${progressiveInitStageDefinition(item.stage).label}`);
  }
  return `${lines.join("\n")}\n`;
}
