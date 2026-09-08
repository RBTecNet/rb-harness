import { canonicalJson } from "../canonical-json.js";
import { isSha256Digest, sha256Canonical } from "../hashing.js";
import { assertNoCredentialMaterial, RalphCredentialSafetyError } from "../operational-b1/secret-safety.js";
import type { RalphEventStoreV2 } from "../operational-b1/index.js";
import {
  attemptArtifactRefV2,
  persistImmutableJsonArtifactV2,
  readImmutableJsonArtifactV2,
  type ArtifactPersistenceResultV2,
  RalphB4ArtifactError,
} from "./artifacts.js";
import { readProviderInvocationArtifactSetV2 } from "./provider-invocation-artifacts.js";

export const RALPH_OPENCODE_PROMPT_SCHEMA_V2 = "rb-ralph-opencode-prompt/v1" as const;
export const RALPH_OPENCODE_RESULT_SCHEMA_V2 = "rb-ralph-opencode-result/v1" as const;
export const OPENCODE_PHYSICAL_RESULT_CLASSIFICATIONS_V2 = ["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT", "PROTOCOL_FAILURE"] as const;
export type OpenCodePhysicalResultClassificationV2 = typeof OPENCODE_PHYSICAL_RESULT_CLASSIFICATIONS_V2[number];

interface OpenCodeCoreBindingV2 {
  readonly runId: string;
  readonly phaseId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly invocationId: string;
}

export interface OpenCodePromptArtifactV2 extends OpenCodeCoreBindingV2 {
  readonly schema: typeof RALPH_OPENCODE_PROMPT_SCHEMA_V2;
  readonly descriptorDigest: string;
  readonly dispatchIntentDigest: string;
  readonly sessionBindingDigest: string;
  readonly openCodeSessionId: string;
  readonly openCodeUserMessageId: string;
  readonly modelSelector: string;
  readonly promptDigest: string;
  readonly promptBytes: number;
  readonly preparedAt: string;
  readonly artifactDigest: string;
}

export interface OpenCodeProviderResultV2 extends OpenCodeCoreBindingV2 {
  readonly schema: typeof RALPH_OPENCODE_RESULT_SCHEMA_V2;
  readonly descriptorDigest: string;
  readonly dispatchIntentDigest: string;
  readonly sessionBindingDigest: string;
  readonly promptArtifactDigest: string;
  readonly openCodeSessionId: string;
  readonly openCodeUserMessageId: string;
  readonly assistantMessageId: string | null;
  readonly observedModelSelector: string;
  readonly classification: OpenCodePhysicalResultClassificationV2;
  readonly assistantContentDigest: string | null;
  readonly responseDigest: string;
  readonly observableTurnDigest: string | null;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly resultDigest: string;
}

const CORE_KEYS = ["runId", "phaseId", "taskId", "attemptId", "invocationId"] as const;

export function openCodePromptRefV2(attemptId: string): string {
  return attemptArtifactRefV2(attemptId, "opencode-prompt.json");
}

export function openCodeProviderResultRefV2(attemptId: string): string {
  return attemptArtifactRefV2(attemptId, "opencode-result.json");
}

export function createOpenCodePromptArtifactV2(input: Omit<OpenCodePromptArtifactV2, "schema" | "artifactDigest">): OpenCodePromptArtifactV2 {
  const base = { schema: RALPH_OPENCODE_PROMPT_SCHEMA_V2, ...input };
  const value = { ...base, artifactDigest: sha256Canonical(base) };
  validateOpenCodePromptArtifactV2(value);
  return freezeDeep(value);
}

export function createOpenCodeProviderResultV2(input: Omit<OpenCodeProviderResultV2, "schema" | "resultDigest">): OpenCodeProviderResultV2 {
  const base = { schema: RALPH_OPENCODE_RESULT_SCHEMA_V2, ...input };
  const value = { ...base, resultDigest: sha256Canonical(base) };
  validateOpenCodeProviderResultV2(value);
  return freezeDeep(value);
}

export function validateOpenCodePromptArtifactV2(value: unknown): asserts value is OpenCodePromptArtifactV2 {
  const record = requireRecord(value, "M4B_PROMPT_ARTIFACT_INVALID");
  assertExactKeys(record, ["schema", ...CORE_KEYS, "descriptorDigest", "dispatchIntentDigest", "sessionBindingDigest", "openCodeSessionId", "openCodeUserMessageId", "modelSelector", "promptDigest", "promptBytes", "preparedAt", "artifactDigest"]);
  if (record.schema !== RALPH_OPENCODE_PROMPT_SCHEMA_V2) invalid("M4B_PROMPT_ARTIFACT_INVALID");
  validateCore(record);
  for (const key of ["descriptorDigest", "dispatchIntentDigest", "sessionBindingDigest", "promptDigest", "artifactDigest"] as const) assertDigest(record[key]);
  assertSessionId(record.openCodeSessionId);
  assertMessageId(record.openCodeUserMessageId);
  assertSafeString(record.modelSelector, true);
  if (!Number.isSafeInteger(record.promptBytes) || Number(record.promptBytes) < 1 || Number(record.promptBytes) > 64 * 1024) invalid("M4B_PROMPT_ARTIFACT_INVALID");
  assertTimestamp(record.preparedAt);
  assertOwnDigest(record, "artifactDigest");
  assertSafe(record);
}

export function validateOpenCodeProviderResultV2(value: unknown): asserts value is OpenCodeProviderResultV2 {
  const record = requireRecord(value, "M4B_PROVIDER_RESULT_INVALID");
  assertExactKeys(record, ["schema", ...CORE_KEYS, "descriptorDigest", "dispatchIntentDigest", "sessionBindingDigest", "promptArtifactDigest", "openCodeSessionId", "openCodeUserMessageId", "assistantMessageId", "observedModelSelector", "classification", "assistantContentDigest", "responseDigest", "observableTurnDigest", "startedAt", "finishedAt", "resultDigest"]);
  if (record.schema !== RALPH_OPENCODE_RESULT_SCHEMA_V2) invalid("M4B_PROVIDER_RESULT_INVALID");
  validateCore(record);
  for (const key of ["descriptorDigest", "dispatchIntentDigest", "sessionBindingDigest", "promptArtifactDigest", "responseDigest", "resultDigest"] as const) assertDigest(record[key]);
  assertSessionId(record.openCodeSessionId);
  assertMessageId(record.openCodeUserMessageId);
  if (record.assistantMessageId !== null) assertMessageId(record.assistantMessageId);
  assertSafeString(record.observedModelSelector, true);
  if (!OPENCODE_PHYSICAL_RESULT_CLASSIFICATIONS_V2.includes(record.classification as OpenCodePhysicalResultClassificationV2)) invalid("M4B_PROVIDER_RESULT_INVALID");
  if (record.assistantContentDigest !== null) assertDigest(record.assistantContentDigest);
  if (record.observableTurnDigest !== null) assertDigest(record.observableTurnDigest);
  if ((record.classification === "SUCCEEDED" || record.classification === "FAILED")
    && (record.assistantMessageId === null || record.assistantContentDigest === null || record.observableTurnDigest === null)) invalid("M4B_PROVIDER_RESULT_INVALID");
  if (record.classification !== "SUCCEEDED" && record.classification !== "FAILED"
    && (record.assistantMessageId !== null || record.assistantContentDigest !== null || record.observableTurnDigest !== null)) invalid("M4B_PROVIDER_RESULT_INVALID");
  assertTimestamp(record.startedAt);
  assertTimestamp(record.finishedAt);
  assertOwnDigest(record, "resultDigest");
  assertSafe(record);
}

export async function persistOpenCodePromptArtifactV2(store: RalphEventStoreV2, value: OpenCodePromptArtifactV2, nonce: string): Promise<ArtifactPersistenceResultV2<OpenCodePromptArtifactV2>> {
  validateOpenCodePromptArtifactV2(value);
  assertStore(store, value);
  const facts = await readProviderInvocationArtifactSetV2(store, value.attemptId);
  if (!facts.descriptor || !facts.dispatchIntent || !facts.sessionBinding
    || !sameCoreBinding(value, facts.descriptor)
    || value.descriptorDigest !== facts.descriptor.descriptorDigest
    || value.dispatchIntentDigest !== facts.dispatchIntent.intentDigest
    || value.sessionBindingDigest !== facts.sessionBinding.bindingDigest
    || value.openCodeSessionId !== facts.sessionBinding.openCodeSessionId
    || value.openCodeUserMessageId !== facts.dispatchIntent.openCodeUserMessageId
    || value.modelSelector !== facts.descriptor.modelSelector) invalid("M4B_PROMPT_ARTIFACT_BINDING_INVALID");
  return persistImmutableJsonArtifactV2({ store, ref: openCodePromptRefV2(value.attemptId), artifact: value, validate: validateOpenCodePromptArtifactV2, nonce });
}

export async function persistOpenCodeProviderResultV2(store: RalphEventStoreV2, value: OpenCodeProviderResultV2, nonce: string): Promise<ArtifactPersistenceResultV2<OpenCodeProviderResultV2>> {
  validateOpenCodeProviderResultV2(value);
  assertStore(store, value);
  const [facts, prompt] = await Promise.all([
    readProviderInvocationArtifactSetV2(store, value.attemptId),
    readOpenCodePromptArtifactV2(store, value.attemptId),
  ]);
  if (!facts.descriptor || !facts.dispatchIntent || !facts.sessionBinding || !prompt
    || !sameCoreBinding(value, facts.descriptor)
    || value.descriptorDigest !== facts.descriptor.descriptorDigest
    || value.dispatchIntentDigest !== facts.dispatchIntent.intentDigest
    || value.sessionBindingDigest !== facts.sessionBinding.bindingDigest
    || value.promptArtifactDigest !== prompt.artifactDigest
    || value.openCodeSessionId !== facts.sessionBinding.openCodeSessionId
    || value.openCodeUserMessageId !== facts.dispatchIntent.openCodeUserMessageId
    || value.observedModelSelector !== facts.descriptor.modelSelector) invalid("M4B_PROVIDER_RESULT_BINDING_INVALID");
  return persistImmutableJsonArtifactV2({ store, ref: openCodeProviderResultRefV2(value.attemptId), artifact: value, validate: validateOpenCodeProviderResultV2, nonce });
}

export async function readOpenCodePromptArtifactV2(store: RalphEventStoreV2, attemptId: string): Promise<OpenCodePromptArtifactV2 | undefined> {
  return readImmutableJsonArtifactV2({ store, ref: openCodePromptRefV2(attemptId), validate: validateOpenCodePromptArtifactV2 });
}

export async function readOpenCodeProviderResultV2(store: RalphEventStoreV2, attemptId: string): Promise<OpenCodeProviderResultV2 | undefined> {
  return readImmutableJsonArtifactV2({ store, ref: openCodeProviderResultRefV2(attemptId), validate: validateOpenCodeProviderResultV2 });
}

function validateCore(record: Record<string, unknown>): void {
  for (const key of CORE_KEYS) assertSafeString(record[key], false);
}

function assertStore(store: RalphEventStoreV2, value: OpenCodeCoreBindingV2): void {
  if (store.runId !== value.runId) invalid("M4B_PROVIDER_RESULT_INVALID");
}

function sameCoreBinding(left: OpenCodeCoreBindingV2, right: OpenCodeCoreBindingV2): boolean {
  return CORE_KEYS.every((key) => left[key] === right[key]);
}

function assertSessionId(value: unknown): void {
  if (typeof value !== "string" || !/^ses_[A-Za-z0-9_-]{8,128}$/.test(value)) invalid("M4B_SESSION_BINDING_INVALID");
}

function assertMessageId(value: unknown): void {
  if (typeof value !== "string" || !/^msg_[A-Za-z0-9_-]{3,128}$/.test(value)) invalid("M4B_PROVIDER_RESULT_INVALID");
}

function assertDigest(value: unknown): void {
  if (!isSha256Digest(value)) invalid("M4B_PROVIDER_RESULT_INVALID");
}

function assertSafeString(value: unknown, slashAllowed: boolean): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || value.includes("\0") || (!slashAllowed && value.includes("/"))) invalid("M4B_PROVIDER_RESULT_INVALID");
}

function assertTimestamp(value: unknown): void {
  if (typeof value !== "string" || value.length < 20 || value.length > 64 || !Number.isFinite(Date.parse(value))) invalid("M4B_PROVIDER_RESULT_INVALID");
}

function assertOwnDigest(record: Record<string, unknown>, field: "artifactDigest" | "resultDigest"): void {
  const { [field]: _ignored, ...base } = record;
  if (record[field] !== sha256Canonical(base)) invalid("M4B_PROVIDER_RESULT_INVALID");
}

function assertSafe(record: Record<string, unknown>): void {
  try { assertNoCredentialMaterial(record, "M4B_PROVIDER_CREDENTIAL_MATERIAL"); }
  catch (error) {
    if (error instanceof RalphCredentialSafetyError) invalid("M4B_PROVIDER_CREDENTIAL_MATERIAL", error);
    throw error;
  }
  if (Buffer.byteLength(canonicalJson(record), "utf8") > 32 * 1024) invalid("M4B_PROVIDER_RESULT_INVALID");
}

function assertExactKeys(record: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys);
  if (Object.keys(record).some((key) => !allowed.has(key))) invalid("M4B_PROVIDER_RESULT_INVALID");
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(message);
  return value as Record<string, unknown>;
}

function invalid(message: string, cause?: unknown): never {
  throw new RalphB4ArtifactError("B4_ARTIFACT_INVALID", message, cause);
}

function freezeDeep<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  return value;
}
