import { describe, expect, it } from "vitest";
import { SemanticGateway } from "../../src/vnext/gateway.js";
import type { CorrectiveSemanticInput } from "../../src/vnext/run-state.js";
import {
  measured,
  unmeasured,
  type CanonicalSemanticResponse,
  type ModelProfile,
  type ProviderAdapter,
  type ProviderOutcome,
  type ResolvedProviderAuth,
  type SemanticRequest,
} from "../../src/vnext/providers/contract.js";
import { listProviderProfiles } from "../../src/vnext/providers/registry.js";
import { semanticReasoningForProfile } from "../../src/vnext/providers/reasoning.js";
import { preflightCodexSubscription } from "../../src/vnext/providers/openai/codex/adapter.js";
import { CODEX_SUBSCRIPTION_CONFORMANCE_CASES } from "../../src/vnext/providers/openai/codex/fixtures.js";
import { CODEX_SUBSCRIPTION_PROFILE } from "../../src/vnext/providers/openai/codex/profiles.js";
import type { WireOutcome } from "../../src/vnext/wire.js";

const conformance: ModelProfile["conformance"] = {
  tier: "SUPPORTED",
  suiteVersion: "fixture/v1",
  runId: "fixture-run",
  recordedAt: "2026-09-10T00:00:00.000Z",
  normalizationsOnHappyPath: [],
  verifiedRecord: true,
};

function profile(reasoning: ModelProfile["reasoning"]): ModelProfile {
  return {
    id: "fixture:reasoning",
    family: "fixture",
    transport: "direct-api",
    requestAccounting: "exact",
    modelId: "fixture-model",
    label: "Fixture reasoning profile",
    runtime: { kind: "built-in" },
    structuredOutput: "json-schema",
    strictSchema: false,
    toolCalling: false,
    toolChoiceForcing: false,
    reasoning,
    maxOutputTokens: 1_024,
    systemRole: "system",
    streaming: { supported: true, usageInStream: true },
    usageReporting: {
      inputTokens: true,
      cachedInputTokens: false,
      cacheWriteTokens: false,
      outputTokens: true,
      reasoningTokens: false,
      costUsd: false,
    },
    conformance,
  };
}

function success(request: SemanticRequest, payload: unknown): ProviderOutcome<CanonicalSemanticResponse> {
  return {
    ok: true,
    value: {
      slice: request.slice,
      payload,
      normalizations: [],
      usage: {
        inputTokens: measured(1),
        cachedInputTokens: unmeasured("not-reported-in-this-response"),
        cacheWriteTokens: unmeasured("not-reported-in-this-response"),
        outputTokens: measured(1),
        reasoningTokens: unmeasured("unsupported-by-provider"),
        providerRequests: measured(1),
        costUsd: unmeasured("unsupported-by-provider"),
      },
      transport: {
        startedAt: "2026-09-10T00:00:00.000Z",
        completedAt: "2026-09-10T00:00:00.001Z",
        firstOutputMs: measured(1),
        httpStatus: unmeasured("unsupported-by-provider"),
        requestId: unmeasured("unsupported-by-provider"),
        stopReason: measured("structured-output"),
      },
    },
  };
}

class CapturingAdapter implements ProviderAdapter {
  readonly family: string;
  readonly transport: ModelProfile["transport"];
  readonly profiles: readonly ModelProfile[];
  readonly requests: SemanticRequest[] = [];

  constructor(
    selectedProfile: ModelProfile,
    private readonly payloads: unknown[],
    private readonly preflight: (profile: ModelProfile, request: SemanticRequest) => ProviderOutcome<true> = () => ({ ok: true, value: true }),
  ) {
    this.family = selectedProfile.family;
    this.transport = selectedProfile.transport;
    this.profiles = [selectedProfile];
  }

  checkCapabilities(selectedProfile: ModelProfile, request: SemanticRequest): ProviderOutcome<true> {
    return this.preflight(selectedProfile, request);
  }

  async request(selectedProfile: ModelProfile, _auth: ResolvedProviderAuth, request: SemanticRequest): Promise<ProviderOutcome<CanonicalSemanticResponse>> {
    this.requests.push(request);
    const capability = this.preflight(selectedProfile, request);
    if (!capability.ok) return capability;
    if (!this.payloads.length) throw new Error("fixture payloads exhausted");
    return success(request, this.payloads.shift());
  }

  replay(): ProviderOutcome<CanonicalSemanticResponse> {
    throw new Error("not used");
  }
}

const auth: ResolvedProviderAuth = { kind: "ambient-session", id: "fixture" };

function correctiveInput(): CorrectiveSemanticInput {
  return {
    input: "corrected input",
    audit: {
      recoveryScope: {
        completeSliceRegeneration: true,
        rulesApplyGlobally: true,
        pointersArePreviousAttemptEvidence: true,
      },
      violatedRules: [],
      specificPreviousFindings: [],
      hashes: {
        originalRequestSha256: "fixture-original",
        authoritativeInputSha256: "fixture-authority",
        recoveryContextSha256: "fixture-recovery",
        correctiveInputSha256: "fixture-corrective",
      },
    },
  };
}

function operation(decode: (payload: unknown) => WireOutcome<true> = () => ({ ok: true, value: true })) {
  return {
    slice: "intent" as const,
    schema: {},
    schemaName: "fixture_reasoning",
    instructions: "Generate fixture semantics",
    input: "fixture input",
    correctiveInput,
    decode,
    signal: new AbortController().signal,
    deadlineMs: 1_000,
    maxOutputTokens: 100,
  };
}

describe("profile-aware semantic reasoning", () => {
  it("projects unsupported and supported/default-off profiles to reasoning off", () => {
    expect(semanticReasoningForProfile(profile({ supported: false }))).toEqual({ mode: "off" });
    expect(semanticReasoningForProfile(profile({
      supported: true,
      defaultMode: "off",
      efforts: ["high"],
      reportsReasoningTokens: false,
    }))).toEqual({ mode: "off" });
  });

  it("uses canonical low only when the profile explicitly allows it", () => {
    expect(semanticReasoningForProfile(profile({
      supported: true,
      defaultMode: "on",
      efforts: ["low"],
      reportsReasoningTokens: false,
    }))).toEqual({ mode: "on", effort: "low" });

    expect(semanticReasoningForProfile(profile({
      supported: true,
      defaultMode: "on",
      efforts: ["high", "low", "medium"],
      reportsReasoningTokens: false,
    }))).toEqual({ mode: "on", effort: "low" });
  });

  it("fails closed rather than inventing an effort when default-on authority omits low", () => {
    for (const efforts of [["medium", "high"], ["high"], []] as const) {
      expect(() => semanticReasoningForProfile(profile({
        supported: true,
        defaultMode: "on",
        efforts,
        reportsReasoningTokens: false,
      }))).toThrow("PROFILE_REASONING_EFFORT_REQUIRED");
    }
  });

  it("projects every currently registered supported-reasoning profile to one of its allowed efforts", () => {
    const supported = listProviderProfiles().filter((candidate) => candidate.reasoning.supported);
    expect(supported.length).toBeGreaterThan(0);
    for (const candidate of supported) {
      const reasoning = candidate.reasoning;
      if (!reasoning.supported) throw new Error(`inventory lost supported reasoning profile ${candidate.id}`);
      const projected = semanticReasoningForProfile(candidate);
      expect(reasoning.defaultMode).toBe("on");
      expect(projected).toEqual({ mode: "on", effort: "low" });
      expect(reasoning.efforts).toContain(projected.mode === "on" ? projected.effort : "");
    }
  });

  it("changes Gateway requests deterministically when profile reasoning authority changes", async () => {
    const unsupported = profile({ supported: false });
    const unsupportedAdapter = new CapturingAdapter(unsupported, [{ valid: true }]);
    await new SemanticGateway(unsupportedAdapter, unsupported, auth).generate(operation());
    expect(unsupportedAdapter.requests[0]!.reasoning).toEqual({ mode: "off" });

    const supported = profile({ supported: true, defaultMode: "on", efforts: ["low"], reportsReasoningTokens: false });
    const supportedAdapter = new CapturingAdapter(supported, [{ valid: true }]);
    await new SemanticGateway(supportedAdapter, supported, auth).generate(operation());
    expect(supportedAdapter.requests[0]!.reasoning).toEqual({ mode: "on", effort: "low" });
  });

  it("keeps the same immutable profile reasoning through corrective regeneration", async () => {
    const selectedProfile = profile({ supported: false });
    const adapter = new CapturingAdapter(selectedProfile, [{ valid: false }, { valid: true }]);
    const decode = (payload: unknown): WireOutcome<true> => (payload as { valid: boolean }).valid
      ? { ok: true, value: true }
      : { ok: false, findings: [{ code: "semantic-invalid", pointer: "/valid", message: "must be true" }] };
    await new SemanticGateway(adapter, selectedProfile, auth).generate(operation(decode));
    expect(adapter.requests.map((request) => request.reasoning)).toEqual([{ mode: "off" }, { mode: "off" }]);
    expect(adapter.requests[1]!.reasoning).toBe(adapter.requests[0]!.reasoning);
    expect(adapter.requests.every((request) => Object.isFrozen(request.reasoning))).toBe(true);
  });

  it("aligns the real Codex profile, Gateway projection, adapter preflight, and conformance requests", async () => {
    const codexProfile: ModelProfile = { ...CODEX_SUBSCRIPTION_PROFILE, conformance };
    const adapter = new CapturingAdapter(codexProfile, [{ valid: true }], preflightCodexSubscription);
    await new SemanticGateway(adapter, codexProfile, auth).generate(operation());
    const request = adapter.requests[0]!;
    expect(request.reasoning).toEqual({ mode: "off" });
    expect(preflightCodexSubscription(codexProfile, request)).toEqual({ ok: true, value: true });
    expect(CODEX_SUBSCRIPTION_CONFORMANCE_CASES.every((test) => (
      JSON.stringify(test.request().reasoning) === JSON.stringify(semanticReasoningForProfile(CODEX_SUBSCRIPTION_PROFILE))
    ))).toBe(true);

    expect(preflightCodexSubscription(codexProfile, {
      ...request,
      reasoning: { mode: "on", effort: "low" },
    })).toMatchObject({
      ok: false,
      error: {
        kind: "unsupported-capability",
        message: "Codex Subscription semantic mode does not accept per-request reasoning overrides",
      },
    });
  });
});
