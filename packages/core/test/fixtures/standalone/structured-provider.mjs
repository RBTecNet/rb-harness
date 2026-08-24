#!/usr/bin/env node
// A CLI provider that speaks a structured JSONL event stream, like the modes
// advertised by codex `--json`, claude `--output-format stream-json`, and
// opencode `--format json`. Behaviour is selected by the fixture mode so the
// runtime's event accounting can be proven without a paid call.
const mode = process.env.RB_HARNESS_TEST_EVENT_MODE ?? "normal";
for await (const _chunk of process.stdin) {
  // Consume the prompt first.
}
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

if (mode === "malformed") {
  emit({ type: "session.start" });
  process.stdout.write('{"type":"tool.start","name":"read_file"\n');
  setInterval(() => {}, 1000);
} else if (mode === "tool-flood") {
  emit({ type: "session.start" });
  for (let index = 0; index < 500; index += 1) {
    emit({ type: "tool.start", name: "read_file", input: { path: `src/file-${index}.ts` } });
    emit({ type: "tool.end", name: "read_file" });
  }
  setInterval(() => {}, 1000);
} else if (mode === "stalled") {
  emit({ type: "session.start" });
  const repeat = () => emit({ type: "log", message: "still thinking about the same thing" });
  repeat();
  setInterval(repeat, 20);
} else {
  emit({ type: "session.start" });
  emit({ type: "tool.start", name: "list_files", input: { path: "." } });
  emit({ type: "tool.end", name: "list_files" });
  emit({
    type: "assistant.message",
    text: `RB_HARNESS_DOCUMENTS_JSON_BEGIN\n${JSON.stringify({
      contract: "rb-harness-documents/v1",
      status: "complete",
      summary: "Structured fixture bundle.",
      documents: [{ path: ".rb/context/ARCHITECTURE.md", content: "# Architecture\n\nStructured." }],
    })}\nRB_HARNESS_DOCUMENTS_JSON_END`,
  });
  emit({ type: "session.end", usage: { input_tokens: 120, cache_read_input_tokens: 90, output_tokens: 40 } });
}
