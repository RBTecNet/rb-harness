import { copyFile, lstat, mkdir, readdir, readFile, rename, rm, chmod } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { assessDecomposition } from "./harness-granularity.js";
import { initializeProject, loadManifest, slugify, syncManifest, validateManifestTree } from "./manifest.js";
import type { StructuralError } from "./harness-generator.js";
import type { HarnessRunState, HarnessWorkflow } from "./standalone-types.js";
import type { ArtifactManifest, ValidationIssue } from "./types.js";
import { validateExecutionMarkdown } from "./execution-contract.js";

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

function workflowArtifactReady(workflow: HarnessWorkflow, artifacts: Awaited<ReturnType<typeof loadManifest>>["artifacts"]): boolean {
  if (["init", "plan", "evolve"].includes(workflow)) {
    return artifacts.some((artifact) => artifact.kind === "execution-plan" && artifact.status === "ready" && artifact.contract === "rb-execution/v1");
  }
  if (workflow === "ai-context") return artifacts.some((artifact) => artifact.kind === "context-document" && artifact.status === "ready");
  return artifacts.some((artifact) => artifact.kind === "review-findings" && artifact.status === "ready");
}

function structuralError(issue: ValidationIssue): StructuralError {
  return {
    code: issue.code,
    message: issue.line ? `${issue.message} (line ${issue.line})` : issue.message,
    ...(issue.path ? { path: issue.path } : {}),
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

export interface StagedValidation {
  valid: boolean;
  repairable: boolean;
  errors: StructuralError[];
  artifacts: number;
  readyPlans: number;
}

/**
 * Deterministic validation of the staged tree. Manifest, hashes, IDs, and the
 * TSV projection are derived here by code; what remains is the document
 * content the writer owns, reported as an ordered, machine-generated error
 * list the single repair can consume.
 */
export async function validateStagedTree(staging: string, workflow: HarnessWorkflow): Promise<StagedValidation> {
  await assertNoEnvironmentSecrets(staging);
  const manifest = await syncManifest(staging);
  const validation = await validateManifestTree(staging);
  const errors = validation.issues.map(structuralError);
  errors.push(...await decompositionErrors(staging, manifest));
  if (validation.valid && !workflowArtifactReady(workflow, manifest.artifacts)) {
    const declaredBlockers = manifest.artifacts
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
  return {
    valid: errors.length === 0,
    repairable: errors.length > 0 && errors.every((error) => !UNREPAIRABLE_CODES.has(error.code)),
    errors,
    artifacts: manifest.artifacts.length,
    readyPlans: manifest.artifacts.filter((artifact) => artifact.kind === "execution-plan" && artifact.status === "ready").length,
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
