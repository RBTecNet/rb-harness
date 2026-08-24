import { access, readFile, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { HarnessWorkflow } from "./standalone-types.js";

interface ResourceRootOptions {
  launcherPath?: string;
  workingDirectory?: string;
  configuredRoot?: string;
}

/** Which prompt consumes the resources; each stage loads only what it needs. */
export type WorkflowResourceSection = "interview" | "generation" | "repair";

interface WorkflowResourceOptions {
  includeHeadlessContracts?: boolean;
  section?: WorkflowResourceSection;
}

export function requestNeedsHeadlessContracts(request: string): boolean {
  const normalized = request.toLowerCase();
  return normalized.includes("rb-harness")
    || normalized.includes("rb harness")
    || normalized.includes("rb-headless");
}

export async function resolveWorkflowResourceRoot(options: ResourceRootOptions = {}): Promise<string> {
  const workingDirectory = resolve(options.workingDirectory ?? process.cwd());
  const launcherPath = resolve(options.launcherPath ?? process.argv[1] ?? workingDirectory);
  let installedLauncherPath = launcherPath;
  try {
    installedLauncherPath = await realpath(launcherPath);
  } catch {
    // Source runners and embedders may not expose a filesystem-backed argv[1].
  }
  const launcherDirectories = [...new Set([
    dirname(installedLauncherPath),
    dirname(launcherPath),
  ])];
  const candidates = [
    options.configuredRoot ?? process.env.RB_HARNESS_RESOURCE_ROOT,
    ...launcherDirectories.flatMap((directory) => [
      resolve(directory, "resources"),
      resolve(directory, "../standalone-resources"),
    ]),
    resolve(workingDirectory, "resources"),
    resolve(workingDirectory, "../../resources"),
  ].filter((entry): entry is string => Boolean(entry));
  for (const candidate of candidates) {
    try {
      await access(resolve(candidate, "references/interview-policy.md"));
      return candidate;
    } catch {
      // Try the next source-tree or installed-package location.
    }
  }
  throw new Error("RB Harness workflow resources were not found; reinstall the complete standalone package");
}

export async function loadWorkflowResources(
  workflow: HarnessWorkflow,
  options: WorkflowResourceOptions = {},
): Promise<string> {
  const section = options.section ?? "generation";
  // The mechanical formats (execution grammar, operational shape, artifact
  // conventions, interview policy) are code-owned by the contract digest.
  // Only workflow-specific semantic guidance is still read from disk.
  if (section === "repair") return "";
  const root = await resolveWorkflowResourceRoot();
  const resources = [
    { label: `workflows/${workflow}/instructions.md`, path: resolve(root, `workflows/${workflow}/instructions.md`) },
    ...(section === "generation"
      ? [{ label: `workflows/${workflow}/artifact-shapes.md`, path: resolve(root, `workflows/${workflow}/artifact-shapes.md`) }]
      : []),
    ...(section === "generation" && workflow === "review"
      ? [{ label: "workflows/review/responsive-evidence.md", path: resolve(root, "workflows/review/responsive-evidence.md") }]
      : []),
  ];
  if (options.includeHeadlessContracts) {
    const contractRoot = resolve(root, "../contracts");
    resources.push(
      { label: "contracts/rb-headless-init-v1.md", path: resolve(contractRoot, "rb-headless-init-v1.md") },
      { label: "contracts/rb-headless-interview-v1.md", path: resolve(contractRoot, "rb-headless-interview-v1.md") },
    );
  }
  const sections: string[] = [];
  for (const resource of resources) {
    sections.push(`\n\n===== RB HARNESS RESOURCE: ${resource.label} =====\n${await readFile(resource.path, "utf8")}`);
  }
  return sections.join("");
}
