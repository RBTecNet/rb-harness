import { canonicalJson } from "../canonical-json.js";
import type { FingerprintIdentity } from "../contracts.js";
import { fingerprintWorkspace, type WorkspaceFingerprintFileSystem } from "../fingerprint.js";
import { assertV2RuntimeState } from "../operational-v2/state.js";
import type { RalphRuntimeStateV2 } from "../operational-v2/contracts.js";
import { RalphEventStoreV2, type EventStoreV2Options, type LedgerInspectionV2 } from "./event-store.js";
import { RalphRunSnapshotV2Error, readRunSnapshotV2, type RunSnapshotV2 } from "./run-snapshot.js";
import { replayOperationalRunV2 } from "./state-snapshot.js";

export const OPERATIONAL_RUN_V2_OPEN_OUTCOMES = [
  "READY_FOR_LEASE",
  "RECONCILIATION_REQUIRED",
  "FAILED_INTEGRITY",
  "INCOMPLETE_INITIALIZATION",
] as const;
export type OperationalRunV2OpenOutcome = typeof OPERATIONAL_RUN_V2_OPEN_OUTCOMES[number];

export interface OperationalRunV2ExternalFacts {
  readonly projectIdentity?: Readonly<Record<string, string>>;
  readonly readyPlanIdentity?: string;
  readonly readyPlanHash?: string;
  readonly readyManifestHash?: string;
  readonly readinessInspectionDigest?: string;
  readonly effectiveConfigDigest?: string;
  readonly executorProfileDigest?: string;
  readonly permissionCapabilityPolicyDigest?: string;
  readonly diagnosticsPolicyDigest?: string;
  readonly environmentPolicyDigest?: string;
  readonly workspacePolicyDigest?: string;
  readonly runtimeIdentityDigest?: string;
  readonly leasePolicyDigest?: string;
  /** This is an observed external fact, not a caller assertion of validity. */
  readonly workspaceFingerprint?: FingerprintIdentity;
}

export interface InspectOperationalRunV2Input {
  readonly projectRoot: string;
  readonly runId: string;
  readonly genesisState: RalphRuntimeStateV2;
  readonly fs?: EventStoreV2Options["fs"];
  readonly externalFacts?: OperationalRunV2ExternalFacts;
  readonly workspaceFingerprintFileSystem?: WorkspaceFingerprintFileSystem;
  /**
   * Post-executor Core continuations must still replay the authoritative
   * ledger, but the product workspace is expected to differ from the frozen
   * pre-execution fingerprint.  The default remains the frozen initial-state
   * comparison used by B1/B2 admission.
   */
  readonly workspaceComparison?: "REQUIRE_INITIAL" | "ALLOW_POST_EXECUTOR_DRIFT";
}

export interface InspectOperationalRunV2Result {
  readonly outcome: OperationalRunV2OpenOutcome;
  readonly runId: string;
  readonly issues: readonly string[];
  readonly store: RalphEventStoreV2;
  readonly runSnapshot?: RunSnapshotV2;
  readonly ledger?: LedgerInspectionV2;
  readonly state?: RalphRuntimeStateV2;
  readonly snapshotUsed: boolean;
  readonly snapshotRecovered: boolean;
  readonly snapshotRepairRequired: boolean;
}

/**
 * Read-only operational opening.  It derives every integrity result itself;
 * no caller-supplied ledger/snapshot/replay validity flag is accepted.
 */
export async function inspectOperationalRunV2(input: InspectOperationalRunV2Input): Promise<InspectOperationalRunV2Result> {
  assertV2RuntimeState(input.genesisState);
  if (input.genesisState.runId !== input.runId || input.genesisState.lastSequence !== 0 || input.genesisState.lastEventHash !== null) {
    throw new Error("RALPH_V2_OPEN_INVALID_GENESIS");
  }
  const store = new RalphEventStoreV2({ projectRoot: input.projectRoot, runId: input.runId, fs: input.fs });

  let snapshot: RunSnapshotV2;
  try {
    snapshot = await readRunSnapshotV2(store);
  } catch (error) {
    if (error instanceof RalphRunSnapshotV2Error && error.code === "RALPH_V2_RUN_SNAPSHOT_MISSING") {
      return await classifyMissingRunSnapshot(store);
    }
    return failed(store, error);
  }

  let ledger: LedgerInspectionV2;
  try {
    ledger = await store.inspect();
  } catch (error) {
    return failed(store, error, snapshot);
  }
  if (ledger.lastSequence === 0) {
    return {
      outcome: "INCOMPLETE_INITIALIZATION",
      runId: input.runId,
      issues: ["RALPH_V2_RUN_CREATED_MISSING"],
      store,
      runSnapshot: snapshot,
      ledger,
      snapshotUsed: false,
      snapshotRecovered: false,
      snapshotRepairRequired: false,
    };
  }

  let replay;
  try {
    replay = await replayOperationalRunV2(store, input.genesisState);
  } catch (error) {
    return failed(store, error, snapshot, ledger);
  }

  const externalIssues = await compareExternalFacts(input, snapshot);
  const issues = [
    ...(replay.snapshotRepairRequired ? ["state-snapshot-repair-required"] : []),
    ...externalIssues,
  ];
  return {
    outcome: externalIssues.length > 0 ? "RECONCILIATION_REQUIRED" : "READY_FOR_LEASE",
    runId: input.runId,
    issues,
    store,
    runSnapshot: snapshot,
    ledger,
    state: replay.state,
    snapshotUsed: replay.snapshotUsed,
    snapshotRecovered: replay.snapshotRecovered,
    snapshotRepairRequired: replay.snapshotRepairRequired,
  };

  async function classifyMissingRunSnapshot(ownedStore: RalphEventStoreV2): Promise<InspectOperationalRunV2Result> {
    try {
      const physicalLedger = await ownedStore.inspectPhysicalLedgerForOpen();
      if (physicalLedger.lastSequence === 0) {
        return {
          outcome: "INCOMPLETE_INITIALIZATION",
          runId: input.runId,
          issues: ["RALPH_V2_RUN_SNAPSHOT_MISSING"],
          store: ownedStore,
          ledger: physicalLedger,
          snapshotUsed: false,
          snapshotRecovered: false,
          snapshotRepairRequired: false,
        };
      }
      return failed(ownedStore, new RalphRunSnapshotV2Error("RALPH_V2_RUN_SNAPSHOT_MISSING_WITH_LEDGER"), undefined, physicalLedger);
    } catch (error) {
      return failed(ownedStore, error);
    }
  }
}

export const openOperationalRunV2ReadOnly = inspectOperationalRunV2;

function failed(
  store: RalphEventStoreV2,
  error: unknown,
  runSnapshot?: RunSnapshotV2,
  ledger?: LedgerInspectionV2,
): InspectOperationalRunV2Result {
  return {
    outcome: "FAILED_INTEGRITY",
    runId: store.runId,
    issues: [errorCode(error)],
    store,
    ...(runSnapshot === undefined ? {} : { runSnapshot }),
    ...(ledger === undefined ? {} : { ledger }),
    snapshotUsed: false,
    snapshotRecovered: false,
    snapshotRepairRequired: false,
  };
}

async function compareExternalFacts(
  input: InspectOperationalRunV2Input,
  snapshot: RunSnapshotV2,
): Promise<readonly string[]> {
  const facts = input.externalFacts;
  const issues: string[] = [];
  if (!facts) {
    const observed = await fingerprintWorkspace(
      input.projectRoot,
      snapshot.workspacePolicy,
      undefined,
      input.workspaceFingerprintFileSystem,
    );
    if (input.workspaceComparison === "ALLOW_POST_EXECUTOR_DRIFT") {
      if (observed.policyDigest !== snapshot.workspacePolicy.policyDigest) issues.push("workspace-policy-mismatch");
    } else compareFingerprint(observed, snapshot.initialWorkspaceFingerprint, issues);
    return issues;
  }
  if (facts.projectIdentity !== undefined && canonicalJson(facts.projectIdentity) !== canonicalJson(snapshot.projectIdentity)) issues.push("project-identity-mismatch");
  compareFact(facts.readyPlanIdentity, snapshot.readyPlanIdentity, "ready-plan-identity-mismatch", issues);
  compareFact(facts.readyPlanHash, snapshot.readyPlanHash, "ready-plan-hash-mismatch", issues);
  compareFact(facts.readyManifestHash, snapshot.readyManifestHash, "ready-manifest-hash-mismatch", issues);
  compareFact(facts.readinessInspectionDigest, snapshot.readinessInspectionDigest, "readiness-inspection-mismatch", issues);
  compareFact(facts.effectiveConfigDigest, snapshot.effectiveConfigDigest, "effective-config-mismatch", issues);
  compareFact(facts.executorProfileDigest, snapshot.executorProfile.descriptorDigest, "executor-profile-mismatch", issues);
  compareFact(facts.permissionCapabilityPolicyDigest, snapshot.permissionCapabilityPolicy.descriptorDigest, "permission-capability-policy-mismatch", issues);
  compareFact(facts.diagnosticsPolicyDigest, snapshot.diagnosticsPolicy.descriptorDigest, "diagnostics-policy-mismatch", issues);
  compareFact(facts.environmentPolicyDigest, snapshot.environmentPolicy.descriptorDigest, "environment-policy-mismatch", issues);
  compareFact(facts.workspacePolicyDigest, snapshot.workspacePolicy.policyDigest, "workspace-policy-mismatch", issues);
  compareFact(facts.runtimeIdentityDigest, snapshot.runtimeIdentity.descriptorDigest, "runtime-identity-mismatch", issues);
  compareFact(facts.leasePolicyDigest, snapshot.leasePolicy.descriptorDigest, "lease-policy-mismatch", issues);
  if (input.workspaceComparison === "ALLOW_POST_EXECUTOR_DRIFT") {
    const observed = await fingerprintWorkspace(input.projectRoot, snapshot.workspacePolicy, undefined, input.workspaceFingerprintFileSystem);
    if (observed.policyDigest !== snapshot.workspacePolicy.policyDigest) issues.push("workspace-policy-mismatch");
  } else if (facts.workspaceFingerprint !== undefined) compareFingerprint(facts.workspaceFingerprint, snapshot.initialWorkspaceFingerprint, issues);
  else {
    const observed = await fingerprintWorkspace(input.projectRoot, snapshot.workspacePolicy, undefined, input.workspaceFingerprintFileSystem);
    compareFingerprint(observed, snapshot.initialWorkspaceFingerprint, issues);
  }
  return issues;
}

function compareFingerprint(observed: FingerprintIdentity, expected: FingerprintIdentity, issues: string[]): void {
  if (observed.policyDigest !== expected.policyDigest) issues.push("workspace-policy-mismatch");
  if (observed.controlPlaneFingerprint !== expected.controlPlaneFingerprint || observed.productWorkspaceFingerprint !== expected.productWorkspaceFingerprint || observed.fingerprintDigest !== expected.fingerprintDigest) {
    issues.push("workspace-fingerprint-mismatch");
  }
}

function compareFact(observed: string | undefined, expected: string, issue: string, issues: string[]): void {
  if (observed !== undefined && observed !== expected) issues.push(issue);
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string") return (error as { code: string }).code;
  return error instanceof Error ? error.message : String(error);
}
