#!/usr/bin/env node
for await (const _chunk of process.stdin) {
  // Consume the prompt before returning the deliberately defective response.
}

if (process.env.RB_HARNESS_MODE === "interview") {
  process.stdout.write(`RB_HARNESS_INTERVIEW_JSON_BEGIN\n${JSON.stringify({
    contract: "rb-harness-interview/v1",
    status: "ready",
    summary: "The fixture request is ready.",
    discoveries: [],
    assumptions: [],
    unresolved: [],
    answerReviews: [],
    questions: [],
  })}\nRB_HARNESS_INTERVIEW_JSON_END\n`);
  process.exit(0);
}
process.stdout.write('RB_HARNESS_DOCUMENTS_JSON_BEGIN\n{"contract":"rb-harness-documents/v1","status":"complete","documents":[{"path":".rb/x.md","content":"# partial');
