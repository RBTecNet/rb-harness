import type { Finding } from "../contracts.js";
import { canonicalJson } from "../canonical-json.js";
import { sha256Canonical } from "../hashing.js";
import type { RalphEventStoreV2 } from "../operational-b1/index.js";
import {
  correctionContextRefV2,
  createCorrectionContextV2,
  readCorrectionContextV2,
  validateCorrectionContextV2,
  type CorrectionContextV2,
  type CorrectionSourceAttemptV2,
} from "../operational-f/correction-context.js";
import { ExecutorRuntimeError } from "./executor-runtime.js";
import type { ProviderInvocationDescriptorV2 } from "./provider-invocation-artifacts.js";

/**
 * M4-C admits a correction Attempt into the frozen M4-B provider transport.
 * It introduces no event, no reducer branch and no AttemptStage: the only new
 * authority is a *verification* of the already frozen
 * `rb-ralph-correction-context/v1` adjunct against the durable Core ledger
 * before any provider physical side effect.
 */
export const M4C_ERROR_CODES = [
  "M4C_CORRECTION_CONTEXT_REQUIRED",
  "M4C_CORRECTION_CONTEXT_INVALID",
  "M4C_CORRECTION_CONTEXT_BINDING_INVALID",
  "M4C_CORRECTION_DESCRIPTOR_BINDING_INVALID",
  "M4C_CORRECTION_FINDING_SET_INCOMPLETE",
  "M4C_CORRECTION_FINDING_UNKNOWN",
  "M4C_CORRECTION_FINDING_FOREIGN",
  "M4C_CORRECTION_FINDING_DIGEST_MISMATCH",
  "M4C_CORRECTION_FINDING_BINDING_INVALID",
  "M4C_CORRECTION_SOURCE_ATTEMPT_INVALID",
  "M4C_CORRECTION_PROMPT_PROJECTION_INVALID",
] as const;
export type M4CErrorCode = typeof M4C_ERROR_CODES[number];

/**
 * A typed M4-C failure is a frozen B4 protocol-before-start failure, exactly
 * like `RalphM4BError`. Correction admission therefore closes through the
 * existing B4 path without a new closure reason.
 */
export class RalphM4CError extends ExecutorRuntimeError {
  readonly name = "RalphM4CError";

  constructor(readonly m4cCode: M4CErrorCode, message: string = m4cCode, cause?: unknown) {
    super("B4_EXECUTOR_PROTOCOL_FAILURE_BEFORE_START", message, cause);
  }
}

/**
 * Finding statuses that are no longer authoritative correction input. A
 * RESOLVED or SUPERSEDED Finding is excluded from the authoritative open set,
 * so a context still naming one can never match the required complete set.
 */
const CLOSED_FINDING_STATUSES = ["RESOLVED", "SUPERSEDED"] as const;

export interface DurableAttemptFactsV2 {
  readonly attemptId: string;
  readonly phaseId: string;
  readonly taskId: string;
  readonly ordinal: number;
  readonly closureReason: string | null;
  readonly auditPackageDigest: string | null;
  readonly validationSetDigest: string | null;
}

export interface DurableCorrectionAuthorityV2 {
  /** Latest durable record for every Finding the ledger has ever emitted. */
  readonly findings: ReadonlyMap<string, Finding>;
  readonly attempts: ReadonlyMap<string, DurableAttemptFactsV2>;
}

/**
 * Fold the sealed, hash-chained V2 ledger into the exact Finding and Attempt
 * authority. This is deliberately derived from durable Core facts rather than
 * accepted from a caller: an Executor never receives correction input it did
 * not independently prove.
 */
export async function deriveDurableCorrectionAuthorityV2(store: RalphEventStoreV2): Promise<DurableCorrectionAuthorityV2> {
  const inspection = await store.inspect();
  const findings = new Map<string, Finding>();
  const attempts = new Map<string, DurableAttemptFactsV2>();
  for (const event of inspection.events) {
    switch (event.eventType) {
      case "finding.state-changed": {
        const finding = event.payload.finding;
        findings.set(finding.id, finding);
        break;
      }
      case "attempt.started": {
        const attemptId = event.payload.attemptId;
        attempts.set(attemptId, {
          attemptId,
          phaseId: event.phaseId ?? "",
          taskId: event.payload.taskId,
          ordinal: event.payload.ordinal,
          closureReason: null,
          auditPackageDigest: null,
          validationSetDigest: null,
        });
        break;
      }
      case "attempt.audit-ready": {
        const existing = event.attemptId === undefined ? undefined : attempts.get(event.attemptId);
        if (existing) {
          attempts.set(existing.attemptId, {
            ...existing,
            auditPackageDigest: event.payload.auditPackageDigest,
            validationSetDigest: event.payload.validationSetDigest,
          });
        }
        break;
      }
      case "attempt.closed": {
        const existing = attempts.get(event.payload.attemptId);
        if (existing) attempts.set(existing.attemptId, { ...existing, closureReason: event.payload.closureReason });
        break;
      }
      default:
        break;
    }
  }
  return Object.freeze({ findings, attempts });
}

/** The exact authoritative OPEN Finding set for one Task, ordered by identity. */
export function authoritativeOpenFindingsForTaskV2(authority: DurableCorrectionAuthorityV2, taskId: string): readonly Finding[] {
  return [...authority.findings.values()]
    .filter((finding) => finding.taskId === taskId && !CLOSED_FINDING_STATUSES.includes(finding.status as typeof CLOSED_FINDING_STATUSES[number]))
    .sort((left, right) => left.id.localeCompare(right.id));
}

/** The exact authoritative rejected source Attempts for one Task, ordered by ordinal. */
export function authoritativeRejectedAttemptsForTaskV2(authority: DurableCorrectionAuthorityV2, taskId: string): readonly CorrectionSourceAttemptV2[] {
  return [...authority.attempts.values()]
    .filter((attempt) => attempt.taskId === taskId
      && attempt.closureReason === "AUDIT_REJECTED"
      && attempt.auditPackageDigest !== null
      && attempt.validationSetDigest !== null)
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((attempt) => Object.freeze({
      attemptId: attempt.attemptId,
      ordinal: attempt.ordinal,
      closureReason: "AUDIT_REJECTED" as const,
      auditPackageDigest: attempt.auditPackageDigest!,
      validationSetDigest: attempt.validationSetDigest!,
    }));
}

export interface BuildExactCorrectionContextV2Input {
  readonly store: RalphEventStoreV2;
  readonly runId: string;
  readonly phaseId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly baseWorkspaceFingerprint: string;
  readonly createdAt: string;
}

/**
 * Derive the exact CorrectionContext for one admitted correction Attempt
 * straight from the durable ledger, using the same frozen
 * `rb-ralph-correction-context/v1` shape and the same Core-derived ordering
 * the F driver uses. Returns `undefined` when no OPEN Finding authorizes a
 * correction, so a base Attempt can never acquire correction input.
 */
export async function buildExactCorrectionContextV2(input: BuildExactCorrectionContextV2Input): Promise<CorrectionContextV2 | undefined> {
  if (input.store.runId !== input.runId) throw new RalphM4CError("M4C_CORRECTION_CONTEXT_BINDING_INVALID", "M4C_CORRECTION_CONTEXT_BINDING_INVALID: foreign run");
  const authority = await deriveDurableCorrectionAuthorityV2(input.store);
  const openFindings = authoritativeOpenFindingsForTaskV2(authority, input.taskId);
  if (openFindings.length === 0) return undefined;
  const sourceRejectedAttempts = authoritativeRejectedAttemptsForTaskV2(authority, input.taskId)
    .filter((source) => source.attemptId !== input.attemptId);
  return createCorrectionContextV2({
    runId: input.runId,
    phaseId: input.phaseId,
    taskId: input.taskId,
    currentAttemptId: input.attemptId,
    sourceRejectedAttempts,
    openFindingRefs: openFindings.map((finding) => finding.id),
    openFindings: openFindings.map((finding) => ({
      findingId: finding.id,
      findingDigest: sha256Canonical(finding),
      criterionId: finding.criterionId,
      severity: finding.severity,
      status: finding.status as CorrectionContextV2["openFindings"][number]["status"],
      observed: finding.observed,
      ...(finding.remediationHint === undefined ? {} : { remediationHint: finding.remediationHint }),
    })),
    baseWorkspaceFingerprint: input.baseWorkspaceFingerprint,
    createdAt: input.createdAt,
  });
}

export interface ValidateExactCorrectionContextV2Input {
  readonly store: RalphEventStoreV2;
  readonly descriptor: ProviderInvocationDescriptorV2;
}

/**
 * Admit — or refuse — one correction Attempt.
 *
 * Returns `undefined` for an ordinary base Attempt. For a correction Attempt
 * it returns the exact immutable durable context only after every binding,
 * digest and Finding has been proven against the durable Core authority.
 * Anything else throws before the caller reaches any provider side effect,
 * so an invalid context produces zero descriptors, zero sessions and zero
 * prompts.
 */
export async function validateExactCorrectionContextForDispatchV2(
  input: ValidateExactCorrectionContextV2Input,
): Promise<CorrectionContextV2 | undefined> {
  const descriptor = input.descriptor;
  let context: CorrectionContextV2 | undefined;
  try {
    context = await readCorrectionContextV2(input.store, descriptor.attemptId);
  } catch (error) {
    throw new RalphM4CError("M4C_CORRECTION_CONTEXT_INVALID", "M4C_CORRECTION_CONTEXT_INVALID: durable context is unreadable", error);
  }

  if (!context) {
    // A base Attempt must not carry a correction binding it cannot prove.
    if (descriptor.correctionContextRef !== null || descriptor.correctionContextDigest !== null) {
      throw new RalphM4CError("M4C_CORRECTION_DESCRIPTOR_BINDING_INVALID", "M4C_CORRECTION_DESCRIPTOR_BINDING_INVALID: descriptor claims a correction context that is not durable");
    }
    // 4/6. Correction is driven by durable Findings, never by the Attempt
    // ordinal. An Attempt dispatched while Core holds OPEN Findings for this
    // Task without the exact correction authority is the ordinal-blind hole,
    // so it fails closed before any provider side effect.
    const baseAuthority = await deriveDurableCorrectionAuthorityV2(input.store);
    if (authoritativeOpenFindingsForTaskV2(baseAuthority, descriptor.taskId).length > 0) {
      throw new RalphM4CError("M4C_CORRECTION_CONTEXT_REQUIRED", "M4C_CORRECTION_CONTEXT_REQUIRED: OPEN Findings exist for this Task but no durable CorrectionContext authorizes this Attempt");
    }
    return undefined;
  }

  try { validateCorrectionContextV2(context); }
  catch (error) { throw new RalphM4CError("M4C_CORRECTION_CONTEXT_INVALID", "M4C_CORRECTION_CONTEXT_INVALID: durable context failed its frozen schema", error); }

  // 7. The provider descriptor binding is HARD: a correction Attempt whose
  // descriptor lost the context ref/digest is not dispatchable.
  if (descriptor.correctionContextRef !== correctionContextRefV2(descriptor.attemptId)
    || descriptor.correctionContextDigest !== context.contextDigest) {
    throw new RalphM4CError("M4C_CORRECTION_DESCRIPTOR_BINDING_INVALID");
  }

  if (context.runId !== descriptor.runId
    || context.phaseId !== descriptor.phaseId
    || context.taskId !== descriptor.taskId
    || context.currentAttemptId !== descriptor.attemptId
    || context.baseWorkspaceFingerprint !== descriptor.baseWorkspaceFingerprint) {
    throw new RalphM4CError("M4C_CORRECTION_CONTEXT_BINDING_INVALID");
  }
  if (input.store.runId !== context.runId) throw new RalphM4CError("M4C_CORRECTION_CONTEXT_BINDING_INVALID", "M4C_CORRECTION_CONTEXT_BINDING_INVALID: foreign run");

  const authority = await deriveDurableCorrectionAuthorityV2(input.store);

  // 4. The context must carry the *complete* authoritative OPEN Finding set.
  // Omitting one, or inserting one that Core does not currently hold open,
  // both fail here before any provider descriptor is persisted.
  const expectedFindings = authoritativeOpenFindingsForTaskV2(authority, context.taskId);
  if (expectedFindings.length === 0) {
    throw new RalphM4CError("M4C_CORRECTION_FINDING_SET_INCOMPLETE", "M4C_CORRECTION_FINDING_SET_INCOMPLETE: no OPEN Finding authorizes a correction Attempt");
  }
  const expectedRefs = expectedFindings.map((finding) => finding.id);
  if (canonicalJson([...context.openFindingRefs].sort()) !== canonicalJson(expectedRefs)
    || canonicalJson(context.openFindings.map((finding) => finding.findingId)) !== canonicalJson(expectedRefs)) {
    throw new RalphM4CError("M4C_CORRECTION_FINDING_SET_INCOMPLETE");
  }

  for (const declared of context.openFindings) {
    const durable = authority.findings.get(declared.findingId);
    if (!durable) throw new RalphM4CError("M4C_CORRECTION_FINDING_UNKNOWN");
    if (durable.taskId !== context.taskId || durable.phaseId !== context.phaseId) throw new RalphM4CError("M4C_CORRECTION_FINDING_FOREIGN");
    if (declared.findingDigest !== sha256Canonical(durable)) throw new RalphM4CError("M4C_CORRECTION_FINDING_DIGEST_MISMATCH");
    if (declared.criterionId !== durable.criterionId
      || declared.severity !== durable.severity
      || declared.status !== durable.status
      || declared.observed !== durable.observed
      || declared.remediationHint !== durable.remediationHint) {
      throw new RalphM4CError("M4C_CORRECTION_FINDING_BINDING_INVALID");
    }
  }

  // 3. The rejected source Attempts are Core-derived, never caller-supplied.
  const expectedSources = authoritativeRejectedAttemptsForTaskV2(authority, context.taskId);
  if (expectedSources.length === 0) throw new RalphM4CError("M4C_CORRECTION_SOURCE_ATTEMPT_INVALID", "M4C_CORRECTION_SOURCE_ATTEMPT_INVALID: no rejected Attempt precedes this correction");
  if (canonicalJson(context.sourceRejectedAttempts) !== canonicalJson(expectedSources)) throw new RalphM4CError("M4C_CORRECTION_SOURCE_ATTEMPT_INVALID");
  if (context.sourceRejectedAttempts.some((source) => source.attemptId === context.currentAttemptId)) {
    throw new RalphM4CError("M4C_CORRECTION_SOURCE_ATTEMPT_INVALID", "M4C_CORRECTION_SOURCE_ATTEMPT_INVALID: an Attempt cannot correct itself");
  }

  return context;
}
