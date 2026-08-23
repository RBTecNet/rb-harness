import { access, readFile, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { HarnessWorkflow } from "./standalone-types.js";

interface ResourceRootOptions {
  launcherPath?: string;
  workingDirectory?: string;
  configuredRoot?: string;
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

export async function loadWorkflowResources(workflow: HarnessWorkflow): Promise<string> {
  const root = await resolveWorkflowResourceRoot();
  const paths = [
    "references/interview-policy.md",
    "references/artifact-conventions.md",
    "references/execution-template.md",
    "references/operational-template.md",
    `workflows/${workflow}/instructions.md`,
    `workflows/${workflow}/artifact-shapes.md`,
    ...(workflow === "review" ? ["workflows/review/responsive-evidence.md"] : []),
  ];
  const sections: string[] = [];
  for (const path of paths) {
    sections.push(`\n\n===== RB HARNESS RESOURCE: ${path} =====\n${await readFile(resolve(root, path), "utf8")}`);
  }
  return sections.join("");
}
