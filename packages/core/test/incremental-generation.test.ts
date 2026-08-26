import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HARNESS_BUDGET } from "../src/harness-budget.js";
import {
  DOCUMENT_PART_BEGIN,
  DOCUMENT_PART_END,
  DOCUMENT_PLAN_BEGIN,
  DOCUMENT_PLAN_END,
  assembleDocumentPlan,
  parseDocumentPart,
  parseDocumentPlan,
} from "../src/harness-incremental-documents.js";
import { requestDocumentBundle } from "../src/harness-generator.js";
import { successfulProviderLogStdout } from "../src/harness-control-formatter.js";
import { buildInputPackage } from "../src/harness-input-package.js";
import { inspectProjectInventory } from "../src/harness-inventory.js";
import { ProviderStreamObserver } from "../src/provider-events.js";
import type { HarnessRunState } from "../src/standalone-types.js";

const fixture = resolve(import.meta.dirname, "fixtures/standalone/incremental-provider.mjs");
const originalCalls = process.env.RB_HARNESS_TEST_INCREMENTAL_CALLS;
const originalFailure = process.env.RB_HARNESS_TEST_INCREMENTAL_FAIL_PART;
const originalExitPart = process.env.RB_HARNESS_TEST_INCREMENTAL_EXIT_PART;
const originalFormatFailures = process.env.RB_HARNESS_TEST_FORMAT_INVALID_ATTEMPTS;
const originalDocumentDependencies = process.env.RB_HARNESS_TEST_DOCUMENT_DEPENDENCIES;

afterEach(() => {
  if (originalCalls === undefined) delete process.env.RB_HARNESS_TEST_INCREMENTAL_CALLS;
  else process.env.RB_HARNESS_TEST_INCREMENTAL_CALLS = originalCalls;
  if (originalFailure === undefined) delete process.env.RB_HARNESS_TEST_INCREMENTAL_FAIL_PART;
  else process.env.RB_HARNESS_TEST_INCREMENTAL_FAIL_PART = originalFailure;
  if (originalExitPart === undefined) delete process.env.RB_HARNESS_TEST_INCREMENTAL_EXIT_PART;
  else process.env.RB_HARNESS_TEST_INCREMENTAL_EXIT_PART = originalExitPart;
  if (originalFormatFailures === undefined) delete process.env.RB_HARNESS_TEST_FORMAT_INVALID_ATTEMPTS;
  else process.env.RB_HARNESS_TEST_FORMAT_INVALID_ATTEMPTS = originalFormatFailures;
  if (originalDocumentDependencies === undefined) delete process.env.RB_HARNESS_TEST_DOCUMENT_DEPENDENCIES;
  else process.env.RB_HARNESS_TEST_DOCUMENT_DEPENDENCIES = originalDocumentDependencies;
});

function envelope(begin: string, end: string, value: unknown): string {
  return `${begin}\n${JSON.stringify(value)}\n${end}`;
}

function samplePlan() {
  return {
    contract: "rb-harness-document-plan/v1",
    status: "complete",
    summary: "Two bounded parts.",
    coordination: "RF-001 -> P01/T001.",
    documents: [{
      path: ".rb/init/PHASES.md",
      purpose: "Execution plan.",
      parts: [
        { id: "header", purpose: "Header." },
        { id: "phase-01", purpose: "First phase." },
      ],
    }],
    blocked: [],
  };
}

async function requestFixture(project: string, runRoot: string) {
  const inventory = await inspectProjectInventory(project, ".rb");
  const inputPackage = await buildInputPackage({
    workflow: "init",
    projectRoot: project,
    artifactDirectory: ".rb",
    request: "Create an incremental fixture.",
    inventory,
  });
  const now = new Date().toISOString();
  const state = {
    contract: "rb-harness-run/v1",
    id: "incremental-fixture",
    workflow: "init",
    status: "generating",
    projectRoot: project,
    artifactDirectory: ".rb",
    request: "Create an incremental fixture.",
    requestHash: "fixture",
    provider: { provider: "custom", model: "fixture", effort: "", command: fixture },
    answers: [],
    analysis: { contract: "rb-harness-interview/v1", status: "ready", summary: "ready", discoveries: [], assumptions: [], unresolved: [], answerReviews: [], questions: [] },
    inventory,
    createdAt: now,
    updatedAt: now,
  } as HarnessRunState;
  return requestDocumentBundle({
    state,
    inputPackage,
    runRoot,
    evidenceRoot: project,
    timeoutSeconds: 20,
    firstOutputTimeoutSeconds: 5,
  });
}

describe("incremental document contracts", () => {
  it("assembles ordered bounded parts into one normalized document", () => {
    const plan = parseDocumentPlan(envelope(DOCUMENT_PLAN_BEGIN, DOCUMENT_PLAN_END, samplePlan()));
    const first = parseDocumentPart(envelope(DOCUMENT_PART_BEGIN, DOCUMENT_PART_END, {
      contract: "rb-harness-document-part/v1", path: ".rb/init/PHASES.md", part: "header", content: "# Plan\n",
    }), { path: ".rb/init/PHASES.md", part: "header" });
    const second = parseDocumentPart(envelope(DOCUMENT_PART_BEGIN, DOCUMENT_PART_END, {
      contract: "rb-harness-document-part/v1", path: ".rb/init/PHASES.md", part: "phase-01", content: "\n## Phase 1\n",
    }), { path: ".rb/init/PHASES.md", part: "phase-01" });
    expect(assembleDocumentPlan(plan, [second, first]).documents[0]?.content).toBe("# Plan\n\n## Phase 1\n");
  });

  it("rejects unsafe paths, duplicate parts, and oversized part bodies", () => {
    expect(() => parseDocumentPlan(envelope(DOCUMENT_PLAN_BEGIN, DOCUMENT_PLAN_END, {
      ...samplePlan(), documents: [{ path: "src/app.ts", purpose: "bad", parts: [{ id: "x", purpose: "x" }] }],
    }))).toThrow("only under .rb");
    expect(() => parseDocumentPlan(envelope(DOCUMENT_PLAN_BEGIN, DOCUMENT_PLAN_END, {
      ...samplePlan(), documents: [{ path: ".rb/init/X.md", purpose: "x", parts: [{ id: "x", purpose: "x" }, { id: "x", purpose: "x" }] }],
    }))).toThrow("declares part x twice");
    expect(() => parseDocumentPlan(envelope(DOCUMENT_PLAN_BEGIN, DOCUMENT_PLAN_END, {
      ...samplePlan(), blocked: ["contradiction"],
    }))).toThrow("cannot retain blockers");
    expect(() => parseDocumentPart(envelope(DOCUMENT_PART_BEGIN, DOCUMENT_PART_END, {
      contract: "rb-harness-document-part/v1", path: ".rb/init/X.md", part: "x", content: "x".repeat(HARNESS_BUDGET.documents.maxPartBytes + 1),
      // The size defect names the observed bytes and the limit, because the
      // writer is asked to author the same span again rather than reformat it.
    }), { path: ".rb/init/X.md", part: "x" })).toThrow(/is \d+ bytes, above the \d+-byte limit/);
    const plan = parseDocumentPlan(envelope(DOCUMENT_PLAN_BEGIN, DOCUMENT_PLAN_END, samplePlan()));
    expect(() => assembleDocumentPlan(plan, [{
      contract: "rb-harness-document-part/v1", path: ".rb/init/OTHER.md", part: "x", content: "unexpected",
    }])).toThrow("unexpected part");
  });

  it("accepts a semantically useful purpose without asking a model to count field bytes", () => {
    const purpose = "Fase P03: " + "fronteira ".repeat(1_750);
    expect(Buffer.byteLength(purpose)).toBeGreaterThan(16 * 1024);
    const value = samplePlan();
    value.documents[0]!.parts[0]!.purpose = purpose;
    const plan = parseDocumentPlan(envelope(DOCUMENT_PLAN_BEGIN, DOCUMENT_PLAN_END, value));
    expect(plan.documents[0]!.parts[0]!.purpose).toBe(purpose.trim());
  });

  it("rejects every unknown authority field instead of guessing provider-specific exceptions", () => {
    const prefixed = samplePlan();
    prefixed.documents[0] = { ...prefixed.documents[0]!, prefix: "execution plan" } as typeof prefixed.documents[number];
    expect(() => parseDocumentPlan(envelope(DOCUMENT_PLAN_BEGIN, DOCUMENT_PLAN_END, prefixed)))
      .toThrow("unsupported planned document field: prefix");
    expect(() => parseDocumentPlan(envelope(DOCUMENT_PLAN_BEGIN, DOCUMENT_PLAN_END, {
      ...samplePlan(),
      documents: [{ ...samplePlan().documents[0], outputPath: "/tmp/redirect" }],
    }))).toThrow("unsupported planned document field: outputPath");
  });

  it("derives and topologically orders load-bearing document dependencies", () => {
    const value = samplePlan();
    value.documents = [
      { path: ".rb/init/OPERATIONS.json", purpose: "Operations", parts: [{ id: "whole", purpose: "Whole" }] },
      { path: ".rb/init/PHASES.md", purpose: "Execution", parts: [{ id: "whole", purpose: "Whole" }] },
      { path: ".rb/init/PROJECT.md", purpose: "Intent", parts: [{ id: "whole", purpose: "Whole" }] },
    ];
    const plan = parseDocumentPlan(envelope(DOCUMENT_PLAN_BEGIN, DOCUMENT_PLAN_END, value));
    expect(plan.documents.map((document) => document.path)).toEqual([
      ".rb/init/PROJECT.md",
      ".rb/init/PHASES.md",
      ".rb/init/OPERATIONS.json",
    ]);
    expect(plan.documents[1]?.dependsOn).toContain(".rb/init/PROJECT.md");
    expect(plan.documents[2]?.dependsOn).toEqual([".rb/init/PHASES.md"]);
  });

  it("rejects missing and cyclic document dependencies as substance defects", () => {
    expect(() => parseDocumentPlan(envelope(DOCUMENT_PLAN_BEGIN, DOCUMENT_PLAN_END, {
      ...samplePlan(),
      documents: [{ ...samplePlan().documents[0], dependsOn: [".rb/init/MISSING.md"] }],
    }))).toThrow("depends on missing document");
    expect(() => parseDocumentPlan(envelope(DOCUMENT_PLAN_BEGIN, DOCUMENT_PLAN_END, {
      ...samplePlan(),
      documents: [
        { path: ".rb/init/A.md", purpose: "A", dependsOn: [".rb/init/B.md"], parts: [{ id: "a", purpose: "A" }] },
        { path: ".rb/init/B.md", purpose: "B", dependsOn: [".rb/init/A.md"], parts: [{ id: "b", purpose: "B" }] },
      ],
    }))).toThrow("dependency graph contains a cycle");
  });

  it("preserves a document part whose JSON string contains literal streamed line breaks", () => {
    const malformedByStrictJson = [
      DOCUMENT_PART_BEGIN,
      '{"contract":"rb-harness-document-part/v1","path":".rb/init/PHASES.md","part":"phase-01","content":"',
      "## Phase 1\n\n- first line\n- second line",
      '"}',
      DOCUMENT_PART_END,
    ].join("\n");
    const part = parseDocumentPart(malformedByStrictJson, { path: ".rb/init/PHASES.md", part: "phase-01" });
    expect(part.content).toBe("\n## Phase 1\n\n- first line\n- second line\n");
  });
});

describe("provider-neutral incremental authoring", () => {
  it("authors and assembles documents over independent custom-adapter calls", async () => {
    await chmod(fixture, 0o755);
    const project = await mkdtemp(resolve(tmpdir(), "rb-incremental-project-"));
    const runRoot = resolve(project, ".rb-harness/runs/test");
    const calls = resolve(await mkdtemp(resolve(tmpdir(), "rb-incremental-calls-")), "calls.log");
    process.env.RB_HARNESS_TEST_INCREMENTAL_CALLS = calls;
    await writeFile(resolve(project, "README.md"), "fixture\n", "utf8");
    const bundle = await requestFixture(project, runRoot);
    expect(bundle.documents.map((document) => document.path)).toEqual([".rb/init/PHASES.md", ".rb/init/PROJECT.md"]);
    expect(bundle.documents.find((document) => document.path.endsWith("PHASES.md"))?.content)
      .toContain("## Phase 1: Deliver incrementally");
    expect((await readFile(calls, "utf8")).trim().split("\n")).toEqual([
      "plan",
      ".rb/init/PROJECT.md#whole",
      ".rb/init/PHASES.md#header",
      ".rb/init/PHASES.md#phase-01",
    ]);
  }, 60_000);

  it("authors OPERATIONS only after PHASES and passes its finalized execution projection", async () => {
    await chmod(fixture, 0o755);
    const project = await mkdtemp(resolve(tmpdir(), "rb-incremental-dependencies-"));
    const runRoot = resolve(project, ".rb-harness/runs/test");
    const calls = resolve(await mkdtemp(resolve(tmpdir(), "rb-incremental-dependency-calls-")), "calls.log");
    process.env.RB_HARNESS_TEST_INCREMENTAL_CALLS = calls;
    process.env.RB_HARNESS_TEST_DOCUMENT_DEPENDENCIES = "1";
    await writeFile(resolve(project, "README.md"), "fixture\n", "utf8");
    const bundle = await requestFixture(project, runRoot);
    expect(bundle.documents.find((document) => document.path.endsWith("OPERATIONS.json"))?.content)
      .toContain('"path": "src/index.js"');
    expect((await readFile(calls, "utf8")).trim().split("\n")).toEqual([
      "plan",
      ".rb/init/PROJECT.md#whole",
      ".rb/init/PHASES.md#header",
      ".rb/init/PHASES.md#phase-01",
      ".rb/init/OPERATIONS.json#whole",
    ]);
  }, 60_000);

  it("resumes at the failed part without regenerating completed paid work", async () => {
    await chmod(fixture, 0o755);
    const project = await mkdtemp(resolve(tmpdir(), "rb-incremental-resume-"));
    const runRoot = resolve(project, ".rb-harness/runs/test");
    const calls = resolve(await mkdtemp(resolve(tmpdir(), "rb-incremental-resume-calls-")), "calls.log");
    process.env.RB_HARNESS_TEST_INCREMENTAL_CALLS = calls;
    process.env.RB_HARNESS_TEST_INCREMENTAL_EXIT_PART = "phase-01";
    await writeFile(resolve(project, "README.md"), "fixture\n", "utf8");
    await expect(requestFixture(project, runRoot)).rejects.toThrow("exited with code 1");
    delete process.env.RB_HARNESS_TEST_INCREMENTAL_EXIT_PART;
    const bundle = await requestFixture(project, runRoot);
    expect(bundle.documents).toHaveLength(2);
    expect((await readFile(calls, "utf8")).trim().split("\n")).toEqual([
      "plan",
      ".rb/init/PROJECT.md#whole",
      ".rb/init/PHASES.md#header",
      ".rb/init/PHASES.md#phase-01",
      ".rb/init/PHASES.md#phase-01",
    ]);
  }, 60_000);

  it("recovers a completed malformed-JSON part from its paid log before spawning a provider", async () => {
    await chmod(fixture, 0o755);
    const project = await mkdtemp(resolve(tmpdir(), "rb-incremental-log-recovery-"));
    const runRoot = resolve(project, ".rb-harness/runs/test");
    const calls = resolve(await mkdtemp(resolve(tmpdir(), "rb-incremental-log-calls-")), "calls.log");
    process.env.RB_HARNESS_TEST_INCREMENTAL_CALLS = calls;
    process.env.RB_HARNESS_TEST_INCREMENTAL_EXIT_PART = "phase-01";
    await writeFile(resolve(project, "README.md"), "fixture\n", "utf8");
    await expect(requestFixture(project, runRoot)).rejects.toThrow("exited with code 1");
    delete process.env.RB_HARNESS_TEST_INCREMENTAL_EXIT_PART;
    const malformed = [
      "exit_code=0",
      "",
      "--- stdout ---",
      DOCUMENT_PART_BEGIN,
      '{"contract":"rb-harness-document-part/v1","path":".rb/init/PHASES.md","part":"phase-01","content":"',
      "## Phase 1: recovered\n\nRecovered without another call.",
      '"}',
      DOCUMENT_PART_END,
      "",
      "--- stderr ---",
      "",
    ].join("\n");
    await writeFile(resolve(runRoot, "logs/generation-document-002-part-002.log"), malformed, "utf8");
    const bundle = await requestFixture(project, runRoot);
    expect(bundle.documents.find((document) => document.path.endsWith("PHASES.md"))?.content).toContain("Recovered without another call");
    expect((await readFile(calls, "utf8")).trim().split("\n")).toEqual([
      "plan",
      ".rb/init/PROJECT.md#whole",
      ".rb/init/PHASES.md#header",
      ".rb/init/PHASES.md#phase-01",
    ]);
  }, 60_000);

  it("formats a malformed legacy part envelope without regenerating its semantic content", async () => {
    await chmod(fixture, 0o755);
    const project = await mkdtemp(resolve(tmpdir(), "rb-incremental-part-format-"));
    const runRoot = resolve(project, ".rb-harness/runs/test");
    const calls = resolve(await mkdtemp(resolve(tmpdir(), "rb-incremental-part-format-calls-")), "calls.log");
    process.env.RB_HARNESS_TEST_INCREMENTAL_CALLS = calls;
    process.env.RB_HARNESS_TEST_INCREMENTAL_FAIL_PART = "phase-01";
    await writeFile(resolve(project, "README.md"), "fixture\n", "utf8");

    const bundle = await requestFixture(project, runRoot);
    expect(bundle.documents.find((document) => document.path.endsWith("PHASES.md"))?.content)
      .toContain('Recovered "quoted" content.');
    expect((await readFile(calls, "utf8")).trim().split("\n")).toEqual([
      "plan",
      ".rb/init/PROJECT.md#whole",
      ".rb/init/PHASES.md#header",
      ".rb/init/PHASES.md#phase-01",
      "format",
    ]);
  }, 60_000);

  it("recovers a completed compatible plan from its paid log before spawning a provider", async () => {
    await chmod(fixture, 0o755);
    const project = await mkdtemp(resolve(tmpdir(), "rb-incremental-plan-log-recovery-"));
    const runRoot = resolve(project, ".rb-harness/runs/test");
    const calls = resolve(await mkdtemp(resolve(tmpdir(), "rb-incremental-plan-log-calls-")), "calls.log");
    process.env.RB_HARNESS_TEST_INCREMENTAL_CALLS = calls;
    await writeFile(resolve(project, "README.md"), "fixture\n", "utf8");
    await mkdir(resolve(runRoot, "logs"), { recursive: true });
    const prefixed = samplePlan();
    prefixed.documents[0] = { ...prefixed.documents[0]!, prefix: "execution plan" } as typeof prefixed.documents[number];
    await writeFile(resolve(runRoot, "logs/generation-plan.log"), [
      "exit_code=0",
      "",
      "--- stdout ---",
      envelope(DOCUMENT_PLAN_BEGIN, DOCUMENT_PLAN_END, prefixed),
      "",
      "--- stderr ---",
      "",
    ].join("\n"), { encoding: "utf8", mode: 0o600 });

    const bundle = await requestFixture(project, runRoot);
    expect(bundle.documents).toHaveLength(1);
    expect((await readFile(calls, "utf8")).trim().split("\n")).toEqual([
      "format",
      ".rb/init/PHASES.md#header",
      ".rb/init/PHASES.md#phase-01",
    ]);
  }, 60_000);

  it("keeps the semantic plan immutable and allows exactly three closed formatter attempts", async () => {
    await chmod(fixture, 0o755);
    const project = await mkdtemp(resolve(tmpdir(), "rb-incremental-format-retry-"));
    const runRoot = resolve(project, ".rb-harness/runs/test");
    const calls = resolve(await mkdtemp(resolve(tmpdir(), "rb-incremental-format-calls-")), "calls.log");
    process.env.RB_HARNESS_TEST_INCREMENTAL_CALLS = calls;
    process.env.RB_HARNESS_TEST_FORMAT_INVALID_ATTEMPTS = "2";
    await writeFile(resolve(project, "README.md"), "fixture\n", "utf8");
    await mkdir(resolve(runRoot, "logs"), { recursive: true });
    const prefixed = samplePlan();
    prefixed.documents[0] = { ...prefixed.documents[0]!, prefix: "execution plan" } as typeof prefixed.documents[number];
    await writeFile(resolve(runRoot, "logs/generation-plan.log"), [
      "exit_code=0", "", "--- stdout ---",
      envelope(DOCUMENT_PLAN_BEGIN, DOCUMENT_PLAN_END, prefixed),
      "", "--- stderr ---", "",
    ].join("\n"), { encoding: "utf8", mode: 0o600 });

    const bundle = await requestFixture(project, runRoot);
    expect(bundle.documents).toHaveLength(1);
    expect((await readFile(calls, "utf8")).trim().split("\n")).toEqual([
      "format", "format", "format",
      ".rb/init/PHASES.md#header",
      ".rb/init/PHASES.md#phase-01",
    ]);
  }, 60_000);

  it("fails after three invalid formatter responses without repeating semantic generation", async () => {
    await chmod(fixture, 0o755);
    const project = await mkdtemp(resolve(tmpdir(), "rb-incremental-format-ceiling-"));
    const runRoot = resolve(project, ".rb-harness/runs/test");
    const calls = resolve(await mkdtemp(resolve(tmpdir(), "rb-incremental-format-ceiling-calls-")), "calls.log");
    process.env.RB_HARNESS_TEST_INCREMENTAL_CALLS = calls;
    process.env.RB_HARNESS_TEST_FORMAT_INVALID_ATTEMPTS = "3";
    await writeFile(resolve(project, "README.md"), "fixture\n", "utf8");
    await mkdir(resolve(runRoot, "logs"), { recursive: true });
    const prefixed = samplePlan();
    prefixed.documents[0] = { ...prefixed.documents[0]!, prefix: "execution plan" } as typeof prefixed.documents[number];
    await writeFile(resolve(runRoot, "logs/generation-plan.log"), [
      "exit_code=0", "", "--- stdout ---",
      envelope(DOCUMENT_PLAN_BEGIN, DOCUMENT_PLAN_END, prefixed),
      "", "--- stderr ---", "",
    ].join("\n"), { encoding: "utf8", mode: 0o600 });

    await expect(requestFixture(project, runRoot)).rejects.toThrow("after 3 attempts");
    expect((await readFile(calls, "utf8")).trim().split("\n")).toEqual(["format", "format", "format"]);
  }, 60_000);
});

describe("OpenCode 1.18 event transport", () => {
  it("reconstructs a successful JSONL provider log before formatter recovery", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "rb-opencode-log-recovery-"));
    const log = resolve(directory, "provider.log");
    const answer = `${DOCUMENT_PLAN_BEGIN}\n${JSON.stringify(samplePlan())}\n${DOCUMENT_PLAN_END}`;
    await writeFile(log, [
      "provider=opencode",
      "exit_code=0",
      "stdout_transport=jsonl-events",
      "stream_mode=structured",
      "",
      "--- stdout ---",
      JSON.stringify({ type: "text", part: { type: "text", text: answer } }),
      "",
      "--- stderr ---",
      "",
    ].join("\n"), "utf8");
    expect(await successfulProviderLogStdout(log)).toBe(`${answer}\n`);
  });

  it("recovers only the text part and measures the real terminal event", () => {
    const observer = new ProviderStreamObserver({ mode: "structured", dialect: "opencode" });
    observer.push(`${JSON.stringify({ type: "step_start", part: { type: "step-start" } })}\n`);
    observer.push(`${JSON.stringify({ type: "text", part: { type: "text", text: "ENVELOPE" } })}\n`);
    expect(observer.push(`${JSON.stringify({ type: "step_finish", part: {
      type: "step-finish", reason: "stop", tokens: { total: 12, input: 5, output: 3, reasoning: 4, cache: { read: 0 } }, cost: 0.01,
    } })}\n`)).toBeUndefined();
    expect(observer.recoveredText()).toBe("ENVELOPE\n");
    expect(observer.report()).toMatchObject({
      turnEvents: 1, requests: 1, stopReason: "stop", totalTokens: 12, reasoningTokens: 4, costUsd: 0.01,
    });
  });

  it("stops once on length instead of feeding accounting noise to the envelope parser", () => {
    const observer = new ProviderStreamObserver({ mode: "structured", dialect: "opencode" });
    const breach = observer.push(`${JSON.stringify({ type: "step_finish", part: {
      type: "step-finish", reason: "length", tokens: { total: 45184, input: 13184, output: 0, reasoning: 32000, cache: { read: 0 } }, cost: 0.07,
    } })}\n`);
    expect(breach).toMatchObject({ code: "output-limit" });
    expect(breach?.message).toContain("reasoning tokens=32000");
    expect(observer.recoveredText()).toBe("");
  });
});
