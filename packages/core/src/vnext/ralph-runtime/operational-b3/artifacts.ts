import { dirname, join } from "node:path";
import type { Stats } from "node:fs";
import type { Task, Phase } from "../../../types.js";
import type { RalphRuntimeFileSystem } from "../event-store.js";
import { canonicalJson } from "../canonical-json.js";
import { isSha256Digest, sha256Canonical } from "../hashing.js";
import type { AttemptStateV2, ValidationSpecRef } from "../operational-v2/contracts.js";
import { validationSpecsForTask } from "../operational-v2/validation.js";
import type { RunSnapshotV2 } from "../operational-b1/run-snapshot.js";
import type { RalphEventStoreV2 } from "../operational-b1/event-store.js";

export const RALPH_WORK_UNIT_SCHEMA_V2 = "rb-ralph-work-unit/v1" as const;
export const RALPH_INVOCATION_SCHEMA_V2 = "rb-ralph-invocation/v1" as const;

export const ARTIFACT_ERROR_CODES = [
  "ARTIFACT_PATH_UNSAFE",
  "ARTIFACT_INVALID",
  "ARTIFACT_IMMUTABLE_CONFLICT",
  "ARTIFACT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION",
  "ARTIFACT_PERSISTENCE_FAILED",
] as const;
export type ArtifactErrorCode = typeof ARTIFACT_ERROR_CODES[number];

export class RalphArtifactError extends Error {
  constructor(readonly code: ArtifactErrorCode, message: string = code, readonly cause?: unknown) {
    super(message);
    this.name = "RalphArtifactError";
  }
}

export interface WorkUnitV2 {
  readonly schema: typeof RALPH_WORK_UNIT_SCHEMA_V2;
  readonly workUnitId: string;
  readonly workUnitDigest: string;
  readonly runId: string;
  readonly phaseId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly ordinal: number;
  readonly planIdentity: string;
  readonly planDigest: string;
  readonly taskDigest: string;
  readonly title: string;
  readonly goal: string;
  readonly change: string;
  readonly scope: string;
  readonly covers: string;
  readonly acceptanceCriteria: readonly string[];
  readonly validationSpecRefs: readonly ValidationSpecRef[];
  readonly expectedEvidence: string;
  readonly executorProfileIdentity: string;
  readonly executorProfileDigest: string;
  readonly timeoutPolicyDigest: string;
  readonly capabilityPolicyDigest: string;
  readonly attemptBaseFingerprint: string;
  readonly createdAt: string;
}

export interface InvocationDescriptorV2 {
  readonly schema: typeof RALPH_INVOCATION_SCHEMA_V2;
  readonly runId: string;
  readonly phaseId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly ordinal: number;
  readonly invocationId: string;
  readonly workUnitId: string;
  readonly workUnitDigest: string;
  readonly executorProfileIdentity: string;
  readonly executorProfileDigest: string;
  readonly attemptBaseFingerprint: string;
  readonly timeoutPolicyDigest: string;
  readonly capabilityPolicyDigest: string;
  readonly createdAt: string;
}

export interface ArtifactBindingInputV2 {
  readonly runId: string;
  readonly phase: Phase;
  readonly task: Task;
  readonly attempt: AttemptStateV2;
  readonly planIdentity: string;
  readonly planDigest: string;
  readonly snapshot: RunSnapshotV2;
}

export interface ArtifactPersistenceResultV2<T> {
  readonly artifact: T;
  readonly publishDisposition: "PUBLISHED_BY_THIS_CALL" | "ALREADY_PRESENT";
}

const WORK_UNIT_KEYS = [
  "schema", "workUnitId", "workUnitDigest", "runId", "phaseId", "taskId", "attemptId", "ordinal", "planIdentity", "planDigest", "taskDigest",
  "title", "goal", "change", "scope", "covers", "acceptanceCriteria", "validationSpecRefs", "expectedEvidence", "executorProfileIdentity",
  "executorProfileDigest", "timeoutPolicyDigest", "capabilityPolicyDigest", "attemptBaseFingerprint", "createdAt",
] as const;

const INVOCATION_KEYS = [
  "schema", "runId", "phaseId", "taskId", "attemptId", "ordinal", "invocationId", "workUnitId", "workUnitDigest", "executorProfileIdentity",
  "executorProfileDigest", "attemptBaseFingerprint", "timeoutPolicyDigest", "capabilityPolicyDigest", "createdAt",
] as const;

export function workUnitPathV2(store: RalphEventStoreV2, attemptId: string): string {
  assertArtifactSegment(attemptId);
  return join(store.runDirectory, "attempts", attemptId, "work-unit.json");
}

export function invocationDescriptorPathV2(store: RalphEventStoreV2, attemptId: string): string {
  assertArtifactSegment(attemptId);
  return join(store.runDirectory, "attempts", attemptId, "invocation.json");
}

export function createWorkUnitV2(input: ArtifactBindingInputV2): WorkUnitV2 {
  assertBindingInput(input);
  const taskDigest = sha256Canonical(taskDescriptor(input.task));
  const identity = {
    runId: input.runId,
    phaseId: input.phase.id,
    taskId: input.task.id,
    attemptId: input.attempt.attemptId,
    ordinal: input.attempt.ordinal,
    planIdentity: input.planIdentity,
    planDigest: input.planDigest,
    taskDigest,
    executorProfileIdentity: input.snapshot.executorProfile.profileId,
    executorProfileDigest: input.snapshot.executorProfile.descriptorDigest,
    timeoutPolicyDigest: input.snapshot.timeoutPolicy.descriptorDigest,
    capabilityPolicyDigest: input.snapshot.permissionCapabilityPolicy.descriptorDigest,
    attemptBaseFingerprint: input.attempt.attemptBaseFingerprint,
  };
  const descriptor = {
    schema: RALPH_WORK_UNIT_SCHEMA_V2,
    workUnitId: `wu-${sha256Canonical(identity).slice("sha256:".length)}`,
    runId: input.runId,
    phaseId: input.phase.id,
    taskId: input.task.id,
    attemptId: input.attempt.attemptId,
    ordinal: input.attempt.ordinal,
    planIdentity: input.planIdentity,
    planDigest: input.planDigest,
    taskDigest,
    title: input.task.title,
    goal: input.phase.goal,
    change: input.task.change,
    scope: input.task.scope,
    covers: input.task.covers,
    acceptanceCriteria: [...input.task.acceptanceCriteria],
    validationSpecRefs: [...validationSpecsForTask(input.task, input.planIdentity)],
    expectedEvidence: input.task.expectedEvidence,
    executorProfileIdentity: input.snapshot.executorProfile.profileId,
    executorProfileDigest: input.snapshot.executorProfile.descriptorDigest,
    timeoutPolicyDigest: input.snapshot.timeoutPolicy.descriptorDigest,
    capabilityPolicyDigest: input.snapshot.permissionCapabilityPolicy.descriptorDigest,
    attemptBaseFingerprint: input.attempt.attemptBaseFingerprint,
    // The durable attempt timestamp is the stable Core-owned creation time.
    createdAt: input.attempt.startedAt,
  } satisfies Omit<WorkUnitV2, "workUnitDigest" | "workUnitId"> & Pick<WorkUnitV2, "workUnitId">;
  const result = { ...descriptor, workUnitDigest: sha256Canonical(descriptor) } as WorkUnitV2;
  validateWorkUnitV2(result);
  return result;
}

export function validateWorkUnitV2(value: unknown): asserts value is WorkUnitV2 {
  if (!isRecord(value)) throw new RalphArtifactError("ARTIFACT_INVALID", "ARTIFACT_INVALID: WorkUnit is not an object");
  assertExactKeys(value, WORK_UNIT_KEYS);
  if (value.schema !== RALPH_WORK_UNIT_SCHEMA_V2) throw new RalphArtifactError("ARTIFACT_INVALID", "ARTIFACT_INVALID: WorkUnit schema");
  for (const key of ["workUnitId", "runId", "phaseId", "taskId", "attemptId", "planIdentity", "taskDigest", "title", "goal", "change", "scope", "covers", "expectedEvidence", "executorProfileIdentity", "attemptBaseFingerprint", "createdAt"] as const) {
    assertNonEmptyString(value[key]);
  }
  if (typeof value.workUnitId !== "string" || !/^wu-[0-9a-f]{64}$/.test(value.workUnitId)) throw new RalphArtifactError("ARTIFACT_INVALID", "ARTIFACT_INVALID: WorkUnit ID");
  for (const key of ["workUnitDigest", "planDigest", "executorProfileDigest", "timeoutPolicyDigest", "capabilityPolicyDigest"] as const) {
    if (!isSha256Digest(value[key])) throw new RalphArtifactError("ARTIFACT_INVALID", `ARTIFACT_INVALID: WorkUnit ${key}`);
  }
  if (typeof value.ordinal !== "number" || !Number.isSafeInteger(value.ordinal) || value.ordinal < 1) throw new RalphArtifactError("ARTIFACT_INVALID", "ARTIFACT_INVALID: WorkUnit ordinal");
  assertStringArray(value.acceptanceCriteria);
  if (!Array.isArray(value.validationSpecRefs)) throw new RalphArtifactError("ARTIFACT_INVALID", "ARTIFACT_INVALID: WorkUnit validation refs");
  if (typeof value.taskId !== "string" || typeof value.planIdentity !== "string") throw new RalphArtifactError("ARTIFACT_INVALID", "ARTIFACT_INVALID: WorkUnit binding");
  for (const reference of value.validationSpecRefs) validateValidationSpecRef(reference, value.taskId, value.planIdentity);
  if (sha256Canonical(stripDigest(value)) !== value.workUnitDigest) throw new RalphArtifactError("ARTIFACT_INVALID", "ARTIFACT_INVALID: WorkUnit digest");
  assertNoSecretMaterial(value);
}

export function createInvocationDescriptorV2(input: { readonly workUnit: WorkUnitV2 } & ArtifactBindingInputV2): InvocationDescriptorV2 {
  assertBindingInput(input);
  validateWorkUnitV2(input.workUnit);
  const binding = invocationBindingV2(input);
  const descriptor: InvocationDescriptorV2 = {
    schema: RALPH_INVOCATION_SCHEMA_V2,
    runId: input.runId,
    phaseId: input.phase.id,
    taskId: input.task.id,
    attemptId: input.attempt.attemptId,
    ordinal: input.attempt.ordinal,
    invocationId: `inv-${sha256Canonical(binding).slice("sha256:".length)}`,
    workUnitId: input.workUnit.workUnitId,
    workUnitDigest: input.workUnit.workUnitDigest,
    executorProfileIdentity: input.snapshot.executorProfile.profileId,
    executorProfileDigest: input.snapshot.executorProfile.descriptorDigest,
    attemptBaseFingerprint: input.attempt.attemptBaseFingerprint,
    timeoutPolicyDigest: input.snapshot.timeoutPolicy.descriptorDigest,
    capabilityPolicyDigest: input.snapshot.permissionCapabilityPolicy.descriptorDigest,
    createdAt: input.workUnit.createdAt,
  };
  validateInvocationDescriptorV2(descriptor);
  return descriptor;
}

export function invocationBindingV2(input: { readonly workUnit: WorkUnitV2 } & ArtifactBindingInputV2): Readonly<Record<string, unknown>> {
  return {
    runId: input.runId,
    phaseId: input.phase.id,
    taskId: input.task.id,
    attemptId: input.attempt.attemptId,
    executorProfileDigest: input.snapshot.executorProfile.descriptorDigest,
    workUnitDigest: input.workUnit.workUnitDigest,
    attemptBaseFingerprint: input.attempt.attemptBaseFingerprint,
    timeoutPolicyDigest: input.snapshot.timeoutPolicy.descriptorDigest,
    capabilityPolicyDigest: input.snapshot.permissionCapabilityPolicy.descriptorDigest,
  };
}

export function invocationIdForBindingV2(input: { readonly workUnit: WorkUnitV2 } & ArtifactBindingInputV2): string {
  return `inv-${sha256Canonical(invocationBindingV2(input)).slice("sha256:".length)}`;
}

export function validateInvocationDescriptorV2(value: unknown): asserts value is InvocationDescriptorV2 {
  if (!isRecord(value)) throw new RalphArtifactError("ARTIFACT_INVALID", "ARTIFACT_INVALID: invocation is not an object");
  assertExactKeys(value, INVOCATION_KEYS);
  if (value.schema !== RALPH_INVOCATION_SCHEMA_V2) throw new RalphArtifactError("ARTIFACT_INVALID", "ARTIFACT_INVALID: invocation schema");
  for (const key of ["runId", "phaseId", "taskId", "attemptId", "invocationId", "workUnitId", "executorProfileIdentity", "attemptBaseFingerprint", "createdAt"] as const) {
    assertNonEmptyString(value[key]);
  }
  if (typeof value.invocationId !== "string" || !/^inv-[0-9a-f]{64}$/.test(value.invocationId)) throw new RalphArtifactError("ARTIFACT_INVALID", "ARTIFACT_INVALID: invocation ID");
  for (const key of ["workUnitDigest", "executorProfileDigest", "timeoutPolicyDigest", "capabilityPolicyDigest"] as const) {
    if (!isSha256Digest(value[key])) throw new RalphArtifactError("ARTIFACT_INVALID", `ARTIFACT_INVALID: invocation ${key}`);
  }
  if (typeof value.ordinal !== "number" || !Number.isSafeInteger(value.ordinal) || value.ordinal < 1) throw new RalphArtifactError("ARTIFACT_INVALID", "ARTIFACT_INVALID: invocation ordinal");
  assertNoSecretMaterial(value);
}

export async function readWorkUnitV2(store: RalphEventStoreV2, attemptId: string): Promise<WorkUnitV2 | undefined> {
  const path = await prepareArtifactPath(store, attemptId);
  return readArtifact(path, store.fileSystem, validateWorkUnitV2);
}

export async function readInvocationDescriptorV2(store: RalphEventStoreV2, attemptId: string): Promise<InvocationDescriptorV2 | undefined> {
  await prepareArtifactPath(store, attemptId);
  return readArtifact(invocationDescriptorPathV2(store, attemptId), store.fileSystem, validateInvocationDescriptorV2);
}

export async function persistWorkUnitV2(store: RalphEventStoreV2, workUnit: WorkUnitV2, nonce: string): Promise<ArtifactPersistenceResultV2<WorkUnitV2>> {
  validateWorkUnitV2(workUnit);
  const path = await prepareArtifactPath(store, workUnit.attemptId);
  return persistImmutableArtifact(store.fileSystem, path, workUnit, nonce);
}

export async function persistInvocationDescriptorV2(store: RalphEventStoreV2, descriptor: InvocationDescriptorV2, nonce: string): Promise<ArtifactPersistenceResultV2<InvocationDescriptorV2>> {
  validateInvocationDescriptorV2(descriptor);
  const path = await prepareArtifactPath(store, descriptor.attemptId);
  return persistImmutableArtifact(store.fileSystem, invocationDescriptorPathV2(store, descriptor.attemptId), descriptor, nonce);
}

async function prepareArtifactPath(store: RalphEventStoreV2, attemptId: string): Promise<string> {
  assertArtifactSegment(attemptId);
  await store.ensureLayout();
  const attemptsDirectory = join(store.runDirectory, "attempts");
  await ensureDirectory(store.fileSystem, attemptsDirectory);
  const attemptDirectory = join(attemptsDirectory, attemptId);
  await ensureDirectory(store.fileSystem, attemptDirectory);
  return join(attemptDirectory, "work-unit.json");
}

async function readArtifact<T>(
  path: string,
  fileSystem: RalphRuntimeFileSystem,
  validate: (value: unknown) => asserts value is T,
): Promise<T | undefined> {
  let stats: Stats;
  try { stats = await fileSystem.lstat(path); }
  catch (error) {
    if (isMissing(error)) return undefined;
    throw new RalphArtifactError("ARTIFACT_PATH_UNSAFE", "ARTIFACT_PATH_UNSAFE: artifact cannot be inspected", error);
  }
  if (stats.isSymbolicLink() || !stats.isFile() || modeOf(stats) !== 0o600) throw new RalphArtifactError("ARTIFACT_PATH_UNSAFE", `ARTIFACT_PATH_UNSAFE: ${path}`);
  let bytes: Buffer;
  try { bytes = await fileSystem.readFile(path); }
  catch (error) { throw new RalphArtifactError("ARTIFACT_INVALID", "ARTIFACT_INVALID: artifact disappeared", error); }
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); }
  catch (error) { throw new RalphArtifactError("ARTIFACT_INVALID", "ARTIFACT_INVALID: malformed artifact JSON", error); }
  validate(parsed);
  if (bytes.toString("utf8") !== canonicalJson(parsed)) throw new RalphArtifactError("ARTIFACT_INVALID", "ARTIFACT_INVALID: non-canonical artifact");
  return parsed;
}

async function persistImmutableArtifact<T>(
  fileSystem: RalphRuntimeFileSystem,
  path: string,
  artifact: T,
  nonce: string,
): Promise<ArtifactPersistenceResultV2<T>> {
  const directory = dirname(path);
  const bytes = Buffer.from(canonicalJson(artifact), "utf8");
  const temporary = `${path}.tmp-${safeNonce(nonce)}`;
  try {
    await fileSystem.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await fileSystem.fsyncFile(temporary);
  } catch (error) {
    throw new RalphArtifactError("ARTIFACT_PERSISTENCE_FAILED", "ARTIFACT_PERSISTENCE_FAILED: artifact staging failed", error);
  }
  try {
    await fileSystem.link(temporary, path);
  } catch (error) {
    if (!isExisting(error)) throw new RalphArtifactError("ARTIFACT_PERSISTENCE_FAILED", "ARTIFACT_PERSISTENCE_FAILED: artifact publication failed", error);
    const existing = await readExistingBytes(fileSystem, path);
    await unlinkBestEffort(fileSystem, temporary);
    if (!existing.equals(bytes)) throw new RalphArtifactError("ARTIFACT_IMMUTABLE_CONFLICT");
    return { artifact, publishDisposition: "ALREADY_PRESENT" };
  }
  try {
    await fileSystem.fsyncDirectory(directory);
  } catch (error) {
    throw new RalphArtifactError("ARTIFACT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION", "ARTIFACT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION", error);
  }
  try {
    await fileSystem.unlink(temporary);
    await fileSystem.fsyncDirectory(directory);
  } catch (error) {
    throw new RalphArtifactError("ARTIFACT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION", "ARTIFACT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION", error);
  }
  return { artifact, publishDisposition: "PUBLISHED_BY_THIS_CALL" };
}

async function readExistingBytes(fileSystem: RalphRuntimeFileSystem, path: string): Promise<Buffer> {
  let stats: Stats;
  try { stats = await fileSystem.lstat(path); }
  catch (error) { throw new RalphArtifactError("ARTIFACT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION", "ARTIFACT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION: artifact target disappeared", error); }
  if (stats.isSymbolicLink() || !stats.isFile() || modeOf(stats) !== 0o600) throw new RalphArtifactError("ARTIFACT_PATH_UNSAFE", `ARTIFACT_PATH_UNSAFE: ${path}`);
  try { return await fileSystem.readFile(path); }
  catch (error) { throw new RalphArtifactError("ARTIFACT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION", "ARTIFACT_DURABILITY_UNKNOWN_REQUIRES_INSPECTION: artifact target unreadable", error); }
}

async function ensureDirectory(fileSystem: RalphRuntimeFileSystem, path: string): Promise<void> {
  let stats: Stats | undefined;
  try { stats = await fileSystem.lstat(path); }
  catch (error) {
    if (!isMissing(error)) throw new RalphArtifactError("ARTIFACT_PATH_UNSAFE", "ARTIFACT_PATH_UNSAFE: artifact directory unavailable", error);
    try { await fileSystem.mkdir(path, { recursive: false, mode: 0o700 }); }
    catch (mkdirError) {
      if (!isExisting(mkdirError)) throw new RalphArtifactError("ARTIFACT_PATH_UNSAFE", "ARTIFACT_PATH_UNSAFE: artifact directory creation failed", mkdirError);
    }
    try { stats = await fileSystem.lstat(path); }
    catch (lstatError) { throw new RalphArtifactError("ARTIFACT_PATH_UNSAFE", "ARTIFACT_PATH_UNSAFE: artifact directory race", lstatError); }
  }
  if (!stats || stats.isSymbolicLink() || !stats.isDirectory() || modeOf(stats) !== 0o700) throw new RalphArtifactError("ARTIFACT_PATH_UNSAFE", `ARTIFACT_PATH_UNSAFE: ${path}`);
}

function assertBindingInput(input: ArtifactBindingInputV2): void {
  if (!input || !input.phase || !input.task || !input.attempt) throw new RalphArtifactError("ARTIFACT_INVALID", "ARTIFACT_INVALID: missing artifact binding");
  assertNonEmptyString(input.runId);
  assertNonEmptyString(input.phase.id);
  assertNonEmptyString(input.task.id);
  assertNonEmptyString(input.attempt.attemptId);
  if (input.attempt.taskId !== input.task.id || input.attempt.phaseId !== input.phase.id) throw new RalphArtifactError("ARTIFACT_INVALID", "ARTIFACT_INVALID: artifact relation");
  assertNonEmptyString(input.planIdentity);
  if (!isSha256Digest(input.planDigest)) throw new RalphArtifactError("ARTIFACT_INVALID", "ARTIFACT_INVALID: plan digest");
  if (!isSha256Digest(input.snapshot.executorProfile.descriptorDigest) || !isSha256Digest(input.snapshot.timeoutPolicy.descriptorDigest) || !isSha256Digest(input.snapshot.permissionCapabilityPolicy.descriptorDigest)) {
    throw new RalphArtifactError("ARTIFACT_INVALID", "ARTIFACT_INVALID: policy digest");
  }
}

function taskDescriptor(task: Task): Readonly<Record<string, unknown>> {
  return {
    id: task.id,
    title: task.title,
    scope: task.scope,
    change: task.change,
    covers: task.covers,
    dependsOn: [...task.dependsOn],
    parallelSafe: task.parallelSafe,
    acceptanceCriteria: [...task.acceptanceCriteria],
    validation: [...task.validation],
    expectedEvidence: task.expectedEvidence,
  };
}

function validateValidationSpecRef(value: unknown, taskId: string, planIdentity: string): asserts value is ValidationSpecRef {
  if (!isRecord(value)) throw new RalphArtifactError("ARTIFACT_INVALID", "ARTIFACT_INVALID: validation reference");
  assertExactKeys(value, ["validationSpecId", "ordinal", "kind", "instruction", "digest", "sourceTaskId", "sourcePlanIdentity"]);
  for (const key of ["validationSpecId", "instruction", "digest", "sourceTaskId", "sourcePlanIdentity"] as const) assertNonEmptyString(value[key]);
  if (typeof value.ordinal !== "number" || !Number.isSafeInteger(value.ordinal) || value.ordinal < 1 || !["COMMAND", "MANUAL", "HUMAN"].includes(value.kind as string)) throw new RalphArtifactError("ARTIFACT_INVALID", "ARTIFACT_INVALID: validation reference enum");
  if (!isSha256Digest(value.digest)) throw new RalphArtifactError("ARTIFACT_INVALID", "ARTIFACT_INVALID: validation reference digest");
  if (value.sourceTaskId !== taskId || value.sourcePlanIdentity !== planIdentity) throw new RalphArtifactError("ARTIFACT_INVALID", "ARTIFACT_INVALID: validation reference binding");
  const { digest: _ignored, ...withoutDigest } = value;
  if (sha256Canonical(withoutDigest) !== value.digest) throw new RalphArtifactError("ARTIFACT_INVALID", "ARTIFACT_INVALID: validation reference digest mismatch");
}

function stripDigest(value: Record<string, any>): Record<string, unknown> {
  const { workUnitDigest: _ignored, ...withoutDigest } = value;
  return withoutDigest;
}

function assertNoSecretMaterial(value: unknown, path = "$", seen = new WeakSet<object>()): void {
  if (!value || typeof value !== "object") {
    if (typeof value === "string" && (/(?:^|\s)Bearer\s+\S+/i.test(value) || /-----BEGIN[^-]*PRIVATE KEY-----/i.test(value) || /(?:api[_-]?key|password|secret)\s*[:=]/i.test(value))) {
      throw new RalphArtifactError("ARTIFACT_INVALID", `ARTIFACT_INVALID: secret material at ${path}`);
    }
    return;
  }
  if (seen.has(value)) throw new RalphArtifactError("ARTIFACT_INVALID", "ARTIFACT_INVALID: cyclic artifact");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      value.forEach((child, index) => assertNoSecretMaterial(child, `${path}[${index}]`, seen));
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (/(?:authorization|api[_-]?key|password|passwd|secret|private[_-]?key|access[_-]?token|refresh[_-]?token|owner[_-]?token|recovery[_-]?token)/i.test(key)) {
        throw new RalphArtifactError("ARTIFACT_INVALID", `ARTIFACT_INVALID: secret field at ${path}.${key}`);
      }
      assertNoSecretMaterial(child, `${path}.${key}`, seen);
    }
  } finally {
    seen.delete(value);
  }
}

function assertExactKeys(value: object, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) throw new RalphArtifactError("ARTIFACT_INVALID", `ARTIFACT_INVALID: unknown fields ${unknown.sort().join(",")}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNonEmptyString(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0) throw new RalphArtifactError("ARTIFACT_INVALID", "ARTIFACT_INVALID: empty field");
}

function assertStringArray(value: unknown): asserts value is readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new RalphArtifactError("ARTIFACT_INVALID", "ARTIFACT_INVALID: string array");
}

function assertArtifactSegment(value: string): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new RalphArtifactError("ARTIFACT_PATH_UNSAFE", "ARTIFACT_PATH_UNSAFE: unsafe attempt identity");
}

function modeOf(stats: Stats): number { return stats.mode & 0o7777; }

function safeNonce(value: string): string { return /^[A-Za-z0-9._-]+$/.test(value) ? value : "nonce"; }

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { readonly code?: unknown }).code === "ENOENT");
}

function isExisting(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { readonly code?: unknown }).code === "EEXIST");
}

async function unlinkBestEffort(fileSystem: RalphRuntimeFileSystem, path: string): Promise<void> {
  try { await fileSystem.unlink(path); } catch { /* immutable target remains authoritative */ }
}
