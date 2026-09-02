import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { OpenAiAdapter, type OpenAiTransport } from "../../../src/vnext/providers/openai/adapter.js";
import { OPENAI_GPT_5_6_SOL_PROFILE } from "../../../src/vnext/providers/openai/profiles.js";
import { CONFORMANCE_CASES, REPRESENTATION_PAYLOAD, SEMANTICALLY_INCOMPLETE_PAYLOAD } from "../../../src/vnext/providers/conformance/fixtures.js";
import { sealRecord, type ConformanceRecord, type ConformanceRecordBody } from "../../../src/vnext/providers/conformance/recording.js";
import { replayConformance, validateConformanceRecord } from "../../../src/vnext/providers/conformance/runner.js";
import { CONFORMANCE_SUITE_VERSION, type ConformanceResult } from "../../../src/vnext/providers/conformance/suite.js";
import { loadVerifiedProviderProfile, resolveProviderConformanceCases } from "../../../src/vnext/providers/registry.js";
import { openAiSse } from "./openai-helpers.js";

function noNetworkAdapter(counter = vi.fn()): OpenAiAdapter {
  return new OpenAiAdapter({ async send() { counter(); throw new Error("network forbidden during replay"); } } as OpenAiTransport);
}

function syntheticRecord(): ConformanceRecord {
  const representation = openAiSse(REPRESENTATION_PAYLOAD);
  const incomplete = openAiSse(SEMANTICALLY_INCOMPLETE_PAYLOAD);
  const runId = "offline-openai-fixture-run";
  const recordedAt = "2026-09-01T12:00:00.000Z";
  const placeholder: ConformanceResult = {
    profileId: OPENAI_GPT_5_6_SOL_PROFILE.id,
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
    profileId: OPENAI_GPT_5_6_SOL_PROFILE.id,
    providerFamily: "openai",
    modelId: OPENAI_GPT_5_6_SOL_PROFILE.modelId,
    transport: "direct-api",
    requestAccounting: "exact",
    suiteVersion: CONFORMANCE_SUITE_VERSION,
    runId,
    recordedAt,
    rawResponses: {
      "representation-comprehensive": { origin: "local-transport-fixture", response: representation },
      "semantic-incomplete": { origin: "local-transport-fixture", response: incomplete },
      "derived-truncated": { origin: "derived-from-recording", derivedFrom: "representation-comprehensive", derivation: "offline truncation", response: { ...representation, streamComplete: false } },
      "derived-malformed": { origin: "derived-from-recording", derivedFrom: "representation-comprehensive", derivation: "offline corruption", response: { ...representation, body: "event: response.completed\ndata: {!}\n\n" } },
    },
    liveSmoke: {
      cancellation: { passed: true, errorKind: "cancelled", durationMs: 20, providerRequests: 1, promptAbort: true },
      timeout: { passed: true, errorKind: "timeout", durationMs: 5, providerRequests: 1, promptAbort: true },
    },
    result: placeholder,
  };
  const provisional = sealRecord(body);
  const result = replayConformance({ adapter: noNetworkAdapter(), profile: OPENAI_GPT_5_6_SOL_PROFILE, cases: CONFORMANCE_CASES, record: provisional });
  return sealRecord({ ...body, result });
}

describe("OpenAI offline conformance", () => {
  it("uses the unchanged generic 16-case suite and passes synthetic replay", () => {
    expect(resolveProviderConformanceCases(OPENAI_GPT_5_6_SOL_PROFILE.id)).toBe(CONFORMANCE_CASES);
    const result = syntheticRecord().result;
    expect(result.cases).toHaveLength(16);
    expect(result.cases.every((entry) => entry.passed)).toBe(true);
    expect(result.tier).toBe("SUPPORTED");
    expect(OPENAI_GPT_5_6_SOL_PROFILE.conformance).toMatchObject({ tier: "UNSUPPORTED", verifiedRecord: false });
  });

  it("replays twice deterministically without transport", () => {
    const network = vi.fn();
    const record = syntheticRecord();
    const input = { adapter: noNetworkAdapter(network), profile: OPENAI_GPT_5_6_SOL_PROFILE, cases: CONFORMANCE_CASES, record };
    expect(validateConformanceRecord(input)).toEqual(validateConformanceRecord(input));
    expect(network).not.toHaveBeenCalled();
  });

  it("refuses runtime promotion when no packaged record exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "rb-openai-no-record-"));
    try {
      await expect(loadVerifiedProviderProfile(OPENAI_GPT_5_6_SOL_PROFILE.id, root)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
