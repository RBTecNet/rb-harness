import { join } from "node:path";
import type { Stats } from "node:fs";
import { canonicalJson } from "../canonical-json.js";
import type { SafeRuntimeDescriptor } from "../contracts.js";
import { deriveBudgetUsage } from "../budgets.js";
import { isSha256Digest, sha256Canonical } from "../hashing.js";
import { writeExclusiveRuntimeFile } from "../event-store.js";
import type { RalphRuntimeStateV2 } from "../operational-v2/contracts.js";
import { assertNoCredentialMaterial, RalphCredentialSafetyError } from "./secret-safety.js";
import type { OperationalRunV2Storage, RunSnapshotV2 } from "./run-snapshot.js";

export const RALPH_RETRY_POLICY_SCHEMA_V1 = "rb-ralph-retry-policy/v1" as const;
export const RALPH_RETRY_POLICY_FILE_V1 = "retry-policy.json" as const;

export interface RalphRetryPolicyV1 {
  readonly schemaVersion: typeof RALPH_RETRY_POLICY_SCHEMA_V1;
  readonly runId: string;
  readonly policyId: string;
  /** Maximum TOTAL Attempt instances admitted for each Task. */
  readonly maxTaskAttemptsPerTask: number;
  /** Maximum retries after the initial infrastructure failure for one ValidationSpec in the same Attempt. */
  readonly validationInfrastructureRetryLimit: number;
  readonly policyDigest: string;
}

export const RETRY_POLICY_ERROR_CODES_V1 = [
  "RALPH_V2_RETRY_POLICY_INVALID",
  "RALPH_V2_RETRY_POLICY_MISSING",
  "RALPH_V2_RETRY_POLICY_PATH_UNSAFE",
  "RALPH_V2_RETRY_POLICY_NON_CANONICAL",
  "RALPH_V2_RETRY_POLICY_IMMUTABLE_CONFLICT",
  "RALPH_V2_RETRY_POLICY_SNAPSHOT_MISMATCH",
  "RALPH_V2_RETRY_POLICY_GENESIS_MISMATCH",
  "RALPH_V2_RETRY_POLICY_DURABILITY_UNKNOWN_REQUIRES_INSPECTION",
] as const;
export type RetryPolicyErrorCodeV1 = typeof RETRY_POLICY_ERROR_CODES_V1[number];

export class RalphRetryPolicyV1Error extends Error {
  constructor(readonly code: RetryPolicyErrorCodeV1, message: string = code, readonly cause?: unknown) {
    super(message);
    this.name = "RalphRetryPolicyV1Error";
  }
}

export function createRetryPolicyV1(input: {
  readonly runId: string;
  readonly policyId: string;
  readonly maxTaskAttemptsPerTask: number;
  readonly validationInfrastructureRetryLimit: number;
}): RalphRetryPolicyV1 {
  const core = {
    schemaVersion: RALPH_RETRY_POLICY_SCHEMA_V1,
    runId: input.runId,
    policyId: input.policyId,
    maxTaskAttemptsPerTask: input.maxTaskAttemptsPerTask,
    validationInfrastructureRetryLimit: input.validationInfrastructureRetryLimit,
  } as const;
  const policy = { ...core, policyDigest: sha256Canonical(core) };
  validateRetryPolicyV1(policy);
  return policy;
}

export function retryPolicyDescriptorV1(policy: RalphRetryPolicyV1): SafeRuntimeDescriptor {
  validateRetryPolicyV1(policy);
  return {
    schemaVersion: policy.schemaVersion,
    descriptorId: policy.policyId,
    descriptorDigest: policy.policyDigest,
  };
}

export function validateRetryPolicyV1(value: unknown): asserts value is RalphRetryPolicyV1 {
  try { assertNoCredentialMaterial(value, "RALPH_V2_RETRY_POLICY_CREDENTIAL"); }
  catch (error) {
    if (error instanceof RalphCredentialSafetyError) throw new RalphRetryPolicyV1Error("RALPH_V2_RETRY_POLICY_INVALID", error.code, error);
    throw error;
  }
  if (!isRecord(value)) throw new RalphRetryPolicyV1Error("RALPH_V2_RETRY_POLICY_INVALID");
  assertExactKeys(value, [
    "schemaVersion", "runId", "policyId", "maxTaskAttemptsPerTask",
    "validationInfrastructureRetryLimit", "policyDigest",
  ]);
  if (value.schemaVersion !== RALPH_RETRY_POLICY_SCHEMA_V1) throw new RalphRetryPolicyV1Error("RALPH_V2_RETRY_POLICY_INVALID");
  assertSafeIdentity(value.runId);
  assertSafeIdentity(value.policyId);
  assertLimit(value.maxTaskAttemptsPerTask);
  assertLimit(value.validationInfrastructureRetryLimit);
  if (!isSha256Digest(value.policyDigest)) throw new RalphRetryPolicyV1Error("RALPH_V2_RETRY_POLICY_INVALID");
  const core = {
    schemaVersion: value.schemaVersion,
    runId: value.runId,
    policyId: value.policyId,
    maxTaskAttemptsPerTask: value.maxTaskAttemptsPerTask,
    validationInfrastructureRetryLimit: value.validationInfrastructureRetryLimit,
  };
  if (sha256Canonical(core) !== value.policyDigest) throw new RalphRetryPolicyV1Error("RALPH_V2_RETRY_POLICY_INVALID");
}

export function assertRetryPolicySnapshotBindingV1(snapshot: RunSnapshotV2, policy: RalphRetryPolicyV1): void {
  validateRetryPolicyV1(policy);
  if (policy.runId !== snapshot.runId
    || snapshot.retryPolicies.schemaVersion !== policy.schemaVersion
    || snapshot.retryPolicies.descriptorId !== policy.policyId
    || snapshot.retryPolicies.descriptorDigest !== policy.policyDigest) {
    throw new RalphRetryPolicyV1Error("RALPH_V2_RETRY_POLICY_SNAPSHOT_MISMATCH");
  }
}

export function assertGenesisRetryPolicyBindingV1(state: RalphRuntimeStateV2, policy: RalphRetryPolicyV1): void {
  validateRetryPolicyV1(policy);
  if (state.runId !== policy.runId || state.lastSequence !== 0 || state.lastEventHash !== null) {
    throw new RalphRetryPolicyV1Error("RALPH_V2_RETRY_POLICY_GENESIS_MISMATCH");
  }
  const expected = deriveBudgetUsage(0, policy.maxTaskAttemptsPerTask);
  for (const task of Object.values(state.tasks)) {
    if (canonicalJson(task.executorBudget) !== canonicalJson(expected)) {
      throw new RalphRetryPolicyV1Error("RALPH_V2_RETRY_POLICY_GENESIS_MISMATCH");
    }
  }
}

export async function persistRetryPolicyV1(
  storage: OperationalRunV2Storage,
  policy: RalphRetryPolicyV1,
  nonce: string,
): Promise<"created" | "already-present"> {
  validateRetryPolicyV1(policy);
  if (policy.runId !== storage.runId) throw new RalphRetryPolicyV1Error("RALPH_V2_RETRY_POLICY_INVALID");
  await storage.ensureLayout();
  const path = join(storage.runDirectory, RALPH_RETRY_POLICY_FILE_V1);
  const bytes = Buffer.from(canonicalJson(policy), "utf8");
  const existing = await readRetryPolicyIfPresent(storage);
  if (existing) {
    if (canonicalJson(existing) !== bytes.toString("utf8")) throw new RalphRetryPolicyV1Error("RALPH_V2_RETRY_POLICY_IMMUTABLE_CONFLICT");
    return "already-present";
  }
  let disposition: "created" | "already-present";
  try {
    disposition = await writeExclusiveRuntimeFile(storage.fileSystem, path, bytes, nonce);
  } catch (error) {
    if (error instanceof Error && error.message.includes("RALPH_RUNTIME_IMMUTABLE_VIOLATION")) {
      throw new RalphRetryPolicyV1Error("RALPH_V2_RETRY_POLICY_IMMUTABLE_CONFLICT", undefined, error);
    }
    throw new RalphRetryPolicyV1Error("RALPH_V2_RETRY_POLICY_DURABILITY_UNKNOWN_REQUIRES_INSPECTION", undefined, error);
  }
  const verified = await readRetryPolicyV1(storage);
  if (canonicalJson(verified) !== bytes.toString("utf8")) throw new RalphRetryPolicyV1Error("RALPH_V2_RETRY_POLICY_IMMUTABLE_CONFLICT");
  return disposition;
}

export async function readRetryPolicyV1(storage: OperationalRunV2Storage): Promise<RalphRetryPolicyV1> {
  await storage.ensureLayout();
  const policy = await readRetryPolicyIfPresent(storage);
  if (!policy) throw new RalphRetryPolicyV1Error("RALPH_V2_RETRY_POLICY_MISSING");
  return policy;
}

export async function readBoundRetryPolicyV1(storage: OperationalRunV2Storage, snapshot: RunSnapshotV2): Promise<RalphRetryPolicyV1> {
  const policy = await readRetryPolicyV1(storage);
  assertRetryPolicySnapshotBindingV1(snapshot, policy);
  return policy;
}

async function readRetryPolicyIfPresent(storage: OperationalRunV2Storage): Promise<RalphRetryPolicyV1 | undefined> {
  const path = join(storage.runDirectory, RALPH_RETRY_POLICY_FILE_V1);
  let stats: Stats;
  try { stats = await storage.fileSystem.lstat(path); }
  catch (error) {
    if (isMissing(error)) return undefined;
    throw new RalphRetryPolicyV1Error("RALPH_V2_RETRY_POLICY_PATH_UNSAFE", undefined, error);
  }
  if (stats.isSymbolicLink() || !stats.isFile() || (stats.mode & 0o7777) !== 0o600) {
    throw new RalphRetryPolicyV1Error("RALPH_V2_RETRY_POLICY_PATH_UNSAFE");
  }
  let bytes: Buffer;
  try { bytes = await storage.fileSystem.readFile(path); }
  catch (error) { throw new RalphRetryPolicyV1Error("RALPH_V2_RETRY_POLICY_PATH_UNSAFE", undefined, error); }
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); }
  catch (error) { throw new RalphRetryPolicyV1Error("RALPH_V2_RETRY_POLICY_INVALID", undefined, error); }
  validateRetryPolicyV1(parsed);
  if (bytes.toString("utf8") !== canonicalJson(parsed)) throw new RalphRetryPolicyV1Error("RALPH_V2_RETRY_POLICY_NON_CANONICAL");
  return parsed;
}

function assertLimit(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new RalphRetryPolicyV1Error("RALPH_V2_RETRY_POLICY_INVALID");
}

function assertSafeIdentity(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new RalphRetryPolicyV1Error("RALPH_V2_RETRY_POLICY_INVALID");
}

function assertExactKeys(value: object, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key)) || allowed.some((key) => !(key in value))) {
    throw new RalphRetryPolicyV1Error("RALPH_V2_RETRY_POLICY_INVALID");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { readonly code?: unknown }).code === "ENOENT");
}
