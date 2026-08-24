import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { validateHeadlessInitValue } from "../src/headless-contract.js";
import { validateHeadlessInterviewValue } from "../src/headless-interview-contract.js";
import { runHeadlessInterview } from "../src/headless-interview-runner.js";

const hash = "a".repeat(64);
const adapterScript = resolve(process.cwd(), "test/fixtures/headless/fake-interview-adapter.mjs");
const bundledCli = resolve(process.cwd(), "../../plugins/rb-harness/scripts/rb-harness.cjs");

function initRequest() {
  return {
    contract: "rb-headless-init/v1", kind: "request", requestId: "request-1", workflow: "init", projectKind: "new",
    project: { id: "demo-project", name: "Demo", description: "A new project", metadata: {} },
    artifactSet: { id: "set-1", name: "Default", description: "", strategy: "" },
    revision: { id: "revision-1", number: 1, createdAt: "2026-01-01T00:00:00.000Z" },
    specifications: [{ id: "spec-1", title: "Spec", description: "Description", decisions: [], metadata: {}, snapshotHash: hash, resources: [] }],
    additionalInstructions: "", interviewAnswers: [],
  };
}

function start(cursor: string | null = null) {
  return {
    contract: "rb-headless-interview/v1", kind: "interview_start", requestId: "request-1",
    captureHash: hash, initRequest: initRequest(), cursor,
  };
}

function answer(question: Record<string, unknown>, cursor: string, interviewId: string, value: string, key = "answer-1") {
  return {
    contract: "rb-headless-interview/v1", kind: "answer", requestId: "request-1", interviewId,
    sequence: question.sequence, questionId: question.questionId, answer: value, idempotencyKey: key, cursor,
  };
}

async function fixture(mode = "normal") {
  const workspace = await mkdtemp(resolve(tmpdir(), "rb-headless-interview-workspace-"));
  const stateRoot = await mkdtemp(resolve(tmpdir(), "rb-headless-interview-state-"));
  const captureRoot = await mkdtemp(resolve(tmpdir(), "rb-headless-interview-capture-"));
  const capture = resolve(captureRoot, "capture.json");
  return {
    workspace, stateRoot, capture,
    adapter: { command: process.execPath, args: [adapterScript, mode], id: "fake-interview", version: "1", provider: "test", model: "fake" },
    environment: {
      PATH: process.env.PATH,
      RB_HEADLESS_ENV_ALLOWLIST: "RB_HEADLESS_TEST_CAPTURE,RB_HEADLESS_TEST_SECRET",
      RB_HEADLESS_TEST_CAPTURE: capture,
      RB_HEADLESS_TEST_SECRET: "SECRET_SENTINEL_INTERVIEW_12345",
    },
  };
}

function event(result: Record<string, unknown>, kind: string): Record<string, unknown> {
  return (result.events as Array<Record<string, unknown>>).find((entry) => entry.kind === kind)!;
}

function runBundled(args: string[], input: string, cwd: string, environment: NodeJS.ProcessEnv = {}): Promise<{ exitCode: number | null; result: Record<string, unknown> }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [bundledCli, "--no-splash", ...args], {
      cwd, env: { PATH: process.env.PATH, ...environment }, stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      try { resolveRun({ exitCode, result: JSON.parse(stdout) as Record<string, unknown> }); }
      catch (error) { reject(new Error(`Bundled CLI returned invalid JSON (${stderr}): ${error instanceof Error ? error.message : String(error)}`)); }
    });
    child.stdin.end(input, "utf8");
  });
}

describe("rb-headless-interview/v1", () => {
  it("validates closed request and response variants", () => {
    expect(validateHeadlessInterviewValue(start()).valid).toBe(true);
    expect(validateHeadlessInterviewValue({ ...start(), surprise: true }).valid).toBe(false);
    expect(validateHeadlessInterviewValue({ ...start(), initRequest: { ...initRequest(), workflow: "evolve" } }).valid).toBe(false);
  });

  it("starts, resumes, accepts, completes, and replays an answer idempotently", async () => {
    const run = await fixture();
    const started = await runHeadlessInterview({ ...run, input: JSON.stringify(start()) });
    expect(started.exitCode).toBe(0);
    expect(started.result.status).toBe("active");
    const question = event(started.result, "question");
    expect(question.options).toEqual([
      { id: "option-1", label: "Brazil", recommended: true },
      { id: "option-2", label: "United States", recommended: false },
    ]);
    const capture = JSON.parse(await readFile(run.capture, "utf8"));
    expect(capture.environment.RB_HEADLESS_MODE).toBe("interview");
    expect(capture.environment.HOME).toBeUndefined();
    expect(capture.prompt).not.toContain("SECRET_SENTINEL_INTERVIEW_12345");

    const resumed = await runHeadlessInterview({ ...run, input: JSON.stringify(start(String(started.result.cursor))) });
    expect(event(resumed.result, "question")).toEqual(question);

    const submitted = answer(question, String(started.result.cursor), String(started.result.interviewId), "1");
    const completed = await runHeadlessInterview({ ...run, input: JSON.stringify(submitted) });
    expect([completed.exitCode, completed.result.status]).toEqual([0, "complete"]);
    expect(event(completed.result, "answer_result")).toMatchObject({ disposition: "accepted", normalizedDecision: "Brazil" });
    const complete = event(completed.result, "interview_complete");
    expect(complete.acceptedAnswers).toEqual([{ questionId: "deployment-region", question: "Which deployment region should be used?", answer: "Brazil", disposition: "accepted" }]);
    expect(validateHeadlessInitValue({ ...initRequest(), interviewAnswers: complete.acceptedAnswers }).valid).toBe(true);

    const replay = await runHeadlessInterview({ ...run, input: JSON.stringify(submitted) });
    expect(replay.result).toEqual(completed.result);
  });

  it("rejects ambiguity with a focused follow-up and resumes it after restart", async () => {
    const run = await fixture();
    const started = await runHeadlessInterview({ ...run, input: JSON.stringify(start()) });
    const question = event(started.result, "question");
    const ambiguous = await runHeadlessInterview({
      ...run,
      input: JSON.stringify(answer(question, String(started.result.cursor), String(started.result.interviewId), "talvez")),
    });
    expect(ambiguous.result.status).toBe("active");
    expect(event(ambiguous.result, "answer_result")).toMatchObject({
      disposition: "ambiguous", followUpQuestionId: "deployment-region-followup",
    });
    expect(event(ambiguous.result, "question")).toMatchObject({ questionId: "deployment-region-followup", answerFor: "deployment-region" });
    expect((ambiguous.result.events as Array<Record<string, unknown>>).some((entry) => entry.kind === "interview_complete")).toBe(false);

    const resumed = await runHeadlessInterview({ ...run, input: JSON.stringify(start(String(ambiguous.result.cursor))) });
    expect(event(resumed.result, "question")).toEqual(event(ambiguous.result, "question"));
  });

  it("fails closed for stale cursors, workspace writes, protocol errors, and secret-bearing results", async () => {
    const staleRun = await fixture();
    const started = await runHeadlessInterview({ ...staleRun, input: JSON.stringify(start()) });
    const stale = answer(event(started.result, "question"), "b".repeat(64), String(started.result.interviewId), "Brazil");
    const staleResult = await runHeadlessInterview({ ...staleRun, input: JSON.stringify(stale) });
    expect([staleResult.exitCode, staleResult.result.status, staleResult.result.diagnosticCode]).toEqual([2, "invalid", "cursor_mismatch"]);

    for (const [mode, diagnostic] of [["modify-workspace", "workspace_modified"], ["invalid-protocol", "adapter_protocol_invalid"], ["secret", "secret_detected"]] as const) {
      const hostile = await fixture(mode);
      const first = await runHeadlessInterview({ ...hostile, input: JSON.stringify(start()) });
      if (mode !== "secret") {
        expect([first.exitCode, first.result.diagnosticCode]).toEqual([70, diagnostic]);
        continue;
      }
      const secretResult = await runHeadlessInterview({
        ...hostile,
        input: JSON.stringify(answer(event(first.result, "question"), String(first.result.cursor), String(first.result.interviewId), "Brazil")),
      });
      expect([secretResult.exitCode, secretResult.result.diagnosticCode]).toEqual([70, diagnostic]);
      expect(JSON.stringify(secretResult.result)).not.toContain("SECRET_SENTINEL_INTERVIEW_12345");
    }
  });

  it("distributes discovery, validation, and execution through the bundled CLI", async () => {
    const run = await fixture();
    const version = await runBundled(["headless", "interview", "version"], "", run.workspace);
    expect([version.exitCode, version.result.contract, version.result.version]).toEqual([0, "rb-headless-interview/v1", "0.3.11"]);

    const validation = await runBundled(["headless", "interview", "validate"], JSON.stringify(start()), run.workspace);
    expect([validation.exitCode, validation.result.valid]).toEqual([0, true]);

    const started = await runBundled(["headless", "interview", "run", "--state", run.stateRoot], JSON.stringify(start()), run.workspace, {
      RB_HEADLESS_ADAPTER_COMMAND: process.execPath,
      RB_HEADLESS_ADAPTER_ARGS: JSON.stringify([adapterScript]),
      RB_HEADLESS_ADAPTER_ID: "fake-interview",
      RB_HEADLESS_ADAPTER_VERSION: "1",
      RB_HEADLESS_ADAPTER_PROVIDER: "test",
      RB_HEADLESS_ADAPTER_MODEL: "fake",
    });
    expect([started.exitCode, started.result.status, event(started.result, "question").questionId]).toEqual([0, "active", "deployment-region"]);
  });
});
