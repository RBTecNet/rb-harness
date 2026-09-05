/**
 * Ralph Runtime Foundation V1 contracts.
 *
 * These are runtime values, not Dashboard labels.  The Dashboard may project
 * them later, but it cannot extend or reinterpret this vocabulary.
 */

export const RUN_DISPOSITIONS = ["CREATED", "ACTIVE", "COMPLETE", "FAILED"] as const;
export type RunDisposition = typeof RUN_DISPOSITIONS[number];

export const RUN_HOLDS = [
  "NONE",
  "PAUSED",
  "BLOCKED",
  "HUMAN_REQUIRED",
  "PROVIDER_UNAVAILABLE",
  "RECONCILIATION_REQUIRED",
] as const;
export type RunHold = typeof RUN_HOLDS[number];

export const PHASE_DISPOSITIONS = ["PENDING", "READY", "COMPLETE", "BLOCKED", "FAILED"] as const;
export type PhaseDisposition = typeof PHASE_DISPOSITIONS[number];

export const PHASE_ACTIVITIES = ["IDLE", "ACTIVE"] as const;
export type PhaseActivity = typeof PHASE_ACTIVITIES[number];

export const TASK_DISPOSITIONS = ["PENDING", "READY", "COMPLETE", "FAILED", "BLOCKED", "PAUSED"] as const;
export type TaskDisposition = typeof TASK_DISPOSITIONS[number];

export const TASK_ACTIVITIES = [
  "IDLE",
  "EXECUTING",
  "CAPTURING_EVIDENCE",
  "VALIDATING",
  "AUDITING",
  "CORRECTING",
  "INTEGRATING",
  "RECONCILING",
] as const;
export type TaskActivity = typeof TASK_ACTIVITIES[number];

export const TASK_OWNERS = ["NONE", "EXECUTOR", "CORE", "AUDITOR", "HUMAN"] as const;
export type TaskOwner = typeof TASK_OWNERS[number];

export const TASK_HOLDS = [
  "NONE",
  "HUMAN_REQUIRED",
  "PROVIDER_UNAVAILABLE",
  "DEPENDENCY_UNAVAILABLE",
  "WORKSPACE_DRIFT",
  "RETRY_BUDGET_EXHAUSTED",
  "CANCELLED_AT_BOUNDARY",
] as const;
export type TaskHold = typeof TASK_HOLDS[number];

export const FINDING_STATUSES = ["OPEN", "CANDIDATE_RESOLVED", "RESOLVED", "SUPERSEDED", "HUMAN_PENDING"] as const;
export type FindingStatus = typeof FINDING_STATUSES[number];

export type RuntimeActor = "CORE" | "EXECUTOR" | "AUDITOR" | "HUMAN" | "SYSTEM";

export interface RuntimeEntityRef {
  readonly kind: "run" | "phase" | "task" | "attempt" | "finding" | "workspace";
  readonly id: string;
}

export interface BudgetUsage {
  readonly used: number;
  readonly limit: number;
  readonly remaining: number;
  readonly exhausted: boolean;
  readonly exceeded: boolean;
}

export interface EvidenceRef {
  readonly evidenceId: string;
  readonly evidenceSetId: string;
  readonly digest: string;
  readonly kind: "workspace-diff" | "command-result" | "test-result" | "provider-output" | "validation-artifact" | "snapshot" | "log";
  readonly provenance: "CORE" | "EXECUTOR" | "AUDITOR" | "SYSTEM";
  readonly integrity: "VERIFIED" | "UNVERIFIED";
  readonly storageRef: string;
  readonly capturedAt: string;
}

export interface ValidationRef {
  readonly validationId: string;
  readonly validatorIdentity: string;
  readonly args: readonly string[];
  readonly workingDirectory: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly exitCode: number | null;
  readonly stdoutRef: string;
  readonly stderrRef: string;
  readonly affectedScope: readonly string[];
  readonly result: "PASS" | "FAIL" | "NOT_APPLICABLE";
  readonly cacheIdentity?: string;
}

export interface AuditBinding {
  readonly runId: string;
  readonly phaseId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly auditReviewOrdinal: number;
  readonly evidenceSetId: string;
  readonly evidenceDigest: string;
  readonly validationSetDigest: string;
  readonly postExecutorFingerprint: string;
  readonly criterionSetVersion: string;
  readonly criterionSetDigest: string;
  readonly auditorProfileDigest: string;
}

export interface AuditCriterionDecision {
  readonly criterionId: string;
  readonly result: "PASS" | "FAIL" | "UNPROVEN" | "NOT_APPLICABLE";
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly findingIds: readonly string[];
}

export interface AuditResult {
  readonly auditId: string;
  readonly binding: AuditBinding;
  readonly result: "PASS" | "FAIL" | "UNPROVEN" | "HUMAN_PENDING" | "NOT_APPLICABLE";
  readonly criteria: readonly AuditCriterionDecision[];
  readonly issuedAt: string;
}

export interface ExecutorResult {
  readonly status: "SUCCEEDED" | "FAILED" | "CANCELLED" | "TIMED_OUT" | "UNAVAILABLE";
  readonly changedPaths: readonly string[];
  readonly commandsExecuted: readonly string[];
  readonly testsReported: readonly string[];
  readonly summary: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly providerMetadata?: Readonly<Record<string, string | number | boolean>>;
  readonly termination: "NORMAL" | "ERROR" | "TIMEOUT" | "CANCELLED" | "PROVIDER_UNAVAILABLE";
  readonly rawOutputRef?: string;
}

export interface CheckpointRecord {
  readonly kind: "runStartFingerprint" | "attemptBaseFingerprint" | "postExecutorFingerprint" | "acceptedCheckpointFingerprint";
  readonly fingerprintDigest: string;
  readonly emittedAt: string;
  readonly attemptId?: string;
  readonly evidenceSetId?: string;
}

export interface Finding {
  readonly id: string;
  readonly criterionId: string;
  readonly phaseId: string;
  readonly taskId: string;
  readonly scope: readonly string[];
  readonly severity: "INFO" | "LOW" | "MEDIUM" | "HIGH" | "BLOCKER";
  readonly status: FindingStatus;
  readonly expectation: string;
  readonly observed: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly remediationHint?: string;
  readonly openedAtAttempt: string;
  readonly resolvedAtAttempt?: string;
  readonly rootCauseGroup?: string;
  readonly supersedesFindingId?: string;
  readonly resolutionEvidenceDigest?: string;
  readonly resolutionAuditId?: string;
  readonly resolutionValidationSetDigest?: string;
  readonly resolutionCriterionResult?: "PASS" | "NOT_APPLICABLE";
}

export interface AttemptState {
  readonly attemptId: string;
  readonly taskId: string;
  readonly ordinal: number;
  readonly strategyGeneration: number;
  readonly attemptBaseFingerprint: string;
  readonly executorResult?: ExecutorResult;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly validationRefs: readonly ValidationRef[];
  readonly auditResult?: AuditResult;
  readonly openedFindingIds: readonly string[];
  readonly resolvedFindingIds: readonly string[];
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly completionReason?: "AUDIT_APPROVED" | "AUDIT_REJECTED" | "VALIDATION_FAILED" | "PROVIDER_FAILURE" | "CANCELLED" | "HUMAN_REQUIRED";
  readonly closed: boolean;
}

export interface TaskState {
  readonly taskId: string;
  readonly phaseId: string;
  readonly dependsOn: readonly string[];
  readonly disposition: TaskDisposition;
  readonly activity: TaskActivity;
  readonly owner: TaskOwner;
  readonly hold: TaskHold;
  readonly currentAttemptId?: string;
  readonly attemptsUsed: number;
  readonly executorBudget?: BudgetUsage;
  readonly strategyResetBudget?: BudgetUsage;
  readonly auditorRetryBudget?: BudgetUsage;
  readonly providerAvailabilityBudget?: BudgetUsage;
  readonly evidenceSetId?: string;
  readonly validationSetDigest?: string;
  readonly postExecutorFingerprint?: string;
  readonly acceptedCheckpointFingerprint?: string;
  readonly findingIds: readonly string[];
  readonly updatedAt: string;
}

export interface PhaseState {
  readonly phaseId: string;
  readonly taskIds: readonly string[];
  readonly disposition: PhaseDisposition;
  readonly activity: PhaseActivity;
}

export interface RunState {
  readonly format: "rb-ralph-runtime-state/v1";
  readonly runId: string;
  readonly disposition: RunDisposition;
  readonly hold: RunHold;
  readonly phaseIds: readonly string[];
  readonly taskIds: readonly string[];
  readonly phases: Readonly<Record<string, PhaseState>>;
  readonly tasks: Readonly<Record<string, TaskState>>;
  readonly attempts: Readonly<Record<string, AttemptState>>;
  readonly findings: Readonly<Record<string, Finding>>;
  readonly checkpoints: Readonly<Record<string, CheckpointRecord>>;
  readonly lastSequence: number;
  readonly lastEventHash: string | null;
  readonly finalStatePersisted: boolean;
}

export interface ProviderProfileDescriptor {
  readonly profileId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly descriptorDigest: string;
}

/**
 * Persisted configuration is deliberately a reference, not an extensible raw
 * object.  Runtime policy values are resolved by a future policy loader and
 * are represented here by their validated schema, identity and digest only.
 */
export interface SafeRuntimeDescriptor {
  readonly schemaVersion: string;
  readonly descriptorId: string;
  readonly descriptorDigest: string;
}

export interface CapabilityMetadata {
  readonly requested: readonly string[];
  readonly granted: readonly string[];
  readonly verified: readonly string[];
  readonly readOnlyEnforced: boolean;
}

export interface WorkspacePolicy {
  readonly format: "rb-ralph-workspace-policy/v1";
  readonly scopePaths: readonly string[];
  readonly coversPaths: readonly string[];
  readonly additionalExcludes: readonly string[];
  readonly generatedPaths: readonly string[];
  readonly policyDigest: string;
}

export interface FingerprintIdentity {
  readonly controlPlaneFingerprint: string;
  readonly productWorkspaceFingerprint: string;
  readonly policyDigest: string;
  readonly fingerprintDigest: string;
}

export interface RunSnapshot {
  readonly snapshotSchemaVersion: "rb-ralph-run-snapshot/v1";
  readonly runId: string;
  readonly projectIdentity: Readonly<Record<string, string>>;
  readonly readyPlanIdentity: string;
  readonly readyPlanHash: string;
  readonly readyManifestHash: string;
  readonly selectedReadyArtifactHashes: Readonly<Record<string, string>>;
  readonly readinessInspectionDigest: string;
  readonly effectiveRunConfig: SafeRuntimeDescriptor;
  readonly effectiveConfigDigest: string;
  readonly executorProfile: ProviderProfileDescriptor;
  readonly auditorProfile: ProviderProfileDescriptor;
  readonly executorCapabilities: CapabilityMetadata;
  readonly auditorCapabilities: CapabilityMetadata;
  readonly permissionEnforceDigest: string;
  readonly workspacePolicy: WorkspacePolicy;
  readonly initialFingerprint: FingerprintIdentity;
  readonly retryPolicy: SafeRuntimeDescriptor;
  readonly timeoutPolicy: SafeRuntimeDescriptor;
  readonly parallelismPolicy: SafeRuntimeDescriptor;
  readonly runtimeVersion: string;
  readonly createdAt: string;
}

export interface RalphRuntimeState extends RunState {}
