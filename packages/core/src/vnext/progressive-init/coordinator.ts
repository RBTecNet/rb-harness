import { sha256Text } from "../../hash.js";
import type { InitInterviewMode } from "../init.js";
import type { InterviewQuestionEvidence } from "../interview.js";
import type { ModelProfile, ProviderAdapter, ResolvedProviderAuth } from "../providers/contract.js";
import { renderDatabaseSchemaDocument } from "./database-schema-document.js";
import {
  databaseSchemaAcceptedDecisionProjection,
  databaseSchemaAuthoritativeInputSha256,
  databaseSchemaForPersistence,
  databaseSchemaUpstreamProjection,
  databaseSchemaUpstreamProjectionSha256,
  validateDatabaseSchema,
} from "./database-schema-ir.js";
import { runDatabaseSchemaOperation } from "./database-schema-operation.js";
import { loadDatabaseSchema, writeDatabaseSchemaAtomically } from "./database-schema-store.js";
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
import { inspectProjectPhasesClosure, publishProjectPhasesClosure, type ProjectPhasesClosureState } from "./project-phases-closure.js";
import { renderProjectPhasesDocument } from "./project-phases-document.js";
import {
  projectPhasesAuthoritativeInputSha256,
  projectPhasesUpstreamProjection,
  projectPhasesUpstreamProjectionSha256,
  validateProjectPhases,
  type ProjectPhasesUpstreamProjection,
} from "./project-phases-ir.js";
import { runProjectPhasesOperation } from "./project-phases-operation.js";
import { loadProjectPhases, writeProjectPhasesAtomically, type LoadedProjectPhases } from "./project-phases-store.js";
import { PROGRESSIVE_INIT_STAGES, progressiveInitPrerequisites, progressiveInitStageDefinition, type ProgressiveInitStage } from "./stages.js";
import { renderUserStoriesDocument } from "./user-stories-document.js";
import {
  userStoriesAcceptedDecisionProjection,
  userStoriesAuthoritativeInputSha256,
  userStoriesForPersistence,
  userStoriesUpstreamProjection,
  userStoriesUpstreamProjectionSha256,
  validateUserStories,
  validateUserStoriesUpstreamReadiness,
} from "./user-stories-ir.js";
import { runUserStoriesOperation } from "./user-stories-operation.js";
import { loadUserStories, writeUserStoriesAtomically } from "./user-stories-store.js";

export type ProgressiveStageStatus = "complete-fresh" | "complete-stale" | "reconciliation-required" | "incomplete";
export interface ProgressiveStageFinding { readonly pointer: string; readonly message: string }
export interface ProgressiveStageSnapshot {
  readonly stage: ProgressiveInitStage;
  readonly status: ProgressiveStageStatus;
  readonly findings?: readonly ProgressiveStageFinding[];
  readonly closureStatus?: ProjectPhasesClosureState["status"];
}
export interface ProgressiveInitPresentation {
  readonly stage: (stage: ProgressiveInitStage, statuses: readonly ProgressiveStageSnapshot[]) => void | Promise<void>;
  readonly question?: (question: InterviewQuestionEvidence) => void | Promise<void>;
  readonly complete?: (stage: ProgressiveInitStage, disposition: "generated" | "existing-fresh") => void | Promise<void>;
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
  readonly completedStage?: ProgressiveInitStage;
  readonly nextStage?: ProgressiveInitStage;
  readonly artifactPath?: string;
  readonly semanticOperations: number;
  readonly correctiveRegenerations: number;
}

function boundary(stage: ProgressiveInitStage): never {
  throw new Error(`PROGRESSIVE_INIT_STAGE_NOT_IMPLEMENTED: ${stage}`);
}

function reconciliationRequired(findings: readonly ProgressiveStageFinding[]): never {
  const details = findings.map((entry) => `${entry.pointer}: ${entry.message}`).join("; ");
  throw new Error(
    "USER_STORIES_RECONCILIATION_REQUIRED: Existing developer-owned user stories conflict with the current project-description. "
      + `${details}. Update .spec/init/user-stories.md to reconcile these developer-owned semantics, then rerun --stage user-stories.`,
  );
}

function databaseSchemaReconciliationRequired(findings: readonly ProgressiveStageFinding[]): never {
  const details = findings.map((entry) => `${entry.pointer}: ${entry.message}`).join("; ");
  throw new Error(
    "DATABASE_SCHEMA_RECONCILIATION_REQUIRED: Existing developer-owned database schema references User Stories that are no longer current. "
      + `${details}. Reconcile .spec/init/database-schema.md explicitly, then rerun --stage database-schema.`,
  );
}

function projectPhasesReconciliationRequired(findings: readonly ProgressiveStageFinding[]): never {
  const details = findings.map((entry) => `${entry.pointer}: ${entry.message}`).join("; ");
  throw new Error(
    "PROJECT_PHASES_RECONCILIATION_REQUIRED: Existing developer-owned Project Phases references upstream authority that is no longer current. "
      + `${details}. Reconcile .spec/init/project-phases.md explicitly, then rerun --stage project-phases.`,
  );
}

interface LoadedProjectPhasesAuthority {
  readonly upstream: ProjectPhasesUpstreamProjection;
  readonly loaded?: LoadedProjectPhases;
}

async function loadProjectPhasesAuthority(root: string): Promise<LoadedProjectPhasesAuthority | undefined> {
  const project = await loadProjectDescription(root);
  if (!project) return undefined;
  const storiesUpstream = userStoriesUpstreamProjection(project.document.value);
  const stories = await loadUserStories(root, storiesUpstream);
  if (!stories) return undefined;
  const storiesProjectionSha256 = userStoriesUpstreamProjectionSha256(storiesUpstream);
  const databaseUpstream = databaseSchemaUpstreamProjection(stories.document.value, storiesProjectionSha256);
  const database = await loadDatabaseSchema(root, databaseUpstream);
  if (!database) return undefined;
  const upstream = projectPhasesUpstreamProjection(
    project.document.value,
    stories.document.value,
    database.document.value,
    {
      projectDescriptionAuthoritativeInputSha256: project.document.metadata.authoritativeInputSha256,
      userStoriesUpstreamProjectionSha256: stories.document.metadata.upstreamProjectionSha256,
      userStoriesAuthoritativeInputSha256: stories.document.metadata.authoritativeInputSha256,
      databaseSchemaUpstreamProjectionSha256: database.document.metadata.upstreamProjectionSha256,
      databaseSchemaAuthoritativeInputSha256: database.document.metadata.authoritativeInputSha256,
    },
  );
  return { upstream, loaded: await loadProjectPhases(root, upstream) };
}

function stageNeedsWork(snapshot: ProgressiveStageSnapshot): boolean {
  return snapshot.status !== "complete-fresh" || snapshot.stage === "project-phases" && snapshot.closureStatus !== "fresh";
}

export async function inspectProgressiveInit(root: string, request?: string): Promise<readonly ProgressiveStageSnapshot[]> {
  const existing = await loadProjectDescription(root);
  let projectDescription: ProgressiveStageStatus = "incomplete";
  let userStories: ProgressiveStageStatus = "incomplete";
  let userStoriesFindings: readonly ProgressiveStageFinding[] | undefined;
  let databaseSchema: ProgressiveStageStatus = "incomplete";
  let databaseSchemaFindings: readonly ProgressiveStageFinding[] | undefined;
  let projectPhases: ProgressiveStageStatus = "incomplete";
  let projectPhasesFindings: readonly ProgressiveStageFinding[] | undefined;
  let projectPhasesClosure: ProjectPhasesClosureState["status"] | undefined;
  if (existing) {
    const originalRequest = request?.trim() || existing.document.value.originalRequest;
    const expected = projectDescriptionAuthoritativeInputSha256({
      originalRequest,
      acceptedDecisions: projectDescriptionAcceptedDecisionProjection(existing.document.value),
    });
    projectDescription = expected === existing.document.metadata.authoritativeInputSha256 ? "complete-fresh" : "complete-stale";
    const upstream = userStoriesUpstreamProjection(existing.document.value);
    const stories = await loadUserStories(root, upstream);
    if (stories) {
      if (projectDescription === "complete-fresh" && stories.document.upstreamCompatibilityFindings.length) {
        userStories = "reconciliation-required";
        userStoriesFindings = stories.document.upstreamCompatibilityFindings.map(({ pointer, message }) => ({ pointer, message }));
      } else {
        const upstreamProjectionSha256 = userStoriesUpstreamProjectionSha256(upstream);
        const expectedUserStories = userStoriesAuthoritativeInputSha256({
          upstreamProjectionSha256,
          acceptedDecisions: userStoriesAcceptedDecisionProjection(stories.document.value),
        });
        const currentSemantics = validateUserStories(stories.document.value, upstream);
        const upstreamReady = validateUserStoriesUpstreamReadiness(upstream).length === 0;
        userStories = projectDescription === "complete-fresh"
          && upstreamReady
          && currentSemantics.ok
          && stories.document.metadata.upstreamProjectionSha256 === upstreamProjectionSha256
          && stories.document.metadata.authoritativeInputSha256 === expectedUserStories
          ? "complete-fresh"
          : "complete-stale";
      }
      const userStoriesUpstreamSha256 = userStoriesUpstreamProjectionSha256(upstream);
      const databaseUpstream = databaseSchemaUpstreamProjection(stories.document.value, userStoriesUpstreamSha256);
      const schema = await loadDatabaseSchema(root, databaseUpstream);
      if (schema) {
        if (userStories === "complete-fresh" && schema.document.upstreamCompatibilityFindings.length) {
          databaseSchema = "reconciliation-required";
          databaseSchemaFindings = schema.document.upstreamCompatibilityFindings.map(({ pointer, message }) => ({ pointer, message }));
        } else {
          const upstreamProjectionSha256 = databaseSchemaUpstreamProjectionSha256(databaseUpstream);
          const expectedDatabaseSchema = databaseSchemaAuthoritativeInputSha256({
            upstreamProjectionSha256,
            acceptedDecisions: databaseSchemaAcceptedDecisionProjection(schema.document.value),
          });
          const currentSemantics = validateDatabaseSchema(schema.document.value, databaseUpstream);
          databaseSchema = userStories === "complete-fresh"
            && currentSemantics.ok
            && schema.document.metadata.upstreamProjectionSha256 === upstreamProjectionSha256
            && schema.document.metadata.authoritativeInputSha256 === expectedDatabaseSchema
            ? "complete-fresh"
            : "complete-stale";
        }
        const projectPhasesUpstream = projectPhasesUpstreamProjection(
          existing.document.value,
          stories.document.value,
          schema.document.value,
          {
            projectDescriptionAuthoritativeInputSha256: existing.document.metadata.authoritativeInputSha256,
            userStoriesUpstreamProjectionSha256: stories.document.metadata.upstreamProjectionSha256,
            userStoriesAuthoritativeInputSha256: stories.document.metadata.authoritativeInputSha256,
            databaseSchemaUpstreamProjectionSha256: schema.document.metadata.upstreamProjectionSha256,
            databaseSchemaAuthoritativeInputSha256: schema.document.metadata.authoritativeInputSha256,
          },
        );
        const phases = await loadProjectPhases(root, projectPhasesUpstream);
        if (phases) {
          if (databaseSchema === "complete-fresh" && phases.document.upstreamCompatibilityFindings.length) {
            projectPhases = "reconciliation-required";
            projectPhasesFindings = phases.document.upstreamCompatibilityFindings.map(({ pointer, message }) => ({ pointer, message }));
          } else {
            const upstreamProjectionSha256 = projectPhasesUpstreamProjectionSha256(projectPhasesUpstream);
            const expectedAuthoritative = projectPhasesAuthoritativeInputSha256(upstreamProjectionSha256);
            const currentSemantics = validateProjectPhases(phases.document.value, projectPhasesUpstream);
            projectPhases = databaseSchema === "complete-fresh"
              && currentSemantics.ok
              && phases.document.metadata.upstreamProjectionSha256 === upstreamProjectionSha256
              && phases.document.metadata.authoritativeInputSha256 === expectedAuthoritative
              ? "complete-fresh"
              : "complete-stale";
            if (projectPhases === "complete-fresh") {
              projectPhasesClosure = (await inspectProjectPhasesClosure(root, projectPhasesUpstream, phases.document.value)).status;
            }
          }
        }
      }
    }
  }
  return PROGRESSIVE_INIT_STAGES.map((stage) => ({
    stage,
    status: stage === "project-description" ? projectDescription
      : stage === "user-stories" ? userStories
        : stage === "database-schema" ? databaseSchema
          : projectPhases,
    ...(stage === "user-stories" && userStoriesFindings ? { findings: userStoriesFindings } : {}),
    ...(stage === "database-schema" && databaseSchemaFindings ? { findings: databaseSchemaFindings } : {}),
    ...(stage === "project-phases" && projectPhasesFindings ? { findings: projectPhasesFindings } : {}),
    ...(stage === "project-phases" && projectPhasesClosure ? { closureStatus: projectPhasesClosure } : {}),
  }));
}

function requireOperation(options: ProgressiveInitOptions): asserts options is ProgressiveInitOptions & Required<Pick<ProgressiveInitOptions, "profile" | "adapter" | "auth" | "interview">> {
  if (!options.profile || !options.adapter || !options.auth || !options.interview) throw new Error("PROGRESSIVE_INIT_PROVIDER_CONFIGURATION_REQUIRED: --profile is required when a stage needs semantic generation");
}

export function assertProgressiveInitPrerequisites(
  selectedStage: ProgressiveInitStage,
  statuses: readonly ProgressiveStageSnapshot[],
): void {
  for (const prerequisite of progressiveInitPrerequisites(selectedStage)) {
    if (statuses.find((entry) => entry.stage === prerequisite)?.status !== "complete-fresh") {
      throw new Error(`PROGRESSIVE_INIT_PREREQUISITE_INVALID: ${selectedStage} requires complete/fresh ${prerequisite}`);
    }
  }
}

export async function runProgressiveInit(options: ProgressiveInitOptions): Promise<ProgressiveInitResult> {
  const mode = options.selectedStage ? "focused" : "automatic";
  const statuses = await inspectProgressiveInit(options.projectRoot, options.originalRequest);
  const selectedStage = options.selectedStage ?? statuses.find(stageNeedsWork)?.stage;
  if (!selectedStage) throw new Error("PROGRESSIVE_INIT_COMPLETE: all stages are complete and fresh");
  assertProgressiveInitPrerequisites(selectedStage, statuses);
  await options.presentation?.stage(selectedStage, statuses);
  const selectedStatus = statuses.find((entry) => entry.stage === selectedStage);
  if (selectedStatus?.status === "complete-fresh" && !(selectedStage === "project-phases" && selectedStatus.closureStatus !== "fresh")) {
    await options.presentation?.complete?.(selectedStage, "existing-fresh");
    return {
      mode,
      selectedStage,
      completedStage: selectedStage,
      semanticOperations: 0,
      correctiveRegenerations: 0,
    };
  }
  if (selectedStage === "project-phases") {
    if (selectedStatus?.status === "reconciliation-required") projectPhasesReconciliationRequired(selectedStatus.findings ?? []);
    const authority = await loadProjectPhasesAuthority(options.projectRoot);
    if (!authority) throw new Error("PROGRESSIVE_INIT_PREREQUISITE_INVALID: project-phases requires complete/fresh P1, P2, and P3 authority");
    if (selectedStatus?.status === "complete-fresh") {
      if (!authority.loaded) throw new Error("PROJECT_PHASES_DOCUMENT_INVALID: complete/fresh status has no strict Project Phases document");
      await publishProjectPhasesClosure(options.projectRoot, authority.upstream, authority.loaded.document.value);
      await options.presentation?.complete?.("project-phases", "generated");
      return {
        mode,
        selectedStage,
        completedStage: "project-phases",
        semanticOperations: 0,
        correctiveRegenerations: 0,
      };
    }
    if (options.interview?.kind !== "interactive") {
      throw new Error("PROJECT_PHASES_INTERACTIVE_AUTHORITY_REQUIRED: incomplete or stale project-phases requires interactive developer authority");
    }
    requireOperation(options);
    const discovery = await discoverProjectDescriptionEnvironment(options.projectRoot);
    const operation = await runProjectPhasesOperation({
      upstream: authority.upstream,
      existing: authority.loaded?.document.value,
      existingRepositoryPaths: discovery.files.map((entry) => entry.path),
      profile: options.profile,
      adapter: options.adapter,
      auth: options.auth,
      interview: options.interview,
      deadlineMs: options.deadlineMs ?? 120_000,
      signal: options.signal,
      onQuestion: options.presentation?.question,
    });
    const upstreamProjectionSha256 = projectPhasesUpstreamProjectionSha256(authority.upstream);
    const authoritativeInputSha256 = projectPhasesAuthoritativeInputSha256(upstreamProjectionSha256);
    const source = renderProjectPhasesDocument(operation.value, authority.upstream, { upstreamProjectionSha256, authoritativeInputSha256 });
    await options.beforeWrite?.();
    const artifactPath = await writeProjectPhasesAtomically(
      options.projectRoot,
      authority.upstream,
      source,
      authority.loaded?.sourceSha256,
    );
    await publishProjectPhasesClosure(options.projectRoot, authority.upstream, operation.value);
    await options.presentation?.complete?.("project-phases", "generated");
    return {
      mode,
      selectedStage,
      completedStage: "project-phases",
      artifactPath,
      semanticOperations: operation.semanticOperations,
      correctiveRegenerations: operation.correctiveRegenerations,
    };
  }
  if (selectedStage !== "project-description" && selectedStage !== "user-stories" && selectedStage !== "database-schema") return boundary(selectedStage);
  if (selectedStage === "database-schema") {
    if (selectedStatus?.status === "reconciliation-required") databaseSchemaReconciliationRequired(selectedStatus.findings ?? []);
    if (options.interview?.kind === "headless") {
      throw new Error("DATABASE_SCHEMA_INTERACTIVE_AUTHORITY_REQUIRED: incomplete or stale database-schema requires interactive developer authority");
    }
    const projectDescription = await loadProjectDescription(options.projectRoot);
    if (!projectDescription) throw new Error("PROGRESSIVE_INIT_PREREQUISITE_INVALID: database-schema requires complete/fresh project-description");
    const userStoriesUpstream = userStoriesUpstreamProjection(projectDescription.document.value);
    const stories = await loadUserStories(options.projectRoot, userStoriesUpstream);
    if (!stories) throw new Error("PROGRESSIVE_INIT_PREREQUISITE_INVALID: database-schema requires complete/fresh user-stories");
    const upstream = databaseSchemaUpstreamProjection(stories.document.value, userStoriesUpstreamProjectionSha256(userStoriesUpstream));
    const loaded = await loadDatabaseSchema(options.projectRoot, upstream);
    if (loaded?.document.upstreamCompatibilityFindings.length) {
      databaseSchemaReconciliationRequired(loaded.document.upstreamCompatibilityFindings);
    }
    requireOperation(options);
    const operation = await runDatabaseSchemaOperation({
      upstream,
      existing: loaded?.document.value,
      profile: options.profile,
      adapter: options.adapter,
      auth: options.auth,
      interview: options.interview,
      deadlineMs: options.deadlineMs ?? 120_000,
      signal: options.signal,
      onQuestion: options.presentation?.question,
    });
    const persistedValue = databaseSchemaForPersistence(operation.value);
    const upstreamProjectionSha256 = databaseSchemaUpstreamProjectionSha256(upstream);
    const authoritativeInputSha256 = databaseSchemaAuthoritativeInputSha256({
      upstreamProjectionSha256,
      acceptedDecisions: databaseSchemaAcceptedDecisionProjection(persistedValue),
    });
    const source = renderDatabaseSchemaDocument(persistedValue, upstream, {
      upstreamProjectionSha256,
      authoritativeInputSha256,
    });
    await options.beforeWrite?.();
    const artifactPath = await writeDatabaseSchemaAtomically(options.projectRoot, upstream, source, loaded?.sourceSha256);
    await options.presentation?.complete?.("database-schema", "generated");
    if (mode === "focused") {
      return {
        mode,
        selectedStage,
        completedStage: "database-schema",
        artifactPath,
        semanticOperations: operation.semanticOperations,
        correctiveRegenerations: operation.correctiveRegenerations,
      };
    }
    const nextStage = "project-phases";
    await options.presentation?.transition?.(nextStage);
    return {
      mode,
      selectedStage,
      completedStage: "database-schema",
      nextStage,
      artifactPath,
      semanticOperations: operation.semanticOperations,
      correctiveRegenerations: operation.correctiveRegenerations,
    };
  }
  if (selectedStage === "user-stories") {
    if (selectedStatus?.status === "reconciliation-required") reconciliationRequired(selectedStatus.findings ?? []);
    const projectDescription = await loadProjectDescription(options.projectRoot);
    if (!projectDescription) throw new Error("PROGRESSIVE_INIT_PREREQUISITE_INVALID: user-stories requires complete/fresh project-description");
    const upstream = userStoriesUpstreamProjection(projectDescription.document.value);
    const readiness = validateUserStoriesUpstreamReadiness(upstream);
    if (readiness.length) {
      throw new Error(`USER_STORIES_UPSTREAM_NOT_READY: ${readiness.map((entry) => `${entry.pointer}: ${entry.message}`).join("; ")}`);
    }
    const loaded = await loadUserStories(options.projectRoot, upstream);
    if (loaded?.document.upstreamCompatibilityFindings.length) {
      reconciliationRequired(loaded.document.upstreamCompatibilityFindings);
    }
    requireOperation(options);
    const operation = await runUserStoriesOperation({
      upstream,
      existing: loaded?.document.value,
      profile: options.profile,
      adapter: options.adapter,
      auth: options.auth,
      interview: options.interview,
      deadlineMs: options.deadlineMs ?? 120_000,
      signal: options.signal,
      onQuestion: options.presentation?.question,
    });
    const persistedValue = userStoriesForPersistence(operation.value);
    const upstreamProjectionSha256 = userStoriesUpstreamProjectionSha256(upstream);
    const authoritativeInputSha256 = userStoriesAuthoritativeInputSha256({
      upstreamProjectionSha256,
      acceptedDecisions: userStoriesAcceptedDecisionProjection(persistedValue),
    });
    const source = renderUserStoriesDocument(persistedValue, upstream, {
      upstreamProjectionSha256,
      authoritativeInputSha256,
    });
    await options.beforeWrite?.();
    const artifactPath = await writeUserStoriesAtomically(options.projectRoot, upstream, source, loaded?.sourceSha256);
    await options.presentation?.complete?.("user-stories", "generated");
    if (mode === "focused") {
      return {
        mode,
        selectedStage,
        completedStage: "user-stories",
        artifactPath,
        semanticOperations: operation.semanticOperations,
        correctiveRegenerations: operation.correctiveRegenerations,
      };
    }
    const nextStage = "database-schema";
    await options.presentation?.transition?.(nextStage);
    return {
      mode,
      selectedStage,
      completedStage: "user-stories",
      nextStage,
      artifactPath,
      semanticOperations: operation.semanticOperations,
      correctiveRegenerations: operation.correctiveRegenerations,
    };
  }
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
  await options.presentation?.complete?.("project-description", "generated");
  if (mode === "focused") return { mode, selectedStage, completedStage: "project-description", artifactPath, semanticOperations: operation.semanticOperations, correctiveRegenerations: operation.correctiveRegenerations };
  const nextStage = "user-stories";
  await options.presentation?.transition?.(nextStage);
  return { mode, selectedStage, completedStage: "project-description", nextStage, artifactPath, semanticOperations: operation.semanticOperations, correctiveRegenerations: operation.correctiveRegenerations };
}

export function formatProgressiveStagePresentation(stage: ProgressiveInitStage, statuses: readonly ProgressiveStageSnapshot[]): string {
  const definition = progressiveInitStageDefinition(stage);
  const lines = [`RB Harness Init`, "", `Stage ${PROGRESSIVE_INIT_STAGES.indexOf(stage) + 1}/${PROGRESSIVE_INIT_STAGES.length} — ${definition.label}`, definition.purpose, ""];
  for (const item of statuses) {
    const marker = item.stage === stage ? "→" : item.status === "complete-fresh" ? "✓" : item.status === "complete-stale" || item.status === "reconciliation-required" ? "!" : "○";
    const closure = item.stage === "project-phases" && item.status === "complete-fresh" && item.closureStatus
      ? ` (closure ${item.closureStatus})`
      : "";
    lines.push(`${marker} ${progressiveInitStageDefinition(item.stage).label}${closure}`);
  }
  return `${lines.join("\n")}\n`;
}
