import { lstat, readFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { taskScopeTokens, validateExecutionMarkdown } from "./execution-contract.js";
import { goPlanNeedsImportInventory, inspectExistingGoImports, validateGoPlanConvergence } from "./go-plan-convergence.js";
import { validateOperationalJson } from "./operational-contract.js";
import { scopeTokenCoversPath } from "./path-ownership.js";
import type { ArtifactManifest, ArtifactRecord, ExecutionDocument, ValidationIssue } from "./types.js";

interface ConsistencyOptions {
  /** Real project checkout whose existing paths may be referenced. */
  projectRoot: string;
  /** Physical directory that contains the logical `.rb/` tree. */
  artifactRoot: string;
  manifest: ArtifactManifest;
}

interface OperationalPathReference {
  path: string;
  jsonPath: string;
  /** A process probe observes output created by that live process. */
  runtimeProduced: boolean;
  expectsAbsence: boolean;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeLogicalPath(value: string): string {
  if (value.trim() === "${RB_VERIFY_ROOT}") return ".";
  return value
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\$\{RB_VERIFY_ROOT\}\/?/, "")
    .replace(/^\.\//, "")
    .replace(/\/{2,}/g, "/")
    .replace(/\/$/, "");
}

function safeProjectRelativePath(value: string): boolean {
  return Boolean(value)
    && !value.includes("\0")
    && !value.includes("${")
    && !value.startsWith("/")
    && !/^[A-Za-z]:\//.test(value)
    && !value.split("/").includes("..");
}

/** Whether one declared Scope token owns a concrete project-relative path. */
export { scopeTokenCoversPath } from "./path-ownership.js";

function physicalArtifactPath(artifactRoot: string, logicalPath: string): string {
  if (!logicalPath.startsWith(".rb/")) throw new Error(`unsafe logical artifact path: ${logicalPath}`);
  const root = resolve(artifactRoot);
  const target = resolve(root, logicalPath.slice(4));
  if (target === root || !target.startsWith(`${root}${sep}`)) throw new Error(`artifact path escapes .rb: ${logicalPath}`);
  return target;
}

async function readArtifact(options: ConsistencyOptions, artifact: ArtifactRecord): Promise<string> {
  return readFile(physicalArtifactPath(options.artifactRoot, artifact.path), "utf8");
}

function directory(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
}

function fileProbe(
  value: unknown,
  jsonPath: string,
  runtimeProduced: boolean,
  output: OperationalPathReference[],
): void {
  if (!object(value) || value.kind !== "file" || typeof value.path !== "string") return;
  output.push({
    path: value.path,
    jsonPath: `${jsonPath}.path`,
    runtimeProduced,
    expectsAbsence: value.exists === false,
  });
}

const FILE_ARGUMENT = /\.(?:[cm]?[jt]sx?|json|ya?ml|toml|xml|ini|conf|env|css|scss|sass|less|html?|md|py|rb|php|go|rs|java|kt|kts|swift|cs|fs|sh|bash|zsh|ps1|sql|proto|wasm|exe|dll|so|dylib|jar|war)$/i;

/** Extract path-shaped argv values without treating package names as files. */
function commandArgumentPath(value: string, index: number): string | undefined {
  let candidate = value.trim();
  if (!candidate || candidate.includes("://") || candidate.startsWith("@")) return undefined;
  if (/^--?[^=]+=/.test(candidate)) candidate = candidate.slice(candidate.indexOf("=") + 1);
  else if (candidate.startsWith("-")) return undefined;
  candidate = normalizeLogicalPath(candidate);
  if (!candidate) return undefined;
  if (candidate.startsWith(".") || candidate.startsWith("/") || /^[A-Za-z]:\//.test(candidate)) return candidate;
  if (FILE_ARGUMENT.test(candidate)) return candidate;
  // An executable containing a separator is a repository path even when it is
  // extensionless (for example bin/app or tools/verify).
  if (index === 0 && candidate.includes("/")) return candidate;
  return undefined;
}

function commandPaths(
  value: unknown,
  jsonPath: string,
  output: OperationalPathReference[],
): void {
  if (!object(value) || !Array.isArray(value.argv)) return;
  value.argv.forEach((argument, argumentIndex) => {
    if (typeof argument !== "string") return;
    const path = commandArgumentPath(argument, argumentIndex);
    if (!path) return;
    output.push({
      path,
      jsonPath: `${jsonPath}.argv[${argumentIndex}]`,
      runtimeProduced: false,
      expectsAbsence: false,
    });
  });
}

function operationalPathReferences(document: Record<string, unknown>): OperationalPathReference[] {
  const output: OperationalPathReference[] = [];
  if (!Array.isArray(document.scenarios)) return output;
  document.scenarios.forEach((scenario, scenarioIndex) => {
    if (!object(scenario) || !Array.isArray(scenario.steps)) return;
    scenario.steps.forEach((step, stepIndex) => {
      if (!object(step)) return;
      const stepPath = `$.scenarios[${scenarioIndex}].steps[${stepIndex}]`;
      fileProbe(step, stepPath, false, output);
      if ((step.kind === "command" || step.kind === "process") && object(step.command)) {
        commandPaths(step.command, `${stepPath}.command`, output);
        if (typeof step.command.cwd === "string") {
          output.push({
            path: step.command.cwd,
            jsonPath: `${stepPath}.command.cwd`,
            runtimeProduced: false,
            expectsAbsence: false,
          });
        }
      }
      if (step.kind === "process") {
        fileProbe(step.ready, `${stepPath}.ready`, true, output);
        if (Array.isArray(step.checks)) {
          step.checks.forEach((probe, probeIndex) => fileProbe(
            probe,
            `${stepPath}.checks[${probeIndex}]`,
            true,
            output,
          ));
        }
      }
    });
  });
  return output;
}

function exclusions(document: Record<string, unknown>): string[] {
  if (!object(document.cleanRoom) || !Array.isArray(document.cleanRoom.exclude)) return [];
  return document.cleanRoom.exclude
    .filter((entry): entry is string => typeof entry === "string")
    .map(normalizeLogicalPath)
    .filter(Boolean);
}

async function pathExists(projectRoot: string, logicalPath: string): Promise<boolean> {
  const root = resolve(projectRoot);
  const target = resolve(root, logicalPath);
  if (target !== root && !target.startsWith(`${root}${sep}`)) return false;
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}

function issue(code: string, message: string, path: string): ValidationIssue {
  return { code, message, path, severity: "error" };
}

function tasks(document: ExecutionDocument) {
  return document.phases.flatMap((phase) => phase.tasks);
}

/**
 * Validate relationships that no individual document schema can prove.
 *
 * In particular, a greenfield operational contract may name files that do not
 * exist yet. Such a path is honest only when PHASES grants a task authority to
 * create it, or when it is a declared clean-room build output. This catches
 * drift like `src/game.js` in OPERATIONS versus `game.js` in PHASES before the
 * immutable bundle is published.
 */
export async function validateArtifactConsistency(options: ConsistencyOptions): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const plans = new Map<string, { artifact: ArtifactRecord; document: ExecutionDocument }>();
  for (const artifact of options.manifest.artifacts.filter((entry) => entry.kind === "execution-plan")) {
    const parsed = validateExecutionMarkdown(await readArtifact(options, artifact));
    if (parsed.valid && parsed.document) plans.set(directory(artifact.path), { artifact, document: parsed.document });
  }

  for (const operational of options.manifest.artifacts.filter((entry) => entry.kind === "operational-verification")) {
    const plan = plans.get(directory(operational.path));
    if (!plan) continue;
    const parsed = validateOperationalJson(await readArtifact(options, operational));
    if (!parsed.valid || !parsed.document) continue;
    const scopes = tasks(plan.document).flatMap((task) => taskScopeTokens(task.scope));
    const generatedRoots = exclusions(parsed.document);
    for (const reference of operationalPathReferences(parsed.document)) {
      const path = normalizeLogicalPath(reference.path);
      if (!safeProjectRelativePath(path)) {
        issues.push(issue(
          "artifact.cross-reference.unsafe-operational-path",
          `${operational.path} ${reference.jsonPath} names a non-portable project path: ${reference.path}`,
          operational.path,
        ));
        continue;
      }
      if (reference.runtimeProduced || reference.expectsAbsence) continue;
      if (await pathExists(options.projectRoot, path)) continue;
      if (scopes.some((scope) => scopeTokenCoversPath(scope, path))) continue;
      if (generatedRoots.some((root) => scopeTokenCoversPath(root, path))) continue;
      issues.push(issue(
        "artifact.cross-reference.unowned-operational-path",
        `${operational.path} ${reference.jsonPath} names future path ${reference.path}, but sibling plan `
          + `${plan.artifact.path} gives no task authority to create it and cleanRoom.exclude does not declare it as generated output.`,
        operational.path,
      ));
    }
  }

  const goPlans = [...plans.values()].filter(({ document }) => goPlanNeedsImportInventory(document));
  if (goPlans.length) {
    const inventory = await inspectExistingGoImports(options.projectRoot);
    if (inventory.complete) {
      for (const { artifact, document } of goPlans) {
        issues.push(...validateGoPlanConvergence(document, {
          existingImports: inventory.imports,
          path: artifact.path,
        }));
      }
    }
  }
  return issues;
}
