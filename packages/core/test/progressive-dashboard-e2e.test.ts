import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { validateManifestTree } from "../src/manifest.js";
import { dispatchCollectedInitWizard } from "../src/init-wizard.js";
import {
  executeProgressiveInitWizardStage,
  type ProgressiveInitCliRuntime,
} from "../src/vnext/progressive-init/cli.js";
import { inspectProgressiveInit } from "../src/vnext/progressive-init/coordinator.js";
import type { ProgressiveDashboardController } from "../src/vnext/progressive-init/dashboard/controller.js";
import {
  countingProviderAdapter,
  progressiveDashboardExecute,
  progressiveDashboardIsAvailable,
  runProgressiveInitDashboard,
  type ProgressiveDashboardBindings,
} from "../src/vnext/progressive-init/dashboard/run.js";
import { purgeProgressiveInitArtifacts } from "../src/vnext/progressive-init/purge.js";
import { startProgressiveInitAfterConfirmation } from "../src/vnext/progressive-init/reinitialize.js";
import { inspectProgressiveRalphReadiness } from "../src/vnext/progressive-init/readiness.js";
import { PROGRESSIVE_INIT_STAGES } from "../src/vnext/progressive-init/stages.js";
import { executeProgressiveInitWizard } from "../src/vnext/progressive-init/wizard-orchestrator.js";
import { resolveProviderProfile } from "../src/vnext/providers/registry.js";
import type { ModelProfile } from "../src/vnext/providers/contract.js";
import {
  character,
  fakeProgressiveTerminal,
  fakeStreams,
  key,
  PROGRESSIVE_FIXTURE_AUTH,
  PROGRESSIVE_FIXTURE_REQUEST,
  ProgressiveFixtureAdapter,
  supportedFixtureProfile,
  type FakeProgressiveTerminal,
} from "./support/progressive-dashboard.js";

const PROFILE_ID = "deepseek:deepseek-v4-pro";
const TEXT_ANSWER = "Hello, <name>!";

function fixtureProfile(): ModelProfile {
  return supportedFixtureProfile(resolveProviderProfile(PROFILE_ID));
}

function wizardOptions(projectRoot: string) {
  return {
    requestParts: [PROGRESSIVE_FIXTURE_REQUEST],
    profileId: PROFILE_ID,
    projectRoot,
    headless: false,
    deadlineSeconds: 120,
  };
}

interface DashboardHarness {
  readonly terminal: FakeProgressiveTerminal;
  readonly adapter: ProgressiveFixtureAdapter;
  readonly prompts: string[];
  readonly answers: string[];
  readonly cliRuntime: (bindings: ProgressiveDashboardBindings) => ProgressiveInitCliRuntime;
  readonly identities: string[];
}

/**
 * Drives the Dashboard the way a developer would: the workspace shows a
 * question, keys are pressed, Enter submits. Nothing here decides semantics.
 */
function dashboardHarness(options: {
  readonly openQuestion?: boolean;
  readonly terminal?: FakeProgressiveTerminal;
  readonly failAtSlice?: string;
} = {}): DashboardHarness {
  const terminal = options.terminal ?? fakeProgressiveTerminal();
  const profile = fixtureProfile();
  const adapter = new ProgressiveFixtureAdapter(profile, options.openQuestion ?? true, options.failAtSlice);
  const prompts: string[] = [];
  const answers: string[] = [];
  const identities: string[] = [];

  const drive = (controller: ProgressiveDashboardController): void => {
    queueMicrotask(() => {
      const interview = controller.state().interview;
      if (!interview) {
        terminal.press(key("enter"));
        return;
      }
      const choices = interview.question.options;
      if (!choices.length) {
        // An open answer is typed and submitted verbatim.
        for (const letter of TEXT_ANSWER) terminal.press(character(letter));
        answers.push(TEXT_ANSWER);
        terminal.press(key("enter"));
        return;
      }
      if (choices.some((option) => option.recommended)) {
        // Enter on the untouched Core recommendation submits blank.
        answers.push("");
        terminal.press(key("enter"));
        return;
      }
      // Core refused to recommend, so an explicit approval selection is made.
      answers.push("1");
      terminal.press(key("down"), key("enter"));
    });
  };

  return {
    terminal,
    adapter,
    prompts,
    answers,
    identities,
    cliRuntime: (bindings) => ({
      inputIsTTY: true,
      outputIsTTY: true,
      write: bindings.write,
      ask: (prompt) => {
        prompts.push(prompt);
        const answer = bindings.ask(prompt);
        drive(bindings.controller);
        return answer;
      },
      inspect: async (root, request) => {
        const snapshots = await inspectProgressiveInit(root, request);
        bindings.controller.emit({ kind: "stage-snapshot", snapshots });
        return snapshots;
      },
      listProfiles: () => [profile],
      loadProfile: async () => profile,
      adapterFor: () => countingProviderAdapter(adapter, () => bindings.controller.countTransportInvocation()),
      authFor: async (selected) => {
        const identity = bindings.describeProvider(selected);
        identities.push(identity.profileId);
        bindings.controller.setProvider(identity);
        return PROGRESSIVE_FIXTURE_AUTH;
      },
      listClaudeCodeModels: async () => [],
      inspectClaudeCodeModel: async () => ({ requestedModel: "unused", transportVersion: "unused", state: "UNSUPPORTED" }),
      verifyClaudeCodeModel: async () => { throw new Error("unused in the fixture"); },
      execute: progressiveDashboardExecute(bindings),
    }),
  };
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

describe("Progressive Dashboard full lifecycle", () => {
  it("runs P1 → P2 → P3 → P4 → closure → Ralph READY and starts zero Ralph executions", async () => {
    const projectRoot = await mkdtemp(resolve(tmpdir(), "rb-progressive-dashboard-e2e-"));
    const harness = dashboardHarness();
    const result = await runProgressiveInitDashboard({
      configuration: wizardOptions(projectRoot),
      version: "1.0.7",
      terminal: harness.terminal,
      runId: "run-a",
      cliRuntime: harness.cliRuntime,
      describeProvider: (profile) => ({
        providerLabel: "DeepSeek API",
        modelLabel: "DeepSeek V4 Pro",
        profileId: profile.id,
        transport: profile.transport,
        requestAccounting: profile.requestAccounting,
      }),
    });

    expect(result.wizard.executedStages).toEqual([...PROGRESSIVE_INIT_STAGES]);
    expect(result.wizard.closureStatus).toBe("fresh");
    expect(result.ralphReady).toBe(true);
    expect(result.ralphExecutions).toBe(0);

    // Core semantics are untouched: same slices, same order, no extra calls.
    expect(harness.adapter.requests.map((request) => request.slice)).toEqual([
      "project-description", "user-stories-questions", "user-stories",
      "database-schema-persistence-questions", "project-phases",
    ]);
    // One closed selection interview and one open text interview were hosted.
    expect(harness.answers).toContain(TEXT_ANSWER);
    expect(harness.answers.filter((answer) => answer === "")).not.toHaveLength(0);
    expect(harness.identities).toEqual(harness.identities.map(() => PROFILE_ID));

    const snapshots = await inspectProgressiveInit(projectRoot, PROGRESSIVE_FIXTURE_REQUEST);
    expect(snapshots.every((entry) => entry.status === "complete-fresh")).toBe(true);
    expect(snapshots.at(-1)?.closureStatus).toBe("fresh");
    expect((await validateManifestTree(projectRoot)).valid).toBe(true);

    // Exactly one Ralph READY execution plan.
    const manifest = JSON.parse(await readFile(resolve(projectRoot, ".rb", "rb-manifest.json"), "utf8"));
    expect(manifest.artifacts.filter((entry: any) => entry.kind === "execution-plan" && entry.status === "ready")).toHaveLength(1);

    // The developer answer became Core-owned authority.
    const description = await readFile(resolve(projectRoot, ".spec", "init", "project-description.md"), "utf8");
    expect(description).toContain(TEXT_ANSWER);

    // The final frame ends at READY and only tells the developer how to start Ralph.
    const frame = harness.terminal.last();
    expect(frame).toContain("RALPH READY ✓");
    expect(frame).toContain("Run `rb-harness --ralph` to start Ralph.");
    expect(harness.terminal.closes()).toBe(1);

    // No Ralph artifact, process marker or dashboard was produced by Init.
    expect(await exists(resolve(projectRoot, ".rb-harness", "ralph"))).toBe(false);
    expect(await readdir(resolve(projectRoot, ".rb"))).toEqual(["init", "rb-manifest.json"]);
  });

  it("performs authoritative zero work on a fresh complete rerun", async () => {
    const projectRoot = await mkdtemp(resolve(tmpdir(), "rb-progressive-dashboard-zero-"));
    const first = dashboardHarness();
    await runProgressiveInitDashboard({
      configuration: wizardOptions(projectRoot),
      version: "1.0.7",
      terminal: first.terminal,
      runId: "run-a",
      cliRuntime: first.cliRuntime,
    });

    const second = dashboardHarness();
    const rerun = await runProgressiveInitDashboard({
      configuration: wizardOptions(projectRoot),
      version: "1.0.7",
      terminal: second.terminal,
      runId: "run-b",
      cliRuntime: second.cliRuntime,
    });

    expect(second.adapter.requests).toEqual([]);
    expect(rerun.wizard).toMatchObject({ alreadyComplete: true, executedStages: [], semanticOperations: 0 });
    expect(rerun.ralphReady).toBe(true);
    const frame = second.terminal.last();
    expect(frame).toContain("Progressive Init already complete and fresh.");
    expect(frame).toContain("RALPH READY ✓");
    expect(frame).toContain("skipped");
  });

  it("skips the stages Core reports fresh and republishes only a stale closure", async () => {
    const projectRoot = await mkdtemp(resolve(tmpdir(), "rb-progressive-dashboard-resume-"));
    const first = dashboardHarness();
    await runProgressiveInitDashboard({
      configuration: wizardOptions(projectRoot),
      version: "1.0.7",
      terminal: first.terminal,
      runId: "run-a",
      cliRuntime: first.cliRuntime,
    });

    // Only the canonical closure becomes stale; P1-P3 stay fresh.
    await rm(resolve(projectRoot, ".rb", "init", "PHASES.md"));
    const stale = await inspectProgressiveInit(projectRoot, PROGRESSIVE_FIXTURE_REQUEST);
    expect(stale.slice(0, 3).every((entry) => entry.status === "complete-fresh")).toBe(true);
    expect(stale.at(-1)?.closureStatus).toBe("stale");

    const second = dashboardHarness();
    const resumed = await runProgressiveInitDashboard({
      configuration: wizardOptions(projectRoot),
      version: "1.0.7",
      terminal: second.terminal,
      runId: "run-b",
      cliRuntime: second.cliRuntime,
    });

    // Core decided the resume point; the Dashboard only displayed it.
    expect(resumed.wizard.skippedStages).toEqual(["project-description", "user-stories", "database-schema"]);
    expect(resumed.wizard.executedStages).toEqual(["project-phases"]);
    expect(second.adapter.requests).toEqual([]);
    expect(resumed.ralphReady).toBe(true);
    const frame = second.terminal.last();
    expect(frame).toContain("P1 ✓ Project Description · fresh · skipped");
    expect(frame).toContain("RALPH READY ✓");
  });

  it("fails closed on the visible surface, restores the terminal and never marks READY", async () => {
    const projectRoot = await mkdtemp(resolve(tmpdir(), "rb-progressive-dashboard-fail-"));
    const harness = dashboardHarness({ failAtSlice: "user-stories" });
    let captured: ProgressiveDashboardController | undefined;
    await expect(runProgressiveInitDashboard({
      configuration: wizardOptions(projectRoot),
      version: "1.0.7",
      terminal: harness.terminal,
      runId: "run-a",
      cliRuntime: (bindings) => {
        captured = bindings.controller;
        return harness.cliRuntime(bindings);
      },
    })).rejects.toThrow(/USER_STORIES/);

    const state = captured!.state();
    expect(state.phase).toBe("failed");
    expect(state.ralphReady).toBe(false);
    expect(state.stages[0]?.disposition).toBe("complete-fresh");
    expect(state.stages[1]?.activity).toBe("failed");
    expect(harness.terminal.closes()).toBe(1);
    const frame = harness.terminal.frames.find((entry) => entry.includes("FAILED"));
    expect(frame).toBeDefined();
    expect(frame).not.toContain("RALPH READY");
    expect(frame).not.toMatch(/continue anyway|force ready|ignore validation/i);
    expect((await inspectProgressiveRalphReadiness(projectRoot)).ready).toBe(false);
  });

  it("restores the terminal when the developer interrupts the run", async () => {
    const projectRoot = await mkdtemp(resolve(tmpdir(), "rb-progressive-dashboard-cancel-"));
    const terminal = fakeProgressiveTerminal();
    const harness = dashboardHarness({ terminal });
    await expect(runProgressiveInitDashboard({
      configuration: wizardOptions(projectRoot),
      version: "1.0.7",
      terminal,
      runId: "run-a",
      cliRuntime: (bindings) => {
        const runtime = harness.cliRuntime(bindings);
        return {
          ...runtime,
          ask: (prompt) => {
            const answer = bindings.ask(prompt);
            // Ctrl+C travels through the cancellation owner, not the renderer.
            queueMicrotask(() => terminal.press(key("interrupt")));
            return answer;
          },
        };
      },
    })).rejects.toThrow(/PROGRESSIVE_INIT_CANCELLED|interrupted/);
    expect(terminal.closes()).toBe(1);
    expect((await inspectProgressiveRalphReadiness(projectRoot)).ready).toBe(false);
  });

  it("keeps a new run free of late events from a superseded run", async () => {
    const projectRoot = await mkdtemp(resolve(tmpdir(), "rb-progressive-dashboard-isolation-"));
    const runA = dashboardHarness();
    let capturedA: ProgressiveDashboardController | undefined;
    await runProgressiveInitDashboard({
      configuration: wizardOptions(projectRoot),
      version: "1.0.7",
      terminal: runA.terminal,
      runId: "run-a",
      cliRuntime: (bindings) => {
        capturedA = bindings.controller;
        return runA.cliRuntime(bindings);
      },
    });
    expect(capturedA).toBeDefined();

    // Destructive reinitialization between the runs.
    await purgeProgressiveInitArtifacts(projectRoot);
    expect((await inspectProgressiveRalphReadiness(projectRoot)).ready).toBe(false);

    const runB = dashboardHarness();
    let capturedB: ProgressiveDashboardController | undefined;
    const resultB = await runProgressiveInitDashboard({
      configuration: wizardOptions(projectRoot),
      version: "1.0.7",
      terminal: runB.terminal,
      runId: "run-b",
      cliRuntime: (bindings) => {
        capturedB = bindings.controller;
        return runB.cliRuntime(bindings);
      },
    });
    expect(resultB.ralphReady).toBe(true);

    const before = capturedB!.state();
    // A late event from run A, with a sequence far ahead of run B's.
    capturedB!.observe({
      runId: "run-a",
      sequence: before.sequence + 10_000,
      kind: "stage-failed",
      stage: "project-description",
      reason: "late run A failure",
    });
    expect(capturedB!.state()).toBe(before);
    expect(capturedB!.state().phase).toBe("completed");
    expect(capturedB!.state().ralphReady).toBe(true);
    expect(capturedB!.state().failure).toBeUndefined();
  });
});

describe("Progressive Dashboard reinitialization end to end", () => {
  it("Refazer Yes followed by final No leaves an already-READY project completely untouched", async () => {
    const projectRoot = await mkdtemp(resolve(tmpdir(), "rb-progressive-reinit-no-"));
    const harness = dashboardHarness();
    await runProgressiveInitDashboard({
      configuration: wizardOptions(projectRoot),
      version: "1.0.7",
      terminal: harness.terminal,
      runId: "run-a",
      cliRuntime: harness.cliRuntime,
    });

    const readiness = await inspectProgressiveRalphReadiness(projectRoot);
    expect(readiness.ready).toBe(true);
    const before = await snapshotTree(projectRoot);
    const requestsBefore = harness.adapter.requests.length;

    let executionStarts = 0;
    const dispatch = await dispatchCollectedInitWizard({
      kind: "configured",
      configuration: {
        ...wizardOptions(projectRoot),
        headless: false,
        dashboard: true,
        execute: false,
        reinitialize: true,
      },
    }, {
      write: () => undefined,
      execute: async (configuration) => {
        executionStarts += 1;
        await startProgressiveInitAfterConfirmation(configuration, async () => undefined);
      },
    });

    // The final No prevents dispatch, so destructive intent alone does nothing.
    expect(dispatch).toBe("cancelled");
    expect(executionStarts).toBe(0);
    expect(await snapshotTree(projectRoot)).toEqual(before);
    expect(harness.adapter.requests).toHaveLength(requestsBefore);
    expect((await inspectProgressiveRalphReadiness(projectRoot)).ready).toBe(true);
  });

  it("Refazer Yes followed by final Yes purges and immediately starts a fresh P1", async () => {
    const projectRoot = await mkdtemp(resolve(tmpdir(), "rb-progressive-reinit-yes-"));
    const first = dashboardHarness();
    await runProgressiveInitDashboard({
      configuration: wizardOptions(projectRoot),
      version: "1.0.7",
      terminal: first.terminal,
      runId: "run-a",
      cliRuntime: first.cliRuntime,
    });
    const originalManifest = await readFile(resolve(projectRoot, ".rb", "rb-manifest.json"), "utf8");
    expect((await inspectProgressiveRalphReadiness(projectRoot)).ready).toBe(true);

    const second = dashboardHarness();
    let purgedBeforeExecution = false;
    const rerun = await startProgressiveInitAfterConfirmation({ projectRoot, reinitialize: true }, async () => {
      const purged = await inspectProgressiveInit(projectRoot, PROGRESSIVE_FIXTURE_REQUEST);
      expect(purged.map((entry) => entry.status)).toEqual(["incomplete", "incomplete", "incomplete", "incomplete"]);
      expect(purged.at(-1)?.closureStatus).toBeUndefined();
      expect(await exists(resolve(projectRoot, ".rb"))).toBe(false);
      purgedBeforeExecution = true;
      return runProgressiveInitDashboard({
        configuration: wizardOptions(projectRoot),
        version: "1.0.7",
        terminal: second.terminal,
        runId: "run-b",
        cliRuntime: second.cliRuntime,
      });
    });

    // The new run genuinely began at P1 and produced a new valid closure.
    expect(rerun.wizard.executedStages).toEqual([...PROGRESSIVE_INIT_STAGES]);
    expect(purgedBeforeExecution).toBe(true);
    expect(rerun.wizard.skippedStages).toEqual([]);
    expect(rerun.ralphReady).toBe(true);
    expect(second.adapter.requests.map((request) => request.slice)[0]).toBe("project-description");
    const manifest = JSON.parse(await readFile(resolve(projectRoot, ".rb", "rb-manifest.json"), "utf8"));
    expect(manifest.artifacts.filter((entry: any) => entry.kind === "execution-plan" && entry.status === "ready")).toHaveLength(1);
    // No contamination from the discarded run.
    expect(await readFile(resolve(projectRoot, ".rb", "rb-manifest.json"), "utf8")).not.toBe(originalManifest);
  });
});

async function snapshotTree(root: string, relative = ""): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(resolve(root, relative), { withFileTypes: true })) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(result, await snapshotTree(root, path));
    else result[path] = await readFile(resolve(root, path), "utf8");
  }
  return result;
}

describe("Progressive Init headless and non-TTY regression", () => {
  it("never creates an interactive controller without a dual TTY", () => {
    const dual = fakeStreams({ isTTY: true });
    const none = fakeStreams({ isTTY: false });
    expect(progressiveDashboardIsAvailable(dual.input, dual.output)).toBe(true);
    expect(progressiveDashboardIsAvailable(none.input, none.output)).toBe(false);
    expect(progressiveDashboardIsAvailable(dual.input, none.output)).toBe(false);
    expect(progressiveDashboardIsAvailable(none.input, dual.output)).toBe(false);
  });

  it("keeps the non-TTY Progressive path textual, deterministic and free of terminal control", async () => {
    const projectRoot = await mkdtemp(resolve(tmpdir(), "rb-progressive-headless-"));
    const profile = fixtureProfile();
    const adapter = new ProgressiveFixtureAdapter(profile, true);
    const output: string[] = [];
    const cliRuntime: ProgressiveInitCliRuntime = {
      inputIsTTY: false,
      outputIsTTY: false,
      write: (value) => void output.push(value),
      ask: async () => { throw new Error("a non-TTY run must never ask an interactive question"); },
      inspect: inspectProgressiveInit,
      listProfiles: () => [profile],
      loadProfile: async () => profile,
      adapterFor: () => adapter,
      authFor: async () => PROGRESSIVE_FIXTURE_AUTH,
      listClaudeCodeModels: async () => [],
      inspectClaudeCodeModel: async () => ({ requestedModel: "unused", transportVersion: "unused", state: "UNSUPPORTED" }),
      verifyClaudeCodeModel: async () => { throw new Error("unused in the fixture"); },
      execute: (await import("../src/vnext/progressive-init/coordinator.js")).runProgressiveInit,
    };

    // Interactive developer authority is required for P3/P4, so a headless run
    // fails closed exactly as the frozen contract specifies.
    await expect(executeProgressiveInitWizard({ ...wizardOptions(projectRoot), headless: true }, {
      inspect: inspectProgressiveInit,
      runStage: (options) => executeProgressiveInitWizardStage({ ...options, headless: true }, cliRuntime),
      write: cliRuntime.write,
    })).rejects.toThrow(/INTERACTIVE_AUTHORITY_REQUIRED/);

    const text = output.join("");
    expect(text).not.toContain("[2J");
    expect(text).not.toContain("[H");
    expect(text).not.toContain("[?25l");
    expect(text).not.toContain("[?25h");
    expect(text).not.toContain("┌");
    expect(text).not.toContain("❯");
    expect(text).toContain("Progressive Init");
    // P1 still completed textually before the fail-closed boundary.
    expect((await inspectProgressiveInit(projectRoot, PROGRESSIVE_FIXTURE_REQUEST))[0]?.status).toBe("complete-fresh");
  });
});
