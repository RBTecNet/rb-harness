import type { JsonSchemaDocument, SemanticRequest } from "../contract.js";
import type { ConformanceCase } from "./suite.js";

export const REPRESENTATION_PAYLOAD = {
  title: "transport-probe",
  mode: "alpha",
  nested: { level1: { level2: { value: "kept" } } },
  arrays: [[], ["one"], ["one", "two"]],
  optional: null,
} as const;

export const SEMANTICALLY_INCOMPLETE_PAYLOAD = { items: [] } as const;

const representationSchema: JsonSchemaDocument = {
  type: "object",
  additionalProperties: false,
  required: ["title", "mode", "nested", "arrays", "optional"],
  properties: {
    title: { type: "string" },
    mode: { type: "string", enum: ["alpha", "beta"] },
    nested: {
      type: "object",
      required: ["level1"],
      properties: {
        level1: {
          type: "object",
          required: ["level2"],
          properties: {
            level2: {
              type: "object",
              required: ["value"],
              properties: { value: { type: "string" } },
            },
          },
        },
      },
    },
    arrays: { type: "array", items: { type: "array", items: { type: "string" } } },
    optional: { anyOf: [{ type: "string" }, { type: "null" }] },
  },
};

const incompleteSchema: JsonSchemaDocument = {
  type: "object",
  additionalProperties: true,
  required: ["items"],
  properties: { items: { type: "array", items: {} } },
};

function signal(): AbortSignal {
  return new AbortController().signal;
}

function request(input: {
  slice: string;
  schema: JsonSchemaDocument;
  schemaName: string;
  instructions: string;
  text: string;
  reasoning?: SemanticRequest["reasoning"];
  maxOutputTokens?: number;
  suppliedSignal?: AbortSignal;
  deadlineMs?: number;
}): SemanticRequest {
  return {
    slice: input.slice,
    instructions: input.instructions,
    input: input.text,
    schema: input.schema,
    schemaName: input.schemaName,
    limits: { maxOutputTokens: input.maxOutputTokens ?? 1_024, deadlineMs: input.deadlineMs ?? 30_000 },
    reasoning: input.reasoning ?? { mode: "on", effort: "low" },
    signal: input.suppliedSignal ?? signal(),
  };
}

const representation = (suppliedSignal?: AbortSignal): SemanticRequest => request({
  slice: "representation-mechanics",
  schema: representationSchema,
  schemaName: "record_representation",
  instructions: "Copy the supplied JSON value into the available structured output.",
  text: JSON.stringify(REPRESENTATION_PAYLOAD),
  suppliedSignal,
});

const incomplete = (suppliedSignal?: AbortSignal): SemanticRequest => request({
  slice: "semantic-boundary-probe",
  schema: incompleteSchema,
  schemaName: "record_incomplete",
  instructions: "Copy the supplied JSON value into the available structured output.",
  text: JSON.stringify(SEMANTICALLY_INCOMPLETE_PAYLOAD),
  reasoning: { mode: "off" },
  suppliedSignal,
});

function representationCase(id: string, category: ConformanceCase["category"]): ConformanceCase {
  return {
    id,
    category,
    mandatory: true,
    happyPath: true,
    recordingKey: "representation-comprehensive",
    request: representation,
    expect: { kind: "payload-equals", value: REPRESENTATION_PAYLOAD },
  };
}

export const CONFORMANCE_CASES: readonly ConformanceCase[] = [
  representationCase("valid-structured-response", "valid-structured-response"),
  representationCase("nested-objects", "nested-objects"),
  representationCase("arrays", "arrays"),
  representationCase("enums", "enums"),
  representationCase("optional-null-fields", "optional-null-fields"),
  representationCase("unknown-provider-metadata", "unknown-provider-metadata"),
  representationCase("wrapper-envelope", "wrapper-envelope"),
  {
    id: "truncated-response",
    category: "truncated-response",
    mandatory: true,
    happyPath: false,
    recordingKey: "derived-truncated",
    request: representation,
    expect: { kind: "error", errorKind: "output-truncated" },
  },
  {
    id: "malformed-syntax",
    category: "malformed-syntax",
    mandatory: true,
    happyPath: false,
    recordingKey: "derived-malformed",
    request: representation,
    expect: { kind: "error", errorKind: "malformed-syntax" },
  },
  {
    id: "semantically-incomplete",
    category: "semantically-incomplete",
    mandatory: true,
    happyPath: true,
    recordingKey: "semantic-incomplete",
    request: incomplete,
    expect: { kind: "payload-equals", value: SEMANTICALLY_INCOMPLETE_PAYLOAD },
  },
  {
    id: "unsupported-structured-output",
    category: "unsupported-structured-output",
    mandatory: true,
    happyPath: false,
    profile: (profile) => ({ ...profile, structuredOutput: "none", toolCalling: false, toolChoiceForcing: false }),
    request: (suppliedSignal) => request({
      slice: "capability-probe",
      schema: incompleteSchema,
      schemaName: "unsupported_structured_output",
      instructions: "",
      text: "{}",
      suppliedSignal,
    }),
    expect: { kind: "capability-refusal" },
  },
  {
    id: "reasoning-enabled",
    category: "reasoning-enabled",
    mandatory: true,
    happyPath: true,
    recordingKey: "representation-comprehensive",
    request: representation,
    expect: { kind: "payload-equals", value: REPRESENTATION_PAYLOAD },
  },
  {
    id: "reasoning-disabled",
    category: "reasoning-disabled",
    mandatory: true,
    happyPath: true,
    recordingKey: "semantic-incomplete",
    request: incomplete,
    expect: { kind: "payload-equals", value: SEMANTICALLY_INCOMPLETE_PAYLOAD },
  },
  {
    id: "usage-reporting",
    category: "usage-reporting",
    mandatory: true,
    happyPath: true,
    recordingKey: "representation-comprehensive",
    request: representation,
    expect: {
      kind: "usage",
      required: ["inputTokens", "cachedInputTokens", "cacheWriteTokens", "outputTokens", "providerRequests"],
    },
  },
  {
    id: "cancellation",
    category: "cancellation",
    mandatory: true,
    happyPath: false,
    request: representation,
    expect: { kind: "live-smoke", errorKind: "cancelled" },
  },
  {
    id: "timeout",
    category: "timeout",
    mandatory: true,
    happyPath: false,
    request: representation,
    expect: { kind: "live-smoke", errorKind: "timeout" },
  },
];

export const LIVE_RECORDING_REQUESTS = {
  "representation-comprehensive": representation,
  "semantic-incomplete": incomplete,
} as const;
