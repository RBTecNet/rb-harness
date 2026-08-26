import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HARNESS_BUDGET, interviewQuestionBudget } from "../src/harness-budget.js";
import {
  HARNESS_CONTRACT_DIGEST_VERSION,
  generationContractDigest,
  interviewContractDigest,
  interviewRoundDirective,
  repairContractDigest,
  workflowSupportsOperations,
} from "../src/harness-contract-digest.js";
import {
  DOCUMENT_BUNDLE_BEGIN,
  DOCUMENT_BUNDLE_END,
  materializeDocuments,
  mergeDocumentBundles,
  normalizeGeneratedArtifactContent,
  parseDocumentBundle,
} from "../src/harness-documents.js";
import { validateExecutionMarkdown } from "../src/execution-contract.js";
import { validateOperationalJson } from "../src/operational-contract.js";
import {
  buildInputPackage,
  serializeInputPackage,
  stableJson,
} from "../src/harness-input-package.js";
import { inspectProjectInventory } from "../src/harness-inventory.js";
import {
  HarnessTelemetry,
  addUsage,
  emptyUsage,
  formatTelemetryReport,
} from "../src/harness-telemetry.js";
import { stageForStatus, stageState } from "../src/harness-dashboard.js";
import { harnessLockDisposition } from "../src/harness-state.js";
import { buildInterviewPrompt } from "../src/harness-interview.js";
import { buildGenerationPrompt } from "../src/harness-generator.js";
import { loadWorkflowResources } from "../src/standalone-resources.js";
import type { HarnessRunState, HarnessWorkflow } from "../src/standalone-types.js";

const WORKFLOWS: HarnessWorkflow[] = ["init", "ai-context", "plan", "evolve", "review"];

function envelope(value: unknown): string {
  return `${DOCUMENT_BUNDLE_BEGIN}\n${JSON.stringify(value)}\n${DOCUMENT_BUNDLE_END}`;
}

describe("operational budget", () => {
  it("keeps the adaptive interview finite behind declared safety ceilings", () => {
    // The interview converges rather than expiring, so the ceilings only have
    // to keep the state machine finite — they are never the stopping point.
    expect(HARNESS_BUDGET.interview.maxRounds).toBeGreaterThan(2);
    expect(Number.isFinite(HARNESS_BUDGET.interview.maxRounds)).toBe(true);
    expect(Number.isFinite(HARNESS_BUDGET.interview.maxQuestions)).toBe(true);
    expect(HARNESS_BUDGET.interview.maxQuestions).toBeGreaterThanOrEqual(
      HARNESS_BUDGET.interview.firstRoundQuestions
      + (HARNESS_BUDGET.interview.maxRounds - 1) * HARNESS_BUDGET.interview.followUpQuestions,
    );
    expect(interviewQuestionBudget(1)).toBe(5);
    expect(interviewQuestionBudget(2)).toBe(3);
    expect(interviewQuestionBudget(HARNESS_BUDGET.interview.maxRounds)).toBe(3);
    expect(HARNESS_BUDGET.formatting.maxAttempts).toBe(3);
    // A part must fit a provider's output window; the ceiling is generous
    // enough for a real phase and still bounded, so a truncated segment cannot
    // reach assembly.
    expect(HARNESS_BUDGET.documents.maxPartBytes).toBeGreaterThanOrEqual(48 * 1024);
    expect(HARNESS_BUDGET.documents.maxPartBytes).toBeLessThanOrEqual(HARNESS_BUDGET.documents.maxDocumentBytes);
    expect(HARNESS_BUDGET.documents.maxPartEnvelopeBytes).toBeGreaterThan(HARNESS_BUDGET.documents.maxPartBytes);
    expect(HARNESS_BUDGET.generation.structuralRepairs).toBe(3);
  });

  it("bounds the documentation tool surface", () => {
    expect(HARNESS_BUDGET.tools.maxCalls).toBeLessThanOrEqual(64);
    expect(HARNESS_BUDGET.tools.maxReadLines).toBeLessThanOrEqual(1000);
    expect(HARNESS_BUDGET.tools.repeatCallLimit).toBeGreaterThanOrEqual(2);
  });
});

describe("compact contract digest", () => {
  it("never contradicts incremental planning with the retired complete-bundle instruction", async () => {
    for (const workflow of WORKFLOWS) {
      const resources = await loadWorkflowResources(workflow, { section: "generation" });
      const normalized = resources.replace(/\s+/g, " ");
      expect(normalized).toContain("return only the compact document plan");
      expect(normalized).toContain("without document content");
      expect(resources).not.toContain("Return every document as a");
      expect(resources).not.toContain("after your call; produce documents");
    }
  });

  it("stays byte-stable and inside its declared ceiling for every workflow", () => {
    for (const workflow of WORKFLOWS) {
      const digest = generationContractDigest(workflow);
      expect(digest).toBe(generationContractDigest(workflow));
      expect(digest).toContain(HARNESS_CONTRACT_DIGEST_VERSION);
      expect(digest).toContain("rb-execution/v1");
      expect(Buffer.byteLength(digest)).toBeLessThanOrEqual(HARNESS_BUDGET.prompt.maxContractDigestBytes);
      expect(digest.includes("rb-operational/v1 — OPERATIONS.json shape"))
        .toBe(workflowSupportsOperations(workflow));
    }
  });

  it("tells the model that the manifest and hashes are code-owned", () => {
    const digest = generationContractDigest("plan");
    expect(digest).toContain(".rb/rb-manifest.json");
    expect(digest).toContain("generated after your call");
    expect(digest).toContain("Do not compute, restate");
  });

  it("states the exact phase/task dependency split and HTTP probe assertion shape", () => {
    const digest = generationContractDigest("init");
    expect(digest).toContain("task `Depends on` field contains only earlier `T###` task IDs, never a `P##`");
    expect(digest).toContain("Never restart at `T001` in a later phase");
    expect(digest).toContain('"status": 200, "bodyIncludes": ["expected text"]');
    expect(digest).toContain("Never put an `expect` object inside `ready`, `checks`, or another probe");
    expect(digest).toContain("Never copy a vague source phrase such as `when applicable` or `quando aplicável` into acceptance");
    expect(digest).toContain("Visual acceptance is stricter");
    expect(digest).toContain("HUMAN_PENDING");
    expect(digest).toContain("durable screenshot");
    expect(digest).toContain("geometry/computed-style measurements");
    expect(digest).toContain("state left after the complete Validation list");
    expect(digest).toContain("name every module path in backticks");
    expect(digest).toContain("A first import in a later phase is non-convergent");
    expect(digest).toContain("never invent a sentinel file");
  });

  it("declares the remaining interview budget in each round", () => {
    expect(interviewRoundDirective(1)).toContain("at most 5 question(s)");
    expect(interviewRoundDirective(1)).toContain("adaptive");
    expect(interviewRoundDirective(1)).toContain("Safety ceilings, not a target");
    expect(interviewRoundDirective(2)).toContain("at most 3 question(s)");
    expect(interviewRoundDirective(2)).not.toContain("final round");
    // The ceiling still announces itself, so a converging model is never
    // surprised by a round that turns out to be its last.
    const last = interviewRoundDirective(HARNESS_BUDGET.interview.maxRounds);
    expect(last).toContain("final round");
    expect(interviewRoundDirective(3, HARNESS_BUDGET.interview.maxQuestions - 1)).toContain("final round");
    // The digest itself is round-independent so it can stay in the invariant
    // prompt prefix.
    expect(interviewContractDigest("plan")).toBe(interviewContractDigest("plan"));
    expect(interviewContractDigest("plan")).not.toMatch(/round \d/i);
  });

  it("keeps the repair pass mechanical and localized", () => {
    const digest = repairContractDigest("plan");
    expect(digest).toContain("Never replan a document no error names");
    expect(digest).toContain("byte for byte");
    expect(digest).toContain("Do not reopen the interview");
    // Parts overwrite the whole file, so a repair that emits only the corrected
    // fragment deletes the rest of the document. The contract has to say so.
    expect(digest).toContain("replaced in full");
    expect(digest).toContain("re-emit the complete corrected document");
  });
});

describe("deterministic input package", () => {
  it("excludes version control, dependencies, build output, and secrets", async () => {
    const project = await mkdtemp(resolve(tmpdir(), "rb-input-package-"));
    for (const directory of [".git", "node_modules/left-pad", "dist", "coverage", ".rb-harness/runs", "src"]) {
      await mkdir(resolve(project, directory), { recursive: true });
    }
    await writeFile(resolve(project, "src/app.ts"), "export const app = 1;\n", "utf8");
    await writeFile(resolve(project, ".git/config"), "[core]\n", "utf8");
    await writeFile(resolve(project, "node_modules/left-pad/index.js"), "module.exports = 1;\n", "utf8");
    await writeFile(resolve(project, "dist/bundle.js"), "1\n", "utf8");
    await writeFile(resolve(project, "coverage/lcov.info"), "TN:\n", "utf8");
    await writeFile(resolve(project, ".rb-harness/runs/state.json"), "{}\n", "utf8");
    await writeFile(resolve(project, ".env"), "TOKEN=abc\n", "utf8");
    await writeFile(resolve(project, "id_rsa"), "PRIVATE\n", "utf8");
    await writeFile(resolve(project, "package-lock.json"), "{}\n", "utf8");
    await writeFile(resolve(project, "package.json"), '{"name":"fixture","version":"1.0.0","scripts":{"test":"vitest"}}\n', "utf8");

    const inputPackage = await buildInputPackage({
      workflow: "ai-context",
      projectRoot: project,
      artifactDirectory: ".rb",
      request: "Document the project.",
      inventory: await inspectProjectInventory(project, ".rb"),
    });
    const serialized = serializeInputPackage(inputPackage);
    for (const forbidden of [".git", "node_modules", "dist/", "coverage", ".rb-harness", ".env", "id_rsa", "package-lock.json"]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(serialized).toContain("src");
    expect(serialized).toContain("app.ts");
    expect(inputPackage.project.signals.find((signal) => signal.path === "package.json")?.summary)
      .toContain("scripts=[test]");
    expect(inputPackage.request.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("serializes deterministically and stays inside the package ceiling", async () => {
    const project = await mkdtemp(resolve(tmpdir(), "rb-input-package-stable-"));
    await mkdir(resolve(project, "src"), { recursive: true });
    for (let index = 0; index < 40; index += 1) {
      await mkdir(resolve(project, `src/module-${index}`), { recursive: true });
      for (let file = 0; file < 20; file += 1) {
        await writeFile(resolve(project, `src/module-${index}/file-${file}.ts`), "x".repeat(200), "utf8");
      }
    }
    const options = {
      workflow: "plan" as const,
      projectRoot: project,
      artifactDirectory: ".rb",
      request: "Plan something.",
      inventory: await inspectProjectInventory(project, ".rb"),
    };
    const first = serializeInputPackage(await buildInputPackage(options));
    const second = serializeInputPackage(await buildInputPackage(options));
    expect(first).toBe(second);
    expect(Buffer.byteLength(first)).toBeLessThanOrEqual(HARNESS_BUDGET.inventory.maxPackageBytes);
    expect(first).toContain('"truncated":true');
  });

  it("sorts object properties so a cached prefix stays byte-identical", () => {
    expect(stableJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } }))
      .toBe('{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}');
  });
});

describe("document bundle", () => {
  it("accepts a fenced envelope inside surrounding prose", () => {
    const bundle = parseDocumentBundle([
      "Here is the result:",
      DOCUMENT_BUNDLE_BEGIN,
      "```json",
      JSON.stringify({
        contract: "rb-harness-documents/v1",
        status: "complete",
        summary: "done",
        documents: [{ path: ".rb/init/PROJECT.md", content: "# Project" }],
      }),
      "```",
      DOCUMENT_BUNDLE_END,
      "Let me know if you need changes.",
    ].join("\n"));
    expect(bundle.documents[0]?.content).toBe("# Project\n");
  });

  it("distinguishes a truncated envelope from a missing one", () => {
    expect(() => parseDocumentBundle(`${DOCUMENT_BUNDLE_BEGIN}\n{"contract":"rb-harness`))
      .toThrow("truncated");
    expect(() => parseDocumentBundle("I had a look and everything is fine."))
      .toThrow("does not contain");
  });

  it("refuses unsafe, escaping, and code-owned paths", () => {
    const reject = (path: string, message: string) => expect(() => parseDocumentBundle(envelope({
      contract: "rb-harness-documents/v1",
      status: "complete",
      summary: "s",
      documents: [{ path, content: "x" }],
    }))).toThrow(message);
    reject("/etc/passwd", "project-relative");
    reject(".rb/../../escape.md", "relative segments");
    reject("src/app.ts", "only under .rb/");
    reject(".rb/rb-manifest.json", "generated by the orchestrator");
    reject(".rb/runs/live/state.json", "control-plane state");
    reject("AGENTS.md", "only under .rb/");
  });

  it("requires a named decision for a blocked bundle", () => {
    expect(() => parseDocumentBundle(envelope({
      contract: "rb-harness-documents/v1", status: "blocked", summary: "cannot continue", documents: [],
    }))).toThrow("must name the missing decision");
    expect(parseDocumentBundle(envelope({
      contract: "rb-harness-documents/v1",
      status: "blocked",
      summary: "cannot continue",
      documents: [],
      blocked: ["Which retention window applies?"],
    })).blocked).toEqual(["Which retention window applies?"]);
  });

  it("merges a repair over the authored bundle without touching other documents", () => {
    const base = parseDocumentBundle(envelope({
      contract: "rb-harness-documents/v1",
      status: "complete",
      summary: "first",
      documents: [
        { path: ".rb/features/x/SPEC.md", content: "spec" },
        { path: ".rb/features/x/PHASES.md", content: "broken" },
      ],
    }));
    const repair = parseDocumentBundle(envelope({
      contract: "rb-harness-documents/v1",
      status: "complete",
      summary: "repaired",
      documents: [
        { path: ".rb/features/x/PHASES.md", content: "fixed" },
        { path: ".rb/features/x/PLAN.md", content: "added" },
      ],
    }));
    const merged = mergeDocumentBundles(base, repair);
    expect(merged.documents.map((document) => document.path)).toEqual([
      ".rb/features/x/PHASES.md", ".rb/features/x/PLAN.md", ".rb/features/x/SPEC.md",
    ]);
    expect(merged.documents.find((document) => document.path.endsWith("SPEC.md"))?.content).toBe("spec\n");
    expect(merged.documents.find((document) => document.path.endsWith("PHASES.md"))?.content).toBe("fixed\n");
  });

  it("materializes nested paths and normalizes line endings", async () => {
    const staging = await mkdtemp(resolve(tmpdir(), "rb-materialize-"));
    const bundle = parseDocumentBundle(envelope({
      contract: "rb-harness-documents/v1",
      status: "complete",
      summary: "s",
      documents: [{ path: ".rb/reviews/2026-01/FINDINGS.md", content: "# Findings\r\n\r\nOne." }],
    }));
    expect(bundle.documents[0]?.content).toBe("# Findings\n\nOne.\n");
    expect(await materializeDocuments(staging, bundle)).toEqual([".rb/reviews/2026-01/FINDINGS.md"]);
  });

  it("canonicalizes legacy probe assertions into strict rb-operational/v1", () => {
    const source = JSON.stringify({
      contract: "rb-operational/v1",
      scenarios: [{ id: "serve", title: "serve", steps: [{
        id: "process", kind: "process", command: { argv: ["npm", "start"] },
        ready: { kind: "http", url: "http://127.0.0.1:3000/", expect: { statusCode: 200 } },
        checks: [{ kind: "http", url: "http://127.0.0.1:3000/", expect: { statusCode: 200, bodyIncludes: ["Cron Facility"] } }],
      }] }],
    });
    const normalized = normalizeGeneratedArtifactContent(".rb/init/OPERATIONS.json", source);
    expect(validateOperationalJson(normalized).issues).toEqual([]);
    expect(normalized).not.toContain('"expect"');
    expect(normalized).toContain('"status": 200');
    expect(normalized).toContain('"bodyIncludes"');
  });

  it("removes only redundant phase IDs from task dependencies and keeps rb-execution/v1 strict", async () => {
    const source = await readFile(resolve(process.cwd(), "../../tests/fixtures/execution/valid/multiple/PHASES.md"), "utf8");
    const invalid = source.replace("  - **Depends on:** T001", "  - **Depends on:** P01");
    expect(validateExecutionMarkdown(invalid).issues.map((issue) => issue.code)).toContain("task.dependency.invalid");
    const normalized = normalizeGeneratedArtifactContent(".rb/init/PHASES.md", invalid);
    expect(validateExecutionMarkdown(normalized).issues).toEqual([]);
    expect(normalized).toContain("**Depends on:** P01");
    expect(normalized).toContain("  - **Depends on:** none");
  });
});

describe("documentation telemetry", () => {
  it("banks duration per stage and reports provider calls", () => {
    const telemetry = new HarnessTelemetry();
    telemetry.beginStage("inventory");
    telemetry.beginStage("gap-analysis");
    telemetry.recordProviderCall({
      stage: "gap-analysis",
      provider: "deepseek",
      model: "deepseek-v4-pro",
      attempt: 1,
      startedAt: new Date().toISOString(),
      durationMilliseconds: 1200,
      exitCode: 0,
      outputBytes: 4096,
      usage: { ...emptyUsage(), measured: true, requests: 2, inputTokens: 900, cachedInputTokens: 700, outputTokens: 100, totalTokens: 1000 },
    });
    telemetry.beginStage("publication");
    const report = telemetry.report();
    expect(report.stages.map((stage) => stage.stage)).toEqual(["inventory", "gap-analysis", "publication"]);
    expect(report.totals.providerCalls).toBe(1);
    expect(report.totals.cachedInputTokens).toBe(700);
    expect(formatTelemetryReport(report)).toContain("em cache=700");
  });

  it("never invents a token count for an unmeasured provider", () => {
    const telemetry = new HarnessTelemetry();
    telemetry.beginStage("generation");
    telemetry.recordProviderCall({
      stage: "generation",
      provider: "codex",
      model: "gpt-5.6-sol",
      attempt: 1,
      startedAt: new Date().toISOString(),
      durationMilliseconds: 500,
      exitCode: 0,
      outputBytes: 100,
      usage: emptyUsage(),
    });
    expect(formatTelemetryReport(telemetry.report())).toContain("não medidos");
  });

  it("adds usage without losing the measured flag", () => {
    const total = emptyUsage();
    addUsage(total, { ...emptyUsage(), measured: true, totalTokens: 10 });
    addUsage(total, { ...emptyUsage(), totalTokens: 5 });
    expect(total).toMatchObject({ measured: true, totalTokens: 15 });
  });
});

describe("documentation pipeline display", () => {
  it("maps every run status to a documentation stage", () => {
    expect(stageForStatus("inventory")).toBe("inventory");
    expect(stageForStatus("interview")).toBe("gap-analysis");
    expect(stageForStatus("generating")).toBe("generation");
    expect(stageForStatus("materializing")).toBe("materialization");
    expect(stageForStatus("repairing")).toBe("structural-repair");
    expect(stageForStatus("auditing")).toBe("validation");
    expect(stageForStatus("publishing")).toBe("publication");
  });

  it("advances the visible pipeline and marks the failed stage", () => {
    expect(stageState("generating", "generation", "inventory")).toBe("done");
    expect(stageState("generating", "generation", "generation")).toBe("run");
    expect(stageState("generating", "generation", "publication")).toBe("wait");
    expect(stageState("generation-failed", "generation", "generation")).toBe("fail");
    // Evidence discovery is owned by the generation step of the pipeline.
    expect(stageState("generating", "evidence", "generation")).toBe("run");
    expect(stageState("complete", "publication", "inventory")).toBe("done");
  });
});


describe("bounded prompts", () => {
  it("keeps the interview and generation prompts inside their declared byte ceilings", async () => {
    const project = await mkdtemp(resolve(tmpdir(), "rb-prompt-budget-"));
    await mkdir(resolve(project, "src"), { recursive: true });
    for (let index = 0; index < 30; index += 1) {
      await writeFile(resolve(project, `src/module-${index}.ts`), "x".repeat(500), "utf8");
    }
    await writeFile(resolve(project, "package.json"), '{"name":"prompt-budget","scripts":{"test":"vitest"}}\n', "utf8");
    const inventory = await inspectProjectInventory(project, ".rb");
    const inputPackage = await buildInputPackage({
      workflow: "plan",
      projectRoot: project,
      artifactDirectory: ".rb",
      request: "Plan a bounded feature.",
      inventory,
    });
    const state = {
      workflow: "plan",
      request: "Plan a bounded feature.",
      answers: [],
      analysis: undefined,
    } as unknown as HarnessRunState;

    const interview = buildInterviewPrompt(
      state,
      inputPackage,
      await loadWorkflowResources("plan", { section: "interview" }),
      1,
      [],
    );
    const generation = buildGenerationPrompt(
      state,
      inputPackage,
      await loadWorkflowResources("plan", { section: "generation" }),
    );
    expect(Buffer.byteLength(interview)).toBeLessThanOrEqual(HARNESS_BUDGET.prompt.maxInterviewPromptBytes);
    expect(Buffer.byteLength(generation)).toBeLessThanOrEqual(HARNESS_BUDGET.prompt.maxGenerationPromptBytes);
    // The model is told where it may not look, and never given a path there.
    expect(generation).toContain("Never inspect the RB Harness installation");
    expect(generation).not.toContain("packages/core");
    expect(interview).toContain("rb-harness-input/v1");
  });
});

describe("run lock identity", () => {
  const record = {
    pid: 4242,
    host: hostname(),
    runId: "plan-run",
    harnessVersion: "0.4.0",
    startedAt: "2026-08-24T12:00:00.000Z",
  };

  it("separates an active run from recoverable residue", () => {
    expect(harnessLockDisposition(undefined).state).toBe("free");
    expect(harnessLockDisposition(record, () => true)).toMatchObject({ state: "active" });
    expect(harnessLockDisposition(record, () => false)).toMatchObject({
      state: "residue",
      reason: expect.stringContaining("no longer running"),
    });
  });

  it("never claims a lock written on another host", () => {
    expect(harnessLockDisposition({ ...record, host: "another-machine" }, () => false))
      .toMatchObject({ state: "active", reason: expect.stringContaining("another-machine") });
  });
});
