import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExecutionDocument, Phase, Task } from "../../../src/types.js";
import type { RuntimeEntityRef } from "../../../src/vnext/ralph-runtime/contracts.js";
import {
  EVENT_SCHEMA_V2,
  OPERATIONAL_CONTRACT_V2,
  STATE_SCHEMA_V2,
  V2_EVENT_ENTITY_KINDS,
  createInitialRuntimeStateV2,
  createRalphEventV2,
  type EventPayloadMapV2,
  type RalphEventTypeV2,
  type RalphEventV2,
  type RalphRuntimeStateV2,
  type UnsignedRalphEventV2,
} from "../../../src/vnext/ralph-runtime/operational-v2/index.js";
import {
  RALPH_RUN_SNAPSHOT_V2_SCHEMA,
  RalphEventStoreV2,
  commitRalphEventV2,
  createRetryPolicyV1,
  initializeOperationalRunV2,
  retryPolicyDescriptorV1,
  type RunSnapshotV2,
} from "../../../src/vnext/ralph-runtime/operational-b1/index.js";
import {
  acquireLeasedRunV2,
  defaultProcessIdentityProvider,
  type LeaseRuntimeInputV2,
} from "../../../src/vnext/ralph-runtime/operational-b2/index.js";
import { prepareNextAuthorizedInvocationV2 } from "../../../src/vnext/ralph-runtime/operational-b3/index.js";
import { createWorkspacePolicy, fingerprintWorkspace } from "../../../src/vnext/ralph-runtime/fingerprint.js";
import { sha256, sha256Canonical } from "../../../src/vnext/ralph-runtime/hashing.js";
import {
  CODEX_CLI_EXECUTOR_PROFILE_V2,
  codexExecutorProfileDigestV2,
  createM5BTimeoutPolicyV2,
  type M5BTimeoutPolicyV2,
} from "../../../src/vnext/ralph-runtime/operational-m5b/contract.js";

export const M5B_FIXTURE_TASK_ID = "T001";
export const M5B_FIXTURE_PHASE_ID = "P01";

export interface M5BFixtureOptionsV2 {
  readonly deadlineMs?: number;
  readonly scope?: string;
  readonly covers?: string;
  readonly extraProductFiles?: Readonly<Record<string, string>>;
  readonly maxTaskAttemptsPerTask?: number;
  /** Root-scope Attempts need a different WorkUnit, not a different Core. */
  readonly title?: string;
  readonly change?: string;
  readonly acceptanceCriteria?: readonly string[];
  readonly validation?: readonly string[];
  readonly expectedEvidence?: string;
  /** Workspace policy paths, when they differ from scope/covers. */
  readonly scopePaths?: readonly string[];
  readonly coversPaths?: readonly string[];
}

export interface M5BFixtureV2 {
  readonly projectRoot: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly store: RalphEventStoreV2;
  readonly plan: ExecutionDocument;
  readonly planDigest: string;
  readonly leaseInput: LeaseRuntimeInputV2;
  readonly timeoutPolicy: M5BTimeoutPolicyV2;
  readonly snapshot: RunSnapshotV2;
  readonly stagingBase: string;
}

function task(options: M5BFixtureOptionsV2): Task {
  return {
    id: M5B_FIXTURE_TASK_ID,
    title: options.title ?? "Create deterministic ready status module",
    done: false,
    scope: options.scope ?? "src/status.js",
    change: options.change ?? "Create src/status.js exporting exactly: module.exports = \"ready\";",
    covers: options.covers ?? "src/status.js",
    dependsOn: [],
    parallelSafe: false,
    acceptanceCriteria: [...(options.acceptanceCriteria ?? ["Requiring ./src/status.js returns exactly the string ready"])],
    validation: [...(options.validation ?? ["`node -e 'const s=require(\"./src/status.js\"); if (s !== \"ready\") process.exit(1)'`"])],
    expectedEvidence: options.expectedEvidence ?? "A real workspace delta creating only src/status.js with the required CommonJS export",
    line: 1,
  };
}

export function m5bPlan(options: M5BFixtureOptionsV2 = {}): ExecutionDocument {
  const phase: Phase = {
    number: 1,
    id: M5B_FIXTURE_PHASE_ID,
    title: "Stock Codex CLI Executor",
    goal: "Prove one real stock codex exec Attempt through the frozen Ralph Core",
    dependsOn: [],
    context: ["sacrificial project; no user code or secrets"],
    tasks: [task(options)],
    line: 1,
  };
  return { contract: "rb-execution/v1", artifactId: "plan-m5b", title: "M5-B stock Codex CLI Executor", phases: [phase] };
}

function descriptor(schemaVersion: string, descriptorId: string, descriptorDigest?: string): { schemaVersion: string; descriptorId: string; descriptorDigest: string } {
  const base = { schemaVersion, descriptorId };
  return { ...base, descriptorDigest: descriptorDigest ?? sha256Canonical(base) };
}

function genesis(document: ExecutionDocument, runId: string, maxTaskAttemptsPerTask: number): RalphRuntimeStateV2 {
  return createInitialRuntimeStateV2({
    runId,
    maxTaskAttemptsPerTask,
    phases: document.phases.map((phase) => ({ phaseId: phase.id, taskIds: phase.tasks.map((candidate) => candidate.id) })),
    tasks: document.phases.flatMap((phase) => phase.tasks.map((candidate) => ({ taskId: candidate.id, phaseId: phase.id, dependsOn: candidate.dependsOn }))),
  });
}

export function m5bEvent<TType extends RalphEventTypeV2>(
  state: RalphRuntimeStateV2,
  eventType: TType,
  payload: EventPayloadMapV2[TType],
  context: { readonly phaseId?: string; readonly taskId?: string; readonly attemptId?: string } = {},
): RalphEventV2 {
  const kind = V2_EVENT_ENTITY_KINDS[eventType];
  const entity: RuntimeEntityRef = kind === "run" ? { kind, id: state.runId }
    : kind === "workspace" ? { kind, id: `${state.runId}:workspace` }
      : kind === "task" ? { kind, id: context.taskId ?? M5B_FIXTURE_TASK_ID }
        : { kind: "attempt", id: context.attemptId ?? "attempt-m5b" };
  const now = new Date().toISOString();
  return createRalphEventV2({
    eventId: `m5b-${randomUUID()}`,
    eventType,
    schemaVersion: EVENT_SCHEMA_V2,
    runId: state.runId,
    sequence: state.lastSequence + 1,
    occurredAt: now,
    recordedAt: now,
    entity,
    ...(context.phaseId === undefined ? {} : { phaseId: context.phaseId }),
    ...(context.taskId === undefined ? {} : { taskId: context.taskId }),
    ...(context.attemptId === undefined ? {} : { attemptId: context.attemptId }),
    actor: "CORE",
    causationId: null,
    correlationId: `${state.runId}:m5b`,
    payload,
    previousEventHash: state.lastEventHash,
  } as UnsignedRalphEventV2<TType>) as RalphEventV2;
}

export async function appendM5BEvent(store: RalphEventStoreV2, state: RalphRuntimeStateV2, next: RalphEventV2): Promise<RalphRuntimeStateV2> {
  return (await commitRalphEventV2({ store, state, event: next, writtenAt: new Date().toISOString(), nonce: randomUUID() })).state;
}

/** A disposable canonical project with Core-owned control-plane canaries. */
export async function bootstrapM5BRunV2(options: M5BFixtureOptionsV2 = {}): Promise<M5BFixtureV2> {
  const projectRoot = await mkdtemp(resolve(tmpdir(), "rb-ralph-m5b-project-"));
  const stagingBase = await mkdtemp(resolve(tmpdir(), "rb-ralph-m5b-staging-"));
  await mkdir(join(projectRoot, "src"), { recursive: true });
  await writeFile(join(projectRoot, "README.md"), "# Disposable Ralph M5-B Codex fixture\n");
  // Every Core-owned control-plane root gets a canary: the provider must not
  // be able to read, write or even create one of these inside its projection,
  // and publication must leave all three byte-identical.
  for (const controlRoot of [".rb-harness", ".rb", ".git"]) {
    await mkdir(join(projectRoot, controlRoot), { recursive: true });
    await writeFile(join(projectRoot, controlRoot, "canary.txt"), "control-plane canary\n");
  }
  for (const [path, content] of Object.entries(options.extraProductFiles ?? {})) {
    await mkdir(join(projectRoot, path, ".."), { recursive: true });
    await writeFile(join(projectRoot, path), content);
  }

  const plan = m5bPlan(options);
  const planDigest = sha256Canonical(plan);
  const runId = `run-m5b-${randomUUID()}`;
  const attemptId = `attempt-m5b-${randomUUID()}`;
  const maxTaskAttemptsPerTask = options.maxTaskAttemptsPerTask ?? 1;
  const timeoutPolicy = createM5BTimeoutPolicyV2(options.deadlineMs ?? 120_000);
  const retryPolicy = createRetryPolicyV1({ runId, policyId: "m5b-no-retry", maxTaskAttemptsPerTask, validationInfrastructureRetryLimit: 0 });
  const workspacePolicy = createWorkspacePolicy({
    scopePaths: [...(options.scopePaths ?? [options.scope ?? "src/status.js"])],
    coversPaths: [...(options.coversPaths ?? [options.covers ?? "src/status.js"])],
  });
  const initialFingerprint = await fingerprintWorkspace(projectRoot, workspacePolicy);
  const config = descriptor("rb-ralph-config/v2", "m5b-config");
  const snapshot: RunSnapshotV2 = {
    snapshotSchemaVersion: RALPH_RUN_SNAPSHOT_V2_SCHEMA,
    runId,
    eventSchema: EVENT_SCHEMA_V2,
    stateSchema: STATE_SCHEMA_V2,
    operationalContract: OPERATIONAL_CONTRACT_V2,
    projectIdentity: { projectId: "m5b-sacrificial-project" },
    readyPlanIdentity: plan.artifactId,
    readyPlanHash: planDigest,
    readyManifestHash: sha256("m5b-ready-manifest"),
    selectedReadyArtifactHashes: { plan: planDigest },
    readinessInspectionDigest: sha256("m5b-readiness"),
    effectiveRunConfig: config,
    effectiveConfigDigest: config.descriptorDigest,
    diagnosticsPolicy: descriptor("rb-ralph-diagnostics/v2", "m5b-diagnostics"),
    environmentPolicy: descriptor("rb-ralph-environment/v2", "m5b-environment-allowlisted"),
    executorProfile: { profileId: CODEX_CLI_EXECUTOR_PROFILE_V2, kind: "scripted", descriptorDigest: codexExecutorProfileDigestV2() },
    executorCapabilities: { requested: ["workspace.write"], granted: ["workspace.write"], verified: ["workspace.write"], readOnlyEnforced: false },
    permissionCapabilityPolicy: descriptor("rb-ralph-capabilities/v2", "m5b-project-root-only"),
    workspacePolicy,
    initialWorkspaceFingerprint: {
      controlPlaneFingerprint: initialFingerprint.controlPlaneFingerprint,
      productWorkspaceFingerprint: initialFingerprint.productWorkspaceFingerprint,
      policyDigest: initialFingerprint.policyDigest,
      fingerprintDigest: initialFingerprint.fingerprintDigest,
    },
    retryPolicies: retryPolicyDescriptorV1(retryPolicy),
    timeoutPolicy: descriptor("rb-ralph-timeout/v2", "m5b-timeout", timeoutPolicy.policyDigest),
    runtimeIdentity: descriptor("rb-ralph-runtime/v2", "m5b-runtime"),
    leasePolicy: descriptor("rb-ralph-lease/v2", "m5b-lease"),
    createdAt: new Date().toISOString(),
  };
  const store = new RalphEventStoreV2({ projectRoot, runId });
  const initial = genesis(plan, runId, maxTaskAttemptsPerTask);
  const initialized = await initializeOperationalRunV2({
    store,
    snapshot,
    retryPolicy,
    genesisState: initial,
    runCreatedEvent: m5bEvent(initial, "run.created", { phaseIds: initial.phaseIds, taskIds: initial.taskIds }),
    createdAt: new Date().toISOString(),
    nonce: randomUUID(),
  });
  let state = await appendM5BEvent(store, initialized.state, m5bEvent(initialized.state, "run.started", {}));
  state = await appendM5BEvent(store, state, m5bEvent(state, "task.state-changed", {
    disposition: "READY", activity: "IDLE", owner: "NONE", hold: "NONE",
  }, { phaseId: M5B_FIXTURE_PHASE_ID, taskId: M5B_FIXTURE_TASK_ID }));

  return Object.freeze({
    projectRoot,
    runId,
    attemptId,
    store,
    plan,
    planDigest,
    leaseInput: { projectRoot, runId, genesisState: initial, processIdentityProvider: defaultProcessIdentityProvider },
    timeoutPolicy,
    snapshot,
    stagingBase,
  });
}

export async function admitM5BAttemptV2(fixture: M5BFixtureV2, attemptId = fixture.attemptId) {
  const lease = await acquireLeasedRunV2(fixture.leaseInput);
  const admitted = await prepareNextAuthorizedInvocationV2({
    leasedRun: lease,
    plan: fixture.plan,
    planIdentity: fixture.plan.artifactId,
    planDigest: fixture.planDigest,
    attemptIdFactory: () => attemptId,
  });
  if (admitted.kind !== "AUTHORIZED_NOT_INVOKED") throw new Error(`m5b fixture admission failed: ${admitted.kind}`);
  return { lease, admitted };
}
