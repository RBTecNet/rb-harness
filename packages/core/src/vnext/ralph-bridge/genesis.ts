import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExecutionDocument } from "../../types.js";
import type { ProgressiveExecutionAuthorityV1 } from "./plan-authority.js";
import type { BridgeWorkspaceSnapshotV1 } from "./workspace-publication.js";
import { canonicalJson } from "../ralph-runtime/canonical-json.js";
import { createWorkspacePolicy, fingerprintWorkspace } from "../ralph-runtime/fingerprint.js";
import { sha256Canonical } from "../ralph-runtime/hashing.js";
import {
  RalphEventStoreV2,
  RALPH_RUN_SNAPSHOT_V2_SCHEMA,
  commitRalphEventV2,
  createRetryPolicyV1,
  initializeOperationalRunV2,
  retryPolicyDescriptorV1,
  type RalphRetryPolicyV1,
  type RunSnapshotV2,
} from "../ralph-runtime/operational-b1/index.js";
import type { LeaseRuntimeInputV2 } from "../ralph-runtime/operational-b2/index.js";
import {
  CODEX_CLI_EXECUTOR_PROFILE_V2,
  CODEX_MANAGED_RUNTIME_V2,
  codexExecutorProfileDigestV2,
  codexManagedRuntimeExpectedIdentityDigestV2,
  createM5BTimeoutPolicyV2,
  type M5BTimeoutPolicyV2,
} from "../ralph-runtime/operational-m5b/index.js";
import { CODEX_CLI_AUDITOR_PROFILE_IDENTITY_V2, CODEX_CLI_AUDITOR_PROFILE_ID_V2 } from "../ralph-runtime/operational-m5d/index.js";
import {
  EVENT_SCHEMA_V2,
  OPERATIONAL_CONTRACT_V2,
  STATE_SCHEMA_V2,
  createInitialRuntimeStateV2,
  createRalphEventV2,
  type EventPayloadMapV2,
  type RalphEventTypeV2,
  type RalphEventV2,
  type RalphRuntimeStateV2,
  type UnsignedRalphEventV2,
} from "../ralph-runtime/operational-v2/index.js";

export const RALPH_BRIDGE_RUN_SCHEMA_V1 = "rb-ralph-bridge-run/v1" as const;
export const RALPH_BRIDGE_MAX_TASK_ATTEMPTS_V1 = 2 as const;
export const RALPH_BRIDGE_VALIDATION_INFRASTRUCTURE_RETRIES_V1 = 0 as const;
export const RALPH_BRIDGE_PUBLICATION_SEMANTIC_V1 = "ACCEPTED_TASK_DELTA" as const;
export const RALPH_BRIDGE_DEFAULT_TIMEOUT_MS_V1 = 3_600_000 as const;

export class RalphBridgeGenesisError extends Error {
  constructor(readonly code: string, message: string = code) {
    super(`${code}: ${message}`);
    this.name = "RalphBridgeGenesisError";
  }
}

export interface RalphBridgeRunDescriptorV1 {
  readonly schema: typeof RALPH_BRIDGE_RUN_SCHEMA_V1;
  readonly runId: string;
  readonly semanticExecutionIdentity: string;
  readonly plan: {
    readonly id: string;
    readonly path: string;
    readonly sha256: string;
    readonly operationalDigest: string;
  };
  readonly workspaceRoot: string;
  readonly runDirectory: string;
  readonly publicationSemantic: typeof RALPH_BRIDGE_PUBLICATION_SEMANTIC_V1;
  readonly phases: readonly { readonly phaseId: string; readonly taskIds: readonly string[] }[];
  readonly tasks: readonly { readonly taskId: string; readonly phaseId: string; readonly dependsOn: readonly string[] }[];
  readonly createdAt: string;
  readonly descriptorDigest: string;
}

export interface InitializedBridgeRunV1 {
  readonly descriptor: RalphBridgeRunDescriptorV1;
  readonly store: RalphEventStoreV2;
  readonly retryPolicy: RalphRetryPolicyV1;
  readonly timeoutPolicy: M5BTimeoutPolicyV2;
  readonly snapshot: RunSnapshotV2;
  readonly genesisState: RalphRuntimeStateV2;
  readonly state: RalphRuntimeStateV2;
  readonly lease: LeaseRuntimeInputV2;
}

export async function initializeBridgeRunV1(input: {
  readonly authority: ProgressiveExecutionAuthorityV1;
  readonly workspaceRoot: string;
  readonly hostBaseline: BridgeWorkspaceSnapshotV1;
  readonly createdAt?: string;
  readonly runId?: string;
  readonly timeoutMs?: number;
  readonly nonceFactory?: () => string;
  readonly eventIdFactory?: () => string;
}): Promise<InitializedBridgeRunV1> {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const runId = input.runId ?? freshRunId(input.authority.semanticExecutionIdentity);
  const nonceFactory = input.nonceFactory ?? randomUUID;
  const eventIdFactory = input.eventIdFactory ?? randomUUID;
  const plan = input.authority.operationalPlan;
  const store = new RalphEventStoreV2({ projectRoot: resolve(input.workspaceRoot), runId });
  const retryPolicy = createRetryPolicyV1({
    runId,
    policyId: "ralph-bridge-v1",
    maxTaskAttemptsPerTask: RALPH_BRIDGE_MAX_TASK_ATTEMPTS_V1,
    validationInfrastructureRetryLimit: RALPH_BRIDGE_VALIDATION_INFRASTRUCTURE_RETRIES_V1,
  });
  const timeoutPolicy = createM5BTimeoutPolicyV2(input.timeoutMs ?? RALPH_BRIDGE_DEFAULT_TIMEOUT_MS_V1);
  const allOwnedPaths = Object.values(input.authority.ownedPathsByTask).flat();
  const workspacePolicy = createWorkspacePolicy({ scopePaths: allOwnedPaths, coversPaths: allOwnedPaths });
  const initial = await fingerprintWorkspace(store.projectRoot, workspacePolicy);
  const genesisState = genesisFor(plan, runId, retryPolicy.maxTaskAttemptsPerTask);
  const effectiveConfig = descriptor("rb-ralph-bridge-config/v1", input.authority.semanticExecutionIdentity, sha256Canonical({
    semanticExecutionIdentity: input.authority.semanticExecutionIdentity,
    publicationSemantic: RALPH_BRIDGE_PUBLICATION_SEMANTIC_V1,
    operationalPlanDigest: input.authority.operationalPlanDigest,
    executorProfile: CODEX_CLI_EXECUTOR_PROFILE_V2,
    auditorProfile: CODEX_CLI_AUDITOR_PROFILE_ID_V2,
    auditorProfileIdentity: CODEX_CLI_AUDITOR_PROFILE_IDENTITY_V2,
    managedRuntime: CODEX_MANAGED_RUNTIME_V2.id,
  }));
  const snapshot: RunSnapshotV2 = {
    snapshotSchemaVersion: RALPH_RUN_SNAPSHOT_V2_SCHEMA,
    runId,
    eventSchema: EVENT_SCHEMA_V2,
    stateSchema: STATE_SCHEMA_V2,
    operationalContract: OPERATIONAL_CONTRACT_V2,
    projectIdentity: {
      projectId: input.authority.manifest.project.id,
      semanticExecutionIdentity: input.authority.semanticExecutionIdentity,
      planPath: input.authority.selectedPlan.path,
      planSourceSha256: input.authority.selectedPlan.sha256,
      hostBaselineDigest: input.hostBaseline.digest,
    },
    readyPlanIdentity: input.authority.selectedPlan.id,
    readyPlanHash: input.authority.operationalPlanDigest,
    readyManifestHash: input.authority.manifestHash,
    selectedReadyArtifactHashes: { executionPlanSource: input.authority.selectedPlanSourceHash },
    readinessInspectionDigest: input.authority.readinessDigest,
    effectiveRunConfig: effectiveConfig,
    effectiveConfigDigest: effectiveConfig.descriptorDigest,
    diagnosticsPolicy: descriptor("rb-ralph-diagnostics/v2", "secret-safe-durable-evidence"),
    environmentPolicy: descriptor("rb-ralph-environment/v2", "managed-codex-closed-environment"),
    executorProfile: {
      profileId: CODEX_CLI_EXECUTOR_PROFILE_V2,
      kind: "scripted",
      descriptorDigest: codexExecutorProfileDigestV2(),
    },
    executorCapabilities: {
      requested: ["workspace.write"],
      granted: ["workspace.write"],
      verified: ["workspace.write", "control-plane.deny", "network.deny"],
      readOnlyEnforced: false,
    },
    permissionCapabilityPolicy: descriptor("rb-ralph-capabilities/v2", "managed-codex-work-unit-owned-paths"),
    workspacePolicy,
    initialWorkspaceFingerprint: fingerprintIdentity(initial),
    retryPolicies: retryPolicyDescriptorV1(retryPolicy),
    timeoutPolicy: descriptor("rb-ralph-timeout/v2", "managed-codex-provider-deadline", timeoutPolicy.policyDigest),
    runtimeIdentity: descriptor("rb-ralph-runtime/v2", CODEX_MANAGED_RUNTIME_V2.id, codexManagedRuntimeExpectedIdentityDigestV2()),
    leasePolicy: descriptor("rb-ralph-lease/v2", "single-writer-no-heartbeat"),
    createdAt,
  };
  const bridgeRoot = resolve(input.authority.projectRoot, ".rb-harness", "ralph", "bridge-runs", runId);
  const descriptorValue = bridgeRunDescriptor(input.authority, plan, runId, store.projectRoot, store.runDirectory, createdAt);
  await persistBridgeDescriptor(bridgeRoot, descriptorValue);
  const initialized = await initializeOperationalRunV2({
    store,
    snapshot,
    retryPolicy,
    genesisState,
    runCreatedEvent: coreEvent(genesisState, "run.created", { phaseIds: genesisState.phaseIds, taskIds: genesisState.taskIds }, eventIdFactory, createdAt),
    createdAt,
    nonce: nonceFactory(),
  });
  let state = initialized.state;
  state = await commitEvent(store, state, coreEvent(state, "run.started", {}, eventIdFactory, createdAt), createdAt, nonceFactory);
  for (const taskId of state.taskIds) {
    const task = state.tasks[taskId]!;
    state = await commitEvent(store, state, coreEvent(state, "task.state-changed", {
      disposition: "READY",
      activity: "IDLE",
      owner: "NONE",
      hold: "NONE",
    }, eventIdFactory, createdAt, { phaseId: task.phaseId, taskId }), createdAt, nonceFactory);
  }
  const externalFacts = {
    projectIdentity: snapshot.projectIdentity,
    readyPlanIdentity: snapshot.readyPlanIdentity,
    readyPlanHash: snapshot.readyPlanHash,
    readyManifestHash: snapshot.readyManifestHash,
    readinessInspectionDigest: snapshot.readinessInspectionDigest,
    effectiveConfigDigest: snapshot.effectiveConfigDigest,
    executorProfileDigest: snapshot.executorProfile.descriptorDigest,
    permissionCapabilityPolicyDigest: snapshot.permissionCapabilityPolicy.descriptorDigest,
    diagnosticsPolicyDigest: snapshot.diagnosticsPolicy.descriptorDigest,
    environmentPolicyDigest: snapshot.environmentPolicy.descriptorDigest,
    workspacePolicyDigest: snapshot.workspacePolicy.policyDigest,
    runtimeIdentityDigest: snapshot.runtimeIdentity.descriptorDigest,
    leasePolicyDigest: snapshot.leasePolicy.descriptorDigest,
    workspaceFingerprint: snapshot.initialWorkspaceFingerprint,
  } as const;
  return Object.freeze({
    descriptor: descriptorValue,
    store,
    retryPolicy,
    timeoutPolicy,
    snapshot,
    genesisState,
    state,
    lease: { projectRoot: store.projectRoot, runId, genesisState, externalFacts },
  });
}

export function genesisFor(plan: ExecutionDocument, runId: string, maxAttempts: number = RALPH_BRIDGE_MAX_TASK_ATTEMPTS_V1): RalphRuntimeStateV2 {
  return createInitialRuntimeStateV2({
    runId,
    maxTaskAttemptsPerTask: maxAttempts,
    phases: plan.phases.map((phase) => ({ phaseId: phase.id, taskIds: phase.tasks.map((task) => task.id) })),
    tasks: plan.phases.flatMap((phase) => phase.tasks.map((task) => ({ taskId: task.id, phaseId: phase.id, dependsOn: [...task.dependsOn] }))),
  });
}

export async function listBridgeRunDescriptors(projectRoot: string): Promise<readonly RalphBridgeRunDescriptorV1[]> {
  const directory = resolve(projectRoot, ".rb-harness", "ralph", "bridge-runs");
  const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [] as string[];
    throw error;
  });
  const descriptors: RalphBridgeRunDescriptorV1[] = [];
  for (const name of names.sort()) {
    const path = resolve(directory, name, "bridge-run.json");
    const value = await readFile(path, "utf8").then((source) => JSON.parse(source) as unknown).catch(() => undefined);
    if (!value || !isBridgeRunDescriptor(value)
      || value.runId !== name
      || value.workspaceRoot !== resolve(directory, name, "workspace")
      || value.runDirectory !== resolve(directory, name, "workspace", ".rb-harness", "ralph", "runs", name)) {
      throw new RalphBridgeGenesisError("RALPH_BRIDGE_RUN_DESCRIPTOR_INVALID", name);
    }
    descriptors.push(value);
  }
  return descriptors.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.runId.localeCompare(right.runId));
}

export function isBridgeRunDescriptor(value: unknown): value is RalphBridgeRunDescriptorV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.schema !== RALPH_BRIDGE_RUN_SCHEMA_V1 || typeof record.runId !== "string" || typeof record.semanticExecutionIdentity !== "string"
    || typeof record.workspaceRoot !== "string" || typeof record.runDirectory !== "string" || typeof record.createdAt !== "string"
    || record.publicationSemantic !== RALPH_BRIDGE_PUBLICATION_SEMANTIC_V1 || typeof record.descriptorDigest !== "string") return false;
  if (!record.plan || typeof record.plan !== "object" || Array.isArray(record.plan)
    || !record.phases || !Array.isArray(record.phases) || !record.tasks || !Array.isArray(record.tasks)) return false;
  const plan = record.plan as Record<string, unknown>;
  if (typeof plan.id !== "string" || typeof plan.path !== "string" || typeof plan.sha256 !== "string" || typeof plan.operationalDigest !== "string") return false;
  const { descriptorDigest, ...base } = record;
  return descriptorDigest === sha256Canonical(base);
}

export async function commitRunTerminalEvent(input: {
  readonly store: RalphEventStoreV2;
  readonly state: RalphRuntimeStateV2;
  readonly disposition: "COMPLETE" | "FAILED";
  readonly reason?: string;
  readonly clock?: () => string;
  readonly nonceFactory?: () => string;
  readonly eventIdFactory?: () => string;
}): Promise<RalphRuntimeStateV2> {
  const now = input.clock?.() ?? new Date().toISOString();
  const eventIdFactory = input.eventIdFactory ?? randomUUID;
  const event = input.disposition === "COMPLETE"
    ? coreEvent(input.state, "run.completed", { finalStatePersisted: true }, eventIdFactory, now)
    : coreEvent(input.state, "run.failed", { reason: input.reason ?? "RALPH_BRIDGE_FAILED_CLOSED" }, eventIdFactory, now);
  return commitEvent(input.store, input.state, event, now, input.nonceFactory ?? randomUUID);
}

function bridgeRunDescriptor(
  authority: ProgressiveExecutionAuthorityV1,
  plan: ExecutionDocument,
  runId: string,
  workspaceRoot: string,
  runDirectory: string,
  createdAt: string,
): RalphBridgeRunDescriptorV1 {
  const base = {
    schema: RALPH_BRIDGE_RUN_SCHEMA_V1,
    runId,
    semanticExecutionIdentity: authority.semanticExecutionIdentity,
    plan: { id: authority.selectedPlan.id, path: authority.selectedPlan.path, sha256: authority.selectedPlan.sha256, operationalDigest: authority.operationalPlanDigest },
    workspaceRoot,
    runDirectory,
    publicationSemantic: RALPH_BRIDGE_PUBLICATION_SEMANTIC_V1,
    phases: plan.phases.map((phase) => ({ phaseId: phase.id, taskIds: phase.tasks.map((task) => task.id) })),
    tasks: plan.phases.flatMap((phase) => phase.tasks.map((task) => ({ taskId: task.id, phaseId: phase.id, dependsOn: [...task.dependsOn] }))),
    createdAt,
  } as const;
  return Object.freeze({ ...base, descriptorDigest: sha256Canonical(base) });
}

async function persistBridgeDescriptor(directory: string, descriptorValue: RalphBridgeRunDescriptorV1): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = resolve(directory, "bridge-run.json");
  const source = canonicalJson(descriptorValue);
  try { await writeFile(path, source, { flag: "wx", mode: 0o600 }); }
  catch {
    if (await readFile(path, "utf8").catch(() => undefined) !== source) throw new Error("RALPH_BRIDGE_RUN_DESCRIPTOR_IMMUTABLE_CONFLICT");
  }
}

function descriptor(schemaVersion: string, descriptorId: string, fixedDigest?: string) {
  const base = { schemaVersion, descriptorId };
  return { ...base, descriptorDigest: fixedDigest ?? sha256Canonical(base) };
}

function fingerprintIdentity(value: Awaited<ReturnType<typeof fingerprintWorkspace>>) {
  return {
    controlPlaneFingerprint: value.controlPlaneFingerprint,
    productWorkspaceFingerprint: value.productWorkspaceFingerprint,
    policyDigest: value.policyDigest,
    fingerprintDigest: value.fingerprintDigest,
  };
}

function freshRunId(semanticIdentity: string): string {
  const semantic = semanticIdentity.slice(-16);
  return `ralph-${semantic}-${randomUUID().replaceAll("-", "")}`;
}

async function commitEvent(
  store: RalphEventStoreV2,
  state: RalphRuntimeStateV2,
  event: RalphEventV2,
  writtenAt: string,
  nonceFactory: () => string,
): Promise<RalphRuntimeStateV2> {
  return (await commitRalphEventV2({ store, state, event, writtenAt, nonce: nonceFactory() })).state;
}

function coreEvent<TType extends RalphEventTypeV2>(
  state: RalphRuntimeStateV2,
  eventType: TType,
  payload: EventPayloadMapV2[TType],
  eventIdFactory: () => string,
  occurredAt: string,
  context: { readonly phaseId?: string; readonly taskId?: string; readonly attemptId?: string } = {},
): RalphEventV2 {
  const entity = eventType === "task.state-changed"
    ? { kind: "task" as const, id: context.taskId! }
    : eventType.startsWith("attempt.") || eventType.startsWith("executor.") || eventType.startsWith("validation.") || eventType === "audit.started"
      ? { kind: "attempt" as const, id: context.attemptId! }
      : { kind: "run" as const, id: state.runId };
  return createRalphEventV2({
    eventId: eventIdFactory(), eventType, schemaVersion: state.eventSchema, runId: state.runId,
    sequence: state.lastSequence + 1, occurredAt, recordedAt: occurredAt, entity,
    ...(context.phaseId ? { phaseId: context.phaseId } : {}),
    ...(context.taskId ? { taskId: context.taskId } : {}),
    ...(context.attemptId ? { attemptId: context.attemptId } : {}),
    actor: "CORE", causationId: null, correlationId: `${state.runId}:bridge`, payload,
    previousEventHash: state.lastEventHash,
  } as UnsignedRalphEventV2<TType>) as RalphEventV2;
}
