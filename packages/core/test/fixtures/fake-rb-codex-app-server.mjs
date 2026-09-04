#!/usr/bin/node
import { createInterface } from "node:readline";

const preflight = {
  semanticMode: true,
  semanticModeVersion: "v1",
  runtimeVersion: "rb-codex 0.151.0-rb.1 (upstream 78c290807ce710180111df227df3b7a4fe845452)",
  model: "gpt-5.6-sol",
  modelProvider: "openai",
  toolPolicy: "none",
  effectiveToolCount: 0,
  toolManifestDigest: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
  instructionPolicy: "isolated",
  outputSchemaStrict: false,
  authenticated: true,
  authMode: "chatgpt",
  authStoreKind: "file",
  sessionMode: "ephemeral",
  requestedCodexTurns: 1,
  requestAccounting: "opaque",
};

const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: { userAgent: "fixture", codexHome: process.env.CODEX_HOME, platformFamily: "unix", platformOs: "linux" } });
  else if (message.method === "thread/start") send({ id: message.id, result: { thread: { id: "fixture-thread" }, semanticPreflight: preflight } });
  else if (message.method === "turn/start") {
    const payload = {
      schema: message.params.outputSchema,
      turnHasModel: Object.hasOwn(message.params, "model"),
      inputCount: message.params.input.length,
    };
    send({ id: message.id, result: { turn: { id: "fixture-turn", status: "inProgress" } } });
    send({ method: "item/completed", params: { threadId: "fixture-thread", turnId: "fixture-turn", item: { type: "agentMessage", id: "fixture-message", text: JSON.stringify(payload), phase: "final_answer" } } });
    send({ method: "thread/tokenUsage/updated", params: { threadId: "fixture-thread", turnId: "fixture-turn", tokenUsage: { last: { inputTokens: 10, cachedInputTokens: 2, cacheWriteInputTokens: 0, outputTokens: 4, reasoningOutputTokens: 1 } } } });
    send({ method: "turn/completed", params: { threadId: "fixture-thread", turn: { id: "fixture-turn", status: "completed" }, semanticCompletion: { initialModel: "gpt-5.6-sol", initialModelProvider: "openai", finalModel: "gpt-5.6-sol", finalModelProvider: "openai", rerouted: false } } });
  }
});
