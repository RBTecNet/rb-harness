import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseInterviewAnalysis, recoverInterviewAnalysis } from "../src/harness-interview.js";
import { artifactAuditFingerprint, parseArtifactAudit } from "../src/harness-audit.js";
import { providerInvocation, providerOutputLimit, runProvider } from "../src/harness-provider.js";
import { inspectProjectInventory } from "../src/harness-inventory.js";
import { composeHarnessSplash, harnessBrand, renderHarnessSplashFrame } from "../src/harness-splash.js";
import { loadWorkflowResources, requestNeedsHeadlessContracts, resolveWorkflowResourceRoot } from "../src/standalone-resources.js";
import { hasReadyInterviewCheckpoint, nextInterviewRound, normalizeInterviewAnswer, resumeStandaloneWorkflow, runStandaloneWorkflow } from "../src/standalone-runner.js";
import { assertNoEnvironmentSecrets, prepareGenerationWorkspace, recoverInterruptedPublication, validateGeneratedWorkspace } from "../src/harness-workspace.js";
import { validateManifestTree } from "../src/manifest.js";
import { writeRunState } from "../src/harness-state.js";

const fakeProvider = resolve(process.cwd(), "test/fixtures/standalone/fake-provider.mjs");
const failingProvider = resolve(process.cwd(), "test/fixtures/standalone/failing-provider.mjs");
const noisyProvider = resolve(process.cwd(), "test/fixtures/standalone/noisy-provider.mjs");
const repairingProvider = resolve(process.cwd(), "test/fixtures/standalone/repairing-provider.mjs");

describe("standalone RB Harness", () => {
  it("continues durable and legacy interviews without reusing prior round logs", () => {
    expect(nextInterviewRound({})).toBe(1);
    expect(nextInterviewRound({ diagnostic: "interview exceeded six adaptive rounds" })).toBe(7);
    expect(nextInterviewRound({ interviewRound: 7 })).toBe(8);
    expect(nextInterviewRound({ interviewRound: 7, activeInterviewRound: 8 })).toBe(8);
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

  it("preserves the versioned RB wordmark and capybara mascot", () => {
    const brand = harnessBrand("0.2.3");
    expect(brand).toContain("◕      ◕");
    expect(brand).toContain("▪  ▪");
    expect(brand).toContain("◡◡");
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

  it("maps provider-neutral model and effort settings without a profile layer", () => {
    const codex = providerInvocation({ provider: "codex", model: "gpt-5.6-sol", effort: "xhigh" }, "interview", "/tmp/project");
    expect(codex.args).toContain("gpt-5.6-sol");
    expect(codex.args).toContain('model_reasoning_effort="xhigh"');
    expect(codex.args).toContain("read-only");
    const claude = providerInvocation({ provider: "claude", model: "opus", effort: "high" }, "generation", "/tmp/project");
    expect(claude.args).toEqual(expect.arrayContaining(["--model", "opus", "--effort", "high", "acceptEdits"]));
    const opencode = providerInvocation({ provider: "opencode", model: "opencode/mimo", effort: "high" }, "generation", "/tmp/project");
    expect(opencode.args).toEqual(expect.arrayContaining(["--model", "opencode/mimo", "--variant", "high", "--auto"]));
  });

  it("rejects an ambiguous accepted answer and unresolved responses without a follow-up", () => {
    const pending = [{ questionId: "scope-boundary", question: "Scope?", rawAnswer: "Whatever", disposition: "PENDING" as const, answeredAt: new Date().toISOString() }];
    const acceptedWithoutDecision = {
      contract: "rb-harness-interview/v1", status: "ready", summary: "Summary", discoveries: [], assumptions: [], unresolved: [],
      answerReviews: [{ questionId: "scope-boundary", disposition: "ACCEPTED" }], questions: [],
    };
    expect(() => parseInterviewAnalysis(`RB_HARNESS_INTERVIEW_JSON_BEGIN\n${JSON.stringify(acceptedWithoutDecision)}\nRB_HARNESS_INTERVIEW_JSON_END`, pending)).toThrow("no normalized decision");
    const ambiguousWithoutFollowUp = {
      ...acceptedWithoutDecision, status: "needs_input",
      answerReviews: [{ questionId: "scope-boundary", disposition: "AMBIGUOUS", remainingUncertainty: "Two scopes remain" }],
      questions: [{ id: "another-question", question: "Different question?", why: "Reason", type: "confirm", options: [] }],
    };
    expect(() => parseInterviewAnalysis(`RB_HARNESS_INTERVIEW_JSON_BEGIN\n${JSON.stringify(ambiguousWithoutFollowUp)}\nRB_HARNESS_INTERVIEW_JSON_END`, pending)).toThrow("no focused follow-up");
    expect(() => parseInterviewAnalysis(`RB_HARNESS_INTERVIEW_JSON_BEGIN\n${JSON.stringify(acceptedWithoutDecision)}\nRB_HARNESS_INTERVIEW_JSON_END\nextra`, pending)).toThrow("no surrounding text");
  });

  it("accepts safe compact and descriptive uppercase interview question IDs", () => {
    const source = (id: string) => `RB_HARNESS_INTERVIEW_JSON_BEGIN\n${JSON.stringify({
      contract: "rb-harness-interview/v1",
      status: "needs_input",
      summary: "One decision remains.",
      discoveries: [],
      assumptions: [],
      unresolved: ["Decision"],
      answerReviews: [],
      questions: [{ id, question: "Choose?", why: "It changes scope.", type: "confirm", options: [] }],
    })}\nRB_HARNESS_INTERVIEW_JSON_END`;
    expect(parseInterviewAnalysis(source("q1"), []).questions[0]?.id).toBe("q1");
    expect(parseInterviewAnalysis(source("EVO-MEMORY-001"), []).questions[0]?.id).toBe("EVO-MEMORY-001");
    expect(() => parseInterviewAnalysis(source("q"), [])).toThrow("2-80 ASCII");
  });

  it("normalizes omitted options for text/confirm questions and rejects invented choices", () => {
    const envelope = (question: Record<string, unknown>) => `RB_HARNESS_INTERVIEW_JSON_BEGIN\n${JSON.stringify({
      contract: "rb-harness-interview/v1",
      status: "needs_input",
      summary: "One decision remains.",
      discoveries: [], assumptions: [], unresolved: ["Decision"], answerReviews: [], questions: [question],
    })}\nRB_HARNESS_INTERVIEW_JSON_END`;
    const text = { id: "follow-up-1", question: "Add the missing limit.", why: "It affects admission.", type: "text" };
    expect(parseInterviewAnalysis(envelope(text), []).questions[0]?.options).toEqual([]);
    expect(() => parseInterviewAnalysis(envelope({ ...text, options: ["Free text"] }), []))
      .toThrow("must not declare choices");
    expect(() => parseInterviewAnalysis(envelope({ ...text, type: "single-choice" }), []))
      .toThrow("needs at least two choices");
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
    expect((await recoverInterviewAnalysis(log, []))?.questions[0]?.id).toBe("q1");
  });

  it("enforces a strict exhaustive artifact-audit envelope and stable root-cause fingerprint", () => {
    const finding = {
      id: "proofability.scope-authority",
      category: "proofability",
      artifact: ".rb/features/example/SPEC.md",
      criterion: "RF-001",
      evidence: "A deterministic validator is asked to understand unlimited prose.",
      requiredChange: "Use a typed authority and finite matrix.",
    };
    const source = (value: unknown) => `RB_HARNESS_ARTIFACT_AUDIT_JSON_BEGIN\n${JSON.stringify(value)}\nRB_HARNESS_ARTIFACT_AUDIT_JSON_END`;
    const first = parseArtifactAudit(source({
      contract: "rb-harness-artifact-audit/v1", status: "revise", summary: "One root cause.", findings: [finding],
    }));
    const second = parseArtifactAudit(source({
      contract: "rb-harness-artifact-audit/v1", status: "revise", summary: "Same cause, revised prose.",
      findings: [{ ...finding, evidence: "Different reproduction of the same issue.", requiredChange: "Establish the same invariant." }],
    }));
    expect(artifactAuditFingerprint(first)).toBe(artifactAuditFingerprint(second));
    expect(() => parseArtifactAudit(source({
      contract: "rb-harness-artifact-audit/v1", status: "pass", summary: "Contradictory pass.", findings: [finding],
    }))).toThrow("must not contain findings");
    expect(() => parseArtifactAudit(source({
      contract: "rb-harness-artifact-audit/v1", status: "blocked", summary: "Decision allegedly required.", findings: [finding],
    }))).toThrow("must declare one explicit developer decision");
    const blocked = parseArtifactAudit(source({
      contract: "rb-harness-artifact-audit/v1", status: "blocked", summary: "Two product outcomes remain valid.", findings: [finding],
      decision: {
        question: "Which externally visible retention policy should the product enforce?",
        reason: "The accepted request requires retention but does not choose between incompatible durations.",
        options: ["Retain for 30 days", "Retain for 90 days"],
      },
    }));
    expect(blocked.decision?.options).toEqual(["Retain for 30 days", "Retain for 90 days"]);
    expect(() => parseArtifactAudit(source({
      contract: "rb-harness-artifact-audit/v1", status: "revise", summary: "Repairable.", findings: [finding],
      decision: blocked.decision,
    }))).toThrow("only a blocked artifact audit");
    expect(() => parseArtifactAudit(`${source({
      contract: "rb-harness-artifact-audit/v1", status: "pass", summary: "Pass.", findings: [],
    })}\nextra`)).toThrow("no surrounding text");
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
        projectRoot: directory,
        prompt: "fixture prompt",
        logPath: log,
        timeoutSeconds: 10,
        firstOutputTimeoutSeconds: 5,
      })).rejects.toThrow("see");
      const evidence = await readFile(log, "utf8");
      expect(evidence).toContain("exit_code=9");
      expect(evidence).toContain("[REDACTED:RB_HARNESS_TEST_API_KEY]");
      expect(evidence).not.toContain(secret);
    } finally {
      delete process.env.RB_HARNESS_TEST_API_KEY;
    }
  });
  it("allows larger bounded generation transcripts and kills nested provider sessions on overflow", async () => {
    expect(providerOutputLimit("generation")).toBe(128 * 1024 * 1024);
    expect(providerOutputLimit("interview")).toBe(32 * 1024 * 1024);
    expect(providerOutputLimit("audit")).toBe(32 * 1024 * 1024);
    const directory = await mkdtemp(resolve(tmpdir(), "rb-harness-provider-overflow-"));
    const log = resolve(directory, "provider.log");
    const pidFile = resolve(directory, "detached.pid");
    await chmod(noisyProvider, 0o755);
    process.env.RB_HARNESS_TEST_CHILD_PID_FILE = pidFile;
    try {
      await expect(runProvider({
        configuration: { provider: "custom", model: "fixture", effort: "high", command: noisyProvider },
        mode: "generation",
        projectRoot: directory,
        prompt: "fixture prompt",
        logPath: log,
        timeoutSeconds: 10,
        firstOutputTimeoutSeconds: 5,
        maxOutputBytes: 4 * 1024,
      })).rejects.toThrow("provider output exceeded 4096 bytes");
      const detachedPid = Number(await readFile(pidFile, "utf8"));
      let alive = true;
      for (let attempt = 0; attempt < 40 && alive; attempt += 1) {
        try { process.kill(detachedPid, 0); }
        catch { alive = false; }
        if (alive) await new Promise((resolveWait) => setTimeout(resolveWait, 25));
      }
      expect(alive).toBe(false);
    } finally {
      delete process.env.RB_HARNESS_TEST_CHILD_PID_FILE;
    }
  });

  it("rejects an exact inherited secret in staged artifacts without echoing its value", async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), "rb-harness-secret-gate-"));
    await mkdir(resolve(workspace, ".rb"), { recursive: true });
    const secret = "exact-generated-secret-sentinel";
    process.env.RB_HARNESS_TEST_SECRET = secret;
    await writeFile(resolve(workspace, ".rb/leak.md"), `# Leak\n\n${secret}\n`, "utf8");
    try {
      await expect(assertNoEnvironmentSecrets(workspace)).rejects.toThrow("RB_HARNESS_TEST_SECRET");
      await expect(assertNoEnvironmentSecrets(workspace)).rejects.not.toThrow(secret);
    } finally {
      delete process.env.RB_HARNESS_TEST_SECRET;
    }
  });

  it("reports an explicit generated blocker instead of a generic missing-output error", async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), "rb-harness-declared-blocker-"));
    await mkdir(resolve(workspace, ".rb/evolutions/example"), { recursive: true });
    await writeFile(resolve(workspace, ".rb/rb-manifest.json"), `${JSON.stringify({
      manifestVersion: "rb-manifest/v1",
      project: { id: "blocked-fixture", name: "Blocked fixture" },
      artifactRoot: ".rb",
      generatedAt: new Date().toISOString(),
      artifacts: [],
    }, null, 2)}\n`, "utf8");
    await writeFile(resolve(workspace, ".rb/evolutions/example/BLOCKED.md"), "# BLOCKED\n\nExternal contract is unavailable.\n", "utf8");
    await expect(validateGeneratedWorkspace(workspace, "evolve"))
      .rejects.toThrow("explicitly declared BLOCKED in .rb/evolutions/example/BLOCKED.md");
  });

  it("interviews headlessly, validates in isolation, publishes to a custom directory, and preserves prior artifacts", async () => {
    const project = await mkdtemp(resolve(tmpdir(), "rb-harness-standalone-"));
    await writeFile(resolve(project, "package.json"), '{"name":"fixture"}\n', "utf8");
    await mkdir(resolve(project, ".rb"), { recursive: true });
    await writeFile(resolve(project, ".rb/stale-from-other-root.md"), "must not leak\n", "utf8");
    const answers = resolve(project, "answers.json");
    await writeFile(answers, '{"scope-boundary":"Yes"}\n', "utf8");
    await chmod(fakeProvider, 0o755);
    const first = await runStandaloneWorkflow({
      workflow: "plan",
      projectRoot: project,
      artifactDirectory: ".spec",
      request: "Plan an isolated version command.",
      provider: { provider: "custom", model: "fixture-model", effort: "high", command: fakeProvider },
      answersFile: answers,
      questionMode: "one-by-one",
      nonInteractive: true,
      timeoutSeconds: 30,
      firstOutputTimeoutSeconds: 5,
    });
    expect(first.status).toBe("complete");
    expect(first.interviewRound).toBe(2);
    expect(first.activeInterviewRound).toBeUndefined();
    expect(first.artifactAudits?.map((audit) => audit.status)).toEqual(["pass"]);
    expect((await validateManifestTree(project, { artifactDirectory: ".spec" })).valid).toBe(true);
    expect(await readFile(resolve(project, ".spec/features/standalone-test/REQUEST.md"), "utf8")).toContain("isolated requested feature");
    await expect(readFile(resolve(project, ".spec/stale-from-other-root.md"), "utf8")).rejects.toThrow();
    const inventory = await inspectProjectInventory(project, ".spec");
    expect(inventory.manifestValid).toBe(true);
    expect(inventory.readyPlans).toEqual([{ id: "standalone-test-execution", path: ".rb/features/standalone-test/PHASES.md" }]);
    expect(inventory.artifactHighlights.some((artifact) => artifact.title && artifact.summary)).toBe(true);

    await mkdir(resolve(project, ".spec/runs/runtime-evidence"), { recursive: true });
    await writeFile(resolve(project, ".spec/runs/runtime-evidence/keep.txt"), "keep\n", "utf8");
    const second = await runStandaloneWorkflow({
      workflow: "plan",
      projectRoot: project,
      artifactDirectory: ".spec",
      request: "Revise the isolated version command documentation.",
      provider: { provider: "custom", model: "fixture-model", effort: "high", command: fakeProvider },
      answersFile: answers,
      questionMode: "one-by-one",
      nonInteractive: true,
      timeoutSeconds: 30,
      firstOutputTimeoutSeconds: 5,
    });
    expect(second.previousArtifacts).toBeTruthy();
    expect(await readFile(resolve(second.previousArtifacts!, "runs/runtime-evidence/keep.txt"), "utf8")).toBe("keep\n");

    const interruptedRun = resolve(project, ".rb-harness/runs/recovery-test-run");
    await mkdir(resolve(interruptedRun, "previous-artifacts"), { recursive: true });
    await writeFile(resolve(interruptedRun, "previous-artifacts/marker.txt"), "restored\n", "utf8");
    const recoveryState = { ...second, id: "recovery-test-run", artifactDirectory: ".recover", previousArtifacts: undefined };
    expect(await recoverInterruptedPublication(recoveryState, interruptedRun)).toBe(true);
    expect(await readFile(resolve(project, ".recover/marker.txt"), "utf8")).toBe("restored\n");
    await expect(prepareGenerationWorkspace(
      { ...second, artifactDirectory: ".git/generated" },
      interruptedRun,
    )).rejects.toThrow("cannot use .git or .rb-harness");
  }, 30_000);

  it("audits generated semantics in a fresh read-only pass and repairs the invariant before publication", async () => {
    const project = await mkdtemp(resolve(tmpdir(), "rb-harness-audit-repair-"));
    await writeFile(resolve(project, "package.json"), '{"name":"audit-repair-fixture"}\n', "utf8");
    await chmod(repairingProvider, 0o755);
    const state = await runStandaloneWorkflow({
      workflow: "plan",
      projectRoot: project,
      artifactDirectory: ".rb",
      request: "Plan a deterministic greenfield scope gate.",
      provider: { provider: "custom", model: "repairing-fixture", effort: "high", command: repairingProvider },
      questionMode: "one-by-one",
      nonInteractive: true,
      timeoutSeconds: 30,
      firstOutputTimeoutSeconds: 5,
    });
    expect(state.status).toBe("complete");
    expect(state.artifactAudits?.map((audit) => audit.status)).toEqual(["revise", "pass"]);
    expect(await readFile(resolve(project, ".rb/features/audit-repair/SPEC.md"), "utf8")).toContain("request.targetMode");
    await expect(readFile(resolve(project, ".rb/features/audit-repair/SPEC.md"), "utf8")).resolves.not.toContain("every phrase");
  }, 30_000);

  it("resumes a completed provider generation at deterministic validation without reinvoking the writer", async () => {
    const project = await mkdtemp(resolve(tmpdir(), "rb-harness-validation-resume-"));
    await writeFile(resolve(project, "package.json"), '{"name":"validation-resume-fixture"}\n', "utf8");
    const answers = resolve(project, "answers.json");
    await writeFile(answers, '{"scope-boundary":"Yes"}\n', "utf8");
    await chmod(fakeProvider, 0o755);
    const completed = await runStandaloneWorkflow({
      workflow: "plan",
      projectRoot: project,
      artifactDirectory: ".rb",
      request: "Plan a validated resumable feature.",
      provider: { provider: "custom", model: "fixture-model", effort: "high", command: fakeProvider },
      answersFile: answers,
      questionMode: "one-by-one",
      nonInteractive: true,
      timeoutSeconds: 30,
      firstOutputTimeoutSeconds: 5,
    });
    const id = "validation-recovery-run";
    const runRoot = resolve(project, ".rb-harness/runs", id);
    const recovery = {
      ...completed,
      id,
      status: "generation-failed" as const,
      artifactAudits: undefined,
      generationCheckpoint: undefined,
      previousArtifacts: undefined,
      publishedAt: undefined,
      diagnostic: "generated artifact tree is invalid: artifact.id.duplicate: fixture",
    };
    await prepareGenerationWorkspace(recovery, runRoot);
    await writeRunState(recovery);
    const modes = resolve(project, "provider-modes.log");
    process.env.RB_HARNESS_TEST_PROVIDER_MODE_FILE = modes;
    try {
      const resumed = await resumeStandaloneWorkflow(project, id, {
        timeoutSeconds: 30,
        firstOutputTimeoutSeconds: 5,
      });
      expect(resumed.status).toBe("complete");
      expect((await readFile(modes, "utf8")).trim().split("\n")).toEqual(["audit"]);
      expect(resumed.generationCheckpoint).toBeUndefined();
    } finally {
      delete process.env.RB_HARNESS_TEST_PROVIDER_MODE_FILE;
    }
  }, 30_000);

  it("repairs a legacy decisionless audit block from its preserved staged workspace", async () => {
    const project = await mkdtemp(resolve(tmpdir(), "rb-harness-audit-block-resume-"));
    await writeFile(resolve(project, "package.json"), '{"name":"audit-block-resume-fixture"}\n', "utf8");
    const answers = resolve(project, "answers.json");
    await writeFile(answers, '{"scope-boundary":"Yes"}\n', "utf8");
    await chmod(fakeProvider, 0o755);
    const completed = await runStandaloneWorkflow({
      workflow: "plan",
      projectRoot: project,
      artifactDirectory: ".rb",
      request: "Plan a resumable audit repair.",
      provider: { provider: "custom", model: "fixture-model", effort: "high", command: fakeProvider },
      answersFile: answers,
      questionMode: "one-by-one",
      nonInteractive: true,
      timeoutSeconds: 30,
      firstOutputTimeoutSeconds: 5,
    });
    const id = "legacy-audit-block-run";
    const runRoot = resolve(project, ".rb-harness/runs", id);
    const finding = {
      id: "proofability.legacy-block",
      category: "proofability" as const,
      artifact: ".rb/features/standalone-test/SPEC.md",
      criterion: "RF-001",
      evidence: "A historical Harness accepted a blocked verdict without a concrete developer question.",
      requiredChange: "Repair the technical invariant from the preserved draft.",
    };
    const recovery = {
      ...completed,
      id,
      status: "blocked" as const,
      artifactAudits: [{
        contract: "rb-harness-artifact-audit/v1" as const,
        status: "blocked" as const,
        summary: "Legacy decisionless block.",
        findings: [finding],
        pass: 2,
        fingerprint: "a".repeat(64),
        auditedAt: new Date().toISOString(),
      }],
      generationCheckpoint: undefined,
      previousArtifacts: undefined,
      publishedAt: undefined,
      diagnostic: "artifact audit requires a material developer decision: proofability.legacy-block",
    };
    await prepareGenerationWorkspace(recovery, runRoot);
    const preserved = resolve(runRoot, "workspace/.rb/features/standalone-test/preserved-pass-two.md");
    await writeFile(preserved, "preserve this draft evidence\n", "utf8");
    await writeRunState(recovery);
    const modes = resolve(project, "provider-modes.log");
    process.env.RB_HARNESS_TEST_PROVIDER_MODE_FILE = modes;
    try {
      const resumed = await resumeStandaloneWorkflow(project, id, {
        timeoutSeconds: 30,
        firstOutputTimeoutSeconds: 5,
      });
      expect(resumed.status).toBe("complete");
      expect((await readFile(modes, "utf8")).trim().split("\n")).toEqual(["generation", "audit"]);
      expect(await readFile(resolve(project, ".rb/features/standalone-test/preserved-pass-two.md"), "utf8"))
        .toBe("preserve this draft evidence\n");
    } finally {
      delete process.env.RB_HARNESS_TEST_PROVIDER_MODE_FILE;
    }
  }, 30_000);
});
