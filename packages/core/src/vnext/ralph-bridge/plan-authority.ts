import { lstat, readFile, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { parseExecutionMarkdown, taskScopeTokens } from "../../execution-contract.js";
import { sha256Text } from "../../hash.js";
import { loadManifest, validateManifestTree } from "../../manifest.js";
import type { ArtifactManifest, ArtifactRecord, ExecutionDocument } from "../../types.js";
import { deriveExecutionDocument } from "../render/execution.js";
import { executionWithoutLocations, selectReadyExecutionPlan } from "../ralph-fidelity.js";
import { databaseSchemaUpstreamProjection, databaseSchemaUpstreamProjectionSha256 } from "../progressive-init/database-schema-ir.js";
import { loadDatabaseSchema } from "../progressive-init/database-schema-store.js";
import { compileProjectPhasesToSemanticInitProject } from "../progressive-init/project-phases-compiler.js";
import { projectPhasesUpstreamProjection, type ProjectPhases, type ProjectPhasesUpstreamProjection } from "../progressive-init/project-phases-ir.js";
import { loadProjectPhases } from "../progressive-init/project-phases-store.js";
import { loadProjectDescription } from "../progressive-init/project-description-store.js";
import { inspectProgressiveRalphReadiness, type ProgressiveRalphReadiness } from "../progressive-init/readiness.js";
import { userStoriesUpstreamProjection, userStoriesUpstreamProjectionSha256 } from "../progressive-init/user-stories-ir.js";
import { loadUserStories } from "../progressive-init/user-stories-store.js";
import { resolveInitProject } from "../resolve.js";
import { sha256, sha256Canonical } from "../ralph-runtime/hashing.js";

export const RALPH_BRIDGE_AUTHORITY_SCHEMA_V1 = "rb-ralph-progressive-authority/v1" as const;

export class RalphBridgeAuthorityError extends Error {
  constructor(readonly code: string, message: string = code) {
    super(`${code}: ${message}`);
    this.name = "RalphBridgeAuthorityError";
  }
}

export interface ProgressiveExecutionAuthorityV1 {
  readonly schema: typeof RALPH_BRIDGE_AUTHORITY_SCHEMA_V1;
  readonly projectRoot: string;
  readonly readiness: ProgressiveRalphReadiness;
  readonly readinessDigest: string;
  readonly manifest: ArtifactManifest;
  readonly manifestHash: string;
  readonly selectedPlan: ArtifactRecord;
  readonly selectedPlanSource: string;
  /** The exact selected PHASES bytes, represented in the Ralph digest vocabulary. */
  readonly selectedPlanSourceHash: string;
  /** Ralph-compatible projection. Only Scope punctuation is normalized. */
  readonly operationalPlan: ExecutionDocument;
  readonly operationalPlanDigest: string;
  readonly semanticExecutionIdentity: string;
  readonly originalRequest: string;
  readonly projectPhases: ProjectPhases;
  readonly upstream: ProjectPhasesUpstreamProjection;
  readonly ownedPathsByTask: Readonly<Record<string, readonly string[]>>;
}

/**
 * The sole Progressive READY -> Ralph authority adapter.
 *
 * Dependency direction is deliberately one-way: this integration module
 * consumes public Progressive and frozen Ralph contracts; neither subsystem
 * imports the bridge or provider implementations.
 */
export async function loadProgressiveExecutionAuthority(projectRoot: string): Promise<ProgressiveExecutionAuthorityV1> {
  const root = resolve(projectRoot);
  const readiness = await inspectExactProgressiveReadiness(root);

  const tree = await validateManifestTree(root);
  if (!tree.valid || !tree.manifest) {
    throw new RalphBridgeAuthorityError("RALPH_BRIDGE_MANIFEST_INVALID", tree.issues.map((issue) => issue.code).join(", "));
  }
  // Re-read through the production loader after tree validation. The manifest
  // object returned above is validated, while this read is the exact current
  // persisted authority used to bind the run.
  const manifest = await loadManifest(root);
  const candidates = manifest.artifacts.filter((entry) => entry.kind === "execution-plan"
    && entry.status === "ready" && entry.contract === "rb-execution/v1");
  const selectedSource = candidates.length === 1 ? await readBoundArtifact(root, candidates[0]!.path) : "";
  const selected = selectExactReadyExecutionPlan(manifest, selectedSource);
  if (sha256Text(selectedSource) !== selected.sha256) {
    throw new RalphBridgeAuthorityError("RALPH_BRIDGE_PLAN_DIGEST_MISMATCH");
  }
  const parsed = parseExecutionMarkdown(selectedSource);
  const progressive = await loadProgressiveAuthority(root);
  const compiled = compileProjectPhasesToSemanticInitProject(progressive.upstream, progressive.projectPhases);
  const resolved = resolveInitProject(compiled, {
    originalRequest: progressive.originalRequest,
    runId: "ralph-authority-projection",
    generatedAt: "2000-01-01T00:00:00.000Z",
  });
  if (!resolved.ok) throw new RalphBridgeAuthorityError("RALPH_BRIDGE_PROGRESSIVE_PROJECTION_INVALID");
  const expected = deriveExecutionDocument(resolved.value);
  if (JSON.stringify(executionWithoutLocations(parsed)) !== JSON.stringify(executionWithoutLocations(expected))) {
    throw new RalphBridgeAuthorityError("RALPH_BRIDGE_PLAN_PROGRESSIVE_BINDING_MISMATCH");
  }

  const ownedPathsByTask: Record<string, readonly string[]> = {};
  let taskIndex = 0;
  const progressiveTasks = progressive.projectPhases.phases.flatMap((phase) => phase.tasks);
  const operationalPlan: ExecutionDocument = {
    ...parsed,
    phases: parsed.phases.map((phase) => ({
      ...phase,
      tasks: phase.tasks.map((task) => {
        const authorityTask = progressiveTasks[taskIndex++];
        if (!authorityTask) throw new RalphBridgeAuthorityError("RALPH_BRIDGE_TASK_AUTHORITY_MISMATCH");
        const parsedPaths = taskScopeTokens(task.scope);
        if (JSON.stringify(parsedPaths) !== JSON.stringify(authorityTask.ownedPaths)) {
          throw new RalphBridgeAuthorityError("RALPH_BRIDGE_TASK_OWNERSHIP_MISMATCH", task.id);
        }
        ownedPathsByTask[task.id] = Object.freeze([...authorityTask.ownedPaths]);
        // The frozen M5-B ownership tokenizer consumes raw comma-separated
        // paths. PHASES renders those paths in Markdown code spans, so the
        // adapter removes only that presentation punctuation.
        return { ...task, scope: parsedPaths.join(", ") };
      }),
    })),
  };
  const operationalPlanDigest = sha256Canonical(operationalPlan);
  const semanticExecutionIdentity = `ralph-exec-${sha256Canonical({
    schema: RALPH_BRIDGE_AUTHORITY_SCHEMA_V1,
    projectId: manifest.project.id,
    planId: selected.id,
    planPath: selected.path,
    planSha256: selected.sha256,
  }).slice("sha256:".length)}`;
  return Object.freeze({
    schema: RALPH_BRIDGE_AUTHORITY_SCHEMA_V1,
    projectRoot: root,
    readiness,
    readinessDigest: sha256Canonical(readiness),
    manifest,
    manifestHash: sha256(await readFile(resolve(root, ".rb", "rb-manifest.json"))),
    selectedPlan: Object.freeze({ ...selected }),
    selectedPlanSource: selectedSource,
    selectedPlanSourceHash: sha256(selectedSource),
    operationalPlan: freezePlan(operationalPlan),
    operationalPlanDigest,
    semanticExecutionIdentity,
    originalRequest: progressive.originalRequest,
    projectPhases: progressive.projectPhases,
    upstream: progressive.upstream,
    ownedPathsByTask: Object.freeze(ownedPathsByTask),
  });
}

export function selectExactReadyExecutionPlan(manifest: ArtifactManifest, phasesSource: string): ArtifactRecord {
  const candidates = manifest.artifacts.filter((entry) => entry.kind === "execution-plan"
    && entry.status === "ready" && entry.contract === "rb-execution/v1");
  if (candidates.length !== 1) {
    throw new RalphBridgeAuthorityError("RALPH_BRIDGE_PLAN_AMBIGUOUS", `expected exactly one READY execution plan, found ${candidates.length}`);
  }
  try { return selectReadyExecutionPlan(manifest, phasesSource); }
  catch (error) {
    throw new RalphBridgeAuthorityError("RALPH_BRIDGE_PLAN_SELECTION_FAILED", error instanceof Error ? error.message : String(error));
  }
}

export async function inspectExactProgressiveReadiness(projectRoot: string): Promise<ProgressiveRalphReadiness> {
  let readiness: ProgressiveRalphReadiness;
  try { readiness = await inspectProgressiveRalphReadiness(resolve(projectRoot)); }
  catch (error) {
    throw new RalphBridgeAuthorityError("RALPH_BRIDGE_PROGRESSIVE_NOT_READY", error instanceof Error ? error.message : String(error));
  }
  assertExactReady(readiness);
  return readiness;
}

export function assertExactReady(readiness: ProgressiveRalphReadiness): void {
  if (readiness.ready !== true || readiness.closureStatus !== "fresh" || readiness.reasons.length !== 0) {
    throw new RalphBridgeAuthorityError("RALPH_BRIDGE_PROGRESSIVE_NOT_READY", readiness.reasons.join("; ") || `closure=${readiness.closureStatus ?? "absent"}`);
  }
}

async function loadProgressiveAuthority(root: string): Promise<{
  readonly originalRequest: string;
  readonly upstream: ProjectPhasesUpstreamProjection;
  readonly projectPhases: ProjectPhases;
}> {
  const p1 = await loadProjectDescription(root);
  if (!p1) throw new RalphBridgeAuthorityError("RALPH_BRIDGE_P1_AUTHORITY_MISSING");
  const p2Upstream = userStoriesUpstreamProjection(p1.document.value);
  const p2 = await loadUserStories(root, p2Upstream);
  if (!p2) throw new RalphBridgeAuthorityError("RALPH_BRIDGE_P2_AUTHORITY_MISSING");
  const p3Upstream = databaseSchemaUpstreamProjection(p2.document.value, userStoriesUpstreamProjectionSha256(p2Upstream));
  const p3 = await loadDatabaseSchema(root, p3Upstream);
  if (!p3) throw new RalphBridgeAuthorityError("RALPH_BRIDGE_P3_AUTHORITY_MISSING");
  const upstream = projectPhasesUpstreamProjection(p1.document.value, p2.document.value, p3.document.value, {
    projectDescriptionAuthoritativeInputSha256: p1.document.metadata.authoritativeInputSha256,
    userStoriesUpstreamProjectionSha256: p2.document.metadata.upstreamProjectionSha256,
    userStoriesAuthoritativeInputSha256: p2.document.metadata.authoritativeInputSha256,
    databaseSchemaUpstreamProjectionSha256: p3.document.metadata.upstreamProjectionSha256,
    databaseSchemaAuthoritativeInputSha256: p3.document.metadata.authoritativeInputSha256,
  });
  // Recomputing this projection is an explicit lineage check, not a new
  // request authority.
  if (databaseSchemaUpstreamProjectionSha256(p3Upstream) !== p3.document.metadata.upstreamProjectionSha256) {
    throw new RalphBridgeAuthorityError("RALPH_BRIDGE_P3_LINEAGE_MISMATCH");
  }
  const p4 = await loadProjectPhases(root, upstream);
  if (!p4) throw new RalphBridgeAuthorityError("RALPH_BRIDGE_P4_AUTHORITY_MISSING");
  return { originalRequest: p1.document.value.originalRequest, upstream, projectPhases: p4.document.value };
}

async function readBoundArtifact(root: string, logicalPath: string): Promise<string> {
  if (!logicalPath.startsWith(".rb/") || logicalPath.includes("\\")) throw new RalphBridgeAuthorityError("RALPH_BRIDGE_PLAN_PATH_UNSAFE");
  const absolute = resolve(root, logicalPath);
  if (absolute === root || !absolute.startsWith(`${root}${sep}`)) throw new RalphBridgeAuthorityError("RALPH_BRIDGE_PLAN_PATH_UNSAFE");
  const stats = await lstat(absolute).catch(() => undefined);
  if (!stats?.isFile() || stats.isSymbolicLink()) throw new RalphBridgeAuthorityError("RALPH_BRIDGE_PLAN_PATH_UNSAFE");
  const physical = await realpath(absolute);
  if (physical !== absolute || !physical.startsWith(`${root}${sep}`)) throw new RalphBridgeAuthorityError("RALPH_BRIDGE_PLAN_PATH_UNSAFE");
  return readFile(absolute, "utf8");
}

function freezePlan(plan: ExecutionDocument): ExecutionDocument {
  // Frozen Ralph admission clones and seals this value again at its boundary;
  // keep the public mutable-array ExecutionDocument type intact here.
  return structuredClone(plan);
}
