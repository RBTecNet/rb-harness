import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Command } from "commander";
import { writeEvidence } from "./evidence.js";
import { HEADLESS_HARNESS_SHA256, HEADLESS_HARNESS_VERSION, runHeadlessInit } from "./headless-runner.js";
import { formatProjectInventory, inspectProjectInventory } from "./harness-inventory.js";
import { harnessBrand, playHarnessSplash } from "./harness-splash.js";
import { listRunStates } from "./harness-state.js";
import { runHarnessWizard } from "./harness-wizard.js";
import {
  defaultRequestForWorkflow,
  resolveStandaloneRequest,
  resumeStandaloneWorkflow,
  runStandaloneWorkflow,
} from "./standalone-runner.js";
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
import type { HarnessWorkflow, ProviderConfiguration } from "./standalone-types.js";

const program = new Command();
const HARNESS_VERSION = "0.2.0";

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
  .description("Provider-neutral documentation harness and deterministic artifact contracts")
  .version(HARNESS_VERSION)
  .option("--splash", "play the RB Harness capybara splash and exit")
  .option("--no-splash", "skip the launch splash")
  .addHelpText("beforeAll", `${harnessBrand(HARNESS_VERSION)}\n\n`)
  .addHelpText("after", [
    "",
    "Standalone examples:",
    "  rb-harness                         Start the interactive wizard",
    "  rb-harness plan --file change.md --provider codex --model gpt-5.6-sol --effort high",
    "  rb-harness review --project . --provider claude --model opus --output .rb",
    "  rb-harness status --project .     Summarize existing artifacts and resumable runs",
  ].join("\n"));

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

const review = program.command("review").description("Audit a product or validate RB review evidence contracts");
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

const headless = program.command("headless").description("Run versioned provider-neutral automation contracts");
headless
  .command("version")
  .description("Print the versioned headless-init boundary identity as JSON")
  .action(() => {
    process.stdout.write(`${JSON.stringify({
      contract: "rb-headless-init/v1",
      version: HEADLESS_HARNESS_VERSION,
      sha256: HEADLESS_HARNESS_SHA256,
    })}\n`);
  });
headless
  .command("init")
  .requiredOption("--output <path>", "absolute isolated output root")
  .action(async (options: { output: string }) => {
    const input = await new Promise<Buffer>((resolveInput, reject) => {
      const chunks: Buffer[] = [];
      process.stdin.on("data", (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
      process.stdin.once("error", reject);
      process.stdin.once("end", () => resolveInput(Buffer.concat(chunks)));
    });
    const outcome = await runHeadlessInit({ input, outputRoot: options.output });
    process.stdout.write(`${JSON.stringify(outcome.result)}\n`);
    process.exitCode = outcome.exitCode;
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
  .option("--artifacts-dir <path>", "physical artifact directory relative to the project", ".rb")
  .option("--json", "emit JSON")
  .action(async (root: string, options: { artifactsDir: string; json?: boolean }) => {
    try {
      const result = await validateManifestTree(root, { artifactDirectory: options.artifactsDir });
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
  .option("--artifacts-dir <path>", "physical artifact directory relative to the project", ".rb")
  .option("--kind <kind>", "artifact kind", "execution-plan")
  .option("--status <status>", "artifact status", "ready")
  .option("--format <format>", "json, tsv, or paths", "paths")
  .action(async (root: string, options: { artifactsDir: string; kind: string; status: ArtifactStatus; format: string }) => {
    try {
      const artifacts = await resolveArtifacts(root, { kind: options.kind, status: options.status, artifactDirectory: options.artifactsDir });
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

interface WorkflowCliOptions {
  prompt?: string;
  file?: string;
  project: string;
  output: string;
  provider: string;
  model: string;
  effort: string;
  adapter?: string;
  answers?: string;
  questions: string;
  nonInteractive?: boolean;
  timeout: string;
  firstOutputTimeout: string;
  depth?: string;
  focus?: string[];
  planAllConfirmed?: boolean;
  findings?: string[];
}

const REVIEW_FOCUS = new Set([
  "product", "security", "tenancy", "frontend", "design", "accessibility",
  "performance", "tests", "data", "operations", "supply-chain",
]);

function applyWorkflowControls(workflow: HarnessWorkflow, request: string, options: WorkflowCliOptions): string {
  const controls: string[] = [];
  const focus = options.focus?.flatMap((entry) => entry.split(",")).map((entry) => entry.trim()).filter(Boolean) ?? [];
  const findings = options.findings?.flatMap((entry) => entry.split(",")).map((entry) => entry.trim()).filter(Boolean) ?? [];
  if (options.depth) {
    if (!["quick", "balanced", "deep"].includes(options.depth)) throw new Error("--depth must be quick, balanced, or deep");
    controls.push(`Inspection depth: ${options.depth}.`);
  }
  if (focus.length) {
    const invalid = focus.filter((entry) => !REVIEW_FOCUS.has(entry));
    if (invalid.length) throw new Error(`unknown --focus area: ${invalid.join(", ")}`);
    controls.push(`Review focus areas: ${focus.join(", ")}. Cross-boundary evidence remains required.`);
  }
  if (options.planAllConfirmed && findings.length) {
    throw new Error("--plan-all-confirmed and --findings are mutually exclusive");
  }
  if (options.planAllConfirmed) {
    controls.push("Remediation selector: plan every and only CONFIRMED finding after the audit set is frozen; do not create a zero-finding plan.");
  }
  if (findings.length) {
    controls.push(`Remediation selector: plan only these stable finding IDs: ${findings.join(", ")}.`);
  }
  if ((focus.length || options.planAllConfirmed || findings.length) && workflow !== "review") {
    throw new Error("--focus, --plan-all-confirmed, and --findings are valid only for review");
  }
  return controls.length ? `${request}\n\nRB Harness operator controls (authoritative):\n- ${controls.join("\n- ")}` : request;
}

function providerConfiguration(options: WorkflowCliOptions): ProviderConfiguration {
  if (!["codex", "claude", "opencode", "custom"].includes(options.provider)) {
    throw new Error("--provider must be codex, claude, opencode, or custom");
  }
  if (options.provider === "custom" && !options.adapter) throw new Error("--provider custom requires --adapter <executable>");
  if (options.provider !== "custom" && options.adapter) throw new Error("--adapter is only valid with --provider custom");
  return {
    provider: options.provider as ProviderConfiguration["provider"],
    model: options.model,
    effort: options.effort,
    ...(options.adapter ? { command: options.adapter } : {}),
  };
}

async function workflowAction(
  workflow: HarnessWorkflow,
  positional: string | undefined,
  options: WorkflowCliOptions,
): Promise<void> {
  const projectRoot = resolve(options.project);
  const source = await resolveStandaloneRequest(projectRoot, positional, options.prompt, options.file);
  const baseRequest = source.request || defaultRequestForWorkflow(workflow, projectRoot);
  if (!baseRequest) throw new Error(`${workflow} requires request text, @file, or --file <path>`);
  const request = applyWorkflowControls(workflow, baseRequest, options);
  if (program.opts<{ splash?: boolean }>().splash !== false) await playHarnessSplash(HARNESS_VERSION);
  const timeoutSeconds = Number(options.timeout);
  const firstOutputTimeoutSeconds = Number(options.firstOutputTimeout);
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 0) throw new Error("--timeout must be a non-negative integer");
  if (!Number.isInteger(firstOutputTimeoutSeconds) || firstOutputTimeoutSeconds < 0) throw new Error("--first-output-timeout must be a non-negative integer");
  if (!(["one-by-one", "batch"] as string[]).includes(options.questions)) throw new Error("--questions must be one-by-one or batch");
  await runStandaloneWorkflow({
    workflow,
    projectRoot,
    artifactDirectory: options.output,
    request,
    requestSource: source.source,
    provider: providerConfiguration(options),
    answersFile: options.answers,
    questionMode: options.questions as "one-by-one" | "batch",
    nonInteractive: Boolean(options.nonInteractive),
    timeoutSeconds,
    firstOutputTimeoutSeconds,
  });
}

function configureWorkflowCommand(command: Command, workflow: HarnessWorkflow): Command {
  return command
    .argument("[request]", "request text, @file, or an existing file path")
    .option("--prompt <text>", "request text supplied explicitly")
    .option("--file <path>", "read the complete request from a file")
    .option("--project <path>", "project root", ".")
    .option("--output <dir>", "project-relative artifact output directory", ".rb")
    .option("--provider <name>", "codex, claude, opencode, or custom", process.env.RB_HARNESS_PROVIDER ?? "codex")
    .option("--model <id>", "provider model ID", process.env.RB_HARNESS_MODEL ?? "")
    .option("--effort <level>", "provider reasoning effort", process.env.RB_HARNESS_EFFORT ?? "")
    .option("--adapter <path>", "custom headless adapter executable")
    .option("--answers <json>", "non-interactive answers keyed by question ID")
    .option("--questions <mode>", "one-by-one or batch", "one-by-one")
    .option("--non-interactive", "never wait for terminal answers")
    .option("--timeout <seconds>", "provider wall timeout; 0 disables", "3600")
    .option("--first-output-timeout <seconds>", "provider first-output timeout; 0 disables", "300")
    .action(async (request: string | undefined, options: WorkflowCliOptions) => workflowAction(workflow, request, options));
}

configureWorkflowCommand(program.command("init").description("Document and plan a new project"), "init");
configureWorkflowCommand(program.command("ai-context").description("Reverse-engineer an implemented project into AS IS context"), "ai-context")
  .option("--depth <mode>", "quick, balanced, or deep inspection", "balanced");
configureWorkflowCommand(program.command("plan").description("Plan an isolated feature, fix, migration, or technical change"), "plan");
configureWorkflowCommand(program.command("evolve").description("Plan a safe change to established product behavior"), "evolve");
configureWorkflowCommand(review, "review")
  .option("--depth <mode>", "quick, balanced, or deep audit", "balanced")
  .option("--focus <areas...>", "one or more review focus areas")
  .option("--plan-all-confirmed", "plan every and only confirmed finding after the audit")
  .option("--findings <ids...>", "plan only the selected stable finding IDs");

program.command("wizard").description("Start the interactive standalone Harness").action(async () => runHarnessWizard(HARNESS_VERSION));

program
  .command("status")
  .description("Summarize existing artifacts, Ralph evidence, and Harness runs")
  .option("--project <path>", "project root", ".")
  .option("--output <dir>", "project-relative artifact directory", ".rb")
  .option("--json", "emit JSON")
  .action(async (options: { project: string; output: string; json?: boolean }) => {
    const projectRoot = resolve(options.project);
    const inventory = await inspectProjectInventory(projectRoot, options.output);
    const runs = await listRunStates(projectRoot);
    if (options.json) process.stdout.write(`${JSON.stringify({ inventory, runs }, null, 2)}\n`);
    else {
      process.stdout.write(`${formatProjectInventory(inventory)}\n\nGerações do Harness: ${runs.length}\n`);
      for (const state of runs.slice(-20)) process.stdout.write(`  ${state.id}\t${state.workflow}\t${state.status}\n`);
    }
  });

program
  .command("resume")
  .description("Resume an interrupted standalone Harness generation")
  .argument("[run-id]", "run ID; defaults to the newest incomplete run")
  .option("--project <path>", "project root", ".")
  .option("--answers <json>", "answers keyed by question ID")
  .option("--non-interactive", "never wait for terminal answers")
  .option("--questions <mode>", "one-by-one or batch", "one-by-one")
  .option("--timeout <seconds>", "provider wall timeout", "3600")
  .option("--first-output-timeout <seconds>", "provider first-output timeout", "300")
  .action(async (runId: string | undefined, options: {
    project: string; answers?: string; nonInteractive?: boolean; questions: string; timeout: string; firstOutputTimeout: string;
  }) => {
    const projectRoot = resolve(options.project);
    if (!runId) {
      const runs = (await listRunStates(projectRoot)).filter((state) => state.status !== "complete");
      runId = runs.at(-1)?.id;
    }
    if (!runId) throw new Error("no incomplete Harness run was found");
    await resumeStandaloneWorkflow(projectRoot, runId, {
      answersFile: options.answers,
      nonInteractive: Boolean(options.nonInteractive),
      questionMode: options.questions as "one-by-one" | "batch",
      timeoutSeconds: Number(options.timeout),
      firstOutputTimeoutSeconds: Number(options.firstOutputTimeout),
    });
  });

const artifacts = program.command("artifacts").description("Inspect compatible artifact trees");
artifacts
  .command("inspect")
  .option("--project <path>", "project root", ".")
  .option("--output <dir>", "project-relative artifact directory", ".rb")
  .option("--json", "emit JSON")
  .action(async (options: { project: string; output: string; json?: boolean }) => {
    const inventory = await inspectProjectInventory(resolve(options.project), options.output);
    process.stdout.write(options.json ? `${JSON.stringify(inventory, null, 2)}\n` : `${formatProjectInventory(inventory)}\n`);
  });

async function main(): Promise<void> {
  if (process.argv.length === 2) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      program.outputHelp();
      throw new Error("no command was provided and the terminal is not interactive");
    }
    await runHarnessWizard(HARNESS_VERSION);
    return;
  }
  if (process.argv.length === 3 && process.argv[2] === "--splash") {
    await playHarnessSplash(HARNESS_VERSION, true);
    return;
  }
  await program.parseAsync(process.argv);
}

void main().catch(fail);
