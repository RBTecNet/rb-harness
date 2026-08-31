import { describe, expect, it } from "vitest";
import { executeProgressiveInitCommand, type ProgressiveInitCliRuntime } from "../src/vnext/progressive-init/cli.js";
import type { ProgressiveInitOptions, ProgressiveInitResult, ProgressiveStageSnapshot } from "../src/vnext/progressive-init/coordinator.js";
import { resolveProviderProfile } from "../src/vnext/providers/registry.js";
import type { ModelProfile, ProviderAdapter, ResolvedProviderAuth } from "../src/vnext/providers/contract.js";
import { CLAUDE_CODE_TRANSPORT_PROFILE_ID } from "../src/vnext/providers/anthropic/claude-code/runtime-model.js";
import type { ClaudeCodeCompatibilityInspection } from "../src/vnext/providers/anthropic/claude-code/runtime-compatibility.js";
import type { InterviewQuestionEvidence } from "../src/vnext/interview.js";

const CLI_ID = "anthropic:claude-code-cli:claude-opus-5";
const API_ID = "anthropic:claude-opus-5";

function supported(id: string): ModelProfile {
  return {
    ...resolveProviderProfile(id),
    conformance: {
      tier: "SUPPORTED",
      suiteVersion: "fixture/v1",
      runId: "fixture",
      recordedAt: "2026-08-30T00:00:00.000Z",
      normalizationsOnHappyPath: [],
      verifiedRecord: true,
    },
  };
}

const cliProfile: ModelProfile = {
  ...supported(CLI_ID),
  runtimeModel: {
    transportProfileId: CLAUDE_CODE_TRANSPORT_PROFILE_ID,
    transportVersion: "2.1.251 (Claude Code)",
    requestedModel: "claude-opus-5",
    selectorKind: "exact",
    resolvedModel: "claude-opus-5",
    compatibilitySource: "packaged",
  },
};
const apiProfile = supported(API_ID);
const incomplete: readonly ProgressiveStageSnapshot[] = [
  { stage: "project-description", status: "incomplete" },
  { stage: "user-stories", status: "incomplete" },
  { stage: "database-schema", status: "incomplete" },
  { stage: "project-phases", status: "incomplete" },
];

const options = {
  requestParts: ["Build a small service application."],
  projectRoot: "/tmp/progressive-profile-selection-fixture",
  headless: false,
  deadlineSeconds: 120,
  stage: "project-description" as const,
};

function fixture(overrides: Partial<ProgressiveInitCliRuntime> = {}) {
  const writes: string[] = [];
  const answers: string[] = [];
  const selectedProfiles: string[] = [];
  const adapters: string[] = [];
  const events: string[] = [];
  let executeCalls = 0;
  const adapter = {} as ProviderAdapter;
  const auth: ResolvedProviderAuth = { kind: "ambient-session", id: "fixture" };
  const runtime: ProgressiveInitCliRuntime = {
    inputIsTTY: true,
    outputIsTTY: true,
    write: (value) => {
      writes.push(value);
      if (value.includes("Select AI transport")) events.push("profile-selection");
      if (value.includes("Select Claude Code model")) events.push("model-selection");
      if (value.startsWith("\nAI profile:")) events.push("profile-selected");
    },
    ask: async () => answers.shift() ?? "1",
    inspect: async () => incomplete,
    listProfiles: () => [apiProfile, cliProfile],
    loadProfile: async (id) => id === CLI_ID ? cliProfile : apiProfile,
    adapterFor: (id) => { adapters.push(id); return adapter; },
    authFor: async () => auth,
    listClaudeCodeModels: async () => [{
      requestedModel: "claude-opus-5",
      state: "SUPPORTED",
      transportVersion: "2.1.251 (Claude Code)",
      resolvedModel: "claude-opus-5",
      source: "packaged",
      target: cliProfile,
    }],
    inspectClaudeCodeModel: async (selector) => selector === "claude-opus-5" ? {
      requestedModel: selector,
      state: "SUPPORTED",
      transportVersion: "2.1.251 (Claude Code)",
      resolvedModel: selector,
      source: "packaged",
      target: cliProfile,
    } : {
      requestedModel: selector,
      state: "UNVERIFIED",
      transportVersion: "2.1.251 (Claude Code)",
    },
    verifyClaudeCodeModel: async () => cliProfile,
    execute: async (execution: ProgressiveInitOptions): Promise<ProgressiveInitResult> => {
      executeCalls += 1;
      selectedProfiles.push(execution.profile!.id);
      await execution.presentation?.stage("project-description", incomplete);
      events.push("stage");
      await execution.presentation?.question?.({
        key: "interface-mvp",
        question: "Which interface should the MVP expose?",
        materiality: "product",
        rigidity: "RIGID",
        recommendedAnswer: { value: "REST API", rationale: "It is a concrete interface boundary." },
        alternatives: ["CLI"],
        persistedBeforeSelection: true,
        presented: false,
        response: null,
        selectedValue: null,
        acceptanceMode: null,
      });
      events.push("question");
      return {
        mode: "focused",
        selectedStage: "project-description",
        completedStage: "project-description",
        semanticOperations: 1,
        correctiveRegenerations: 0,
      };
    },
    ...overrides,
  };
  return { runtime, writes, answers, selectedProfiles, adapters, events, executeCalls: () => executeCalls };
}

describe("Progressive focused AI profile selection", () => {
  it("selects transport, then a compatibility-backed Claude Code model before stage execution", async () => {
    const state = fixture();
    state.answers.push("1", "1");
    await executeProgressiveInitCommand(options, state.runtime);
    expect(state.selectedProfiles).toEqual([CLI_ID]);
    expect(state.adapters).toEqual([CLI_ID]);
    expect(state.writes.join("")).toContain("Select Claude Code model:");
    expect(state.writes.join("")).toContain("claude-opus-5\n   SUPPORTED — resolves to claude-opus-5");
    expect(state.writes.join("")).toContain(`${CLI_ID}\ntransport: claude-code-cli\nruntime version: 2.1.251 (Claude Code)\nrequested model: claude-opus-5\nresolved model: claude-opus-5`);
    expect(state.events).toEqual(["profile-selection", "model-selection", "profile-selected", "stage", "question"]);
  });

  it("can select the exact direct API profile without making a live request", async () => {
    const state = fixture();
    state.answers.push("2");
    await executeProgressiveInitCommand(options, state.runtime);
    expect(state.selectedProfiles).toEqual([API_ID]);
    expect(state.adapters).toEqual([API_ID]);
  });

  it("prints the Progressive interview heading without duplicating the question rendered by the answer prompt", async () => {
    const prompts: string[] = [];
    const question: InterviewQuestionEvidence = {
      key: "interface-mvp",
      question: "Which interface should the MVP expose?",
      materiality: "product",
      rigidity: "RIGID",
      recommendedAnswer: { value: "REST API", rationale: "It is a concrete interface boundary." },
      alternatives: ["CLI"],
      persistedBeforeSelection: true,
      presented: false,
      response: null,
      selectedValue: null,
      acceptanceMode: null,
    };
    const state = fixture({
      ask: async (prompt) => { prompts.push(prompt); return ""; },
      execute: async (execution) => {
        await execution.presentation?.stage("project-description", incomplete);
        await execution.presentation?.question?.(question);
        if (execution.interview?.kind !== "interactive") throw new Error("expected interactive fixture");
        await execution.interview.answer(question);
        return {
          mode: "focused",
          selectedStage: "project-description",
          completedStage: "project-description",
          semanticOperations: 1,
          correctiveRegenerations: 0,
        };
      },
    });
    await executeProgressiveInitCommand({ ...options, profileId: API_ID }, state.runtime);
    expect(state.writes.join("")).toContain("\nProject Description interview\n");
    expect(state.writes.join("")).not.toContain(question.question);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.split(question.question)).toHaveLength(2);
  });

  it("uses an explicit profile exactly and bypasses the selector", async () => {
    let asked = 0;
    const state = fixture({ ask: async () => { asked += 1; return "1"; } });
    await executeProgressiveInitCommand({ ...options, profileId: API_ID }, state.runtime);
    expect(asked).toBe(0);
    expect(state.selectedProfiles).toEqual([API_ID]);
    expect(state.writes.join("")).not.toContain("Select AI profile");
  });

  it("fails headless and non-TTY missing-profile runs before execution", async () => {
    const headless = fixture();
    await expect(executeProgressiveInitCommand({ ...options, headless: true }, headless.runtime)).rejects.toThrow(/PROGRESSIVE_INIT_PROFILE_REQUIRED/);
    expect(headless.executeCalls()).toBe(0);
    const nonTty = fixture({ inputIsTTY: false });
    await expect(executeProgressiveInitCommand(options, nonTty.runtime)).rejects.toThrow(/PROGRESSIVE_INIT_PROFILE_REQUIRED/);
    expect(nonTty.executeCalls()).toBe(0);
  });

  it("reprompts invalid input and never silently selects another profile", async () => {
    const state = fixture();
    state.answers.push("not-a-profile", CLAUDE_CODE_TRANSPORT_PROFILE_ID, "1");
    await executeProgressiveInitCommand(options, state.runtime);
    expect(state.selectedProfiles).toEqual([CLI_ID]);
    expect(state.writes.join("")).toContain("Invalid selection. Enter a listed number or exact listed value.");
  });

  it("makes numeric selection independent of registry enumeration order", async () => {
    const first = fixture({ listProfiles: () => [apiProfile, cliProfile] });
    const second = fixture({ listProfiles: () => [cliProfile, apiProfile] });
    first.answers.push("1", "1");
    second.answers.push("1", "1");
    await executeProgressiveInitCommand(options, first.runtime);
    await executeProgressiveInitCommand(options, second.runtime);
    expect(first.selectedProfiles).toEqual([CLI_ID]);
    expect(second.selectedProfiles).toEqual([CLI_ID]);
  });

  it("does not fall back when the selected profile authentication fails", async () => {
    const state = fixture({ authFor: async (profile) => { throw new Error(`auth failed for ${profile.id}`); } });
    state.answers.push("1", "1");
    await expect(executeProgressiveInitCommand(options, state.runtime)).rejects.toThrow(`auth failed for ${CLI_ID}`);
    expect(state.adapters).toEqual([CLI_ID]);
    expect(state.executeCalls()).toBe(0);
  });

  it("accepts a future selector without a registry entry only after explicit verification consent", async () => {
    const verified = {
      ...cliProfile,
      id: CLAUDE_CODE_TRANSPORT_PROFILE_ID,
      modelId: "claude-future-9-20270101",
      runtimeModel: {
        transportProfileId: CLAUDE_CODE_TRANSPORT_PROFILE_ID,
        transportVersion: "2.1.251 (Claude Code)",
        requestedModel: "claude-future-9",
        selectorKind: "alias" as const,
        resolvedModel: "claude-future-9-20270101",
        compatibilitySource: "runtime" as const,
      },
    };
    const verifiedSelectors: string[] = [];
    const state = fixture({
      inspectClaudeCodeModel: async (selector): Promise<ClaudeCodeCompatibilityInspection> => ({
        requestedModel: selector,
        state: "UNVERIFIED",
        transportVersion: "2.1.251 (Claude Code)",
      }),
      verifyClaudeCodeModel: async (selector) => {
        verifiedSelectors.push(selector);
        return verified;
      },
    });
    state.answers.push("1", "2", "claude-future-9", "yes");
    await executeProgressiveInitCommand(options, state.runtime);
    expect(verifiedSelectors).toEqual(["claude-future-9"]);
    expect(state.selectedProfiles).toEqual([CLAUDE_CODE_TRANSPORT_PROFILE_ID]);
    expect(state.writes.join("")).toContain("UNVERIFIED until compatibility verification succeeds");
  });

  it("does not verify or execute an unverified model without explicit consent", async () => {
    let verificationCalls = 0;
    const state = fixture({
      inspectClaudeCodeModel: async (selector) => ({ requestedModel: selector, state: "UNVERIFIED", transportVersion: "2.1.251 (Claude Code)" }),
      verifyClaudeCodeModel: async () => { verificationCalls += 1; return cliProfile; },
    });
    state.answers.push("1", "2", "sonnet", "no");
    await expect(executeProgressiveInitCommand(options, state.runtime)).rejects.toThrow(/MODEL_COMPATIBILITY_VERIFICATION_DECLINED/);
    expect(verificationCalls).toBe(0);
    expect(state.executeCalls()).toBe(0);
  });

  it("does not fall back or execute the stage when approved compatibility verification fails", async () => {
    const adapterSelections: string[] = [];
    const state = fixture({
      inspectClaudeCodeModel: async (selector) => ({ requestedModel: selector, state: "UNVERIFIED", transportVersion: "2.1.251 (Claude Code)" }),
      verifyClaudeCodeModel: async () => { throw new Error("MODEL_COMPATIBILITY_UNSUPPORTED: full conformance failed"); },
      adapterFor: (id) => { adapterSelections.push(id); return {} as ProviderAdapter; },
    });
    state.answers.push("1", "2", "sonnet", "yes");
    await expect(executeProgressiveInitCommand(options, state.runtime)).rejects.toThrow(/MODEL_COMPATIBILITY_UNSUPPORTED/);
    expect(adapterSelections).toEqual([]);
    expect(state.executeCalls()).toBe(0);
  });

  it("executes an explicit headless dynamic pair only with current evidence", async () => {
    const dynamic = {
      ...cliProfile,
      id: CLAUDE_CODE_TRANSPORT_PROFILE_ID,
      modelId: "claude-sonnet-5",
      runtimeModel: {
        transportProfileId: CLAUDE_CODE_TRANSPORT_PROFILE_ID,
        transportVersion: "2.1.251 (Claude Code)",
        requestedModel: "sonnet",
        selectorKind: "alias" as const,
        resolvedModel: "claude-sonnet-5",
        compatibilitySource: "runtime" as const,
      },
    };
    const supportedState = fixture({
      inspectClaudeCodeModel: async (selector) => ({ requestedModel: selector, resolvedModel: "claude-sonnet-5", state: "SUPPORTED", transportVersion: "2.1.251 (Claude Code)", target: dynamic }),
    });
    await executeProgressiveInitCommand({ ...options, headless: true, profileId: CLAUDE_CODE_TRANSPORT_PROFILE_ID, modelSelector: "sonnet" }, supportedState.runtime);
    expect(supportedState.selectedProfiles).toEqual([CLAUDE_CODE_TRANSPORT_PROFILE_ID]);

    const missingState = fixture({
      inspectClaudeCodeModel: async (selector) => ({ requestedModel: selector, state: "UNVERIFIED", transportVersion: "2.1.251 (Claude Code)" }),
    });
    await expect(executeProgressiveInitCommand({ ...options, headless: true, profileId: CLAUDE_CODE_TRANSPORT_PROFILE_ID, modelSelector: "sonnet" }, missingState.runtime)).rejects.toThrow(/MODEL_COMPATIBILITY_VERIFICATION_REQUIRED/);
    expect(missingState.executeCalls()).toBe(0);
  });

  it("rejects --model with a legacy exact profile instead of switching models", async () => {
    const state = fixture();
    await expect(executeProgressiveInitCommand({ ...options, profileId: CLI_ID, modelSelector: "sonnet" }, state.runtime)).rejects.toThrow(/MODEL_SELECTOR_CONFLICT/);
    expect(state.executeCalls()).toBe(0);
  });

  it("does no provider selection at all for a complete-fresh stage", async () => {
    const fresh: readonly ProgressiveStageSnapshot[] = [
      { stage: "project-description", status: "complete-fresh" },
      { stage: "user-stories", status: "incomplete" },
      { stage: "database-schema", status: "incomplete" },
      { stage: "project-phases", status: "incomplete" },
    ];
    let providerResolutionCalls = 0;
    const state = fixture({
      inspect: async () => fresh,
      listProfiles: () => { providerResolutionCalls += 1; return []; },
      listClaudeCodeModels: async () => { providerResolutionCalls += 1; return []; },
      execute: async (execution) => {
        expect(execution.profile).toBeUndefined();
        await execution.presentation?.stage("project-description", fresh);
        await execution.presentation?.complete?.("project-description", "existing-fresh");
        return { mode: "focused", selectedStage: "project-description", completedStage: "project-description", completionDisposition: "existing-fresh", semanticOperations: 0, correctiveRegenerations: 0 };
      },
    });
    await executeProgressiveInitCommand(options, state.runtime);
    expect(providerResolutionCalls).toBe(0);
    expect(state.writes.join("")).toContain("already complete and fresh");
  });
});
