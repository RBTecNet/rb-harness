#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const prompt = Buffer.concat(chunks).toString("utf8");
const pendingSource = prompt.match(/Answers requiring classification in this round:\n([^\n]*)/)?.[1] ?? "[]";
const pending = JSON.parse(pendingSource);
const mode = process.argv[2] ?? "normal";

if (process.env.RB_HEADLESS_TEST_CAPTURE) {
  await writeFile(process.env.RB_HEADLESS_TEST_CAPTURE, JSON.stringify({ prompt, environment: process.env }), "utf8");
}
if (mode === "modify-workspace") {
  await writeFile(resolve(process.cwd(), "adapter-wrote.txt"), "forbidden\n", "utf8");
}
if (mode === "unavailable") process.exit(75);
if (mode === "invalid-protocol") {
  process.stdout.write("not-json\n");
  process.exit(0);
}

let result;
if (pending.length === 0) {
  result = {
    contract: "rb-harness-interview/v1",
    status: "needs_input",
    summary: "One material decision is pending.",
    discoveries: ["Declarative new-project request received."],
    assumptions: [], unresolved: ["Deployment region is not selected."], answerReviews: [],
    questions: [{
      id: "deployment-region", question: "Which deployment region should be used?", why: "It determines data residency.",
      type: "single-choice", options: ["Brazil", "United States"], recommendation: "Brazil",
    }],
  };
} else {
  const answer = pending[0];
  const ambiguous = /maybe|talvez/i.test(answer.rawAnswer);
  const secret = process.env.RB_HEADLESS_TEST_SECRET;
  result = ambiguous ? {
    contract: "rb-harness-interview/v1",
    status: "needs_input",
    summary: "The submitted region answer remains ambiguous.",
    discoveries: [], assumptions: [], unresolved: ["A single region is still required."],
    answerReviews: [{ questionId: answer.questionId, disposition: "AMBIGUOUS", remainingUncertainty: "The answer did not choose one region." }],
    questions: [{
      id: "deployment-region-followup", question: "Choose exactly one deployment region.", why: "A deployable plan needs one region.",
      type: "single-choice", options: ["Brazil", "United States"], recommendation: "Brazil", answerFor: answer.questionId,
    }],
  } : {
    contract: "rb-harness-interview/v1",
    status: "ready",
    summary: mode === "secret" ? `Ready ${secret}` : "All material decisions are accepted.",
    discoveries: [], assumptions: [], unresolved: [],
    answerReviews: [{ questionId: answer.questionId, disposition: "ACCEPTED", normalizedDecision: mode === "secret" ? `${answer.rawAnswer} ${secret}` : answer.rawAnswer }],
    questions: [],
  };
}

process.stdout.write(`RB_HARNESS_INTERVIEW_JSON_BEGIN\n${JSON.stringify(result)}\nRB_HARNESS_INTERVIEW_JSON_END\n`);
