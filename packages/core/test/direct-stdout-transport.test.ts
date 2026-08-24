/**
 * Regression: a direct-API provider's final answer must reach the envelope
 * parser byte for byte.
 *
 * The bundled direct-API runtime is genuinely controlled — it owns the tool
 * catalog, counts every call, reports real usage, and confines reads. But the
 * *transport* between that runtime and the orchestrator is a subprocess whose
 * stdout carries one thing: the model's final answer. Treating "the adapter is
 * controlled" as "the adapter writes JSONL events" made the stream observer
 * read the envelope's own `{` as an event and flatten it to its string leaves,
 * so a complete, already-paid response was reported as malformed JSON.
 *
 * Nothing here touches a network, a credential, or a paid provider.
 */

import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runProvider } from "../src/harness-provider.js";
import {
  isControlledAdapter,
  providerCapabilities,
  usesStructuredStdout,
} from "../src/provider-capabilities.js";
import { ProviderStreamObserver, collectEventText } from "../src/provider-events.js";
import { parseInterviewAnalysis, recoverInterviewAnalysis } from "../src/harness-interview.js";
import { parseDocumentBundle } from "../src/harness-documents.js";
import type { DirectProviderId } from "../src/provider-registry.js";

const fixtures = resolve(process.cwd(), "test/fixtures/standalone");
const directRuntime = resolve(fixtures, "direct-runtime-provider.mjs");
const openCodeProvider = resolve(fixtures, "opencode-provider.mjs");

const DIRECT_PROVIDERS: DirectProviderId[] = [
  "openai", "anthropic", "gemini", "deepseek", "minimax", "openrouter",
];

/** A valid interview envelope exactly as the direct runtime prints it. */
function interviewEnvelope(): string {
  return `RB_HARNESS_INTERVIEW_JSON_BEGIN\n${JSON.stringify({
    contract: "rb-harness-interview/v1",
    status: "needs_input",
    summary: "Checkpoint 1 (round 1/2): four material decisions remain.",
    discoveries: ["The repository has no existing artifact tree."],
    assumptions: [],
    unresolved: ["Scheduling semantics"],
    answerReviews: [],
    questions: [
      { id: "q1", question: "Which scheduling semantics apply?", why: "It changes the data model.", type: "text", options: [] },
    ],
  })}\nRB_HARNESS_INTERVIEW_JSON_END\n`;
}

const originalArgv1 = process.argv[1] ?? "";

afterEach(() => {
  process.argv[1] = originalArgv1;
  delete process.env.RB_HARNESS_TEST_DIRECT_MODE;
});

/**
 * Run a real direct-provider invocation. `providerInvocation` builds the
 * command from `process.argv[1]`, so pointing that at the fixture exercises the
 * genuine direct-provider path — same capability lookup, same stream handling —
 * without a credential or a network call.
 */
async function runDirect(
  provider: DirectProviderId,
  mode = "interview",
): Promise<Awaited<ReturnType<typeof runProvider>> & { logPath: string }> {
  const directory = await mkdtemp(resolve(tmpdir(), `rb-direct-${provider}-`));
  const logPath = resolve(directory, "provider.log");
  await chmod(directRuntime, 0o755);
  process.argv[1] = directRuntime;
  process.env.RB_HARNESS_TEST_DIRECT_MODE = mode;
  const result = await runProvider({
    configuration: { provider, model: "fixture-model", effort: "" },
    mode: "interview",
    stage: "gap-analysis",
    projectRoot: directory,
    prompt: "fixture prompt",
    logPath,
    timeoutSeconds: 30,
    firstOutputTimeoutSeconds: 10,
  });
  return { ...result, logPath };
}

describe("direct-API stdout transport", () => {
  it("recognizes internal control without claiming a structured stdout stream", () => {
    for (const provider of DIRECT_PROVIDERS) {
      const capabilities = providerCapabilities(provider);
      // The internal guarantees are real and must stay claimed.
      expect(isControlledAdapter(provider)).toBe(true);
      expect(capabilities.toolAccounting.verified).toBe(true);
      expect(capabilities.usageMetrics.verified).toBe(true);
      expect(capabilities.readConfinement.verified).toBe(true);
      // The transport between that runtime and the orchestrator is not events.
      expect(usesStructuredStdout(provider)).toBe(false);
      expect(capabilities.stdoutTransport).toBe("final-text");
    }
  });

  it("keeps OpenCode on its real JSONL transport", () => {
    expect(isControlledAdapter("opencode")).toBe(true);
    expect(usesStructuredStdout("opencode")).toBe(true);
    expect(providerCapabilities("opencode").stdoutTransport).toBe("jsonl-events");
  });

  it("treats codex, claude, and custom stdout as final text", () => {
    for (const provider of ["codex", "claude", "custom"] as const) {
      expect(usesStructuredStdout(provider)).toBe(false);
      expect(providerCapabilities(provider).stdoutTransport).toBe("final-text");
    }
  });

  it("delivers the direct runtime's envelope to the parser byte for byte", async () => {
    for (const provider of DIRECT_PROVIDERS) {
      const result = await runDirect(provider);
      // The exact bytes the runtime wrote, not a reconstruction.
      expect(result.stdout).toBe(result.rawStdout);
      const analysis = parseInterviewAnalysis(result.stdout, { pendingAnswers: [], round: 1 });
      expect(analysis.status).toBe("needs_input");
      expect(analysis.questions).toHaveLength(2);
      expect(analysis.summary).toContain("Checkpoint 1");
    }
  }, 60_000);

  it("delivers a direct-runtime document bundle intact", async () => {
    const result = await runDirect("deepseek", "documents");
    expect(result.stdout).toBe(result.rawStdout);
    expect(parseDocumentBundle(result.stdout).documents[0]?.path).toBe(".rb/init/PROJECT.md");
  }, 30_000);

  it("never dismantles an envelope line that happens to start with a brace", () => {
    const envelope = interviewEnvelope();
    // This is the corruption: the observer flattens the object to its string
    // leaves, so `{"contract":"rb-harness-interview/v1","status":"needs_input"}`
    // becomes `rb-harness-interview/v1needs_input`.
    const asEvents = new ProviderStreamObserver({ mode: "structured", dialect: "generic" });
    asEvents.push(envelope);
    asEvents.end();
    expect(asEvents.report().events).toBeGreaterThan(0);
    expect(asEvents.recoveredText()).not.toContain('"contract"');

    // A final-text transport must never take that path.
    const asText = new ProviderStreamObserver({ mode: "opaque", dialect: "generic" });
    asText.push(envelope);
    asText.end();
    expect(asText.report().events).toBe(0);
    expect(parseInterviewAnalysis(envelope, { pendingAnswers: [], round: 1 }).questions).toHaveLength(1);
  });

  it("shows what collectEventText does to a structured envelope", () => {
    const flattened = collectEventText(JSON.parse('{"contract":"rb-harness-interview/v1","status":"needs_input"}'));
    expect(flattened).toEqual(["rb-harness-interview/v1", "needs_input"]);
  });

  it("keeps the direct runtime's measured usage and tool accounting", async () => {
    const result = await runDirect("deepseek");
    expect(result.usage.measured).toBe(true);
    expect(result.usage.requests).toBe(3);
    expect(result.usage.totalTokens).toBe(127_816);
    expect(result.usage.cachedInputTokens).toBe(96_000);
    // Tool calls come from the runtime that actually made them.
    expect(result.usage.toolCalls).toBe(5);
  }, 30_000);

  it("records the real transport in the log instead of claiming structured events", async () => {
    const result = await runDirect("deepseek");
    const log = await readFile(result.logPath, "utf8");
    expect(log).toMatch(/^stdout_transport=final-text$/m);
    expect(log).toMatch(/^stream_mode=opaque$/m);
    expect(log).not.toMatch(/^stream_mode=structured$/m);
    // The log still holds the exact bytes the provider wrote.
    expect(log).toContain("RB_HARNESS_INTERVIEW_JSON_END");
  }, 30_000);

  it("still recovers OpenCode's final text from its JSONL stream", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "rb-direct-opencode-"));
    await chmod(openCodeProvider, 0o755);
    const result = await runProvider({
      configuration: { provider: "custom", model: "fixture", effort: "", command: openCodeProvider },
      mode: "generation",
      stage: "generation",
      streamMode: "structured",
      streamDialect: "opencode",
      projectRoot: directory,
      prompt: "fixture prompt",
      logPath: resolve(directory, "provider.log"),
      timeoutSeconds: 30,
      firstOutputTimeoutSeconds: 10,
    });
    expect(result.stream.mode).toBe("structured");
    expect(result.stdout).not.toBe(result.rawStdout);
    expect(parseDocumentBundle(result.stdout).documents[0]?.path).toBe(".rb/context/ARCHITECTURE.md");
    expect(result.stream.toolEvents).toBe(1);
  }, 30_000);

  it("keeps the explicit streamMode override working for fixtures", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "rb-direct-override-"));
    await chmod(directRuntime, 0o755);
    process.env.RB_HARNESS_TEST_DIRECT_MODE = "interview";
    // Forcing structured is still honoured — that is what the override means.
    const forced = await runProvider({
      configuration: { provider: "custom", model: "fixture", effort: "", command: directRuntime },
      mode: "interview",
      stage: "gap-analysis",
      streamMode: "structured",
      projectRoot: directory,
      prompt: "fixture prompt",
      logPath: resolve(directory, "forced.log"),
      timeoutSeconds: 30,
      firstOutputTimeoutSeconds: 10,
    });
    expect(forced.stream.mode).toBe("structured");
    expect(await readFile(resolve(directory, "forced.log"), "utf8")).toMatch(/^stream_mode=structured$/m);

    // And forcing opaque is honoured for an adapter that would otherwise parse.
    const opaque = await runProvider({
      configuration: { provider: "custom", model: "fixture", effort: "", command: directRuntime },
      mode: "interview",
      stage: "gap-analysis",
      streamMode: "opaque",
      projectRoot: directory,
      prompt: "fixture prompt",
      logPath: resolve(directory, "opaque.log"),
      timeoutSeconds: 30,
      firstOutputTimeoutSeconds: 10,
    });
    expect(opaque.stream.mode).toBe("opaque");
    expect(opaque.stdout).toBe(opaque.rawStdout);
  }, 30_000);

  it("still rejects genuinely malformed JSON from a direct provider", async () => {
    const result = await runDirect("deepseek", "malformed");
    expect(result.stdout).toBe(result.rawStdout);
    expect(() => parseInterviewAnalysis(result.stdout, { pendingAnswers: [], round: 1 }))
      .toThrow("malformed interview JSON");
  }, 30_000);

  it("recovers a valid persisted direct-provider response without a new call", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "rb-direct-recover-"));
    const logPath = resolve(directory, "interview-round-1-protocol-2.log");
    // A log shaped exactly like the one the affected run left behind.
    await writeFile(logPath, [
      "provider=deepseek",
      "model=deepseek-v4-flash",
      "effort=provider-default",
      "mode=interview",
      "stage=gap-analysis",
      "exit_code=0",
      "first_output_ms=99484",
      "stdout_transport=final-text",
      "stream_mode=opaque",
      "",
      "--- stdout ---",
      interviewEnvelope(),
      "--- stderr ---",
      "",
    ].join("\n"), "utf8");

    const recovered = await recoverInterviewAnalysis(logPath, { pendingAnswers: [], round: 1 });
    expect(recovered?.status).toBe("needs_input");
    expect(recovered?.questions).toHaveLength(1);
    expect(recovered?.summary).toContain("Checkpoint 1");
  });

  it("recovers even from a log written before the fix, whose header said structured", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "rb-direct-legacy-"));
    const logPath = resolve(directory, "interview-round-1-protocol-1.log");
    // The pre-fix header is wrong about the transport, but the recorded stdout
    // was always the raw bytes — which is why the paid answer survives.
    await writeFile(logPath, [
      "provider=deepseek",
      "model=deepseek-v4-flash",
      "mode=interview",
      "exit_code=0",
      "stream_mode=structured",
      "stream_events=1",
      "",
      "--- stdout ---",
      interviewEnvelope(),
      "--- stderr ---",
      "",
    ].join("\n"), "utf8");

    expect((await recoverInterviewAnalysis(logPath, { pendingAnswers: [], round: 1 }))?.questions)
      .toHaveLength(1);
  });
});
