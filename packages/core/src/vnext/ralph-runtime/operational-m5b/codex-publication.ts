import { dirname, join, resolve } from "node:path";
import { sha256, sha256Canonical, isSha256Digest } from "../hashing.js";
import { fingerprintWorkspace, type WorkspaceFingerprintPolicyInput } from "../fingerprint.js";
import { isWorkspacePackageInfrastructurePathV1 } from "../package-infrastructure.js";
import type { RalphEventStoreV2 } from "../operational-b1/index.js";
import {
  attemptArtifactRefV2,
  ensureAttemptArtifactDirectoryV2,
  persistImmutableJsonArtifactV2,
  readImmutableJsonArtifactV2,
} from "../operational-b4/artifacts.js";
import { RalphM5BError } from "./contract.js";
import { assertSafeRelativePathV2, isCodexProjectionExcludedPathV2 } from "./codex-projection.js";
import {
  validateCodexWorkspaceDeltaV2,
  type CodexDeltaOperationV2,
  type CodexWorkspaceDeltaV2,
} from "./codex-delta.js";
import { codexWorkspaceDeltaRefV2, type CodexCoreBindingV2 } from "./codex-artifacts.js";

export const RALPH_CODEX_PUBLICATION_INTENT_SCHEMA_V2 = "rb-ralph-codex-publication-intent/v1" as const;
export const RALPH_CODEX_PUBLICATION_RECEIPT_SCHEMA_V2 = "rb-ralph-codex-publication-receipt/v1" as const;

export const CODEX_PUBLICATION_ENTRY_STATES_V2 = ["NOT_APPLIED", "APPLIED"] as const;
export type CodexPublicationEntryStateV2 = typeof CODEX_PUBLICATION_ENTRY_STATES_V2[number];

export interface CodexPublicationEntryIntentV2 {
  readonly path: string;
  readonly operation: CodexDeltaOperationV2;
  readonly preimageDigest: string | null;
  readonly postimageDigest: string | null;
  readonly mode: number | null;
}

export interface CodexPublicationIntentV2 extends CodexCoreBindingV2 {
  readonly schema: typeof RALPH_CODEX_PUBLICATION_INTENT_SCHEMA_V2;
  readonly deltaRef: string;
  readonly deltaDigest: string;
  readonly canonicalPreFingerprint: string;
  readonly canonicalPreControlPlaneFingerprint: string;
  readonly entries: readonly CodexPublicationEntryIntentV2[];
  readonly entryCount: number;
  readonly createdAt: string;
  readonly publicationIntentDigest: string;
}

export interface CodexPublicationEntryOutcomeV2 {
  readonly path: string;
  readonly observedBefore: CodexPublicationEntryStateV2;
  readonly disposition: "APPLIED_BY_THIS_CALL" | "ALREADY_APPLIED";
}

export interface CodexPublicationReceiptV2 extends CodexCoreBindingV2 {
  readonly schema: typeof RALPH_CODEX_PUBLICATION_RECEIPT_SCHEMA_V2;
  readonly publicationIntentDigest: string;
  readonly deltaDigest: string;
  readonly entries: readonly CodexPublicationEntryOutcomeV2[];
  readonly appliedCount: number;
  readonly alreadyAppliedCount: number;
  readonly canonicalPostFingerprint: string;
  readonly canonicalPostControlPlaneFingerprint: string;
  readonly completedAt: string;
  readonly receiptDigest: string;
}

export const codexPublicationIntentRefV2 = (attemptId: string): string => attemptArtifactRefV2(attemptId, "codex-publication-intent.json");
export const codexPublicationReceiptRefV2 = (attemptId: string): string => attemptArtifactRefV2(attemptId, "codex-publication-receipt.json");

export const readCodexPublicationIntentV2 = (store: RalphEventStoreV2, attemptId: string): Promise<CodexPublicationIntentV2 | undefined> =>
  readImmutableJsonArtifactV2({ store, ref: codexPublicationIntentRefV2(attemptId), validate: validateCodexPublicationIntentV2 });
export const readCodexPublicationReceiptV2 = (store: RalphEventStoreV2, attemptId: string): Promise<CodexPublicationReceiptV2 | undefined> =>
  readImmutableJsonArtifactV2({ store, ref: codexPublicationReceiptRefV2(attemptId), validate: validateCodexPublicationReceiptV2 });

export function validateCodexPublicationIntentV2(value: unknown): asserts value is CodexPublicationIntentV2 {
  if (!isRecord(value)) throw new RalphM5BError("M5B_PUBLICATION_INVALID");
  assertExactKeys(value, [
    "schema", "runId", "phaseId", "taskId", "attemptId", "invocationId", "deltaRef", "deltaDigest",
    "canonicalPreFingerprint", "canonicalPreControlPlaneFingerprint", "entries", "entryCount", "createdAt", "publicationIntentDigest",
  ]);
  if (value.schema !== RALPH_CODEX_PUBLICATION_INTENT_SCHEMA_V2) throw new RalphM5BError("M5B_PUBLICATION_INVALID", "M5B_PUBLICATION_INVALID: schema");
  if (!Array.isArray(value.entries) || value.entries.length !== value.entryCount) throw new RalphM5BError("M5B_PUBLICATION_INVALID", "M5B_PUBLICATION_INVALID: entries");
  for (const entry of value.entries) {
    if (!isRecord(entry)) throw new RalphM5BError("M5B_PUBLICATION_INVALID", "M5B_PUBLICATION_INVALID: entry");
    assertExactKeys(entry, ["path", "operation", "preimageDigest", "postimageDigest", "mode"]);
    assertSafeRelativePathV2(entry.path);
    if (isWorkspacePackageInfrastructurePathV1(entry.path as string)) throw new RalphM5BError("M5B_DELTA_PATH_FORBIDDEN", `M5B_DELTA_PATH_FORBIDDEN: ${String(entry.path)}`);
    if (isCodexProjectionExcludedPathV2(entry.path as string)) throw new RalphM5BError("M5B_DELTA_PATH_FORBIDDEN", `M5B_DELTA_PATH_FORBIDDEN: ${String(entry.path)}`);
  }
  if (!isSha256Digest(value.publicationIntentDigest)) throw new RalphM5BError("M5B_PUBLICATION_INVALID", "M5B_PUBLICATION_INVALID: digest");
  const { publicationIntentDigest: _ignored, ...base } = value;
  if (sha256Canonical(base) !== value.publicationIntentDigest) throw new RalphM5BError("M5B_PUBLICATION_INVALID", "M5B_PUBLICATION_INVALID: digest mismatch");
}

export function validateCodexPublicationReceiptV2(value: unknown): asserts value is CodexPublicationReceiptV2 {
  if (!isRecord(value)) throw new RalphM5BError("M5B_PUBLICATION_INVALID");
  assertExactKeys(value, [
    "schema", "runId", "phaseId", "taskId", "attemptId", "invocationId", "publicationIntentDigest", "deltaDigest", "entries",
    "appliedCount", "alreadyAppliedCount", "canonicalPostFingerprint", "canonicalPostControlPlaneFingerprint", "completedAt", "receiptDigest",
  ]);
  if (value.schema !== RALPH_CODEX_PUBLICATION_RECEIPT_SCHEMA_V2) throw new RalphM5BError("M5B_PUBLICATION_INVALID", "M5B_PUBLICATION_INVALID: schema");
  if (!isSha256Digest(value.receiptDigest)) throw new RalphM5BError("M5B_PUBLICATION_INVALID", "M5B_PUBLICATION_INVALID: digest");
  const { receiptDigest: _ignored, ...base } = value;
  if (sha256Canonical(base) !== value.receiptDigest) throw new RalphM5BError("M5B_PUBLICATION_INVALID", "M5B_PUBLICATION_INVALID: digest mismatch");
}

export interface PublishCodexWorkspaceDeltaInputV2 {
  readonly store: RalphEventStoreV2;
  readonly delta: CodexWorkspaceDeltaV2;
  readonly workspacePolicy: WorkspaceFingerprintPolicyInput;
  readonly clock: () => string;
  readonly nonceFactory: () => string;
}

/**
 * Publish the sealed provider delta into the canonical workspace.
 *
 * This is a mechanical transport with no semantic authority: every byte it
 * writes comes from the sealed delta and is verified against the sealed
 * postimage digest afterwards.  The operation is idempotent, crash
 * recoverable from durable state alone, and never asks the provider to run
 * again.
 */
export async function publishCodexWorkspaceDeltaV2(input: PublishCodexWorkspaceDeltaInputV2): Promise<CodexPublicationReceiptV2> {
  validateCodexWorkspaceDeltaV2(input.delta);
  const delta = input.delta;
  const projectRoot = resolve(input.store.projectRoot);
  await ensureAttemptArtifactDirectoryV2(input.store, delta.attemptId);
  const existingReceipt = await readCodexPublicationReceiptV2(input.store, delta.attemptId);
  if (existingReceipt) {
    if (existingReceipt.deltaDigest !== delta.deltaDigest) throw new RalphM5BError("M5B_PUBLICATION_INVALID", "M5B_PUBLICATION_INVALID: a different delta is already published");
    return existingReceipt;
  }

  let intent = await readCodexPublicationIntentV2(input.store, delta.attemptId);
  if (intent) {
    if (intent.deltaDigest !== delta.deltaDigest) throw new RalphM5BError("M5B_PUBLICATION_INVALID", "M5B_PUBLICATION_INVALID: publication intent binds a different delta");
  } else {
    // The canonical drift gate applies exactly once, before any byte is
    // written. A recovered publication continues from durable per-entry
    // state instead, because a partially published workspace is expected to
    // differ from the pre-dispatch fingerprint.
    const before = await fingerprintWorkspace(projectRoot, input.workspacePolicy);
    if (before.fingerprintDigest !== delta.baseWorkspaceFingerprint) {
      throw new RalphM5BError("M5B_CANONICAL_DRIFT", "M5B_CANONICAL_DRIFT: the canonical workspace changed after the provider baseline");
    }
    const base = {
      schema: RALPH_CODEX_PUBLICATION_INTENT_SCHEMA_V2,
      runId: delta.runId,
      phaseId: delta.phaseId,
      taskId: delta.taskId,
      attemptId: delta.attemptId,
      invocationId: delta.invocationId,
      deltaRef: codexWorkspaceDeltaRefV2(delta.attemptId),
      deltaDigest: delta.deltaDigest,
      canonicalPreFingerprint: before.fingerprintDigest,
      canonicalPreControlPlaneFingerprint: before.controlPlaneFingerprint,
      entries: delta.entries.map((entry) => Object.freeze({
        path: entry.path,
        operation: entry.operation,
        preimageDigest: entry.preimageDigest,
        postimageDigest: entry.postimageDigest,
        mode: entry.mode,
      })),
      entryCount: delta.entries.length,
      createdAt: input.clock(),
    };
    const candidate: CodexPublicationIntentV2 = Object.freeze({ ...base, publicationIntentDigest: sha256Canonical(base) });
    validateCodexPublicationIntentV2(candidate);
    await persistImmutableJsonArtifactV2({
      store: input.store,
      ref: codexPublicationIntentRefV2(delta.attemptId),
      artifact: candidate,
      validate: validateCodexPublicationIntentV2,
      nonce: input.nonceFactory(),
    });
    intent = await readCodexPublicationIntentV2(input.store, delta.attemptId) ?? candidate;
  }

  const outcomes: CodexPublicationEntryOutcomeV2[] = [];
  for (const entry of delta.entries) {
    const absolute = join(projectRoot, entry.path);
    const current = await readCanonicalDigestV2(input.store, absolute);
    const expectedPost = entry.operation === "DELETE" ? null : entry.postimageDigest;
    const expectedPre = entry.operation === "CREATE" ? null : entry.preimageDigest;
    if (current === expectedPost) {
      outcomes.push(Object.freeze({ path: entry.path, observedBefore: "APPLIED", disposition: "ALREADY_APPLIED" }));
      continue;
    }
    if (current !== expectedPre) {
      throw new RalphM5BError("M5B_PUBLICATION_RECONCILIATION_REQUIRED", `M5B_PUBLICATION_RECONCILIATION_REQUIRED: ${entry.path}`);
    }
    if (entry.operation === "DELETE") await deleteCanonicalFileV2(input.store, absolute);
    else await writeCanonicalFileV2(input.store, absolute, Buffer.from(entry.postimageBase64!, "base64"), entry.mode ?? 0o644, input.nonceFactory());
    outcomes.push(Object.freeze({ path: entry.path, observedBefore: "NOT_APPLIED", disposition: "APPLIED_BY_THIS_CALL" }));
  }

  // Positive verification: the canonical bytes must be exactly the sealed
  // provider postimage. Publication that diverged from the sealed delta —
  // for any reason, including a host-side edit — fails closed here.
  for (const entry of delta.entries) {
    const current = await readCanonicalDigestV2(input.store, join(projectRoot, entry.path));
    const expected = entry.operation === "DELETE" ? null : entry.postimageDigest;
    if (current !== expected) throw new RalphM5BError("M5B_PUBLICATION_DIVERGENCE", `M5B_PUBLICATION_DIVERGENCE: ${entry.path}`);
  }

  const after = await fingerprintWorkspace(projectRoot, input.workspacePolicy);
  if (after.controlPlaneFingerprint !== intent.canonicalPreControlPlaneFingerprint) {
    throw new RalphM5BError("M5B_PUBLICATION_DIVERGENCE", "M5B_PUBLICATION_DIVERGENCE: the control plane changed during publication");
  }
  const receiptBase = {
    schema: RALPH_CODEX_PUBLICATION_RECEIPT_SCHEMA_V2,
    runId: delta.runId,
    phaseId: delta.phaseId,
    taskId: delta.taskId,
    attemptId: delta.attemptId,
    invocationId: delta.invocationId,
    publicationIntentDigest: intent.publicationIntentDigest,
    deltaDigest: delta.deltaDigest,
    entries: outcomes,
    appliedCount: outcomes.filter((entry) => entry.disposition === "APPLIED_BY_THIS_CALL").length,
    alreadyAppliedCount: outcomes.filter((entry) => entry.disposition === "ALREADY_APPLIED").length,
    canonicalPostFingerprint: after.fingerprintDigest,
    canonicalPostControlPlaneFingerprint: after.controlPlaneFingerprint,
    completedAt: input.clock(),
  };
  const receipt: CodexPublicationReceiptV2 = Object.freeze({ ...receiptBase, receiptDigest: sha256Canonical(receiptBase) });
  validateCodexPublicationReceiptV2(receipt);
  await persistImmutableJsonArtifactV2({
    store: input.store,
    ref: codexPublicationReceiptRefV2(delta.attemptId),
    artifact: receipt,
    validate: validateCodexPublicationReceiptV2,
    nonce: input.nonceFactory(),
  });
  return await readCodexPublicationReceiptV2(input.store, delta.attemptId) ?? receipt;
}

async function readCanonicalDigestV2(store: RalphEventStoreV2, absolute: string): Promise<string | null> {
  let stats;
  try { stats = await store.fileSystem.lstat(absolute); }
  catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw new RalphM5BError("M5B_PUBLICATION_INVALID", "M5B_PUBLICATION_INVALID: canonical path unreadable", error);
  }
  if (stats.isSymbolicLink() || !stats.isFile()) throw new RalphM5BError("M5B_PUBLICATION_INVALID", `M5B_PUBLICATION_INVALID: ${absolute} is not a regular file`);
  return sha256(await store.fileSystem.readFile(absolute));
}

async function writeCanonicalFileV2(store: RalphEventStoreV2, absolute: string, bytes: Buffer, mode: number, nonce: string): Promise<void> {
  const directory = dirname(absolute);
  await store.fileSystem.mkdir(directory, { recursive: true, mode: 0o755 });
  const temporary = `${absolute}.rb-m5b-${/^[A-Za-z0-9._-]+$/.test(nonce) ? nonce : "publication"}`;
  await store.fileSystem.writeFile(temporary, bytes, { flag: "wx", mode });
  await store.fileSystem.fsyncFile(temporary);
  await store.fileSystem.rename(temporary, absolute);
  await store.fileSystem.fsyncDirectory(directory);
}

async function deleteCanonicalFileV2(store: RalphEventStoreV2, absolute: string): Promise<void> {
  const directory = dirname(absolute);
  await store.fileSystem.unlink(absolute);
  await store.fileSystem.fsyncDirectory(directory);
}

function assertExactKeys(value: object, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) throw new RalphM5BError("M5B_PUBLICATION_INVALID", `M5B_PUBLICATION_INVALID: unknown fields ${unknown.sort().join(",")}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
