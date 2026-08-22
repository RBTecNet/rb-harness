import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Command } from "commander";
import { writeEvidence } from "./evidence.js";
import {
  extractExecutionPhaseMarkdown,
  extractExecutionTaskMarkdown,
  parseValidationInstruction,
  validateExecutionMarkdown,
} from "./execution-contract.js";
import { validateOperationalJson } from "./operational-contract.js";
import { validateResponsiveInventoryJson } from "./responsive-inventory.js";
import {
  initializeProject,
  manifestTsv,
  resolveArtifacts,
  syncManifest,
  validateManifestTree,
} from "./manifest.js";
import type { ArtifactRecord, ArtifactStatus, ValidationIssue } from "./types.js";

const program = new Command();

function printIssues(issues: ValidationIssue[], json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({ valid: issues.length === 0, issues }, null, 2)}\n`);
    return;
  }
  for (const entry of issues) {
    const location = [entry.path, entry.line ? `line ${entry.line}` : undefined].filter(Boolean).join(":");
    process.stderr.write(`${entry.severity.toUpperCase()} ${entry.code}${location ? ` (${location})` : ""}: ${entry.message}\n`);
  }
}

function fail(error: unknown): never {
  process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

program
  .name("rb-harness")
  .description("Deterministic contracts and artifact discovery for RB Harness")
  .version("0.1.5");

const contract = program.command("contract").description("Validate RB execution documents");
contract
  .command("validate")
  .argument("<path>", "PHASES.md path")
  .option("--json", "emit JSON")
  .action(async (path: string, options: { json?: boolean }) => {
    try {
      const result = validateExecutionMarkdown(await readFile(resolve(path), "utf8"));
      printIssues(result.issues, Boolean(options.json));
      if (!result.valid) process.exitCode = 1;
      else if (!options.json) process.stdout.write(`OK: ${path} conforms to rb-execution/v1\n`);
    } catch (error) {
      fail(error);
    }
  });

const operations = program.command("operations").description("Validate RB operational acceptance documents");
operations
  .command("validate")
  .argument("<path>", "OPERATIONS.json path")
  .option("--json", "emit JSON")
  .action(async (path: string, options: { json?: boolean }) => {
    try {
      const result = validateOperationalJson(await readFile(resolve(path), "utf8"));
      printIssues(result.issues, Boolean(options.json));
      if (!result.valid) process.exitCode = 1;
      else if (!options.json) process.stdout.write(`OK: ${path} conforms to rb-operational/v1\n`);
    } catch (error) {
      fail(error);
    }
  });

const review = program.command("review").description("Validate RB review evidence contracts");
review
  .command("validate-responsive")
  .argument("<path>", "RESPONSIVE_INVENTORY.json path")
  .option("--json", "emit JSON")
  .action(async (path: string, options: { json?: boolean }) => {
    try {
      const result = validateResponsiveInventoryJson(await readFile(resolve(path), "utf8"));
      printIssues(result.issues, Boolean(options.json));
      if (!result.valid) process.exitCode = 1;
      else if (!options.json) process.stdout.write(`OK: ${path} conforms to rb-responsive-inventory/v1\n`);
    } catch (error) {
      fail(error);
    }
  });

contract
  .command("inspect")
  .argument("<path>", "PHASES.md path")
  .option("--format <format>", "json or tsv", "json")
  .action(async (path: string, options: { format: string }) => {
    try {
      const result = validateExecutionMarkdown(await readFile(resolve(path), "utf8"));
      if (!result.valid || !result.document) {
        printIssues(result.issues, false);
        process.exitCode = 1;
        return;
      }
      if (options.format === "json") {
        process.stdout.write(`${JSON.stringify(result.document, null, 2)}\n`);
      } else if (options.format === "tsv") {
        process.stdout.write("phase_id\tnumber\ttask_count\tpending_count\tdepends_on\ttitle\n");
        for (const phase of result.document.phases) {
          const title = phase.title.replace(/\t/g, " ");
          const pending = phase.tasks.filter((task) => !task.done).length;
          process.stdout.write(
            `${phase.id}\t${phase.number}\t${phase.tasks.length}\t${pending}\t${phase.dependsOn.join(",")}\t${title}\n`,
          );
        }
      } else {
        throw new Error(`Unknown format ${options.format}; use json or tsv`);
      }
    } catch (error) {
      fail(error);
    }
  });

contract
  .command("extract")
  .argument("<path>", "PHASES.md path")
  .option("--phase <phase-id>", "phase ID such as P01")
  .option("--task <task-id>", "task ID such as T001")
  .action(async (path: string, options: { phase?: string; task?: string }) => {
    try {
      if (Boolean(options.phase) === Boolean(options.task)) {
        throw new Error("Choose exactly one of --phase or --task");
      }
      const source = await readFile(resolve(path), "utf8");
      process.stdout.write(
        options.phase
          ? extractExecutionPhaseMarkdown(source, options.phase)
          : extractExecutionTaskMarkdown(source, options.task!),
      );
    } catch (error) {
      fail(error);
    }
  });

contract
  .command("tasks")
  .argument("<path>", "PHASES.md path")
  .requiredOption("--phase <phase-id>", "phase ID such as P01")
  .option("--format <format>", "json or tsv", "tsv")
  .action(async (path: string, options: { phase: string; format: string }) => {
    try {
      const result = validateExecutionMarkdown(await readFile(resolve(path), "utf8"));
      if (!result.valid || !result.document) {
        const details = result.issues.map((entry) => `${entry.code}: ${entry.message}`).join("; ");
        throw new Error(`Execution document is invalid: ${details}`);
      }
      const phase = result.document.phases.find((entry) => entry.id === options.phase);
      if (!phase) throw new Error(`Unknown phase ${options.phase}`);
      if (options.format === "json") {
        process.stdout.write(`${JSON.stringify(phase.tasks, null, 2)}\n`);
      } else if (options.format === "tsv") {
        process.stdout.write("task_id\tdone\tparallel_safe\tdepends_on\ttitle\n");
        for (const task of phase.tasks) {
          const title = task.title.replace(/\t/g, " ");
          process.stdout.write(
            `${task.id}\t${task.done}\t${task.parallelSafe}\t${task.dependsOn.join(",")}\t${title}\n`,
          );
        }
      } else {
        throw new Error(`Unknown format ${options.format}; use json or tsv`);
      }
    } catch (error) {
      fail(error);
    }
  });

contract
  .command("validations")
  .argument("<path>", "PHASES.md path")
  .requiredOption("--phase <phase-id>", "phase ID such as P01")
  .option("--format <format>", "json or tsv", "tsv")
  .action(async (path: string, options: { phase: string; format: string }) => {
    try {
      const result = validateExecutionMarkdown(await readFile(resolve(path), "utf8"));
      if (!result.valid || !result.document) {
        const details = result.issues.map((entry) => `${entry.code}: ${entry.message}`).join("; ");
        throw new Error(`Execution document is invalid: ${details}`);
      }
      const phase = result.document.phases.find((entry) => entry.id === options.phase);
      if (!phase) throw new Error(`Unknown phase ${options.phase}`);
      const validations = phase.tasks.flatMap((task) =>
        task.validation.map((entry) => ({ taskId: task.id, ...parseValidationInstruction(entry)! })),
      );
      if (options.format === "json") {
        process.stdout.write(`${JSON.stringify(validations, null, 2)}\n`);
      } else if (options.format === "tsv") {
        process.stdout.write("task_id\tkind\tvalue\n");
        for (const validation of validations) {
          process.stdout.write(`${validation.taskId}\t${validation.kind}\t${validation.value}\n`);
        }
      } else {
        throw new Error(`Unknown format ${options.format}; use json or tsv`);
      }
    } catch (error) {
      fail(error);
    }
  });

const project = program.command("project").description("Initialize an RB artifact tree");
project
  .command("init")
  .argument("[root]", "project root", ".")
  .requiredOption("--name <name>", "project display name")
  .option("--id <id>", "stable project ID")
  .action(async (root: string, options: { name: string; id?: string }) => {
    try {
      const manifest = await initializeProject(root, options.name, options.id);
      process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    } catch (error) {
      fail(error);
    }
  });

const manifest = program.command("manifest").description("Manage the artifact manifest");
manifest
  .command("sync")
  .argument("[root]", "project root", ".")
  .option("--json", "emit the manifest")
  .action(async (root: string, options: { json?: boolean }) => {
    try {
      const result = await syncManifest(root);
      process.stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : `OK: indexed ${result.artifacts.length} artifacts\n`);
    } catch (error) {
      fail(error);
    }
  });

const tree = program.command("tree").description("Validate and resolve artifact trees");
tree
  .command("validate")
  .argument("[root]", "project root", ".")
  .option("--json", "emit JSON")
  .action(async (root: string, options: { json?: boolean }) => {
    try {
      const result = await validateManifestTree(root);
      printIssues(result.issues, Boolean(options.json));
      if (!result.valid) process.exitCode = 1;
      else if (!options.json) process.stdout.write(`OK: artifact tree is valid (${result.manifest?.artifacts.length ?? 0} artifacts)\n`);
    } catch (error) {
      fail(error);
    }
  });

tree
  .command("resolve")
  .argument("[root]", "project root", ".")
  .option("--kind <kind>", "artifact kind", "execution-plan")
  .option("--status <status>", "artifact status", "ready")
  .option("--format <format>", "json, tsv, or paths", "paths")
  .action(async (root: string, options: { kind: string; status: ArtifactStatus; format: string }) => {
    try {
      const artifacts = await resolveArtifacts(root, { kind: options.kind, status: options.status });
      if (options.format === "json") {
        process.stdout.write(`${JSON.stringify(artifacts, null, 2)}\n`);
      } else if (options.format === "tsv") {
        const pseudoManifest = {
          manifestVersion: "rb-manifest/v1" as const,
          project: { id: "resolved", name: "Resolved" },
          artifactRoot: ".rb" as const,
          generatedAt: new Date(0).toISOString(),
          artifacts,
        };
        process.stdout.write(manifestTsv(pseudoManifest));
      } else if (options.format === "paths") {
        process.stdout.write(artifacts.map((entry: ArtifactRecord) => entry.path).join("\n") + (artifacts.length ? "\n" : ""));
      } else {
        throw new Error(`Unknown format ${options.format}; use json, tsv, or paths`);
      }
    } catch (error) {
      fail(error);
    }
  });

program
  .command("inspect")
  .description("Collect bounded, secret-safe repository evidence")
  .argument("[root]", "project root", ".")
  .option("--output <path>", "output relative to project root", ".rb/context/evidence.json")
  .option("--no-sync", "do not refresh the artifact manifest")
  .action(async (root: string, options: { output: string; sync: boolean }) => {
    try {
      const target = await writeEvidence(root, options.output);
      if (options.sync) await syncManifest(root);
      process.stdout.write(`OK: evidence written to ${target}\n`);
    } catch (error) {
      fail(error);
    }
  });

async function main(): Promise<void> {
  await program.parseAsync(process.argv);
}

void main().catch(fail);
