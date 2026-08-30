import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const REQUEST = "Create a Node.js command-line program named hello with named and default greetings and automated tests.";

const fixture = vi.hoisted(() => {
  const profile = {
    id: "fixture:canonical", family: "fixture", transport: "claude-code-cli", requestAccounting: "opaque", modelId: "fixture", label: "Fixture",
    runtime: { kind: "external-executable", versionPolicy: "exact-recorded" }, structuredOutput: "claude-code-json-schema", strictSchema: true,
    toolCalling: false, toolChoiceForcing: false, reasoning: { supported: false }, maxOutputTokens: 128_000, systemRole: "system",
    streaming: { supported: true, usageInStream: false }, usageReporting: { inputTokens: false, cachedInputTokens: false, cacheWriteTokens: false, outputTokens: false, reasoningTokens: false, costUsd: false },
    conformance: { tier: "SUPPORTED", suiteVersion: "fixture/v1", runId: "fixture", recordedAt: "2026-08-30T00:00:00.000Z", normalizationsOnHappyPath: [], verifiedRecord: true },
  } as const;
  const intent = {
    format: "rb-init-intent/v1",
    project: { name: "hello", objective: "Deliver a tested Node.js command-line greeting program with named and default output." },
    determinations: [{
      key: "node-cli", statement: "The product is a Node.js command-line program named hello.", rationale: "The requested runtime and product surface are explicit.",
      materiality: "architecture", rigidity: "RIGID", sourceKind: "request", evidence: "Node.js command-line program named hello",
    }],
    requirements: [
      { key: "named-greeting", statement: "Running hello with a name prints the named greeting." },
      { key: "default-greeting", statement: "Running hello without a name prints the default greeting." },
      { key: "automated-tests", statement: "Automated tests cover both greeting modes." },
    ],
    qualityCommands: [{ key: "test-suite", kind: "test", command: "npm test" }],
    proposedProtectedPaths: [], questions: [], contradictions: [],
  };
  const work = {
    format: "rb-init-work/v1",
    phases: [{
      key: "deliver-cli", title: "Deliver the hello CLI", goal: "Provide tested named and default greetings.", dependsOn: [],
      tasks: [{
        key: "implement-greetings", title: "Implement greeting behavior", intent: "Implement the executable greeting command and automated coverage.",
        dependsOn: [], ownedPaths: ["bin/hello.js", "src/greet.js", "test/greet.test.js"],
        covers: ["named-greeting", "default-greeting", "automated-tests"],
        acceptance: [
          "Running `node bin/hello.js Ada` writes exactly `Hello, Ada!` and exits successfully.",
          "Running `node bin/hello.js` writes exactly `Hello, world!` and exits successfully.",
          "Running `npm test` completes with passing named and default greeting checks.",
        ],
        validation: [{ kind: "command", value: "test-suite" }],
        expectedEvidence: "Implementation source, automated test source, and passing npm test output.",
      }],
    }],
  };
  const requests: Array<{ readonly slice: string }> = [];
  const script: unknown[] = [intent, work];
  const adapter = {
    family: "fixture", transport: "claude-code-cli", profiles: [profile],
    checkCapabilities: () => ({ ok: true, value: true }),
    request: async (_profile: unknown, _auth: unknown, request: { readonly slice: string }) => {
      requests.push(request);
      const payload = script.shift();
      if (!payload) throw new Error("fixture script exhausted");
      return { ok: true, value: {
        slice: request.slice, payload: structuredClone(payload), normalizations: [],
        usage: {
          inputTokens: { measured: false, reason: "unsupported-by-provider" }, cachedInputTokens: { measured: false, reason: "unsupported-by-provider" },
          cacheWriteTokens: { measured: false, reason: "unsupported-by-provider" }, outputTokens: { measured: false, reason: "unsupported-by-provider" },
          reasoningTokens: { measured: false, reason: "unsupported-by-provider" }, providerRequests: { measured: false, reason: "unsupported-by-provider" },
          costUsd: { measured: false, reason: "unsupported-by-provider" },
        },
        transport: {
          startedAt: "2026-08-30T00:00:00.000Z", completedAt: "2026-08-30T00:00:00.001Z",
          firstOutputMs: { measured: false, reason: "unsupported-by-provider" }, httpStatus: { measured: false, reason: "unsupported-by-provider" },
          requestId: { measured: false, reason: "unsupported-by-provider" }, stopReason: { measured: false, reason: "unsupported-by-provider" },
        },
      } };
    },
    replay: () => { throw new Error("unused"); },
  };
  return { profile, adapter, requests };
});

vi.mock("../src/vnext/providers/registry.js", () => ({
  listProviderProfiles: () => [fixture.profile],
  resolveProviderProfile: () => fixture.profile,
  loadVerifiedProviderProfile: async () => fixture.profile,
  resolveProviderAdapter: () => fixture.adapter,
  resolveProviderAuth: async () => ({ kind: "ambient-session", id: "fixture" }),
}));

import { runHarnessCli } from "../src/cli-program.js";
import { CANONICAL_INIT_RECOVERY_BUDGET } from "../src/vnext/recovery-budget.js";

const originalArgv = [...process.argv];

afterEach(() => {
  process.argv = [...originalArgv];
  vi.restoreAllMocks();
});

async function files(root: string, relative = ""): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(resolve(root, relative), { withFileTypes: true })) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...await files(root, path));
    else found.push(path);
  }
  return found.sort();
}

describe("canonical Init public CLI integration", () => {
  it("routes bare init through intent/work, restores dashboard presentation, and publishes exact .rb closure", async () => {
    const project = await mkdtemp(resolve(tmpdir(), "rb-canonical-cli-"));
    let stdout = "";
    let stderr = "";
    vi.spyOn(process.stdout, "write").mockImplementation(((value: string | Uint8Array) => { stdout += String(value); return true; }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, "write").mockImplementation(((value: string | Uint8Array) => { stderr += String(value); return true; }) as typeof process.stderr.write);
    process.argv = [process.execPath, "rb-harness", "init", "--dashboard", "--profile", fixture.profile.id, "--project", project, "--headless", REQUEST];

    await runHarnessCli();

    expect(fixture.requests.map((entry) => entry.slice)).toEqual(["intent", "work"]);
    expect(await files(resolve(project, ".rb"))).toEqual(["init/BRIEF.md", "init/PHASES.md", "rb-manifest.json"]);
    expect(stdout).toContain("Semantic operations: 2");
    expect(stdout).toContain("Transport invocations: 2");
    expect(stdout).toContain("Corrective regenerations: 0");
    expect(stdout).toContain("Ralph: READY");
    expect(stdout).not.toContain("Progressive specification:");
    expect(stderr).toContain("--dashboard requer um terminal; seguindo com o log textual");
    expect(CANONICAL_INIT_RECOVERY_BUDGET).toEqual({
      maxCorrectiveRegenerationsPerSlice: 2,
      maxCorrectiveRegenerationsPerRun: 3,
      maxSemanticOperationsPerRun: 5,
      maxTransportInvocationsPerRun: 7,
      maxTransportRetriesPerSemanticOperation: 1,
      maxTransportRetriesPerRun: 2,
    });
  });
});
