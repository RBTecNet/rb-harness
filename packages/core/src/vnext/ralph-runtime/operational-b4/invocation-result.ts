import {
  EXECUTOR_RESULT_ENVELOPE_STATUSES,
  type ExecutorResultEnvelopeStatusV2,
} from "./execution-observation.js";
import {
  EXECUTOR_STATUSES,
  EXECUTOR_TERMINATIONS,
  type ExecutorStatus,
  type ExecutorTermination,
} from "../operational-v2/contracts.js";
import { isSha256Digest, sha256Canonical } from "../hashing.js";
import type { RalphEventStoreV2 } from "../operational-b1/index.js";
import {
  attemptArtifactRefV2,
  persistImmutableJsonArtifactV2,
  readImmutableJsonArtifactV2,
  type ArtifactPersistenceResultV2,
  RalphB4ArtifactError,
} from "./artifacts.js";

export const RALPH_EXECUTOR_RESULT_SCHEMA_V2 = "rb-ralph-executor-result/v1" as const;

export interface InvocationResultV2 {
  readonly schema: typeof RALPH_EXECUTOR_RESULT_SCHEMA_V2;
  readonly runId: string;
  readonly phaseId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly invocationId: string;
  readonly resultEnvelopeStatus: ExecutorResultEnvelopeStatusV2;
  readonly status: ExecutorStatus;
  readonly termination: ExecutorTermination;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly startedObservationRef: string;
  readonly finishedObservationRef: string;
  readonly diagnosticRefs: readonly string[];
  readonly safeMetadata: Readonly<Record<string, string>>;
  readonly resultDigest: string;
}

export function invocationResultRefV2(attemptId: string): string {
  return attemptArtifactRefV2(attemptId, "invocation-result.json");
}

export function createInvocationResultV2(input: Omit<InvocationResultV2, "schema" | "resultDigest">): InvocationResultV2 {
  validateInvocationResultInput(input);
  const base = { schema: RALPH_EXECUTOR_RESULT_SCHEMA_V2, ...input };
  const result: InvocationResultV2 = { ...base, resultDigest: sha256Canonical(base) };
  validateInvocationResultV2(result);
  return result;
}

export function validateInvocationResultV2(value: unknown): asserts value is InvocationResultV2 {
  if (!isRecord(value)) throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", "B4_EXECUTOR_RESULT_INVALID");
  assertExactKeys(value, [
    "schema", "runId", "phaseId", "taskId", "attemptId", "invocationId", "resultEnvelopeStatus", "status", "termination",
    "exitCode", "signal", "startedAt", "finishedAt", "startedObservationRef", "finishedObservationRef", "diagnosticRefs", "safeMetadata", "resultDigest",
  ]);
  if (value.schema !== RALPH_EXECUTOR_RESULT_SCHEMA_V2) throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", "B4_EXECUTOR_RESULT_INVALID: schema");
  for (const key of ["runId", "phaseId", "taskId", "attemptId", "invocationId", "startedAt", "finishedAt", "startedObservationRef", "finishedObservationRef"] as const) assertSafeString(value[key]);
  if (!EXECUTOR_RESULT_ENVELOPE_STATUSES.includes(value.resultEnvelopeStatus as ExecutorResultEnvelopeStatusV2)) throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", "B4_EXECUTOR_RESULT_INVALID: result envelope");
  if (!EXECUTOR_STATUSES.includes(value.status as ExecutorStatus) || !EXECUTOR_TERMINATIONS.includes(value.termination as ExecutorTermination)) throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", "B4_EXECUTOR_RESULT_INVALID: termination");
  if (value.exitCode !== null && (typeof value.exitCode !== "number" || !Number.isSafeInteger(value.exitCode) || value.exitCode < -1)) throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", "B4_EXECUTOR_RESULT_INVALID: exit code");
  if (value.signal !== null && (typeof value.signal !== "string" || value.signal.length === 0 || value.signal.length > 64)) throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", "B4_EXECUTOR_RESULT_INVALID: signal");
  if (!Array.isArray(value.diagnosticRefs) || value.diagnosticRefs.some((ref) => {
    try { assertSafeString(ref); return false; } catch { return true; }
  })) throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", "B4_EXECUTOR_RESULT_INVALID: diagnostics");
  validateSafeMetadata(value.safeMetadata);
  if (!isSha256Digest(value.resultDigest)) throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", "B4_EXECUTOR_RESULT_INVALID: digest");
  const { resultDigest: _ignored, ...base } = value;
  if (sha256Canonical(base) !== value.resultDigest) throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", "B4_EXECUTOR_RESULT_INVALID: digest mismatch");
  if (value.resultEnvelopeStatus === "VALID" && value.status === "UNAVAILABLE") throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", "B4_EXECUTOR_RESULT_INVALID: unavailable envelope");
}

export async function persistInvocationResultV2(
  store: RalphEventStoreV2,
  result: InvocationResultV2,
  nonce: string,
): Promise<ArtifactPersistenceResultV2<InvocationResultV2>> {
  validateInvocationResultV2(result);
  return persistImmutableJsonArtifactV2({ store, ref: invocationResultRefV2(result.attemptId), artifact: result, validate: validateInvocationResultV2, nonce });
}

export async function readInvocationResultV2(store: RalphEventStoreV2, attemptId: string): Promise<InvocationResultV2 | undefined> {
  return readImmutableJsonArtifactV2({ store, ref: invocationResultRefV2(attemptId), validate: validateInvocationResultV2 });
}

function validateInvocationResultInput(input: Omit<InvocationResultV2, "schema" | "resultDigest">): void {
  if (!isRecord(input)) throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", "B4_EXECUTOR_RESULT_INVALID");
  for (const key of ["runId", "phaseId", "taskId", "attemptId", "invocationId", "startedAt", "finishedAt", "startedObservationRef", "finishedObservationRef"] as const) assertSafeString(input[key]);
  if (!EXECUTOR_RESULT_ENVELOPE_STATUSES.includes(input.resultEnvelopeStatus)) throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", "B4_EXECUTOR_RESULT_INVALID");
  if (!EXECUTOR_STATUSES.includes(input.status) || !EXECUTOR_TERMINATIONS.includes(input.termination)) throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", "B4_EXECUTOR_RESULT_INVALID");
  if (input.exitCode !== null && (!Number.isSafeInteger(input.exitCode) || input.exitCode < -1)) throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", "B4_EXECUTOR_RESULT_INVALID");
  if (input.signal !== null && (typeof input.signal !== "string" || input.signal.length === 0)) throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", "B4_EXECUTOR_RESULT_INVALID");
  if (!Array.isArray(input.diagnosticRefs)) throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", "B4_EXECUTOR_RESULT_INVALID");
  validateSafeMetadata(input.safeMetadata);
}

function validateSafeMetadata(value: unknown): asserts value is Readonly<Record<string, string>> {
  if (!isRecord(value)) throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", "B4_EXECUTOR_RESULT_INVALID: metadata");
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(key) || typeof item !== "string" || item.length > 512 || /(?:Bearer\s+\S+|-----BEGIN[^-]*PRIVATE KEY-----|(?:api[_-]?key|password|secret)\s*[:=])/i.test(item)) {
      throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", "B4_EXECUTOR_RESULT_INVALID: unsafe metadata");
    }
  }
}

function assertSafeString(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || value.includes("\0") || value.includes("/")) throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", "B4_EXECUTOR_RESULT_INVALID: string");
}

function assertExactKeys(value: object, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", `B4_EXECUTOR_RESULT_INVALID: unknown fields ${unknown.sort().join(",")}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
