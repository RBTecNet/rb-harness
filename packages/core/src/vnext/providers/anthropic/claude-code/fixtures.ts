import type { JsonSchemaDocument, SemanticRequest } from "../../contract.js";
import { CONFORMANCE_CASES } from "../../conformance/fixtures.js";
import type { ConformanceCase, ConformanceCategory, RuntimeAssertionKey } from "../../conformance/suite.js";

function lowReasoning(test: ConformanceCase): ConformanceCase {
  return {
    ...test,
    request: (signal) => ({ ...test.request(signal), reasoning: { mode: "on", effort: "low" } }),
  };
}

const shared = CONFORMANCE_CASES
  .filter((test) => test.id !== "reasoning-disabled")
  .map(lowReasoning);

const baseRequest = shared.find((test) => test.id === "valid-structured-response")!.request;

function runtime(id: RuntimeAssertionKey, category: ConformanceCategory, key: RuntimeAssertionKey = id): ConformanceCase {
  return {
    id,
    category,
    mandatory: true,
    happyPath: false,
    request: baseRequest,
    expect: { kind: "runtime-assertion", key },
  };
}

export const CLAUDE_CODE_CONFORMANCE_CASES: readonly ConformanceCase[] = [
  ...shared,
  runtime("subscription-auth", "transport-auth"),
  runtime("environment-api-key-isolation", "transport-environment"),
  runtime("transport-version", "transport-version"),
  runtime("single-harness-invocation", "invocation-bounds"),
  runtime("opaque-provider-accounting", "invocation-bounds"),
  runtime("structured-output-retry-bound", "retry-bounds"),
  runtime("exact-model", "model-selection"),
  runtime("no-fallback", "model-selection"),
  runtime("no-agent-tools-or-mcp", "tool-isolation"),
  runtime("isolated-context", "session-isolation"),
  runtime("no-session-persistence", "session-isolation"),
];

export const STRUCTURED_OUTPUT_RETRY_PROBE_SCHEMA: JsonSchemaDocument = {
  type: "object",
  additionalProperties: false,
  required: ["value"],
  properties: {
    value: {
      type: "string",
      minLength: 2,
      maxLength: 1,
    },
  },
};

export function structuredOutputRetryProbe(signal = new AbortController().signal): SemanticRequest {
  return {
    slice: "structured-output-retry-bound",
    instructions: "Produce one structured value for the supplied input.",
    input: "{}",
    schema: STRUCTURED_OUTPUT_RETRY_PROBE_SCHEMA,
    schemaName: "retry_bound_probe",
    limits: { maxOutputTokens: 256, deadlineMs: 30_000 },
    reasoning: { mode: "on", effort: "low" },
    signal,
  };
}
