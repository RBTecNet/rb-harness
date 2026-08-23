import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { HarnessWorkflow } from "./standalone-types.js";

async function resourceRoot(): Promise<string> {
  const executableDirectory = dirname(resolve(process.argv[1] ?? process.cwd()));
  const candidates = [
    process.env.RB_HARNESS_RESOURCE_ROOT,
    resolve(executableDirectory, "resources"),
    resolve(executableDirectory, "../standalone-resources"),
    resolve(process.cwd(), "resources"),
    resolve(process.cwd(), "../../resources"),
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
  const root = await resourceRoot();
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
