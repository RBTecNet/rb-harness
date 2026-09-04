import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { validateManifestTree } from "../src/manifest.js";
import { executeProgressiveInitWizardStage, type ProgressiveInitCliRuntime } from "../src/vnext/progressive-init/cli.js";
import {
  inspectProgressiveInit,
  runProgressiveInit,
  type ProgressiveInitResult,
  type ProgressiveStageSnapshot,
} from "../src/vnext/progressive-init/coordinator.js";
import { resolveProviderProfile } from "../src/vnext/providers/registry.js";
import type {
  CanonicalSemanticResponse,
  ModelProfile,
  ProviderAdapter,
  ProviderOutcome,
  ResolvedProviderAuth,
  SemanticRequest,
} from "../src/vnext/providers/contract.js";
import { PROGRESSIVE_INIT_STAGES, type ProgressiveInitStage } from "../src/vnext/progressive-init/stages.js";
import {
  executeProgressiveInitWizard,
  type ProgressiveInitWizardRuntime,
} from "../src/vnext/progressive-init/wizard-orchestrator.js";

const REQUEST = "Build a stateless TypeScript CLI that accepts one name and prints exactly one greeting. Include deterministic tests.";
const PROFILE_ID = "deepseek:deepseek-v4-pro";

function snapshots(completed: ReadonlySet<ProgressiveInitStage>, closureFresh = false): ProgressiveStageSnapshot[] {
  return PROGRESSIVE_INIT_STAGES.map((stage) => ({
    stage,
    status: completed.has(stage) ? "complete-fresh" : "incomplete",
    ...(stage === "project-phases" && completed.has(stage) ? { closureStatus: closureFresh ? "fresh" as const : "stale" as const } : {}),
  }));
}

function result(stage: ProgressiveInitStage, semanticOperations = 1): ProgressiveInitResult {
  return { mode: "focused", selectedStage: stage, completedStage: stage, semanticOperations, correctiveRegenerations: 0 };
}

function routingRuntime(input: {
  readonly completed?: readonly ProgressiveInitStage[];
  readonly closureFresh?: boolean;
  readonly failAt?: ProgressiveInitStage;
} = {}): ProgressiveInitWizardRuntime & { readonly calls: ProgressiveInitStage[]; readonly profiles: string[]; readonly output: string[] } {
  const complete = new Set(input.completed ?? []);
  let closureFresh = Boolean(input.closureFresh);
  const calls: ProgressiveInitStage[] = [];
  const profiles: string[] = [];
  const output: string[] = [];
  return {
    calls,
    profiles,
    output,
    inspect: async () => snapshots(complete, closureFresh),
    runStage: async (options) => {
      const stage = options.stage!;
      calls.push(stage);
      profiles.push(options.profileId!);
      if (stage === input.failAt) throw new Error("fixture stage failure");
      complete.add(stage);
      if (stage === "project-phases") closureFresh = true;
      return result(stage);
    },
    write: (value) => void output.push(value),
  };
}

const wizardOptions = (projectRoot: string) => ({
  requestParts: [REQUEST],
  profileId: PROFILE_ID,
  projectRoot,
  headless: false,
  deadlineSeconds: 120,
});

describe("Wizard Progressive Init routing", () => {
  it("runs P1-P4 in frozen order, propagates the exact profile, closes once, and never routes to canonical work-requested/dashboard", async () => {
    const runtime = routingRuntime();
    const outcome = await executeProgressiveInitWizard(wizardOptions("/fixture/project"), runtime);
    expect(runtime.calls).toEqual(PROGRESSIVE_INIT_STAGES);
    expect(runtime.profiles).toEqual(PROGRESSIVE_INIT_STAGES.map(() => PROFILE_ID));
    expect(runtime.calls.filter((stage) => stage === "project-phases")).toHaveLength(1);
    expect(outcome).toMatchObject({ executedStages: PROGRESSIVE_INIT_STAGES, skippedStages: [], alreadyComplete: false, closureStatus: "fresh" });
    expect(runtime.output.join("")).toContain("Canonical closure: COMPLETE");
    expect(runtime.output.join("")).toContain("Ralph: READY");
    expect(runtime.output.join("")).not.toMatch(/work-requested|dashboard/i);
  });

  it("stops at a failing stage and leaves downstream stages untouched", async () => {
    const runtime = routingRuntime({ failAt: "user-stories" });
    await expect(executeProgressiveInitWizard(wizardOptions("/fixture/project"), runtime)).rejects.toThrow("fixture stage failure");
    expect(runtime.calls).toEqual(["project-description", "user-stories"]);
    expect(runtime.output.join("")).toContain("Progressive Init stopped at:\nuser-stories");
    expect(runtime.output.join("")).not.toContain("Ralph: READY");
  });

  it("skips fresh upstream stages and resumes at the first stage needing work", async () => {
    const runtime = routingRuntime({ completed: ["project-description", "user-stories"] });
    const outcome = await executeProgressiveInitWizard(wizardOptions("/fixture/project"), runtime);
    expect(runtime.calls).toEqual(["database-schema", "project-phases"]);
    expect(outcome.skippedStages).toEqual(["project-description", "user-stories"]);
  });

  it("performs zero provider work when all stages and closure are already fresh", async () => {
    const runtime = routingRuntime({ completed: [...PROGRESSIVE_INIT_STAGES], closureFresh: true });
    const outcome = await executeProgressiveInitWizard(wizardOptions("/fixture/project"), runtime);
    expect(runtime.calls).toEqual([]);
    expect(outcome).toMatchObject({ semanticOperations: 0, correctiveRegenerations: 0, alreadyComplete: true });
    expect(runtime.output.join("")).toContain("already complete and fresh");
  });

  it("republishes stale closure through focused P4 without regenerating fresh stages", async () => {
    const runtime = routingRuntime({ completed: [...PROGRESSIVE_INIT_STAGES], closureFresh: false });
    await executeProgressiveInitWizard(wizardOptions("/fixture/project"), runtime);
    expect(runtime.calls).toEqual(["project-phases"]);
  });
});

function usage() {
  const absent = { measured: false as const, reason: "unsupported-by-provider" as const };
  return {
    inputTokens: absent, cachedInputTokens: absent, cacheWriteTokens: absent,
    outputTokens: absent, reasoningTokens: absent, providerRequests: absent, costUsd: absent,
  };
}

class FullFlowAdapter implements ProviderAdapter {
  readonly family = "deepseek";
  readonly transport = "direct-api" as const;
  readonly profiles: readonly ModelProfile[];
  readonly requests: SemanticRequest[] = [];

  constructor(profile: ModelProfile) { this.profiles = [profile]; }
  checkCapabilities(): ProviderOutcome<true> { return { ok: true, value: true }; }
  replay(): ProviderOutcome<CanonicalSemanticResponse> { throw new Error("replay unused"); }

  async request(_profile: ModelProfile, _auth: ResolvedProviderAuth, request: SemanticRequest): Promise<ProviderOutcome<CanonicalSemanticResponse>> {
    this.requests.push(request);
    const input = JSON.parse(request.input) as Record<string, any>;
    let payload: unknown;
    if (request.slice === "project-description") {
      payload = {
        contract: "rb-project-description/v1", stage: "project-description", originalRequest: REQUEST,
        project: { key: "greeting-cli", name: "Greeting CLI", objective: "Print exactly one greeting for one supplied name." },
        actors: [{ key: "cli-user", name: "CLI user", responsibility: "Supplies a name and reads the greeting." }],
        capabilities: [{ key: "print-greeting", statement: "Accept one name and print exactly one greeting." }],
        workflows: [{ key: "greet-user", statement: "A CLI user supplies a name and receives one greeting.", actorKeys: ["cli-user"], capabilityKeys: ["print-greeting"] }],
        constraints: [], determinations: [], qualityCommands: [{ key: "tests", kind: "test", command: "npm test" }], questions: [],
      };
    } else if (request.slice === "user-stories-questions") {
      payload = { contract: "rb-user-stories-questions/v1", stage: "user-stories", participationRecommendations: [], questions: [] };
    } else if (request.slice === "user-stories") {
      payload = {
        contract: "rb-user-stories/v1", stage: "user-stories", projectKey: "greeting-cli",
        stories: [{ key: "print-greeting", workflowKey: "greet-user", capabilityKeys: ["print-greeting"], actorKey: "cli-user", operatorActorKey: "cli-user", intent: "Supply one name", outcome: "Receive exactly one greeting containing that name", acceptance: ["Running the CLI with one name prints exactly one greeting containing that name."] }],
      };
    } else if (request.slice === "database-schema-persistence-questions") {
      payload = {
        contract: "rb-database-schema-persistence-questions/v1", stage: "database-schema",
        recommendations: input.storyPersistenceSubjects.map((subject: any) => ({ subjectKey: subject.key, recommendedOptionKey: "not-persisted", question: `Should ${subject.storyKey} persist data?`, rationale: "The approved workflow completes within one process invocation." })),
      };
    } else if (request.slice === "project-phases") {
      payload = {
        phases: [{
          key: "implementation", title: "Implement the greeting CLI", goal: "Deliver the approved stateless greeting workflow.",
          tasks: [{
            key: "implement-greeting", title: "Implement and test greeting output",
            intent: "Implement the CLI argument contract, greeting output, and deterministic tests.", dependsOn: [],
            ownedPaths: ["src/cli.ts", "test/cli.test.ts"],
            coverageKeys: input.implementationSubjects.map((subject: any) => subject.key),
            acceptance: ["Running the CLI with one name prints exactly one greeting containing that name."],
            validation: [{ kind: "command", commandKey: "tests" }],
            expectedEvidence: "Passing deterministic test output for the accepted greeting and argument contract.",
          }],
        }],
      };
    } else {
      throw new Error(`unexpected fake-provider slice: ${request.slice}`);
    }
    return {
      ok: true,
      value: {
        slice: request.slice, payload, normalizations: [], usage: usage(),
        transport: {
          startedAt: "2026-09-04T00:00:00.000Z", completedAt: "2026-09-04T00:00:00.001Z",
          firstOutputMs: { measured: false, reason: "unsupported-by-provider" },
          httpStatus: { measured: false, reason: "unsupported-by-provider" },
          requestId: { measured: false, reason: "unsupported-by-provider" },
          stopReason: { measured: false, reason: "unsupported-by-provider" },
        },
      },
    };
  }
}

describe("Wizard full local-provider production orchestration", () => {
  it("uses the real stage coordinator from P1 through one canonical Ralph READY closure", async () => {
    const projectRoot = await mkdtemp(resolve(tmpdir(), "rb-wizard-progressive-full-"));
    const declared = resolveProviderProfile(PROFILE_ID);
    const profile: ModelProfile = {
      ...declared,
      conformance: { tier: "SUPPORTED", suiteVersion: "fixture/v1", runId: "fixture", recordedAt: "2026-09-04T00:00:00.000Z", normalizationsOnHappyPath: [], verifiedRecord: true },
    };
    const adapter = new FullFlowAdapter(profile);
    const auth: ResolvedProviderAuth = { kind: "credential", credential: { id: "fixture", secret: "fixture-only", attributes: {} } };
    const output: string[] = [];
    const stageCalls: ProgressiveInitStage[] = [];
    const cliRuntime: ProgressiveInitCliRuntime = {
      inputIsTTY: true, outputIsTTY: true, write: (value) => void output.push(value),
      ask: async (prompt) => /blank is not accepted/i.test(prompt) ? "1" : "",
      inspect: inspectProgressiveInit, listProfiles: () => [profile], loadProfile: async () => profile,
      adapterFor: () => adapter, authFor: async () => auth,
      listClaudeCodeModels: async () => [], inspectClaudeCodeModel: async () => ({ requestedModel: "unused", transportVersion: "unused", state: "UNSUPPORTED" }),
      verifyClaudeCodeModel: async () => { throw new Error("unused"); }, execute: runProgressiveInit,
    };
    const outcome = await executeProgressiveInitWizard(wizardOptions(projectRoot), {
      inspect: inspectProgressiveInit,
      write: cliRuntime.write,
      runStage: async (options) => {
        stageCalls.push(options.stage!);
        return executeProgressiveInitWizardStage(options, cliRuntime);
      },
    });

    expect(stageCalls).toEqual(PROGRESSIVE_INIT_STAGES);
    expect(adapter.requests.map((request) => request.slice)).toEqual([
      "project-description", "user-stories-questions", "user-stories",
      "database-schema-persistence-questions", "project-phases",
    ]);
    expect(outcome).toMatchObject({ closureStatus: "fresh", semanticOperations: 5 });
    expect((await inspectProgressiveInit(projectRoot, REQUEST)).every((entry) => entry.status === "complete-fresh")).toBe(true);
    expect((await inspectProgressiveInit(projectRoot, REQUEST)).at(-1)?.closureStatus).toBe("fresh");
    expect((await validateManifestTree(projectRoot)).valid).toBe(true);
    const manifest = JSON.parse(await readFile(resolve(projectRoot, ".rb", "rb-manifest.json"), "utf8"));
    expect(manifest.artifacts.filter((entry: any) => entry.kind === "execution-plan" && entry.status === "ready")).toHaveLength(1);
    expect(output.join("")).not.toMatch(/work-requested|dashboard/i);

    const before = adapter.requests.length;
    const second = await executeProgressiveInitWizard(wizardOptions(projectRoot), {
      inspect: inspectProgressiveInit,
      write: cliRuntime.write,
      runStage: vi.fn(async (options) => executeProgressiveInitWizardStage(options, cliRuntime)),
    });
    expect(second).toMatchObject({ alreadyComplete: true, semanticOperations: 0, executedStages: [] });
    expect(adapter.requests).toHaveLength(before);
  });
});
