#!/usr/bin/env node
/**
 * A sanitized replay of the JSONL protocol that `opencode run --format json`
 * emits in the installed 1.18.21 build.
 *
 * The envelope (`{type, properties}`), the event names, the part types, and the
 * tool-state progression below were read from the installed binary's own
 * schema strings — not invented. Session, message, and part identifiers are
 * replaced with fixture values and no provider is contacted.
 */
const mode = process.env.RB_HARNESS_TEST_EVENT_MODE ?? "normal";
for await (const _chunk of process.stdin) {
  // Consume the prompt first.
}
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const sessionID = "ses_fixture0001";
const messageID = "msg_fixture0001";

const part = (properties) => emit({
  type: "message.part.updated",
  properties: { sessionID, part: { sessionID, messageID, ...properties }, time: { start: 0 } },
});

emit({ type: "message.updated", properties: { sessionID, info: { id: messageID, role: "assistant" } } });
part({ id: "prt_step0001", type: "step-start" });

// One tool invocation, re-emitted as its state advances. Counting events here
// would report three calls; the provider's callID says it is one.
for (const state of [
  { status: "pending", input: {} },
  { status: "running", input: { path: "." }, time: { start: 1 } },
  { status: "completed", input: { path: "." }, output: "src/app.ts", time: { start: 1, end: 2 } },
]) {
  part({ id: "prt_tool0001", type: "tool", callID: "call_fixture0001", tool: "list", state });
}

if (mode === "tool-flood") {
  for (let index = 0; index < 400; index += 1) {
    part({
      id: `prt_flood${index}`,
      type: "tool",
      callID: `call_flood_${index}`,
      tool: "read",
      state: { status: "completed", input: { filePath: `src/file-${index}.ts` } },
    });
  }
  setInterval(() => {}, 1000);
} else if (mode === "truncated-eof") {
  // A stream cut exactly at EOF: a half-written event and no newline.
  process.stdout.write('{"type":"message.part.updated","properties":{"sessionID":"ses_fixture0001","part":{"type":"text","text":"partial');
} else {
  const bundle = {
    contract: "rb-harness-documents/v1",
    status: "complete",
    summary: "OpenCode protocol fixture bundle.",
    documents: [{ path: ".rb/context/ARCHITECTURE.md", content: "# Architecture\n\nFrom the OpenCode fixture.\n" }],
  };
  part({
    id: "prt_text0001",
    type: "text",
    text: `RB_HARNESS_DOCUMENTS_JSON_BEGIN\n${JSON.stringify(bundle)}\nRB_HARNESS_DOCUMENTS_JSON_END`,
  });
  part({ id: "prt_step0002", type: "step-finish" });
  emit({ type: "session.idle", properties: { sessionID } });
}
