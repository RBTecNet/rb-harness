import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateManifestTree, validateManifestValue } from "../manifest.js";
import { sha256Text } from "../hash.js";
import type { ArtifactManifest, ExecutionDocument } from "../types.js";
import type { InitProjectModel, ResolutionContext, SemanticInitProject } from "./ir.js";
import { resolveInitProject } from "./resolve.js";
import { canonicalize, validate } from "./validate.js";
import { deriveExecutionDocument, renderPhases } from "./render/execution.js";
import { renderBrief } from "./render/brief.js";
import { buildManifest, renderManifest, type StagedArtifactBytes } from "./render/manifest.js";
import { assertExecutionRoundTrip, assertRalphIssueMapExhaustive, selectReadyExecutionPlan } from "./ralph-fidelity.js";
import { publishStagedRb } from "./publish.js";
import type { Finding, Outcome } from "./result.js";

export interface DeterministicCounters {
  readonly providerCalls: 0;
  readonly adapterCalls: 0;
  readonly formatterCalls: 0;
  readonly repairCalls: 0;
  readonly providerSpecificBranches: 0;
}

export interface ClosureResult {
  readonly model: InitProjectModel;
  readonly executionDocument: ExecutionDocument;
  readonly phases: string;
  readonly brief: string;
  readonly manifest: ArtifactManifest;
  readonly publishedRoot: string;
  readonly counters: DeterministicCounters;
}

export class SemanticClosureError extends Error {
  constructor(readonly findings: readonly Finding[]) {
    super(`SEMANTIC_INVALID: ${findings.map((entry) => `${entry.invariant} ${entry.message}`).join("; ")}`);
  }
}

const ZERO_CALLS: DeterministicCounters = {
  providerCalls: 0,
  adapterCalls: 0,
  formatterCalls: 0,
  repairCalls: 0,
  providerSpecificBranches: 0,
};

function assertSafeRunId(runId: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(runId)) throw new Error(`Invalid deterministic run ID: ${runId}`);
}

async function verifyPublishedBytes(root: string, manifest: ArtifactManifest): Promise<void> {
  for (const artifact of manifest.artifacts) {
    const bytes = await readFile(resolve(root, artifact.path));
    if (sha256Text(bytes) !== artifact.sha256) throw new Error(`POST_PUBLICATION_HASH_MISMATCH: ${artifact.path}`);
  }
}

export async function closeInitProject(modelInput: InitProjectModel, projectRoot: string): Promise<ClosureResult> {
  const model = canonicalize(modelInput);
  const semanticValidation = validate(model);
  if (!semanticValidation.valid) throw new SemanticClosureError(semanticValidation.findings);
  assertSafeRunId(model.core.provenance.runId);
  assertRalphIssueMapExhaustive();

  const executionDocument = deriveExecutionDocument(model);
  const phases = renderPhases(executionDocument);
  const brief = renderBrief(model);
  const runRoot = resolve(projectRoot, ".rb-harness", "runs", model.core.provenance.runId);
  const stagingRb = resolve(runRoot, "staging", ".rb");
  await rm(resolve(runRoot, "staging"), { recursive: true, force: true });
  await mkdir(resolve(stagingRb, "init"), { recursive: true });
  const rendered: readonly StagedArtifactBytes[] = [
    { path: ".rb/init/BRIEF.md", bytes: Buffer.from(brief) },
    { path: ".rb/init/PHASES.md", bytes: Buffer.from(phases) },
  ];
  await writeFile(resolve(stagingRb, "init", "PHASES.md"), rendered[1]!.bytes);
  await writeFile(resolve(stagingRb, "init", "BRIEF.md"), rendered[0]!.bytes);

  assertExecutionRoundTrip(phases, executionDocument);
  const staged: readonly StagedArtifactBytes[] = [
    { path: ".rb/init/BRIEF.md", bytes: await readFile(resolve(stagingRb, "init", "BRIEF.md")) },
    { path: ".rb/init/PHASES.md", bytes: await readFile(resolve(stagingRb, "init", "PHASES.md")) },
  ];
  const manifest = buildManifest(model, staged);
  const manifestValidation = validateManifestValue(manifest);
  if (!manifestValidation.valid) throw new Error(`MANIFEST_PROGRAMMING_BUG: ${manifestValidation.issues.map((entry) => entry.code).join(", ")}`);
  await writeFile(resolve(stagingRb, "rb-manifest.json"), renderManifest(manifest));

  const artifactDirectory = `.rb-harness/runs/${model.core.provenance.runId}/staging/.rb`;
  const treeValidation = await validateManifestTree(projectRoot, { artifactDirectory });
  if (!treeValidation.valid) throw new Error(`RALPH_TREE_PROGRAMMING_BUG: ${treeValidation.issues.map((entry) => entry.code).join(", ")}`);
  selectReadyExecutionPlan(manifest, phases);

  const publication = await publishStagedRb(projectRoot, stagingRb, resolve(runRoot, "previous", ".rb"));
  await verifyPublishedBytes(projectRoot, manifest);
  return {
    model,
    executionDocument,
    phases,
    brief,
    manifest,
    publishedRoot: publication.publishedRoot,
    counters: ZERO_CALLS,
  };
}

export async function runDeterministicInit(
  semantic: SemanticInitProject,
  context: ResolutionContext,
  projectRoot: string,
): Promise<ClosureResult> {
  const resolved: Outcome<InitProjectModel> = resolveInitProject(semantic, context);
  if (!resolved.ok) throw new SemanticClosureError(resolved.findings);
  return closeInitProject(resolved.value, projectRoot);
}
