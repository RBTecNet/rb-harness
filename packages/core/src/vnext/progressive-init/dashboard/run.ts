import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { stdin, stdout } from "node:process";
import type { ModelProfile, ProviderAdapter } from "../../providers/contract.js";
import {
  createProgressiveInitCliRuntime,
  executeProgressiveInitWizardStage,
  type ProgressiveInitCliOptions,
  type ProgressiveInitCliRuntime,
} from "../cli.js";
import { inspectProgressiveInit, runProgressiveInit } from "../coordinator.js";
import { projectProgressiveRalphReadiness } from "../readiness.js";
import type { ProgressiveInitStage } from "../stages.js";
import {
  executeProgressiveInitWizard,
  type ProgressiveInitWizardOptions,
  type ProgressiveInitWizardResult,
} from "../wizard-orchestrator.js";
import {
  createProgressiveDashboardController,
  ProgressiveDashboardCancelled,
  type ProgressiveDashboardController,
} from "./controller.js";
import type { ProgressiveProviderIdentity } from "./presentation.js";
import { sanitizeProgressiveFailure } from "./safety.js";
import {
  createProgressiveTerminal,
  progressiveTerminalIsInteractive,
  type ProgressiveTerminal,
  type ProgressiveTerminalInput,
  type ProgressiveTerminalOutput,
} from "./terminal.js";

/**
 * Dashboard-owned Progressive Init run.
 *
 * The Dashboard owns the visual terminal for the whole run: observability,
 * interview, closure and Ralph READY all happen inside the same surface, so the
 * screen is never handed to a separate interview program and taken back. It
 * never chooses a stage, never decides freshness or closure, and never starts
 * Ralph.
 */

export type ProgressiveProviderDescriber = (profile: ModelProfile) => ProgressiveProviderIdentity;

/** The narrow surface a test double needs to drive a Dashboard-hosted run. */
export interface ProgressiveDashboardBindings {
  readonly controller: ProgressiveDashboardController;
  readonly write: (value: string) => void;
  readonly ask: (prompt: string) => Promise<string>;
  readonly signal: AbortSignal;
  readonly activeStage: () => ProgressiveInitStage | undefined;
  readonly setActiveStage: (stage: ProgressiveInitStage) => void;
  readonly describeProvider: ProgressiveProviderDescriber;
}

export interface ProgressiveDashboardRunOptions {
  readonly configuration: ProgressiveInitWizardOptions;
  readonly version: string;
  readonly describeProvider?: ProgressiveProviderDescriber;
  /** Injected for tests; production builds one from the process streams. */
  readonly terminal?: ProgressiveTerminal;
  readonly runId?: string;
  /** Injected for tests; production uses the registry-backed runtime. */
  readonly cliRuntime?: (bindings: ProgressiveDashboardBindings) => ProgressiveInitCliRuntime;
}

export interface ProgressiveDashboardRunResult {
  readonly wizard: ProgressiveInitWizardResult;
  readonly ralphReady: boolean;
  /** Always zero. Progressive Init ends at READY and never starts Ralph. */
  readonly ralphExecutions: 0;
}

export function defaultProgressiveProviderIdentity(profile: ModelProfile): ProgressiveProviderIdentity {
  return {
    providerLabel: profile.family,
    modelLabel: profile.label,
    // The registry object's own id, carried verbatim; never rebuilt from a label.
    profileId: profile.id,
    transport: profile.transport,
    requestAccounting: profile.requestAccounting,
  };
}

/** Count every real transport invocation without altering adapter behavior. */
export function countingProviderAdapter(adapter: ProviderAdapter, onRequest: () => void): ProviderAdapter {
  return new Proxy(adapter, {
    get(target, property, receiver): unknown {
      if (property !== "request") return Reflect.get(target, property, receiver);
      return (...args: Parameters<ProviderAdapter["request"]>) => {
        onRequest();
        return target.request(...args);
      };
    },
  });
}

/**
 * The presentation decorator applied to coordinator execution. It adds
 * observation and cancellation and changes nothing else, so the same semantic
 * operation runs with or without a Dashboard attached.
 */
export function progressiveDashboardExecute(
  bindings: ProgressiveDashboardBindings,
): ProgressiveInitCliRuntime["execute"] {
  const { controller } = bindings;
  return async (initOptions) => {
    const inner = initOptions.presentation;
    return runProgressiveInit({
      ...initOptions,
      signal: bindings.signal,
      presentation: {
        stage: async (stage, statuses) => {
          bindings.setActiveStage(stage);
          controller.emit({ kind: "stage-snapshot", snapshots: statuses });
          if (stage === "project-phases") controller.emit({ kind: "closure-started" });
          await inner?.stage(stage, statuses);
        },
        question: async (question) => {
          controller.presentQuestion(question, bindings.activeStage());
          await inner?.question?.(question);
        },
        complete: async (stage, disposition) => { await inner?.complete?.(stage, disposition); },
        transition: async (next) => { await inner?.transition?.(next); },
      },
    });
  };
}

export function progressiveDashboardCliRuntime(
  bindings: ProgressiveDashboardBindings,
): ProgressiveInitCliRuntime {
  const { controller } = bindings;
  const authoritative = createProgressiveInitCliRuntime({
    inputIsTTY: true,
    outputIsTTY: true,
    write: bindings.write,
    ask: bindings.ask,
  });
  return {
    ...authoritative,
    // `terminalOutput` is deliberately absent: the Dashboard owns the screen, so
    // the legacy interview screen never clears or repaints it.
    inspect: async (root, request) => {
      const snapshots = await authoritative.inspect(root, request);
      controller.emit({ kind: "stage-snapshot", snapshots });
      return snapshots;
    },
    adapterFor: (profileId) => countingProviderAdapter(
      authoritative.adapterFor(profileId),
      () => controller.countTransportInvocation(),
    ),
    authFor: async (profile, credential) => {
      controller.setProvider(bindings.describeProvider(profile));
      return authoritative.authFor(profile, credential);
    },
    execute: progressiveDashboardExecute(bindings),
  };
}

export function progressiveDashboardIsAvailable(
  input: ProgressiveTerminalInput = stdin,
  output: ProgressiveTerminalOutput = stdout,
): boolean {
  return progressiveTerminalIsInteractive(input, output);
}

export async function runProgressiveInitDashboard(
  options: ProgressiveDashboardRunOptions,
): Promise<ProgressiveDashboardRunResult> {
  const projectRoot = resolve(options.configuration.projectRoot);
  const terminal = options.terminal
    ?? createProgressiveTerminal({ input: stdin, output: stdout, env: process.env });
  const abort = new AbortController();
  const controller = createProgressiveDashboardController({
    terminal,
    version: options.version,
    projectRoot,
    runId: options.runId ?? `progressive-dashboard-${randomUUID()}`,
    // Cancellation travels to the execution owner; the Dashboard never exits.
    onCancel: () => abort.abort(),
  });
  let activeStage: ProgressiveInitStage | undefined;
  const bindings: ProgressiveDashboardBindings = {
    controller,
    write: (value) => controller.write(value),
    ask: (prompt) => controller.ask(prompt),
    signal: abort.signal,
    activeStage: () => activeStage,
    setActiveStage: (stage) => { activeStage = stage; },
    describeProvider: options.describeProvider ?? defaultProgressiveProviderIdentity,
  };
  const cliRuntime = (options.cliRuntime ?? progressiveDashboardCliRuntime)(bindings);

  try {
    controller.emit({ kind: "run-started", projectRoot, disposition: "fresh-run" });
    const wizard = await executeProgressiveInitWizard(options.configuration, {
      inspect: cliRuntime.inspect,
      runStage: (stageOptions: ProgressiveInitCliOptions) => executeProgressiveInitWizardStage(stageOptions, cliRuntime),
      write: (value) => controller.write(value),
      observe: (observation) => {
        switch (observation.kind) {
          case "run-started":
            controller.emit({
              kind: "run-started",
              projectRoot,
              disposition: observation.alreadyComplete ? "resume" : "fresh-run",
            });
            return;
          case "stage-snapshot":
            controller.emit({ kind: "stage-snapshot", snapshots: observation.snapshots });
            return;
          case "stage-skipped":
            controller.emit({ kind: "stage-skipped", stage: observation.stage });
            return;
          case "stage-started":
            activeStage = observation.stage;
            controller.emit({ kind: "stage-started", stage: observation.stage });
            return;
          case "stage-finished":
            controller.recordStageAccounting(observation.result);
            controller.emit({ kind: "stage-finished", stage: observation.stage });
            if (observation.stage === "project-phases") controller.emit({ kind: "closure-completed" });
            return;
          case "stage-failed":
            controller.rejectPendingAnswer(sanitizeProgressiveFailure(observation.reason));
            controller.emit({ kind: "stage-failed", stage: observation.stage, reason: observation.reason });
            return;
          default:
            return;
        }
      },
    });

    // Readiness is inspected authoritatively; the Dashboard never derives it
    // from "P4 complete" and never treats closure as readiness.
    const snapshots = await inspectProgressiveInit(projectRoot, undefined);
    controller.emit({ kind: "stage-snapshot", snapshots });
    const readiness = projectProgressiveRalphReadiness(snapshots);
    if (readiness.closureStatus === "fresh") controller.emit({ kind: "closure-completed" });
    controller.emit({ kind: "readiness", established: readiness.ready, reasons: readiness.reasons });
    controller.emit({
      kind: "run-completed",
      zeroWork: wizard.alreadyComplete && wizard.executedStages.length === 0 && wizard.semanticOperations === 0,
    });
    controller.flush();
    // Progressive Init ends here. No Ralph process, plan execution or Ralph
    // dashboard is started from this path.
    return { wizard, ralphReady: readiness.ready, ralphExecutions: 0 };
  } catch (error) {
    controller.emit({
      kind: "run-failed",
      reason: error instanceof ProgressiveDashboardCancelled
        ? "Progressive Init was interrupted by the developer"
        : sanitizeProgressiveFailure(error),
    });
    controller.flush();
    throw error;
  } finally {
    // The owner that created the Dashboard closes it, on every exit path.
    controller.close();
  }
}
