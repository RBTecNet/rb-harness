/**
 * The complete public command surface.
 *
 * It lives in its own module so a compatibility test can introspect every
 * command and flag without importing an executable that would parse the host
 * process's arguments. `cli.ts` is the thin entry point that runs it.
 */
import { readFile } from "node:fs/promises";
import { isUtf8 } from "node:buffer";
import { resolve } from "node:path";
import { Command } from "commander";
import { writeEvidence } from "./evidence.js";
import { HEADLESS_HARNESS_SHA256, HEADLESS_HARNESS_VERSION, runHeadlessInit } from "./headless-runner.js";
import { HEADLESS_INTERVIEW_CONTRACT, validateHeadlessInterviewJson } from "./headless-interview-contract.js";
import { runHeadlessInterview } from "./headless-interview-runner.js";
import { formatProjectInventory, inspectProjectInventory } from "./harness-inventory.js";
import { harnessBrand, playHarnessSplash } from "./harness-splash.js";
import { logoutCredential, printCredentialList, runLoginWizard } from "./auth-cli.js";
import { runDirectApiAgentCli } from "./api-agent.js";
import { PROVIDER_HELP, isCliProvider, isDirectProvider } from "./provider-registry.js";
import {
  createInitDashboardController,
  finishHarnessDashboard,
  startHarnessDashboard,
} from "./harness-dashboard.js";
import { HARNESS_VERSION } from "./version.js";
import { printProviderList, runProviderTestCommand } from "./provider-cli.js";
import { listRunStates } from "./harness-state.js";
import {
  artifactVerificationExitCode,
  formatArtifactVerification,
  verifyArtifacts,
} from "./artifact-verifier.js";
import { runRootWizard } from "./root-wizard.js";
import { runInitWizard, type InitWizardPreflightDecision } from "./init-wizard.js";
import {
  groupWizardProfiles,
  wizardModelChoices,
  wizardModelLabel,
} from "./wizard-profile-selector.js";
import { classifyRootCliArgs, formatIncompleteInitDirectMode, missingInitDirectInputs } from "./init-routing.js";
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
import { goPlanNeedsImportInventory, inspectExistingGoImports, validateGoPlanConvergence } from "./go-plan-convergence.js";
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
import { runVnextConformanceCommand } from "./vnext/providers/conformance/cli.js";
import { runClaudeCodeRuntimeConformanceCommand } from "./vnext/providers/anthropic/claude-code/runtime-conformance-cli.js";
import { runInitCommand, type InitCliOptions, type InitCliPresentation } from "./vnext/init-cli.js";
import { runProgressiveInitCommand, type ProgressiveInitCliOptions } from "./vnext/progressive-init/cli.js";
import { runProgressiveInitWizardCommand } from "./vnext/progressive-init/wizard-orchestrator.js";
import { parseProgressiveInitStage } from "./vnext/progressive-init/stages.js";
import { listProviderProfiles } from "./vnext/providers/registry.js";
import type { ModelProfile } from "./vnext/providers/contract.js";
import {
  askProgressiveConfirmation,
  progressiveReinitConfirmationRequest,
} from "./vnext/progressive-init/dashboard/confirm.js";
import type { ProgressiveProviderIdentity } from "./vnext/progressive-init/dashboard/presentation.js";
import {
  progressiveDashboardIsAvailable,
  runProgressiveInitDashboard,
} from "./vnext/progressive-init/dashboard/run.js";
import { createProgressiveTerminal } from "./vnext/progressive-init/dashboard/terminal.js";
import { startProgressiveInitAfterConfirmation } from "./vnext/progressive-init/reinitialize.js";
import { inspectProgressiveRalphReadiness } from "./vnext/progressive-init/readiness.js";
import { verifyManagedCodexRuntime } from "./managed-codex-runtime.js";
import { configureCodexRuntimeVerifier } from "./vnext/providers/openai/codex/managed-runtime.js";
import { CODEX_EXTERNAL_LOGIN_PROVIDER } from "./vnext/providers/openai/codex/login.js";

configureCodexRuntimeVerifier({ verify: verifyManagedCodexRuntime });

function runConfiguredLoginWizard(options: { provider?: string; protocol?: string; label?: string } = {}): Promise<void> {
  return runLoginWizard(options, [CODEX_EXTERNAL_LOGIN_PROVIDER]);
}

const program = new Command();

function canonicalInitPresentation(projectRoot: string): InitCliPresentation {
  const dashboard = createInitDashboardController(HARNESS_VERSION, resolve(projectRoot));
  return {
    start: () => dashboard.start(),
    pause: () => dashboard.pause(),
    resume: () => dashboard.resume(),
    finish: () => dashboard.finish(),
    state: (state) => dashboard.state({
      stage: state.stage,
      selectedProfileId: state.selectedProfileId,
      transport: state.transport,
      requestAccounting: state.requestAccounting,
      questions: state.questions.length,
      semanticOperations: state.counters.semanticOperations,
      transportInvocations: state.counters.transportInvocations,
      correctiveRegenerations: state.counters.correctiveRegenerations,
      providerRequests: state.counters.providerRequests.measured ? String(state.counters.providerRequests.value) : "não medido",
      ...(state.terminalStatus ? { terminalStatus: state.terminalStatus } : {}),
      ...(state.failureKind ? { failureKind: state.failureKind } : {}),
      publicationOccurred: state.publicationOccurred,
      projectRoot: resolve(projectRoot),
      updatedAt: state.updatedAt,
    }),
  };
}

async function runCanonicalInit(options: InitCliOptions & { readonly dashboard?: boolean }): Promise<void> {
  const { dashboard, ...semanticOptions } = options;
  await runInitCommand({ ...semanticOptions, ...(dashboard ? { presentation: canonicalInitPresentation(semanticOptions.projectRoot) } : {}) });
}

/**
 * Exact provider identity for presentation. The provider group and model labels
 * come from the same selector the wizard used, and the profile ID is always the
 * registry object's own value — never rebuilt from a display label.
 */
export function progressiveProviderIdentity(profile: ModelProfile): ProgressiveProviderIdentity {
  const identity: ProgressiveProviderIdentity = {
    providerLabel: profile.family,
    modelLabel: wizardModelLabel(profile),
    profileId: profile.id,
    transport: profile.transport,
    requestAccounting: profile.requestAccounting,
  };
  try {
    const group = groupWizardProfiles(listProviderProfiles())
      .groups.find((candidate) => candidate.profiles.some((entry) => entry.id === profile.id));
    if (!group) return identity;
    const choice = wizardModelChoices(group).find((entry) => entry.profile.id === profile.id);
    return {
      ...identity,
      providerLabel: group.label,
      ...(choice ? { modelLabel: choice.label } : {}),
    };
  } catch {
    // Presentation never fails execution; the exact profile ID still identifies it.
    return identity;
  }
}

/**
 * Authoritative already-Ralph-READY preflight for the interactive Progressive
 * route. Declining performs zero mutation, zero purge, zero provider work and
 * zero stage work; accepting records destructive intent only. The Core purge
 * is deferred until the later final execution confirmation.
 */
async function progressiveInitReinitPreflight(projectRoot: string): Promise<InitWizardPreflightDecision> {
  const readiness = await inspectProgressiveRalphReadiness(projectRoot);
  if (!readiness.ready) return "continue";
  if (!progressiveDashboardIsAvailable()) {
    throw new Error("PROGRESSIVE_INIT_ALREADY_RALPH_READY: this project is already Ralph READY; reinitialization requires interactive confirmation");
  }
  const terminal = createProgressiveTerminal({ input: process.stdin, output: process.stdout, env: process.env });
  let decision: string;
  try {
    decision = await askProgressiveConfirmation(terminal, progressiveReinitConfirmationRequest(projectRoot));
  } finally {
    terminal.close();
  }
  if (decision !== "yes") return "already-ralph-ready";
  return "reinitialize";
}

async function runProgressiveInitWizardFrontDoor(options: { readonly dashboard?: boolean; readonly splash?: boolean }): Promise<void> {
  await runInitWizard(HARNESS_VERSION, {
    ...options,
    profiles: listProviderProfiles(),
    preflight: progressiveInitReinitPreflight,
    execute: async ({ dashboard, execute: _execute, reinitialize, ...configuration }) => {
      // Last safe moment: all non-destructive configuration is complete and
      // the developer has answered the final execution confirmation Yes.
      await startProgressiveInitAfterConfirmation({ projectRoot: configuration.projectRoot, reinitialize }, async () => {
        if (dashboard && progressiveDashboardIsAvailable()) {
          await runProgressiveInitDashboard({
            configuration,
            version: HARNESS_VERSION,
            describeProvider: progressiveProviderIdentity,
          });
          return;
        }
        await runProgressiveInitWizardCommand(configuration);
      });
    },
  });
}

async function runProductRootWizard(options: { readonly dashboard?: boolean; readonly splash?: boolean } = {}): Promise<void> {
  await runRootWizard(HARNESS_VERSION, { ...options, runProgressiveInit: runProgressiveInitWizardFrontDoor });
}

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

export function fail(error: unknown): never {
  process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

program
  .name("rb-harness")
  .description("Provider-neutral documentation harness and deterministic artifact contracts")
  .version(HARNESS_VERSION)
  .option("--ver", "output the version number (alias for --version)")
  .option("--login", "configure a provider credential interactively; combine with --list for safe metadata")
  .option("--list", "with --login, list credential metadata without decrypting or displaying secrets")
  .option("--init", "select Init; selector-only use opens the interactive Init wizard")
  .option("--dashboard", "enable dashboard presentation for the selected operation")
  .option("--splash", "play the RB Harness capybara splash and exit")
  .option("--no-splash", "skip the launch splash")
  .addHelpText("beforeAll", `${harnessBrand(HARNESS_VERSION)}\n\n`)
  .addHelpText("after", [
    "",
    "Standalone examples:",
    "  rb-harness                         Start the interactive wizard",
    "  rb-harness --init                  Run Progressive Init P1→P4 interactively",
    "  rb-harness init --profile anthropic:claude-code-cli:claude-opus-5 --project . \"Build an inventory system\"",
    "  rb-harness plan --file change.md --provider codex --model gpt-5.6-sol --effort high",
    "  rb-harness review --project . --provider claude --model opus --output .rb",
    "  rb-harness provider test          Test a configured API through the guided wizard",
    "  rb-harness artifacts verify       Verify whether generated artifacts are safe for Ralph",
    "  rb-harness status --project .     Summarize existing artifacts and resumable runs",
  ].join("\n"));

const contract = program.command("contract").description("Validate RB execution documents");
contract
  .command("validate")
  .argument("<path>", "PHASES.md path")
  .option("--project <path>", "project root used to inventory existing Go imports", ".")
  .option("--json", "emit JSON")
  .action(async (path: string, options: { project: string; json?: boolean }) => {
    try {
      const result = validateExecutionMarkdown(await readFile(resolve(path), "utf8"));
      const inventory = result.document && goPlanNeedsImportInventory(result.document)
        ? await inspectExistingGoImports(resolve(options.project))
        : undefined;
      const convergence = result.document && inventory?.complete
        ? validateGoPlanConvergence(result.document, { existingImports: inventory.imports, path: path })
        : [];
      const issues = [...result.issues, ...convergence.filter((candidate) => !result.issues.some((existing) =>
        existing.code === candidate.code && existing.line === candidate.line && existing.message === candidate.message))];
      printIssues(issues, Boolean(options.json));
      if (issues.length) process.exitCode = 1;
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

/**
 * Both headless contracts consume exactly one complete UTF-8 JSON document from
 * stdin, terminated by EOF, and emit exactly one JSON result on stdout.
 */
function readHeadlessContractInput(): Promise<Buffer> {
  return new Promise<Buffer>((resolveInput, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
    process.stdin.once("error", reject);
    process.stdin.once("end", () => resolveInput(Buffer.concat(chunks)));
  });
}

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
  .description("Execute one rb-headless-init/v1 request from stdin into an isolated output root")
  .requiredOption("--output <path>", "absolute isolated output root")
  .action(async (options: { output: string }) => {
    const outcome = await runHeadlessInit({ input: await readHeadlessContractInput(), outputRoot: options.output });
    process.stdout.write(`${JSON.stringify(outcome.result)}\n`);
    process.exitCode = outcome.exitCode;
  });

const headlessInterview = headless.command("interview").description("Run the durable adaptive interview contract");
headlessInterview
  .command("version")
  .description("Print the versioned headless interview boundary identity as JSON")
  .action(() => {
    process.stdout.write(`${JSON.stringify({
      contract: HEADLESS_INTERVIEW_CONTRACT,
      version: HEADLESS_HARNESS_VERSION,
      sha256: HEADLESS_HARNESS_SHA256,
    })}\n`);
  });
headlessInterview
  .command("validate")
  .description("Validate one headless interview request or response from stdin")
  .action(async () => {
    const input = await new Promise<Buffer>((resolveInput, reject) => {
      const chunks: Buffer[] = [];
      process.stdin.on("data", (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
      process.stdin.once("error", reject);
      process.stdin.once("end", () => resolveInput(Buffer.concat(chunks)));
    });
    const validation = isUtf8(input)
      ? validateHeadlessInterviewJson(input.toString("utf8"))
      : { valid: false, issues: [{ code: "headless.interview.encoding", message: "stdin must be valid UTF-8", severity: "error" as const, path: "$" }] };
    process.stdout.write(`${JSON.stringify(validation)}\n`);
    if (!validation.valid) process.exitCode = 2;
  });
headlessInterview
  .command("run")
  .description("Process one interview_start or answer message from stdin")
  .requiredOption("--state <path>", "absolute durable interview state root")
  .option("--timeout <seconds>", "adapter wall timeout", "3600")
  .option("--first-output-timeout <seconds>", "adapter first output timeout", "300")
  .action(async (options: { state: string; timeout: string; firstOutputTimeout: string }) => {
    const timeoutSeconds = Number(options.timeout);
    const firstOutputTimeoutSeconds = Number(options.firstOutputTimeout);
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0 || !Number.isFinite(firstOutputTimeoutSeconds) || firstOutputTimeoutSeconds < 0) {
      throw new Error("headless interview timeouts must be non-negative numbers");
    }
    const outcome = await runHeadlessInterview({
      input: await readHeadlessContractInput(),
      stateRoot: options.state,
      timeoutSeconds,
      firstOutputTimeoutSeconds,
    });
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

interface ProviderCliOptions {
  provider: string;
  model: string;
  effort: string;
  credential?: string;
  adapter?: string;
}

interface WorkflowCliOptions extends ProviderCliOptions {
  prompt?: string;
  file?: string;
  project: string;
  output: string;
  answers?: string;
  questions: string;
  nonInteractive?: boolean;
  timeout: string;
  firstOutputTimeout: string;
  depth?: string;
  focus?: string[];
  planAllConfirmed?: boolean;
  findings?: string[];
  dashboard?: boolean;
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

function providerConfiguration(options: ProviderCliOptions): ProviderConfiguration {
  if (!isCliProvider(options.provider) && !isDirectProvider(options.provider)) {
    throw new Error(`--provider must be one of: ${PROVIDER_HELP}`);
  }
  if (options.provider === "custom" && !options.adapter) throw new Error("--provider custom requires --adapter <executable>");
  if (options.provider !== "custom" && options.adapter) throw new Error("--adapter is only valid with --provider custom");
  if (!isDirectProvider(options.provider) && options.credential) throw new Error("--credential is valid only with a direct API provider");
  return {
    provider: options.provider as ProviderConfiguration["provider"],
    model: options.model,
    effort: options.effort,
    ...(options.adapter ? { command: options.adapter } : {}),
    ...(options.credential ? { credential: options.credential } : {}),
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
  if (options.dashboard) startHarnessDashboard(HARNESS_VERSION);
  try {
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
  } finally {
    if (options.dashboard) finishHarnessDashboard();
  }
}

function configureWorkflowCommand(command: Command, workflow: HarnessWorkflow): Command {
  return command
    .argument("[request]", "request text, @file, or an existing file path")
    .option("--prompt <text>", "request text supplied explicitly")
    .option("--file <path>", "read the complete request from a file")
    .option("--project <path>", "project root", ".")
    .option("--output <dir>", "project-relative artifact output directory", ".rb")
    .option("--provider <name>", PROVIDER_HELP, process.env.RB_HARNESS_PROVIDER ?? "codex")
    .option("--model <id>", "provider model ID", process.env.RB_HARNESS_MODEL ?? "")
    .option("--effort <level>", "provider reasoning effort; on DeepSeek: none (default, no reasoning), low, medium, high, xhigh, max", process.env.RB_HARNESS_EFFORT ?? "")
    .option("--credential <id-or-label>", "saved credential selector for a direct API provider")
    .option("--adapter <path>", "custom headless adapter executable")
    .option("--answers <json>", "non-interactive answers keyed by question ID")
    .option("--questions <mode>", "one-by-one or batch", "one-by-one")
    .option("--non-interactive", "never wait for terminal answers")
    .option("--timeout <seconds>", "provider wall timeout; 0 disables", "3600")
    .option("--first-output-timeout <seconds>", "provider first-output timeout; 0 disables", "300")
    .option("--dashboard", "show the live Harness terminal dashboard")
    .action(async (request: string | undefined, options: WorkflowCliOptions) => workflowAction(workflow, request, options));
}

program.command("init")
  .description("Run canonical Init, or one explicitly selected Progressive Init stage")
  .argument("[request...]", "project request text")
  .option("--profile <profile-id>", "exact supported provider/transport/model profile")
  .option("--model <selector>", "runtime model selector for anthropic:claude-code-cli")
  .option("--file <path>", "read request text from a file")
  .option("--credential <id-or-label>", "saved direct API credential selector")
  .option("--project <path>", "project root", ".")
  .option("--headless", "accept generated recommendations through non-interactive policy")
  .option("--timeout <seconds>", "deadline for each provider transport invocation", "120")
  .option("--stage <stage>", `run exactly one Progressive Init stage: project-description, user-stories, database-schema, or project-phases`, parseProgressiveInitStage)
  .option("--dashboard", "show the canonical Init dashboard")
  .action(async (request: string[], options: {
    profile?: string; model?: string; file?: string; credential?: string; project: string; headless?: boolean; timeout: string; dashboard?: boolean; stage?: ReturnType<typeof parseProgressiveInitStage>;
  }) => {
    const dashboard = Boolean(options.dashboard || program.opts<{ dashboard?: boolean }>().dashboard);
    if (options.stage) {
      if (dashboard) throw new Error("PROGRESSIVE_INIT_DASHBOARD_NOT_IMPLEMENTED_PHASE_1: --dashboard cannot be combined with --stage");
      const progressiveOptions: ProgressiveInitCliOptions = {
        requestParts: request,
        requestFile: options.file,
        profileId: options.profile,
        modelSelector: options.model,
        credential: options.credential,
        projectRoot: options.project,
        headless: Boolean(options.headless),
        deadlineSeconds: Number(options.timeout),
        stage: options.stage,
      };
      await runProgressiveInitCommand(progressiveOptions);
      return;
    }
    if (options.model) throw new Error("DYNAMIC_MODEL_SELECTION_PROGRESSIVE_ONLY: --model currently requires --stage");
    const missing = missingInitDirectInputs({ profile: options.profile, requestParts: request, requestFile: options.file });
    if (missing.length) throw new Error(formatIncompleteInitDirectMode(missing));
    await runCanonicalInit({
      requestParts: request,
      requestFile: options.file,
      profileId: options.profile!,
      credential: options.credential,
      projectRoot: options.project,
      headless: Boolean(options.headless),
      deadlineSeconds: Number(options.timeout),
      dashboard,
    });
  });
configureWorkflowCommand(program.command("ai-context").description("Reverse-engineer an implemented project into AS IS context"), "ai-context")
  .option("--depth <mode>", "quick, balanced, or deep inspection", "balanced");
configureWorkflowCommand(program.command("plan").description("Plan an isolated feature, fix, migration, or technical change"), "plan");
configureWorkflowCommand(program.command("evolve").description("Plan a safe change to established product behavior"), "evolve");
configureWorkflowCommand(review, "review")
  .option("--depth <mode>", "quick, balanced, or deep audit", "balanced")
  .option("--focus <areas...>", "one or more review focus areas")
  .option("--plan-all-confirmed", "plan every and only confirmed finding after the audit")
  .option("--findings <ids...>", "plan only the selected stable finding IDs");

program.command("wizard").description("Start the interactive RB Harness product shell").action(async () => runProductRootWizard());

const auth = program.command("auth").description("Manage the shared RB provider credential vault");
auth.command("login")
  .description("Configure one provider interactively; secrets are never accepted as arguments")
  .option("--provider <name>", "provider namespace, including codex-subscription, opencode-go, or opencode-zen")
  .option("--protocol <name>", "api-key, oauth-pkce, or google-adc")
  .option("--label <name>", "local credential label")
  .action(async (options: { provider?: string; protocol?: string; label?: string }) => runConfiguredLoginWizard(options));
auth.command("list")
  .description("List credential metadata without revealing secrets")
  .option("--json", "emit JSON")
  .action(async (options: { json?: boolean }) => printCredentialList(Boolean(options.json)));
auth.command("logout")
  .description("Remove one saved credential")
  .argument("<id-or-label>")
  .action(async (selector: string) => logoutCredential(selector));

const providerCommands = program.command("provider").description("List and test supported providers without starting a workflow");
providerCommands.command("list")
  .description("List CLI/API providers and safe saved-credential metadata")
  .option("--json", "emit rb-provider-list/v1 JSON")
  .action(async (options: { json?: boolean }) => printProviderList(Boolean(options.json)));
providerCommands.command("test")
  .description("Send a minimal PING/PONG request; missing provider/model starts a wizard")
  .option("--provider <name>", "openai, anthropic, gemini, deepseek, minimax, or openrouter")
  .option("--model <id>", "exact provider model ID")
  .option("--credential <id-or-label>", "saved credential selector")
  .option("--effort <level>", "optional provider reasoning effort; on DeepSeek: none (default), low, medium, high, xhigh, max")
  .option("--timeout <seconds>", "connection-test timeout (1-900)", "60")
  .option("--json", "emit rb-provider-test/v1 JSON")
  .action(async (options: {
    provider?: string; model?: string; credential?: string; effort?: string; timeout: string; json?: boolean;
  }) => runProviderTestCommand({
    provider: options.provider,
    model: options.model,
    credential: options.credential,
    effort: options.effort,
    timeout: Number(options.timeout),
    json: Boolean(options.json),
  }));

const vnext = program.command("vnext").description("Run experimental vNext laboratories");
vnext.command("conformance")
  .description("Replay or explicitly record exact-profile adapter conformance")
  .argument("<profile-id>")
  .option("--record", "perform explicit live recording")
  .option("--verify-runtime-model <selector>", "explicitly run full Claude Code compatibility verification into user state")
  .option("--credential <id-or-label>", "saved direct API credential selector")
  .action(async (profileId: string, options: { record?: boolean; verifyRuntimeModel?: string; credential?: string }) => {
    if (options.verifyRuntimeModel !== undefined) {
      if (options.record || options.credential) throw new Error("runtime model verification cannot be combined with --record or --credential");
      await runClaudeCodeRuntimeConformanceCommand({ transportProfileId: profileId, requestedModel: options.verifyRuntimeModel });
      return;
    }
    await runVnextConformanceCommand({ profileId, record: Boolean(options.record), credential: options.credential });
  });

program.command("_provider-run")
  .description("Internal direct API agent adapter")
  .requiredOption("--provider <name>")
  .requiredOption("--model <id>")
  .option("--effort <level>", "", "")
  .requiredOption("--role <role>")
  .requiredOption("--project <path>")
  .option("--permission <mode>", "", "protected")
  .option("--credential <id-or-label>")
  .option("--artifacts-dir <path>")
  .option("--evidence-dir <path>")
  .option("--no-tools", "disable the tool catalog for a closed authoring step")
  .action(async (options: {
    provider: string; model: string; effort: string; role: string; project: string; permission: string;
    credential?: string; artifactsDir?: string; evidenceDir?: string; tools: boolean;
  }) => {
    if (!isDirectProvider(options.provider)) throw new Error(`unsupported direct provider: ${options.provider}`);
    const roles = ["harness-interview", "harness-generation", "harness-repair", "ralph-agent", "ralph-manager"] as const;
    if (!(roles as readonly string[]).includes(options.role)) throw new Error(`unsupported direct API role: ${options.role}`);
    if (!(["yolo", "protected"] as string[]).includes(options.permission)) throw new Error("--permission must be yolo or protected");
    await runDirectApiAgentCli({
      provider: options.provider,
      model: options.model,
      effort: options.effort,
      role: options.role as typeof roles[number],
      projectRoot: resolve(options.project),
      permissionMode: options.permission as "yolo" | "protected",
      credential: options.credential,
      artifactDirectory: options.artifactsDir,
      evidenceDirectory: options.evidenceDir,
      toolsEnabled: options.tools,
    });
  });

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
  .option("--dashboard", "show the live Harness terminal dashboard")
  .action(async (runId: string | undefined, options: {
    project: string; answers?: string; nonInteractive?: boolean; questions: string; timeout: string; firstOutputTimeout: string; dashboard?: boolean;
  }) => {
    const projectRoot = resolve(options.project);
    if (!runId) {
      const runs = (await listRunStates(projectRoot)).filter((state) => state.status !== "complete");
      runId = runs.at(-1)?.id;
    }
    if (!runId) throw new Error("no incomplete Harness run was found");
    const selectedRun = (await listRunStates(projectRoot)).find((state) => state.id === runId);
    if (selectedRun?.workflow === "init") {
      throw new Error("legacy Init runs cannot be resumed after the canonical Init cutover; run rb-harness --init to start Progressive Init");
    }
    if (options.dashboard) startHarnessDashboard(HARNESS_VERSION);
    try {
      await resumeStandaloneWorkflow(projectRoot, runId, {
        answersFile: options.answers,
        nonInteractive: Boolean(options.nonInteractive),
        questionMode: options.questions as "one-by-one" | "batch",
        timeoutSeconds: Number(options.timeout),
        firstOutputTimeoutSeconds: Number(options.firstOutputTimeout),
      });
    } finally {
      if (options.dashboard) finishHarnessDashboard();
    }
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

artifacts
  .command("verify")
  .description("Verify artifact readiness deterministically; no provider is started and no artifact is edited")
  .option("--project <path>", "project root", ".")
  .option("--artifacts-dir <dir>", "physical artifact directory relative to the project", ".rb")
  .option("--against <path>", "authoritative original request file; a matching Harness run is used by default")
  .option("--provider <name>", `${PROVIDER_HELP} (recorded for provenance only)`, process.env.RB_HARNESS_PROVIDER ?? "codex")
  .option("--model <id>", "provider model ID (recorded for provenance only)", process.env.RB_HARNESS_MODEL ?? "")
  .option("--effort <level>", "provider reasoning effort (recorded for provenance only)", process.env.RB_HARNESS_EFFORT ?? "")
  .option("--credential <id-or-label>", "saved credential selector for a direct API provider")
  .option("--adapter <path>", "custom headless adapter executable")
  .option("--deterministic-only", "accepted and now the only behavior; verification never starts a provider")
  .option("--remediate", "removed with the semantic manager; fails with guidance")
  .option("--from-report <path>", "removed with --remediate; fails with guidance")
  .option("--answers <json>", "removed with the remediation interview; fails with guidance")
  .option("--questions <mode>", "accepted for compatibility; deterministic verification asks nothing", "one-by-one")
  .option("--non-interactive", "removed with the remediation interview; fails with guidance")
  .option("--timeout <seconds>", "accepted for compatibility; no provider is started", "3600")
  .option("--first-output-timeout <seconds>", "accepted for compatibility; no provider is started", "300")
  .option("--report <path>", "report path relative to the project; defaults under .rb-harness/verifications")
  .option("--json", "emit rb-harness-artifact-verification/v1 JSON")
  .option("--dashboard", "show the live Harness terminal dashboard")
  .action(async (options: ProviderCliOptions & {
    project: string;
    artifactsDir: string;
    against?: string;
    deterministicOnly?: boolean;
    remediate?: boolean;
    fromReport?: string;
    answers?: string;
    questions: string;
    nonInteractive?: boolean;
    timeout: string;
    firstOutputTimeout: string;
    report?: string;
    json?: boolean;
    dashboard?: boolean;
  }) => {
    const timeoutSeconds = Number(options.timeout);
    const firstOutputTimeoutSeconds = Number(options.firstOutputTimeout);
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 0) throw new Error("--timeout must be a non-negative integer");
    if (!Number.isInteger(firstOutputTimeoutSeconds) || firstOutputTimeoutSeconds < 0) {
      throw new Error("--first-output-timeout must be a non-negative integer");
    }
    if (!(["one-by-one", "batch"] as string[]).includes(options.questions)) {
      throw new Error("--questions must be one-by-one or batch");
    }
    // Options that existed only to drive the removed semantic manager fail
    // with explicit guidance instead of being silently reinterpreted.
    if (options.remediate) {
      throw new Error(
        "--remediate was removed with the semantic documentation manager. Verification is deterministic and never repairs artifacts. "
        + "Re-run the workflow (rb-harness plan/evolve/init/review ...) to regenerate documentation; bounded localized structural correction now happens inside generation.",
      );
    }
    if (options.fromReport) {
      throw new Error("--from-report was removed with --remediate; read the persisted rb-harness-artifact-verification/v1 report directly.");
    }
    if (options.answers || options.nonInteractive) {
      throw new Error("--answers and --non-interactive applied to the removed remediation interview; deterministic verification never asks a question.");
    }
    if (options.dashboard) startHarnessDashboard(HARNESS_VERSION);
    try {
      if (!options.deterministicOnly) {
        process.stderr.write(
          "[rb-harness] verificação é determinística por contrato; nenhum provider é iniciado. --deterministic-only permanece aceito e descreve o comportamento padrão.\n",
        );
      }
      const report = await verifyArtifacts({
        projectRoot: resolve(options.project),
        artifactDirectory: options.artifactsDir,
        againstFile: options.against,
        provider: providerConfiguration(options),
        reportPath: options.report,
      });
      process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatArtifactVerification(report)}\n`);
      process.exitCode = artifactVerificationExitCode(report);
    } finally {
      if (options.dashboard) finishHarnessDashboard();
    }
  });

export async function runHarnessCli(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--ver")) {
    process.stdout.write(`${HARNESS_VERSION}\n`);
    return;
  }
  if (args.length === 2 && args[0] === "--login" && args[1] === "--list") {
    await printCredentialList();
    return;
  }
  if (args.length === 1 && args[0] === "--login") {
    await runConfiguredLoginWizard();
    return;
  }
  if (process.argv.length === 3 && process.argv[2] === "--splash") {
    await playHarnessSplash(HARNESS_VERSION, true);
    return;
  }
  const route = classifyRootCliArgs(args, Boolean(process.stdin.isTTY && process.stdout.isTTY));
  if (route.kind === "root-wizard") {
    await runProductRootWizard({ dashboard: route.dashboard, splash: !args.includes("--no-splash") });
    return;
  }
  if (route.kind === "init-wizard") {
    await runProgressiveInitWizardFrontDoor({ dashboard: route.dashboard, splash: !args.includes("--no-splash") });
    return;
  }
  if (route.kind === "init-direct") {
    await program.parseAsync([process.argv[0]!, process.argv[1]!, "init", ...route.argv]);
    return;
  }
  if (route.kind === "non-interactive-error") {
    program.outputHelp();
    throw new Error(route.operation === "init"
      ? "Init wizard requires an interactive terminal; use rb-harness init --profile <profile-id> --project <path> <request>"
      : "no operation was provided and the terminal is not interactive; use a direct command such as rb-harness init --help");
  }
  await program.parseAsync(process.argv);
}

/**
 * The complete public command surface, exported so a regression test can
 * assert that an internal architecture change never forces a user to relearn
 * a command or rewrite an existing script.
 */
export function harnessCommandSurface(): Record<string, string[]> {
  const surface: Record<string, string[]> = {};
  const visit = (command: Command, path: string[]): void => {
    const name = [...path, command.name()].filter(Boolean).join(" ");
    surface[name] = command.options.map((option) => option.long ?? option.short ?? "").filter(Boolean).sort();
    for (const child of command.commands) visit(child, name ? [name] : []);
  };
  visit(program, []);
  return surface;
}
