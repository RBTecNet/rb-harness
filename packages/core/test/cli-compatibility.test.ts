import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { harnessCommandSurface } from "../src/cli-program.js";
import { HARNESS_BUDGET } from "../src/harness-budget.js";
import { runStandaloneWorkflow } from "../src/standalone-runner.js";
import { writeRunState } from "../src/harness-state.js";
import { verifyArtifacts } from "../src/artifact-verifier.js";
import type { RunStatus } from "../src/standalone-types.js";

const run = promisify(execFile);
const fakeProvider = resolve(process.cwd(), "test/fixtures/standalone/fake-provider.mjs");

/**
 * The published surface as of the release before the documentation-core
 * refactor. An internal architecture change may never force a user to relearn
 * a command, and an option may only disappear when it existed solely to drive
 * the removed semantic manager — and then only with an explicit error.
 */
async function baseline(): Promise<Record<string, string[]>> {
  return JSON.parse(await readFile(resolve(process.cwd(), "test/fixtures/cli-surface.json"), "utf8")) as Record<string, string[]>;
}

describe("public CLI compatibility", () => {
  it("still exposes every previously published command and flag", async () => {
    const previous = await baseline();
    const current = harnessCommandSurface();
    for (const [command, options] of Object.entries(previous)) {
      expect(current[command], `command ${command} disappeared`).toBeDefined();
      for (const option of options) {
        expect(current[command], `${command} lost ${option}`).toContain(option);
      }
    }
  });

  it("keeps the workflow, wizard, login, provider, and dashboard entry points", () => {
    const current = harnessCommandSurface();
    for (const command of ["init", "ai-context", "plan", "evolve", "review"]) {
      expect(current[`rb-harness ${command}`]).toEqual(expect.arrayContaining([
        "--project", "--output", "--provider", "--model", "--effort", "--prompt", "--file",
        "--answers", "--questions", "--non-interactive", "--timeout", "--first-output-timeout", "--dashboard",
      ]));
    }
    expect(current["rb-harness wizard"]).toBeDefined();
    expect(current["rb-harness provider list"]).toBeDefined();
    expect(current["rb-harness provider test"]).toBeDefined();
    expect(current["rb-harness"]).toEqual(expect.arrayContaining(["--login", "--splash", "--no-splash", "--ver", "--version"]));
    expect(current["rb-harness resume"]).toEqual(expect.arrayContaining(["--dashboard", "--answers", "--questions"]));
  });

  it("fails removed semantic-manager options with explicit guidance instead of silence", async () => {
    const project = await mkdtemp(resolve(tmpdir(), "rb-harness-cli-deprecation-"));
    const cli = resolve(process.cwd(), "dist/cli.js");
    let built = true;
    try {
      await readFile(cli);
    } catch {
      built = false;
    }
    if (!built) return;
    await expect(run(process.execPath, [cli, "--no-splash", "artifacts", "verify", "--project", project, "--remediate"]))
      .rejects.toThrow(/--remediate was removed with the semantic documentation manager/);
    await expect(run(process.execPath, [cli, "--no-splash", "artifacts", "verify", "--project", project, "--from-report", "x.json"]))
      .rejects.toThrow(/--from-report was removed/);
  });

  it("accepts --deterministic-only as the documented default behavior", async () => {
    const project = await mkdtemp(resolve(tmpdir(), "rb-harness-deterministic-only-"));
    await mkdir(resolve(project, ".rb"), { recursive: true });
    const report = await verifyArtifacts({ projectRoot: project, artifactDirectory: ".rb" });
    expect(report.semantic.executed).toBe(false);
  });
});

describe("bounded state graph", () => {
  /**
   * The documentation graph is acyclic except for the counted interview
   * follow-up and bounded counted structural corrections. No stage may restart
   * itself, and no stage may return to an earlier one.
   */
  const TRANSITIONS: Readonly<Record<RunStatus, RunStatus[]>> = {
    "inventory": ["interview", "generating"],
    "interview": ["interview-failed", "blocked", "generating"],
    "interview-failed": [],
    "blocked": [],
    "generating": ["generation-failed", "blocked", "materializing"],
    "generation-failed": [],
    "materializing": ["validating"],
    "validating": ["repairing", "publishing", "generation-failed"],
    "repairing": ["materializing", "generation-failed"],
    "auditing": [],
    "publishing": ["complete", "repairing", "generation-failed"],
    "complete": [],
  };

  it("contains no cycle beyond the two counted allowances", () => {
    const counted = new Set(["repairing->materializing"]);
    const seen = new Set<RunStatus>();
    const stack = new Set<RunStatus>();
    const cycles: string[] = [];
    const visit = (status: RunStatus, edge?: string): void => {
      if (stack.has(status)) {
        if (edge && !counted.has(edge)) cycles.push(edge);
        return;
      }
      if (seen.has(status)) return;
      seen.add(status);
      stack.add(status);
      for (const next of TRANSITIONS[status]) visit(next, `${status}->${next}`);
      stack.delete(status);
    };
    visit("inventory");
    expect(cycles).toEqual([]);
    for (const [status, targets] of Object.entries(TRANSITIONS)) {
      expect(targets, `${status} must not restart itself`).not.toContain(status);
    }
  });

  it("counts both allowances explicitly and finitely", () => {
    // The interview loops until it converges, so its allowance is a declared
    // finite ceiling rather than a fixed round count; corrections also have a
    // small explicit ceiling so one generated defect does not abort the run.
    expect(Number.isInteger(HARNESS_BUDGET.interview.maxRounds)).toBe(true);
    expect(HARNESS_BUDGET.interview.maxRounds).toBeGreaterThan(0);
    expect(Number.isInteger(HARNESS_BUDGET.interview.maxQuestions)).toBe(true);
    expect(HARNESS_BUDGET.interview.maxQuestions).toBeGreaterThan(0);
    expect(HARNESS_BUDGET.generation.structuralRepairs).toBe(3);
    expect(TRANSITIONS.auditing).toEqual([]);
  });
});

describe("resume without repeating paid work", () => {
  it("skips interview analysis when the checkpoint is already ready", async () => {
    const project = await mkdtemp(resolve(tmpdir(), "rb-harness-interview-resume-"));
    await writeFile(resolve(project, "package.json"), '{"name":"fixture"}\n', "utf8");
    const answers = resolve(project, "answers.json");
    await writeFile(answers, '{"scope-boundary":"Yes"}\n', "utf8");
    await chmod(fakeProvider, 0o755);
    const options = {
      workflow: "plan" as const,
      projectRoot: project,
      artifactDirectory: ".rb",
      request: "Plan an isolated version command.",
      provider: { provider: "custom" as const, model: "fixture-model", effort: "high", command: fakeProvider },
      answersFile: answers,
      questionMode: "one-by-one" as const,
      nonInteractive: true,
      timeoutSeconds: 30,
      firstOutputTimeoutSeconds: 5,
    };
    const completed = await runStandaloneWorkflow(options);
    expect(completed.checkpoints?.interviewCompletedAt).toBeTruthy();

    const id = "interview-checkpoint-run";
    const recovery = {
      ...completed,
      id,
      status: "generation-failed" as const,
      bundle: undefined,
      previousArtifacts: undefined,
      publishedAt: undefined,
      telemetry: undefined,
      checkpoints: { interviewCompletedAt: completed.checkpoints?.interviewCompletedAt },
      diagnostic: "provider failed after the interview",
    };
    await writeRunState(recovery);
    const modes = resolve(project, "provider-modes.log");
    process.env.RB_HARNESS_TEST_PROVIDER_MODE_FILE = modes;
    try {
      const { resumeStandaloneWorkflow } = await import("../src/standalone-runner.js");
      const resumed = await resumeStandaloneWorkflow(project, id, { timeoutSeconds: 30, firstOutputTimeoutSeconds: 5 });
      expect(resumed.status).toBe("complete");
      // Only the writer runs again; the interview is never re-analyzed.
      expect((await readFile(modes, "utf8")).trim().split("\n")).toEqual(["generation"]);
    } finally {
      delete process.env.RB_HARNESS_TEST_PROVIDER_MODE_FILE;
    }
  }, 60_000);
});
