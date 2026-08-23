import { copyFile, lstat, mkdir, readdir, readFile, rename, rm, chmod } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { initializeProject, loadManifest, slugify, syncManifest, validateManifestTree } from "./manifest.js";
import type { HarnessRunState, HarnessWorkflow } from "./standalone-types.js";

const IGNORED_DIRECTORIES = new Set([
  ".git", ".rb", ".rb-harness", ".idea", ".vscode", "node_modules", "vendor", "dist", "build", "coverage",
  ".next", ".nuxt", "target", "tmp", "cache", ".cache",
]);
const SECRET_NAMES = /^(?:\.env(?:\..+)?|id_(?:rsa|dsa|ecdsa|ed25519)|credentials(?:\.json)?|secrets?\.json)$/i;
const SECRET_EXTENSIONS = /\.(?:pem|key|p12|pfx|jks|keystore)$/i;
const MAX_SOURCE_FILES = 30_000;
const MAX_SOURCE_BYTES = 768 * 1024 * 1024;

function safeArtifactTarget(projectRoot: string, artifactDirectory: string): string {
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

async function copyTree(
  source: string,
  destination: string,
  options: { excludedAbsolute?: string; artifactsOnly?: boolean } = {},
): Promise<void> {
  let fileCount = 0;
  let byteCount = 0;
  const sourceRoot = resolve(source);
  const excluded = options.excludedAbsolute ? resolve(options.excludedAbsolute) : undefined;

  async function visit(currentSource: string, currentDestination: string, atRoot = false): Promise<void> {
    const sourceInfo = await lstat(currentSource);
    if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw new Error(`copy source is not a regular directory: ${currentSource}`);
    await mkdir(currentDestination, { recursive: true, mode: 0o700 });
    for (const entry of (await readdir(currentSource, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = resolve(currentSource, entry.name);
      if (excluded && (absolute === excluded || absolute.startsWith(`${excluded}${sep}`))) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (options.artifactsOnly && atRoot && entry.name === "runs") continue;
        if (!options.artifactsOnly && IGNORED_DIRECTORIES.has(entry.name)) continue;
        await visit(absolute, resolve(currentDestination, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      if (!options.artifactsOnly && (SECRET_NAMES.test(entry.name) || SECRET_EXTENSIONS.test(entry.name)) && !/\.example$/i.test(entry.name)) continue;
      const info = await lstat(absolute);
      fileCount += 1;
      byteCount += info.size;
      if (fileCount > MAX_SOURCE_FILES || byteCount > MAX_SOURCE_BYTES) {
        throw new Error(`isolated source snapshot exceeds ${MAX_SOURCE_FILES} files or ${MAX_SOURCE_BYTES} bytes`);
      }
      const target = resolve(currentDestination, entry.name);
      await copyFile(absolute, target);
      await chmod(target, info.mode & 0o777).catch(() => undefined);
    }
  }
  await visit(sourceRoot, destination, true);
}

export async function prepareGenerationWorkspace(state: HarnessRunState, runRoot: string): Promise<string> {
  const workspace = resolve(runRoot, "workspace");
  const outputTarget = safeArtifactTarget(state.projectRoot, state.artifactDirectory);
  await rm(workspace, { recursive: true, force: true });
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  await copyTree(state.projectRoot, workspace, { excludedAbsolute: outputTarget });
  const workspaceArtifacts = resolve(workspace, ".rb");
  if (await exists(outputTarget)) {
    const outputInfo = await lstat(outputTarget);
    if (!outputInfo.isDirectory() || outputInfo.isSymbolicLink()) throw new Error("artifact output must be a regular directory");
    await copyTree(outputTarget, workspaceArtifacts, { artifactsOnly: true });
  }
  if (!(await exists(resolve(workspaceArtifacts, "rb-manifest.json")))) {
    const name = state.inventory.projectName || basename(state.projectRoot) || "RB Project";
    await initializeProject(workspace, name, state.inventory.projectId || slugify(name));
  }
  return workspace;
}

function workflowArtifactReady(workflow: HarnessWorkflow, artifacts: Awaited<ReturnType<typeof loadManifest>>["artifacts"]): boolean {
  if (["init", "plan", "evolve"].includes(workflow)) {
    return artifacts.some((artifact) => artifact.kind === "execution-plan" && artifact.status === "ready" && artifact.contract === "rb-execution/v1");
  }
  if (workflow === "ai-context") return artifacts.some((artifact) => artifact.kind === "context-document" && artifact.status === "ready");
  return artifacts.some((artifact) => artifact.kind === "review-findings" && artifact.status === "ready");
}

export async function validateGeneratedWorkspace(workspace: string, workflow: HarnessWorkflow): Promise<{ artifacts: number; readyPlans: number }> {
  await assertNoEnvironmentSecrets(workspace);
  const manifest = await syncManifest(workspace);
  const validation = await validateManifestTree(workspace);
  if (!validation.valid) {
    const details = validation.issues.slice(0, 12).map((issue) => `${issue.code}: ${issue.message}`).join("; ");
    throw new Error(`generated artifact tree is invalid: ${details}`);
  }
  if (!workflowArtifactReady(workflow, manifest.artifacts)) {
    throw new Error(`generated artifacts do not contain the required ready output for workflow ${workflow}`);
  }
  return {
    artifacts: manifest.artifacts.length,
    readyPlans: manifest.artifacts.filter((artifact) => artifact.kind === "execution-plan" && artifact.status === "ready").length,
  };
}

export async function assertNoEnvironmentSecrets(workspace: string): Promise<void> {
  const artifactRoot = resolve(workspace, ".rb");
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

export async function publishGeneratedArtifacts(state: HarnessRunState, runRoot: string, workspace: string): Promise<string | undefined> {
  const target = safeArtifactTarget(state.projectRoot, state.artifactDirectory);
  const staged = resolve(workspace, ".rb");
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
    const stagedRuns = resolve(runRoot, "workspace/.rb/runs");
    const previousRuns = resolve(previous, "runs");
    if (await exists(stagedRuns) && !(await exists(previousRuns))) await rename(stagedRuns, previousRuns);
  }
  await mkdir(dirname(target), { recursive: true });
  await rename(previous, target);
  state.previousArtifacts = undefined;
  return true;
}

export async function generationSourceSummary(workspace: string): Promise<string> {
  const manifest = await loadManifest(workspace);
  return JSON.stringify({
    project: manifest.project,
    existingArtifacts: manifest.artifacts.map((artifact) => ({ id: artifact.id, kind: artifact.kind, status: artifact.status, path: artifact.path })),
  });
}
