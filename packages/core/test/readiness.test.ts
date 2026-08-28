/**
 * Readiness corrections CR-001 … CR-007.
 *
 * Every test here first reproduced a real defect in the 0.4.0 working tree.
 * They are deterministic and offline: no network, no authentication, no paid
 * provider call. Provider behaviour comes from local fixtures only.
 */

import { chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { providerInvocation, runProvider } from "../src/harness-provider.js";
import {
  confinesReads,
  describeAdapterControl,
  describeReadConfinement,
  isControlledAdapter,
  providerCapabilities,
} from "../src/provider-capabilities.js";
import { discardEvidenceProjection, prepareEvidenceProjection } from "../src/harness-evidence.js";
import { ProviderStreamObserver } from "../src/provider-events.js";
import { parseDocumentBundle } from "../src/harness-documents.js";
import { spawnProcessTree, trackedProcessTrees } from "../src/process-tree.js";
import { currentCgroupPath, describeContainment, detectContainmentSupport } from "../src/process-containment.js";
import { acquireHarnessLock } from "../src/harness-state.js";
import { isExecutable } from "./support/process-liveness.js";
import { HARNESS_BUDGET } from "../src/harness-budget.js";
import { parseInterviewAnalysis } from "../src/harness-interview.js";
import { createToolGovernor, executeApiAgentTool } from "../src/api-agent-tools.js";
import { runStandaloneWorkflow } from "../src/standalone-runner.js";
import {
  assertPromptWithinBudget,
  buildInputPackage,
  serializeInputPackage,
} from "../src/harness-input-package.js";
import { inspectProjectInventory } from "../src/harness-inventory.js";
import { buildInterviewPrompt, stableInterviewPrefix } from "../src/harness-interview.js";
import { buildGenerationPrompt, stableGenerationPrefix } from "../src/harness-generator.js";
import { loadWorkflowResources } from "../src/standalone-resources.js";
import { emptyUsage, formatTelemetryReport } from "../src/harness-telemetry.js";
import type { HarnessRunState } from "../src/standalone-types.js";
import type { InterviewAnswer } from "../src/standalone-types.js";

const fixtures = resolve(process.cwd(), "test/fixtures/standalone");
const orphaningProvider = resolve(fixtures, "orphaning-provider.mjs");
const snoopingProvider = resolve(fixtures, "snooping-provider.mjs");
const escapingProvider = resolve(fixtures, "escaping-provider.mjs");
const fakeProvider = resolve(fixtures, "fake-provider.mjs");

/**
 * A process that can still execute work. Deliberately not `kill(pid, 0)`,
 * which also succeeds for a zombie awaiting reaping — see
 * `test/support/process-liveness.ts`.
 */
const alive = isExecutable;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

async function recordedPids(path: string, expected: number): Promise<number[]> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const source = await readFile(path, "utf8").catch(() => "");
    const pids = [...source.matchAll(/=(\d+)/g)].map((match) => Number(match[1]));
    if (pids.length >= expected) return pids;
    await sleep(25);
  }
  throw new Error(`the provider tree never reported ${expected} processes`);
}

describe.skipIf(process.platform === "win32")("CR-001 · the tree dies even when the leader succeeds", () => {
  it("does not return while a descendant of a successful run is still alive", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "rb-harness-orphan-"));
    const pidFile = resolve(directory, "tree.pids");
    await writeFile(pidFile, "", "utf8");
    await chmod(orphaningProvider, 0o755);
    process.env.RB_HARNESS_TEST_TREE_PID_FILE = pidFile;
    try {
      const result = await runProvider({
        configuration: { provider: "custom", model: "fixture", effort: "", command: orphaningProvider },
        mode: "interview",
        stage: "gap-analysis",
        projectRoot: directory,
        prompt: "fixture prompt",
        logPath: resolve(directory, "provider.log"),
        timeoutSeconds: 60,
        firstOutputTimeoutSeconds: 0,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("RB_HARNESS_INTERVIEW_JSON_END");
      const pids = await recordedPids(pidFile, 2);
      // The whole tree must already be gone by the time runProvider resolves.
      expect(pids.filter(alive)).toEqual([]);
      expect(trackedProcessTrees()).toBe(0);
      const release = await acquireHarnessLock(directory, "orphan-lock-recovery-run");
      await release();
    } finally {
      delete process.env.RB_HARNESS_TEST_TREE_PID_FILE;
    }
  }, 60_000);
});

describe.skipIf(process.platform === "win32")("CR-001 · a descendant that escapes the process group", () => {
  it("either contains the escapee structurally or refuses to claim quiescence", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "rb-harness-escape-"));
    const pidFile = resolve(directory, "tree.pids");
    await writeFile(pidFile, "", "utf8");
    await chmod(escapingProvider, 0o755);
    process.env.RB_HARNESS_TEST_TREE_PID_FILE = pidFile;
    try {
      // The leader answers nothing and exits immediately, so neither the
      // first-output sample nor any periodic sample can observe the escapee.
      await runProvider({
        configuration: { provider: "custom", model: "fixture", effort: "", command: escapingProvider },
        mode: "interview",
        stage: "gap-analysis",
        projectRoot: directory,
        prompt: "fixture prompt",
        logPath: resolve(directory, "provider.log"),
        timeoutSeconds: 30,
        firstOutputTimeoutSeconds: 0,
      }).catch(() => undefined);
      const pids = await recordedPids(pidFile, 2);
      const log = await readFile(resolve(directory, "provider.log"), "utf8");
      const structural = /^tree_containment_structural=true$/m.test(log);
      if (structural) {
        // With real containment the escapee is enumerable and dies with the
        // rest of the tree.
        expect(pids.filter(alive)).toEqual([]);
        expect(log).toMatch(/^tree_quiescence_verified=true$/m);
      } else {
        // Without it the Harness must not claim a guarantee it cannot make.
        expect(log).toMatch(/^tree_quiescence_verified=false$/m);
        for (const pid of pids.filter(alive)) {
          try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
        }
      }
      expect(trackedProcessTrees()).toBe(0);
    } finally {
      delete process.env.RB_HARNESS_TEST_TREE_PID_FILE;
    }
  }, 60_000);

  it("never reports zero survivors for a tree it could not observe", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "rb-harness-unobserved-"));
    await chmod(fakeProvider, 0o755);
    // A structural mechanism that cannot answer: the run is unobserved, and
    // "0 descendant process(es) alive" would be both false and reassuring.
    await expect(runProvider({
      configuration: { provider: "custom", model: "fixture", effort: "", command: fakeProvider },
      mode: "interview",
      stage: "gap-analysis",
      projectRoot: directory,
      prompt: "fixture prompt",
      logPath: resolve(directory, "provider.log"),
      timeoutSeconds: 20,
      firstOutputTimeoutSeconds: 5,
      containment: {
        kind: "cgroup2",
        structural: true,
        reason: "fixture cgroup that cannot be observed",
        wrap: (command, args) => ({ command, args }),
        members: () => undefined,
        killAll: () => false,
        destroy: () => undefined,
      },
    })).rejects.toThrow(/tree could not be verified[\s\S]*could not be observed/);

    const log = await readFile(resolve(directory, "provider.log"), "utf8");
    expect(log).toMatch(/^tree_observed=false$/m);
    expect(log).toMatch(/^tree_quiescent=false$/m);
    expect(log).toMatch(/^tree_quiescence_verified=false$/m);
    // The false, reassuring phrasing must be gone entirely.
    expect(log).not.toContain("left 0 descendant");
  }, 60_000);

  it("declares what the platform can and cannot guarantee", () => {
    const support = detectContainmentSupport();
    expect(["cgroup2", "process-group", "windows-taskkill"]).toContain(support.kind);
    expect(support.structural).toBe(support.kind === "cgroup2");
    expect(describeContainment(support)).toContain(support.structural ? "estrutural" : "melhor esforço");
  });

  it("never presents taskkill as a Job Object", () => {
    const windows = {
      kind: "windows-taskkill" as const,
      structural: false,
      reason: "taskkill /T walks the parent chain; this is not a Job Object and cannot contain a re-parented descendant",
    };
    expect(windows.structural).toBe(false);
    expect(describeContainment(windows)).toContain("melhor esforço");
    expect(windows.reason).toContain("not a Job Object");
  });

  it("reads the cgroup v2 path from the unified hierarchy only", () => {
    expect(currentCgroupPath("12:pids:/user.slice\n0::/user.slice/session.scope\n")).toBe("/user.slice/session.scope");
    expect(currentCgroupPath("12:pids:/user.slice\n")).toBeUndefined();
  });

  it("reports non-structural containment through the settle outcome", async () => {
    // A forced non-structural mechanism must never report a verified teardown.
    const directory = await mkdtemp(resolve(tmpdir(), "rb-harness-nonstructural-"));
    const handle = spawnProcessTree(process.execPath, ["-e", "setTimeout(() => {}, 50)"], {
      cwd: directory,
      stdio: ["ignore", "ignore", "ignore"],
      containment: {
        kind: "process-group",
        structural: false,
        reason: "forced fixture fallback",
        wrap: (command, args) => ({ command, args }),
        members: () => undefined,
        killAll: () => false,
        destroy: () => undefined,
      },
    });
    const outcome = await handle.settle("fixture teardown");
    handle.dispose();
    expect(outcome.quiescent).toBe(true);
    expect(outcome.verified).toBe(false);
    expect(outcome.containment.structural).toBe(false);
  }, 30_000);
});

describe("CR-004 · ambiguity never becomes an accepted decision", () => {
  const pending = (questionId: string): InterviewAnswer => ({
    questionId,
    question: "Which retention window applies?",
    rawAnswer: "the usual one",
    disposition: "PENDING",
    answeredAt: new Date().toISOString(),
  });

  const envelope = (value: unknown) =>
    `RB_HARNESS_INTERVIEW_JSON_BEGIN\n${JSON.stringify(value)}\nRB_HARNESS_INTERVIEW_JSON_END`;

  const base = {
    contract: "rb-harness-interview/v1",
    status: "ready",
    summary: "Everything is resolved.",
    discoveries: [],
    assumptions: [],
    unresolved: [],
    questions: [],
  };

  it("refuses to accept an answer the provider never classified", () => {
    const analysis = parseInterviewAnalysis(
      envelope({ ...base, answerReviews: [] }),
      { pendingAnswers: [pending("retention")], round: 1 },
    );
    expect(analysis.answerReviews[0]?.disposition).not.toBe("ACCEPTED");
    expect(analysis.semanticDefects?.join(" ")).toContain("retention");
    expect(analysis.status).not.toBe("ready");
  });

  it("refuses to accept an unknown or misspelled disposition", () => {
    const analysis = parseInterviewAnalysis(
      envelope({ ...base, answerReviews: [{ questionId: "retention", disposition: "ACCEPTEDD" }] }),
      { pendingAnswers: [pending("retention")], round: 1 },
    );
    expect(analysis.answerReviews[0]?.disposition).not.toBe("ACCEPTED");
    expect(analysis.semanticDefects?.length).toBeGreaterThan(0);
  });

  it("accepts an explicit, single, normalized decision", () => {
    const analysis = parseInterviewAnalysis(
      envelope({
        ...base,
        answerReviews: [{ questionId: "retention", disposition: "ACCEPTED", normalizedDecision: "Retain for 30 days." }],
      }),
      { pendingAnswers: [pending("retention")], round: 1 },
    );
    expect(analysis.answerReviews[0]).toMatchObject({
      disposition: "ACCEPTED",
      normalizedDecision: "Retain for 30 days.",
    });
    expect(analysis.semanticDefects ?? []).toEqual([]);
    expect(analysis.status).toBe("ready");
  });

  it("falls back to the raw answer only under an explicit ACCEPTED", () => {
    const accepted = parseInterviewAnalysis(
      envelope({ ...base, answerReviews: [{ questionId: "retention", disposition: "ACCEPTED" }] }),
      { pendingAnswers: [pending("retention")], round: 1 },
    );
    expect(accepted.answerReviews[0]).toMatchObject({
      disposition: "ACCEPTED",
      normalizedDecision: "the usual one",
    });
  });

  it("records surplus questions as deferred pendings instead of dropping them", () => {
    const questions = Array.from({ length: 9 }, (_value, index) => ({
      id: `q-${index}`,
      question: `Decision ${index}?`,
      why: "It changes scope.",
      type: "text",
      options: [],
    }));
    const analysis = parseInterviewAnalysis(
      envelope({ ...base, status: "needs_input", answerReviews: [], questions }),
      { pendingAnswers: [], round: 1 },
    );
    expect(analysis.questions).toHaveLength(HARNESS_BUDGET.interview.firstRoundQuestions);
    // The four surplus questions must still be visible as open material items.
    expect(analysis.unresolved.join(" ")).toContain("Decision 8?");
    expect(analysis.overflowQuestions).toBe(4);
  });

  it("cannot report ready while material overflow is hidden", () => {
    const questions = Array.from({ length: 8 }, (_value, index) => ({
      id: `q-${index}`,
      question: `Decision ${index}?`,
      why: "It changes scope.",
      type: "text",
      options: [],
    }));
    // Mid-interview the surplus is carried into the next round, never closed over.
    const carried = parseInterviewAnalysis(
      envelope({ ...base, status: "ready", answerReviews: [], questions }),
      { pendingAnswers: [], round: 2 },
    );
    expect(carried.status).toBe("needs_input");
    expect(carried.unresolved.join(" ")).toContain("Carried material decision");
    // At the ceiling it can no longer be carried, so readiness is refused.
    const exhausted = parseInterviewAnalysis(
      envelope({ ...base, status: "ready", answerReviews: [], questions }),
      { pendingAnswers: [], round: HARNESS_BUDGET.interview.maxRounds },
    );
    expect(exhausted.status).toBe("blocked");
    expect(exhausted.unresolved.length).toBeGreaterThan(0);
  });

  it("keeps asking while a material gap remains and blocks only at the ceiling", () => {
    const unresolvedAnswer = {
      ...base,
      status: "needs_input",
      answerReviews: [{ questionId: "retention", disposition: "AMBIGUOUS", remainingUncertainty: "30 or 90 days" }],
      questions: [],
    };
    // An ambiguous answer earns another focused round instead of ending the run.
    const midway = parseInterviewAnalysis(
      envelope(unresolvedAnswer),
      { pendingAnswers: [pending("retention")], round: 2 },
    );
    expect(midway.status).toBe("needs_input");
    expect(midway.questions).toHaveLength(1);
    expect(midway.questions[0]?.answerFor).toBe("retention");
    // Only the declared safety ceiling converts the open decision into BLOCKED.
    const ceiling = parseInterviewAnalysis(
      envelope(unresolvedAnswer),
      { pendingAnswers: [pending("retention")], round: HARNESS_BUDGET.interview.maxRounds },
    );
    expect(ceiling.status).toBe("blocked");
    expect(ceiling.unresolved.join(" ")).toContain("30 or 90 days");
  });

  it("still asks a round that exactly consumes the remaining question budget", () => {
    const questions = Array.from({ length: 3 }, (_value, index) => ({
      id: `tail-${index}`,
      question: `Tail decision ${index}?`,
      why: "It changes scope.",
      type: "text",
      options: [],
    }));
    const analysis = parseInterviewAnalysis(
      envelope({ ...base, status: "needs_input", answerReviews: [], questions }),
      { pendingAnswers: [], round: 3, askedQuestions: HARNESS_BUDGET.interview.maxQuestions - 3 },
    );
    expect(analysis.status).toBe("needs_input");
    expect(analysis.questions).toHaveLength(3);
  });

  it("stops the run-wide question budget from being exceeded", () => {
    const questions = Array.from({ length: 3 }, (_value, index) => ({
      id: `late-${index}`,
      question: `Late decision ${index}?`,
      why: "It changes scope.",
      type: "text",
      options: [],
    }));
    const analysis = parseInterviewAnalysis(
      envelope({ ...base, status: "needs_input", answerReviews: [], questions }),
      { pendingAnswers: [], round: 3, askedQuestions: HARNESS_BUDGET.interview.maxQuestions },
    );
    expect(analysis.questions).toHaveLength(0);
    expect(analysis.status).toBe("blocked");
  });

  it("never re-asks a decision the developer already answered", () => {
    const analysis = parseInterviewAnalysis(
      envelope({
        ...base,
        status: "needs_input",
        answerReviews: [],
        questions: [
          { id: "again", question: "How long is retention?", why: "It changes scope.", type: "text", options: [] },
          { id: "fresh", question: "Which audit events are recorded?", why: "It changes scope.", type: "text", options: [] },
        ],
      }),
      { pendingAnswers: [], round: 3, answeredQuestions: ["How long is retention?"] },
    );
    expect(analysis.questions.map((question) => question.id)).toEqual(["fresh"]);
    expect(analysis.normalizations?.join(" ")).toContain("already-answered");
  });
});

describe("CR-005 · the provider cannot reach Harness control state", () => {
  async function project(): Promise<string> {
    const root = await mkdtemp(resolve(tmpdir(), "rb-harness-isolation-"));
    await mkdir(resolve(root, ".rb-harness/runs/live"), { recursive: true });
    await mkdir(resolve(root, ".rb/runs/attempt-1"), { recursive: true });
    await mkdir(resolve(root, ".git/objects"), { recursive: true });
    await mkdir(resolve(root, "src"), { recursive: true });
    await writeFile(resolve(root, ".rb-harness/runs/live/state.json"), '{"secret":"run state"}\n', "utf8");
    await writeFile(resolve(root, ".rb/runs/attempt-1/events.tsv"), "control plane\n", "utf8");
    await writeFile(resolve(root, ".git/objects/pack.idx"), "git internals\n", "utf8");
    await writeFile(resolve(root, "src/app.ts"), "export const app = 1;\n", "utf8");
    await writeFile(resolve(root, ".env"), "TOKEN=must-not-leak\n", "utf8");
    return root;
  }

  function context(root: string) {
    return {
      projectRoot: root,
      role: "harness-generation" as const,
      permissionMode: "protected" as const,
      governor: createToolGovernor(),
    };
  }

  it("never lists Harness or Git control state", async () => {
    const root = await project();
    const listing = await executeApiAgentTool(context(root), "list_files", { path: "." });
    expect(listing).toContain("src/app.ts");
    expect(listing).not.toContain(".rb-harness");
    expect(listing).not.toContain(".rb/runs");
    expect(listing).not.toContain(".git/");
    expect(listing).not.toContain(".env");
  });

  it("denies a direct read of Harness run state", async () => {
    const root = await project();
    await expect(executeApiAgentTool(context(root), "read_file", { path: ".rb-harness/runs/live/state.json" }))
      .rejects.toThrow(/orchestrator|control|not allowed/i);
    await expect(executeApiAgentTool(context(root), "read_file", { path: ".rb/runs/attempt-1/events.tsv" }))
      .rejects.toThrow(/orchestrator|control|not allowed/i);
    await expect(executeApiAgentTool(context(root), "read_file", { path: ".git/objects/pack.idx" }))
      .rejects.toThrow(/orchestrator|control|not allowed/i);
  });

  it("denies a direct listing of a forbidden directory", async () => {
    const root = await project();
    await expect(executeApiAgentTool(context(root), "list_files", { path: ".rb-harness" }))
      .rejects.toThrow(/orchestrator|control|not allowed/i);
  });

  it("never returns forbidden content through a text search", async () => {
    const root = await project();
    const matches = await executeApiAgentTool(context(root), "search_text", { query: "control plane" });
    expect(matches).toContain("[no literal matches]");
    const stateMatches = await executeApiAgentTool(context(root), "search_text", { query: "run state" });
    expect(stateMatches).toContain("[no literal matches]");
  });

  it("denies traversal and symlink escapes", async () => {
    const root = await project();
    const outside = await mkdtemp(resolve(tmpdir(), "rb-harness-outside-"));
    await writeFile(resolve(outside, "secret.txt"), "outside\n", "utf8");
    const { symlink } = await import("node:fs/promises");
    await symlink(outside, resolve(root, "escape"));
    await expect(executeApiAgentTool(context(root), "read_file", { path: "../escape/secret.txt" }))
      .rejects.toThrow(/project-relative|outside|escapes/i);
    await expect(executeApiAgentTool(context(root), "read_file", { path: "escape/secret.txt" }))
      .rejects.toThrow(/outside|escapes/i);
  });

  it("keeps legitimate project evidence reachable", async () => {
    const root = await project();
    await expect(executeApiAgentTool(context(root), "read_file", { path: "src/app.ts" }))
      .resolves.toContain("export const app");
  });

  it("builds the projection outside the run directory, with no run state above it", async () => {
    const root = await project();
    const projection = await prepareEvidenceProjection({ projectRoot: root, artifactDirectory: ".rb" });
    try {
      // The old location put ../state.json one directory from the provider.
      expect(projection.root).not.toContain(".rb-harness");
      expect(projection.root.startsWith(realpathSync(tmpdir()))).toBe(true);
      const parent = resolve(projection.root, "..");
      const siblings = await readdir(parent);
      expect(siblings).not.toContain("state.json");
      expect(siblings.some((entry) => entry === "runs" || entry === "bundle.json")).toBe(false);
      // The control plane is absent from the projection itself.
      const entries = await readdir(projection.root);
      expect(entries).toContain("src");
      expect(entries).not.toContain(".rb-harness");
      expect(entries).not.toContain(".git");
      expect(entries).not.toContain(".env");
    } finally {
      await discardEvidenceProjection(projection.root);
    }
  }, 30_000);

  it("seals the projection read-only", async () => {
    const root = await project();
    const projection = await prepareEvidenceProjection({ projectRoot: root, artifactDirectory: ".rb" });
    try {
      const file = resolve(projection.root, "src/app.ts");
      expect((await stat(file)).mode & 0o222).toBe(0);
      expect((await stat(resolve(projection.root, "src"))).mode & 0o222).toBe(0);
      await expect(writeFile(file, "tampered\n", "utf8")).rejects.toThrow();
      await expect(writeFile(resolve(projection.root, "src/new.ts"), "x\n", "utf8")).rejects.toThrow();
      // Reading the evidence still works, which is the whole point.
      expect(await readFile(file, "utf8")).toContain("export const app");
    } finally {
      await discardEvidenceProjection(projection.root);
    }
  }, 30_000);

  it("declares that an external CLI is not read-confined instead of claiming isolation", () => {
    expect(confinesReads("deepseek")).toBe(true);
    for (const provider of ["codex", "claude", "opencode", "custom"] as const) {
      expect(confinesReads(provider)).toBe(false);
      const description = describeReadConfinement(provider);
      expect(description).toContain("sem confinamento de leitura");
      expect(description).toContain("não é sandbox de leitura");
    }
    // A read-only sandbox blocks writes, not reads; the note must say so.
    expect(providerCapabilities("codex").notes).toContain("leaves the filesystem readable");
    expect(providerCapabilities("claude").notes).toContain("leaves the filesystem readable");
  });

  it("never hands the real project's absolute path to a provider", () => {
    const invocation = providerInvocation(
      { provider: "codex", model: "m", effort: "" },
      "generation",
      "/tmp/rb-harness-evidence-abc/projection",
    );
    expect(invocation.environment.RB_HARNESS_PROJECT_ROOT).toBe("/tmp/rb-harness-evidence-abc/projection");
    expect(invocation.args.join(" ")).not.toContain("/home/");
  });

  it("gives a CLI provider a projection with no control state in it", async () => {
    const root = await project();
    await writeFile(resolve(root, "package.json"), '{"name":"isolation-fixture"}\n', "utf8");
    const answers = resolve(root, "answers.json");
    await writeFile(answers, "{}\n", "utf8");
    const snoopFile = resolve(root, "snoop.json");
    await chmod(snoopingProvider, 0o755);
    process.env.RB_HARNESS_TEST_SNOOP_FILE = snoopFile;
    try {
      // The interview alone is enough: the fixture reports what it could reach
      // from its working directory before the run continues.
      await runStandaloneWorkflow({
        workflow: "plan",
        projectRoot: root,
        artifactDirectory: ".rb",
        request: "Plan an isolated change.",
        provider: { provider: "custom", model: "fixture", effort: "", command: snoopingProvider },
        answersFile: answers,
        questionMode: "one-by-one",
        nonInteractive: true,
        timeoutSeconds: 30,
        firstOutputTimeoutSeconds: 5,
      }).catch(() => undefined);
      const snooped = JSON.parse(await readFile(snoopFile, "utf8")) as { reached: string[]; visible: string[] };
      expect(snooped.reached).toEqual([]);
      expect(snooped.visible).toContain("src");
      expect(snooped.visible).not.toContain(".rb-harness");
      expect(snooped.visible).not.toContain(".git");
      expect(snooped.visible).not.toContain(".env");
    } finally {
      delete process.env.RB_HARNESS_TEST_SNOOP_FILE;
    }
  }, 60_000);
});


describe("CR-006 · declared byte limits are enforced before a provider starts", () => {
  async function inputOptions(request: string) {
    const project = await mkdtemp(resolve(tmpdir(), "rb-harness-budget-"));
    await writeFile(resolve(project, "package.json"), '{"name":"budget-fixture"}\n', "utf8");
    return {
      workflow: "plan" as const,
      projectRoot: project,
      artifactDirectory: ".rb",
      request,
      inventory: await inspectProjectInventory(project, ".rb"),
    };
  }

  it("accepts a request exactly at the limit and rejects one byte more", async () => {
    const limit = HARNESS_BUDGET.prompt.maxRequestBytes;
    await expect(buildInputPackage(await inputOptions("r".repeat(limit)))).resolves.toBeDefined();
    await expect(buildInputPackage(await inputOptions("r".repeat(limit + 1))))
      .rejects.toThrow(/above its .* budget[\s\S]*never truncated/);
  });

  it("names the observed size, the limit, and a safe way forward", async () => {
    await expect(buildInputPackage(await inputOptions("r".repeat(HARNESS_BUDGET.prompt.maxRequestBytes + 1))))
      .rejects.toThrow(/split it into smaller requests/);
    // The diagnostic must not echo the oversized content back at the operator.
    await expect(buildInputPackage(await inputOptions("r".repeat(HARNESS_BUDGET.prompt.maxRequestBytes + 1))))
      .rejects.not.toThrow(/rrrrrrrrrr/);
  });

  it("refuses to drop an accepted decision to fit the budget", async () => {
    const base = await inputOptions("Plan a change.");
    const answers: InterviewAnswer[] = Array.from({ length: 3 }, (_value, index) => ({
      questionId: `decision-${index}`,
      question: "Which boundary applies?",
      rawAnswer: "x",
      normalizedDecision: "d".repeat(40 * 1024),
      disposition: "ACCEPTED" as const,
      answeredAt: new Date().toISOString(),
    }));
    await expect(buildInputPackage({ ...base, answers }))
      .rejects.toThrow(/decision budget[\s\S]*never dropped/);
  });

  it("rejects an over-budget prompt instead of truncating it", () => {
    expect(() => assertPromptWithinBudget("x".repeat(10), 10, "interview")).not.toThrow();
    expect(() => assertPromptWithinBudget("x".repeat(11), 10, "interview"))
      .toThrow(/the interview prompt is 11 bytes, above its 10 bytes budget/);
  });

  it("bounds an oversized existing-artifact summary without failing the run", async () => {
    const base = await inputOptions("Plan a change.");
    const highlights = Array.from({ length: 200 }, (_value, index) => ({
      id: `artifact-${index}`,
      kind: "feature-document",
      status: "ready",
      path: `.rb/features/f-${index}/SPEC.md`,
      summary: "s".repeat(4 * 1024),
    }));
    const built = await buildInputPackage({
      ...base,
      inventory: { ...base.inventory, artifactHighlights: highlights },
    });
    expect(built.artifacts.highlights.length).toBeLessThan(highlights.length);
    expect(built.artifacts.omittedHighlights).toBeGreaterThan(0);
    expect(Buffer.byteLength(serializeInputPackage(built)))
      .toBeLessThanOrEqual(HARNESS_BUDGET.inventory.maxPackageBytes);
  });

  it("never starts a provider when the size preflight fails", async () => {
    const project = await mkdtemp(resolve(tmpdir(), "rb-harness-preflight-"));
    await writeFile(resolve(project, "package.json"), '{"name":"preflight-fixture"}\n', "utf8");
    const answers = resolve(project, "answers.json");
    await writeFile(answers, "{}\n", "utf8");
    const modes = resolve(project, "provider-modes.log");
    await chmod(fakeProvider, 0o755);
    process.env.RB_HARNESS_TEST_PROVIDER_MODE_FILE = modes;
    try {
      await expect(runStandaloneWorkflow({
        workflow: "plan",
        projectRoot: project,
        artifactDirectory: ".rb",
        request: "r".repeat(HARNESS_BUDGET.prompt.maxRequestBytes + 1),
        provider: { provider: "custom", model: "fixture", effort: "", command: fakeProvider },
        answersFile: answers,
        questionMode: "one-by-one",
        nonInteractive: true,
        timeoutSeconds: 30,
        firstOutputTimeoutSeconds: 5,
      })).rejects.toThrow(/above its .* budget/);
      await expect(readFile(modes, "utf8")).rejects.toThrow();
    } finally {
      delete process.env.RB_HARNESS_TEST_PROVIDER_MODE_FILE;
    }
  }, 60_000);
});

describe("CR-007 · the invariant prompt prefix is real", () => {
  async function fixture() {
    const project = await mkdtemp(resolve(tmpdir(), "rb-harness-prefix-"));
    await writeFile(resolve(project, "package.json"), '{"name":"prefix-fixture"}\n', "utf8");
    const inventory = await inspectProjectInventory(project, ".rb");
    const inputPackage = await buildInputPackage({
      workflow: "plan",
      projectRoot: project,
      artifactDirectory: ".rb",
      request: "Plan a bounded change.",
      inventory,
    });
    const resources = await loadWorkflowResources("plan", { section: "interview" });
    const state = { workflow: "plan", request: "Plan a bounded change.", answers: [] } as unknown as HarnessRunState;
    return { state, inputPackage, resources };
  }

  it("keeps the declared prefix byte-identical across rounds and answers", async () => {
    const { state, inputPackage, resources } = await fixture();
    const prefix = stableInterviewPrefix(state, inputPackage, resources);
    const firstRound = buildInterviewPrompt(state, inputPackage, resources, 1, []);
    const secondRound = buildInterviewPrompt(
      { ...state, analysis: { status: "needs_input", summary: "one open decision" } } as unknown as HarnessRunState,
      inputPackage,
      resources,
      2,
      [{
        questionId: "retention",
        question: "Which window?",
        rawAnswer: "30 days",
        disposition: "PENDING",
        answeredAt: new Date().toISOString(),
      }],
    );
    expect(firstRound.startsWith(prefix)).toBe(true);
    expect(secondRound.startsWith(prefix)).toBe(true);
    // The volatile part really is different, so the assertion is meaningful.
    expect(firstRound).not.toBe(secondRound);
    expect(firstRound.slice(prefix.length)).not.toBe(secondRound.slice(prefix.length));
  });

  it("keeps round budget and checkpoint state out of the prefix", async () => {
    const { state, inputPackage, resources } = await fixture();
    const prefix = stableInterviewPrefix(state, inputPackage, resources);
    expect(prefix).not.toContain("ROUND STATE");
    expect(prefix).not.toContain("Answers requiring classification");
    expect(prefix).toContain("rb-harness-contract-digest/v1");
  });

  it("keeps the generation prefix stable across a protocol retry", async () => {
    const { state, inputPackage } = await fixture();
    const resources = await loadWorkflowResources("plan", { section: "generation" });
    const prefix = stableGenerationPrefix(state, inputPackage, resources);
    expect(buildGenerationPrompt(state, inputPackage, resources).startsWith(prefix)).toBe(true);
    expect(buildGenerationPrompt(state, inputPackage, resources, "malformed JSON").startsWith(prefix)).toBe(true);
  });

  it("never converts a missing usage metric into a cache hit", () => {
    const usage = emptyUsage();
    expect(usage.measured).toBe(false);
    expect(usage.cachedInputTokens).toBe(0);
    const report = formatTelemetryReport({
      contract: "rb-harness-telemetry/v1",
      startedAt: new Date().toISOString(),
      durationMilliseconds: 10,
      stages: [],
      providerCalls: [],
      structuralRepairs: [],
      totals: { ...usage, providerCalls: 1 },
    });
    expect(report).toContain("não medidos");
    expect(report).not.toContain("em cache=0");
  });
});


describe("CR-003 · CLI adapters are governed, never assumed equivalent", () => {
  const structuredProvider = resolve(fixtures, "structured-provider.mjs");
  const openCodeProvider = resolve(fixtures, "opencode-provider.mjs");

  async function runStructured(eventMode: string, overrides: Record<string, unknown> = {}) {
    const directory = await mkdtemp(resolve(tmpdir(), "rb-harness-stream-"));
    await chmod(structuredProvider, 0o755);
    process.env.RB_HARNESS_TEST_EVENT_MODE = eventMode;
    try {
      return await runProvider({
        configuration: { provider: "custom", model: "fixture", effort: "", command: structuredProvider },
        mode: "generation",
        stage: "generation",
        streamMode: "structured",
        projectRoot: directory,
        prompt: "fixture prompt",
        logPath: resolve(directory, "provider.log"),
        timeoutSeconds: 20,
        firstOutputTimeoutSeconds: 5,
        ...overrides,
      });
    } finally {
      delete process.env.RB_HARNESS_TEST_EVENT_MODE;
    }
  }

  async function runOpenCode(eventMode: string) {
    const directory = await mkdtemp(resolve(tmpdir(), "rb-harness-opencode-"));
    await chmod(openCodeProvider, 0o755);
    process.env.RB_HARNESS_TEST_EVENT_MODE = eventMode;
    try {
      return await runProvider({
        configuration: { provider: "custom", model: "fixture", effort: "", command: openCodeProvider },
        mode: "generation",
        stage: "generation",
        streamMode: "structured",
        streamDialect: "opencode",
        projectRoot: directory,
        prompt: "fixture prompt",
        logPath: resolve(directory, "provider.log"),
        timeoutSeconds: 20,
        firstOutputTimeoutSeconds: 5,
      });
    } finally {
      delete process.env.RB_HARNESS_TEST_EVENT_MODE;
    }
  }

  it("declares what each installed adapter can and cannot be held to", () => {
    expect(isControlledAdapter("opencode")).toBe(true);
    expect(providerCapabilities("opencode").structuredEvents.mechanism).toBe("opencode run --format json");
    // Advertised is not verified: codex and claude document an event stream the
    // Harness does not consume, so no control is claimed for them.
    expect(providerCapabilities("codex").structuredEvents.advertised).toBe(true);
    expect(isControlledAdapter("codex")).toBe(false);
    expect(isControlledAdapter("claude")).toBe(false);
    expect(isControlledAdapter("deepseek")).toBe(true);
    expect(isControlledAdapter("custom")).toBe(false);
    expect(describeAdapterControl("codex")).toContain("não medido");
    expect(describeAdapterControl("opencode")).toContain("orçamento documental aplicado");
  });

  it("keeps every documented provider selectable and read-only", () => {
    for (const provider of ["codex", "claude", "opencode"] as const) {
      const invocation = providerInvocation({ provider, model: "m", effort: "" }, "generation", "/tmp/project");
      expect(invocation.command).toBeTruthy();
      expect(invocation.args.join(" ")).not.toContain("workspace-write");
    }
    const opencode = providerInvocation(
      { provider: "opencode", model: "opencode-go/deepseek-v4-pro", effort: "high" },
      "generation",
      "/tmp/project",
    );
    expect(opencode.args).toEqual(expect.arrayContaining(["--format", "json", "--model", "opencode-go/deepseek-v4-pro"]));
  });

  it("recovers the final envelope from a normal structured stream", async () => {
    const result = await runStructured("normal");
    expect(result.stream.mode).toBe("structured");
    expect(result.stream.events).toBeGreaterThan(0);
    expect(result.stream.toolEvents).toBe(2);
    expect(result.stream.degraded).toBe(false);
    expect(result.stdout).toContain("RB_HARNESS_DOCUMENTS_JSON_END");
    expect(parseDocumentBundle(result.stdout).documents[0]?.path).toBe(".rb/context/ARCHITECTURE.md");
  });

  it("stops a run that floods the documentation tool budget", async () => {
    await expect(runStructured("tool-flood")).rejects.toThrow(/tool budget of \d+ tool events/);
  }, 30_000);

  it("fails explicitly on a malformed structured event", async () => {
    await expect(runStructured("malformed")).rejects.toThrow(/malformed structured event/);
  }, 30_000);

  it("does not let repeated output renew the progress window forever", () => {
    const observer = new ProviderStreamObserver({ mode: "opaque", noProgressMilliseconds: 40 });
    observer.push("thinking about the same thing\n");
    const start = Date.now();
    while (Date.now() - start < 60) {
      // Identical content is activity, not progress.
      observer.push("thinking about the same thing\n");
    }
    expect(observer.stalled()).toBe(true);
    observer.push("a genuinely new line\n");
    expect(observer.stalled()).toBe(false);
  });

  it("labels an opaque adapter as unmeasured instead of claiming control", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "rb-harness-opaque-"));
    await chmod(fakeProvider, 0o755);
    const result = await runProvider({
      configuration: { provider: "custom", model: "fixture", effort: "", command: fakeProvider },
      mode: "interview",
      stage: "gap-analysis",
      projectRoot: directory,
      prompt: "fixture prompt",
      logPath: resolve(directory, "provider.log"),
      timeoutSeconds: 20,
      firstOutputTimeoutSeconds: 5,
    });
    expect(result.stream.mode).toBe("opaque");
    expect(result.stream.toolEvents).toBe(0);
    expect(result.usage.measured).toBe(false);
    expect(await readFile(resolve(directory, "provider.log"), "utf8")).toContain("stream_mode=opaque");
  }, 30_000);

  it("counts one OpenCode tool invocation once, not once per state change", async () => {
    const result = await runOpenCode("normal");
    // The fixture re-emits one tool part as pending → running → completed.
    expect(result.stream.events).toBeGreaterThan(5);
    expect(result.stream.toolEvents).toBe(1);
    expect(result.stream.turnEvents).toBe(1);
    expect(result.stream.degraded).toBe(false);
    expect(parseDocumentBundle(result.stdout).documents[0]?.path).toBe(".rb/context/ARCHITECTURE.md");
  }, 30_000);

  it("applies the tool budget to distinct OpenCode call IDs", async () => {
    await expect(runOpenCode("tool-flood")).rejects.toThrow(/tool budget of \d+ tool events/);
  }, 30_000);

  it("fails on a structured stream truncated at EOF without a newline", async () => {
    await expect(runOpenCode("truncated-eof")).rejects.toThrow(/malformed structured event/);
  }, 30_000);

  it("returns the trailing breach from end() rather than swallowing it", () => {
    const observer = new ProviderStreamObserver({ mode: "structured", dialect: "opencode" });
    // No newline: the event is only ever seen by end().
    observer.push('{"type":"message.part.updated","properties":{"part":{"type":"text"');
    const breach = observer.end();
    expect(breach?.code).toBe("malformed-event");
    expect(breach?.message).toContain("malformed structured event");
  });

  it("selects the OpenCode dialect for the opencode adapter", () => {
    expect(providerCapabilities("opencode").inspectedVersion).toBe("1.18.21");
    const observer = new ProviderStreamObserver({ mode: "structured", dialect: "opencode" });
    // A generic reader would call every `tool`-shaped key a call; the OpenCode
    // reader groups by the provider's own callID.
    for (const status of ["pending", "running", "completed"]) {
      observer.push(`${JSON.stringify({
        type: "message.part.updated",
        properties: { part: { type: "tool", callID: "call_a", tool: "read", state: { status } } },
      })}\n`);
    }
    expect(observer.report().toolEvents).toBe(1);
  });

  it("declares a structured stream that carried no parsable event as degraded", () => {
    const observer = new ProviderStreamObserver({ mode: "structured" });
    observer.push("opencode banner line\n");
    observer.push("another prose line\n");
    const report = observer.report();
    expect(report.degraded).toBe(true);
    expect(report.events).toBe(0);
    expect(observer.recoveredText()).toContain("opencode banner line");
  });
});
