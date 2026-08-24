#!/usr/bin/env node
/**
 * Stands in for the direct-API runtime as the orchestrator sees it: content-free
 * activity markers on stderr while the remote call is in flight, and the model's
 * complete final answer on stdout at the end. It contacts nothing.
 */
const mode = process.env.RB_HARNESS_TEST_STREAM_MODE ?? "slow-finish";
const marker = (kind) => process.stderr.write(`[rb-api-event] ${kind}\n`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

for await (const _chunk of process.stdin) {
  // Consume the prompt exactly as the real runtime does.
}

if (mode === "silent") {
  // The connection is accepted and the provider never answers.
  await sleep(30_000);
  process.exit(0);
}

const envelope = (summary) => `RB_HARNESS_INTERVIEW_JSON_BEGIN\n${JSON.stringify({
  contract: "rb-harness-interview/v1",
  status: "ready",
  summary,
  discoveries: [],
  assumptions: [],
  unresolved: [],
  answerReviews: [],
  questions: [],
})}\nRB_HARNESS_INTERVIEW_JSON_END\n`;

if (mode === "sensitive") {
  // Reasoning, tool arguments, and secrets exist inside the runtime and must
  // never reach stdout or the log through the activity channel.
  marker("response-start");
  marker("reasoning-delta");
  marker("tool-call-delta");
  marker("content-delta");
  marker("response-complete");
  process.stdout.write(envelope("Nothing sensitive left the runtime."));
  process.exit(0);
}

if (mode === "legacy-silent") {
  // Exactly the pre-0.4.2 behaviour: `stream: false`, so nothing at all is
  // written until the whole call finishes. This is the shape that lost a paid
  // generation at the 300s first-output deadline.
  await sleep(2_500);
  process.stdout.write(envelope("Answered only at the very end."));
  process.exit(0);
}

// slow-finish: the stream starts quickly, the answer takes much longer.
await sleep(300);
marker("response-start");
for (let index = 0; index < 8; index += 1) {
  await sleep(250);
  marker("content-delta");
}
marker("response-complete");
process.stdout.write(envelope("The stream began long before the answer finished."));
