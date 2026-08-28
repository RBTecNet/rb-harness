import { copyFile, lstat, mkdir, readdir, readFile, rename, rm, chmod } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { assessDecomposition } from "./harness-granularity.js";
import { validateArtifactConsistency } from "./artifact-consistency.js";
import { initializeProject, slugify, syncManifest, validateManifestTree } from "./manifest.js";
import type { StructuralError } from "./harness-generator.js";
import type { HarnessRunState, HarnessWorkflow } from "./standalone-types.js";
import type { ArtifactManifest, ValidationIssue } from "./types.js";
import { validateExecutionMarkdown } from "./execution-contract.js";
import {
  applicableWorkflowArtifacts,
  readyWorkflowArtifact,
  requiredWorkflowArtifactPaths,
  workflowScopeFromPaths,
} from "./workflow-definition.js";
import {
  BUILT_IN_PROTECTED_PATH_CONSTRAINTS,
  artifactAuthoritySources,
  authorityConstraintsFromState,
  deduplicateProtectedPaths,
  deduplicateTraceability,
  protectedPathConstraintsFromArtifact,
  traceabilityConstraintsFromArtifact,
  traceabilityConstraintsFromState,
  validateAuthorityConstraints,
  validateTraceabilityConstraints,
} from "./authority-constraints.js";

/**
 * Errors a localized repair cannot fix. They indicate a compromised staging
 * tree rather than a document the writer can correct, so they fail the run.
 */
const UNREPAIRABLE_CODES = new Set([
  "artifact.path.unsafe",
  "artifact.path.root",
  "manifest.missing",
  "manifest.version",
  "manifest.root",
]);

export function safeArtifactTarget(projectRoot: string, artifactDirectory: string): string {
  if (!artifactDirectory || isAbsolute(artifactDirectory) || artifactDirectory.includes("\0")) {
    throw new Error("--output must be a project-relative artifact directory");
  }
  const root = resolve(projectRoot);
  const target = resolve(root, artifactDirectory);
  if (target === root || !target.startsWith(`${root}${sep}`)) throw new Error("--output must remain inside the project");
  const firstSegment = relative(root, target).split(sep)[0]?.toLowerCase() ?? "";
  if ([".git", ".rb-harness"].includes(firstSegment)) {
    throw new Error("--output cannot use .git or .rb-harness; choose a documentation directory such as .rb or .spec");
  }
  return target;
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch { return false; }
}

/**
 * Copy an existing artifact tree into staging. Only the documentation tree is
 * copied — never the project source. The previous architecture snapshotted the
 * whole repository into the run directory before every generation, which was
 * slow, unbounded, and handed an agentic provider a writable playground.
 */
async function copyArtifactTree(source: string, destination: string): Promise<void> {
  async function visit(currentSource: string, currentDestination: string, atRoot: boolean): Promise<void> {
    const info = await lstat(currentSource);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`artifact source is not a regular directory: ${currentSource}`);
    await mkdir(currentDestination, { recursive: true, mode: 0o700 });
    for (const entry of (await readdir(currentSource, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) continue;
      const absolute = resolve(currentSource, entry.name);
      if (entry.isDirectory()) {
        // `.rb/runs` is live Ralph control-plane state, never regenerated here.
        if (atRoot && entry.name === "runs") continue;
        await visit(absolute, resolve(currentDestination, entry.name), false);
        continue;
      }
      if (!entry.isFile()) continue;
      const target = resolve(currentDestination, entry.name);
      await copyFile(absolute, target);
      const fileInfo = await lstat(absolute);
      await chmod(target, fileInfo.mode & 0o777).catch(() => undefined);
    }
  }
  await visit(resolve(source), destination, true);
}

/**
 * Build the staging tree the bundle is materialized into: only `.rb`, seeded
 * with the compatible existing artifacts so preserved documents survive.
 */
export async function prepareStagingTree(state: HarnessRunState, runRoot: string): Promise<string> {
  const staging = resolve(runRoot, "staging");
  const outputTarget = safeArtifactTarget(state.projectRoot, state.artifactDirectory);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true, mode: 0o700 });
  const stagedArtifacts = resolve(staging, ".rb");
  if (await exists(outputTarget)) {
    const outputInfo = await lstat(outputTarget);
    if (!outputInfo.isDirectory() || outputInfo.isSymbolicLink()) throw new Error("artifact output must be a regular directory");
    await copyArtifactTree(outputTarget, stagedArtifacts);
  } else {
    await mkdir(stagedArtifacts, { recursive: true, mode: 0o700 });
  }
  if (!(await exists(resolve(stagedArtifacts, "rb-manifest.json")))) {
    const name = state.inventory.projectName || basename(state.projectRoot) || "RB Project";
    await initializeProject(staging, name, state.inventory.projectId || slugify(name));
  }
  return staging;
}

function structuralError(issue: ValidationIssue): StructuralError {
  return {
    code: issue.code,
    // Go convergence diagnostics already carry stable task/criterion identity.
    // Keep their public message byte-identical to artifacts verify/headless.
    message: issue.line && !issue.code.startsWith("execution.go-") ? `${issue.message} (line ${issue.line})` : issue.message,
    ...(issue.path ? { path: issue.path } : {}),
    ...(issue.line ? { line: issue.line } : {}),
  };
}

/**
 * Decomposition ceilings a published plan must respect.
 *
 * The manifest and the grammar can both be perfect while the plan still hands
 * an entire feature to one context-free RB Ralph call. That is a document
 * defect the localized repair can correct, so it is reported as a structural
 * error rather than discovered by the executor at run time.
 */
async function decompositionErrors(staging: string, manifest: ArtifactManifest): Promise<StructuralError[]> {
  const errors: StructuralError[] = [];
  for (const artifact of manifest.artifacts) {
    if (artifact.kind !== "execution-plan" || artifact.status !== "ready") continue;
    let source: string;
    try {
      source = await readFile(resolve(staging, artifact.path), "utf8");
    } catch {
      continue;
    }
    const document = validateExecutionMarkdown(source).document;
    if (!document) continue;
    for (const issue of assessDecomposition(document)) {
      errors.push(structuralError({ ...issue, path: artifact.path }));
    }
  }
  return errors;
}

async function authorityErrors(
  staging: string,
  manifest: ArtifactManifest,
  state?: HarnessRunState,
): Promise<StructuralError[]> {
  const constraints = [
    ...BUILT_IN_PROTECTED_PATH_CONSTRAINTS,
    ...(state ? authorityConstraintsFromState(state) : []),
  ];
  const traceability = state ? traceabilityConstraintsFromState(state) : [];
  for (const artifact of artifactAuthoritySources(manifest.artifacts)) {
    try {
      const content = await readFile(resolve(staging, artifact.path), "utf8");
      constraints.push(...protectedPathConstraintsFromArtifact(
        artifact.path,
        content,
      ));
      traceability.push(...traceabilityConstraintsFromArtifact(artifact.path, content));
    } catch { /* manifest/tree validation reports unreadable artifacts */ }
  }
  const canonical = deduplicateProtectedPaths(constraints);
  const errors: StructuralError[] = [];
  for (const artifact of manifest.artifacts.filter((entry) => entry.kind === "execution-plan")) {
    try {
      const parsed = validateExecutionMarkdown(await readFile(resolve(staging, artifact.path), "utf8"));
      if (parsed.document) {
        errors.push(...validateAuthorityConstraints(parsed.document, canonical, artifact.path).map(structuralError));
        errors.push(...validateTraceabilityConstraints(
          parsed.document,
          deduplicateTraceability(traceability),
          artifact.path,
        ).map(structuralError));
      }
    } catch { /* manifest/tree validation reports unreadable artifacts */ }
  }
  return errors;
}

export interface StagedValidation {
  valid: boolean;
  repairable: boolean;
  errors: StructuralError[];
  artifacts: number;
  readyPlans: number;
}

export interface StagedValidationScope {
  /** Exact logical paths authored by this run's current document bundle. */
  currentArtifactPaths?: readonly string[];
  /** Run authority used by deterministic constraint checks. */
  authority?: HarnessRunState;
}

/**
 * Deterministic validation of the staged tree. Manifest, hashes, IDs, and the
 * TSV projection are derived here by code; what remains is the document
 * content the writer owns, reported as an ordered, machine-generated error
 * list a bounded localized correction can consume.
 */
export async function validateStagedTree(
  staging: string,
  workflow: HarnessWorkflow,
  projectRoot = staging,
  runScope: StagedValidationScope = {},
): Promise<StagedValidation> {
  await assertNoEnvironmentSecrets(staging);
  const manifest = await syncManifest(staging);
  const authoredPaths = runScope.currentArtifactPaths?.map((path) => path.replaceAll("\\", "/"));
  const scope = workflowScopeFromPaths(workflow, authoredPaths ?? manifest.artifacts.map((artifact) => artifact.path));
  const applicableArtifacts = scope ? applicableWorkflowArtifacts(workflow, scope, manifest.artifacts) : [];
  const applicablePaths = new Set(applicableArtifacts.map((artifact) => artifact.path));
  const validation = await validateManifestTree(staging, { applicablePaths });
  const errors = validation.issues.map(structuralError);
  if (!scope) {
    errors.push({
      code: "workflow.scope.invalid",
      message: `The current ${workflow} bundle does not identify exactly one canonical workflow root.`,
    });
  }
  if (validation.valid) {
    errors.push(...(await validateArtifactConsistency({
      projectRoot,
      artifactRoot: resolve(staging, ".rb"),
      manifest: { ...manifest, artifacts: applicableArtifacts },
    })).map(structuralError));
  }
  errors.push(...await decompositionErrors(staging, { ...manifest, artifacts: applicableArtifacts }));
  errors.push(...await authorityErrors(staging, { ...manifest, artifacts: applicableArtifacts }, runScope.authority));
  const requiredPaths = scope ? requiredWorkflowArtifactPaths(workflow, scope) : [];
  const producedPaths = new Set(authoredPaths ?? applicableArtifacts.map((artifact) => artifact.path));
  const readyArtifact = scope ? readyWorkflowArtifact(workflow, scope, applicableArtifacts) : undefined;
  const readyProduced = Boolean(readyArtifact && producedPaths.has(readyArtifact.path));
  if (validation.valid && !readyProduced) {
    const declaredBlockers = applicableArtifacts
      .filter((artifact) => artifact.status === "blocked" || basename(artifact.path).toUpperCase() === "BLOCKED.MD")
      .map((artifact) => artifact.path);
    errors.push({
      code: "workflow.ready-output.missing",
      ...(declaredBlockers[0] ? { path: declaredBlockers[0] } : {}),
      message: declaredBlockers.length
        ? `The workflow declared BLOCKED in ${declaredBlockers.join(", ")} and did not emit the required ready output for workflow ${workflow}.`
        : `The generated artifacts do not contain the required ready output for workflow ${workflow}.`,
    });
  }
  for (const path of requiredPaths.filter((path) => !producedPaths.has(path))) {
    errors.push({
      code: "workflow.artifact.required-missing",
      path,
      message: `The current ${workflow} run did not produce mandatory artifact ${path}; a historical artifact cannot satisfy current-run completeness.`,
    });
  }
  return {
    valid: errors.length === 0,
    repairable: errors.length > 0 && errors.every((error) => !UNREPAIRABLE_CODES.has(error.code)),
    errors,
    artifacts: manifest.artifacts.length,
    readyPlans: applicableArtifacts.filter((artifact) =>
      artifact.kind === "execution-plan" && artifact.status === "ready" && producedPaths.has(artifact.path)).length,
  };
}

export async function assertNoEnvironmentSecrets(staging: string): Promise<void> {
  const artifactRoot = resolve(staging, ".rb");
  const secrets = Object.entries(process.env)
    .filter(([name, value]) => /(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name) && typeof value === "string" && value.length >= 12)
    .map(([name, value]) => ({ name, bytes: Buffer.from(value!, "utf8") }));
  if (!secrets.length) return;
  async function inspect(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`generated artifact tree contains a symbolic link: ${relative(artifactRoot, path)}`);
      if (entry.isDirectory()) {
        await inspect(path);
        continue;
      }
      if (!entry.isFile()) throw new Error(`generated artifact tree contains an unsupported entry: ${relative(artifactRoot, path)}`);
      const content = await readFile(path);
      const leaked = secrets.find((secret) => content.includes(secret.bytes));
      if (leaked) throw new Error(`generated artifacts contain the exact value of sensitive environment variable ${leaked.name}`);
    }
  }
  await inspect(artifactRoot);
}

async function uniquePreviousPath(runRoot: string): Promise<string> {
  const base = resolve(runRoot, "previous-artifacts");
  if (!(await exists(base))) return base;
  for (let index = 2; index < 100; index += 1) {
    const candidate = resolve(runRoot, `previous-artifacts-${index}`);
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error("too many preserved artifact revisions in one Harness run");
}

async function uniqueFailedPublicationPath(runRoot: string): Promise<string> {
  const base = resolve(runRoot, "failed-publication");
  if (!(await exists(base))) return base;
  for (let index = 2; index < 100; index += 1) {
    const candidate = resolve(runRoot, `failed-publication-${index}`);
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error("too many failed publications in one Harness run");
}

export async function publishStagedArtifacts(state: HarnessRunState, runRoot: string, staging: string): Promise<string | undefined> {
  const target = safeArtifactTarget(state.projectRoot, state.artifactDirectory);
  const staged = resolve(staging, ".rb");
  const stagedInfo = await lstat(staged);
  if (!stagedInfo.isDirectory() || stagedInfo.isSymbolicLink()) throw new Error("validated staging artifact root disappeared");
  await mkdir(dirname(target), { recursive: true });
  let previous: string | undefined;
  let preservedRuns: string | undefined;
  if (await exists(target)) {
    const targetInfo = await lstat(target);
    if (!targetInfo.isDirectory() || targetInfo.isSymbolicLink()) throw new Error("refusing to replace a non-directory artifact target");
    previous = await uniquePreviousPath(runRoot);
    await rename(target, previous);
    const oldRuns = resolve(previous, "runs");
    if (state.artifactDirectory === ".rb" && await exists(oldRuns)) {
      preservedRuns = oldRuns;
      await rename(oldRuns, resolve(staged, "runs"));
    }
  }
  try {
    await rename(staged, target);
    return previous;
  } catch (error) {
    if (previous) {
      if (preservedRuns && await exists(resolve(staged, "runs"))) await rename(resolve(staged, "runs"), preservedRuns).catch(() => undefined);
      if (!(await exists(target))) await rename(previous, target).catch(() => undefined);
    }
    throw error;
  }
}

/**
 * Quarantine a publication that failed its closing verification and restore
 * the prior revision without deleting either set of bytes.
 */
export async function rollbackPublishedArtifacts(
  state: HarnessRunState,
  runRoot: string,
  previous?: string,
): Promise<string> {
  const target = safeArtifactTarget(state.projectRoot, state.artifactDirectory);
  if (!(await exists(target))) {
    if (previous && await exists(previous)) {
      await mkdir(dirname(target), { recursive: true });
      await rename(previous, target);
    }
    throw new Error("published artifact target disappeared before rollback");
  }
  if (previous && !(await exists(previous))) throw new Error("previous artifact revision disappeared before rollback");

  if (previous && state.artifactDirectory === ".rb") {
    const currentRuns = resolve(target, "runs");
    const previousRuns = resolve(previous, "runs");
    if (await exists(currentRuns) && !(await exists(previousRuns))) await rename(currentRuns, previousRuns);
  }

  const failed = await uniqueFailedPublicationPath(runRoot);
  await rename(target, failed);
  if (previous) {
    try {
      await rename(previous, target);
    } catch (error) {
      if (!(await exists(target))) await rename(failed, target).catch(() => undefined);
      throw error;
    }
  }
  return failed;
}

export async function recoverInterruptedPublication(state: HarnessRunState, runRoot: string): Promise<boolean> {
  const target = safeArtifactTarget(state.projectRoot, state.artifactDirectory);
  if (await exists(target)) return false;
  const candidates = [resolve(runRoot, "previous-artifacts")];
  for (let index = 2; index < 100; index += 1) candidates.push(resolve(runRoot, `previous-artifacts-${index}`));
  const previous = (await Promise.all(candidates.map(async (path) => ({ path, exists: await exists(path) }))))
    .filter((candidate) => candidate.exists)
    .at(-1)?.path;
  if (!previous) return false;
  if (state.artifactDirectory === ".rb") {
    const stagedRuns = resolve(runRoot, "staging/.rb/runs");
    const previousRuns = resolve(previous, "runs");
    if (await exists(stagedRuns) && !(await exists(previousRuns))) await rename(stagedRuns, previousRuns);
  }
  await mkdir(dirname(target), { recursive: true });
  await rename(previous, target);
  state.previousArtifacts = undefined;
  return true;
}
