import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runStandaloneWorkflow } from "../src/standalone-runner.js";
import { validateManifestTree } from "../src/manifest.js";
import { HARNESS_BUDGET } from "../src/harness-budget.js";
import { buildInputPackage, serializeInputPackage } from "../src/harness-input-package.js";
import { buildInterviewPrompt } from "../src/harness-interview.js";
import { inspectProjectInventory } from "../src/harness-inventory.js";
import type { HarnessRunState, InterviewAnswer } from "../src/standalone-types.js";

const fixtures = resolve(import.meta.dirname, "fixtures/standalone");
const adaptiveProvider = resolve(fixtures, "adaptive-provider.mjs");

/**
 * End-to-end proof that the interview converges instead of expiring.
 *
 * The fixture only reports `ready` in its third analysis round, because
 * accepting the first answer is what opens the second decision. Under the old
 * two-round ceiling this exact run ended BLOCKED with a decision still open.
 */
describe("adaptive interview reaches convergence", () => {
  it("keeps asking until nothing material is open, then publishes", async () => {
    const project = await mkdtemp(resolve(tmpdir(), "rb-harness-adaptive-"));
    await writeFile(resolve(project, "package.json"), '{"name":"fixture"}\n', "utf8");
    const answers = resolve(project, "answers.json");
    await writeFile(answers, JSON.stringify({
      "scope-boundary": "Archived records only.",
      "retention-window": "90 days.",
    }), "utf8");
    await chmod(adaptiveProvider, 0o755);

    const state = await runStandaloneWorkflow({
      workflow: "plan",
      projectRoot: project,
      artifactDirectory: ".rb",
      request: "Plan an export of archived records.",
      provider: { provider: "custom", model: "fixture-model", effort: "high", command: adaptiveProvider },
      answersFile: answers,
      questionMode: "one-by-one",
      nonInteractive: true,
      timeoutSeconds: 30,
      firstOutputTimeoutSeconds: 5,
    });

    expect(state.status).toBe("complete");
    // Three analysis rounds: ask, ask again after the answer opened a decision, converge.
    expect(state.interviewRound).toBe(3);
    expect(state.analysis?.status).toBe("ready");
    expect(state.analysis?.unresolved).toEqual([]);
    // Both decisions entered the closed checkpoint as accepted, in order.
    expect(state.answers.map((answer) => answer.questionId)).toEqual(["scope-boundary", "retention-window"]);
    expect(state.answers.every((answer) => answer.disposition === "ACCEPTED")).toBe(true);
    expect(state.repairsUsed).toBe(0);

    expect((await validateManifestTree(project)).valid).toBe(true);
    const plan = await readFile(resolve(project, ".rb/features/adaptive-fixture/PHASES.md"), "utf8");
    expect(plan).toContain("T001");
    expect(plan).toContain("T002");
  }, 60_000);
});

/**
 * A converging interview may accept a decision for every question its run-wide
 * ceiling allows. Those decisions are authority and are never trimmed, so the
 * package and prompt ceilings must hold the whole set: a run that failed here
 * would discard an interview the developer already answered in full.
 */
describe("the budgets hold a fully converged interview", () => {
  it("carries the maximum number of accepted decisions through package and prompt", async () => {
    const project = await mkdtemp(resolve(tmpdir(), "rb-harness-converged-budget-"));
    await writeFile(resolve(project, "package.json"), '{"name":"budget-fixture"}\n', "utf8");
    const answers: InterviewAnswer[] = Array.from(
      { length: HARNESS_BUDGET.interview.maxQuestions },
      (_value, index): InterviewAnswer => ({
        questionId: `decision-${String(index + 1).padStart(2, "0")}`,
        question: `Which observable behavior does boundary ${index + 1} expose when the documented precondition does not hold? `.repeat(2),
        rawAnswer: `Boundary ${index + 1} returns the documented refusal and records exactly one audit entry naming the actor. `.repeat(4),
        disposition: "ACCEPTED",
        normalizedDecision: `Boundary ${index + 1} refuses with the documented status and records one audit entry. `.repeat(4),
        answeredAt: new Date().toISOString(),
      }),
    );
    const inputPackage = await buildInputPackage({
      workflow: "plan",
      projectRoot: project,
      artifactDirectory: ".rb",
      request: "Plan a change whose interview needed every available round.",
      inventory: await inspectProjectInventory(project, ".rb"),
      answers,
    });
    expect(inputPackage.decisions).toHaveLength(HARNESS_BUDGET.interview.maxQuestions);
    expect(Buffer.byteLength(serializeInputPackage(inputPackage)))
      .toBeLessThanOrEqual(HARNESS_BUDGET.inventory.maxPackageBytes);

    const state = {
      workflow: "plan",
      request: "Plan a change whose interview needed every available round.",
      answers,
      analysis: {
        contract: "rb-harness-interview/v1",
        status: "needs_input",
        summary: "Decisions accumulated across the adaptive rounds.",
        discoveries: [],
        assumptions: [],
        unresolved: Array.from({ length: 50 }, (_value, index) => `Open item ${index + 1} still needs a decision. `.repeat(4)),
        answerReviews: [],
        questions: [],
      },
    } as unknown as HarnessRunState;
    const prompt = buildInterviewPrompt(state, inputPackage, "", HARNESS_BUDGET.interview.maxRounds, answers.slice(-3));
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(HARNESS_BUDGET.prompt.maxInterviewPromptBytes);
  });
});
