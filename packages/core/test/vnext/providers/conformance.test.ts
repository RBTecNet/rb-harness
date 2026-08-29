import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AnthropicAdapter, type AnthropicTransport } from "../../../src/vnext/providers/anthropic/adapter.js";
import { CLAUDE_OPUS_5_PROFILE } from "../../../src/vnext/providers/anthropic/profiles.js";
import { CONFORMANCE_CASES, REPRESENTATION_PAYLOAD, SEMANTICALLY_INCOMPLETE_PAYLOAD } from "../../../src/vnext/providers/conformance/fixtures.js";
import {
  readConformanceRecord,
  sealRecord,
  writeConformanceRecord,
  type ConformanceRecord,
  type ConformanceRecordBody,
} from "../../../src/vnext/providers/conformance/recording.js";
import { deriveConformanceTier, replayConformance, validateConformanceRecord } from "../../../src/vnext/providers/conformance/runner.js";
import { CONFORMANCE_SUITE_VERSION, MANDATORY_CATEGORIES, type ConformanceResult } from "../../../src/vnext/providers/conformance/suite.js";
import type { ModelProfile, NormalizationCode } from "../../../src/vnext/providers/contract.js";
import { anthropicSse } from "./helpers.js";
import { loadVerifiedProviderProfile } from "../../../src/vnext/providers/registry.js";
import {
  conformanceRecordsRootFromModulePath,
  defaultConformanceRecordsRoot,
  runVnextConformanceCommand,
} from "../../../src/vnext/providers/conformance/cli.js";

function noNetworkAdapter(counter = vi.fn()): AnthropicAdapter {
  return new AnthropicAdapter({
    async send() {
      counter();
      throw new Error("network forbidden during replay");
    },
  } as AnthropicTransport);
}

function record(): ConformanceRecord {
  const representation = anthropicSse(REPRESENTATION_PAYLOAD);
  const incomplete = anthropicSse(SEMANTICALLY_INCOMPLETE_PAYLOAD, { toolName: "record_incomplete" });
  const runId = "runner-produced-fixture-run";
  const recordedAt = "2026-08-28T12:00:00.000Z";
  const placeholder: ConformanceResult = {
    profileId: CLAUDE_OPUS_5_PROFILE.id,
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
    profileId: CLAUDE_OPUS_5_PROFILE.id,
    transport: "direct-api",
    suiteVersion: CONFORMANCE_SUITE_VERSION,
    runId,
    recordedAt,
    rawResponses: {
      "representation-comprehensive": { origin: "local-transport-fixture", response: representation },
      "semantic-incomplete": { origin: "local-transport-fixture", response: incomplete },
      "derived-truncated": { origin: "derived-from-recording", derivedFrom: "representation-comprehensive", derivation: "test truncation", response: { ...representation, streamComplete: false } },
      "derived-malformed": { origin: "derived-from-recording", derivedFrom: "representation-comprehensive", derivation: "test corruption", response: { ...representation, body: "data: {!}\n\n" } },
    },
    liveSmoke: {
      cancellation: { passed: true, errorKind: "cancelled", durationMs: 50, providerRequests: 1, promptAbort: true },
      timeout: { passed: true, errorKind: "timeout", durationMs: 5, providerRequests: 1, promptAbort: true },
    },
    result: placeholder,
  };
  const provisional = sealRecord(body);
  const result = replayConformance({ adapter: noNetworkAdapter(), profile: CLAUDE_OPUS_5_PROFILE, cases: CONFORMANCE_CASES, record: provisional });
  return sealRecord({ ...body, result });
}

describe("provider/model conformance runner", () => {
  it("participates in every mandatory category and returns deterministic supported replay", () => {
    for (const category of MANDATORY_CATEGORIES) {
      expect(CONFORMANCE_CASES.some((test) => test.mandatory && test.category === category), category).toBe(true);
    }
    const source = record();
    const first = replayConformance({ adapter: noNetworkAdapter(), profile: CLAUDE_OPUS_5_PROFILE, cases: CONFORMANCE_CASES, record: source });
    const second = replayConformance({ adapter: noNetworkAdapter(), profile: CLAUDE_OPUS_5_PROFILE, cases: CONFORMANCE_CASES, record: source });
    expect(first).toEqual(second);
    expect(first.tier).toBe("SUPPORTED");
    expect(first.normalizationsOnHappyPath).toEqual([]);
    expect(first.cases.every((test) => test.passed)).toBe(true);
    expect(first.cases.find((test) => test.id === "semantically-incomplete")).toMatchObject({ passed: true });
  });

  it("performs zero transport/network requests during replay", () => {
    const network = vi.fn();
    const source = record();
    const result = validateConformanceRecord({ adapter: noNetworkAdapter(network), profile: CLAUDE_OPUS_5_PROFILE, cases: CONFORMANCE_CASES, record: source });
    expect(result.tier).toBe("SUPPORTED");
    expect(network).not.toHaveBeenCalled();
  });

  it("binds support to the exact transport and rejects missing or unknown transport attribution", () => {
    const source = record();
    expect(validateConformanceRecord({ adapter: noNetworkAdapter(), profile: CLAUDE_OPUS_5_PROFILE, cases: CONFORMANCE_CASES, record: source }).tier)
      .toBe("SUPPORTED");

    const cliProfile = { ...CLAUDE_OPUS_5_PROFILE, transport: "claude-code-cli" } as unknown as ModelProfile;
    expect(() => validateConformanceRecord({ adapter: noNetworkAdapter(), profile: cliProfile, cases: CONFORMANCE_CASES, record: source }))
      .toThrow(/direct-api.*claude-code-cli/);

    const { integritySha256: _integrity, transport: _transport, ...missingBody } = source;
    const missing = sealRecord(missingBody as unknown as ConformanceRecordBody);
    expect(() => validateConformanceRecord({ adapter: noNetworkAdapter(), profile: CLAUDE_OPUS_5_PROFILE, cases: CONFORMANCE_CASES, record: missing }))
      .toThrow(/invalid conformance record transport: undefined/);

    const unknown = sealRecord({ ...missingBody, transport: "unknown-transport" } as unknown as ConformanceRecordBody);
    expect(() => validateConformanceRecord({ adapter: noNetworkAdapter(), profile: CLAUDE_OPUS_5_PROFILE, cases: CONFORMANCE_CASES, record: unknown }))
      .toThrow(/invalid conformance record transport: unknown-transport/);
  });

  it("rejects stale, mismatched, missing, and tampered records", async () => {
    const source = record();
    const { integritySha256: _integrity, ...cleanBody } = source;
    const stale = sealRecord({ ...cleanBody, suiteVersion: "rb-adapter-conformance/v0" });
    expect(() => validateConformanceRecord({ adapter: noNetworkAdapter(), profile: CLAUDE_OPUS_5_PROFILE, cases: CONFORMANCE_CASES, record: stale }))
      .toThrow(/stale/);

    const staleResult = sealRecord({
      ...cleanBody,
      result: { ...cleanBody.result, suiteVersion: "rb-adapter-conformance/v0" as typeof CONFORMANCE_SUITE_VERSION },
    });
    expect(() => validateConformanceRecord({ adapter: noNetworkAdapter(), profile: CLAUDE_OPUS_5_PROFILE, cases: CONFORMANCE_CASES, record: staleResult }))
      .toThrow("stale conformance result suite: result 'rb-adapter-conformance/v0', expected 'rb-adapter-conformance/v1'");

    const mismatch = sealRecord({ ...cleanBody, profileId: "anthropic:other" });
    expect(() => validateConformanceRecord({ adapter: noNetworkAdapter(), profile: CLAUDE_OPUS_5_PROFILE, cases: CONFORMANCE_CASES, record: mismatch }))
      .toThrow(/belongs to/);

    const root = await mkdtemp(resolve(tmpdir(), "rb-vnext-record-"));
    await expect(readConformanceRecord(root, CLAUDE_OPUS_5_PROFILE.id)).rejects.toThrow();
    const path = await writeConformanceRecord(root, source);
    expect(path).toContain("anthropic_claude-opus-5.json");
    expect((await readConformanceRecord(root, CLAUDE_OPUS_5_PROFILE.id)).runId).toBe(source.runId);
    expect(await loadVerifiedProviderProfile(CLAUDE_OPUS_5_PROFILE.id, root)).toMatchObject({
      conformance: { tier: "SUPPORTED", verifiedRecord: true, runId: source.runId },
    });

    const tampered = { ...source, result: { ...source.result, tier: "UNSUPPORTED" as const } };
    await expect(writeConformanceRecord(root, tampered)).rejects.toThrow(/integrity/);
  });

  it("enforces the normalization ceiling and semantic-normalization ban", () => {
    const cases = [{ id: "x", category: "arrays" as const, mandatory: true, passed: true, normalizations: [] }];
    expect(deriveConformanceTier({
      cases,
      happyPathCodes: ["a", "b", "c", "d"] as unknown as NormalizationCode[],
      semanticNormalizationRequired: false,
    })).toBe("UNSUPPORTED");
    expect(deriveConformanceTier({ cases, happyPathCodes: [], semanticNormalizationRequired: true })).toBe("UNSUPPORTED");
  });

  it("reports only reasoning modes and efforts actually exercised by suite requests", () => {
    const result = replayConformance({ adapter: noNetworkAdapter(), profile: CLAUDE_OPUS_5_PROFILE, cases: CONFORMANCE_CASES, record: record() });
    expect(result.capabilitiesActuallyTested).toEqual(expect.arrayContaining([
      "reasoning:enabled:low",
      "reasoning:disabled",
      "structured-output:forced-tool-argument",
      "preflight:unsupported-structured-output",
    ]));
    expect(result.capabilitiesActuallyTested).not.toEqual(expect.arrayContaining([
      "effort:medium", "effort:high", "effort:xhigh", "effort:max",
    ]));
  });

  it("makes the unsupported structured-output assertion a real zero-transport preflight", () => {
    const network = vi.fn();
    const result = replayConformance({ adapter: noNetworkAdapter(network), profile: CLAUDE_OPUS_5_PROFILE, cases: CONFORMANCE_CASES, record: record() });
    expect(result.cases.find((test) => test.id === "unsupported-structured-output")).toMatchObject({ passed: true });
    expect(network).not.toHaveBeenCalled();
  });

  it("cannot derive support when a mandatory case or live smoke fails", () => {
    const source = record();
    const { integritySha256: _integrity, ...cleanBody } = source;
    const failedBody = {
      ...cleanBody,
      liveSmoke: { ...source.liveSmoke, cancellation: { ...source.liveSmoke.cancellation, passed: false } },
      result: source.result,
    } as ConformanceRecordBody;
    const result = replayConformance({ adapter: noNetworkAdapter(), profile: CLAUDE_OPUS_5_PROFILE, cases: CONFORMANCE_CASES, record: sealRecord(failedBody) });
    expect(result.tier).toBe("UNSUPPORTED");
    expect(result.cases.find((test) => test.id === "cancellation")).toMatchObject({ passed: false });
  });

  it("discovers and replays the authoritative source record without dist or network", async () => {
    const coreRoot = resolve(import.meta.dirname, "../../..");
    const expected = resolve(coreRoot, "src/vnext/providers/conformance/records");
    expect(defaultConformanceRecordsRoot()).toBe(expected);
    expect(conformanceRecordsRootFromModulePath(resolve(coreRoot, "dist/cli.js")))
      .toBe(resolve(coreRoot, "dist/records"));

    const network = vi.fn(() => { throw new Error("network forbidden during authoritative replay"); });
    vi.stubGlobal("fetch", network);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runVnextConformanceCommand({ profileId: CLAUDE_OPUS_5_PROFILE.id, record: false });
    expect(write.mock.calls.flat().join("")).toContain("Transport: direct-api");
    expect(write.mock.calls.flat().join("")).toContain("Assertions: 16/16 passed");
    expect(write.mock.calls.flat().join("")).toContain("Tier: SUPPORTED");
    expect(network).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    write.mockRestore();
  });

  it("rejects credential fields even in an otherwise integrity-valid persisted record", async () => {
    const source = record();
    const { integritySha256: _integrity, ...body } = source;
    const unsafe = sealRecord({
      ...body,
      rawResponses: {
        ...body.rawResponses,
        unsafe: {
          origin: "local-transport-fixture",
          response: { headers: { "x-api-key": "sk-ant-never-persist" } },
        },
      },
    });
    const root = await mkdtemp(resolve(tmpdir(), "rb-vnext-unsafe-record-"));
    await expect(writeConformanceRecord(root, unsafe)).rejects.toThrow(/forbidden credential field/);
  });
});
