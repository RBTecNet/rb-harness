import { describe, expect, it, vi } from "vitest";
import {
  assertDeepSeekRecordCandidateSanitized,
  recordDeepSeekConformance,
  sanitizeDeepSeekRawResponseForRecord,
} from "../../../src/vnext/providers/deepseek/record.js";
import { DeepSeekAdapter } from "../../../src/vnext/providers/deepseek/adapter.js";
import { DEEPSEEK_V4_PRO_PROFILE } from "../../../src/vnext/providers/deepseek/profiles.js";
import type { SemanticRequest } from "../../../src/vnext/providers/contract.js";
import { deepSeekSse } from "./deepseek-helpers.js";

const SENTINEL = "DEEPSEEK_SENTINEL_DO_NOT_LEAK_94af_record";

function request(): SemanticRequest {
  return {
    slice: "record-probe",
    instructions: "copy",
    input: "{}",
    schema: { type: "object" },
    schemaName: "record_probe",
    limits: { maxOutputTokens: 1_024, deadlineMs: 30_000 },
    reasoning: { mode: "on", effort: "low" },
    signal: new AbortController().signal,
  };
}

describe("DeepSeek record safety", () => {
  it("strips reasoning events and terminal reasoning items while retaining usage and replay semantics", () => {
    const raw = deepSeekSse({ value: "visible" }, { includeReasoning: true });
    const sanitized = sanitizeDeepSeekRawResponseForRecord(raw);
    expect(sanitized.body).not.toContain("private provider reasoning");
    expect(sanitized.body).not.toContain("response.reasoning_text.delta");
    expect(sanitized.body).not.toContain('"type":"reasoning"');
    expect(sanitized.body).toContain('"reasoning_tokens":2');
    expect(new DeepSeekAdapter().replay(DEEPSEEK_V4_PRO_PROFILE, request(), sanitized))
      .toMatchObject({ ok: true, value: { payload: { value: "visible" } } });
  });

  it("rejects exact active-secret occurrences regardless of key name or prefix", () => {
    for (const candidate of [
      { harmlessLookingField: SENTINEL },
      { response: { body: JSON.stringify({ error: { message: SENTINEL } }) } },
      { networkError: `socket closed near ${SENTINEL}` },
      { providerError: { code: "failed", detail: SENTINEL } },
    ]) {
      expect(() => assertDeepSeekRecordCandidateSanitized(candidate, SENTINEL)).toThrow(/active credential material/);
    }
    expect(() => assertDeepSeekRecordCandidateSanitized({ safe: "value" }, SENTINEL)).not.toThrow();
  });

  it("removes a sentinel contained only in provider reasoning before the exact-secret guard", () => {
    const raw = deepSeekSse({ visible: true }, { includeReasoning: true });
    const containingSentinel = {
      ...raw,
      body: raw.body.replaceAll("private provider reasoning", SENTINEL),
    };
    expect(() => assertDeepSeekRecordCandidateSanitized(containingSentinel, SENTINEL)).toThrow();
    const sanitized = sanitizeDeepSeekRawResponseForRecord(containingSentinel);
    expect(JSON.stringify(sanitized)).not.toContain(SENTINEL);
    expect(() => assertDeepSeekRecordCandidateSanitized(sanitized, SENTINEL)).not.toThrow();
  });

  it("refuses undeclared or mismatched DeepSeek identities before transport", async () => {
    const network = vi.fn();
    vi.stubGlobal("fetch", network);
    await expect(recordDeepSeekConformance(
      { ...DEEPSEEK_V4_PRO_PROFILE, id: "deepseek:undeclared", modelId: "deepseek-v4-flash" },
      { id: "deepseek:test", secret: SENTINEL, attributes: {} },
    )).rejects.toThrow(/restricted to declared DeepSeek profiles/);
    expect(network).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
