import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { formatInteractiveQuestion, type InterviewQuestionEvidence } from "../interview.js";
import { defaultConformanceRecordsRoot } from "../providers/conformance/cli.js";
import type { ModelProfile, ProviderAdapter, ResolvedProviderAuth } from "../providers/contract.js";
import {
  listProviderProfiles,
  loadVerifiedProviderProfile,
  resolveProviderAdapter,
  resolveProviderAuth,
  resolveProviderProfile,
} from "../providers/registry.js";
import { claudeCodeAdapter } from "../providers/anthropic/claude-code/adapter.js";
import {
  inspectClaudeCodeCompatibility,
  listClaudeCodeCompatibilityChoices,
  verifyClaudeCodeRuntimeCompatibility,
  type ClaudeCodeCompatibilityInspection,
} from "../providers/anthropic/claude-code/runtime-compatibility.js";
import { CLAUDE_CODE_TRANSPORT_PROFILE_ID } from "../providers/anthropic/claude-code/runtime-model.js";
import {
  assertProgressiveInitPrerequisites,
  formatProgressiveStagePresentation,
  inspectProgressiveInit,
  runProgressiveInit,
  type ProgressiveInitOptions,
  type ProgressiveInitResult,
  type ProgressiveStageSnapshot,
} from "./coordinator.js";
import { progressiveInitStageDefinition, type ProgressiveInitStage } from "./stages.js";

export interface ProgressiveInitCliOptions {
  readonly requestParts: readonly string[];
  readonly requestFile?: string;
  readonly profileId?: string;
  readonly modelSelector?: string;
  readonly credential?: string;
  readonly projectRoot: string;
  readonly headless: boolean;
  readonly deadlineSeconds: number;
  readonly stage?: ProgressiveInitStage;
}

export interface ProgressiveInitCliRuntime {
  readonly inputIsTTY: boolean;
  readonly outputIsTTY: boolean;
  readonly write: (value: string) => void;
  readonly ask: (prompt: string) => Promise<string>;
  readonly inspect: (root: string, request?: string) => Promise<readonly ProgressiveStageSnapshot[]>;
  readonly listProfiles: () => readonly ModelProfile[];
  readonly loadProfile: (profileId: string) => Promise<ModelProfile>;
  readonly adapterFor: (profileId: string) => ProviderAdapter;
  readonly authFor: (profile: ModelProfile, credential?: string) => Promise<ResolvedProviderAuth>;
  readonly listClaudeCodeModels: () => Promise<readonly ClaudeCodeCompatibilityInspection[]>;
  readonly inspectClaudeCodeModel: (selector: string) => Promise<ClaudeCodeCompatibilityInspection>;
  readonly verifyClaudeCodeModel: (selector: string) => Promise<ModelProfile>;
  readonly execute: (options: ProgressiveInitOptions) => Promise<ProgressiveInitResult>;
}

async function requestText(options: ProgressiveInitCliOptions): Promise<string | undefined> {
  if (options.requestFile && options.requestParts.length) throw new Error("use either request text or --file, not both");
  const value = options.requestFile ? await readFile(resolve(options.requestFile), "utf8") : options.requestParts.join(" ");
  return value.trim() || undefined;
}

function profileSummary(profile: ModelProfile): string {
  const runtime = profile.runtimeModel;
  return [
    profile.label,
    profile.id,
    `transport: ${profile.transport}`,
    ...(runtime ? [
      `runtime version: ${runtime.transportVersion}`,
      `requested model: ${runtime.requestedModel}`,
      `resolved model: ${runtime.resolvedModel ?? "unresolved"}`,
      `compatibility: ${profile.conformance.tier === "UNSUPPORTED" ? "UNSUPPORTED" : "SUPPORTED"}`,
    ] : []),
    `request accounting: ${profile.requestAccounting}`,
  ].join("\n");
}

function semanticExecutionStage(
  requested: ProgressiveInitStage | undefined,
  statuses: readonly ProgressiveStageSnapshot[],
): ProgressiveInitStage | undefined {
  const stage = requested ?? statuses.find((entry) => entry.status !== "complete-fresh"
    || entry.stage === "project-phases" && entry.closureStatus !== "fresh")?.stage;
  if (stage !== "project-description" && stage !== "user-stories" && stage !== "database-schema" && stage !== "project-phases") return undefined;
  const status = statuses.find((entry) => entry.stage === stage)?.status;
  return status === "incomplete" || status === "complete-stale" ? stage : undefined;
}

async function supportedDirectProfiles(runtime: ProgressiveInitCliRuntime): Promise<readonly ModelProfile[]> {
  const profiles = await Promise.all(runtime.listProfiles().filter((declared) => declared.transport === "direct-api").map(async (declared) => {
    try {
      const verified = await runtime.loadProfile(declared.id);
      return verified.conformance.tier === "SUPPORTED" ? verified : undefined;
    } catch {
      return undefined;
    }
  }));
  return profiles.filter((entry): entry is ModelProfile => Boolean(entry)).sort((left, right) => left.id.localeCompare(right.id));
}

async function choose(runtime: ProgressiveInitCliRuntime, prompt: string, values: readonly string[]): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const answer = (await runtime.ask(prompt)).trim();
    const ordinal = /^\d+$/.test(answer) ? Number(answer) : 0;
    const selected = ordinal >= 1 && ordinal <= values.length ? values[ordinal - 1] : values.find((value) => value === answer);
    if (selected) return selected;
    runtime.write("Invalid selection. Enter a listed number or exact listed value.\n");
  }
  throw new Error("PROGRESSIVE_INIT_PROFILE_SELECTION_INVALID: no valid selection was made");
}

async function selectTransport(runtime: ProgressiveInitCliRuntime): Promise<"claude-code-cli" | ModelProfile> {
  const direct = await supportedDirectProfiles(runtime);
  const values = [CLAUDE_CODE_TRANSPORT_PROFILE_ID, ...direct.map((profile) => profile.id)];
  runtime.write("\nSelect AI transport:\n\n");
  runtime.write("1. Claude Code CLI\n   transport: claude-code-cli\n   request accounting: opaque\n\n");
  direct.forEach((profile, index) => runtime.write(`${index + 2}. Anthropic API\n   ${profile.id}\n   request accounting: ${profile.requestAccounting}\n\n`));
  const selected = await choose(runtime, "Choice: ", values);
  return selected === CLAUDE_CODE_TRANSPORT_PROFILE_ID ? "claude-code-cli" : direct.find((profile) => profile.id === selected)!;
}

async function selectClaudeCodeModel(runtime: ProgressiveInitCliRuntime): Promise<string> {
  const choices = await runtime.listClaudeCodeModels();
  runtime.write("\nSelect Claude Code model:\n\n");
  choices.forEach((choice, index) => runtime.write(`${index + 1}. ${choice.requestedModel}\n   ${choice.state}${choice.resolvedModel ? ` — resolves to ${choice.resolvedModel}` : " — compatibility verification required"}\n\n`));
  const customOrdinal = choices.length + 1;
  runtime.write(`${customOrdinal}. Enter another model selector\n   UNVERIFIED until compatibility verification succeeds\n\n`);
  const values = [...choices.map((choice) => choice.requestedModel), "__custom__"];
  const selected = await choose(runtime, "Choice: ", values);
  if (selected !== "__custom__") return selected;
  const custom = (await runtime.ask("Model selector: ")).trim();
  if (!custom) throw new Error("MODEL_SELECTOR_INVALID: model selector must not be empty");
  return custom;
}

async function resolveClaudeCodeModel(
  selector: string,
  runtime: ProgressiveInitCliRuntime,
  interactive: boolean,
): Promise<ModelProfile> {
  const inspection = await runtime.inspectClaudeCodeModel(selector);
  if (inspection.state === "SUPPORTED" && inspection.target) return inspection.target;
  if (!interactive) {
    throw new Error(`MODEL_COMPATIBILITY_VERIFICATION_REQUIRED: ${selector} is ${inspection.state}; run rb-harness vnext conformance ${CLAUDE_CODE_TRANSPORT_PROFILE_ID} --verify-runtime-model ${selector}`);
  }
  runtime.write([
    "\nCompatibility verification is required for:\n",
    `Transport: Claude Code CLI ${inspection.transportVersion}\n`,
    `Requested model: ${selector}\n\n`,
    "Verification runs the full RB Harness Claude Code conformance suite and makes bounded Claude Code/model invocations.\n",
  ].join(""));
  const consent = (await runtime.ask("Verify now? [y/N] ")).trim();
  if (!/^(?:y|yes)$/i.test(consent)) throw new Error("MODEL_COMPATIBILITY_VERIFICATION_DECLINED: semantic execution was not started");
  return runtime.verifyClaudeCodeModel(selector);
}

async function resolveExecutionProfile(
  options: ProgressiveInitCliOptions,
  runtime: ProgressiveInitCliRuntime,
  requiresSemanticExecution: boolean,
): Promise<{ readonly profile?: ModelProfile; readonly adapter?: ProviderAdapter; readonly auth?: ResolvedProviderAuth }> {
  if (options.credential && !options.profileId) throw new Error("--credential requires --profile");
  if (options.modelSelector && options.profileId !== CLAUDE_CODE_TRANSPORT_PROFILE_ID) {
    throw new Error(`MODEL_SELECTOR_CONFLICT: ${options.profileId ?? "missing profile"} cannot be combined with --model`);
  }
  if (!requiresSemanticExecution) return {};
  const interactive = !options.headless && runtime.inputIsTTY && runtime.outputIsTTY;
  let profile: ModelProfile;
  if (options.profileId) {
    if (options.profileId === CLAUDE_CODE_TRANSPORT_PROFILE_ID) {
      if (options.credential) throw new Error(`--credential is not accepted for ambient-session profile ${options.profileId}`);
      const selector = options.modelSelector ?? (interactive ? await selectClaudeCodeModel(runtime) : undefined);
      if (!selector) throw new Error(`MODEL_SELECTOR_REQUIRED: provide --model <selector> with --profile ${CLAUDE_CODE_TRANSPORT_PROFILE_ID}`);
      profile = await resolveClaudeCodeModel(selector, runtime, interactive);
    } else {
      const declared = resolveProviderProfile(options.profileId);
      if (declared.transport !== "direct-api" && options.credential) throw new Error(`--credential is not accepted for ambient-session profile ${declared.id}`);
      if (declared.transport === "claude-code-cli") {
        profile = await resolveClaudeCodeModel(declared.modelId, runtime, interactive);
      } else {
        profile = await runtime.loadProfile(options.profileId);
        if (profile.conformance.tier !== "SUPPORTED") throw new Error(`PROGRESSIVE_INIT_PROFILE_UNSUPPORTED: ${profile.id} is not classified SUPPORTED`);
      }
    }
  } else {
    if (!interactive) {
      throw new Error("PROGRESSIVE_INIT_PROFILE_REQUIRED: provide --profile <profile-id> for headless or non-TTY Progressive execution");
    }
    const selected = await selectTransport(runtime);
    profile = selected === "claude-code-cli"
      ? await resolveClaudeCodeModel(await selectClaudeCodeModel(runtime), runtime, true)
      : selected;
  }
  runtime.write(`\nAI profile:\n${profileSummary(profile)}\n\n`);
  return {
    profile,
    adapter: runtime.adapterFor(profile.id),
    auth: await runtime.authFor(profile, options.credential),
  };
}

export async function executeProgressiveInitCommand(
  options: ProgressiveInitCliOptions,
  runtime: ProgressiveInitCliRuntime,
): Promise<void> {
  if (!Number.isFinite(options.deadlineSeconds) || options.deadlineSeconds <= 0 || options.deadlineSeconds > 900) throw new Error("--timeout must be between 1 and 900 seconds");
  const projectRoot = resolve(options.projectRoot);
  const originalRequest = await requestText(options);
  const statuses = await runtime.inspect(projectRoot, originalRequest);
  const headless = options.headless || !runtime.inputIsTTY || !runtime.outputIsTTY;
  const selectedStage = options.stage ?? statuses.find((entry) => entry.status !== "complete-fresh"
    || entry.stage === "project-phases" && entry.closureStatus !== "fresh")?.stage;
  const selectedStatus = statuses.find((entry) => entry.stage === selectedStage)?.status;
  if (selectedStage) assertProgressiveInitPrerequisites(selectedStage, statuses);
  if (headless && selectedStage === "database-schema" && (selectedStatus === "incomplete" || selectedStatus === "complete-stale")) {
    throw new Error("DATABASE_SCHEMA_INTERACTIVE_AUTHORITY_REQUIRED: incomplete or stale database-schema requires interactive developer authority before provider/profile resolution");
  }
  if (headless && selectedStage === "project-phases" && selectedStatus !== "complete-fresh") {
    throw new Error("PROJECT_PHASES_INTERACTIVE_AUTHORITY_REQUIRED: incomplete, stale, or reconciliation-required project-phases requires interactive developer authority before provider/profile resolution");
  }
  const requiresSemanticExecution = Boolean(semanticExecutionStage(options.stage, statuses));
  const configuration = await resolveExecutionProfile(options, runtime, requiresSemanticExecution);
  const answer = async (question: InterviewQuestionEvidence): Promise<string> => runtime.ask(formatInteractiveQuestion(question));
  let activeStage: ProgressiveInitStage | undefined;
  const result = await runtime.execute({
    projectRoot,
    originalRequest,
    selectedStage: options.stage,
    ...configuration,
    interview: configuration.profile ? (headless ? { kind: "headless" } : { kind: "interactive", answer }) : undefined,
    deadlineMs: options.deadlineSeconds * 1_000,
    presentation: {
      stage: (stage, currentStatuses) => {
        activeStage = stage;
        runtime.write(formatProgressiveStagePresentation(stage, currentStatuses));
      },
      question: () => {
        const label = activeStage ? progressiveInitStageDefinition(activeStage).label : "Progressive Init";
        runtime.write(`\n${label} interview\n`);
      },
      complete: (stage, disposition) => {
        const label = progressiveInitStageDefinition(stage).label;
        runtime.write(disposition === "existing-fresh"
          ? `\n✓ ${label} already complete and fresh\nNo regeneration required.\n`
          : `\n✓ ${label} complete\n`);
      },
      transition: (next) => { runtime.write(`\nNext stage: ${next}\nRun the focused stage when ready.\n`); },
    },
  });
  if (result.artifactPath) runtime.write(`Progressive specification: ${result.artifactPath}\n`);
  runtime.write(`Semantic operations: ${result.semanticOperations}\nCorrective regenerations: ${result.correctiveRegenerations}\n`);
}

export async function runProgressiveInitCommand(options: ProgressiveInitCliOptions): Promise<void> {
  const interactive = !options.headless && Boolean(stdin.isTTY) && Boolean(stdout.isTTY);
  const terminal = interactive ? createInterface({ input: stdin, output: stdout }) : undefined;
  try {
    await executeProgressiveInitCommand(options, {
      inputIsTTY: Boolean(stdin.isTTY),
      outputIsTTY: Boolean(stdout.isTTY),
      write: (value) => stdout.write(value),
      ask: async (prompt) => terminal!.question(prompt),
      inspect: inspectProgressiveInit,
      listProfiles: listProviderProfiles,
      loadProfile: (profileId) => loadVerifiedProviderProfile(profileId, defaultConformanceRecordsRoot()),
      adapterFor: resolveProviderAdapter,
      authFor: resolveProviderAuth,
      listClaudeCodeModels: async () => {
        const runtime = await claudeCodeAdapter.runtimePreflight();
        if (!runtime.ok) throw new Error(runtime.error.message);
        return listClaudeCodeCompatibilityChoices({ transportVersion: runtime.value.transportVersion, recordsRoot: defaultConformanceRecordsRoot(), adapter: claudeCodeAdapter });
      },
      inspectClaudeCodeModel: async (requestedModel) => {
        const runtime = await claudeCodeAdapter.runtimePreflight();
        if (!runtime.ok) throw new Error(runtime.error.message);
        return inspectClaudeCodeCompatibility({ requestedModel, transportVersion: runtime.value.transportVersion, recordsRoot: defaultConformanceRecordsRoot(), adapter: claudeCodeAdapter });
      },
      verifyClaudeCodeModel: async (requestedModel) => (await verifyClaudeCodeRuntimeCompatibility({ requestedModel, recordsRoot: defaultConformanceRecordsRoot(), adapter: claudeCodeAdapter })).target,
      execute: runProgressiveInit,
    });
  } finally {
    terminal?.close();
  }
}
