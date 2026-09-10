import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256Text } from "../../src/hash.js";
import { runSemanticInit } from "../../src/vnext/init.js";
import { INTENT_INSTRUCTIONS, correctiveIntentInput, intentInput } from "../../src/vnext/prompts.js";
import {
  legacyRequestEvidenceIsVerified,
  requestEvidenceCatalog,
  requestEvidenceIsVerified,
} from "../../src/vnext/provenance.js";
import {
  REJECTED_EVIDENCE_STRING_LIMIT,
  rejectedIntentFindingEvidence,
  type RejectedFindingEvidence,
} from "../../src/vnext/rejected-evidence.js";
import { CANONICAL_INIT_RECOVERY_BUDGET } from "../../src/vnext/recovery-budget.js";
import { modelFacingRecoveryContext } from "../../src/vnext/recovery-findings.js";
import type {
  CanonicalSemanticResponse,
  ModelProfile,
  ProviderAdapter,
  ProviderOutcome,
  ResolvedProviderAuth,
  SemanticRequest,
} from "../../src/vnext/providers/contract.js";
import { decodeIntentWire, deriveIntentSchema } from "../../src/vnext/wire.js";

const REQUEST = [
  "Build a tiny status service.",
  "Expose a health endpoint.",
  "npm start",
  "GET /health",
  "localStorage",
  "Do not modify docs/config.md.",
].join("\n");

const CANDIDATES = requestEvidenceCatalog(REQUEST).candidates;
const REDACTED_ENV_SECRET = "[REDACTED_ENV_SECRET]";
const BARE_ENV_ASSIGNMENTS = [
  ["password", "PASSWORD=hunter2value"],
  ["secret", "SECRET=bare-secret-value"],
  ["api-key", "API_KEY=bare-api-key-value"],
  ["access-token", "ACCESS_TOKEN=bare-access-token-value"],
  ["auth-token", "AUTH_TOKEN=bare-auth-token-value"],
] as const;
const LOWERCASE_ENV_ASSIGNMENTS = [
  ["lower-password", "password=lower-password-value"],
  ["lower-secret", "secret=lower-secret-value"],
  ["lower-api-key", "api_key=lower-api-key-value"],
  ["lower-access-token", "access_token=lower-access-token-value"],
  ["lower-auth-token", "auth_token=lower-auth-token-value"],
] as const;
const PREFIXED_ENV_ASSIGNMENTS = [
  ["openai-api-key", "OPENAI_API_KEY=prefixed-api-key-value"],
  ["my-secret", "MY_SECRET=prefixed-secret-value"],
  ["db-password", "DB_PASSWORD=prefixed-password-value"],
  ["service-access-token", "SERVICE_ACCESS_TOKEN=prefixed-access-token-value"],
] as const;
const DOUBLE_QUOTED_ENV_ASSIGNMENTS = [
  ["double-password-compact", 'PASSWORD="hunter2value"'],
  ["double-password-spaces", 'PASSWORD="hunter two value"'],
  ["double-secret", 'SECRET="alpha beta gamma"'],
  ["double-api-key", 'API_KEY="abc def ghi"'],
  ["double-access-token", 'ACCESS_TOKEN="token with spaces"'],
  ["double-auth-token", 'AUTH_TOKEN="token with spaces"'],
  ["double-db-password", 'DB_PASSWORD="hunter two value"'],
  ["double-openai-api-key", 'OPENAI_API_KEY="abc def ghi"'],
] as const;
const SINGLE_QUOTED_ENV_ASSIGNMENTS = [
  ["single-password-compact", "PASSWORD='hunter2value'"],
  ["single-password-spaces", "PASSWORD='hunter two value'"],
  ["single-secret", "SECRET='alpha beta gamma'"],
  ["single-api-key", "API_KEY='abc def ghi'"],
  ["single-db-password", "DB_PASSWORD='hunter two value'"],
  ["single-openai-api-key", "OPENAI_API_KEY='abc def ghi'"],
] as const;
const UNTERMINATED_DOUBLE_ENV_ASSIGNMENTS = [
  ["unterminated-double-password", 'PASSWORD="secret-alpha secret-beta secret-gamma'],
  ["unterminated-double-secret", 'SECRET="secret-alpha secret-beta secret-gamma'],
  ["unterminated-double-api-key", 'API_KEY="secret-alpha secret-beta secret-gamma'],
  ["unterminated-double-access-token", 'ACCESS_TOKEN="secret-alpha secret-beta secret-gamma'],
  ["unterminated-double-auth-token", 'AUTH_TOKEN="secret-alpha secret-beta secret-gamma'],
  ["unterminated-double-db-password", 'DB_PASSWORD="secret-alpha secret-beta secret-gamma'],
  ["unterminated-double-openai-api-key", 'OPENAI_API_KEY="secret-alpha secret-beta secret-gamma'],
  ["unterminated-double-lower-password", 'password="secret-alpha secret-beta secret-gamma'],
] as const;
const UNTERMINATED_SINGLE_ENV_ASSIGNMENTS = [
  ["unterminated-single-password", "PASSWORD='secret-alpha secret-beta secret-gamma"],
  ["unterminated-single-secret", "SECRET='secret-alpha secret-beta secret-gamma"],
  ["unterminated-single-api-key", "API_KEY='secret-alpha secret-beta secret-gamma"],
  ["unterminated-single-access-token", "ACCESS_TOKEN='secret-alpha secret-beta secret-gamma"],
  ["unterminated-single-auth-token", "AUTH_TOKEN='secret-alpha secret-beta secret-gamma"],
  ["unterminated-single-db-password", "DB_PASSWORD='secret-alpha secret-beta secret-gamma"],
  ["unterminated-single-openai-api-key", "OPENAI_API_KEY='secret-alpha secret-beta secret-gamma"],
  ["unterminated-single-lower-password", "password='secret-alpha secret-beta secret-gamma"],
] as const;
const TERMINAL_FAIL_SAFE_NAMES = [
  "PASSWORD",
  "SECRET",
  "API_KEY",
  "ACCESS_TOKEN",
  "AUTH_TOKEN",
  "DB_PASSWORD",
  "OPENAI_API_KEY",
  "password",
  "api_key",
] as const;
const BACKSLASH_NEWLINE = `${String.fromCharCode(92)}\n`;

function intentPayload(evidence: string = "GET /health"): any {
  return {
    format: "rb-init-intent/v1",
    project: { name: "status-service", objective: "Deliver a tiny service with a deterministic health endpoint." },
    determinations: [{
      key: "health-endpoint",
      statement: "The service exposes a health endpoint.",
      rationale: "The endpoint is explicit in the request.",
      materiality: "architecture",
      rigidity: "RIGID",
      sourceKind: "request",
      evidence,
    }],
    requirements: [{ key: "health-response", statement: "A health request returns a successful deterministic response." }],
    qualityCommands: [{ key: "test-suite", kind: "test", command: "npm test" }],
    proposedProtectedPaths: [],
    questions: [],
    contradictions: [],
  };
}

function workPayload(): unknown {
  return {
    format: "rb-init-work/v1",
    phases: [{
      key: "deliver-status",
      title: "Deliver the status service",
      goal: "Provide a tested deterministic health response.",
      dependsOn: [],
      tasks: [{
        key: "implement-health",
        title: "Implement health behavior",
        intent: "Implement the health response and its automated verification.",
        dependsOn: [],
        ownedPaths: ["src/status.ts", "test/status.test.ts"],
        covers: ["health-response"],
        acceptance: ["A GET /health request returns HTTP 200 with the exact response body ok."],
        validation: [{ kind: "command", value: "test-suite" }],
        expectedEvidence: "Status source, automated test source, and passing npm test output.",
      }],
    }],
  };
}

const profile: ModelProfile = {
  id: "fixture:closed-evidence",
  family: "fixture",
  transport: "direct-api",
  requestAccounting: "exact",
  modelId: "fixture-model",
  label: "Closed evidence fixture",
  runtime: { kind: "built-in" },
  structuredOutput: "forced-tool-argument",
  strictSchema: false,
  toolCalling: false,
  toolChoiceForcing: false,
  reasoning: { supported: true, defaultMode: "on", efforts: ["low"], reportsReasoningTokens: false },
  maxOutputTokens: 128_000,
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
  conformance: {
    tier: "SUPPORTED",
    suiteVersion: "fixture/v1",
    runId: "closed-evidence-fixture",
    recordedAt: "2026-09-10T00:00:00.000Z",
    normalizationsOnHappyPath: [],
    verifiedRecord: true,
  },
};

const auth: ResolvedProviderAuth = { kind: "ambient-session", id: "fixture" };

class CapturingAdapter implements ProviderAdapter {
  readonly family = "fixture";
  readonly transport = "direct-api" as const;
  readonly profiles = [profile];
  readonly requests: SemanticRequest[] = [];

  constructor(private readonly script: unknown[]) {}

  checkCapabilities(): ProviderOutcome<true> {
    return { ok: true, value: true };
  }

  async request(
    _profile: ModelProfile,
    _auth: ResolvedProviderAuth,
    request: SemanticRequest,
  ): Promise<ProviderOutcome<CanonicalSemanticResponse>> {
    this.requests.push(request);
    const payload = this.script.shift();
    if (!payload) throw new Error("fixture script exhausted");
    return {
      ok: true,
      value: {
        slice: request.slice,
        payload: structuredClone(payload),
        normalizations: [],
        usage: {
          inputTokens: { measured: true, value: 1 },
          cachedInputTokens: { measured: false, reason: "not-reported-in-this-response" },
          cacheWriteTokens: { measured: false, reason: "not-reported-in-this-response" },
          outputTokens: { measured: true, value: 1 },
          reasoningTokens: { measured: false, reason: "unsupported-by-provider" },
          providerRequests: { measured: true, value: 1 },
          costUsd: { measured: false, reason: "unsupported-by-provider" },
        },
        transport: {
          startedAt: "2026-09-10T00:00:00.000Z",
          completedAt: "2026-09-10T00:00:00.001Z",
          firstOutputMs: { measured: true, value: 1 },
          httpStatus: { measured: false, reason: "unsupported-by-provider" },
          requestId: { measured: false, reason: "unsupported-by-provider" },
          stopReason: { measured: true, value: "structured-output" },
        },
      },
    };
  }

  replay(): ProviderOutcome<CanonicalSemanticResponse> {
    throw new Error("unused");
  }
}

async function recoveryRun(firstIntent: unknown, runId: string) {
  const projectRoot = await mkdtemp(resolve(tmpdir(), "rb-closed-evidence-"));
  const adapter = new CapturingAdapter([firstIntent, intentPayload(), workPayload()]);
  const result = await runSemanticInit({
    originalRequest: REQUEST,
    projectRoot,
    profile,
    adapter,
    auth,
    interview: { kind: "headless" },
    runId,
    now: () => "2026-09-10T00:00:00.000Z",
  });
  return { projectRoot, adapter, result };
}

function protectedPathIntentPayload(evidence: string): any {
  const payload = intentPayload();
  payload.proposedProtectedPaths = [{
    path: "docs/config.md",
    reason: "The request explicitly protects this file.",
    sourceKind: "request",
    evidence,
  }];
  return payload;
}

const securityRunCache = new Map<string, ReturnType<typeof recoveryRun>>();

function securityRecoveryRun(kind: "determination" | "protected-path", label: string, evidence: string) {
  const cacheKey = `${kind}:${label}`;
  let result = securityRunCache.get(cacheKey);
  if (!result) {
    result = recoveryRun(
      kind === "determination" ? intentPayload(evidence) : protectedPathIntentPayload(evidence),
      `redaction-${kind}-${label}`,
    );
    securityRunCache.set(cacheKey, result);
  }
  return result;
}

async function persistedSecurityDiagnostic(
  kind: "determination" | "protected-path",
  label: string,
  rawValue: string,
) {
  const pointer = kind === "determination"
    ? "/determinations/0/evidence"
    : "/proposedProtectedPaths/0/evidence";
  const { adapter, result } = await securityRecoveryRun(kind, label, rawValue);
  const persisted = await readFile(result.runStatePath, "utf8");
  const correction = adapter.requests[1]!.input;
  const diagnostic = result.runState.attempts[0]?.rejectedFindings?.find((entry) => entry.pointer === pointer);
  if (!diagnostic) throw new Error(`missing rejected diagnostic for ${pointer}`);
  return { adapter, result, persisted, correction, diagnostic };
}

function directRejectedDiagnostic(payload: any, pointer: string): RejectedFindingEvidence {
  let rejected: readonly RejectedFindingEvidence[] = [];
  const decoded = decodeIntentWire(payload, REQUEST, (candidate, findings) => {
    rejected = rejectedIntentFindingEvidence(candidate, findings, payload);
  });
  if (decoded.ok) throw new Error("expected rejected intent fixture");
  const diagnostic = rejected.find((entry) => entry.pointer === pointer);
  if (!diagnostic) throw new Error(`missing rejected diagnostic for ${pointer}`);
  return diagnostic;
}

let cachedInvalidRun: Awaited<ReturnType<typeof recoveryRun>> | undefined;
async function invalidRecoveryRun() {
  cachedInvalidRun ??= await recoveryRun(intentPayload("a rewritten health endpoint"), "invalid-evidence-run");
  return cachedInvalidRun;
}

function intentSchemaBranches() {
  const schema = deriveIntentSchema(REQUEST) as any;
  return {
    schema,
    determinationRequest: schema.properties.determinations.items.oneOf[0],
    determinationDefault: schema.properties.determinations.items.oneOf[1],
    protectedRequest: schema.properties.proposedProtectedPaths.items.oneOf[0],
    protectedQuestion: schema.properties.proposedProtectedPaths.items.oneOf[1],
  };
}

describe("P1 closed request evidence authority mutation matrix", () => {
  it("E1 schema cannot regress request evidence to an arbitrary string", () => {
    const { determinationRequest } = intentSchemaBranches();
    expect(determinationRequest.properties.evidence).toEqual({ type: "string", enum: CANDIDATES });
    expect(determinationRequest.properties.evidence.enum).not.toContain("a rewritten health endpoint");
  });

  it("E2 schema and decoder both require request evidence", () => {
    const { determinationRequest } = intentSchemaBranches();
    expect(determinationRequest.required).toContain("evidence");
    const payload = intentPayload();
    delete payload.determinations[0].evidence;
    const decoded = decodeIntentWire(payload, REQUEST);
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.findings).toContainEqual(expect.objectContaining({
      pointer: "/determinations/0/evidence",
      message: expect.stringContaining("is required"),
    }));
  });

  it("E3 decoder rejects an arbitrary substring even when the request contains it", () => {
    expect(legacyRequestEvidenceIsVerified(REQUEST, "health endpoint")).toBe(true);
    const decoded = decodeIntentWire(intentPayload("health endpoint"), REQUEST);
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.findings).toContainEqual(expect.objectContaining({
      pointer: "/determinations/0/evidence",
      message: expect.stringContaining("exactly select"),
    }));
  });

  it("E4 exact short catalog candidates are authority without old token thresholds", () => {
    for (const evidence of ["npm start", "GET /health", "localStorage"]) {
      expect(legacyRequestEvidenceIsVerified(REQUEST, evidence)).toBe(false);
      expect(requestEvidenceIsVerified(REQUEST, evidence)).toBe(true);
      expect(decodeIntentWire(intentPayload(evidence), REQUEST).ok).toBe(true);
    }
  });

  it("E5 decoder rejects combined catalog candidates", () => {
    expect(decodeIntentWire(intentPayload("npm start GET /health"), REQUEST).ok).toBe(false);
  });

  it("E6 decoder rejects a paraphrased catalog candidate", () => {
    expect(decodeIntentWire(intentPayload("Expose the health endpoint."), REQUEST).ok).toBe(false);
  });

  it("E7 cross-request replay fails", () => {
    const requestB = "Build an unrelated calculator.\nPOST /sum";
    expect(requestEvidenceIsVerified(requestB, "GET /health")).toBe(false);
    expect(decodeIntentWire(intentPayload("GET /health"), requestB).ok).toBe(false);
  });

  it("E8 model-default cannot claim request evidence in schema or decoder", () => {
    const { determinationDefault } = intentSchemaBranches();
    expect(determinationDefault.properties).not.toHaveProperty("evidence");
    const payload = intentPayload();
    payload.determinations[0].sourceKind = "model-default";
    const decoded = decodeIntentWire(payload, REQUEST);
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.findings).toContainEqual(expect.objectContaining({
      pointer: "/determinations/0/evidence",
      message: "model-default determination must not claim request evidence",
    }));
  });

  it("E9 rejected determination evidence is persisted as bounded diagnostic evidence", async () => {
    const { result } = await invalidRecoveryRun();
    expect(result.runState.attempts[0]?.rejectedFindings).toEqual([expect.objectContaining({
      pointer: "/determinations/0/evidence",
      value: "a rewritten health endpoint",
      valueSha256: sha256Text("a rewritten health endpoint"),
      rule: "request-evidence-selection",
    })]);
  });

  it("E10 corrective input retains the immediately previous rejected value", async () => {
    const { adapter } = await invalidRecoveryRun();
    const correction = JSON.parse(adapter.requests[1]!.input);
    expect(correction.previousRejectedEvidence).toEqual([expect.objectContaining({
      pointer: "/determinations/0/evidence",
      value: "a rewritten health endpoint",
      valueSha256: sha256Text("a rewritten health endpoint"),
    })]);
    expect(correction.specificPreviousFindings).toContainEqual(expect.objectContaining({
      pointer: "/determinations/0/evidence",
      message: expect.stringContaining("was not an exact requestEvidenceCandidates selection"),
    }));
  });

  it("E11 corrective input includes the complete closed candidate set", async () => {
    const { adapter } = await invalidRecoveryRun();
    expect(JSON.parse(adapter.requests[1]!.input).requestEvidenceCandidates).toEqual(CANDIDATES);
  });

  it("E12 request evidence findings produce the global closed-selection recovery rule", async () => {
    const { adapter } = await invalidRecoveryRun();
    const correction = JSON.parse(adapter.requests[1]!.input);
    expect(correction.violatedRules).toContainEqual(expect.objectContaining({
      rule: "request-evidence-selection",
      constraint: expect.stringContaining("COMPLETE regenerated intent slice"),
    }));
    expect(correction.violatedRules[0].constraint).toContain("Do not shorten, combine, paraphrase, rewrite, or invent evidence");
  });

  it("E13 protected-path request evidence uses the same closed schema and decoder authority", () => {
    const { protectedRequest, protectedQuestion } = intentSchemaBranches();
    expect(protectedRequest.properties.evidence).toEqual({ type: "string", enum: CANDIDATES });
    expect(protectedRequest.required).toContain("evidence");
    expect(protectedQuestion.properties).not.toHaveProperty("evidence");
    const valid = intentPayload();
    valid.proposedProtectedPaths = [{
      path: "docs/config.md",
      reason: "The request explicitly protects this file.",
      sourceKind: "request",
      evidence: "Do not modify docs/config.md.",
    }];
    expect(decodeIntentWire(valid, REQUEST).ok).toBe(true);
    const missing = structuredClone(valid);
    delete missing.proposedProtectedPaths[0].evidence;
    expect(decodeIntentWire(missing, REQUEST).ok).toBe(false);
    valid.proposedProtectedPaths[0].evidence = "do not change the config";
    let rejected: readonly RejectedFindingEvidence[] = [];
    const invalid = decodeIntentWire(valid, REQUEST, (candidate, findings) => {
      rejected = rejectedIntentFindingEvidence(candidate, findings, valid);
    });
    expect(invalid.ok).toBe(false);
    expect(rejected).toContainEqual(expect.objectContaining({
      pointer: "/proposedProtectedPaths/0/evidence",
      value: "do not change the config",
      valueSha256: sha256Text("do not change the config"),
      rule: "request-evidence-selection",
    }));
  });

  it("E14 secret-shaped rejected evidence is redacted before persistence", async () => {
    const poisons = [
      "Bearer secret-token-value",
      "sk-ant-secretvalue123",
      "OPENAI_API_KEY=secretvalue123",
      "/home/bruno/private/request.txt",
    ];
    const poison = poisons.join(" ");
    const poisonedPayload = intentPayload(poison);
    poisonedPayload.project.objective = "PROVIDER_PAYLOAD_SENTINEL_MUST_NOT_PERSIST";
    const { adapter, result } = await recoveryRun(poisonedPayload, "secret-evidence-run");
    const persisted = await readFile(result.runStatePath, "utf8");
    const correction = adapter.requests[1]!.input;
    expect(persisted).not.toContain("PROVIDER_PAYLOAD_SENTINEL_MUST_NOT_PERSIST");
    for (const secret of poisons) {
      const serialized = `${persisted}\n${correction}`;
      expect(serialized).not.toContain(secret);
    }
    expect(persisted).toContain("[REDACTED_TOKEN]");
    expect(persisted).toContain("[REDACTED]");
    expect(persisted).toContain("[REDACTED_ENV_SECRET]");
    expect(persisted).toContain("/home/[REDACTED]/");
    for (const evidence of result.runState.attempts[0]?.rejectedFindings ?? []) {
      const serialized = JSON.stringify(evidence);
      expect(serialized).not.toContain(poison);
      expect(evidence.valueSha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("E15 SemanticGateway carries persisted rejected diagnostics into correction", async () => {
    const { adapter, result } = await invalidRecoveryRun();
    const prior = result.runState.attempts[0]!.rejectedFindings;
    const correction = JSON.parse(adapter.requests[1]!.input);
    expect(result.runState.attempts.slice(0, 2).map((attempt) => attempt.status)).toEqual(["semantic-invalid", "accepted"]);
    expect(result.runState.counters).toMatchObject({ correctiveRegenerations: 1, correctiveBySlice: { intent: 1, work: 0 } });
    expect(correction.previousRejectedEvidence).toEqual(prior);
    expect(result.runState.attempts[1]?.recovery?.hashes.correctiveInputSha256)
      .toBe(sha256Text(adapter.requests[1]!.input));
  });

  it("E16 the frozen recovery budget is unchanged", () => {
    expect(CANONICAL_INIT_RECOVERY_BUDGET).toEqual({
      maxCorrectiveRegenerationsPerSlice: 2,
      maxCorrectiveRegenerationsPerRun: 3,
      maxSemanticOperationsPerRun: 5,
      maxTransportInvocationsPerRun: 7,
      maxTransportRetriesPerSemanticOperation: 1,
      maxTransportRetriesPerRun: 2,
    });
  });
});

describe("P1 rejected evidence redaction security mutation matrix", () => {
  it("S1 restoring the prefix-required regex leaks the shipped bare-name fixtures", async () => {
    for (const [label, rawValue] of [...BARE_ENV_ASSIGNMENTS, ...LOWERCASE_ENV_ASSIGNMENTS, ...PREFIXED_ENV_ASSIGNMENTS]) {
      const { persisted, correction, diagnostic } = await persistedSecurityDiagnostic("determination", label, rawValue);
      const secretValue = rawValue.slice(rawValue.indexOf("=") + 1);
      expect(diagnostic).toMatchObject({
        pointer: "/determinations/0/evidence",
        value: REDACTED_ENV_SECRET,
        valueSha256: sha256Text(REDACTED_ENV_SECRET),
      });
      expect(`${persisted}\n${correction}`).not.toContain(rawValue);
      expect(`${persisted}\n${correction}`).not.toContain(secretValue);
    }
  });

  it("S2 bare PASSWORD assignment cannot survive determination persistence", async () => {
    const rawValue = BARE_ENV_ASSIGNMENTS[0][1];
    const { persisted, diagnostic } = await persistedSecurityDiagnostic("determination", "password", rawValue);
    expect(diagnostic.value).toBe(REDACTED_ENV_SECRET);
    expect(persisted).not.toContain("hunter2value");
  });

  it("S3 bare API_KEY assignment cannot survive determination persistence", async () => {
    const rawValue = BARE_ENV_ASSIGNMENTS[2][1];
    const { persisted, diagnostic } = await persistedSecurityDiagnostic("determination", "api-key", rawValue);
    expect(diagnostic.value).toBe(REDACTED_ENV_SECRET);
    expect(persisted).not.toContain("bare-api-key-value");
  });

  it("S4 lowercase password assignment cannot survive determination persistence", async () => {
    const rawValue = LOWERCASE_ENV_ASSIGNMENTS[0][1];
    const { persisted, diagnostic } = await persistedSecurityDiagnostic("determination", "lower-password", rawValue);
    expect(diagnostic.value).toBe(REDACTED_ENV_SECRET);
    expect(persisted).not.toContain("lower-password-value");
  });

  it("S5 protected-path rejected evidence uses the same redaction boundary", async () => {
    for (const [label, rawValue] of [...BARE_ENV_ASSIGNMENTS, ...LOWERCASE_ENV_ASSIGNMENTS, ...PREFIXED_ENV_ASSIGNMENTS]) {
      const { persisted, correction, diagnostic } = await persistedSecurityDiagnostic("protected-path", label, rawValue);
      const secretValue = rawValue.slice(rawValue.indexOf("=") + 1);
      expect(diagnostic).toMatchObject({
        pointer: "/proposedProtectedPaths/0/evidence",
        value: REDACTED_ENV_SECRET,
        valueSha256: sha256Text(REDACTED_ENV_SECRET),
      });
      expect(`${persisted}\n${correction}`).not.toContain(rawValue);
      expect(`${persisted}\n${correction}`).not.toContain(secretValue);
    }
  });

  it("S6 SemanticGateway forwards only the redacted diagnostic to corrective input", async () => {
    const rawValue = BARE_ENV_ASSIGNMENTS[0][1];
    const { adapter, result, correction, diagnostic } = await persistedSecurityDiagnostic("determination", "password", rawValue);
    const correctiveValue = JSON.parse(correction);
    expect(correctiveValue.previousRejectedEvidence).toContainEqual(diagnostic);
    expect(correctiveValue.previousRejectedEvidence).toContainEqual(expect.objectContaining({ value: REDACTED_ENV_SECRET }));
    expect(correction).not.toContain("hunter2value");
    expect(result.runState.attempts[1]?.recovery?.hashes.correctiveInputSha256)
      .toBe(sha256Text(adapter.requests[1]!.input));
  });

  it("S7 valueSha256 hashes the sanitized untruncated value, never the raw secret", async () => {
    const rawValue = BARE_ENV_ASSIGNMENTS[0][1];
    const { diagnostic } = await persistedSecurityDiagnostic("determination", "password", rawValue);
    expect(diagnostic.valueSha256).toBe(sha256Text(REDACTED_ENV_SECRET));
    expect(diagnostic.valueSha256).not.toBe(sha256Text(rawValue));
  });

  it("redacts before applying the existing 512-character truncation boundary", async () => {
    const rawSecret = "x".repeat(700);
    const safeTail = "safe-context ".repeat(80);
    const rawValue = `PASSWORD=${rawSecret} ${safeTail}`;
    const sanitizedValue = `${REDACTED_ENV_SECRET} ${safeTail}`;
    const { persisted, correction, diagnostic } = await persistedSecurityDiagnostic("determination", "long-password", rawValue);
    expect(diagnostic.value).toBe(sanitizedValue.slice(0, REJECTED_EVIDENCE_STRING_LIMIT));
    expect(diagnostic.value).toHaveLength(REJECTED_EVIDENCE_STRING_LIMIT);
    expect(diagnostic.valueTruncated).toBe(true);
    expect(diagnostic.valueSha256).toBe(sha256Text(sanitizedValue));
    expect(diagnostic.valueSha256).not.toBe(sha256Text(rawValue));
    expect(`${persisted}\n${correction}`).not.toContain("x".repeat(64));
  });

  it("preserves Bearer, authorization, x-api-key, sk-ant, home-path, and prefixed assignment redaction", () => {
    const fixtures = [
      ["Bearer bearer-private-value", "[REDACTED_TOKEN]"],
      ["authorization: Bearer authorization-private-value", "[REDACTED_HEADER]"],
      ["x-api-key=x-api-private-value", "[REDACTED_HEADER]"],
      ["sk-ant-privatevalue123", "[REDACTED]"],
      ["/home/bruno/private/path", "/home/[REDACTED]/private/path"],
      ...PREFIXED_ENV_ASSIGNMENTS.map(([, value]) => [value, REDACTED_ENV_SECRET] as const),
    ] as const;
    for (const [rawValue, sanitizedValue] of fixtures) {
      const diagnostic = directRejectedDiagnostic(intentPayload(rawValue), "/determinations/0/evidence");
      expect(diagnostic.value).toBe(sanitizedValue);
      expect(diagnostic.valueSha256).toBe(sha256Text(sanitizedValue));
      expect(JSON.stringify(diagnostic)).not.toContain(rawValue);
    }
  });

  it("does not redact ordinary non-assignment prose", () => {
    for (const prose of ["password field", "secret management", "API key support", "reset password flow", "access token support"]) {
      const diagnostic = directRejectedDiagnostic(intentPayload(prose), "/determinations/0/evidence");
      expect(diagnostic.value).toBe(prose);
      expect(diagnostic.valueSha256).toBe(sha256Text(prose));
    }
  });

  it("S8/Q1/Q2 redacts each complete double-quoted assignment atomically", () => {
    for (const [, rawValue] of DOUBLE_QUOTED_ENV_ASSIGNMENTS) {
      const diagnostic = directRejectedDiagnostic(intentPayload(rawValue), "/determinations/0/evidence");
      expect(diagnostic.value).toBe(REDACTED_ENV_SECRET);
      expect(diagnostic.valueSha256).toBe(sha256Text(REDACTED_ENV_SECRET));
      expect(JSON.stringify(diagnostic)).not.toContain(rawValue.slice(rawValue.indexOf("=") + 2, -1));
    }
  });

  it("S8/Q3 redacts each complete single-quoted assignment atomically", () => {
    for (const [, rawValue] of SINGLE_QUOTED_ENV_ASSIGNMENTS) {
      const diagnostic = directRejectedDiagnostic(intentPayload(rawValue), "/determinations/0/evidence");
      expect(diagnostic.value).toBe(REDACTED_ENV_SECRET);
      expect(diagnostic.valueSha256).toBe(sha256Text(REDACTED_ENV_SECRET));
      expect(JSON.stringify(diagnostic)).not.toContain(rawValue.slice(rawValue.indexOf("=") + 2, -1));
    }
  });

  it("redacts escaped quotes inside double- and single-quoted values", () => {
    for (const rawValue of [
      'PASSWORD="escaped-alpha \\"escaped-beta\\" escaped-gamma"',
      "PASSWORD='escaped-alpha \\'escaped-beta\\' escaped-gamma'",
    ]) {
      const diagnostic = directRejectedDiagnostic(intentPayload(rawValue), "/determinations/0/evidence");
      expect(diagnostic.value).toBe(REDACTED_ENV_SECRET);
      expect(JSON.stringify(diagnostic)).not.toContain("escaped-alpha");
      expect(JSON.stringify(diagnostic)).not.toContain("escaped-beta");
      expect(JSON.stringify(diagnostic)).not.toContain("escaped-gamma");
    }
  });

  it("S8/Q4 redacts quoted secrets through determination and protected-path persistence", async () => {
    const rawValue = 'PASSWORD="persist-delta-7 persist-epsilon-8 persist-zeta-9"';
    for (const kind of ["determination", "protected-path"] as const) {
      const { persisted, correction, diagnostic } = await persistedSecurityDiagnostic(kind, `quoted-${kind}`, rawValue);
      expect(diagnostic.value).toBe(REDACTED_ENV_SECRET);
      expect(`${persisted}\n${correction}`).toContain(REDACTED_ENV_SECRET);
      for (const fragment of ["persist-delta-7", "persist-epsilon-8", "persist-zeta-9"]) {
        expect(`${persisted}\n${correction}`).not.toContain(fragment);
      }
    }
  });

  it("S8/Q5 forwards no trailing quoted-secret fragments to double- or single-quoted corrective input", async () => {
    const fixtures = [
      ["corrective-double", 'PASSWORD="corrective-alpha-1 corrective-beta-2 corrective-gamma-3"'],
      ["corrective-single", "PASSWORD='corrective-delta-4 corrective-epsilon-5 corrective-zeta-6'"],
    ] as const;
    for (const [label, rawValue] of fixtures) {
      const { adapter, result, persisted, correction, diagnostic } = await persistedSecurityDiagnostic("determination", label, rawValue);
      expect(diagnostic.value).toBe(REDACTED_ENV_SECRET);
      expect(JSON.parse(correction).previousRejectedEvidence).toContainEqual(diagnostic);
      for (const fragment of rawValue.match(/corrective-[a-z]+-\d/g) ?? []) {
        expect(`${persisted}\n${correction}`).not.toContain(fragment);
      }
      expect(result.runState.attempts[1]?.recovery?.hashes.correctiveInputSha256)
        .toBe(sha256Text(adapter.requests[1]!.input));
    }
  });

  it("Q6 hashes the fully sanitized quoted assignment, never the raw secret", () => {
    const rawValue = 'PASSWORD="digest-alpha-1 digest-beta-2"';
    const diagnostic = directRejectedDiagnostic(intentPayload(rawValue), "/determinations/0/evidence");
    expect(diagnostic.value).toBe(REDACTED_ENV_SECRET);
    expect(diagnostic.valueSha256).toBe(sha256Text(REDACTED_ENV_SECRET));
    expect(diagnostic.valueSha256).not.toBe(sha256Text(rawValue));
  });

  it("redacts a long quoted secret before the existing 512-character truncation boundary", async () => {
    const rawSecret = "quoted-private-x".repeat(64);
    const safeTail = "safe-quoted-context ".repeat(40);
    const rawValue = `PASSWORD="${rawSecret}" ${safeTail}`;
    const sanitizedValue = `${REDACTED_ENV_SECRET} ${safeTail}`;
    const { persisted, correction, diagnostic } = await persistedSecurityDiagnostic("determination", "long-quoted-password", rawValue);
    expect(diagnostic.value).toBe(sanitizedValue.slice(0, REJECTED_EVIDENCE_STRING_LIMIT));
    expect(diagnostic.valueTruncated).toBe(true);
    expect(diagnostic.valueSha256).toBe(sha256Text(sanitizedValue));
    expect(diagnostic.valueSha256).not.toBe(sha256Text(rawValue));
    expect(`${persisted}\n${correction}`).not.toContain("quoted-private-x");
  });

  it("Q7 preserves unquoted assignment and delimiter behavior", () => {
    const fixtures = [
      ["PASSWORD=hunter2value", REDACTED_ENV_SECRET],
      ["PASSWORD = hunter2value", REDACTED_ENV_SECRET],
      ["export PASSWORD=hunter2value", `export ${REDACTED_ENV_SECRET}`],
      ["PASSWORD=hunter2value # comment", `${REDACTED_ENV_SECRET} # comment`],
      ["PASSWORD=hunter2value;OTHER=value", `${REDACTED_ENV_SECRET};OTHER=value`],
    ] as const;
    for (const [rawValue, sanitizedValue] of fixtures) {
      const diagnostic = directRejectedDiagnostic(intentPayload(rawValue), "/determinations/0/evidence");
      expect(diagnostic.value).toBe(sanitizedValue);
      expect(JSON.stringify(diagnostic)).not.toContain("hunter2value");
    }
  });

  it("Q8 redacts lowercase double- and single-quoted assignments", () => {
    for (const rawValue of [
      'password="lower-double-alpha lower-double-beta"',
      "api_key='lower-single-alpha lower-single-beta'",
    ]) {
      const diagnostic = directRejectedDiagnostic(intentPayload(rawValue), "/determinations/0/evidence");
      expect(diagnostic.value).toBe(REDACTED_ENV_SECRET);
      expect(JSON.stringify(diagnostic)).not.toContain("lower-double-alpha");
      expect(JSON.stringify(diagnostic)).not.toContain("lower-single-alpha");
    }
  });

  it("Q9/U1/U3 redacts unterminated double-quoted assignments through the end of the diagnostic", () => {
    for (const [, rawValue] of UNTERMINATED_DOUBLE_ENV_ASSIGNMENTS) {
      const diagnostic = directRejectedDiagnostic(intentPayload(rawValue), "/determinations/0/evidence");
      expect(diagnostic.value).toBe(REDACTED_ENV_SECRET);
      expect(diagnostic.valueSha256).toBe(sha256Text(REDACTED_ENV_SECRET));
      for (const fragment of ["secret-alpha", "secret-beta", "secret-gamma"]) {
        expect(JSON.stringify(diagnostic)).not.toContain(fragment);
      }
    }
  });

  it("Q9/U2/U4 redacts unterminated single-quoted assignments through the end of the diagnostic", () => {
    for (const [, rawValue] of UNTERMINATED_SINGLE_ENV_ASSIGNMENTS) {
      const diagnostic = directRejectedDiagnostic(intentPayload(rawValue), "/determinations/0/evidence");
      expect(diagnostic.value).toBe(REDACTED_ENV_SECRET);
      expect(diagnostic.valueSha256).toBe(sha256Text(REDACTED_ENV_SECRET));
      for (const fragment of ["secret-alpha", "secret-beta", "secret-gamma"]) {
        expect(JSON.stringify(diagnostic)).not.toContain(fragment);
      }
    }
  });

  it("U5 persists no malformed quoted secret for determinations or protected paths", async () => {
    const fixtures = [
      ["determination", "unterminated-persist-double", 'DB_PASSWORD="persist-u5-alpha persist-u5-beta persist-u5-gamma'],
      ["determination", "unterminated-persist-single", "PASSWORD='persist-u5-delta persist-u5-epsilon persist-u5-zeta"],
      ["determination", "unterminated-persist-lower", 'password="persist-u5-eta persist-u5-theta persist-u5-iota'],
      ["protected-path", "unterminated-protected-double", 'OPENAI_API_KEY="persist-u5-kappa persist-u5-lambda persist-u5-mu'],
      ["protected-path", "unterminated-protected-single", "API_KEY='persist-u5-nu persist-u5-xi persist-u5-omicron"],
    ] as const;
    for (const [kind, label, rawValue] of fixtures) {
      const { persisted, correction, diagnostic } = await persistedSecurityDiagnostic(kind, label, rawValue);
      expect(diagnostic.value).toBe(REDACTED_ENV_SECRET);
      expect(`${persisted}\n${correction}`).toContain(REDACTED_ENV_SECRET);
      for (const fragment of rawValue.match(/persist-u5-[a-z]+/g) ?? []) {
        expect(`${persisted}\n${correction}`).not.toContain(fragment);
      }
    }
  });

  it("U6 sends no malformed quoted trailing fragment to corrective input", async () => {
    const fixtures = [
      ["determination", "unterminated-correction-double", 'PASSWORD="correct-u6-alpha correct-u6-beta correct-u6-gamma'],
      ["determination", "unterminated-correction-single", "PASSWORD='correct-u6-delta correct-u6-epsilon correct-u6-zeta"],
      ["protected-path", "unterminated-correction-protected", 'SECRET="correct-u6-eta correct-u6-theta correct-u6-iota'],
      ["determination", "unterminated-correction-lower", 'auth_token="correct-u6-kappa correct-u6-lambda correct-u6-mu'],
    ] as const;
    for (const [kind, label, rawValue] of fixtures) {
      const { adapter, result, correction, diagnostic } = await persistedSecurityDiagnostic(kind, label, rawValue);
      expect(JSON.parse(correction).previousRejectedEvidence).toContainEqual(diagnostic);
      expect(diagnostic.value).toBe(REDACTED_ENV_SECRET);
      for (const fragment of rawValue.match(/correct-u6-[a-z]+/g) ?? []) expect(correction).not.toContain(fragment);
      expect(result.runState.attempts[1]?.recovery?.hashes.correctiveInputSha256)
        .toBe(sha256Text(adapter.requests[1]!.input));
    }
  });

  it("U7 retains case-insensitive fail-safe behavior for lowercase malformed assignments", async () => {
    for (const [label, rawValue] of [
      ["unterminated-lower-double-real", 'password="lower-u7-alpha lower-u7-beta'],
      ["unterminated-lower-single-real", "api_key='lower-u7-gamma lower-u7-delta"],
    ] as const) {
      const { persisted, correction, diagnostic } = await persistedSecurityDiagnostic("determination", label, rawValue);
      expect(diagnostic.value).toBe(REDACTED_ENV_SECRET);
      expect(`${persisted}\n${correction}`).not.toContain("lower-u7-");
    }
  });

  it("U8 fails safe across multiline malformed double- and single-quoted values", async () => {
    for (const [label, rawValue] of [
      ["unterminated-multiline-double", 'PASSWORD="multi-u8-alpha\nmulti-u8-beta\nmulti-u8-gamma'],
      ["unterminated-multiline-single", "PASSWORD='multi-u8-delta\nmulti-u8-epsilon\nmulti-u8-zeta"],
    ] as const) {
      const { persisted, correction, diagnostic } = await persistedSecurityDiagnostic("determination", label, rawValue);
      expect(diagnostic.value).toBe(REDACTED_ENV_SECRET);
      expect(`${persisted}\n${correction}`).not.toContain("multi-u8-");
    }
  });

  it("conservatively consumes following delimiters and diagnostic text after an unterminated quote", () => {
    for (const rawValue of [
      'PASSWORD="delimiter-alpha delimiter-beta;OTHER=value',
      'PASSWORD="delimiter-alpha delimiter-beta, next field',
      'PASSWORD="delimiter-alpha delimiter-beta\nOTHER=value',
      "PASSWORD='delimiter-gamma delimiter-delta;OTHER=value",
    ]) {
      const diagnostic = directRejectedDiagnostic(intentPayload(rawValue), "/determinations/0/evidence");
      expect(diagnostic.value).toBe(REDACTED_ENV_SECRET);
      expect(JSON.stringify(diagnostic)).not.toContain("delimiter-");
    }
  });

  it("preserves sanitized-untruncated hash semantics for malformed quoted assignments", () => {
    for (const rawValue of ['PASSWORD="hash-u9-alpha hash-u9-beta', "PASSWORD='hash-u9-gamma hash-u9-delta"]) {
      const diagnostic = directRejectedDiagnostic(intentPayload(rawValue), "/determinations/0/evidence");
      expect(diagnostic.value).toBe(REDACTED_ENV_SECRET);
      expect(diagnostic.valueSha256).toBe(sha256Text(REDACTED_ENV_SECRET));
      expect(diagnostic.valueSha256).not.toBe(sha256Text(rawValue));
    }
  });

  it("sanitizes a long malformed quoted secret before evaluating the truncation bound", async () => {
    const rawValue = `PASSWORD="${"malformed-private-u9".repeat(64)}`;
    const { persisted, correction, diagnostic } = await persistedSecurityDiagnostic("determination", "unterminated-long", rawValue);
    expect(diagnostic.value).toBe(REDACTED_ENV_SECRET);
    expect(diagnostic.valueTruncated).toBeUndefined();
    expect(diagnostic.valueSha256).toBe(sha256Text(REDACTED_ENV_SECRET));
    expect(diagnostic.valueSha256).not.toBe(sha256Text(rawValue));
    expect(`${persisted}\n${correction}`).not.toContain("malformed-private-u9");
  });

  it("U9 preserves balanced quoted, escaped, backslash, and multiline redaction", () => {
    for (const rawValue of [
      'PASSWORD="hunter two value"',
      "PASSWORD='hunter two value'",
      'PASSWORD="hunter \\"two\\" value"',
      "PASSWORD='hunter \\'two\\' value'",
      'SECRET="alpha \\\\ beta"',
      "API_KEY='abc \\\\ def'",
      'PASSWORD="balanced-multi-alpha\nbalanced-multi-beta"',
      "PASSWORD='balanced-multi-gamma\nbalanced-multi-delta'",
    ]) {
      const diagnostic = directRejectedDiagnostic(intentPayload(rawValue), "/determinations/0/evidence");
      expect(diagnostic.value).toBe(REDACTED_ENV_SECRET);
    }
  });

  it("U10 preserves ordinary unquoted redaction", () => {
    for (const rawValue of [
      "PASSWORD=hunter2value",
      "PASSWORD = hunter2value",
      "export PASSWORD=hunter2value",
      "PASSWORD=hunter2value # comment",
      "PASSWORD=hunter2value;OTHER=value",
      "password=lowercase-unquoted",
      "DB_PASSWORD=prefixed-unquoted",
    ]) {
      const diagnostic = directRejectedDiagnostic(intentPayload(rawValue), "/determinations/0/evidence");
      expect(JSON.stringify(diagnostic)).not.toContain(rawValue.slice(rawValue.indexOf("=") + 1).trim().split(/[\s;]/)[0]);
    }
  });

  it("F1-F7/F12 gives every quote-prefixed sensitive assignment a terminal fail-safe", () => {
    for (const name of TERMINAL_FAIL_SAFE_NAMES) {
      for (const quote of ['"', "'"] as const) {
        for (const tail of [
          "terminal-sentinel-one terminal-sentinel-two\\",
          "C:\\Users\\terminal-sentinel-one\\",
          `terminal-sentinel-one ${BACKSLASH_NEWLINE}terminal-sentinel-two`,
          `terminal-sentinel-one terminal-sentinel-two${"\\".repeat(3)}`,
        ]) {
          const rawValue = `${name}=${quote}${tail}`;
          const diagnostic = directRejectedDiagnostic(intentPayload(rawValue), "/determinations/0/evidence");
          expect(diagnostic.value).toBe(REDACTED_ENV_SECRET);
          expect(diagnostic.valueSha256).toBe(sha256Text(REDACTED_ENV_SECRET));
          expect(JSON.stringify(diagnostic)).not.toContain("terminal-sentinel-one");
          expect(JSON.stringify(diagnostic)).not.toContain("terminal-sentinel-two");
          expect(JSON.stringify(diagnostic)).not.toContain("C:\\Users");
        }
      }
    }
  });

  it("F8 persists no terminal-fail-safe sentinel for determinations or protected paths", async () => {
    const fixtures = [
      ["determination", "terminal-persist-double", 'PASSWORD="persist-f8-alpha persist-f8-beta\\'],
      ["determination", "terminal-persist-single", "PASSWORD='persist-f8-gamma persist-f8-delta\\"],
      ["determination", "terminal-persist-newline", `password="persist-f8-epsilon ${BACKSLASH_NEWLINE}persist-f8-zeta`],
      ["protected-path", "terminal-protected-windows", 'DB_PASSWORD="C:\\Users\\persist-f8-eta\\'],
      ["protected-path", "terminal-protected-single", "OPENAI_API_KEY='persist-f8-theta persist-f8-iota\\"],
    ] as const;
    for (const [kind, label, rawValue] of fixtures) {
      const { persisted, correction, diagnostic } = await persistedSecurityDiagnostic(kind, label, rawValue);
      expect(diagnostic.value).toBe(REDACTED_ENV_SECRET);
      expect(`${persisted}\n${correction}`).toContain(REDACTED_ENV_SECRET);
      expect(`${persisted}\n${correction}`).not.toContain("persist-f8-");
      expect(`${persisted}\n${correction}`).not.toContain("C:\\\\Users");
    }
  });

  it("F9 corrective input receives no dangling-backslash or backslash-newline secret", async () => {
    const fixtures = [
      ["determination", "terminal-correction-double", 'PASSWORD="correct-f9-alpha correct-f9-beta\\'],
      ["determination", "terminal-correction-single", "PASSWORD='correct-f9-gamma correct-f9-delta\\"],
      ["determination", "terminal-correction-newline", `AUTH_TOKEN="correct-f9-epsilon ${BACKSLASH_NEWLINE}correct-f9-zeta`],
      ["protected-path", "terminal-correction-protected", 'API_KEY="correct-f9-eta correct-f9-theta\\'],
    ] as const;
    for (const [kind, label, rawValue] of fixtures) {
      const { adapter, result, correction, diagnostic } = await persistedSecurityDiagnostic(kind, label, rawValue);
      expect(diagnostic.value).toBe(REDACTED_ENV_SECRET);
      expect(JSON.parse(correction).previousRejectedEvidence).toContainEqual(diagnostic);
      expect(correction).not.toContain("correct-f9-");
      expect(result.runState.attempts[1]?.recovery?.hashes.correctiveInputSha256)
        .toBe(sha256Text(adapter.requests[1]!.input));
    }
  });

  it("F10 preserves following text for balanced quoted values, including backslash-newline", () => {
    const fixtures = [
      ['PASSWORD="balanced-f10-alpha balanced-f10-beta";OTHER=value', `${REDACTED_ENV_SECRET};OTHER=value`],
      ['PASSWORD="balanced-f10-gamma balanced-f10-delta", next field', `${REDACTED_ENV_SECRET}, next field`],
      [`PASSWORD="balanced-f10-epsilon ${BACKSLASH_NEWLINE}balanced-f10-zeta";OTHER=value`, `${REDACTED_ENV_SECRET};OTHER=value`],
      [`PASSWORD='balanced-f10-eta ${BACKSLASH_NEWLINE}balanced-f10-theta', next field`, `${REDACTED_ENV_SECRET}, next field`],
    ] as const;
    for (const [rawValue, sanitizedValue] of fixtures) {
      const diagnostic = directRejectedDiagnostic(intentPayload(rawValue), "/determinations/0/evidence");
      expect(diagnostic.value).toBe(sanitizedValue);
      expect(JSON.stringify(diagnostic)).not.toContain("balanced-f10-");
    }
  });

  it("conservatively consumes following text after terminally malformed quoted values", () => {
    for (const rawValue of [
      'PASSWORD="malformed-follow-alpha malformed-follow-beta;OTHER=value\\',
      "PASSWORD='malformed-follow-gamma malformed-follow-delta, next field\\",
      `PASSWORD="malformed-follow-epsilon ${BACKSLASH_NEWLINE}OTHER=value\\`,
    ]) {
      const diagnostic = directRejectedDiagnostic(intentPayload(rawValue), "/determinations/0/evidence");
      expect(diagnostic.value).toBe(REDACTED_ENV_SECRET);
      expect(JSON.stringify(diagnostic)).not.toContain("malformed-follow-");
      expect(JSON.stringify(diagnostic)).not.toContain("OTHER=value");
    }
  });

  it("hashes and bounds the sanitized terminal fail-safe result, never the raw tail", async () => {
    const rawValue = `PASSWORD="${"terminal-long-secret".repeat(64)}\\`;
    const { persisted, correction, diagnostic } = await persistedSecurityDiagnostic("determination", "terminal-long", rawValue);
    expect(diagnostic.value).toBe(REDACTED_ENV_SECRET);
    expect(diagnostic.valueTruncated).toBeUndefined();
    expect(diagnostic.valueSha256).toBe(sha256Text(REDACTED_ENV_SECRET));
    expect(diagnostic.valueSha256).not.toBe(sha256Text(rawValue));
    expect(`${persisted}\n${correction}`).not.toContain("terminal-long-secret");
  });

  it("F11 preserves the ordinary unquoted assignment boundary", () => {
    const fixtures = [
      ["PASSWORD=value", REDACTED_ENV_SECRET],
      ["PASSWORD = value", REDACTED_ENV_SECRET],
      ["export PASSWORD=value", `export ${REDACTED_ENV_SECRET}`],
      ["PASSWORD=value # comment", `${REDACTED_ENV_SECRET} # comment`],
      ["PASSWORD=value;OTHER=value", `${REDACTED_ENV_SECRET};OTHER=value`],
      ["password=lower-value", REDACTED_ENV_SECRET],
      ["DB_PASSWORD=prefixed-value", REDACTED_ENV_SECRET],
    ] as const;
    for (const [rawValue, sanitizedValue] of fixtures) {
      const diagnostic = directRejectedDiagnostic(intentPayload(rawValue), "/determinations/0/evidence");
      expect(diagnostic.value).toBe(sanitizedValue);
    }
  });
});

describe("P1 closed request evidence contract proofs", () => {
  it("enumerates normalized lines deterministically, deduplicates in first-occurrence order, and freezes the catalog", () => {
    const source = "  cafe\u0301   au\tlait  \r\nnpm start\n\nGET /health\u2028npm start\nlocalStorage  ";
    const first = requestEvidenceCatalog(source);
    const second = requestEvidenceCatalog(source);
    expect(first.candidates).toEqual(["café au lait", "npm start", "GET /health", "localStorage"]);
    expect(second).toEqual(first);
    expect(JSON.stringify(deriveIntentSchema(source))).toBe(JSON.stringify(deriveIntentSchema(source)));
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.candidates)).toBe(true);
  });

  it("keeps prompt, input, schema, and decoder aligned across the complete finite enum", () => {
    const providerInput = JSON.parse(intentInput(REQUEST));
    expect(providerInput.requestEvidenceCandidates).toEqual(CANDIDATES);
    expect(INTENT_INSTRUCTIONS).toContain("evidence is REQUIRED");
    expect(INTENT_INSTRUCTIONS).toContain("exactly one complete value from requestEvidenceCandidates");
    const evidenceEnum = intentSchemaBranches().determinationRequest.properties.evidence.enum;
    expect(evidenceEnum).toEqual(CANDIDATES);
    for (const evidence of evidenceEnum) expect(decodeIntentWire(intentPayload(evidence), REQUEST).ok).toBe(true);
    expect(decodeIntentWire(intentPayload("not a candidate"), REQUEST).ok).toBe(false);
  });

  it("distinguishes omitted evidence from present invalid evidence during recovery", async () => {
    const missing = intentPayload();
    delete missing.determinations[0].evidence;
    const { adapter, result } = await recoveryRun(missing, "missing-evidence-run");
    expect(result.runState.attempts[0]?.rejectedFindings).toEqual([expect.objectContaining({
      pointer: "/determinations/0/evidence",
      valueMissing: true,
    })]);
    const correction = JSON.parse(adapter.requests[1]!.input);
    expect(correction.previousRejectedEvidence).toEqual([expect.objectContaining({ valueMissing: true })]);
    expect(correction.specificPreviousFindings).toContainEqual(expect.objectContaining({
      pointer: "/determinations/0/evidence",
      message: expect.stringContaining("previous request-evidence value was missing"),
    }));
  });

  it("supports cold reconstruction from state plus the cryptographically bound correction", async () => {
    const { result } = await invalidRecoveryRun();
    const persisted = JSON.parse(await readFile(result.runStatePath, "utf8"));
    expect(persisted.attempts[0].rejectedFindings[0]).toMatchObject({
      pointer: "/determinations/0/evidence",
      value: "a rewritten health endpoint",
      valueSha256: sha256Text("a rewritten health endpoint"),
    });
    const reconstructed = correctiveIntentInput(
      persisted.originalRequest,
      persisted.attempts[0].findings,
      persisted.attempts[0].rejectedFindings,
    ).input;
    expect(persisted.attempts[1].recovery.hashes.correctiveInputSha256)
      .toBe(sha256Text(reconstructed));
  });

  it("reproduces the former schema/matcher asymmetry offline and proves every new leg is closed", () => {
    const formerEvidenceSchema = { type: "string" };
    const freeForm = "a rewritten health endpoint";
    expect(typeof freeForm).toBe(formerEvidenceSchema.type);
    expect(legacyRequestEvidenceIsVerified(REQUEST, freeForm)).toBe(false);
    const schema = intentSchemaBranches().determinationRequest;
    expect(schema.properties.evidence.enum).not.toContain(freeForm);
    expect(decodeIntentWire(intentPayload(freeForm), REQUEST).ok).toBe(false);
    const finding = [{ code: "semantic-invalid" as const, pointer: "/determinations/0/evidence", message: "request evidence must exactly select one Core-provided request evidence candidate" }];
    expect(JSON.stringify(modelFacingRecoveryContext(finding))).not.toContain(freeForm);
    const rejected = rejectedIntentFindingEvidence(intentPayload(freeForm) as any, finding, intentPayload(freeForm));
    const correction = JSON.parse(correctiveIntentInput(REQUEST, finding, rejected).input);
    expect(rejected[0]).toMatchObject({ value: freeForm, valueSha256: sha256Text(freeForm) });
    expect(correction.previousRejectedEvidence).toEqual(rejected);
    expect(correction.requestEvidenceCandidates).toEqual(CANDIDATES);
  });
});
