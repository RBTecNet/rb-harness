import { randomUUID } from "node:crypto";
import type { ExecutionDocument } from "../../../types.js";
import type { CheckpointRecord, EvidenceRef, Finding } from "../contracts.js";
import { canonicalJson } from "../canonical-json.js";
import { sha256Canonical } from "../hashing.js";
import {
  assertLeasedRunV2,
  deriveExecutorReleaseProofV2,
  releaseLeasedRunV2,
  refreshLeasedRunV2,
  repairStateSnapshotWhileLeasedV2,
  revalidateLeaseOwnershipV2,
  type LeasedRunV2,
} from "../operational-b2/index.js";
import {
  createWorkUnitV2,
  createInvocationDescriptorV2,
  readInvocationDescriptorV2,
  readWorkUnitV2,
  type ArtifactBindingInputV2,
  type InvocationDescriptorV2,
  type WorkUnitV2,
} from "../operational-b3/index.js";
import {
  attemptArtifactRefV2,
  readInvocationResultV2,
  validateInvocationResultV2,
} from "../operational-b4/index.js";
import type { TrustedExecutorObservationV2 } from "../operational-b4/execution-observation.js";
import {
  observeWorkspaceManifestV2,
  readWorkspaceAfterManifestV2,
  workspaceManifestCoreJson,
  type WorkspaceManifestV2,
} from "../operational-b4/workspace-manifest.js";
import {
  readEvidenceCaptureV2,
  validateEvidenceCaptureV2,
  type EvidenceCaptureV2,
} from "../operational-c/index.js";
import {
  canCompleteRuntimeV2,
  type AttemptStateV2,
  type RalphRuntimeStateV2,
} from "../operational-v2/index.js";
import { deterministicValidationSummary } from "../operational-v2/state.js";
import {
  createRalphEventV2,
  V2_EVENT_ENTITY_KINDS,
  type EventPayloadMapV2,
  type RalphEventTypeV2,
  type RalphEventV2,
  type UnsignedRalphEventV2,
} from "../operational-v2/events.js";
import { commitRalphEventV2 } from "../operational-b1/index.js";
import {
  findingDigestV2,
  readAuditPackageV2,
  readValidationRunV2,
  readValidationSetV2,
  validateAuditPackageV2,
  validateValidationRunV2,
  validateValidationSetV2,
  auditPackageIdV2,
  validationRunRefFromArtifactV2,
  validationSetIdV2,
  type AuditPackageV2,
  type ValidationRunV2,
  type ValidationSetV2,
} from "../operational-d/artifacts.js";
import {
  assertAuditorResultEnvelopeV2,
  type AuditorResultEnvelopeV2,
} from "./auditor-runtime.js";
import {
  assertTrustedAuditorRuntimeV2,
  type TrustedAuditorRuntimeV2,
} from "./auditor-trust.js";
import {
  auditInvocationIdV2,
  createAuditInvocationDescriptorV2,
  createAuditResultV2,
  persistAuditInvocationDescriptorV2,
  persistAuditResultV2,
  readAuditInvocationDescriptorV2,
  readAuditResultV2,
  validateAuditInvocationDescriptorV2,
  validateAuditResultV2,
  type AuditInvocationDescriptorV2,
  type AuditResultV2,
  type ProposedFindingV2,
} from "./artifacts.js";

export const E_AUDIT_ERROR_CODES = [
  "E_LEASE_REQUIRED",
  "E_ATTEMPT_INVALID",
  "E_AUDIT_PACKAGE_REQUIRED",
  "E_AUDIT_PACKAGE_INVALID",
  "E_AUDIT_PACKAGE_BINDING_INVALID",
  "E_AUDITOR_TRUST_REQUIRED",
  "E_AUDITOR_RESULT_INVALID",
  "E_AUDITOR_RESULT_BINDING_INVALID",
  "E_FINDING_INVALID",
  "E_AUDIT_EVENT_DURABILITY_UNKNOWN",
  "E_WORKSPACE_RECONCILIATION_REQUIRED",
] as const;
export type EAuditErrorCode = typeof E_AUDIT_ERROR_CODES[number];

export class RalphEAuditError extends Error {
  constructor(readonly code: EAuditErrorCode, message: string = code, readonly cause?: unknown) {
    super(message);
    this.name = "RalphEAuditError";
  }
}

export interface AuditRunnerOptionsV2 {
  readonly executorObservation?: TrustedExecutorObservationV2;
  readonly clock?: () => string;
  readonly nonceFactory?: () => string;
  readonly eventIdFactory?: () => string;
  readonly workspaceFingerprintFileSystem?: import("../fingerprint.js").WorkspaceFingerprintFileSystem;
}

export interface AuditAttemptV2Input extends AuditRunnerOptionsV2 {
  readonly leasedRun: LeasedRunV2;
  readonly plan: ExecutionDocument;
  readonly auditor: TrustedAuditorRuntimeV2;
  readonly attemptId?: string;
}

export type AuditAttemptV2Result =
  | {
    readonly kind: "AUDIT_ACCEPTED";
    readonly outcome: "AUDIT_ACCEPTED";
    readonly state: RalphRuntimeStateV2;
    readonly attempt: AttemptStateV2;
    readonly auditInvocation: AuditInvocationDescriptorV2;
    readonly auditResult: AuditResultV2;
    readonly leaseReleased: true;
  }
  | {
    readonly kind: "AUDIT_REJECTED";
    readonly outcome: "AUDIT_REJECTED";
    readonly state: RalphRuntimeStateV2;
    readonly attempt: AttemptStateV2;
    readonly auditInvocation: AuditInvocationDescriptorV2;
    readonly auditResult: AuditResultV2;
    readonly leaseReleased: true;
  }
  | {
    readonly kind: "NOT_AUDITABLE";
    readonly outcome: "NOT_AUDITABLE";
    readonly state: RalphRuntimeStateV2;
    readonly attempt: AttemptStateV2;
    readonly auditPackage: AuditPackageV2;
    readonly leaseReleased: boolean;
  }
  | {
    readonly kind: "RECONCILIATION_REQUIRED";
    readonly outcome: "RECONCILIATION_REQUIRED";
    readonly state: RalphRuntimeStateV2;
    readonly attempt: AttemptStateV2;
    readonly leaseReleased: false;
  };

/** Auditor-only composition boundary. It never invokes Executor or a process. */
export class AuditorRunner {
  async run(input: AuditAttemptV2Input): Promise<AuditAttemptV2Result> {
    return auditAttemptV2(input);
  }
}

export async function auditAttemptV2(input: AuditAttemptV2Input): Promise<AuditAttemptV2Result> {
  const clock = input.clock ?? (() => new Date().toISOString());
  const nonceFactory = input.nonceFactory ?? (() => cryptoSafeId());
  const eventIdFactory = input.eventIdFactory ?? (() => cryptoSafeId());
  try { assertLeasedRunV2(input.leasedRun); }
  catch (error) { throw new RalphEAuditError("E_LEASE_REQUIRED", "E_LEASE_REQUIRED: a live Core lease handle is required", error); }
  try { assertTrustedAuditorRuntimeV2(input.auditor); }
  catch (error) { throw new RalphEAuditError("E_AUDITOR_TRUST_REQUIRED", "E_AUDITOR_TRUST_REQUIRED: trusted ScriptedAuditor is required", error); }

  await refreshLeasedRunV2(input.leasedRun);
  await repairStateSnapshotWhileLeasedV2(input.leasedRun, { writtenAt: clock(), nonce: nonceFactory() });
  let attempt = findAttempt(input.leasedRun.state, input.attemptId);
  if (!attempt) throw new RalphEAuditError("E_ATTEMPT_INVALID", "E_ATTEMPT_INVALID: Attempt is missing");

  // Terminal replay is deliberately idempotent.  A crash after closure must
  // not invoke Auditor again, but an accepted closure may still need its
  // reducer-owned Task/Run projection completed.
  if (attempt.disposition === "CLOSED") {
    if (attempt.closureReason === "AUDIT_REJECTED") {
      return await terminalRejectedResult(input.leasedRun, attempt, input);
    }
    if (attempt.closureReason === "AUDIT_ACCEPTED") {
      return await finishAcceptedProjection(input, attempt, clock, nonceFactory, eventIdFactory);
    }
    throw new RalphEAuditError("E_ATTEMPT_INVALID", "E_ATTEMPT_INVALID: Attempt is closed outside the Auditor boundary");
  }
  if (attempt.stage !== "AWAITING_AUDIT" && attempt.stage !== "AUDITING") throw new RalphEAuditError("E_ATTEMPT_INVALID", "E_ATTEMPT_INVALID: Attempt is not at the audit boundary");

  const boundary = await loadAuditBoundary(input, attempt);
  if (boundary.controlPlaneChanged || boundary.workspaceDrift) {
    return await reconcileAudit(input.leasedRun, attempt, boundary.controlPlaneChanged ? "C_WORKSPACE_CHANGED_AFTER_EVIDENCE" : "C_WORKSPACE_CHANGED_DURING_AUDIT", clock, nonceFactory, eventIdFactory);
  }
  const auditPackage = boundary.auditPackage;
  if (auditPackage.auditability !== "AUDITABLE") {
    const leaseReleased = await releaseAuditLeaseIfPossible(input.leasedRun, attempt, input.executorObservation);
    return { kind: "NOT_AUDITABLE", outcome: "NOT_AUDITABLE", state: input.leasedRun.state, attempt, auditPackage, leaseReleased };
  }

  const binding = {
    runId: input.leasedRun.runId,
    phaseId: attempt.phaseId,
    taskId: attempt.taskId,
    attemptId: attempt.attemptId,
    auditPackageId: auditPackageIdForAttempt(attempt),
    auditPackageDigest: auditPackage.packageDigest,
    auditorIdentity: input.auditor.runtimeIdentity,
    auditorProfileId: input.auditor.profileId,
    auditorProfileDigest: input.auditor.profileDigest,
  } as const;
  if (binding.auditPackageId !== auditPackageIdForAttempt(attempt)) throw new RalphEAuditError("E_AUDIT_PACKAGE_BINDING_INVALID");
  const expectedInvocationId = auditInvocationIdV2(binding);
  let descriptor = await readAuditInvocationDescriptorV2(input.leasedRun.store, attempt.attemptId);
  if (!descriptor) {
    descriptor = createAuditInvocationDescriptorV2({ ...binding, startedAt: clock() });
    await persistAuditInvocationDescriptorV2(input.leasedRun.store, descriptor, nonceFactory());
  } else {
    validateAuditInvocationDescriptorV2(descriptor);
    if (descriptor.auditInvocationId !== expectedInvocationId
      || descriptor.runId !== binding.runId
      || descriptor.phaseId !== binding.phaseId
      || descriptor.taskId !== binding.taskId
      || descriptor.attemptId !== binding.attemptId
      || descriptor.auditPackageId !== binding.auditPackageId
      || descriptor.auditPackageDigest !== binding.auditPackageDigest
      || descriptor.auditorIdentity !== binding.auditorIdentity
      || descriptor.auditorProfileId !== binding.auditorProfileId
      || descriptor.auditorProfileDigest !== binding.auditorProfileDigest) {
      throw new RalphEAuditError("E_AUDIT_PACKAGE_BINDING_INVALID", "E_AUDIT_PACKAGE_BINDING_INVALID: immutable audit descriptor conflict");
    }
  }

  attempt = input.leasedRun.state.attempts[attempt.attemptId] ?? attempt;
  const started = await hasAuditStarted(input.leasedRun, attempt.attemptId);
  if (attempt.stage === "AWAITING_AUDIT") {
    if (started) throw new RalphEAuditError("E_AUDIT_PACKAGE_BINDING_INVALID", "E_AUDIT_PACKAGE_BINDING_INVALID: reducer stage/event mismatch");
    const event = coreEvent(input.leasedRun.state, "audit.started", {
      auditPackageId: auditPackageIdForAttempt(attempt),
      auditPackageDigest: auditPackage.packageDigest,
      startedAt: descriptor.startedAt,
    }, { phaseId: attempt.phaseId, taskId: attempt.taskId, attemptId: attempt.attemptId, eventIdFactory, clock });
    await commitAuditEvent(input.leasedRun, event, clock, nonceFactory);
    attempt = input.leasedRun.state.attempts[attempt.attemptId] ?? attempt;
  } else if (!started) {
    throw new RalphEAuditError("E_AUDIT_PACKAGE_BINDING_INVALID", "E_AUDIT_PACKAGE_BINDING_INVALID: AUDITING state has no durable audit.started event");
  }

  let auditResult = await readAuditResultV2(input.leasedRun.store, attempt.attemptId);
  if (!auditResult) {
    let envelope: AuditorResultEnvelopeV2;
    try {
      envelope = await input.auditor.invoke(deepFreeze(auditPackage));
      assertAuditorResultEnvelopeV2(envelope);
    } catch (error) {
      await releaseAuditorLeaseBestEffort(input, attempt);
      throw new RalphEAuditError("E_AUDITOR_RESULT_INVALID", "E_AUDITOR_RESULT_INVALID: Auditor did not return a valid result envelope", error);
    }
    try {
      auditResult = createAuditResultV2({
        runId: input.leasedRun.runId,
        phaseId: attempt.phaseId,
        taskId: attempt.taskId,
        attemptId: attempt.attemptId,
        auditInvocationId: descriptor.auditInvocationId,
        auditPackageId: auditPackageIdForAttempt(attempt),
        auditPackageDigest: auditPackage.packageDigest,
        verdict: envelope.verdict,
        proposedFindings: envelope.proposedFindings,
        resolvedFindingRefs: envelope.resolvedFindingRefs,
        rationale: envelope.rationale,
        metadata: envelope.metadata,
        startedAt: descriptor.startedAt,
        finishedAt: clock(),
      });
    } catch (error) {
      await releaseAuditorLeaseBestEffort(input, attempt);
      throw new RalphEAuditError("E_AUDITOR_RESULT_INVALID", "E_AUDITOR_RESULT_INVALID: Auditor result failed Core validation", error);
    }
    try {
      await persistAuditResultV2(input.leasedRun.store, auditResult, nonceFactory());
    } catch (error) {
      await releaseAuditorLeaseBestEffort(input, attempt);
      throw new RalphEAuditError("E_AUDIT_EVENT_DURABILITY_UNKNOWN", "E_AUDIT_EVENT_DURABILITY_UNKNOWN: AuditResult durability is unknown", error);
    }
  } else {
    validateAuditResultV2(auditResult);
    assertAuditResultBinding(auditResult, descriptor, auditPackage);
  }

  // The Auditor receives a frozen package and no workspace capability.  Keep
  // a second Core observation anyway: an accidental or hostile fixture side
  // effect must never be silently audited as a different workspace.
  const afterAudit = await observeStableAuditManifest(input, attempt, input.leasedRun.state.attempts[attempt.attemptId]?.invocation?.invocationId ?? "audit-boundary");
  if (afterAudit.controlPlaneFingerprint !== boundary.after.controlPlaneFingerprint
    || workspaceManifestCoreJson(afterAudit) !== workspaceManifestCoreJson(boundary.after)) {
    return await reconcileAudit(input.leasedRun, attempt, afterAudit.controlPlaneFingerprint !== boundary.after.controlPlaneFingerprint ? "C_WORKSPACE_CHANGED_AFTER_EVIDENCE" : "C_WORKSPACE_CHANGED_DURING_AUDIT", clock, nonceFactory, eventIdFactory);
  }

  attempt = input.leasedRun.state.attempts[attempt.attemptId] ?? attempt;
  const result = await reconcileAuditResult(input, attempt, auditPackage, boundary, descriptor, auditResult, clock, nonceFactory, eventIdFactory);
  return result;
}

export const runAuditV2 = auditAttemptV2;
export const runAudit = auditAttemptV2;

interface AuditBoundaryV2 {
  readonly auditPackage: AuditPackageV2;
  readonly validationSet: ValidationSetV2;
  readonly validationRuns: readonly ValidationRunV2[];
  readonly workUnit: WorkUnitV2;
  readonly invocation: InvocationDescriptorV2;
  readonly evidence: EvidenceCaptureV2;
  readonly after: WorkspaceManifestV2;
  readonly current: WorkspaceManifestV2;
  readonly controlPlaneChanged: boolean;
  readonly workspaceDrift: boolean;
}

async function loadAuditBoundary(input: AuditAttemptV2Input, attempt: AttemptStateV2): Promise<AuditBoundaryV2> {
  if (!attempt.auditPackage || !attempt.validationSet || !attempt.evidenceCapture) throw new RalphEAuditError("E_AUDIT_PACKAGE_REQUIRED");
  const auditPackage = await readAuditPackageV2(input.leasedRun.store, attempt.attemptId);
  const validationSet = await readValidationSetV2(input.leasedRun.store, attempt.attemptId);
  if (!auditPackage || !validationSet) throw new RalphEAuditError("E_AUDIT_PACKAGE_REQUIRED", "E_AUDIT_PACKAGE_REQUIRED: D artifacts are missing");
  validateAuditPackageV2(auditPackage);
  validateValidationSetV2(validationSet);
  if (computedAuditPackageId(auditPackage) !== attempt.auditPackage.auditPackageId) {
    throw new RalphEAuditError("E_AUDIT_PACKAGE_BINDING_INVALID", "E_AUDIT_PACKAGE_BINDING_INVALID: derived AuditPackage identity conflict");
  }
  if (auditPackage.packageDigest !== attempt.auditPackage.auditPackageDigest
    || validationSet.setDigest !== attempt.validationSet.validationSetDigest
    || auditPackage.validationSetDigest !== validationSet.setDigest
    || auditPackage.validationSetId !== attempt.validationSet.validationSetId
    || auditPackage.runId !== input.leasedRun.runId
    || auditPackage.phaseId !== attempt.phaseId
    || auditPackage.taskId !== attempt.taskId
    || auditPackage.attemptId !== attempt.attemptId
    || auditPackage.evidenceCaptureId !== attempt.evidenceCapture.evidenceCaptureId
    || auditPackage.evidenceDigest !== attempt.evidenceCapture.evidenceDigest
    || auditPackage.postExecutorFingerprint !== attempt.evidenceCapture.postExecutorFingerprint) {
    throw new RalphEAuditError("E_AUDIT_PACKAGE_BINDING_INVALID", "E_AUDIT_PACKAGE_BINDING_INVALID: package/state binding");
  }
  const phase = input.plan.phases.find((candidate) => candidate.id === attempt.phaseId);
  const task = phase?.tasks.find((candidate) => candidate.id === attempt.taskId);
  if (!phase || !task) throw new RalphEAuditError("E_AUDIT_PACKAGE_BINDING_INVALID", "E_AUDIT_PACKAGE_BINDING_INVALID: plan binding");
  const planIdentity = input.plan.artifactId;
  const planDigest = sha256Canonical(input.plan);
  if (planIdentity !== input.leasedRun.snapshot.readyPlanIdentity || planDigest !== input.leasedRun.snapshot.readyPlanHash) throw new RalphEAuditError("E_AUDIT_PACKAGE_BINDING_INVALID", "E_AUDIT_PACKAGE_BINDING_INVALID: supplied plan is not Ready plan");
  const binding: ArtifactBindingInputV2 = { runId: input.leasedRun.runId, phase, task, attempt, planIdentity, planDigest, snapshot: input.leasedRun.snapshot };
  const expectedWorkUnit = createWorkUnitV2(binding);
  const workUnit = await readWorkUnitV2(input.leasedRun.store, attempt.attemptId);
  const invocation = await readInvocationDescriptorV2(input.leasedRun.store, attempt.attemptId);
  if (!workUnit || !invocation || canonicalJson(workUnit) !== canonicalJson(expectedWorkUnit)) throw new RalphEAuditError("E_AUDIT_PACKAGE_BINDING_INVALID", "E_AUDIT_PACKAGE_BINDING_INVALID: WorkUnit binding");
  if (canonicalJson(auditPackage.acceptanceCriteria) !== canonicalJson(workUnit.acceptanceCriteria)
    || auditPackage.constraints.planIdentity !== workUnit.planIdentity
    || auditPackage.constraints.taskTitle !== workUnit.title
    || auditPackage.constraints.scope !== workUnit.scope
    || auditPackage.constraints.covers !== workUnit.covers
    || auditPackage.constraints.expectedEvidence !== workUnit.expectedEvidence) {
    throw new RalphEAuditError("E_AUDIT_PACKAGE_BINDING_INVALID", "E_AUDIT_PACKAGE_BINDING_INVALID: package acceptance/constraint binding");
  }
  const expectedInvocation = createInvocationDescriptorV2({ ...binding, workUnit: expectedWorkUnit });
  if (canonicalJson(invocation) !== canonicalJson(expectedInvocation)) throw new RalphEAuditError("E_AUDIT_PACKAGE_BINDING_INVALID", "E_AUDIT_PACKAGE_BINDING_INVALID: invocation binding");
  const evidence = await readEvidenceCaptureV2(input.leasedRun.store, attempt.attemptId);
  const after = await readWorkspaceAfterManifestV2(input.leasedRun.store, attempt.attemptId);
  const invocationResult = await readInvocationResultV2(input.leasedRun.store, attempt.attemptId);
  if (!evidence || !after || !invocationResult) throw new RalphEAuditError("E_AUDIT_PACKAGE_BINDING_INVALID", "E_AUDIT_PACKAGE_BINDING_INVALID: executor/evidence artifact missing");
  validateEvidenceCaptureV2(evidence);
  validateInvocationResultV2(invocationResult);
  if (evidence.evidenceDigest !== attempt.evidenceCapture.evidenceDigest
    || evidence.afterFingerprint !== after.fingerprintDigest
    || auditPackage.workspaceFingerprint !== evidence.afterFingerprint
    || auditPackage.postExecutorFingerprint !== evidence.afterFingerprint
    || invocationResult.resultDigest !== evidence.invocationResultDigest) throw new RalphEAuditError("E_AUDIT_PACKAGE_BINDING_INVALID", "E_AUDIT_PACKAGE_BINDING_INVALID: EvidenceCapture binding");
  const validationRuns: ValidationRunV2[] = [];
  for (const ref of validationSet.validationRunRefs) {
    const run = await readValidationRunV2(input.leasedRun.store, attempt.attemptId, ref.validationRunId);
    if (!run) throw new RalphEAuditError("E_AUDIT_PACKAGE_BINDING_INVALID", "E_AUDIT_PACKAGE_BINDING_INVALID: ValidationRun missing");
    validateValidationRunV2(run);
    const spec = workUnit.validationSpecRefs.find((candidate) => candidate.validationSpecId === ref.validationSpecId);
    if (!spec
      || ref.validationSpecDigest !== spec.digest
      || run.validationSpecDigest !== spec.digest
      || run.kind !== spec.kind
      || run.instruction !== spec.instruction
      || ref.artifactRef !== attemptArtifactRefV2(attempt.attemptId, `validation-run-${ref.validationRunId}.json`)
      || run.runDigest !== ref.runDigest
      || run.validationSpecId !== ref.validationSpecId
      || run.validationRunOrdinal !== ref.validationRunOrdinal) throw new RalphEAuditError("E_AUDIT_PACKAGE_BINDING_INVALID", "E_AUDIT_PACKAGE_BINDING_INVALID: ValidationRun ref conflict");
    validationRuns.push(run);
  }
  const expectedValidationRefs = validationRuns.map(validationRunRefFromArtifactV2);
  if (attempt.validationRuns.length !== expectedValidationRefs.length
    || expectedValidationRefs.some((expected) => {
      const actual = attempt.validationRuns.find((candidate) => candidate.validationRunId === expected.validationRunId);
      return !actual || canonicalJson(actual) !== canonicalJson(expected);
    })) {
    throw new RalphEAuditError("E_AUDIT_PACKAGE_BINDING_INVALID", "E_AUDIT_PACKAGE_BINDING_INVALID: reducer ValidationRun refs differ from ValidationSet");
  }
  const expectedSummary = deterministicValidationSummary(workUnit.validationSpecRefs, expectedValidationRefs);
  const expectedAuditability = workUnit.validationSpecRefs.length === 0
    || validationSet.summary.infrastructureFailures > 0
    || validationSet.summary.manualRequired > 0
    ? "NOT_AUDITABLE"
    : "AUDITABLE";
  if (auditPackage.validationSetId !== validationSetIdV2(input.leasedRun.runId, attempt.attemptId, { evidenceCaptureId: validationSet.evidenceCaptureId, evidenceDigest: validationSet.evidenceDigest }, validationRuns)
    || validationSet.runId !== input.leasedRun.runId
    || validationSet.phaseId !== attempt.phaseId
    || validationSet.taskId !== attempt.taskId
    || validationSet.attemptId !== attempt.attemptId
    || validationSet.evidenceCaptureId !== attempt.evidenceCapture.evidenceCaptureId
    || validationSet.evidenceDigest !== evidence.evidenceDigest
    || validationSet.postExecutorFingerprint !== auditPackage.postExecutorFingerprint
    || canonicalJson(validationSet.summary) !== canonicalJson(expectedSummary)
    || canonicalJson(validationSet.summary) !== canonicalJson(auditPackage.validationSummary)
    || auditPackage.auditability !== expectedAuditability
    || canonicalJson(validationSet.manualUnprovenSpecIds) !== canonicalJson(workUnit.validationSpecRefs.filter((spec) => spec.kind === "MANUAL").map((spec) => spec.validationSpecId))
    || canonicalJson(validationSet.humanValidationSpecIds) !== canonicalJson(workUnit.validationSpecRefs.filter((spec) => spec.kind === "HUMAN").map((spec) => spec.validationSpecId))
    || !attempt.validationSummary
    || canonicalJson(validationSet.summary) !== canonicalJson(attempt.validationSummary)) {
    throw new RalphEAuditError("E_AUDIT_PACKAGE_BINDING_INVALID", "E_AUDIT_PACKAGE_BINDING_INVALID: ValidationSet/package binding");
  }
  for (const run of validationRuns) {
    if (run.preValidationFingerprint !== auditPackage.postExecutorFingerprint || run.postValidationFingerprint !== auditPackage.postExecutorFingerprint) {
      throw new RalphEAuditError("E_AUDIT_PACKAGE_BINDING_INVALID", "E_AUDIT_PACKAGE_BINDING_INVALID: ValidationRun workspace binding");
    }
  }
  for (const ref of auditPackage.openFindingRefs) {
    const finding = input.leasedRun.state.findings[ref.findingId];
    if (!finding || finding.phaseId !== auditPackage.phaseId || finding.taskId !== auditPackage.taskId || finding.severity !== ref.severity || findingDigestV2(finding) !== ref.findingDigest || finding.status === "RESOLVED" || finding.status === "SUPERSEDED") throw new RalphEAuditError("E_AUDIT_PACKAGE_BINDING_INVALID", "E_AUDIT_PACKAGE_BINDING_INVALID: open Finding binding");
  }
  const current = await observeStableAuditManifest(input, attempt, invocation.invocationId);
  return {
    auditPackage,
    validationSet,
    validationRuns,
    workUnit,
    invocation,
    evidence,
    after,
    current,
    controlPlaneChanged: current.controlPlaneFingerprint !== after.controlPlaneFingerprint,
    workspaceDrift: workspaceManifestCoreJson(current) !== workspaceManifestCoreJson(after),
  };
}

async function reconcileAuditResult(
  input: AuditAttemptV2Input,
  attempt: AttemptStateV2,
  auditPackage: AuditPackageV2,
  boundary: AuditBoundaryV2,
  descriptor: AuditInvocationDescriptorV2,
  auditResult: AuditResultV2,
  clock: () => string,
  nonceFactory: () => string,
  eventIdFactory: () => string,
): Promise<AuditAttemptV2Result> {
  assertAuditResultBinding(auditResult, descriptor, auditPackage);
  validateResolutionRefs(auditResult, auditPackage, input.leasedRun.state);
  const taskFindings = Object.values(input.leasedRun.state.findings).filter((finding) => finding.taskId === attempt.taskId && !["RESOLVED", "SUPERSEDED"].includes(finding.status));
  const hardNegative = auditPackage.validationSummary.hardNegative || auditPackage.validationSummary.failed > 0;
  const hasProposals = auditResult.proposedFindings.length > 0;
  const allOpenExplicitlyResolved = taskFindings.every((finding) => auditResult.resolvedFindingRefs.includes(finding.id));
  const effectiveAccept = auditResult.verdict === "ACCEPT"
    && !hardNegative
    && !hasProposals
    && allOpenExplicitlyResolved;

  if (!effectiveAccept) {
    const proposed = [...auditResult.proposedFindings];
    if (hardNegative) proposed.push(...deterministicHardNegativeProposals(auditPackage, boundary.validationRuns, boundary.workUnit));
    if (proposed.length === 0) proposed.push(genericRejectionProposal(auditPackage));
    const evidenceRefs = evidenceRefsForBoundary(auditPackage, boundary);
    for (const proposal of deduplicateProposals(proposed)) {
      await upsertOpenFinding(input.leasedRun, attempt, proposal, evidenceRefs, clock, nonceFactory, eventIdFactory);
    }
    const currentAttempt = input.leasedRun.state.attempts[attempt.attemptId] ?? attempt;
    if (currentAttempt.disposition === "OPEN") {
      const close = coreEvent(input.leasedRun.state, "attempt.closed", { attemptId: attempt.attemptId, closureReason: "AUDIT_REJECTED", finishedAt: clock() }, { phaseId: attempt.phaseId, taskId: attempt.taskId, attemptId: attempt.attemptId, eventIdFactory, clock });
      await commitAuditEvent(input.leasedRun, close, clock, nonceFactory);
    }
    const closed = input.leasedRun.state.attempts[attempt.attemptId];
    if (!closed) throw new RalphEAuditError("E_AUDIT_EVENT_DURABILITY_UNKNOWN");
    await releaseAuditLeaseIfPossible(input.leasedRun, closed, input.executorObservation);
    return { kind: "AUDIT_REJECTED", outcome: "AUDIT_REJECTED", state: input.leasedRun.state, attempt: closed, auditInvocation: descriptor, auditResult, leaseReleased: true };
  }

  const evidenceRefs = evidenceRefsForBoundary(auditPackage, boundary);
  for (const finding of taskFindings) {
    if (auditResult.resolvedFindingRefs.includes(finding.id)) await resolveFinding(input.leasedRun, finding, attempt, auditPackage, descriptor, auditResult, evidenceRefs, clock, nonceFactory, eventIdFactory);
  }
  const currentAttempt = input.leasedRun.state.attempts[attempt.attemptId] ?? attempt;
  if (currentAttempt.disposition === "OPEN") {
    const close = coreEvent(input.leasedRun.state, "attempt.closed", { attemptId: attempt.attemptId, closureReason: "AUDIT_ACCEPTED", finishedAt: clock() }, { phaseId: attempt.phaseId, taskId: attempt.taskId, attemptId: attempt.attemptId, eventIdFactory, clock });
    await commitAuditEvent(input.leasedRun, close, clock, nonceFactory);
  }
  const closed = input.leasedRun.state.attempts[attempt.attemptId];
  if (!closed) throw new RalphEAuditError("E_AUDIT_EVENT_DURABILITY_UNKNOWN");
  return await finishAcceptedProjection({ ...input, leasedRun: input.leasedRun }, closed, clock, nonceFactory, eventIdFactory, descriptor, auditResult);
}

async function finishAcceptedProjection(
  input: AuditAttemptV2Input,
  attempt: AttemptStateV2,
  clock: () => string,
  nonceFactory: () => string,
  eventIdFactory: () => string,
  suppliedDescriptor?: AuditInvocationDescriptorV2,
  suppliedResult?: AuditResultV2,
): Promise<Extract<AuditAttemptV2Result, { readonly kind: "AUDIT_ACCEPTED" }>> {
  const descriptor = suppliedDescriptor ?? await readAuditInvocationDescriptorV2(input.leasedRun.store, attempt.attemptId);
  const auditResult = suppliedResult ?? await readAuditResultV2(input.leasedRun.store, attempt.attemptId);
  if (!descriptor || !auditResult || !attempt.auditPackage || !attempt.validationSet || !attempt.evidenceCapture) throw new RalphEAuditError("E_AUDIT_PACKAGE_REQUIRED");
  validateAuditInvocationDescriptorV2(descriptor);
  validateAuditResultV2(auditResult);
  const auditPackage = await readAuditPackageV2(input.leasedRun.store, attempt.attemptId);
  if (!auditPackage) throw new RalphEAuditError("E_AUDIT_PACKAGE_REQUIRED");
  validateAuditPackageV2(auditPackage);
  assertAuditResultBinding(auditResult, descriptor, auditPackage);
  await assertAcceptedAuditBoundary(input, attempt, descriptor, auditResult, auditPackage);
  const checkpoint = input.leasedRun.state.checkpoints.acceptedCheckpointFingerprint;
  if (!checkpoint || checkpoint.attemptId !== attempt.attemptId) {
    const record: CheckpointRecord = {
      kind: "acceptedCheckpointFingerprint",
      fingerprintDigest: auditPackage.workspaceFingerprint,
      emittedAt: clock(),
      attemptId: attempt.attemptId,
      evidenceSetId: attempt.evidenceCapture.evidenceCaptureId,
    };
    const event = coreEvent(input.leasedRun.state, "workspace.checkpointed", { checkpoint: record }, { eventIdFactory, clock, workspace: true });
    await commitAuditEvent(input.leasedRun, event, clock, nonceFactory);
  } else if (checkpoint.fingerprintDigest !== auditPackage.workspaceFingerprint) {
    throw new RalphEAuditError("E_AUDIT_PACKAGE_BINDING_INVALID", "E_AUDIT_PACKAGE_BINDING_INVALID: accepted checkpoint conflict");
  }
  const task = input.leasedRun.state.tasks[attempt.taskId];
  if (!task) throw new RalphEAuditError("E_AUDIT_PACKAGE_BINDING_INVALID");
  if (task.disposition !== "COMPLETE") {
    const taskEvent = coreEvent(input.leasedRun.state, "task.state-changed", {
      disposition: "COMPLETE",
      activity: "IDLE",
      owner: "NONE",
      hold: "NONE",
      currentAttemptId: attempt.attemptId,
      evidenceSetId: attempt.evidenceCapture.evidenceCaptureId,
      validationSetDigest: auditPackage.validationSetDigest,
      postExecutorFingerprint: auditPackage.workspaceFingerprint,
      acceptedCheckpointFingerprint: auditPackage.workspaceFingerprint,
    }, { phaseId: attempt.phaseId, taskId: attempt.taskId, eventIdFactory, clock });
    await commitAuditEvent(input.leasedRun, taskEvent, clock, nonceFactory);
  }
  if (input.leasedRun.state.disposition === "ACTIVE" && canCompleteRuntimeV2(input.leasedRun.state, true)) {
    const completed = coreEvent(input.leasedRun.state, "run.completed", { finalStatePersisted: true }, { eventIdFactory, clock });
    await commitAuditEvent(input.leasedRun, completed, clock, nonceFactory);
  }
  const closed = input.leasedRun.state.attempts[attempt.attemptId] ?? attempt;
  await releaseAuditLeaseIfPossible(input.leasedRun, closed, input.executorObservation);
  return { kind: "AUDIT_ACCEPTED", outcome: "AUDIT_ACCEPTED", state: input.leasedRun.state, attempt: closed, auditInvocation: descriptor, auditResult, leaseReleased: true };
}

async function assertAcceptedAuditBoundary(
  input: AuditAttemptV2Input,
  attempt: AttemptStateV2,
  descriptor: AuditInvocationDescriptorV2,
  auditResult: AuditResultV2,
  auditPackage: AuditPackageV2,
): Promise<void> {
  if (attempt.disposition !== "CLOSED" || attempt.closureReason !== "AUDIT_ACCEPTED") {
    throw new RalphEAuditError("E_AUDIT_PACKAGE_BINDING_INVALID", "E_AUDIT_PACKAGE_BINDING_INVALID: accepted projection is not a closed accepted Attempt");
  }
  if (input.leasedRun.state.hold !== "NONE"
    || attempt.auditPackage?.auditPackageId !== computedAuditPackageId(auditPackage)
    || attempt.auditPackage?.auditPackageDigest !== auditPackage.packageDigest
    || attempt.validationSet?.validationSetId !== auditPackage.validationSetId
    || attempt.validationSet?.validationSetDigest !== auditPackage.validationSetDigest
    || attempt.evidenceCapture?.evidenceCaptureId !== auditPackage.evidenceCaptureId
    || attempt.evidenceCapture?.evidenceDigest !== auditPackage.evidenceDigest
    || attempt.evidenceCapture?.postExecutorFingerprint !== auditPackage.postExecutorFingerprint
    || attempt.auditability !== auditPackage.auditability
    || !attempt.validationSummary
    || canonicalJson(attempt.validationSummary) !== canonicalJson(auditPackage.validationSummary)) {
    throw new RalphEAuditError("E_AUDIT_PACKAGE_BINDING_INVALID", "E_AUDIT_PACKAGE_BINDING_INVALID: accepted package/state binding");
  }
  const expectedInvocationId = auditInvocationIdV2({
    runId: descriptor.runId,
    phaseId: descriptor.phaseId,
    taskId: descriptor.taskId,
    attemptId: descriptor.attemptId,
    auditPackageId: descriptor.auditPackageId,
    auditPackageDigest: descriptor.auditPackageDigest,
    auditorIdentity: descriptor.auditorIdentity,
    auditorProfileId: descriptor.auditorProfileId,
    auditorProfileDigest: descriptor.auditorProfileDigest,
  });
  if (descriptor.auditInvocationId !== expectedInvocationId
    || auditResult.verdict !== "ACCEPT"
    || auditResult.proposedFindings.length !== 0
    || auditPackage.auditability !== "AUDITABLE"
    || auditPackage.validationSummary.failed !== 0
    || auditPackage.validationSummary.infrastructureFailures !== 0
    || auditPackage.validationSummary.manualRequired !== 0
    || auditPackage.validationSummary.hardNegative) {
    throw new RalphEAuditError("E_AUDITOR_RESULT_BINDING_INVALID", "E_AUDITOR_RESULT_BINDING_INVALID: accepted projection violates Core acceptance invariants");
  }
  validateResolutionRefs(auditResult, auditPackage, input.leasedRun.state);
  const unresolved = Object.values(input.leasedRun.state.findings).some((finding) => finding.taskId === attempt.taskId && !["RESOLVED", "SUPERSEDED"].includes(finding.status));
  if (unresolved || auditPackage.openFindingRefs.some((finding) => !auditResult.resolvedFindingRefs.includes(finding.findingId))) {
    throw new RalphEAuditError("E_FINDING_INVALID", "E_FINDING_INVALID: accepted projection has unresolved Findings");
  }
  const current = await observeStableAuditManifest(input, attempt, attempt.invocation?.invocationId ?? "audit-boundary");
  if (current.fingerprintDigest !== auditPackage.workspaceFingerprint) {
    throw new RalphEAuditError("E_WORKSPACE_RECONCILIATION_REQUIRED", "E_WORKSPACE_RECONCILIATION_REQUIRED: accepted workspace changed before projection");
  }
}

async function terminalRejectedResult(leasedRun: LeasedRunV2, attempt: AttemptStateV2, input: AuditAttemptV2Input): Promise<Extract<AuditAttemptV2Result, { readonly kind: "AUDIT_REJECTED" }>> {
  const descriptor = await readAuditInvocationDescriptorV2(leasedRun.store, attempt.attemptId);
  const result = await readAuditResultV2(leasedRun.store, attempt.attemptId);
  const auditPackage = await readAuditPackageV2(leasedRun.store, attempt.attemptId);
  if (!descriptor || !result || !auditPackage) throw new RalphEAuditError("E_AUDIT_PACKAGE_REQUIRED");
  validateAuditPackageV2(auditPackage);
  validateAuditInvocationDescriptorV2(descriptor);
  validateAuditResultV2(result);
  assertAuditResultBinding(result, descriptor, auditPackage);
  await releaseAuditLeaseIfPossible(leasedRun, attempt, input.executorObservation);
  return { kind: "AUDIT_REJECTED", outcome: "AUDIT_REJECTED", state: leasedRun.state, attempt, auditInvocation: descriptor, auditResult: result, leaseReleased: true };
}

async function upsertOpenFinding(
  leasedRun: LeasedRunV2,
  attempt: AttemptStateV2,
  proposal: ProposedFindingV2,
  evidenceRefs: readonly EvidenceRef[],
  clock: () => string,
  nonceFactory: () => string,
  eventIdFactory: () => string,
): Promise<void> {
  const current = leasedRun.state.findings[findingIdV2(attempt.taskId, proposal)];
  if (current?.status === "RESOLVED" || current?.status === "SUPERSEDED") throw new RalphEAuditError("E_FINDING_INVALID", "E_FINDING_INVALID: a terminal Finding cannot be silently reopened");
  const finding: Finding = {
    id: findingIdV2(attempt.taskId, proposal),
    criterionId: proposal.criterionId,
    phaseId: attempt.phaseId,
    taskId: attempt.taskId,
    scope: proposal.scope.length > 0 ? [...proposal.scope] : ["task"],
    severity: proposal.severity,
    status: "OPEN",
    expectation: proposal.expectation,
    observed: proposal.observed,
    evidenceRefs: [...evidenceRefs],
    ...(proposal.remediationHint === undefined ? {} : { remediationHint: proposal.remediationHint }),
    openedAtAttempt: current?.openedAtAttempt ?? attempt.attemptId,
    ...(proposal.rootCauseGroup === undefined ? {} : { rootCauseGroup: proposal.rootCauseGroup }),
  };
  if (current && current.status === "CANDIDATE_RESOLVED") {
    const reopenEvent = coreEvent(leasedRun.state, "finding.state-changed", { finding }, { phaseId: attempt.phaseId, taskId: attempt.taskId, findingId: finding.id, eventIdFactory, clock });
    await commitAuditEvent(leasedRun, reopenEvent, clock, nonceFactory);
    return;
  }
  if (current && canonicalJson(current) === canonicalJson(finding)) return;
  const event = coreEvent(leasedRun.state, "finding.state-changed", { finding }, { phaseId: attempt.phaseId, taskId: attempt.taskId, findingId: finding.id, eventIdFactory, clock });
  await commitAuditEvent(leasedRun, event, clock, nonceFactory);
}

async function resolveFinding(
  leasedRun: LeasedRunV2,
  finding: Finding,
  attempt: AttemptStateV2,
  auditPackage: AuditPackageV2,
  descriptor: AuditInvocationDescriptorV2,
  auditResult: AuditResultV2,
  evidenceRefs: readonly EvidenceRef[],
  clock: () => string,
  nonceFactory: () => string,
  eventIdFactory: () => string,
): Promise<void> {
  let current = leasedRun.state.findings[finding.id] ?? finding;
  if (current.status === "RESOLVED" || current.status === "SUPERSEDED") return;
  const candidateEvidenceRefs = evidenceRefs.filter((reference) => !current.evidenceRefs.some((existing) => existing.digest === reference.digest));
  if (current.status === "OPEN" && candidateEvidenceRefs.length === 0) throw new RalphEAuditError("E_FINDING_INVALID", "E_FINDING_INVALID: candidate resolution evidence is missing");
  if (current.status === "OPEN") {
    const candidate = coreEvent(leasedRun.state, "finding.state-changed", {
      finding: {
        ...current,
        evidenceRefs: [...current.evidenceRefs, ...candidateEvidenceRefs],
        resolvedAtAttempt: attempt.attemptId,
        resolutionEvidenceDigest: candidateEvidenceRefs[0]!.digest,
        resolutionAuditId: descriptor.auditInvocationId,
        resolutionValidationSetDigest: auditPackage.validationSetDigest,
        resolutionCriterionResult: "PASS",
        status: "CANDIDATE_RESOLVED",
      },
    }, { phaseId: attempt.phaseId, taskId: attempt.taskId, findingId: current.id, eventIdFactory, clock });
    await commitAuditEvent(leasedRun, candidate, clock, nonceFactory);
    current = leasedRun.state.findings[finding.id] ?? { ...current, status: "CANDIDATE_RESOLVED" };
  }
  if (current.status === "CANDIDATE_RESOLVED" || current.status === "HUMAN_PENDING") {
    const finalEvidenceRef: EvidenceRef = {
      evidenceId: auditResult.auditInvocationId,
      evidenceSetId: auditPackage.validationSetId,
      digest: auditResult.resultDigest,
      // Keep the frozen EvidenceRef vocabulary; the storageRef/digest bind
      // this Core audit-result artifact without widening event schemas.
      kind: "validation-artifact",
      provenance: "CORE",
      integrity: "VERIFIED",
      storageRef: attemptArtifactRefV2(attempt.attemptId, "audit-result.json"),
      capturedAt: auditResult.finishedAt,
    };
    const finalEvidenceRefs = current.evidenceRefs.some((reference) => reference.digest === finalEvidenceRef.digest) ? [] : [finalEvidenceRef];
    if (finalEvidenceRefs.length === 0) throw new RalphEAuditError("E_FINDING_INVALID", "E_FINDING_INVALID: final resolution evidence is not new");
    const finalEvent = coreEvent(leasedRun.state, "finding.state-changed", {
      finding: {
        ...current,
        evidenceRefs: [...current.evidenceRefs, ...finalEvidenceRefs],
        resolvedAtAttempt: attempt.attemptId,
        resolutionEvidenceDigest: finalEvidenceRef.digest,
        resolutionAuditId: descriptor.auditInvocationId,
        resolutionValidationSetDigest: auditPackage.validationSetDigest,
        resolutionCriterionResult: "PASS",
        status: "RESOLVED",
      },
    }, { phaseId: attempt.phaseId, taskId: attempt.taskId, findingId: current.id, eventIdFactory, clock });
    await commitAuditEvent(leasedRun, finalEvent, clock, nonceFactory);
  }
}

function findingIdV2(taskId: string, proposal: Pick<ProposedFindingV2, "criterionId" | "structuredFindingKey">): string {
  return `finding-${sha256Canonical({ taskId, criterionId: proposal.criterionId, structuredFindingKey: proposal.structuredFindingKey }).slice("sha256:".length)}`;
}

function deterministicHardNegativeProposals(auditPackage: AuditPackageV2, runs: readonly ValidationRunV2[], workUnit: WorkUnitV2): ProposedFindingV2[] {
  return runs.filter((run) => run.outcome === "FAIL").map((run) => {
    const spec = workUnit.validationSpecRefs.find((candidate) => candidate.validationSpecId === run.validationSpecId);
    return {
      criterionId: run.validationSpecId,
      structuredFindingKey: `deterministic-red:${run.validationSpecId}`,
      severity: "BLOCKER" as const,
      scope: [workUnit.scope],
      expectation: spec?.instruction ?? "deterministic validation must pass",
      observed: `COMMAND validation ${run.validationSpecId} returned FAIL`,
      remediationHint: "Correct the deterministic validation failure and submit a new Attempt.",
      rootCauseGroup: `validation:${auditPackage.taskId}`,
    };
  });
}

function genericRejectionProposal(auditPackage: AuditPackageV2): ProposedFindingV2 {
  return {
    criterionId: "audit",
    structuredFindingKey: "audit:rejected",
    severity: "BLOCKER",
    scope: [auditPackage.constraints.scope],
    expectation: auditPackage.acceptanceCriteria.join("; "),
    observed: "Auditor rejected the immutable AuditPackage.",
    remediationHint: "Address the structured audit finding and submit a correction Attempt.",
    rootCauseGroup: `audit:${auditPackage.taskId}`,
  };
}

function deduplicateProposals(proposals: readonly ProposedFindingV2[]): ProposedFindingV2[] {
  const seen = new Set<string>();
  return proposals.filter((proposal) => {
    const key = `${proposal.criterionId}\u0000${proposal.structuredFindingKey}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function evidenceRefsForBoundary(auditPackage: AuditPackageV2, boundary: AuditBoundaryV2): readonly EvidenceRef[] {
  const selected = boundary.validationRuns.filter((run) => run.outcome === "FAIL").slice(0, 16);
  const source = selected.length > 0 ? selected : boundary.validationRuns.slice(0, 1);
  if (source.length === 0) return [{
    evidenceId: auditPackage.validationSetId,
    evidenceSetId: auditPackage.validationSetId,
    digest: auditPackage.validationSetDigest,
    kind: "validation-artifact",
    provenance: "CORE",
    integrity: "VERIFIED",
    storageRef: attemptArtifactRefV2(auditPackage.attemptId, "validation-set.json"),
    capturedAt: auditPackage.workspaceFingerprint,
  }];
  return source.map((run) => ({
    evidenceId: run.validationRunId,
    evidenceSetId: auditPackage.validationSetId,
    digest: run.runDigest,
    kind: "validation-artifact" as const,
    provenance: "CORE" as const,
    integrity: "VERIFIED" as const,
    storageRef: attemptArtifactRefV2(auditPackage.attemptId, `validation-run-${run.validationRunId}.json`),
    capturedAt: run.finishedAt,
  }));
}

function validateResolutionRefs(result: AuditResultV2, auditPackage: AuditPackageV2, state: RalphRuntimeStateV2): void {
  const allowed = new Set(auditPackage.openFindingRefs.map((finding) => finding.findingId));
  for (const findingId of result.resolvedFindingRefs) {
    if (!allowed.has(findingId) || !state.findings[findingId]) throw new RalphEAuditError("E_AUDITOR_RESULT_BINDING_INVALID", "E_AUDITOR_RESULT_BINDING_INVALID: Auditor resolution is not an open package Finding");
  }
}

function assertAuditResultBinding(result: AuditResultV2, descriptor: AuditInvocationDescriptorV2, auditPackage: AuditPackageV2): void {
  if (result.runId !== auditPackage.runId || result.phaseId !== auditPackage.phaseId || result.taskId !== auditPackage.taskId || result.attemptId !== auditPackage.attemptId || result.auditInvocationId !== descriptor.auditInvocationId || result.auditPackageId !== descriptor.auditPackageId || result.auditPackageDigest !== auditPackage.packageDigest || result.startedAt !== descriptor.startedAt) throw new RalphEAuditError("E_AUDITOR_RESULT_BINDING_INVALID", "E_AUDITOR_RESULT_BINDING_INVALID: immutable AuditResult binding conflict");
}

function auditPackageIdForAttempt(attempt: Pick<AttemptStateV2, "auditPackage">): string {
  const value = attempt.auditPackage?.auditPackageId;
  if (!value) throw new RalphEAuditError("E_AUDIT_PACKAGE_REQUIRED");
  return value;
}

function computedAuditPackageId(auditPackage: AuditPackageV2): string {
  const { schema: _schema, packageDigest: _packageDigest, ...base } = auditPackage;
  return auditPackageIdV2(base);
}

async function observeStableAuditManifest(input: AuditAttemptV2Input, attempt: AttemptStateV2, invocationId: string): Promise<WorkspaceManifestV2> {
  const binding = { runId: input.leasedRun.runId, phaseId: attempt.phaseId, taskId: attempt.taskId, attemptId: attempt.attemptId, invocationId };
  const fileSystem = input.workspaceFingerprintFileSystem ?? input.leasedRun.workspaceFingerprintFileSystem;
  const first = await observeWorkspaceManifestV2({ projectRoot: input.leasedRun.projectRoot, policy: input.leasedRun.snapshot.workspacePolicy, binding, fileSystem });
  const second = await observeWorkspaceManifestV2({ projectRoot: input.leasedRun.projectRoot, policy: input.leasedRun.snapshot.workspacePolicy, binding, fileSystem });
  if (workspaceManifestCoreJson(first.manifest) !== workspaceManifestCoreJson(second.manifest)) throw new RalphEAuditError("E_WORKSPACE_RECONCILIATION_REQUIRED");
  return first.manifest;
}

async function reconcileAudit(
  leasedRun: LeasedRunV2,
  attempt: AttemptStateV2,
  reason: string,
  clock: () => string,
  nonceFactory: () => string,
  eventIdFactory: () => string,
): Promise<Extract<AuditAttemptV2Result, { readonly kind: "RECONCILIATION_REQUIRED" }>> {
  if (attempt.stage !== "RECONCILING") {
    const event = coreEvent(leasedRun.state, "attempt.reconciliation-required", { reason, proofRef: `audit-reconciliation-${sha256Canonical({ runId: leasedRun.runId, attemptId: attempt.attemptId, reason }).slice("sha256:".length)}` }, { phaseId: attempt.phaseId, taskId: attempt.taskId, attemptId: attempt.attemptId, eventIdFactory, clock });
    await commitAuditEvent(leasedRun, event, clock, nonceFactory);
  }
  const next = leasedRun.state.attempts[attempt.attemptId];
  if (!next) throw new RalphEAuditError("E_AUDIT_EVENT_DURABILITY_UNKNOWN");
  return { kind: "RECONCILIATION_REQUIRED", outcome: "RECONCILIATION_REQUIRED", state: leasedRun.state, attempt: next, leaseReleased: false };
}

async function hasAuditStarted(leasedRun: LeasedRunV2, attemptId: string): Promise<boolean> {
  const inspected = await leasedRun.store.inspect();
  return inspected.events.some((event) => event.eventType === "audit.started" && event.attemptId === attemptId);
}

async function releaseAuditLeaseIfPossible(
  leasedRun: LeasedRunV2,
  attempt: AttemptStateV2,
  observation: TrustedExecutorObservationV2 | undefined,
): Promise<boolean> {
  if (attempt.disposition === "CLOSED") {
    if (observation) {
      const refs = [
        attemptArtifactRefV2(attempt.attemptId, "work-unit.json"),
        attemptArtifactRefV2(attempt.attemptId, "invocation.json"),
        attemptArtifactRefV2(attempt.attemptId, "invocation-result.json"),
        attemptArtifactRefV2(attempt.attemptId, "workspace-before.json"),
        attemptArtifactRefV2(attempt.attemptId, "workspace-after.json"),
        attemptArtifactRefV2(attempt.attemptId, "evidence-capture.json"),
      ];
      const proof = await deriveExecutorReleaseProofV2(leasedRun, observation, refs);
      await releaseLeasedRunV2(leasedRun, { proof });
    } else {
      await releaseLeasedRunV2(leasedRun);
    }
    return true;
  }
  if (!observation) return false;
  const refs = [
    attemptArtifactRefV2(attempt.attemptId, "work-unit.json"),
    attemptArtifactRefV2(attempt.attemptId, "invocation.json"),
    attemptArtifactRefV2(attempt.attemptId, "invocation-result.json"),
    attemptArtifactRefV2(attempt.attemptId, "workspace-before.json"),
    attemptArtifactRefV2(attempt.attemptId, "workspace-after.json"),
    attemptArtifactRefV2(attempt.attemptId, "evidence-capture.json"),
  ];
  const proof = await deriveExecutorReleaseProofV2(leasedRun, observation, refs);
  await releaseLeasedRunV2(leasedRun, { proof });
  return true;
}

async function releaseAuditorLeaseBestEffort(input: AuditAttemptV2Input, attempt: AttemptStateV2): Promise<void> {
  try {
    await releaseAuditLeaseIfPossible(input.leasedRun, attempt, input.executorObservation);
  } catch {
    // The original Auditor/protocol failure remains the semantic result.  If
    // lease removal is itself uncertain, the next Core opener must inspect
    // the durable lease and ledger rather than receive a fabricated release.
  }
}

async function commitAuditEvent(leasedRun: LeasedRunV2, event: RalphEventV2, clock: () => string, nonceFactory: () => string): Promise<void> {
  await revalidateLeaseOwnershipV2(leasedRun);
  let committed;
  try {
    committed = await commitRalphEventV2({ store: leasedRun.store, state: leasedRun.state, event, writtenAt: clock(), nonce: nonceFactory() });
  } catch (error) {
    if (error instanceof Error && error.message.includes("DURABILITY_UNKNOWN")) throw new RalphEAuditError("E_AUDIT_EVENT_DURABILITY_UNKNOWN", error.message, error);
    throw error;
  }
  if (committed.eventDurability !== "DURABLE") throw new RalphEAuditError("E_AUDIT_EVENT_DURABILITY_UNKNOWN");
  try {
    if (committed.snapshotStatus !== "CURRENT") await repairStateSnapshotWhileLeasedV2(leasedRun, { writtenAt: clock(), nonce: nonceFactory() });
    await refreshLeasedRunV2(leasedRun);
  } catch (error) {
    throw new RalphEAuditError("E_AUDIT_EVENT_DURABILITY_UNKNOWN", "E_AUDIT_EVENT_DURABILITY_UNKNOWN: event cannot be replayed", error);
  }
}

function coreEvent<TType extends RalphEventTypeV2>(
  state: RalphRuntimeStateV2,
  eventType: TType,
  payload: EventPayloadMapV2[TType],
  context: { readonly phaseId?: string; readonly taskId?: string; readonly attemptId?: string; readonly findingId?: string; readonly workspace?: boolean; readonly eventIdFactory: () => string; readonly clock: () => string },
): RalphEventV2 {
  const kind = V2_EVENT_ENTITY_KINDS[eventType];
  const entity = kind === "run"
    ? { kind, id: state.runId }
    : kind === "task"
      ? { kind, id: context.taskId ?? "task" }
      : kind === "finding"
        ? { kind, id: context.findingId ?? "finding" }
        : kind === "workspace"
          ? { kind, id: `${state.runId}:workspace` }
          : { kind: "attempt" as const, id: context.attemptId ?? "attempt" };
  return createRalphEventV2({
    eventId: context.eventIdFactory(),
    eventType,
    schemaVersion: state.eventSchema,
    runId: state.runId,
    sequence: state.lastSequence + 1,
    occurredAt: context.clock(),
    recordedAt: context.clock(),
    entity,
    ...(kind === "attempt" ? { phaseId: context.phaseId, taskId: context.taskId, attemptId: context.attemptId } : kind === "task" ? { phaseId: context.phaseId, taskId: context.taskId } : {}),
    actor: "CORE",
    causationId: null,
    correlationId: `${state.runId}:${context.attemptId ?? eventType}`,
    payload,
    previousEventHash: state.lastEventHash,
  } as UnsignedRalphEventV2<TType>) as RalphEventV2;
}

function findAttempt(state: RalphRuntimeStateV2, attemptId: string | undefined): AttemptStateV2 | undefined {
  if (attemptId) return state.attempts[attemptId];
  const open = Object.values(state.attempts).find((attempt) => attempt.disposition === "OPEN");
  if (open) return open;
  return Object.values(state.attempts)
    .filter((attempt) => attempt.disposition === "CLOSED" && (attempt.closureReason === "AUDIT_ACCEPTED" || attempt.closureReason === "AUDIT_REJECTED"))
    .sort((left, right) => right.ordinal - left.ordinal || right.attemptId.localeCompare(left.attemptId))[0];
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function cryptoSafeId(): string {
  return randomUUID();
}
