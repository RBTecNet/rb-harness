import { mkdtemp, readFile, readdir, rm, writeFile, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const AUDIT_SESSION_PREFIX = "ses_m4dAuditSession";

interface FakeEnvelope {
  readonly verdict?: unknown;
  readonly proposedFindings?: unknown;
  readonly resolvedFindingRefs?: unknown;
  readonly rationale?: unknown;
  readonly [key: string]: unknown;
}

const transport = vi.hoisted(() => ({
  promptCalls: 0,
  sessionCreates: 0,
  serverStarts: 0,
  sanitizedReads: 0,
  workerStarts: 0,
  promptSawDurableChain: false,
  workerEnvironments: [] as NodeJS.ProcessEnv[],
  sessionPermissions: [] as unknown[],
  promptTools: [] as unknown[],
  sessionTitles: [] as string[],
  createdSessions: [] as string[],
  sanitizedEnvironments: [] as (NodeJS.ProcessEnv | undefined)[],
  forcedSessionId: null as string | null,
  responseText: null as string | null,
  responseModel: null as string | null,
  responseClassification: "SUCCEEDED" as "SUCCEEDED" | "FAILED",
  observationMismatch: false,
  workspaceMutation: null as null | { readonly path: string; readonly content: string },
  settlementObserved: true,
  settlementQuiescent: true,
  settlementVerified: true,
  projectRoot: "",
}));

vi.mock("../../src/vnext/ralph-runtime/operational-b4/opencode-cli-process.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/vnext/ralph-runtime/operational-b4/opencode-cli-process.js")>();
  return {
    ...actual,
    inspectExactOpenCodeCliExecutableV2: vi.fn(async () => Object.freeze({
      executablePath: "/home/bruno/.opencode/bin/opencode",
      executableVersion: "1.18.29",
    })),
    startOpenCodeCliWorkerV2: vi.fn(async (input: { readonly environment?: NodeJS.ProcessEnv }) => {
      transport.workerStarts += 1;
      transport.workerEnvironments.push(input.environment ?? {});
      const { defaultProcessIdentityProvider } = await import("../../src/vnext/ralph-runtime/operational-b2/index.js");
      const host = await defaultProcessIdentityProvider.current();
      const processIdentity = Object.freeze({ ...host, pid: 987_321, processStartIdentity: `sha256:${"b".repeat(64)}` });
      return Object.freeze({
        processIdentity,
        processGroupId: processIdentity.pid,
        startedAt: "2026-09-06T07:10:00.000Z",
        async startServer() {
          transport.serverStarts += 1;
          return "http://127.0.0.1:32411";
        },
        async settle() {
          return Object.freeze({
            observed: transport.settlementObserved,
            quiescent: transport.settlementQuiescent,
            verified: transport.settlementVerified,
            survivors: [],
            containment: { kind: "cgroup-v2", structural: true },
          });
        },
      });
    }),
  };
});

vi.mock("../../src/vnext/ralph-runtime/operational-b4/opencode-cli-session-inspector.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/vnext/ralph-runtime/operational-b4/opencode-cli-session-inspector.js")>();
  const MODEL = "opencode-go/deepseek-v4-pro";
  const assistant = (sessionId: string, userMessageId: string) => Object.freeze({
    assistantMessageId: "msg_m4d_fake_assistant_001",
    sessionId,
    userMessageId,
    modelSelector: transport.responseModel ?? MODEL,
    classification: transport.responseClassification,
    parts: Object.freeze([{ type: "text", text: transport.responseText ?? "" }]),
    assistantContentDigest: `sha256:${"7".repeat(64)}`,
    responseDigest: `sha256:${"8".repeat(64)}`,
    observableTurnDigest: `sha256:${"9".repeat(64)}`,
    raw: {},
  });
  return {
    ...actual,
    OpenCodeCliHttpClientV2: class {
      constructor(private readonly options: {
        readonly projectRoot: string;
        readonly sessionPermission?: unknown;
        readonly promptTools?: unknown;
      }) {
        transport.sessionPermissions.push(options.sessionPermission);
        transport.promptTools.push(options.promptTools);
      }
      async health() { return "1.18.29"; }
      async createSession(input: { readonly title: string }) {
        transport.sessionCreates += 1;
        transport.sessionTitles.push(input.title);
        const id = transport.forcedSessionId ?? `${AUDIT_SESSION_PREFIX}${String(transport.sessionCreates).padStart(4, "0")}`;
        transport.createdSessions.push(id);
        return Object.freeze({ id, directory: this.options.projectRoot, version: "1.18.29", modelSelector: MODEL });
      }
      async getSession() {
        const id = transport.createdSessions[transport.createdSessions.length - 1] ?? `${AUDIT_SESSION_PREFIX}0001`;
        return Object.freeze({ id, directory: this.options.projectRoot, version: "1.18.29", modelSelector: MODEL });
      }
      async listMessages() { return []; }
      async sendPrompt(input: { readonly sessionId: string; readonly userMessageId: string }) {
        transport.promptCalls += 1;
        const files = await readdir(resolve(transport.projectRoot, ".rb-harness", "ralph", "runs"), { recursive: true });
        transport.promptSawDurableChain = ["audit-provider-descriptor.json", "audit-provider-dispatch-intent.json", "audit-provider-worker-started.json", "audit-provider-session-binding.json", "audit-provider-prompt.json"]
          .every((name) => files.some((file) => String(file).endsWith(name)));
        if (!transport.promptSawDurableChain) throw new Error("fixture observed an audit prompt before the durable audit dispatch chain");
        if (transport.workspaceMutation) {
          await writeFile(join(transport.projectRoot, transport.workspaceMutation.path), transport.workspaceMutation.content);
        }
        return assistant(input.sessionId, input.userMessageId);
      }
      async readExactPromptResult(input: { readonly sessionId: string; readonly userMessageId: string }) {
        return assistant(input.sessionId, input.userMessageId);
      }
      async abort() { return true; }
    },
    readSanitizedExactOpenCodeTurnV2: async (options: { readonly environment?: NodeJS.ProcessEnv }, input: { readonly sessionId: string; readonly userMessageId: string }) => {
      transport.sanitizedReads += 1;
      transport.sanitizedEnvironments.push(options.environment);
      const value = assistant(input.sessionId, input.userMessageId);
      return transport.observationMismatch ? Object.freeze({ ...value, observableTurnDigest: `sha256:${"1".repeat(64)}` }) : value;
    },
  };
});

import type { RuntimeEntityRef } from "../../src/vnext/ralph-runtime/contracts.js";
import type { ExecutionDocument, Phase, Task } from "../../src/types.js";
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
} from "../../src/vnext/ralph-runtime/operational-v2/index.js";
import {
  RALPH_RUN_SNAPSHOT_V2_SCHEMA,
  RalphEventStoreV2,
  commitRalphEventV2,
  createRetryPolicyV1,
  initializeOperationalRunV2,
  retryPolicyDescriptorV1,
  type RunSnapshotV2,
} from "../../src/vnext/ralph-runtime/operational-b1/index.js";
import {
  acquireLeasedRunV2,
  releaseLeasedRunV2,
  type LeaseRuntimeInputV2,
  type ProcessIdentity,
  type ProcessIdentityProvider,
} from "../../src/vnext/ralph-runtime/operational-b2/index.js";
import { prepareNextAuthorizedInvocationV2, type AuthorizedInvocationV2 } from "../../src/vnext/ralph-runtime/operational-b3/index.js";
import {
  ScriptedExecutor,
  createM4BTimeoutPolicyV2,
  loadExactConformanceRecordV2,
  createProviderDispatchIntentV2,
  createProviderInvocationDescriptorV2,
  createProviderSessionBindingV2,
  createProviderWorkerReceiptV2,
  executeAuthorizedInvocationV2,
  persistProviderDispatchIntentV2,
  persistProviderInvocationDescriptorV2,
  persistProviderSessionBindingV2,
  persistProviderWorkerReceiptV2,
  type M4BTimeoutPolicyV2,
} from "../../src/vnext/ralph-runtime/operational-b4/index.js";
import { captureEvidenceV2 } from "../../src/vnext/ralph-runtime/operational-c/index.js";
import { readAuditPackageV2, validateAttemptV2 } from "../../src/vnext/ralph-runtime/operational-d/index.js";
import {
  auditAttemptV2,
  createAuditInvocationDescriptorV2,
  isTrustedAuditorRuntimeV2,
  persistAuditInvocationDescriptorV2,
  readAuditInvocationDescriptorV2,
  readAuditResultV2,
  ScriptedAuditor,
  type AuditAttemptV2Result,
} from "../../src/vnext/ralph-runtime/operational-e/index.js";
import type { AuditPackageV2 } from "../../src/vnext/ralph-runtime/operational-d/artifacts.js";
import {
  OPENCODE_AUDIT_DENIED_PROMPT_TOOLS_V2,
  OPENCODE_AUDIT_DENIED_TOOLS_V2,
  OPENCODE_CLI_AUDITOR_CORE_PROFILE_ID_V2,
  OPENCODE_AUDIT_PROTECTED_ROOTS_V2,
  OPENCODE_AUDIT_READ_TOOLS_V2,
  OpenCodeCliAuditorV2,
  RALPH_AUDIT_ENVELOPE_BEGIN_V2,
  RALPH_AUDIT_ENVELOPE_END_V2,
  assertReadOnlyAuditPermissionsV2,
  auditorRuntimeIdentityV2,
  createOpenCodeCliAuditorV2,
  isGenuineOpenCodeCliAuditorV2,
  openCodeAuditReadOnlyChildEnvironmentV2,
  openCodeAuditReadOnlyPermissionPolicyV2,
  projectAuditPackageToOpenCodePromptV2,
  readAuditProviderArtifactSetV2,
  readAuditProviderDescriptorV2,
  readAuditProviderPromptArtifactV2,
  readAuditProviderResultV2,
  readAuditProviderSessionBindingV2,
  readAuditProviderTerminalArtifactV2,
} from "../../src/vnext/ralph-runtime/operational-m4d/index.js";
import { openCodeM4BChildEnvironment } from "../../src/vnext/ralph-runtime/operational-b4/opencode-cli-process.js";
import { createWorkspacePolicy, fingerprintWorkspace } from "../../src/vnext/ralph-runtime/fingerprint.js";
import { sha256, sha256Canonical } from "../../src/vnext/ralph-runtime/hashing.js";

const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PROFILE = "opencode:cli:opencode-go/deepseek-v4-pro";
const MODEL = "opencode-go/deepseek-v4-pro";
const OWNER: ProcessIdentity = { pid: 58311, processStartIdentity: "m4d-start", hostIdentity: "m4d-host", bootSessionIdentity: "m4d-boot" };
const IDENTITY_PROVIDER: ProcessIdentityProvider = { current: () => OWNER, inspect: () => "MATCH" };
const ATTEMPT_ONE = "attempt-m4d-001";
const ATTEMPT_TWO = "attempt-m4d-002";
const CRITERIA = ["src/status.js exports exactly ready", "src/status.js exports no other symbol"] as const;

let ordinal = 0;

function envelopeText(value: FakeEnvelope, options: { readonly prose?: string; readonly duplicated?: boolean } = {}): string {
  const block = `${RALPH_AUDIT_ENVELOPE_BEGIN_V2}\n${JSON.stringify(value)}\n${RALPH_AUDIT_ENVELOPE_END_V2}`;
  const prose = options.prose ?? "I inspected the workspace and reached a verdict.";
  return options.duplicated ? `${prose}\n${block}\n${block}` : `${prose}\n${block}`;
}

function acceptEnvelope(resolvedFindingRefs: readonly string[] = []): string {
  return envelopeText({ verdict: "ACCEPT", proposedFindings: [], resolvedFindingRefs: [...resolvedFindingRefs], rationale: "Every acceptance criterion is satisfied by the workspace." });
}

function rejectEnvelope(overrides: Record<string, unknown> = {}): string {
  return envelopeText({
    verdict: "REJECT",
    proposedFindings: [{
      criterionId: "criterion:1",
      structuredFindingKey: "status-export-mismatch",
      severity: "BLOCKER",
      scope: ["src/status.js"],
      expectation: "src/status.js must export ready",
      observed: "src/status.js exports broken",
      remediationHint: "Export the required value.",
      ...overrides,
    }],
    resolvedFindingRefs: [],
    rationale: "The workspace does not satisfy the first acceptance criterion.",
  });
}

function descriptorRef(schemaVersion: string, descriptorId: string, descriptorDigest?: string) {
  const base = { schemaVersion, descriptorId };
  return { ...base, descriptorDigest: descriptorDigest ?? sha256Canonical(base) };
}

function task(validation: readonly string[]): Task {
  return {
    id: "T001", title: "Create the status module", done: false, scope: "src", change: "create src/status.js", covers: "src",
    dependsOn: [], parallelSafe: false, acceptanceCriteria: [...CRITERIA], validation: [...validation],
    expectedEvidence: "a real src/status.js workspace delta", line: 1,
  };
}

function plan(validation: readonly string[]): ExecutionDocument {
  const phase: Phase = { number: 1, id: "P01", title: "M4-D", goal: "prove the real Auditor", dependsOn: [], context: ["disposable fixture"], tasks: [task(validation)], line: 1 };
  return { contract: "rb-execution/v1", artifactId: "plan-m4d", title: "M4-D", phases: [phase] };
}

function event<TType extends RalphEventTypeV2>(
  state: RalphRuntimeStateV2,
  eventType: TType,
  payload: EventPayloadMapV2[TType],
  context: { readonly phaseId?: string; readonly taskId?: string; readonly attemptId?: string } = {},
): RalphEventV2 {
  const entityKind = eventType === "run.created" || eventType === "run.started" || eventType === "run.completed"
    ? "run"
    : eventType === "task.state-changed" ? "task" : eventType === "workspace.checkpointed" ? "workspace" : "attempt";
  const entity: RuntimeEntityRef = entityKind === "run" ? { kind: "run", id: state.runId }
    : entityKind === "workspace" ? { kind: "workspace", id: `${state.runId}:workspace` }
      : entityKind === "task" ? { kind: "task", id: context.taskId ?? "T001" }
        : { kind: "attempt", id: context.attemptId ?? ATTEMPT_ONE };
  const now = "2026-09-06T07:00:00.000Z";
  return createRalphEventV2({
    eventId: `m4d-event-${state.lastSequence + 1}-${eventType}`, eventType, schemaVersion: EVENT_SCHEMA_V2, runId: state.runId,
    sequence: state.lastSequence + 1, occurredAt: now, recordedAt: now, entity,
    ...(entityKind === "attempt" ? { phaseId: context.phaseId ?? "P01", taskId: context.taskId ?? "T001", attemptId: context.attemptId ?? ATTEMPT_ONE }
      : entityKind === "task" ? { phaseId: context.phaseId ?? "P01", taskId: context.taskId ?? "T001" } : {}),
    actor: "CORE", causationId: null, correlationId: `${state.runId}:m4d`, payload, previousEventHash: state.lastEventHash,
  } as UnsignedRalphEventV2<TType>) as RalphEventV2;
}

interface Fixture {
  readonly root: string;
  readonly runId: string;
  readonly store: RalphEventStoreV2;
  readonly document: ExecutionDocument;
  readonly leaseOptions: LeaseRuntimeInputV2;
  readonly observation: import("../../src/vnext/ralph-runtime/operational-b4/execution-observation.js").TrustedExecutorObservationV2;
  readonly state: RalphRuntimeStateV2;
  readonly timeoutPolicy: M4BTimeoutPolicyV2;
  readonly authorizedInvocation: AuthorizedInvocationV2;
}

async function fixture(validation: readonly string[] = ["`true`"], content = 'module.exports = "ready";\n'): Promise<Fixture> {
  const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-m4d-"));
  transport.projectRoot = root;
  const document = plan(validation);
  const runId = `run-m4d-${++ordinal}`;
  const policy = createWorkspacePolicy();
  const initialFingerprint = await fingerprintWorkspace(root, policy);
  const timeoutPolicy = createM4BTimeoutPolicyV2(5_000);
  const retryPolicy = createRetryPolicyV1({ runId, policyId: "m4d-retry", maxTaskAttemptsPerTask: 4, validationInfrastructureRetryLimit: 1 });
  const config = descriptorRef("rb-ralph-config/v2", "m4d-config");
  const snapshot: RunSnapshotV2 = {
    snapshotSchemaVersion: RALPH_RUN_SNAPSHOT_V2_SCHEMA, runId, eventSchema: EVENT_SCHEMA_V2, stateSchema: STATE_SCHEMA_V2,
    operationalContract: OPERATIONAL_CONTRACT_V2, projectIdentity: { projectId: "m4d-project" },
    readyPlanIdentity: document.artifactId, readyPlanHash: sha256Canonical(document), readyManifestHash: sha256("m4d-manifest"),
    selectedReadyArtifactHashes: { plan: sha256Canonical(document) }, readinessInspectionDigest: sha256("m4d-readiness"),
    effectiveRunConfig: config, effectiveConfigDigest: config.descriptorDigest,
    diagnosticsPolicy: descriptorRef("rb-ralph-diagnostics/v2", "m4d-diagnostics"),
    environmentPolicy: descriptorRef("rb-ralph-environment/v2", "m4d-environment"),
    executorProfile: { profileId: PROFILE, kind: "scripted", descriptorDigest: sha256("m4d-profile") },
    executorCapabilities: { requested: ["fixture.effect"], granted: ["fixture.effect"], verified: ["fixture.effect"], readOnlyEnforced: false },
    permissionCapabilityPolicy: descriptorRef("rb-ralph-capabilities/v2", "m4d-capabilities"),
    workspacePolicy: policy,
    initialWorkspaceFingerprint: {
      controlPlaneFingerprint: initialFingerprint.controlPlaneFingerprint, productWorkspaceFingerprint: initialFingerprint.productWorkspaceFingerprint,
      policyDigest: initialFingerprint.policyDigest, fingerprintDigest: initialFingerprint.fingerprintDigest,
    },
    retryPolicies: retryPolicyDescriptorV1(retryPolicy),
    timeoutPolicy: descriptorRef("rb-ralph-timeout/v2", "m4d-timeout", timeoutPolicy.policyDigest),
    runtimeIdentity: descriptorRef("rb-ralph-runtime/v2", "m4d-runtime"), leasePolicy: descriptorRef("rb-ralph-lease/v2", "m4d-lease"),
    createdAt: "2026-09-06T07:00:00.000Z",
  };
  const store = new RalphEventStoreV2({ projectRoot: root, runId });
  const genesis = createInitialRuntimeStateV2({
    runId, maxTaskAttemptsPerTask: 4,
    phases: document.phases.map((phase) => ({ phaseId: phase.id, taskIds: phase.tasks.map((candidate) => candidate.id) })),
    tasks: document.phases.flatMap((phase) => phase.tasks.map((candidate) => ({ taskId: candidate.id, phaseId: phase.id, dependsOn: candidate.dependsOn }))),
  });
  const initialized = await initializeOperationalRunV2({
    store, snapshot, retryPolicy, genesisState: genesis,
    runCreatedEvent: event(genesis, "run.created", { phaseIds: genesis.phaseIds, taskIds: genesis.taskIds }),
    createdAt: "2026-09-06T07:00:00.000Z", nonce: `m4d-init-${ordinal}`,
  });
  let state = (await commitRalphEventV2({ store, state: initialized.state, event: event(initialized.state, "run.started", {}), writtenAt: "2026-09-06T07:00:01.000Z", nonce: `m4d-start-${ordinal}` })).state;
  state = (await commitRalphEventV2({ store, state, event: event(state, "task.state-changed", { disposition: "READY", activity: "IDLE", owner: "NONE", hold: "NONE" }, { phaseId: "P01", taskId: "T001" }), writtenAt: "2026-09-06T07:00:02.000Z", nonce: `m4d-ready-${ordinal}` })).state;
  const leaseOptions: LeaseRuntimeInputV2 = { projectRoot: root, runId, genesisState: genesis, processIdentityProvider: IDENTITY_PROVIDER };
  const admitted = await prepareNextAuthorizedInvocationV2({
    leasedRun: await acquireLeasedRunV2(leaseOptions), plan: document, attemptIdFactory: () => ATTEMPT_ONE,
    nonceFactory: () => `m4d-${++ordinal}`, eventIdFactory: () => `m4d-event-${++ordinal}`, clock: () => "2026-09-06T07:00:03.000Z",
  });
  if (admitted.kind !== "AUTHORIZED_NOT_INVOKED") throw new Error(`M4-D fixture admission failed: ${admitted.kind}`);
  const executorLease = await acquireLeasedRunV2(leaseOptions);
  const executed = await executeAuthorizedInvocationV2({
    leasedRun: executorLease, plan: document,
    runtime: new ScriptedExecutor({
      clock: () => "2026-09-06T07:00:04.000Z",
      defaultScenario: {
        kind: "SUCCESS",
        fixtureWorkspaceAction: async () => {
          await import("node:fs/promises").then((fs) => fs.mkdir(join(root, "src"), { recursive: true }));
          await writeFile(join(root, "src", "status.js"), content);
        },
      },
    }),
    nonceFactory: () => `m4d-${++ordinal}`, eventIdFactory: () => `m4d-event-${++ordinal}`,
  });
  if (executed.kind !== "EXECUTOR_FINISHED_READY_FOR_CAPTURE") throw new Error(`M4-D fixture execution failed: ${executed.kind}`);
  const captured = await captureEvidenceV2({
    leasedRun: executorLease, plan: document, observation: executed.observation,
    nonceFactory: () => `m4d-${++ordinal}`, eventIdFactory: () => `m4d-event-${++ordinal}`, clock: () => "2026-09-06T07:00:05.000Z",
  });
  if (captured.kind !== "EVIDENCE_CAPTURED_READY_FOR_VALIDATION") throw new Error(`M4-D fixture evidence failed: ${captured.kind}`);
  const validated = await validateAttemptV2({
    leasedRun: await acquireLeasedRunV2(leaseOptions), plan: document, executorObservation: executed.observation,
    nonceFactory: () => `m4d-${++ordinal}`, eventIdFactory: () => `m4d-event-${++ordinal}`, clock: () => "2026-09-06T07:00:06.000Z",
  });
  if (validated.kind !== "VALIDATION_READY_FOR_AUDIT") throw new Error(`M4-D fixture validation failed: ${validated.kind}`);
  return { root, runId, store, document, leaseOptions, observation: executed.observation, state: validated.state, timeoutPolicy, authorizedInvocation: admitted.authorizedInvocation };
}

async function withFixture(action: (value: Fixture) => Promise<void>, validation?: readonly string[], content?: string): Promise<void> {
  const value = await fixture(validation, content);
  try { await action(value); }
  finally { await rm(value.root, { recursive: true, force: true }); }
}

async function auditorFor(value: Fixture): Promise<OpenCodeCliAuditorV2> {
  return createOpenCodeCliAuditorV2({
    store: new RalphEventStoreV2({ projectRoot: value.root, runId: value.runId }),
    timeoutPolicy: value.timeoutPolicy,
    clock: () => "2026-09-06T07:10:01.000Z",
    nonceFactory: () => `m4d-audit-${++ordinal}`,
  });
}

async function runCoreAudit(value: Fixture, auditor: OpenCodeCliAuditorV2 | ScriptedAuditor, attemptId = ATTEMPT_ONE): Promise<AuditAttemptV2Result> {
  return auditAttemptV2({
    leasedRun: await acquireLeasedRunV2(value.leaseOptions), plan: value.document, auditor, attemptId,
    executorObservation: value.observation, nonceFactory: () => `m4d-${++ordinal}`,
    eventIdFactory: () => `m4d-event-${++ordinal}`, clock: () => "2026-09-06T07:10:02.000Z",
  });
}

/**
 * Persist the frozen Core audit invocation authority and the durable
 * `audit.started` fact exactly the way the E boundary does, so the physical
 * Auditor can be driven directly for the fresh-runtime boundary matrix.
 */
async function beginCoreAudit(
  value: Fixture,
  auditor: { readonly runtimeIdentity: string; readonly profileId: string; readonly profileDigest: string },
  attemptId = ATTEMPT_ONE,
): Promise<AuditPackageV2> {
  const store = new RalphEventStoreV2({ projectRoot: value.root, runId: value.runId });
  const auditPackage = await readAuditPackageV2(store, attemptId);
  if (!auditPackage) throw new Error("M4-D fixture has no durable AuditPackage");
  const attempt = value.state.attempts[attemptId];
  if (!attempt?.auditPackage) throw new Error("M4-D fixture Attempt carries no AuditPackage binding");
  const descriptor = createAuditInvocationDescriptorV2({
    runId: value.runId, phaseId: attempt.phaseId, taskId: attempt.taskId, attemptId,
    auditPackageId: attempt.auditPackage.auditPackageId, auditPackageDigest: auditPackage.packageDigest,
    auditorIdentity: auditor.runtimeIdentity, auditorProfileId: auditor.profileId, auditorProfileDigest: auditor.profileDigest,
    startedAt: "2026-09-06T07:09:00.000Z",
  });
  await persistAuditInvocationDescriptorV2(store, descriptor, `m4d-core-audit-${++ordinal}`);
  await commitRalphEventV2({
    store, state: value.state,
    event: event(value.state, "audit.started", {
      auditPackageId: attempt.auditPackage.auditPackageId, auditPackageDigest: auditPackage.packageDigest, startedAt: descriptor.startedAt,
    }, { phaseId: attempt.phaseId, taskId: attempt.taskId, attemptId }),
    writtenAt: "2026-09-06T07:09:01.000Z", nonce: `m4d-core-audit-event-${++ordinal}`,
  });
  return auditPackage;
}

function expectAudit<TKind extends AuditAttemptV2Result["kind"]>(result: AuditAttemptV2Result, kind: TKind): Extract<AuditAttemptV2Result, { readonly kind: TKind }> {
  expect(result.kind).toBe(kind);
  if (result.kind !== kind) throw new Error(`M4-D expected ${kind} but Core returned ${result.kind}`);
  return result as Extract<AuditAttemptV2Result, { readonly kind: TKind }>;
}

function attemptArtifactPath(value: Fixture, attemptId: string, name: string): string {
  return join(value.root, ".rb-harness", "ralph", "runs", value.runId, "attempts", attemptId, name);
}

async function removeArtifacts(value: Fixture, attemptId: string, names: readonly string[]): Promise<void> {
  for (const name of names) await unlink(attemptArtifactPath(value, attemptId, name)).catch(() => undefined);
}

const AFTER_DESCRIPTOR = ["audit-provider-dispatch-intent.json", "audit-provider-worker-started.json", "audit-provider-session-binding.json", "audit-provider-prompt.json", "audit-provider-result.json", "audit-provider-terminal.json"] as const;

beforeEach(() => {
  transport.promptCalls = 0;
  transport.sessionCreates = 0;
  transport.serverStarts = 0;
  transport.sanitizedReads = 0;
  transport.workerStarts = 0;
  transport.promptSawDurableChain = false;
  transport.workerEnvironments = [];
  transport.sessionPermissions = [];
  transport.promptTools = [];
  transport.sessionTitles = [];
  transport.createdSessions = [];
  transport.sanitizedEnvironments = [];
  transport.forcedSessionId = null;
  transport.responseText = acceptEnvelope();
  transport.responseModel = null;
  transport.responseClassification = "SUCCEEDED";
  transport.observationMismatch = false;
  transport.workspaceMutation = null;
  transport.settlementObserved = true;
  transport.settlementQuiescent = true;
  transport.settlementVerified = true;
  vi.restoreAllMocks();
});

describe("Ralph M4-D — nominal OpenCode CLI Auditor trust root and independent role", () => {
  it("M4D-1: extends the Auditor trust root only with a genuine sealed OpenCodeCliAuditorV2", async () => {
    await withFixture(async (value) => {
      const auditor = await auditorFor(value);
      expect(isGenuineOpenCodeCliAuditorV2(auditor)).toBe(true);
      expect(isTrustedAuditorRuntimeV2(auditor)).toBe(true);
      expect(isTrustedAuditorRuntimeV2(new ScriptedAuditor())).toBe(true);
      expect(isTrustedAuditorRuntimeV2({ kind: "AUDITOR_RUNTIME", runtimeIdentity: auditor.runtimeIdentity, profileId: auditor.profileId, profileDigest: auditor.profileDigest, invoke: auditor.invoke.bind(auditor) })).toBe(false);
      expect(isTrustedAuditorRuntimeV2(JSON.parse(JSON.stringify({ kind: auditor.kind, runtimeIdentity: auditor.runtimeIdentity })))).toBe(false);
      expect(isTrustedAuditorRuntimeV2(structuredClone({ kind: auditor.kind, runtimeIdentity: auditor.runtimeIdentity }))).toBe(false);
      expect(isTrustedAuditorRuntimeV2(Object.create(Object.getPrototypeOf(auditor)))).toBe(false);
      expect(isTrustedAuditorRuntimeV2(new Proxy(auditor, {}))).toBe(false);
      expect(() => Reflect.construct(OpenCodeCliAuditorV2, [{}, Symbol("fake")])).toThrow("M4D_AUDITOR_AUTHORITY_REQUIRED");
      expect(() => Reflect.construct(OpenCodeCliAuditorV2, [{}, Symbol("fake")], class extends OpenCodeCliAuditorV2 {})).toThrow("M4D_AUDITOR_AUTHORITY_REQUIRED");
      expect(Object.isFrozen(auditor)).toBe(true);
      expect(transport.promptCalls).toBe(0);
    });
  });

  it("exposes no generic auditor registration surface and keeps ScriptedAuditor semantics unchanged", async () => {
    const runtimeDirectory = resolve(TEST_DIRECTORY, "../../src/vnext/ralph-runtime");
    const sources = await Promise.all([
      join(runtimeDirectory, "operational-e", "auditor-runtime.ts"),
      join(runtimeDirectory, "operational-e", "auditor-trust.ts"),
      join(runtimeDirectory, "operational-e", "index.ts"),
      join(runtimeDirectory, "operational-m4d", "cli-auditor-runtime.ts"),
      join(runtimeDirectory, "operational-m4d", "index.ts"),
    ].map((path) => readFile(path, "utf8")));
    const combined = sources.join("\n");
    expect(combined).not.toMatch(/export\s+(?:async\s+)?(?:function|const|let|var|class)\s+(?:trustAuditor|registerAuditor|wrapAuditor|addTrustedAuditor)\b/);
    const auditorTrust = await import("../../src/vnext/ralph-runtime/operational-e/auditor-trust.js");
    const m4dSurface = await import("../../src/vnext/ralph-runtime/operational-m4d/index.js");
    for (const exported of [...Object.keys(auditorTrust), ...Object.keys(m4dSurface)]) {
      expect(exported).not.toMatch(/^(?:trust|register|wrap|add)[A-Z]/);
    }
    const scripted = new ScriptedAuditor({ defaultDecision: { verdict: "REJECT", rationale: "unchanged" } });
    expect(scripted.profileId).toBe("scripted-auditor-default-v1");
    expect(scripted.runtimeIdentity).toBe("scripted-auditor-v2");
    expect(scripted.totalInvocations).toBe(0);
  });

  it("mints an Auditor runtime identity that can never equal an Executor runtime identity", async () => {
    await withFixture(async (value) => {
      const auditor = await auditorFor(value);
      expect(auditor.runtimeIdentity).toMatch(/^opencode-cli-auditor-runtime-[0-9a-f]{64}$/);
      expect(auditor.profileId).toBe(OPENCODE_CLI_AUDITOR_CORE_PROFILE_ID_V2);
      expect(auditor.profileId).not.toContain("/");
      const executableIdentity = sha256Canonical({ transport: "opencode-cli", executablePath: "/home/bruno/.opencode/bin/opencode", executableVersion: "1.18.29" });
      const executorIdentity = `opencode-cli-runtime-${sha256Canonical({ openCodeExecutableIdentity: executableIdentity, executorProfileIdentity: PROFILE, executorProfileDigest: sha256("anything"), modelSelector: MODEL }).slice("sha256:".length)}`;
      expect(auditor.runtimeIdentity).not.toBe(executorIdentity);
      expect(auditor.runtimeIdentity).toBe(auditorRuntimeIdentityV2({ openCodeExecutableIdentity: executableIdentity, profileDigest: auditor.profileDigest }));
      // A different read-only permission policy is a different Auditor identity.
      const widened = { ...openCodeAuditReadOnlyPermissionPolicyV2(), policyDigest: sha256("widened-policy") };
      expect(auditorRuntimeIdentityV2({ openCodeExecutableIdentity: executableIdentity, profileDigest: sha256Canonical({ widened: widened.policyDigest }) })).not.toBe(auditor.runtimeIdentity);
    });
  });
});

describe("Ralph M4-D — physically read-only Auditor", () => {
  it("M4D-2: denies every mutating OpenCode capability in the environment, the session and the prompt", async () => {
    const policy = openCodeAuditReadOnlyPermissionPolicyV2();
    for (const tool of OPENCODE_AUDIT_DENIED_TOOLS_V2) {
      expect(policy.environmentPermission[tool]).toBe("deny");
      expect(policy.sessionPermission.some((rule) => rule.permission === tool && rule.pattern === "*" && rule.action === "deny")).toBe(true);
      for (const root of OPENCODE_AUDIT_PROTECTED_ROOTS_V2) {
        expect(policy.sessionPermission.some((rule) => rule.permission === tool && rule.pattern === `${root}/**` && rule.action === "deny")).toBe(true);
      }
    }
    for (const tool of OPENCODE_AUDIT_DENIED_PROMPT_TOOLS_V2) expect(policy.promptTools[tool]).toBe(false);
    // Only vocabularies the frozen, conformance-proven M4-B transport already
    // sends to OpenCode 1.18.29 are used.
    expect(Object.keys(policy.promptTools).sort()).toEqual(["apply_patch", "bash", "edit", "glob", "grep", "list", "read", "task", "webfetch", "websearch", "write"]);
    expect(Object.keys(policy.environmentPermission).sort()).toEqual(["bash", "codesearch", "edit", "external_directory", "glob", "grep", "list", "patch", "read", "task", "webfetch", "websearch", "write"]);
    for (const tool of OPENCODE_AUDIT_READ_TOOLS_V2) {
      expect(policy.environmentPermission[tool]).toBe("allow");
      expect(policy.promptTools[tool]).toBe(true);
    }
    expect(policy.sessionPermission.every((rule) => rule.action === "allow" ? (OPENCODE_AUDIT_READ_TOOLS_V2 as readonly string[]).includes(String(rule.permission)) : true)).toBe(true);
    const environment = openCodeAuditReadOnlyChildEnvironmentV2(openCodeM4BChildEnvironment(), policy);
    const permission = JSON.parse(String(environment.OPENCODE_CONFIG_CONTENT)).permission as Record<string, string>;
    for (const tool of OPENCODE_AUDIT_DENIED_TOOLS_V2) expect(permission[tool]).toBe("deny");
    expect(permission.read).toBe("allow");
  });

  it("M4D-2: rejects any widened permission policy before a prompt exists", () => {
    const policy = openCodeAuditReadOnlyPermissionPolicyV2();
    for (const tool of ["edit", "write", "patch", "bash"] as const) {
      expect(() => assertReadOnlyAuditPermissionsV2({ ...policy, environmentPermission: { ...policy.environmentPermission, [tool]: "allow" } })).toThrow("M4D_PERMISSIONS_NOT_READ_ONLY");
      expect(() => assertReadOnlyAuditPermissionsV2({ ...policy, promptTools: { ...policy.promptTools, [tool]: true } })).toThrow("M4D_PERMISSIONS_NOT_READ_ONLY");
      expect(() => assertReadOnlyAuditPermissionsV2({ ...policy, sessionPermission: [...policy.sessionPermission, { permission: tool, pattern: "*", action: "allow" }] })).toThrow("M4D_PERMISSIONS_NOT_READ_ONLY");
      expect(() => assertReadOnlyAuditPermissionsV2({ ...policy, sessionPermission: policy.sessionPermission.filter((rule) => !(rule.permission === tool && rule.pattern === "*")) })).toThrow("M4D_PERMISSIONS_NOT_READ_ONLY");
    }
  });

  it("M4D-2: physically dispatches the read-only policy on every transport surface", async () => {
    await withFixture(async (value) => {
      const auditor = await auditorFor(value);
      const result = expectAudit(await runCoreAudit(value, auditor), "AUDIT_ACCEPTED");
      expect(result.attempt.closureReason).toBe("AUDIT_ACCEPTED");
      expect(transport.workerStarts).toBe(1);
      const environment = transport.workerEnvironments[0]!;
      const permission = JSON.parse(String(environment.OPENCODE_CONFIG_CONTENT)).permission as Record<string, string>;
      for (const tool of OPENCODE_AUDIT_DENIED_TOOLS_V2) expect(permission[tool]).toBe("deny");
      for (const tool of OPENCODE_AUDIT_DENIED_PROMPT_TOOLS_V2) expect((transport.promptTools[0] as Record<string, boolean>)[tool]).toBe(false);
      expect(transport.sessionPermissions[0]).toEqual(openCodeAuditReadOnlyPermissionPolicyV2().sessionPermission);
      expect(transport.promptTools[0]).toEqual(openCodeAuditReadOnlyPermissionPolicyV2().promptTools);
      const sanitizedPermission = JSON.parse(String(transport.sanitizedEnvironments[0]?.OPENCODE_CONFIG_CONTENT)).permission as Record<string, string>;
      expect(sanitizedPermission.write).toBe("deny");
    });
  });

  it("M4D-3: fails closed when the Auditor mutates the workspace it audits", async () => {
    await withFixture(async (value) => {
      transport.workspaceMutation = { path: "audit-side-effect.txt", content: "written by the auditor\n" };
      const auditor = await auditorFor(value);
      await expect(runCoreAudit(value, auditor)).rejects.toMatchObject({ code: "E_AUDITOR_RESULT_INVALID" });
      const store = new RalphEventStoreV2({ projectRoot: value.root, runId: value.runId });
      expect(await readAuditResultV2(store, ATTEMPT_ONE)).toBeUndefined();
      expect(await readAuditProviderTerminalArtifactV2(store, ATTEMPT_ONE)).toBeUndefined();
      const events = (await store.inspect()).events;
      expect(events.filter((candidate) => candidate.eventType === "attempt.closed")).toHaveLength(0);
      expect(events.filter((candidate) => candidate.eventType === "finding.state-changed")).toHaveLength(0);
      // The mutation itself is real; the audit is what fails closed.
      expect(await readFile(join(value.root, "audit-side-effect.txt"), "utf8")).toContain("written by the auditor");
    });
  });

  it("M4D-3: a durable audit terminal can never record a mutated workspace", async () => {
    await withFixture(async (value) => {
      const auditor = await auditorFor(value);
      await runCoreAudit(value, auditor);
      const store = new RalphEventStoreV2({ projectRoot: value.root, runId: value.runId });
      const terminal = await readAuditProviderTerminalArtifactV2(store, ATTEMPT_ONE);
      expect(terminal?.workspaceFingerprintBefore).toBe(terminal?.workspaceFingerprintAfter);
      const descriptor = await readAuditProviderDescriptorV2(store, ATTEMPT_ONE);
      const auditPackage = await readAuditPackageV2(store, ATTEMPT_ONE);
      expect(terminal?.workspaceFingerprintBefore).toBe(auditPackage?.workspaceFingerprint);
      expect(descriptor?.baseWorkspaceFingerprint).toBe(auditPackage?.workspaceFingerprint);
    });
  });
});

describe("Ralph M4-D — durable audit invocation protocol", () => {
  it("binds one dedicated empty session behind the complete durable dispatch chain", async () => {
    await withFixture(async (value) => {
      const auditor = await auditorFor(value);
      const result = expectAudit(await runCoreAudit(value, auditor), "AUDIT_ACCEPTED");
      expect(result.attempt.closureReason).toBe("AUDIT_ACCEPTED");
      expect(transport).toMatchObject({ promptCalls: 1, sessionCreates: 1, serverStarts: 1, sanitizedReads: 1, workerStarts: 1, promptSawDurableChain: true });
      const store = new RalphEventStoreV2({ projectRoot: value.root, runId: value.runId });
      const facts = await readAuditProviderArtifactSetV2(store, ATTEMPT_ONE);
      const core = await readAuditInvocationDescriptorV2(store, ATTEMPT_ONE);
      expect(facts.descriptor).toMatchObject({ role: "AUDITOR", transport: "opencode-cli", conformanceState: "MATCH", modelSelector: MODEL, auditorProfileIdentity: PROFILE, auditorProfileId: OPENCODE_CLI_AUDITOR_CORE_PROFILE_ID_V2, conformanceProfileId: PROFILE });
      expect(facts.descriptor?.auditInvocationId).toBe(core?.auditInvocationId);
      expect(facts.descriptor?.auditorRuntimeIdentity).toBe(auditor.runtimeIdentity);
      expect(facts.dispatchIntent?.dispatchId).toMatch(/^audit-dispatch-[0-9a-f]{64}$/);
      expect(facts.dispatchIntent?.openCodeUserMessageId).toMatch(/^msg_ralph_audit_[0-9a-f]{32}$/);
      expect(facts.sessionBinding?.openCodeSessionId).toBe(transport.createdSessions[0]);
      expect(facts.prompt?.openCodeSessionId).toBe(facts.sessionBinding?.openCodeSessionId);
      expect(facts.result?.classification).toBe("SUCCEEDED");
      expect(facts.terminal?.quiescence).toMatchObject({ workerProcessState: "ABSENT", processTreeState: "QUIESCENT" });
      expect(auditor.physicalDispatches).toBe(1);
    });
  });

  it("reconstructs the dispatched audit prompt byte for byte from the durable AuditPackage alone", async () => {
    await withFixture(async (value) => {
      const auditor = await auditorFor(value);
      await runCoreAudit(value, auditor);
      const store = new RalphEventStoreV2({ projectRoot: value.root, runId: value.runId });
      const auditPackage = await readAuditPackageV2(store, ATTEMPT_ONE);
      const prompt = await readAuditProviderPromptArtifactV2(store, ATTEMPT_ONE);
      const projected = projectAuditPackageToOpenCodePromptV2(auditPackage!);
      expect(prompt?.promptDigest).toBe(projected.promptDigest);
      expect(prompt?.promptBytes).toBe(projected.byteLength);
      for (const token of [auditPackage!.packageDigest, "criterion:1", "criterion:2", CRITERIA[0], "Deterministic red can never be overridden", "physically read-only", "Finding identities are not yours to choose", RALPH_AUDIT_ENVELOPE_BEGIN_V2]) {
        expect(projected.text).toContain(token);
      }
      expect(projected.text).not.toContain(value.root);
    });
  });

  it("M4D-4: refuses a dispatch whose durable session binding is missing", async () => {
    await withFixture(async (value) => {
      const auditor = await auditorFor(value);
      await beginCoreAudit(value, auditor);
      const auditPackage = await readAuditPackageV2(new RalphEventStoreV2({ projectRoot: value.root, runId: value.runId }), ATTEMPT_ONE);
      await auditor.invoke(auditPackage!);
      expect(transport.promptSawDurableChain).toBe(true);
      await removeArtifacts(value, ATTEMPT_ONE, ["audit-provider-session-binding.json", "audit-provider-prompt.json", "audit-provider-result.json", "audit-provider-terminal.json"]);
      const fresh = await auditorFor(value);
      await expect(fresh.invoke(auditPackage!)).rejects.toMatchObject({ m4dCode: "M4D_REDISPATCH_FORBIDDEN" });
      expect(transport.promptCalls).toBe(1);
    });
  });

  it("M4D-5: never redispatches after an ambiguous physical audit state", async () => {
    await withFixture(async (value) => {
      const auditor = await auditorFor(value);
      const auditPackage = await beginCoreAudit(value, auditor);
      await auditor.invoke(auditPackage);
      for (const removal of [
        ["audit-provider-terminal.json"],
        ["audit-provider-terminal.json", "audit-provider-result.json"],
        ["audit-provider-terminal.json", "audit-provider-result.json", "audit-provider-prompt.json"],
      ] as const) {
        await removeArtifacts(value, ATTEMPT_ONE, removal);
        const fresh = await auditorFor(value);
        await expect(fresh.invoke(auditPackage)).rejects.toMatchObject({ m4dCode: "M4D_REDISPATCH_FORBIDDEN" });
      }
      expect(transport.promptCalls).toBe(1);
    });
  });

  it("M4D-6: refuses a tampered AuditPackage before any physical audit state exists", async () => {
    await withFixture(async (value) => {
      const auditor = await auditorFor(value);
      const auditPackage = await beginCoreAudit(value, auditor);
      const foreign = { ...auditPackage, packageDigest: sha256("foreign-audit-package") } as AuditPackageV2;
      await expect(auditor.invoke(foreign)).rejects.toMatchObject({ m4dCode: "M4D_AUDIT_PACKAGE_INVALID" });
      const tampered = { ...auditPackage, relevantContext: ["tampered"] } as AuditPackageV2;
      await expect(auditor.invoke(tampered)).rejects.toMatchObject({ m4dCode: "M4D_AUDIT_PACKAGE_INVALID" });
      expect(transport.promptCalls).toBe(0);
      const store = new RalphEventStoreV2({ projectRoot: value.root, runId: value.runId });
      expect(await readAuditProviderDescriptorV2(store, ATTEMPT_ONE)).toBeUndefined();
    });
  });

  it("M4D-6: refuses a Core audit invocation minted for a different Auditor identity", async () => {
    await withFixture(async (value) => {
      const scripted = new ScriptedAuditor();
      const auditPackage = await beginCoreAudit(value, scripted);
      const auditor = await auditorFor(value);
      await expect(auditor.invoke(auditPackage)).rejects.toMatchObject({ m4dCode: "M4D_AUDIT_INVOCATION_BINDING_INVALID" });
      expect(transport.promptCalls).toBe(0);
      const store = new RalphEventStoreV2({ projectRoot: value.root, runId: value.runId });
      expect(await readAuditProviderDescriptorV2(store, ATTEMPT_ONE)).toBeUndefined();
      const core = await readAuditInvocationDescriptorV2(store, ATTEMPT_ONE);
      expect(core?.auditorIdentity).toBe(scripted.runtimeIdentity);
      expect(core?.auditorIdentity).not.toBe(auditor.runtimeIdentity);
    });
  });

  it("M4D-6: refuses to run without a durable Core audit invocation descriptor", async () => {
    await withFixture(async (value) => {
      const auditor = await auditorFor(value);
      const auditPackage = await readAuditPackageV2(new RalphEventStoreV2({ projectRoot: value.root, runId: value.runId }), ATTEMPT_ONE);
      await expect(auditor.invoke(auditPackage!)).rejects.toMatchObject({ m4dCode: "M4D_AUDIT_INVOCATION_REQUIRED" });
      expect(transport.promptCalls).toBe(0);
    });
  });

  it("M4D-12: refuses a provider result that is not positively quiescent", async () => {
    for (const arrange of [
      () => { transport.settlementObserved = false; },
      () => { transport.settlementQuiescent = false; },
      () => { transport.settlementVerified = false; },
    ]) {
      await withFixture(async (value) => {
        transport.promptCalls = 0;
        arrange();
        const auditor = await auditorFor(value);
        await expect(runCoreAudit(value, auditor)).rejects.toMatchObject({ code: "E_AUDITOR_RESULT_INVALID" });
        const store = new RalphEventStoreV2({ projectRoot: value.root, runId: value.runId });
        expect(await readAuditProviderTerminalArtifactV2(store, ATTEMPT_ONE)).toBeUndefined();
        expect(await readAuditResultV2(store, ATTEMPT_ONE)).toBeUndefined();
        expect((await store.inspect()).events.filter((candidate) => candidate.eventType === "attempt.closed")).toHaveLength(0);
      });
    }
  }, 120_000);

  it("refuses a live/sanitized observable turn identity mismatch", async () => {
    await withFixture(async (value) => {
      transport.observationMismatch = true;
      const auditor = await auditorFor(value);
      await expect(runCoreAudit(value, auditor)).rejects.toMatchObject({ code: "E_AUDITOR_RESULT_INVALID" });
      expect(await readAuditProviderResultV2(new RalphEventStoreV2({ projectRoot: value.root, runId: value.runId }), ATTEMPT_ONE)).toBeUndefined();
    });
  });

  it("refuses a foreign observed model", async () => {
    await withFixture(async (value) => {
      transport.responseModel = "opencode-go/foreign-model";
      const auditor = await auditorFor(value);
      await expect(runCoreAudit(value, auditor)).rejects.toMatchObject({ code: "E_AUDITOR_RESULT_INVALID" });
      expect(await readAuditProviderResultV2(new RalphEventStoreV2({ projectRoot: value.root, runId: value.runId }), ATTEMPT_ONE)).toBeUndefined();
    });
  });
});

describe("Ralph M4-D — one audit is one session", () => {
  it("M4D-10: refuses an OpenCode session already bound to an Executor invocation", async () => {
    await withFixture(async (value) => {
      const store = new RalphEventStoreV2({ projectRoot: value.root, runId: value.runId });
      const conformance = await loadExactConformanceRecordV2();
      const executable = {
        executablePath: "/home/bruno/.opencode/bin/opencode",
        executableVersion: "1.18.29",
        conformanceProfileId: PROFILE,
        conformanceRecordDigest: sha256Canonical(conformance),
        conformanceExecutableVersion: "1.18.29",
      } as const;
      const executorDescriptor = await createProviderInvocationDescriptorV2({ store, authorizedInvocation: value.authorizedInvocation, executable });
      expect(executorDescriptor.conformanceState).toBe("MATCH");
      await persistProviderInvocationDescriptorV2(store, executorDescriptor, `m4d-exec-descriptor-${++ordinal}`);
      const executorIntent = createProviderDispatchIntentV2(executorDescriptor, "2026-09-06T07:05:00.000Z");
      await persistProviderDispatchIntentV2(store, executorIntent, `m4d-exec-intent-${++ordinal}`);
      const executorWorker = createProviderWorkerReceiptV2({
        descriptor: executorDescriptor, dispatchIntent: executorIntent,
        processIdentity: { pid: 4_242, processStartIdentity: `sha256:${"c".repeat(64)}`, hostIdentity: "m4d-host", bootSessionIdentity: "m4d-boot" },
        processGroupId: 4_242, startedAt: "2026-09-06T07:05:01.000Z",
      });
      await persistProviderWorkerReceiptV2(store, executorWorker, `m4d-exec-worker-${++ordinal}`);
      const executorSessionId = "ses_m4dExecutorSession0001";
      const executorSession = createProviderSessionBindingV2({
        descriptor: executorDescriptor, dispatchIntent: executorIntent, workerReceipt: executorWorker,
        openCodeSessionId: executorSessionId, boundAt: "2026-09-06T07:05:02.000Z",
      });
      await persistProviderSessionBindingV2(store, executorSession, `m4d-exec-session-${++ordinal}`);

      transport.forcedSessionId = executorSessionId;
      const auditor = await auditorFor(value);
      await expect(runCoreAudit(value, auditor)).rejects.toMatchObject({ code: "E_AUDITOR_RESULT_INVALID" });
      expect(await readAuditProviderSessionBindingV2(store, ATTEMPT_ONE)).toBeUndefined();
      expect(await readAuditProviderResultV2(store, ATTEMPT_ONE)).toBeUndefined();
      expect(await readAuditResultV2(store, ATTEMPT_ONE)).toBeUndefined();
      expect(transport.promptCalls).toBe(0);
    });
  });

  it("M4D-11: refuses to reuse a previous audit session and binds a fresh session per audit", async () => {
    await withFixture(async (value) => {
      transport.responseText = rejectEnvelope();
      const firstAuditor = await auditorFor(value);
      const rejected = expectAudit(await runCoreAudit(value, firstAuditor), "AUDIT_REJECTED");
      expect(rejected.attempt.closureReason).toBe("AUDIT_REJECTED");
      const store = new RalphEventStoreV2({ projectRoot: value.root, runId: value.runId });
      const firstSession = (await readAuditProviderSessionBindingV2(store, ATTEMPT_ONE))!.openCodeSessionId;

      const second = await secondAttempt(value);
      transport.forcedSessionId = firstSession;
      const reusedAuditor = await auditorFor(second.fixture);
      await expect(runCoreAudit(second.fixture, reusedAuditor, ATTEMPT_TWO)).rejects.toMatchObject({ code: "E_AUDITOR_RESULT_INVALID" });
      expect(await readAuditProviderSessionBindingV2(store, ATTEMPT_TWO)).toBeUndefined();
      expect(transport.promptCalls).toBe(1);

      transport.forcedSessionId = null;
      await removeArtifacts(value, ATTEMPT_TWO, ["audit-provider-descriptor.json", ...AFTER_DESCRIPTOR]);
      const freshAuditor = await auditorFor(second.fixture);
      const again = expectAudit(await runCoreAudit(second.fixture, freshAuditor, ATTEMPT_TWO), "AUDIT_REJECTED");
      expect(again.attempt.attemptId).toBe(ATTEMPT_TWO);
      const secondSession = (await readAuditProviderSessionBindingV2(store, ATTEMPT_TWO))!.openCodeSessionId;
      expect(secondSession).not.toBe(firstSession);
      const firstInvocation = (await readAuditProviderDescriptorV2(store, ATTEMPT_ONE))!.auditInvocationId;
      const secondInvocation = (await readAuditProviderDescriptorV2(store, ATTEMPT_TWO))!.auditInvocationId;
      expect(secondInvocation).not.toBe(firstInvocation);
      expect(transport.promptCalls).toBe(2);
    }, ["`true`"], 'module.exports = "broken";\n');
  });
});

describe("Ralph M4-D — untrusted structured audit envelope", () => {
  const cases = [
    ["malformed JSON", () => { transport.responseText = `${RALPH_AUDIT_ENVELOPE_BEGIN_V2}\n{ not json }\n${RALPH_AUDIT_ENVELOPE_END_V2}`; }],
    ["no structured response", () => { transport.responseText = "I think this looks fine, ACCEPT."; }],
    ["two structured responses", () => { transport.responseText = envelopeText({ verdict: "ACCEPT", proposedFindings: [], resolvedFindingRefs: [], rationale: "ok" }, { duplicated: true }); }],
    ["unknown envelope field", () => { transport.responseText = envelopeText({ verdict: "ACCEPT", proposedFindings: [], resolvedFindingRefs: [], rationale: "ok", taskComplete: true }); }],
    ["provider-supplied Finding id", () => { transport.responseText = rejectEnvelope({ findingId: "finding-provider-chosen" }); }],
    ["foreign resolution reference", () => { transport.responseText = envelopeText({ verdict: "ACCEPT", proposedFindings: [], resolvedFindingRefs: ["finding-not-in-this-package"], rationale: "ok" }); }],
    ["foreign criterion reference", () => { transport.responseText = rejectEnvelope({ criterionId: "criterion:99" }); }],
    ["ACCEPT carrying proposed Findings", () => { transport.responseText = envelopeText({ verdict: "ACCEPT", proposedFindings: [{ criterionId: "criterion:1", structuredFindingKey: "k", severity: "LOW", scope: ["src"], expectation: "e", observed: "o" }], resolvedFindingRefs: [], rationale: "ok" }); }],
    ["REJECT carrying no proposed Finding", () => { transport.responseText = envelopeText({ verdict: "REJECT", proposedFindings: [], resolvedFindingRefs: [], rationale: "ok" }); }],
    ["oversized output", () => { transport.responseText = envelopeText({ verdict: "ACCEPT", proposedFindings: [], resolvedFindingRefs: [], rationale: "x".repeat(5_000) }); }],
    ["credential-like output", () => { transport.responseText = envelopeText({ verdict: "ACCEPT", proposedFindings: [], resolvedFindingRefs: [], rationale: "Authorization: Bearer sk-forbidden-material-abcdefghijklmnop" }); }],
    ["provider verdict outside the vocabulary", () => { transport.responseText = envelopeText({ verdict: "COMPLETE", proposedFindings: [], resolvedFindingRefs: [], rationale: "ok" }); }],
  ] as const;

  for (const [label, arrange] of cases) {
    it(`fails closed on ${label}`, async () => {
      await withFixture(async (value) => {
        arrange();
        const auditor = await auditorFor(value);
        await expect(runCoreAudit(value, auditor)).rejects.toMatchObject({ code: "E_AUDITOR_RESULT_INVALID" });
        const store = new RalphEventStoreV2({ projectRoot: value.root, runId: value.runId });
        expect(await readAuditResultV2(store, ATTEMPT_ONE)).toBeUndefined();
        expect(await readAuditProviderResultV2(store, ATTEMPT_ONE)).toBeUndefined();
        expect(await readAuditProviderTerminalArtifactV2(store, ATTEMPT_ONE)).toBeUndefined();
        const events = (await store.inspect()).events;
        expect(events.filter((candidate) => candidate.eventType === "attempt.closed")).toHaveLength(0);
        expect(events.filter((candidate) => candidate.eventType === "finding.state-changed")).toHaveLength(0);
      });
    });
  }

  it("accepts bounded prose around exactly one structured response", async () => {
    await withFixture(async (value) => {
      transport.responseText = envelopeText(
        { verdict: "ACCEPT", proposedFindings: [], resolvedFindingRefs: [], rationale: "The module exports the required value." },
        { prose: "Let me summarise. I read src/status.js and compared it to criterion:1 and criterion:2." },
      );
      const auditor = await auditorFor(value);
      const result = expectAudit(await runCoreAudit(value, auditor), "AUDIT_ACCEPTED");
      expect(result.auditResult.rationale).toBe("The module exports the required value.");
      expect(result.auditResult.metadata).toMatchObject({ role: "AUDITOR", transport: "opencode-cli", model: MODEL });
    });
  });
});

describe("Ralph M4-D — Core reconciliation keeps every semantic decision", () => {
  it("deterministic ACCEPT completes the Task and Run through the frozen reducer", async () => {
    await withFixture(async (value) => {
      const auditor = await auditorFor(value);
      const result = expectAudit(await runCoreAudit(value, auditor), "AUDIT_ACCEPTED");
      expect(result.attempt.closureReason).toBe("AUDIT_ACCEPTED");
      expect(result.state.tasks.T001?.disposition).toBe("COMPLETE");
      expect(result.state.disposition).toBe("COMPLETE");
      const store = new RalphEventStoreV2({ projectRoot: value.root, runId: value.runId });
      const auditResult = await readAuditResultV2(store, ATTEMPT_ONE);
      const providerResult = await readAuditProviderResultV2(store, ATTEMPT_ONE);
      expect(auditResult?.verdict).toBe("ACCEPT");
      expect(auditResult?.resultDigest).not.toBe(providerResult?.resultDigest);
      expect(auditResult?.metadata.providerResultDigest).toBe(providerResult?.resultDigest);
      expect(auditResult?.auditInvocationId).toBe(providerResult?.auditInvocationId);
    });
  });

  it("M4D-7: deterministic REJECT mints the Finding identity in Core, never in the provider", async () => {
    await withFixture(async (value) => {
      transport.responseText = rejectEnvelope();
      const auditor = await auditorFor(value);
      const result = expectAudit(await runCoreAudit(value, auditor), "AUDIT_REJECTED");
      expect(result.attempt.closureReason).toBe("AUDIT_REJECTED");
      expect(result.state.tasks.T001?.disposition).not.toBe("COMPLETE");
      const findings = Object.values(result.state.findings);
      expect(findings).toHaveLength(1);
      const finding = findings[0]!;
      expect(finding.status).toBe("OPEN");
      expect(finding.id).toBe(`finding-${sha256Canonical({ taskId: "T001", criterionId: "criterion:1", structuredFindingKey: "status-export-mismatch" }).slice("sha256:".length)}`);
      expect(finding.rootCauseGroup).toBe("audit:T001");
      const events = (await new RalphEventStoreV2({ projectRoot: value.root, runId: value.runId }).inspect()).events.map((candidate) => candidate.eventType);
      expect(events.indexOf("audit.started")).toBeLessThan(events.indexOf("finding.state-changed"));
      expect(events.indexOf("finding.state-changed")).toBeLessThan(events.indexOf("attempt.closed"));
    }, ["`true`"], 'module.exports = "broken";\n');
  });

  it("M4D-8: deterministic red plus a provider ACCEPT never reaches AUDIT_ACCEPTED", async () => {
    await withFixture(async (value) => {
      const auditor = await auditorFor(value);
      const result = expectAudit(await runCoreAudit(value, auditor), "AUDIT_REJECTED");
      expect(result.auditResult.verdict).toBe("ACCEPT");
      expect(result.state.tasks.T001?.disposition).not.toBe("COMPLETE");
      expect(result.state.disposition).not.toBe("COMPLETE");
      expect(Object.values(result.state.findings).some((finding) => finding.severity === "BLOCKER" && finding.status === "OPEN")).toBe(true);
    }, ["`test -f missing.fixture`"]);
  });

  it("M4D-9: an omitted open Finding is never silently resolved", async () => {
    await withFixture(async (value) => {
      transport.responseText = rejectEnvelope();
      const firstAuditor = await auditorFor(value);
      const rejected = expectAudit(await runCoreAudit(value, firstAuditor), "AUDIT_REJECTED");
      const findingId = Object.values(rejected.state.findings)[0]!.id;

      const second = await secondAttempt(value);
      transport.responseText = acceptEnvelope();
      const auditor = await auditorFor(second.fixture);
      const result = expectAudit(await runCoreAudit(second.fixture, auditor, ATTEMPT_TWO), "AUDIT_REJECTED");
      expect(result.state.findings[findingId]?.status).toBe("OPEN");
      expect(result.state.tasks.T001?.disposition).not.toBe("COMPLETE");
    }, ["`true`"], 'module.exports = "broken";\n');
  });

  it("resolves an open Finding only through the frozen OPEN → CANDIDATE_RESOLVED → RESOLVED lifecycle", async () => {
    await withFixture(async (value) => {
      transport.responseText = rejectEnvelope();
      const firstAuditor = await auditorFor(value);
      const rejected = expectAudit(await runCoreAudit(value, firstAuditor), "AUDIT_REJECTED");
      const findingId = Object.values(rejected.state.findings)[0]!.id;

      const second = await secondAttempt(value, 'module.exports = "ready";\n');
      transport.responseText = acceptEnvelope([findingId]);
      const auditor = await auditorFor(second.fixture);
      const result = expectAudit(await runCoreAudit(second.fixture, auditor, ATTEMPT_TWO), "AUDIT_ACCEPTED");
      expect(result.state.findings[findingId]?.status).toBe("RESOLVED");
      expect(result.state.tasks.T001?.disposition).toBe("COMPLETE");
      expect(result.state.disposition).toBe("COMPLETE");
      const lifecycle = (await new RalphEventStoreV2({ projectRoot: value.root, runId: value.runId }).inspect()).events
        .flatMap((candidate) => candidate.eventType === "finding.state-changed" && candidate.payload.finding.id === findingId ? [candidate.payload.finding.status] : []);
      expect(lifecycle).toEqual(["OPEN", "CANDIDATE_RESOLVED", "RESOLVED"]);
      // Two audits, two sessions, two Core audit invocation identities.
      const store = new RalphEventStoreV2({ projectRoot: value.root, runId: value.runId });
      const one = await readAuditProviderSessionBindingV2(store, ATTEMPT_ONE);
      const two = await readAuditProviderSessionBindingV2(store, ATTEMPT_TWO);
      expect(one?.openCodeSessionId).not.toBe(two?.openCodeSessionId);
      expect(transport.promptCalls).toBe(2);
    }, ["`true`"], 'module.exports = "broken";\n');
  });
});

describe("Ralph M4-D — fresh-runtime boundaries", () => {
  it("A: a durable descriptor without a dispatch intent keeps the same identity and dispatches once", async () => {
    await withFixture(async (value) => {
      const auditor = await auditorFor(value);
      const auditPackage = await beginCoreAudit(value, auditor);
      await auditor.invoke(auditPackage);
      const store = new RalphEventStoreV2({ projectRoot: value.root, runId: value.runId });
      const before = await readAuditProviderDescriptorV2(store, ATTEMPT_ONE);
      await removeArtifacts(value, ATTEMPT_ONE, AFTER_DESCRIPTOR);
      const fresh = await auditorFor(value);
      const envelope = await fresh.invoke(auditPackage);
      expect(envelope.verdict).toBe("ACCEPT");
      const after = await readAuditProviderDescriptorV2(store, ATTEMPT_ONE);
      expect(after).toEqual(before);
      expect(transport.promptCalls).toBe(2);
      expect(transport.createdSessions[0]).not.toBe(transport.createdSessions[1]);
    });
  });

  it("B/C/D/E/F/G: every ambiguous physical state fails closed without a second dispatch", async () => {
    const boundaries = [
      ["B intent before worker", ["audit-provider-worker-started.json", "audit-provider-session-binding.json", "audit-provider-prompt.json", "audit-provider-result.json", "audit-provider-terminal.json"]],
      ["C worker before session binding", ["audit-provider-session-binding.json", "audit-provider-prompt.json", "audit-provider-result.json", "audit-provider-terminal.json"]],
      ["D session binding before prompt", ["audit-provider-prompt.json", "audit-provider-result.json", "audit-provider-terminal.json"]],
      ["E prompt before dispatch", ["audit-provider-result.json", "audit-provider-terminal.json"]],
      ["F dispatch ambiguous before result", ["audit-provider-result.json", "audit-provider-terminal.json"]],
      ["G result before terminal", ["audit-provider-terminal.json"]],
    ] as const;
    for (const [, removal] of boundaries) {
      transport.promptCalls = 0;
      transport.sessionCreates = 0;
      await withFixture(async (value) => {
        const auditor = await auditorFor(value);
        const auditPackage = await beginCoreAudit(value, auditor);
        await auditor.invoke(auditPackage);
        await removeArtifacts(value, ATTEMPT_ONE, removal);
        const fresh = await auditorFor(value);
        await expect(fresh.invoke(auditPackage)).rejects.toMatchObject({ m4dCode: "M4D_REDISPATCH_FORBIDDEN" });
        expect(transport.promptCalls).toBe(1);
      });
    }
  }, 120_000);

  it("H: a durable audit terminal replays the identical envelope with zero model-bearing calls", async () => {
    await withFixture(async (value) => {
      const auditor = await auditorFor(value);
      const auditPackage = await beginCoreAudit(value, auditor);
      const first = await auditor.invoke(auditPackage);
      const fresh = await auditorFor(value);
      const replayed = await fresh.invoke(auditPackage);
      expect(replayed).toEqual(first);
      expect(transport.promptCalls).toBe(1);
      expect(fresh.physicalDispatches).toBe(0);
      // Core still materializes its own AuditResult from the replayed envelope.
      const reconciled = expectAudit(await runCoreAudit(value, await auditorFor(value)), "AUDIT_ACCEPTED");
      expect(transport.promptCalls).toBe(1);
      expect(reconciled.auditResult.metadata.providerResultDigest).toBe(first.metadata.providerResultDigest);
    });
  });

  it("I/J: a durable AuditResult reconciles Findings before closure and never redispatches", async () => {
    await withFixture(async (value) => {
      transport.responseText = rejectEnvelope();
      const auditor = await auditorFor(value);
      const first = expectAudit(await runCoreAudit(value, auditor), "AUDIT_REJECTED");
      const store = new RalphEventStoreV2({ projectRoot: value.root, runId: value.runId });
      const events = (await store.inspect()).events;
      expect(events.findIndex((candidate) => candidate.eventType === "finding.state-changed"))
        .toBeLessThan(events.findIndex((candidate) => candidate.eventType === "attempt.closed"));
      const replay = expectAudit(await runCoreAudit(value, await auditorFor(value)), "AUDIT_REJECTED");
      expect(replay.auditResult.resultDigest).toBe(first.auditResult.resultDigest);
      expect(Object.values(replay.state.findings)).toHaveLength(1);
      expect(transport.promptCalls).toBe(1);
      const after = (await store.inspect()).events;
      expect(after.filter((candidate) => candidate.eventType === "attempt.closed")).toHaveLength(1);
      expect(after.filter((candidate) => candidate.eventType === "audit.started")).toHaveLength(1);
    }, ["`true`"], 'module.exports = "broken";\n');
  });

  it("refuses to run once Core already holds a durable AuditResult", async () => {
    await withFixture(async (value) => {
      const auditor = await auditorFor(value);
      const auditPackage = await beginCoreAudit(value, auditor);
      await auditor.invoke(auditPackage);
      await runCoreAudit(value, await auditorFor(value));
      const fresh = await auditorFor(value);
      await expect(fresh.invoke(auditPackage)).rejects.toMatchObject({ m4dCode: "M4D_AUDIT_ALREADY_RECONCILED" });
      expect(transport.promptCalls).toBe(1);
    });
  });
});

/** Admit, execute, capture and validate one more Attempt for the same Task. */
async function secondAttempt(value: Fixture, content = 'module.exports = "broken";\n'): Promise<{ readonly fixture: Fixture }> {
  const checkpointLease = await acquireLeasedRunV2(value.leaseOptions);
  const observed = await fingerprintWorkspace(value.root, createWorkspacePolicy());
  await commitRalphEventV2({
    store: checkpointLease.store, state: checkpointLease.state,
    event: event(checkpointLease.state, "workspace.checkpointed", {
      checkpoint: {
        kind: "acceptedCheckpointFingerprint", fingerprintDigest: observed.fingerprintDigest,
        emittedAt: "2026-09-06T07:19:00.000Z", attemptId: ATTEMPT_ONE,
        evidenceSetId: checkpointLease.state.attempts[ATTEMPT_ONE]?.evidenceCapture?.evidenceCaptureId ?? "evidence",
      },
    }),
    writtenAt: "2026-09-06T07:19:01.000Z", nonce: `m4d-checkpoint-${++ordinal}`,
  });
  await releaseLeasedRunV2(checkpointLease);
  const admitted = await prepareNextAuthorizedInvocationV2({
    leasedRun: await acquireLeasedRunV2(value.leaseOptions), plan: value.document, attemptIdFactory: () => ATTEMPT_TWO,
    nonceFactory: () => `m4d-${++ordinal}`, eventIdFactory: () => `m4d-event-${++ordinal}`, clock: () => "2026-09-06T07:20:00.000Z",
  });
  if (admitted.kind !== "AUTHORIZED_NOT_INVOKED") throw new Error(`M4-D second admission failed: ${admitted.kind}`);
  const executorLease = await acquireLeasedRunV2(value.leaseOptions);
  const executed = await executeAuthorizedInvocationV2({
    leasedRun: executorLease, plan: value.document,
    runtime: new ScriptedExecutor({
      clock: () => "2026-09-06T07:20:01.000Z",
      defaultScenario: { kind: "SUCCESS", fixtureWorkspaceAction: async () => { await writeFile(join(value.root, "src", "status.js"), content); } },
    }),
    attemptId: ATTEMPT_TWO, nonceFactory: () => `m4d-${++ordinal}`, eventIdFactory: () => `m4d-event-${++ordinal}`,
  });
  if (executed.kind !== "EXECUTOR_FINISHED_READY_FOR_CAPTURE") throw new Error(`M4-D second execution failed: ${executed.kind}`);
  const captured = await captureEvidenceV2({
    leasedRun: executorLease, plan: value.document, attemptId: ATTEMPT_TWO, observation: executed.observation,
    nonceFactory: () => `m4d-${++ordinal}`, eventIdFactory: () => `m4d-event-${++ordinal}`, clock: () => "2026-09-06T07:20:02.000Z",
  });
  if (captured.kind !== "EVIDENCE_CAPTURED_READY_FOR_VALIDATION") throw new Error(`M4-D second evidence failed: ${captured.kind}`);
  const validated = await validateAttemptV2({
    leasedRun: await acquireLeasedRunV2(value.leaseOptions), plan: value.document, attemptId: ATTEMPT_TWO,
    executorObservation: executed.observation, nonceFactory: () => `m4d-${++ordinal}`,
    eventIdFactory: () => `m4d-event-${++ordinal}`, clock: () => "2026-09-06T07:20:03.000Z",
  });
  if (validated.kind !== "VALIDATION_READY_FOR_AUDIT") throw new Error(`M4-D second validation failed: ${validated.kind}`);
  return { fixture: { ...value, observation: executed.observation, state: validated.state } };
}
