import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseInterviewAnalysis, recoverInterviewAnalysis } from "../src/harness-interview.js";
import { artifactAuditFingerprint, parseArtifactAudit } from "../src/harness-audit.js";
import { providerInvocation, runProvider } from "../src/harness-provider.js";
import { inspectProjectInventory } from "../src/harness-inventory.js";
import { composeHarnessSplash, harnessBrand, renderHarnessSplashFrame } from "../src/harness-splash.js";
import { resolveWorkflowResourceRoot } from "../src/standalone-resources.js";
import { runStandaloneWorkflow } from "../src/standalone-runner.js";
import { assertNoEnvironmentSecrets, prepareGenerationWorkspace, recoverInterruptedPublication } from "../src/harness-workspace.js";
import { validateManifestTree } from "../src/manifest.js";

const fakeProvider = resolve(process.cwd(), "test/fixtures/standalone/fake-provider.mjs");
const failingProvider = resolve(process.cwd(), "test/fixtures/standalone/failing-provider.mjs");
const repairingProvider = resolve(process.cwd(), "test/fixtures/standalone/repairing-provider.mjs");

describe("standalone RB Harness", () => {
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
});
