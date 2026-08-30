import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HARNESS_BUDGET } from "../src/harness-budget.js";
import { parseInterviewAnalysis, recoverInterviewAnalysis } from "../src/harness-interview.js";
import { providerInvocation, providerOutputLimit, runProvider } from "../src/harness-provider.js";
import { inspectProjectInventory } from "../src/harness-inventory.js";
import { composeHarnessSplash, harnessBrand, renderHarnessSplashFrame } from "../src/harness-splash.js";
import { harnessMascotPlainRows, renderHarnessMascot } from "../src/harness-mascot.js";
import { terminalVisibleWidth } from "../src/harness-dashboard.js";
import { loadWorkflowResources, requestNeedsHeadlessContracts, resolveWorkflowResourceRoot } from "../src/standalone-resources.js";
import {
  hasReadyInterviewCheckpoint,
  nextInterviewRound,
  normalizeInterviewAnswer,
  resumeStandaloneWorkflow,
  runStandaloneWorkflow,
} from "../src/standalone-runner.js";
import {
  assertNoEnvironmentSecrets,
  prepareStagingTree,
  publishStagedArtifacts,
  recoverInterruptedPublication,
  rollbackPublishedArtifacts,
  validateStagedTree,
} from "../src/harness-workspace.js";
import { materializeDocuments, parseDocumentBundle } from "../src/harness-documents.js";
import { validateManifestTree } from "../src/manifest.js";
import { writeRunState } from "../src/harness-state.js";
import { isExecutable } from "./support/process-liveness.js";

const fixtures = resolve(process.cwd(), "test/fixtures/standalone");
const fakeProvider = resolve(fixtures, "fake-provider.mjs");
const failingProvider = resolve(fixtures, "failing-provider.mjs");
const noisyProvider = resolve(fixtures, "noisy-provider.mjs");
const repairingProvider = resolve(fixtures, "repairing-provider.mjs");
const truncatedProvider = resolve(fixtures, "truncated-provider.mjs");
const silentProvider = resolve(fixtures, "silent-provider.mjs");

function baseOptions(project: string, answers: string, command = fakeProvider) {
  return {
    workflow: "plan" as const,
    projectRoot: project,
    artifactDirectory: ".rb",
    request: "Plan an isolated version command.",
    provider: { provider: "custom" as const, model: "fixture-model", effort: "high", command },
    answersFile: answers,
    questionMode: "one-by-one" as const,
    nonInteractive: true,
    timeoutSeconds: 30,
    firstOutputTimeoutSeconds: 5,
  };
}

async function fixtureProject(prefix: string): Promise<{ project: string; answers: string }> {
  const project = await mkdtemp(resolve(tmpdir(), prefix));
  await writeFile(resolve(project, "package.json"), '{"name":"fixture"}\n', "utf8");
  const answers = resolve(project, "answers.json");
  await writeFile(answers, '{"scope-boundary":"Yes"}\n', "utf8");
  await chmod(fakeProvider, 0o755);
  return { project, answers };
}

describe("standalone RB Harness", () => {
  it("continues an interrupted interview at the correct bounded round", () => {
    expect(nextInterviewRound({})).toBe(1);
    expect(nextInterviewRound({ interviewRound: 1 })).toBe(2);
    expect(nextInterviewRound({ interviewRound: 1, activeInterviewRound: 2 })).toBe(2);
  });

  it("reuses only a fully resolved ready interview checkpoint on resume", () => {
    const ready = {
      analysis: {
        contract: "rb-harness-interview/v1" as const,
        status: "ready" as const,
        summary: "All material decisions are resolved.",
        discoveries: [], assumptions: [], unresolved: [], answerReviews: [], questions: [],
      },
      answers: [{
        questionId: "scope", question: "Scope?", rawAnswer: "Confirmed", normalizedDecision: "Confirmed",
        disposition: "ACCEPTED" as const, answeredAt: new Date().toISOString(),
      }],
    };
    expect(hasReadyInterviewCheckpoint(ready)).toBe(true);
    expect(hasReadyInterviewCheckpoint({ ...ready, answers: [{ ...ready.answers[0]!, disposition: "PENDING" as const }] })).toBe(false);
    expect(hasReadyInterviewCheckpoint({ ...ready, analysis: { ...ready.analysis, status: "needs_input" as const } })).toBe(false);
  });

  it("normalizes recommendation shortcuts and numbered choices before persistence", () => {
    const textQuestion = {
      id: "limits", question: "Limits?", why: "Capacity", type: "text" as const, options: [], recommendation: "10 tokens; 1 MiB",
    };
    expect(normalizeInterviewAnswer(textQuestion, "use a recomendação")).toBe("10 tokens; 1 MiB");
    expect(normalizeInterviewAnswer(textQuestion, "usar a recomendação")).toBe("10 tokens; 1 MiB");
    expect(normalizeInterviewAnswer({ ...textQuestion, type: "single-choice", options: ["A", "B"] }, "2")).toBe("B");
  });

  it("follows an installed bin symlink to the packaged workflow resources", async () => {
    const installation = await mkdtemp(resolve(tmpdir(), "rb-harness-linked-install-"));
    const packagedCli = resolve(installation, "lib/node_modules/@rb-harness/core/dist/cli.js");
    const packagedResources = resolve(installation, "lib/node_modules/@rb-harness/core/dist/resources");
    const launcher = resolve(installation, "bin/rb-harness");
    await mkdir(resolve(packagedResources, "references"), { recursive: true });
    await mkdir(resolve(installation, "bin"), { recursive: true });
    await writeFile(packagedCli, "#!/usr/bin/env node\n", "utf8");
    await writeFile(resolve(packagedResources, "references/interview-policy.md"), "fixture\n", "utf8");
    await symlink(packagedCli, launcher);

    expect(await resolveWorkflowResourceRoot({
      launcherPath: launcher,
      workingDirectory: resolve(installation, "unrelated-project"),
      configuredRoot: "",
    })).toBe(packagedResources);
  });

  it("injects both public headless authorities for RB Harness integration requests", async () => {
    expect(requestNeedsHeadlessContracts("Integrate the hosted service with RB Harness.")).toBe(true);
    expect(requestNeedsHeadlessContracts("Plan an unrelated local command.")).toBe(false);
    const resources = await loadWorkflowResources("evolve", { includeHeadlessContracts: true });
    expect(resources).toContain("contracts/rb-headless-init-v1.md");
    expect(resources).toContain("rb-headless-init/v1");
    expect(resources).toContain("contracts/rb-headless-interview-v1.md");
    expect(resources).toContain("rb-headless-interview/v1");
  });

  it("loads only the section each documentation stage needs", async () => {
    const interview = await loadWorkflowResources("plan", { section: "interview" });
    const generation = await loadWorkflowResources("plan", { section: "generation" });
    expect(interview).toContain("RESOURCE: workflows/plan/instructions.md");
    expect(interview).not.toContain("RESOURCE: workflows/plan/artifact-shapes.md");
    expect(generation).not.toContain("RESOURCE: workflows/plan/artifact-authority (code-owned)");
    // The mechanical formats moved into the code-owned contract digest.
    expect(generation).not.toContain("RESOURCE: references/execution-template.md");
    expect(generation).not.toContain("RESOURCE: references/interview-policy.md");
    expect(await loadWorkflowResources("plan", { section: "repair" })).toBe("");
    expect(Buffer.byteLength(generation)).toBeLessThan(Buffer.byteLength(await readFile(
      resolve(process.cwd(), "../../resources/references/execution-template.md"),
    )) * 4);
  });

  it("preserves the versioned RB wordmark and capybara mascot", () => {
    const brand = harnessBrand("0.2.3");
    expect(brand).toContain("█▀█ █▄▄");
    for (const row of harnessMascotPlainRows("compact")) expect(brand).toContain(row);
    expect(brand).toContain("capivara das especificações · v0.2.3");
  });

  it("centers a responsive Ralph-quality splash in both terminal dimensions", () => {
    const columns = 120;
    const rows = 30;
    const lines = composeHarnessSplash("0.2.3", columns, rows);
    expect(lines[0]).toContain("██████╗");
    expect(lines.every((line) => [...line].length <= columns)).toBe(true);
    expect(lines.filter(Boolean).every((line) => line.startsWith(" "))).toBe(true);
    const frame = renderHarnessSplashFrame(lines, 0, true, rows, columns);
    const body = frame.slice("\u001b[H\u001b[2J".length);
    expect(body.match(/^\n*/)?.[0].length).toBe(Math.floor((rows - lines.length) / 2));

    const compact = composeHarnessSplash("0.2.3", 50, 16);
    expect(compact[0]).toContain("█▀█ █▄▄");
    expect(compact.every((line) => [...line].length <= 50)).toBe(true);
  });

  it("paints the splash with the dashboard capybara instead of the gradient", () => {
    const columns = 120;
    const rows = 30;
    const painted = composeHarnessSplash("0.2.3", columns, rows, { color: true });
    // The splash carries the same mascot art the dashboard renders.
    for (const row of renderHarnessMascot("wide")) {
      expect(painted.some((line) => line.includes(row))).toBe(true);
    }
    expect(painted.every((line) => terminalVisibleWidth(line) <= columns)).toBe(true);

    const frame = renderHarnessSplashFrame(painted, 0.3, true, rows, columns);
    const mascotRow = renderHarnessMascot("wide")[6]!;
    const mascotLine = frame.split("\n").find((line) => line.includes(mascotRow))!;
    // The capybara keeps its own palette: the frame adds centering and a reset,
    // never a gradient colour, so the row survives byte for byte.
    expect(mascotLine.replace(/^ +/, "")).toBe(`${mascotRow}\u001b[0m`);
    expect(mascotLine).toContain("\u001b[38;2;0;194;222m");

    // Unpainted art still animates through the gradient.
    const wordmarkLine = frame.split("\n").find((line) => line.includes("██████╗"))!;
    expect(wordmarkLine).toContain("\u001b[38;2;");
    expect(composeHarnessSplash("0.2.3", columns, rows).some((line) => line.includes("\u001b["))).toBe(false);

    const compact = composeHarnessSplash("0.2.3", 50, 16, { color: true });
    for (const row of renderHarnessMascot("compact")) {
      expect(compact.some((line) => line.includes(row))).toBe(true);
    }
    expect(compact.every((line) => terminalVisibleWidth(line) <= 50)).toBe(true);
  });

  it("keeps every documentation provider role read-only", () => {
    const codex = providerInvocation({ provider: "codex", model: "gpt-5.6-sol", effort: "xhigh" }, "interview", "/tmp/project");
    expect(codex.args).toContain("gpt-5.6-sol");
    expect(codex.args).toContain('model_reasoning_effort="xhigh"');
    expect(codex.args).toContain("read-only");
    const codexGeneration = providerInvocation({ provider: "codex", model: "m", effort: "" }, "generation", "/tmp/project");
    expect(codexGeneration.args).toContain("read-only");
    expect(codexGeneration.args).not.toContain("workspace-write");
    const claude = providerInvocation({ provider: "claude", model: "opus", effort: "high" }, "generation", "/tmp/project");
    expect(claude.args).toEqual(expect.arrayContaining(["--model", "opus", "--effort", "high", "plan"]));
    expect(claude.args).not.toContain("acceptEdits");
    const opencode = providerInvocation({ provider: "opencode", model: "opencode/mimo", effort: "high" }, "generation", "/tmp/project");
    expect(opencode.args).toEqual(expect.arrayContaining(["--model", "opencode/mimo", "--variant", "high"]));
    expect(opencode.args).not.toContain("--auto");
    expect(opencode.environment.OPENCODE_PERMISSION).toContain('"edit":"deny"');
  });

  it("never hands orchestrator-private locations to a provider", () => {
    process.env.RB_HARNESS_RESOURCE_ROOT = "/opt/rb-harness/dist/resources";
    try {
      const invocation = providerInvocation({ provider: "codex", model: "m", effort: "" }, "generation", "/tmp/project");
      expect(invocation.environment.RB_HARNESS_RESOURCE_ROOT).toBeUndefined();
      expect(invocation.environment.RB_HARNESS_PROJECT_ROOT).toBe("/tmp/project");
    } finally {
      delete process.env.RB_HARNESS_RESOURCE_ROOT;
    }
  });

  it("normalizes superficial interview protocol deviations instead of failing", () => {
    const pending = [{
      questionId: "scope-boundary", question: "Scope?", rawAnswer: "Only the requested feature",
      disposition: "PENDING" as const, answeredAt: new Date().toISOString(),
    }];
    const envelope = (value: unknown) => `noise before\nRB_HARNESS_INTERVIEW_JSON_BEGIN\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\`\nRB_HARNESS_INTERVIEW_JSON_END\ntrailing noise`;
    const analysis = parseInterviewAnalysis(envelope({
      contract: "rb-harness-interview/v1",
      status: "needs_input",
      summary: "One decision remains.",
      discoveries: [], assumptions: [], unresolved: ["Decision"],
      // Deliberately missing the classification of the pending answer.
      answerReviews: [],
      questions: [{ id: "!!", question: "Which retention window?", why: "It changes storage.", options: ["30 days", "90 days"] }],
    }), { pendingAnswers: pending, round: 1 });
    expect(analysis.status).toBe("needs_input");
    expect(analysis.questions[0]?.id).toBe("q1");
    expect(analysis.questions[0]?.type).toBe("single-choice");
    // An unclassified answer is a semantic defect, never an acceptance.
    expect(analysis.answerReviews[0]).toMatchObject({
      questionId: "scope-boundary",
      disposition: "AMBIGUOUS",
    });
    expect(analysis.semanticDefects?.join(" ")).toContain("never classified");
  });

  it("accepts a valid raw interview JSON object without decorative marker lines", () => {
    const raw = JSON.stringify({
      contract: "rb-harness-interview/v1", status: "ready", summary: "ready",
      discoveries: [], assumptions: [], unresolved: [], answerReviews: [], questions: [],
    });
    expect(parseInterviewAnalysis(raw, []).status).toBe("ready");
  });

  it("truncates a round to its question budget and blocks after the final round", () => {
    const question = (index: number) => ({
      id: `q-${index}`, question: `Decision ${index}?`, why: "It changes scope.", type: "text", options: [],
    });
    const source = (round: number, count: number) => parseInterviewAnalysis(
      `RB_HARNESS_INTERVIEW_JSON_BEGIN\n${JSON.stringify({
        contract: "rb-harness-interview/v1",
        status: "needs_input",
        summary: "Decisions remain.",
        discoveries: [], assumptions: [], unresolved: ["Retention"], answerReviews: [],
        questions: Array.from({ length: count }, (_value, index) => question(index)),
      })}\nRB_HARNESS_INTERVIEW_JSON_END`,
      { pendingAnswers: [], round },
    );
    expect(source(1, 9).questions).toHaveLength(5);
    // A follow-up round truncates to its own budget and carries the surplus.
    expect(source(2, 9).status).toBe("needs_input");
    expect(source(2, 9).questions).toHaveLength(3);
    // The declared ceiling — not an early round — ends the interview.
    const ceiling = source(HARNESS_BUDGET.interview.maxRounds, 9);
    expect(ceiling.status).toBe("blocked");
    expect(ceiling.questions).toHaveLength(0);
    expect(ceiling.unresolved.length).toBeGreaterThan(0);
  });

  it("derives one focused follow-up from a declared unresolved answer", () => {
    const pending = [{
      questionId: "retention", question: "Retention?", rawAnswer: "The usual",
      disposition: "PENDING" as const, answeredAt: new Date().toISOString(),
    }];
    const analysis = parseInterviewAnalysis(`RB_HARNESS_INTERVIEW_JSON_BEGIN\n${JSON.stringify({
      contract: "rb-harness-interview/v1",
      status: "needs_input",
      summary: "The retention answer is ambiguous.",
      discoveries: [], assumptions: [], unresolved: [],
      answerReviews: [{ questionId: "retention", disposition: "AMBIGUOUS", remainingUncertainty: "30 and 90 days both remain valid." }],
      questions: [],
    })}\nRB_HARNESS_INTERVIEW_JSON_END`, { pendingAnswers: pending, round: 1 });
    expect(analysis.questions).toHaveLength(1);
    expect(analysis.questions[0]?.answerFor).toBe("retention");
    expect(analysis.questions[0]?.question).toContain("30 and 90 days");
  });

  it("recovers a now-valid interview envelope from a successful provider log", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "rb-harness-interview-recovery-"));
    const log = resolve(directory, "interview.log");
    const envelope = `RB_HARNESS_INTERVIEW_JSON_BEGIN\n${JSON.stringify({
      contract: "rb-harness-interview/v1",
      status: "needs_input",
      summary: "One decision remains.",
      discoveries: [], assumptions: [], unresolved: ["Decision"], answerReviews: [],
      questions: [{ id: "q1", question: "Choose?", why: "It changes scope.", type: "confirm", options: [] }],
    })}\nRB_HARNESS_INTERVIEW_JSON_END`;
    await writeFile(log, `provider=custom\nexit_code=0\n\n--- stdout ---\n${envelope}\n--- stderr ---\nprovider trace\n`, "utf8");
    expect((await recoverInterviewAnalysis(log, { pendingAnswers: [], round: 1 }))?.questions[0]?.id).toBe("q1");
  });

  it("persists failed provider diagnostics without retaining inherited secret values", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "rb-harness-provider-failure-"));
    const log = resolve(directory, "provider.log");
    const secret = "rb-harness-sentinel-that-must-be-redacted";
    process.env.RB_HARNESS_TEST_API_KEY = secret;
    await chmod(failingProvider, 0o755);
    try {
      await expect(runProvider({
        configuration: { provider: "custom", model: "fixture", effort: "high", command: failingProvider },
        mode: "interview",
        stage: "gap-analysis",
        projectRoot: directory,
        prompt: "fixture prompt",
        logPath: log,
        timeoutSeconds: 10,
        firstOutputTimeoutSeconds: 5,
      })).rejects.toThrow("see");
      const evidence = await readFile(log, "utf8");
      expect(evidence).toContain("exit_code=9");
      expect(evidence).toContain("stage=gap-analysis");
      expect(evidence).toContain("[REDACTED:RB_HARNESS_TEST_API_KEY]");
      expect(evidence).not.toContain(secret);
    } finally {
      delete process.env.RB_HARNESS_TEST_API_KEY;
    }
  });

  it("bounds documentation transcripts and kills nested provider sessions on overflow", async () => {
    expect(providerOutputLimit("generation")).toBe(32 * 1024 * 1024);
    expect(providerOutputLimit("repair")).toBe(16 * 1024 * 1024);
    expect(providerOutputLimit("interview")).toBe(8 * 1024 * 1024);
    const directory = await mkdtemp(resolve(tmpdir(), "rb-harness-provider-overflow-"));
    const log = resolve(directory, "provider.log");
    const pidFile = resolve(directory, "detached.pid");
    await chmod(noisyProvider, 0o755);
    process.env.RB_HARNESS_TEST_CHILD_PID_FILE = pidFile;
    try {
      await expect(runProvider({
        configuration: { provider: "custom", model: "fixture", effort: "high", command: noisyProvider },
        mode: "generation",
        stage: "generation",
        projectRoot: directory,
        prompt: "fixture prompt",
        logPath: log,
        timeoutSeconds: 10,
        firstOutputTimeoutSeconds: 5,
        maxOutputBytes: 4 * 1024,
      })).rejects.toThrow("provider output exceeded 4096 bytes");
      const detachedPid = Number(await readFile(pidFile, "utf8"));
      expect(isExecutable(detachedPid)).toBe(false);
    } finally {
      delete process.env.RB_HARNESS_TEST_CHILD_PID_FILE;
    }
  }, 30_000);

  it("rejects an exact inherited secret in staged artifacts without echoing its value", async () => {
    const staging = await mkdtemp(resolve(tmpdir(), "rb-harness-secret-gate-"));
    await mkdir(resolve(staging, ".rb"), { recursive: true });
    const secret = "exact-generated-secret-sentinel";
    process.env.RB_HARNESS_TEST_SECRET = secret;
    await writeFile(resolve(staging, ".rb/leak.md"), `# Leak\n\n${secret}\n`, "utf8");
    try {
      await expect(assertNoEnvironmentSecrets(staging)).rejects.toThrow("RB_HARNESS_TEST_SECRET");
      await expect(assertNoEnvironmentSecrets(staging)).rejects.not.toThrow(secret);
    } finally {
      delete process.env.RB_HARNESS_TEST_SECRET;
    }
  });

  it("reports an explicit generated blocker as a repairable structural error", async () => {
    const staging = await mkdtemp(resolve(tmpdir(), "rb-harness-declared-blocker-"));
    await mkdir(resolve(staging, ".rb/evolutions/example"), { recursive: true });
    await writeFile(resolve(staging, ".rb/rb-manifest.json"), `${JSON.stringify({
      manifestVersion: "rb-manifest/v1",
      project: { id: "blocked-fixture", name: "Blocked fixture" },
      artifactRoot: ".rb",
      generatedAt: new Date().toISOString(),
      artifacts: [],
    }, null, 2)}\n`, "utf8");
    await writeFile(resolve(staging, ".rb/evolutions/example/BLOCKED.md"), "# BLOCKED\n\nExternal contract is unavailable.\n", "utf8");
    const validation = await validateStagedTree(staging, "evolve");
    expect(validation.valid).toBe(false);
    expect(validation.repairable).toBe(true);
    expect(validation.errors[0]?.message).toContain(".rb/evolutions/example/BLOCKED.md");
  });

  it("interviews, generates once, publishes to a custom directory, and preserves prior artifacts", async () => {
    const project = await mkdtemp(resolve(tmpdir(), "rb-harness-standalone-"));
    await writeFile(resolve(project, "package.json"), '{"name":"fixture"}\n', "utf8");
    await mkdir(resolve(project, ".rb"), { recursive: true });
    await writeFile(resolve(project, ".rb/stale-from-other-root.md"), "must not leak\n", "utf8");
    const answers = resolve(project, "answers.json");
    await writeFile(answers, '{"scope-boundary":"Yes"}\n', "utf8");
    await chmod(fakeProvider, 0o755);
    const first = await runStandaloneWorkflow({ ...baseOptions(project, answers), artifactDirectory: ".spec" });
    expect(first.status).toBe("complete");
    expect(first.interviewRound).toBe(2);
    expect(first.activeInterviewRound).toBeUndefined();
    expect(first.checkpoints?.publishedAt).toBeTruthy();
    expect(first.repairsUsed).toBe(0);
    expect((await validateManifestTree(project, { artifactDirectory: ".spec" })).valid).toBe(true);
    expect(await readFile(resolve(project, ".spec/features/standalone-test/REQUEST.md"), "utf8")).toContain("isolated requested feature");
    await expect(readFile(resolve(project, ".spec/stale-from-other-root.md"), "utf8")).rejects.toThrow();
    const inventory = await inspectProjectInventory(project, ".spec");
    expect(inventory.manifestValid).toBe(true);
    expect(inventory.readyPlans).toEqual([{ id: "standalone-test-execution", path: ".rb/features/standalone-test/PHASES.md" }]);

    await mkdir(resolve(project, ".spec/runs/runtime-evidence"), { recursive: true });
    await writeFile(resolve(project, ".spec/runs/runtime-evidence/keep.txt"), "keep\n", "utf8");
    const second = await runStandaloneWorkflow({
      ...baseOptions(project, answers),
      artifactDirectory: ".spec",
      request: "Revise the isolated version command documentation.",
    });
    expect(second.previousArtifacts).toBeTruthy();
    expect(await readFile(resolve(second.previousArtifacts!, "runs/runtime-evidence/keep.txt"), "utf8")).toBe("keep\n");

    const interruptedRun = resolve(project, ".rb-harness/runs/recovery-test-run");
    await mkdir(resolve(interruptedRun, "previous-artifacts"), { recursive: true });
    await writeFile(resolve(interruptedRun, "previous-artifacts/marker.txt"), "restored\n", "utf8");
    const recoveryState = { ...second, id: "recovery-test-run", artifactDirectory: ".recover", previousArtifacts: undefined };
    expect(await recoverInterruptedPublication(recoveryState, interruptedRun)).toBe(true);
    expect(await readFile(resolve(project, ".recover/marker.txt"), "utf8")).toBe("restored\n");
    await expect(prepareStagingTree(
      { ...second, artifactDirectory: ".git/generated" },
      interruptedRun,
    )).rejects.toThrow("cannot use .git or .rb-harness");
  }, 60_000);

  it("accepts one legacy complete-bundle call and uses no manager, auditor, or repair", async () => {
    const { project, answers } = await fixtureProject("rb-harness-single-writer-");
    const modes = resolve(project, "provider-modes.log");
    process.env.RB_HARNESS_TEST_PROVIDER_MODE_FILE = modes;
    try {
      const state = await runStandaloneWorkflow(baseOptions(project, answers));
      expect(state.status).toBe("complete");
      expect(state.artifactAudits).toBeUndefined();
      expect(state.repairsUsed).toBe(0);
      expect(state.verificationReport).toBeTruthy();
      expect(JSON.parse(await readFile(state.verificationReport!, "utf8"))).toMatchObject({
        deterministic: { passed: true },
        readyForRalph: true,
      });
      expect((await readFile(modes, "utf8")).trim().split("\n"))
        .toEqual(["interview", "interview", "generation"]);
    } finally {
      delete process.env.RB_HARNESS_TEST_PROVIDER_MODE_FILE;
    }
  }, 60_000);

  it("quarantines a rejected publication and restores the prior artifact revision", async () => {
    const { project, answers } = await fixtureProject("rb-harness-publication-rollback-");
    const state = await runStandaloneWorkflow(baseOptions(project, answers));
    const runRoot = resolve(project, ".rb-harness/runs", state.id);
    await writeFile(resolve(project, ".rb/prior-marker.txt"), "prior\n", "utf8");
    const staging = await prepareStagingTree(state, runRoot);
    await writeFile(resolve(staging, ".rb/new-marker.txt"), "rejected\n", "utf8");

    const previous = await publishStagedArtifacts(state, runRoot, staging);
    const failed = await rollbackPublishedArtifacts(state, runRoot, previous);

    expect(await readFile(resolve(project, ".rb/prior-marker.txt"), "utf8")).toBe("prior\n");
    expect(await readFile(resolve(failed, "new-marker.txt"), "utf8")).toBe("rejected\n");
  }, 60_000);

  it("formats prose-only CLI interviews in closed passes instead of repeating discovery", async () => {
    const { project, answers } = await fixtureProject("rb-harness-closed-interview-");
    const prompts = resolve(project, "protocol-prompts.log");
    process.env.RB_HARNESS_TEST_PROSE_INTERVIEW = "1";
    process.env.RB_HARNESS_TEST_PROMPT_FILE = prompts;
    try {
      const state = await runStandaloneWorkflow(baseOptions(project, answers));
      expect(state.status).toBe("complete");
      const recorded = await readFile(prompts, "utf8");
      // One formatter call in round one and two in round two: the second
      // round's first representation omitted the pending answer disposition,
      // so the deterministic defect drives one bounded formatting retry.
      expect(recorded.match(/===== EXACT OUTPUT CONTRACT =====/g)).toHaveLength(3);
      expect(recorded).toContain("Let me now craft the required envelope");
    } finally {
      delete process.env.RB_HARNESS_TEST_PROSE_INTERVIEW;
      delete process.env.RB_HARNESS_TEST_PROMPT_FILE;
    }
  }, 60_000);

  it("never sends the Harness installation, resources, or contracts to the writer", async () => {
    const { project, answers } = await fixtureProject("rb-harness-prompt-scope-");
    const prompts = resolve(project, "prompts.log");
    process.env.RB_HARNESS_TEST_PROMPT_FILE = prompts;
    try {
      await runStandaloneWorkflow(baseOptions(project, answers));
      const captured = await readFile(prompts, "utf8");
      expect(captured).toContain("rb-harness-input/v1");
      expect(captured).toContain("rb-harness-contract-digest/v1");
      expect(captured).not.toContain("packages/core/src");
      expect(captured).not.toContain("/dist/resources");
      expect(captured).toContain("Never inspect the RB Harness installation");
    } finally {
      delete process.env.RB_HARNESS_TEST_PROMPT_FILE;
    }
  }, 60_000);

  it("repairs one structural error in place and preserves unrelated documents", async () => {
    const project = await mkdtemp(resolve(tmpdir(), "rb-harness-structural-repair-"));
    await writeFile(resolve(project, "package.json"), '{"name":"repair-fixture"}\n', "utf8");
    const answers = resolve(project, "answers.json");
    await writeFile(answers, "{}\n", "utf8");
    await chmod(repairingProvider, 0o755);
    const modes = resolve(project, "provider-modes.log");
    const workingDirectories = resolve(project, "provider-working-directories.jsonl");
    process.env.RB_HARNESS_TEST_PROVIDER_MODE_FILE = modes;
    process.env.RB_HARNESS_TEST_PROVIDER_CWD_FILE = workingDirectories;
    try {
      const state = await runStandaloneWorkflow({
        ...baseOptions(project, answers, repairingProvider),
        request: "Plan a deterministic scope gate.",
      });
      expect(state.status).toBe("complete");
      expect(state.repairsUsed).toBe(1);
      expect((await readFile(modes, "utf8")).trim().split("\n"))
        .toEqual(["interview", "generation", "repair", "repair"]);
      const invocations = (await readFile(workingDirectories, "utf8")).trim().split("\n")
        .map((line) => JSON.parse(line) as { mode: string; cwd: string; entries: string[] });
      const repair = invocations.find((invocation) => invocation.mode === "repair");
      expect(repair?.cwd).not.toBe(project);
      expect(repair?.entries).toEqual([]);
      expect(await readFile(resolve(project, ".rb/features/structural-repair/PHASES.md"), "utf8"))
        .toContain("finite accepted and rejected values");
      // A document the repair did not touch must survive byte for byte.
      expect(await readFile(resolve(project, ".rb/features/structural-repair/SPEC.md"), "utf8"))
        .toContain("request.targetMode");
    } finally {
      delete process.env.RB_HARNESS_TEST_PROVIDER_MODE_FILE;
      delete process.env.RB_HARNESS_TEST_PROVIDER_CWD_FILE;
    }
  }, 60_000);

  it("fails a cross-task Go repair that returns a complete document for one region", async () => {
    const project = await mkdtemp(resolve(tmpdir(), "rb-harness-go-convergence-repair-"));
    await writeFile(resolve(project, "go.mod"), "module example.com/repair-fixture\n\ngo 1.22\n", "utf8");
    const answers = resolve(project, "answers.json");
    await writeFile(answers, "{}\n", "utf8");
    await chmod(repairingProvider, 0o755);
    process.env.RB_HARNESS_TEST_GO_REPAIR = "1";
    try {
      await expect(runStandaloneWorkflow({
        ...baseOptions(project, answers, repairingProvider),
        request: "Plan a convergent Go module introduction.",
      })).rejects.toThrow(/complete-document or outside-region content/);
    } finally {
      delete process.env.RB_HARNESS_TEST_GO_REPAIR;
    }
  }, 60_000);

  it("rejects an invalid control-plane scope inside the authorized task region", async () => {
    const project = await mkdtemp(resolve(tmpdir(), "rb-harness-multi-repair-"));
    await writeFile(resolve(project, "package.json"), '{"name":"repair-fixture"}\n', "utf8");
    const answers = resolve(project, "answers.json");
    await writeFile(answers, "{}\n", "utf8");
    await chmod(repairingProvider, 0o755);
    const modes = resolve(project, "provider-modes.log");
    process.env.RB_HARNESS_TEST_PROVIDER_MODE_FILE = modes;
    process.env.RB_HARNESS_TEST_TWO_REPAIRS = "1";
    try {
      await expect(runStandaloneWorkflow({
        ...baseOptions(project, answers, repairingProvider),
        request: "Plan a deterministic scope gate and correct generated defects until valid.",
      })).rejects.toThrow(/invalid execution document.*task.scope.control-plane/);
      expect((await readFile(modes, "utf8")).trim().split("\n"))
        .toEqual(["interview", "generation", "repair", "repair"]);
    } finally {
      delete process.env.RB_HARNESS_TEST_PROVIDER_MODE_FILE;
      delete process.env.RB_HARNESS_TEST_TWO_REPAIRS;
    }
  }, 60_000);

  it("reports a truncated or missing envelope instead of publishing", async () => {
    for (const [command, message] of [
      [truncatedProvider, "truncated"],
      [silentProvider, "does not contain"],
    ] as const) {
      const project = await mkdtemp(resolve(tmpdir(), "rb-harness-bad-envelope-"));
      await writeFile(resolve(project, "package.json"), '{"name":"fixture"}\n', "utf8");
      const answers = resolve(project, "answers.json");
      await writeFile(answers, '{"scope-boundary":"Yes"}\n', "utf8");
      await chmod(command, 0o755);
      await expect(runStandaloneWorkflow({ ...baseOptions(project, answers, command) }))
        .rejects.toThrow(message);
      await expect(readFile(resolve(project, ".rb/rb-manifest.json"), "utf8")).rejects.toThrow();
    }
  }, 60_000);

  it("resumes from a persisted bundle without reinvoking the provider", async () => {
    const { project, answers } = await fixtureProject("rb-harness-bundle-resume-");
    const completed = await runStandaloneWorkflow(baseOptions(project, answers));
    const id = "bundle-recovery-run";
    const runRoot = resolve(project, ".rb-harness/runs", id);
    await mkdir(runRoot, { recursive: true, mode: 0o700 });
    const sourceBundle = await readFile(resolve(project, ".rb-harness/runs", completed.id, "bundle.json"), "utf8");
    await writeFile(resolve(runRoot, "bundle.json"), sourceBundle, "utf8");
    await rm(resolve(project, ".rb"), { recursive: true, force: true });
    const { createHash } = await import("node:crypto");
    const recovery = {
      ...completed,
      id,
      status: "generation-failed" as const,
      previousArtifacts: undefined,
      publishedAt: undefined,
      telemetry: undefined,
      bundle: {
        contract: "rb-harness-documents/v1" as const,
        documents: 4,
        sha256: createHash("sha256").update(sourceBundle).digest("hex"),
        receivedAt: new Date().toISOString(),
        repaired: false,
      },
      diagnostic: "generated artifact tree is invalid",
    };
    await writeRunState(recovery);
    const modes = resolve(project, "provider-modes.log");
    process.env.RB_HARNESS_TEST_PROVIDER_MODE_FILE = modes;
    try {
      const resumed = await resumeStandaloneWorkflow(project, id, { timeoutSeconds: 30, firstOutputTimeoutSeconds: 5 });
      expect(resumed.status).toBe("complete");
      await expect(readFile(modes, "utf8")).rejects.toThrow();
      expect(await readFile(resolve(project, ".rb/features/standalone-test/PHASES.md"), "utf8"))
        .toContain("rb-execution/v1");
    } finally {
      delete process.env.RB_HARNESS_TEST_PROVIDER_MODE_FILE;
    }
  }, 60_000);

  it("materializes a bundle into staging without copying the project source", async () => {
    const project = await mkdtemp(resolve(tmpdir(), "rb-harness-staging-"));
    await mkdir(resolve(project, "src"), { recursive: true });
    await writeFile(resolve(project, "src/huge.ts"), "x".repeat(4096), "utf8");
    const runRoot = resolve(project, ".rb-harness/runs/staging-run");
    await mkdir(runRoot, { recursive: true, mode: 0o700 });
    const staging = await prepareStagingTree({
      projectRoot: project,
      artifactDirectory: ".rb",
      inventory: { projectName: "Staging fixture", projectId: "staging-fixture" },
    } as never, runRoot);
    await expect(readFile(resolve(staging, "src/huge.ts"), "utf8")).rejects.toThrow();
    const bundle = parseDocumentBundle(`RB_HARNESS_DOCUMENTS_JSON_BEGIN\n${JSON.stringify({
      contract: "rb-harness-documents/v1",
      status: "complete",
      summary: "one document",
      documents: [{ path: ".rb/context/ARCHITECTURE.md", content: "# Architecture" }],
    })}\nRB_HARNESS_DOCUMENTS_JSON_END`);
    expect(await materializeDocuments(staging, bundle)).toEqual([".rb/context/ARCHITECTURE.md"]);
    expect(await readFile(resolve(staging, ".rb/context/ARCHITECTURE.md"), "utf8")).toBe("# Architecture\n");
  });
});
