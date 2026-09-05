import type { AuditResult, ValidationRef } from "./contracts.js";

export interface AuditBindingContext {
  readonly runId: string;
  readonly phaseId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly currentAttemptId: string;
  readonly currentEvidenceSetId: string;
  readonly currentEvidenceDigest: string;
  readonly currentValidationSetDigest: string;
  readonly currentPostExecutorFingerprint: string;
  readonly criterionSetVersion: string;
  readonly criterionSetDigest: string;
  readonly auditorProfileDigest: string;
  readonly validationResults: readonly ValidationRef[];
  readonly newerEvidenceExists: boolean;
}

export type AuditBindingFailure =
  | "IDENTITY_MISMATCH"
  | "EVIDENCE_MISSING"
  | "EVIDENCE_STALE"
  | "VALIDATION_STALE"
  | "WORKSPACE_STALE"
  | "CRITERION_STALE"
  | "PROFILE_STALE"
  | "DETERMINISTIC_VALIDATION_FAILED"
  | "ATTEMPT_STALE";

export type AuditBindingValidation = { readonly valid: true } | { readonly valid: false; readonly reason: AuditBindingFailure };

export function validateAuditBinding(result: AuditResult, context: AuditBindingContext): AuditBindingValidation {
  const binding = result.binding;
  if (binding.runId !== context.runId || binding.phaseId !== context.phaseId || binding.taskId !== context.taskId) return { valid: false, reason: "IDENTITY_MISMATCH" };
  if (binding.attemptId !== context.attemptId || context.currentAttemptId !== binding.attemptId) return { valid: false, reason: "ATTEMPT_STALE" };
  if (!binding.evidenceSetId || !binding.evidenceDigest) return { valid: false, reason: "EVIDENCE_MISSING" };
  if (binding.evidenceSetId !== context.currentEvidenceSetId || binding.evidenceDigest !== context.currentEvidenceDigest || context.newerEvidenceExists) return { valid: false, reason: "EVIDENCE_STALE" };
  if (result.result === "PASS" && !result.criteria.some((criterion) => criterion.evidenceRefs.some((reference) => reference.evidenceSetId === binding.evidenceSetId && reference.digest === binding.evidenceDigest && reference.integrity === "VERIFIED"))) return { valid: false, reason: "EVIDENCE_MISSING" };
  if (binding.validationSetDigest !== context.currentValidationSetDigest) return { valid: false, reason: "VALIDATION_STALE" };
  if (binding.postExecutorFingerprint !== context.currentPostExecutorFingerprint) return { valid: false, reason: "WORKSPACE_STALE" };
  if (binding.criterionSetVersion !== context.criterionSetVersion || binding.criterionSetDigest !== context.criterionSetDigest) return { valid: false, reason: "CRITERION_STALE" };
  if (binding.auditorProfileDigest !== context.auditorProfileDigest) return { valid: false, reason: "PROFILE_STALE" };
  if (context.validationResults.some((validation) => validation.result === "FAIL")) return { valid: false, reason: "DETERMINISTIC_VALIDATION_FAILED" };
  return { valid: true };
}

export function assertAuditBinding(result: AuditResult, context: AuditBindingContext): void {
  const validation = validateAuditBinding(result, context);
  if (!validation.valid) throw new Error(`RALPH_AUDIT_BINDING_REJECTED: ${validation.reason}`);
}

export function auditMayApprove(result: AuditResult, context: AuditBindingContext): boolean {
  return (result.result === "PASS" || result.result === "NOT_APPLICABLE") && validateAuditBinding(result, context).valid;
}
