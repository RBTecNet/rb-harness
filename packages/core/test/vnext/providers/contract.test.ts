import { describe, expect, it } from "vitest";
import {
  isRequestAccounting,
  measured,
  unmeasured,
  type CanonicalSemanticResponse,
  type ProviderErrorKind,
  type RequestAccounting,
} from "../../../src/vnext/providers/contract.js";

describe("provider contract", () => {
  it("keeps semantic payload unknown and errors transport/protocol-only", () => {
    const response: CanonicalSemanticResponse = {
      slice: "opaque",
      payload: { anything: true } as unknown,
      normalizations: [],
      usage: {
        inputTokens: measured(0), cachedInputTokens: unmeasured("not-reported-in-this-response"),
        cacheWriteTokens: unmeasured("unsupported-by-provider"), outputTokens: measured(0),
        reasoningTokens: unmeasured("unsupported-by-provider"), providerRequests: measured(1),
        costUsd: unmeasured("unsupported-by-provider"),
      },
      transport: {
        startedAt: "x", completedAt: "y", firstOutputMs: measured(0), httpStatus: measured(200),
        requestId: unmeasured("not-reported-in-this-response"), stopReason: measured("tool_use"),
      },
    };
    expect(response.payload).toEqual({ anything: true });
    expect(response.usage.inputTokens).toEqual({ measured: true, value: 0 });
    expect(response.usage.cachedInputTokens).toEqual({ measured: false, reason: "not-reported-in-this-response" });

    const kinds: ProviderErrorKind[] = [
      "auth", "rate-limit", "transport", "timeout", "cancelled", "output-truncated",
      "malformed-syntax", "unsupported-capability", "provider-error",
    ];
    expect(kinds).not.toContain("schema-mismatch");
    expect(kinds).not.toContain("semantic-invalid");
  });

  it("keeps exact and opaque provider accounting distinct", () => {
    const modes: RequestAccounting[] = ["exact", "opaque"];
    expect(modes.every(isRequestAccounting)).toBe(true);
    expect(isRequestAccounting("assistant-message-count")).toBe(false);
  });
});
