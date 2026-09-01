import { describe, expect, it, vi } from "vitest";
import { DeepSeekAdapter, type DeepSeekTransport } from "../../../src/vnext/providers/deepseek/adapter.js";
import {
  DEEPSEEK_V4_FLASH_PROFILE,
  DEEPSEEK_V4_PRO_PROFILE,
} from "../../../src/vnext/providers/deepseek/profiles.js";
import { CONFORMANCE_CASES, REPRESENTATION_PAYLOAD, SEMANTICALLY_INCOMPLETE_PAYLOAD } from "../../../src/vnext/providers/conformance/fixtures.js";
import { sealRecord, type ConformanceRecord, type ConformanceRecordBody } from "../../../src/vnext/providers/conformance/recording.js";
import { replayConformance, validateConformanceRecord } from "../../../src/vnext/providers/conformance/runner.js";
import { CONFORMANCE_SUITE_VERSION, type ConformanceResult } from "../../../src/vnext/providers/conformance/suite.js";
import type { ModelProfile } from "../../../src/vnext/providers/contract.js";
import { deepSeekSse } from "./deepseek-helpers.js";

function noNetworkAdapter(counter = vi.fn()): DeepSeekAdapter {
  return new DeepSeekAdapter({
    async send() {
      counter();
      throw new Error("network forbidden during replay");
    },
  } as DeepSeekTransport);
}

function syntheticRecord(
  profile: ModelProfile = DEEPSEEK_V4_PRO_PROFILE,
  representationUsage?: Record<string, unknown>,
): ConformanceRecord {
  const representation = deepSeekSse(REPRESENTATION_PAYLOAD, {
    model: profile.modelId,
    ...(representationUsage === undefined ? {} : { usage: representationUsage }),
  });
  const incomplete = deepSeekSse(SEMANTICALLY_INCOMPLETE_PAYLOAD, { model: profile.modelId });
  const runId = "offline-deepseek-fixture-run";
  const recordedAt = "2026-09-01T12:00:00.000Z";
  const placeholder: ConformanceResult = {
    profileId: profile.id,
    suiteVersion: CONFORMANCE_SUITE_VERSION,
    runId,
    recordedAt,
    tier: "UNSUPPORTED",
    cases: [],
    normalizationsOnHappyPath: [],
    capabilitiesActuallyTested: [],
  };
  const body: ConformanceRecordBody = {
    format: "rb-adapter-conformance-record/v1",
    producer: "rb-harness-conformance-runner",
    profileId: profile.id,
    providerFamily: profile.family,
    modelId: profile.modelId,
    transport: "direct-api",
    requestAccounting: "exact",
    suiteVersion: CONFORMANCE_SUITE_VERSION,
    runId,
    recordedAt,
    rawResponses: {
      "representation-comprehensive": { origin: "local-transport-fixture", response: representation },
      "semantic-incomplete": { origin: "local-transport-fixture", response: incomplete },
      "derived-truncated": {
        origin: "derived-from-recording",
        derivedFrom: "representation-comprehensive",
        derivation: "offline test truncation",
        response: { ...representation, streamComplete: false },
      },
      "derived-malformed": {
        origin: "derived-from-recording",
        derivedFrom: "representation-comprehensive",
        derivation: "offline test corruption",
        response: { ...representation, body: "event: response.completed\ndata: {!}\n\n" },
      },
    },
    liveSmoke: {
      cancellation: { passed: true, errorKind: "cancelled", durationMs: 20, providerRequests: 1, promptAbort: true },
      timeout: { passed: true, errorKind: "timeout", durationMs: 5, providerRequests: 1, promptAbort: true },
    },
    result: placeholder,
  };
  const provisional = sealRecord(body);
  const result = replayConformance({ adapter: noNetworkAdapter(), profile, cases: CONFORMANCE_CASES, record: provisional });
  return sealRecord({ ...body, result });
}

describe("DeepSeek offline conformance integration", () => {
  it("replays deterministically with no network or credential access", () => {
    const network = vi.fn();
    const source = syntheticRecord();
    const first = validateConformanceRecord({
      adapter: noNetworkAdapter(network),
      profile: DEEPSEEK_V4_PRO_PROFILE,
      cases: CONFORMANCE_CASES,
      record: source,
    });
    const second = validateConformanceRecord({
      adapter: noNetworkAdapter(network),
      profile: DEEPSEEK_V4_PRO_PROFILE,
      cases: CONFORMANCE_CASES,
      record: source,
    });
    expect(first).toEqual(second);
    expect(network).not.toHaveBeenCalled();
    expect(first.normalizationsOnHappyPath).toEqual([]);
    expect(first.capabilitiesActuallyTested).toEqual(expect.arrayContaining([
      "structured-output:json-schema",
      "reasoning:enabled:low",
      "reasoning:disabled",
    ]));
  });

  it("passes all synthetic assertions without promoting the offline-only profile", () => {
    const result = syntheticRecord().result;
    expect(result.cases).toHaveLength(16);
    expect(result.cases.every((test) => test.passed)).toBe(true);
    expect(result.tier).toBe("SUPPORTED");
    expect(DEEPSEEK_V4_PRO_PROFILE.usageReporting).toMatchObject({
      reasoningTokens: true,
      cacheWriteTokens: false,
    });
    expect(DEEPSEEK_V4_PRO_PROFILE.conformance).toMatchObject({
      tier: "UNSUPPORTED",
      verifiedRecord: false,
      runId: null,
      recordedAt: null,
    });
  });

  it("passes 16/16 synthetic Flash assertions without promoting its source declaration", () => {
    const result = syntheticRecord(DEEPSEEK_V4_FLASH_PROFILE).result;
    expect(result.profileId).toBe("deepseek:deepseek-v4-flash");
    expect(result.cases).toHaveLength(16);
    expect(result.cases.every((test) => test.passed)).toBe(true);
    expect(result.tier).toBe("SUPPORTED");
    expect(DEEPSEEK_V4_FLASH_PROFILE.conformance).toMatchObject({
      tier: "UNSUPPORTED",
      verifiedRecord: false,
      runId: null,
      recordedAt: null,
    });
  });

  it("fails usage conformance when supported DeepSeek reasoning tokens are unmeasured", () => {
    const result = syntheticRecord(DEEPSEEK_V4_PRO_PROFILE, {
      input_tokens: 11,
      input_tokens_details: { cached_tokens: 3 },
      output_tokens: 7,
    }).result;
    expect(result.cases.find((test) => test.id === "usage-reporting")).toMatchObject({
      passed: false,
      diagnostic: "supported usage metric 'reasoningTokens' is unmeasured (not-reported-in-this-response)",
    });
    expect(result.tier).toBe("UNSUPPORTED");
  });

  it("normalizes a recorded response identically through direct replay", () => {
    const raw = deepSeekSse({ nested: { values: ["one", "two"] }, optional: null });
    const adapter = noNetworkAdapter();
    const conformanceRequest = CONFORMANCE_CASES.find((test) => test.id === "valid-structured-response")!.request();
    const first = adapter.replay(DEEPSEEK_V4_PRO_PROFILE, conformanceRequest, raw);
    const second = adapter.replay(DEEPSEEK_V4_PRO_PROFILE, conformanceRequest, raw);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      ok: true,
      value: {
        payload: { nested: { values: ["one", "two"] }, optional: null },
        usage: { providerRequests: { measured: true, value: 1 } },
      },
    });
  });
});
