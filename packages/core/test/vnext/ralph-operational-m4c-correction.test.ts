import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * M4-C deterministic gate.
 *
 * Every test here drives the real frozen M4-B Executor across a local
 * OpenCode-compatible transport fixture. The fixture never inspects the
 * Attempt ordinal: its correction behaviour is a pure function of the
 * Finding text that actually reached the projected prompt.
 */
const transport = vi.hoisted(() => ({
  promptCalls: 0,
  sessionCreates: 0,
  serverStarts: 0,
  sanitizedReads: 0,
  sessionOrdinal: 0,
  currentSessionId: "",
  promptTexts: [] as string[],
  sessionIds: [] as string[],
  /** Physical workspace behaviour, driven only by the prompt the model received. */
  behavior: (async () => undefined) as (prompt: string, projectRoot: string) => Promise<void>,
  failIn: null as null | "startServer" | "getSession" | "sendPrompt" | "readResult",
}));

vi.mock("../../src/vnext/ralph-runtime/operational-b4/opencode-cli-process.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/vnext/ralph-runtime/operational-b4/opencode-cli-process.js")>();
  return {
    ...actual,
    inspectExactOpenCodeCliExecutableV2: vi.fn(async () => Object.freeze({
      executablePath: "/home/bruno/.opencode/bin/opencode",
      executableVersion: "1.18.29",
    })),
    startOpenCodeCliWorkerV2: vi.fn(async () => {
      const { defaultProcessIdentityProvider } = await import("../../src/vnext/ralph-runtime/operational-b2/index.js");
      const host = await defaultProcessIdentityProvider.current();
      const processIdentity = Object.freeze({ ...host, pid: 987_654, processStartIdentity: `sha256:${"a".repeat(64)}` });
      return Object.freeze({
        processIdentity,
        processGroupId: processIdentity.pid,
        startedAt: "2026-09-07T12:00:05.000Z",
        async startServer() {
          transport.serverStarts += 1;
          if (transport.failIn === "startServer") throw new Error("M4C_FIXTURE_CRASH_BEFORE_SESSION");
          return "http://127.0.0.1:32109";
        },
        async settle() {
          return Object.freeze({ observed: true, quiescent: true, verified: true, survivors: [], containment: { kind: "cgroup-v2", structural: true } });
        },
      });
    }),
  };
});

vi.mock("../../src/vnext/ralph-runtime/operational-b4/opencode-cli-session-inspector.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/vnext/ralph-runtime/operational-b4/opencode-cli-session-inspector.js")>();
  const model = "opencode-go/deepseek-v4-pro";
  const assistant = (userMessageId: string) => Object.freeze({
    assistantMessageId: `msg_m4c_assistant_${transport.sessionOrdinal.toString().padStart(3, "0")}`,
    sessionId: transport.currentSessionId,
    userMessageId,
    modelSelector: model,
    classification: "SUCCEEDED" as const,
    parts: Object.freeze([{ type: "text", text: "Workspace updated; Core decides Validation and Audit." }]),
    assistantContentDigest: `sha256:${"d".repeat(64)}`,
    responseDigest: `sha256:${"e".repeat(64)}`,
    observableTurnDigest: `sha256:${"f".repeat(64)}`,
    raw: {},
  });
  return {
    ...actual,
    OpenCodeCliHttpClientV2: class {
      constructor(private readonly options: { readonly projectRoot: string }) {}
      async health() { return "1.18.29"; }
      async createSession() {
        transport.sessionCreates += 1;
        transport.sessionOrdinal += 1;
        transport.currentSessionId = `ses_m4cDedicatedSession${transport.sessionOrdinal.toString().padStart(3, "0")}`;
        transport.sessionIds.push(transport.currentSessionId);
        return Object.freeze({ id: transport.currentSessionId, directory: this.options.projectRoot, version: "1.18.29", modelSelector: model });
      }
      async getSession() {
        if (transport.failIn === "getSession") throw new Error("M4C_FIXTURE_CRASH_BEFORE_DISPATCH");
        return Object.freeze({ id: transport.currentSessionId, directory: this.options.projectRoot, version: "1.18.29", modelSelector: model });
      }
      async listMessages() { return []; }
      async sendPrompt(input: { readonly prompt: string }) {
        transport.promptCalls += 1;
        transport.promptTexts.push(input.prompt);
        if (transport.failIn === "sendPrompt") throw new Error("M4C_FIXTURE_CRASH_DURING_DISPATCH");
        // The only physical workspace effect, decided purely from the prompt.
        await transport.behavior(input.prompt, this.options.projectRoot);
      }
      async readExactPromptResult(input: { readonly userMessageId: string }) {
        if (transport.failIn === "readResult") throw new Error("M4C_FIXTURE_CRASH_AFTER_DISPATCH");
        return assistant(input.userMessageId);
      }
      async abort() { return true; }
    },
    readSanitizedExactOpenCodeTurnV2: async (_options: unknown, input: { readonly userMessageId: string }) => {
      transport.sanitizedReads += 1;
      return assistant(input.userMessageId);
    },
    SupportedOpenCodeCliSessionInspectorV2: class {
      async inspect(input: {
        readonly descriptor: { readonly modelSelector: string };
        readonly dispatchIntent: { readonly openCodeUserMessageId: string };
        readonly sessionBinding: { readonly openCodeSessionId: string };
        readonly terminal: null | { readonly resultRef: string | null; readonly resultDigest: string | null };
      }) {
        return Object.freeze({
          sessionIdentity: "MATCH" as const,
          observedSessionId: input.sessionBinding.openCodeSessionId,
          activity: "STATUS_UNPROVEN" as const,
          modelIdentity: "MATCH" as const,
          observedModelSelector: input.descriptor.modelSelector,
          userMessageIdentity: "MATCH" as const,
          observedUserMessageId: input.dispatchIntent.openCodeUserMessageId,
          resultIdentity: input.terminal ? "MATCH" as const : "ABSENT" as const,
          observedResultRef: input.terminal?.resultRef ?? null,
          observedResultDigest: input.terminal?.resultDigest ?? null,
        });
      }
    },
  };
});

import type { ExecutionDocument, Phase, Task } from "../../src/types.js";
import type { Finding, RuntimeEntityRef } from "../../src/vnext/ralph-runtime/contracts.js";
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
  defaultProcessIdentityProvider,
  releaseLeasedRunV2,
  type LeaseRuntimeInputV2,
  type ProcessIdentity,
  type ProcessIdentityProvider,
} from "../../src/vnext/ralph-runtime/operational-b2/index.js";
import { prepareNextAuthorizedInvocationV2 } from "../../src/vnext/ralph-runtime/operational-b3/index.js";
import {
  buildExactCorrectionContextV2,
  createM4BTimeoutPolicyV2,
  createProviderDispatchIntentV2,
  createProviderInvocationDescriptorV2,
  createProviderSessionBindingV2,
  createProviderWorkerReceiptV2,
  persistProviderDispatchIntentV2,
  persistProviderInvocationDescriptorV2,
  persistProviderSessionBindingV2,
  persistProviderWorkerReceiptV2,
  createOpenCodeCliExecutorV2,
  deriveDurableCorrectionAuthorityV2,
  executeAuthorizedInvocationV2,
  authoritativeOpenFindingsForTaskV2,
  projectWorkUnitToOpenCodePromptV2,
  readProviderInvocationArtifactSetV2,
  validateExactCorrectionContextForDispatchV2,
  type M4BTimeoutPolicyV2,
} from "../../src/vnext/ralph-runtime/operational-b4/index.js";
import { readOpenCodePromptArtifactV2, readOpenCodeProviderResultV2 } from "../../src/vnext/ralph-runtime/operational-b4/opencode-cli-result.js";
import { LinuxProviderProcessTreeInspectorV2 } from "../../src/vnext/ralph-runtime/operational-b4/provider-process-tree-inspector.js";
import { captureEvidenceV2 } from "../../src/vnext/ralph-runtime/operational-c/index.js";
import { validateAttemptV2 } from "../../src/vnext/ralph-runtime/operational-d/index.js";
import { ScriptedAuditor, auditAttemptV2 } from "../../src/vnext/ralph-runtime/operational-e/index.js";
import {
  createCorrectionContextV2,
  persistCorrectionContextV2,
  readCorrectionContextV2,
  type CorrectionContextV2,
} from "../../src/vnext/ralph-runtime/operational-f/index.js";
import { createWorkspacePolicy, fingerprintWorkspace } from "../../src/vnext/ralph-runtime/fingerprint.js";
import { sha256, sha256Canonical } from "../../src/vnext/ralph-runtime/hashing.js";

const PROFILE = "opencode:cli:opencode-go/deepseek-v4-pro";
const MODEL = "opencode-go/deepseek-v4-pro";
const STATUS_PATH = "src/status.js";
const CORRECT_MODULE = "module.exports = { status: \"ready\", version: 1 };\n";
const DEFECTIVE_MODULE = "module.exports = { status: \"ready\" };\n";
const OWNER: ProcessIdentity = Object.freeze({
  pid: 64_021,
  processStartIdentity: sha256("m4c-lease-birth"),
  hostIdentity: sha256("m4c-host"),
  bootSessionIdentity: sha256("m4c-boot"),
});
const IDENTITY_PROVIDER: ProcessIdentityProvider = { current: () => OWNER, inspect: () => "MATCH" };

let ordinal = 0;

function descriptorRef(schemaVersion: string, descriptorId: string, descriptorDigest?: string) {
  const base = { schemaVersion, descriptorId };
  return { ...base, descriptorDigest: descriptorDigest ?? sha256Canonical(base) };
}

/**
 * Two concrete requirements. Attempt 1 satisfies the first and misses the
 * second, so the deterministic red is genuine rather than manufactured.
 */
function task(): Task {
  return {
    id: "T001",
    title: "Create the deterministic status module",
    done: false,
    scope: STATUS_PATH,
    change: `Create ${STATUS_PATH} exporting an object with a status property and a version property`,
    covers: STATUS_PATH,
    dependsOn: [],
    parallelSafe: false,
    acceptanceCriteria: [
      `${STATUS_PATH} exports status equal to the string ready`,
      `${STATUS_PATH} exports version equal to the number 1`,
    ],
    validation: [
      "`node -e \"const s=require('./src/status.js'); if (s.status !== 'ready') process.exit(1)\"`",
      "`node -e \"const s=require('./src/status.js'); if (s.version !== 1) process.exit(1)\"`",
    ],
    expectedEvidence: `A real workspace delta creating ${STATUS_PATH}`,
    line: 1,
  };
}

function plan(): ExecutionDocument {
  const phase: Phase = {
    number: 1, id: "P01", title: "M4-C correction loop",
    goal: "prove a real correction caused by a real Finding", dependsOn: [], context: ["m4c fixture"], tasks: [task()], line: 1,
  };
  return { contract: "rb-execution/v1", artifactId: "plan-m4c", title: "M4-C", phases: [phase] };
}

function event<TType extends RalphEventTypeV2>(
  state: RalphRuntimeStateV2,
  eventType: TType,
  payload: EventPayloadMapV2[TType],
  context: { readonly phaseId?: string; readonly taskId?: string; readonly attemptId?: string } = {},
): RalphEventV2 {
  const kind = V2_EVENT_ENTITY_KINDS[eventType];
  const entity: RuntimeEntityRef = kind === "run" ? { kind, id: state.runId }
    : kind === "workspace" ? { kind, id: `${state.runId}:workspace` }
      : kind === "task" ? { kind, id: context.taskId ?? "T001" }
        : { kind: "attempt", id: context.attemptId ?? "attempt-m4c" };
  return createRalphEventV2({
    eventId: `m4c-event-${state.lastSequence + 1}-${eventType}`, eventType, schemaVersion: EVENT_SCHEMA_V2, runId: state.runId,
    sequence: state.lastSequence + 1, occurredAt: "2026-09-07T12:00:00.000Z", recordedAt: "2026-09-07T12:00:00.000Z", entity,
    ...(context.phaseId === undefined ? {} : { phaseId: context.phaseId }),
    ...(context.taskId === undefined ? {} : { taskId: context.taskId }),
    ...(context.attemptId === undefined ? {} : { attemptId: context.attemptId }),
    actor: "CORE", causationId: null, correlationId: `${state.runId}:m4c`, payload, previousEventHash: state.lastEventHash,
  } as UnsignedRalphEventV2<TType>) as RalphEventV2;
}

interface Fixture {
  readonly root: string;
  readonly runId: string;
  readonly document: ExecutionDocument;
  readonly genesis: RalphRuntimeStateV2;
  readonly lease: LeaseRuntimeInputV2;
  readonly timeoutPolicy: M4BTimeoutPolicyV2;
  readonly policy: ReturnType<typeof createWorkspacePolicy>;
  store(): RalphEventStoreV2;
}

async function bootstrap(name: string, maxTaskAttemptsPerTask = 2): Promise<Fixture> {
  const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", `rb-ralph-m4c-${name}-`));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "README.md"), "# Disposable Ralph M4-C correction fixture\n");
  const runId = `run-m4c-${name}-${++ordinal}`;
  const document = plan();
  const policy = createWorkspacePolicy({ scopePaths: [STATUS_PATH], coversPaths: [STATUS_PATH] });
  const fingerprint = await fingerprintWorkspace(root, policy);
  const timeoutPolicy = createM4BTimeoutPolicyV2(30_000);
  const retryPolicy = createRetryPolicyV1({ runId, policyId: "m4c-retry", maxTaskAttemptsPerTask, validationInfrastructureRetryLimit: 0 });
  const config = descriptorRef("rb-ralph-config/v2", "m4c-config");
  const snapshot: RunSnapshotV2 = {
    snapshotSchemaVersion: RALPH_RUN_SNAPSHOT_V2_SCHEMA, runId, eventSchema: EVENT_SCHEMA_V2, stateSchema: STATE_SCHEMA_V2,
    operationalContract: OPERATIONAL_CONTRACT_V2, projectIdentity: { projectId: "m4c-project" }, readyPlanIdentity: document.artifactId,
    readyPlanHash: sha256Canonical(document), readyManifestHash: sha256("m4c-manifest"), selectedReadyArtifactHashes: { plan: sha256Canonical(document) },
    readinessInspectionDigest: sha256("m4c-readiness"), effectiveRunConfig: config, effectiveConfigDigest: config.descriptorDigest,
    diagnosticsPolicy: descriptorRef("rb-ralph-diagnostics/v2", "m4c-diagnostics"),
    environmentPolicy: descriptorRef("rb-ralph-environment/v2", "m4c-environment"),
    executorProfile: { profileId: PROFILE, kind: "scripted", descriptorDigest: sha256("m4c-opencode-profile") },
    executorCapabilities: { requested: ["workspace.write"], granted: ["workspace.write"], verified: ["workspace.write"], readOnlyEnforced: false },
    permissionCapabilityPolicy: descriptorRef("rb-ralph-capabilities/v2", "m4c-capabilities"), workspacePolicy: policy,
    initialWorkspaceFingerprint: {
      controlPlaneFingerprint: fingerprint.controlPlaneFingerprint, productWorkspaceFingerprint: fingerprint.productWorkspaceFingerprint,
      policyDigest: fingerprint.policyDigest, fingerprintDigest: fingerprint.fingerprintDigest,
    },
    retryPolicies: retryPolicyDescriptorV1(retryPolicy),
    timeoutPolicy: descriptorRef("rb-ralph-timeout/v2", "m4c-timeout", timeoutPolicy.policyDigest),
    runtimeIdentity: descriptorRef("rb-ralph-runtime/v2", "m4c-runtime"), leasePolicy: descriptorRef("rb-ralph-lease/v2", "m4c-lease"),
    createdAt: "2026-09-07T12:00:00.000Z",
  };
  const store = new RalphEventStoreV2({ projectRoot: root, runId });
  const genesis = createInitialRuntimeStateV2({
    runId, maxTaskAttemptsPerTask,
    phases: document.phases.map((phase) => ({ phaseId: phase.id, taskIds: phase.tasks.map((candidate) => candidate.id) })),
    tasks: document.phases.flatMap((phase) => phase.tasks.map((candidate) => ({ taskId: candidate.id, phaseId: phase.id, dependsOn: candidate.dependsOn }))),
  });
  const initialized = await initializeOperationalRunV2({
    store, snapshot, retryPolicy, genesisState: genesis,
    runCreatedEvent: event(genesis, "run.created", { phaseIds: genesis.phaseIds, taskIds: genesis.taskIds }),
    createdAt: "2026-09-07T12:00:01.000Z", nonce: "m4c-init",
  });
  let state = (await commitRalphEventV2({ store, state: initialized.state, event: event(initialized.state, "run.started", {}), writtenAt: "2026-09-07T12:00:02.000Z", nonce: "m4c-start" })).state;
  state = (await commitRalphEventV2({
    store, state,
    event: event(state, "task.state-changed", { disposition: "READY", activity: "IDLE", owner: "NONE", hold: "NONE" }, { phaseId: "P01", taskId: "T001" }),
    writtenAt: "2026-09-07T12:00:03.000Z", nonce: "m4c-ready",
  })).state;
  return {
    root, runId, document, genesis, timeoutPolicy, policy,
    lease: { projectRoot: root, runId, genesisState: genesis, processIdentityProvider: IDENTITY_PROVIDER },
    store: () => new RalphEventStoreV2({ projectRoot: root, runId }),
  };
}

async function withFixture(name: string, action: (value: Fixture) => Promise<void>, maxTaskAttemptsPerTask = 2): Promise<void> {
  const value = await bootstrap(name, maxTaskAttemptsPerTask);
  try { await action(value); }
  finally { await rm(value.root, { recursive: true, force: true }); }
}

/** Record the post-Attempt workspace as the accepted checkpoint, exactly as the F driver does. */
async function checkpointWorkspace(value: Fixture): Promise<void> {
  const leasedRun = await acquireLeasedRunV2({ ...value.lease, runtimeInstanceId: `m4c-checkpoint-${++ordinal}` });
  try {
    const observed = await fingerprintWorkspace(value.root, value.policy);
    const current = leasedRun.state.checkpoints.acceptedCheckpointFingerprint;
    if (current?.fingerprintDigest === observed.fingerprintDigest) return;
    const attempt = Object.values(leasedRun.state.attempts).sort((left, right) => right.ordinal - left.ordinal)[0];
    await commitRalphEventV2({
      store: leasedRun.store, state: leasedRun.state,
      event: event(leasedRun.state, "workspace.checkpointed", {
        checkpoint: {
          kind: "acceptedCheckpointFingerprint", fingerprintDigest: observed.fingerprintDigest,
          emittedAt: "2026-09-07T12:30:00.000Z", attemptId: attempt?.attemptId,
          ...(attempt?.evidenceCapture ? { evidenceSetId: attempt.evidenceCapture.evidenceCaptureId } : {}),
        },
      }),
      writtenAt: "2026-09-07T12:30:00.000Z", nonce: `m4c-checkpoint-${ordinal}`,
    });
  } finally {
    await releaseLeasedRunV2(leasedRun);
  }
}

interface AttemptOutcome {
  readonly attemptId: string;
  readonly invocationId: string;
  readonly openCodeSessionId: string;
  readonly correctionContext?: CorrectionContextV2;
  readonly promptText: string;
  readonly evidenceCaptureId: string;
  readonly evidenceDigest: string;
  readonly validationSetDigest: string;
  readonly validationPassed: number;
  readonly validationFailed: number;
  readonly failedSpecIds: readonly string[];
  readonly auditKind: string;
  readonly closureReason?: string;
  readonly state: RalphRuntimeStateV2;
}

/**
 * One complete Attempt across every frozen Core boundary, driven with entirely
 * fresh runtime objects. `auditorFor` receives the real deterministic
 * validation outcome so the Finding it proposes describes the observed failure.
 */
async function runAttempt(value: Fixture, options: {
  readonly label: string;
  readonly auditorFor: (facts: { readonly failedSpecIds: readonly string[]; readonly openFindings: readonly Finding[] }) => ScriptedAuditor;
  readonly mutateCorrectionContext?: (context: CorrectionContextV2, store: RalphEventStoreV2) => Promise<CorrectionContextV2 | undefined>;
}): Promise<AttemptOutcome> {
  const store = value.store();
  const attemptId = `attempt-m4c-${options.label}`;
  const admissionLease = await acquireLeasedRunV2({ ...value.lease, runtimeInstanceId: `m4c-admit-${options.label}` });
  const admitted = await prepareNextAuthorizedInvocationV2({
    leasedRun: admissionLease, plan: value.document, planIdentity: value.document.artifactId, planDigest: sha256Canonical(value.document),
    attemptIdFactory: () => attemptId,
  });
  if (admitted.kind !== "AUTHORIZED_NOT_INVOKED") throw new Error(`M4-C admission failed: ${admitted.kind}`);
  const core = admitted.authorizedInvocation.descriptor;

  // Core mints and persists the correction authority before any provider fact.
  let correctionContext = await buildExactCorrectionContextV2({
    store, runId: core.runId, phaseId: core.phaseId, taskId: core.taskId, attemptId: core.attemptId,
    baseWorkspaceFingerprint: core.attemptBaseFingerprint, createdAt: "2026-09-07T12:40:00.000Z",
  });
  if (correctionContext && options.mutateCorrectionContext) {
    correctionContext = await options.mutateCorrectionContext(correctionContext, store);
  }
  if (correctionContext) await persistCorrectionContextV2(store, correctionContext, `m4c-context-${options.label}`);

  const executorLease = await acquireLeasedRunV2({ ...value.lease, runtimeInstanceId: `m4c-exec-${options.label}` });
  const executor = await createOpenCodeCliExecutorV2({ store, authorizedInvocation: admitted.authorizedInvocation, timeoutPolicy: value.timeoutPolicy });
  const executed = await executeAuthorizedInvocationV2({
    leasedRun: executorLease, plan: value.document, planIdentity: value.document.artifactId, planDigest: sha256Canonical(value.document),
    attemptId, runtime: executor,
  });
  if (executed.kind !== "EXECUTOR_FINISHED_READY_FOR_CAPTURE") throw new Error(`M4-C execution failed: ${executed.kind}`);

  const artifacts = await readProviderInvocationArtifactSetV2(store, attemptId);
  const promptArtifact = await readOpenCodePromptArtifactV2(store, attemptId);
  const promptText = transport.promptTexts[transport.promptTexts.length - 1] ?? "";
  if (!promptArtifact || promptArtifact.promptDigest !== sha256(promptText)) throw new Error("M4-C prompt artifact is not bound to the dispatched prompt");

  const captured = await captureEvidenceV2({ leasedRun: executorLease, plan: value.document, attemptId, observation: executed.observation });
  if (captured.kind !== "EVIDENCE_CAPTURED_READY_FOR_VALIDATION") throw new Error(`M4-C evidence failed: ${captured.kind}`);

  const validationLease = await acquireLeasedRunV2({ ...value.lease, runtimeInstanceId: `m4c-validate-${options.label}` });
  const validated = await validateAttemptV2({ leasedRun: validationLease, plan: value.document, attemptId, executorObservation: executed.observation });
  if (validated.kind !== "VALIDATION_READY_FOR_AUDIT") throw new Error(`M4-C validation failed: ${validated.kind}`);
  const failedSpecIds = validated.attempt.validationRuns.filter((run) => run.outcome === "FAIL").map((run) => run.validationSpecId);

  const authorityBeforeAudit = await deriveDurableCorrectionAuthorityV2(store);
  const auditor = options.auditorFor({ failedSpecIds, openFindings: authoritativeOpenFindingsForTaskV2(authorityBeforeAudit, "T001") });
  const auditLease = await acquireLeasedRunV2({ ...value.lease, runtimeInstanceId: `m4c-audit-${options.label}` });
  const audited = await auditAttemptV2({ leasedRun: auditLease, plan: value.document, attemptId, executorObservation: executed.observation, auditor });

  return {
    attemptId, invocationId: core.invocationId,
    openCodeSessionId: artifacts.sessionBinding?.openCodeSessionId ?? "",
    ...(correctionContext ? { correctionContext } : {}),
    promptText,
    evidenceCaptureId: validated.validationSet.evidenceCaptureId, evidenceDigest: captured.evidence.evidenceDigest,
    validationSetDigest: validated.validationSet.setDigest,
    validationPassed: validated.validationSet.summary.passed, validationFailed: validated.validationSet.summary.failed,
    failedSpecIds, auditKind: audited.kind,
    ...(audited.attempt?.closureReason ? { closureReason: audited.attempt.closureReason } : {}),
    state: audited.state,
  };
}

/**
 * REJECT while the real red is present; ACCEPT and resolve once it is gone.
 * The Auditor proposes nothing: Core's own deterministic hard-negative Finding
 * is the authoritative description of the observed failure.
 */
function rejectingAuditor(facts: { readonly failedSpecIds: readonly string[]; readonly openFindings: readonly Finding[] }): ScriptedAuditor {
  if (facts.failedSpecIds.length > 0) {
    return new ScriptedAuditor({
      defaultDecision: { verdict: "REJECT", proposedFindings: [], resolvedFindingRefs: [], rationale: "deterministic red is present" },
    });
  }
  return new ScriptedAuditor({
    defaultDecision: {
      verdict: "ACCEPT", proposedFindings: [],
      resolvedFindingRefs: facts.openFindings.map((finding) => finding.id),
      rationale: "deterministic red is absent and the open Finding is revalidated",
    },
  });
}

/**
 * The fixture corrects only when the real Finding reached the prompt. It reads
 * the failing validation instruction the correction section restated, and never
 * consults an Attempt ordinal.
 */
async function findingDrivenBehavior(prompt: string, projectRoot: string): Promise<void> {
  const target = join(projectRoot, STATUS_PATH);
  const correctionRequested = prompt.includes("CORRECTION ATTEMPT")
    && /Finding finding-[0-9a-f]{64}/.test(prompt)
    && /Failing validation \[COMMAND\]:.*s\.version !== 1/.test(prompt);
  await writeFile(target, correctionRequested ? CORRECT_MODULE : DEFECTIVE_MODULE);
}

beforeEach(() => {
  transport.promptCalls = 0;
  transport.sessionCreates = 0;
  transport.serverStarts = 0;
  transport.sanitizedReads = 0;
  transport.sessionOrdinal = 0;
  transport.currentSessionId = "";
  transport.promptTexts = [];
  transport.sessionIds = [];
  transport.failIn = null;
  transport.behavior = findingDrivenBehavior;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Ralph M4-C — real OpenCode correction loop (deterministic)", () => {
  it("M4C-2/M4C-8/M4C-9: drives reject → real Finding → fresh-process correction → accept without ordinal magic", async () => {
    await withFixture("loop", async (value) => {
      const first = await runAttempt(value, { label: "a1", auditorFor: rejectingAuditor });
      expect(first.correctionContext).toBeUndefined();
      // M4C-2: a base Attempt receives no correction section at all.
      expect(first.promptText).not.toContain("CORRECTION ATTEMPT");
      expect(first.validationFailed).toBe(1);
      expect(first.validationPassed).toBe(1);
      expect(first.auditKind).toBe("AUDIT_REJECTED");
      expect(first.closureReason).toBe("AUDIT_REJECTED");
      expect(await readFile(join(value.root, STATUS_PATH), "utf8")).toBe(DEFECTIVE_MODULE);

      const openAfterFirst = Object.values(first.state.findings);
      expect(openAfterFirst).toHaveLength(1);
      const finding = openAfterFirst[0]!;
      expect(finding.status).toBe("OPEN");
      expect(finding.severity).toBe("BLOCKER");
      expect(finding.criterionId).toBe(first.failedSpecIds[0]);
      // 11: the Finding describes the deterministic failure Core actually observed.
      expect(finding.observed).toContain(first.failedSpecIds[0]!);
      expect(first.state.tasks.T001?.disposition).not.toBe("COMPLETE");

      // 13/20: every runtime object is discarded across the boundary.
      await checkpointWorkspace(value);
      const coldStore = value.store();
      const coldAuthority = await deriveDurableCorrectionAuthorityV2(coldStore);
      expect(authoritativeOpenFindingsForTaskV2(coldAuthority, "T001").map((item) => item.id)).toEqual([finding.id]);
      expect(coldAuthority.attempts.get(first.attemptId)?.closureReason).toBe("AUDIT_REJECTED");

      const second = await runAttempt(value, { label: "a2", auditorFor: rejectingAuditor });
      expect(second.correctionContext).toBeDefined();
      expect(second.correctionContext?.openFindingRefs).toEqual([finding.id]);
      expect(second.correctionContext?.sourceRejectedAttempts.map((item) => item.attemptId)).toEqual([first.attemptId]);

      // 22: the Finding reached the model input verbatim.
      expect(second.promptText).toContain("CORRECTION ATTEMPT");
      expect(second.promptText).toContain(finding.id);
      expect(second.promptText).toContain(finding.criterionId);
      expect(second.promptText).toContain(finding.observed);
      expect(second.promptText).toContain(finding.remediationHint!);
      expect(second.promptText).toContain("Failing validation [COMMAND]:");
      expect(second.promptText).toContain("s.version !== 1");
      expect(second.promptText).toContain("Do not infer what to do from the Attempt number");

      // 9/M4C-6/M4C-9: nothing is shared between the two Attempts.
      expect(second.attemptId).not.toBe(first.attemptId);
      expect(second.invocationId).not.toBe(first.invocationId);
      expect(second.openCodeSessionId).not.toBe(first.openCodeSessionId);
      expect(second.evidenceCaptureId).not.toBe(first.evidenceCaptureId);
      expect(second.evidenceDigest).not.toBe(first.evidenceDigest);
      expect(second.validationSetDigest).not.toBe(first.validationSetDigest);
      expect(transport.sessionIds).toHaveLength(2);
      expect(new Set(transport.sessionIds).size).toBe(2);
      expect(transport.promptCalls).toBe(2);

      expect(await readFile(join(value.root, STATUS_PATH), "utf8")).toBe(CORRECT_MODULE);
      expect(second.validationFailed).toBe(0);
      expect(second.validationPassed).toBe(2);
      expect(second.auditKind).toBe("AUDIT_ACCEPTED");
      expect(second.state.findings[finding.id]?.status).toBe("RESOLVED");
      expect(second.state.tasks.T001?.disposition).toBe("COMPLETE");
      expect(second.state.disposition).toBe("COMPLETE");

      const events = (await value.store().inspect()).events;
      expect(events.flatMap((candidate) => candidate.eventType === "finding.state-changed" && candidate.payload.finding.id === finding.id
        ? [candidate.payload.finding.status] : [])).toEqual(["OPEN", "CANDIDATE_RESOLVED", "RESOLVED"]);
      // M4C-8: the Finding is still OPEN when the correction Executor finishes.
      const secondExecutorFinished = events.findIndex((candidate) => candidate.eventType === "executor.finished" && candidate.attemptId === second.attemptId);
      const resolvedIndex = events.findIndex((candidate) => candidate.eventType === "finding.state-changed" && candidate.payload.finding.status === "RESOLVED");
      const secondAuditStarted = events.findIndex((candidate) => candidate.eventType === "audit.started" && candidate.attemptId === second.attemptId);
      expect(secondExecutorFinished).toBeGreaterThan(-1);
      expect(resolvedIndex).toBeGreaterThan(secondExecutorFinished);
      expect(resolvedIndex).toBeGreaterThan(secondAuditStarted);
      expect(events.filter((candidate) => candidate.eventType === "attempt.closed")).toHaveLength(2);
      expect(events.some((candidate) => candidate.eventType === "run.completed")).toBe(true);
    });
  }, 60_000);

  it("M4C-1: the projected correction prompt carries every authoritative Finding field", async () => {
    await withFixture("projection", async (value) => {
      const first = await runAttempt(value, { label: "p1", auditorFor: rejectingAuditor });
      const finding = Object.values(first.state.findings)[0]!;
      await checkpointWorkspace(value);
      const store = value.store();
      const admissionLease = await acquireLeasedRunV2({ ...value.lease, runtimeInstanceId: "m4c-projection" });
      const admitted = await prepareNextAuthorizedInvocationV2({
        leasedRun: admissionLease, plan: value.document, planIdentity: value.document.artifactId,
        planDigest: sha256Canonical(value.document), attemptIdFactory: () => "attempt-m4c-p2",
      });
      if (admitted.kind !== "AUTHORIZED_NOT_INVOKED") throw new Error(`admission failed: ${admitted.kind}`);
      const core = admitted.authorizedInvocation.descriptor;
      const context = await buildExactCorrectionContextV2({
        store, runId: core.runId, phaseId: core.phaseId, taskId: core.taskId, attemptId: core.attemptId,
        baseWorkspaceFingerprint: core.attemptBaseFingerprint, createdAt: "2026-09-07T12:40:00.000Z",
      });
      if (!context) throw new Error("M4-C expected a correction context");

      const base = projectWorkUnitToOpenCodePromptV2(admitted.authorizedInvocation.workUnit);
      const corrected = projectWorkUnitToOpenCodePromptV2(admitted.authorizedInvocation.workUnit, context);
      expect(corrected.promptDigest).not.toBe(base.promptDigest);
      expect(corrected.text.startsWith(base.text)).toBe(true);
      for (const fragment of [finding.id, finding.criterionId, finding.severity, finding.status, finding.observed, finding.remediationHint!, context.contextId, first.attemptId]) {
        expect(corrected.text).toContain(fragment);
      }
      expect(corrected.text).toContain("Findings are the authoritative correction input");
      expect(corrected.text).toContain("Do not mark any Finding resolved");
      expect(corrected.text).toContain("Do not claim Validation PASS");
      expect(corrected.text).toContain("Do not claim Audit ACCEPT");
      expect(corrected.text).toContain("Do not commit or push");
      expect(corrected.text).toContain("Core independently revalidates and reaudits");
      expect(corrected.text).toContain("Inspect the current workspace");

      // Dropping the Finding from the context necessarily changes the prompt.
      const withoutObserved = createCorrectionContextV2({
        runId: context.runId, phaseId: context.phaseId, taskId: context.taskId, currentAttemptId: context.currentAttemptId,
        sourceRejectedAttempts: context.sourceRejectedAttempts, openFindingRefs: context.openFindingRefs,
        openFindings: context.openFindings.map((item) => ({ ...item, observed: "unrelated" })),
        baseWorkspaceFingerprint: context.baseWorkspaceFingerprint, createdAt: context.createdAt,
      });
      const mutated = projectWorkUnitToOpenCodePromptV2(admitted.authorizedInvocation.workUnit, withoutObserved);
      expect(mutated.promptDigest).not.toBe(corrected.promptDigest);
      expect(mutated.text).not.toContain(finding.observed);
    });
  }, 60_000);

  it("M4C-2: the Attempt ordinal never triggers correction, and dispatch without the durable authority fails closed", async () => {
    await withFixture("ordinal", async (value) => {
      const first = await runAttempt(value, { label: "o1", auditorFor: rejectingAuditor });
      expect(first.auditKind).toBe("AUDIT_REJECTED");
      const finding = Object.values(first.state.findings)[0]!;
      expect(finding.status).toBe("OPEN");
      await checkpointWorkspace(value);

      const store = value.store();
      const admissionLease = await acquireLeasedRunV2({ ...value.lease, runtimeInstanceId: "m4c-ordinal" });
      const admitted = await prepareNextAuthorizedInvocationV2({
        leasedRun: admissionLease, plan: value.document, planIdentity: value.document.artifactId,
        planDigest: sha256Canonical(value.document), attemptIdFactory: () => "attempt-m4c-o2",
      });
      if (admitted.kind !== "AUTHORIZED_NOT_INVOKED") throw new Error(`admission failed: ${admitted.kind}`);
      expect(admitted.attempt.attempt.ordinal).toBe(2);

      // The projection is ordinal-blind: this is the correction Attempt's own
      // WorkUnit, and without the durable context it yields no correction input.
      const ordinalOnly = projectWorkUnitToOpenCodePromptV2(admitted.authorizedInvocation.workUnit);
      expect(ordinalOnly.text).not.toContain("CORRECTION ATTEMPT");
      expect(ordinalOnly.text).not.toContain(finding.id);

      // Dispatching this Attempt without persisting the correction authority —
      // exactly the ordinal-driven mutation — fails closed with nothing physical.
      const promptsBefore = transport.promptCalls;
      const sessionsBefore = transport.sessionCreates;
      const serversBefore = transport.serverStarts;
      const executor = await createOpenCodeCliExecutorV2({ store, authorizedInvocation: admitted.authorizedInvocation, timeoutPolicy: value.timeoutPolicy });
      await expect(executor.invoke(admitted.authorizedInvocation)).rejects.toMatchObject({ m4cCode: "M4C_CORRECTION_CONTEXT_REQUIRED" });
      expect(await readProviderInvocationArtifactSetV2(store, "attempt-m4c-o2")).toEqual({});
      expect(transport.promptCalls).toBe(promptsBefore);
      expect(transport.sessionCreates).toBe(sessionsBefore);
      expect(transport.serverStarts).toBe(serversBefore);
      expect(await readFile(join(value.root, STATUS_PATH), "utf8")).toBe(DEFECTIVE_MODULE);
    });
  }, 60_000);

  it("M4C-10: an exhausted Task budget admits no correction Attempt, session or provider dispatch", async () => {
    await withFixture("budget", async (value) => {
      const first = await runAttempt(value, { label: "b1", auditorFor: rejectingAuditor });
      expect(first.auditKind).toBe("AUDIT_REJECTED");
      expect(Object.values(first.state.findings)[0]?.status).toBe("OPEN");
      await checkpointWorkspace(value);
      const promptsBefore = transport.promptCalls;
      const sessionsBefore = transport.sessionCreates;

      const admissionLease = await acquireLeasedRunV2({ ...value.lease, runtimeInstanceId: "m4c-budget" });
      const admitted = await prepareNextAuthorizedInvocationV2({
        leasedRun: admissionLease, plan: value.document, planIdentity: value.document.artifactId,
        planDigest: sha256Canonical(value.document), attemptIdFactory: () => "attempt-m4c-b2",
      });
      expect(admitted.kind).not.toBe("AUTHORIZED_NOT_INVOKED");
      expect(admitted.state.tasks.T001?.attemptsUsed).toBe(1);
      expect(admitted.state.tasks.T001?.executorBudget?.limit).toBe(1);
      expect(transport.promptCalls).toBe(promptsBefore);
      expect(transport.sessionCreates).toBe(sessionsBefore);
    }, 1);
  }, 60_000);
});

interface CorrectionStage {
  readonly store: RalphEventStoreV2;
  readonly admitted: Extract<Awaited<ReturnType<typeof prepareNextAuthorizedInvocationV2>>, { kind: "AUTHORIZED_NOT_INVOKED" }>;
  readonly core: { readonly runId: string; readonly phaseId: string; readonly taskId: string; readonly attemptId: string; readonly attemptBaseFingerprint: string };
  readonly context: CorrectionContextV2;
  readonly finding: Finding;
  readonly promptsBefore: number;
  readonly sessionsBefore: number;
}

/** Drive one genuine rejection, then stop exactly at correction admission. */
async function correctionStage(value: Fixture, label: string): Promise<CorrectionStage> {
  const first = await runAttempt(value, { label: `${label}-1`, auditorFor: rejectingAuditor });
  if (first.auditKind !== "AUDIT_REJECTED") throw new Error(`M4-C probe setup failed: ${first.auditKind}`);
  const finding = Object.values(first.state.findings)[0]!;
  await checkpointWorkspace(value);
  const store = value.store();
  const admissionLease = await acquireLeasedRunV2({ ...value.lease, runtimeInstanceId: `m4c-probe-${label}` });
  const admitted = await prepareNextAuthorizedInvocationV2({
    leasedRun: admissionLease, plan: value.document, planIdentity: value.document.artifactId,
    planDigest: sha256Canonical(value.document), attemptIdFactory: () => `attempt-m4c-${label}-2`,
  });
  if (admitted.kind !== "AUTHORIZED_NOT_INVOKED") throw new Error(`M4-C probe admission failed: ${admitted.kind}`);
  const core = admitted.authorizedInvocation.descriptor;
  const context = await buildExactCorrectionContextV2({
    store, runId: core.runId, phaseId: core.phaseId, taskId: core.taskId, attemptId: core.attemptId,
    baseWorkspaceFingerprint: core.attemptBaseFingerprint, createdAt: "2026-09-07T12:40:00.000Z",
  });
  if (!context) throw new Error("M4-C probe expected a correction context");
  return { store, admitted, core, context, finding, promptsBefore: transport.promptCalls, sessionsBefore: transport.sessionCreates };
}

function rebuild(context: CorrectionContextV2, overrides: Partial<Parameters<typeof createCorrectionContextV2>[0]>): CorrectionContextV2 {
  return createCorrectionContextV2({
    runId: context.runId, phaseId: context.phaseId, taskId: context.taskId, currentAttemptId: context.currentAttemptId,
    sourceRejectedAttempts: context.sourceRejectedAttempts, openFindingRefs: context.openFindingRefs,
    openFindings: context.openFindings, baseWorkspaceFingerprint: context.baseWorkspaceFingerprint,
    createdAt: context.createdAt, ...overrides,
  });
}

describe("Ralph M4-C — correction admission security probes", () => {
  const probes: readonly [string, string, (stage: CorrectionStage) => CorrectionContextV2][] = [
    ["M4C-1 omits the only OPEN Finding", "M4C_CORRECTION_FINDING_SET_INCOMPLETE",
      (stage) => rebuild(stage.context, { openFindingRefs: [], openFindings: [] })],
    ["M4C-3 inserts a foreign Finding", "M4C_CORRECTION_FINDING_SET_INCOMPLETE",
      (stage) => rebuild(stage.context, {
        openFindingRefs: [...stage.context.openFindingRefs, `finding-${"b".repeat(64)}`].sort(),
        openFindings: [...stage.context.openFindings, {
          findingId: `finding-${"b".repeat(64)}`, findingDigest: sha256Canonical({ foreign: true }), criterionId: "foreign-criterion",
          severity: "BLOCKER" as const, status: "OPEN" as const, observed: "foreign observation", remediationHint: "foreign hint",
        }].sort((left, right) => left.findingId.localeCompare(right.findingId)),
      })],
    ["M4C-4 alters the Finding digest", "M4C_CORRECTION_FINDING_DIGEST_MISMATCH",
      (stage) => rebuild(stage.context, {
        openFindings: stage.context.openFindings.map((finding) => ({ ...finding, findingDigest: sha256Canonical({ tampered: finding.findingId }) })),
      })],
    ["M4C-1 replaces the observed failure text", "M4C_CORRECTION_FINDING_BINDING_INVALID",
      (stage) => rebuild(stage.context, { openFindings: stage.context.openFindings.map((finding) => ({ ...finding, observed: "an unrelated observation" })) })],
    ["M4C-1 replaces the remediation hint", "M4C_CORRECTION_FINDING_BINDING_INVALID",
      (stage) => rebuild(stage.context, { openFindings: stage.context.openFindings.map((finding) => ({ ...finding, remediationHint: "do something else entirely" })) })],
    ["M4C-5 declares a resolved-looking status for an OPEN Finding", "M4C_CORRECTION_FINDING_BINDING_INVALID",
      (stage) => rebuild(stage.context, { openFindings: stage.context.openFindings.map((finding) => ({ ...finding, status: "CANDIDATE_RESOLVED" as const })) })],
    ["M4C-3 changes the rejected source Attempt reference", "M4C_CORRECTION_SOURCE_ATTEMPT_INVALID",
      (stage) => rebuild(stage.context, {
        sourceRejectedAttempts: stage.context.sourceRejectedAttempts.map((source) => ({ ...source, attemptId: "attempt-m4c-foreign" })),
      })],
    ["M4C-3 drops the rejected source Attempt entirely", "M4C_CORRECTION_SOURCE_ATTEMPT_INVALID",
      (stage) => rebuild(stage.context, { sourceRejectedAttempts: [] })],
  ];

  it.each(probes)("%s and performs no provider dispatch", async (label, expectedCode, mutate) => {
    await withFixture(`probe-${expectedCode.toLowerCase().slice(4, 24)}-${label.length}`, async (value) => {
      const stage = await correctionStage(value, "probe");
      await persistCorrectionContextV2(stage.store, mutate(stage), "m4c-probe-context");
      const executor = await createOpenCodeCliExecutorV2({ store: stage.store, authorizedInvocation: stage.admitted.authorizedInvocation, timeoutPolicy: value.timeoutPolicy });
      await expect(executor.invoke(stage.admitted.authorizedInvocation)).rejects.toMatchObject({ m4cCode: expectedCode });
      // 4: fail BEFORE provider descriptor, intent, session and prompt.
      expect(await readProviderInvocationArtifactSetV2(stage.store, stage.core.attemptId)).toEqual({});
      expect(await readOpenCodePromptArtifactV2(stage.store, stage.core.attemptId)).toBeUndefined();
      expect(transport.promptCalls).toBe(stage.promptsBefore);
      expect(transport.sessionCreates).toBe(stage.sessionsBefore);
      expect(await readFile(join(value.root, STATUS_PATH), "utf8")).toBe(DEFECTIVE_MODULE);
    });
  }, 60_000);

  it("M4C-4: refuses a durable context whose own contextDigest was tampered with", async () => {
    await withFixture("probe-context-digest", async (value) => {
      const stage = await correctionStage(value, "digest");
      await persistCorrectionContextV2(stage.store, stage.context, "m4c-probe-context");
      const path = join(stage.store.runDirectory, "attempts", stage.core.attemptId, "correction-context.json");
      const tampered = { ...JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>, contextDigest: sha256Canonical({ tampered: true }) };
      await writeFile(path, `${JSON.stringify(tampered, null, 2)}\n`);
      // The frozen artifact reader refuses the tampered digest at the earliest
      // durable read, and the M4-C guard refuses it independently.
      await expect(createOpenCodeCliExecutorV2({ store: stage.store, authorizedInvocation: stage.admitted.authorizedInvocation, timeoutPolicy: value.timeoutPolicy }))
        .rejects.toThrow("F_CORRECTION_CONTEXT_INVALID");
      await expect(validateExactCorrectionContextForDispatchV2({
        store: stage.store,
        descriptor: {
          ...stage.admitted.authorizedInvocation.descriptor,
          correctionContextRef: `attempts/${stage.core.attemptId}/correction-context.json`,
          correctionContextDigest: stage.context.contextDigest,
          baseWorkspaceFingerprint: stage.core.attemptBaseFingerprint,
        } as unknown as Parameters<typeof validateExactCorrectionContextForDispatchV2>[0]["descriptor"],
      })).rejects.toMatchObject({ m4cCode: "M4C_CORRECTION_CONTEXT_INVALID" });
      expect(await readProviderInvocationArtifactSetV2(stage.store, stage.core.attemptId)).toEqual({});
      expect(transport.promptCalls).toBe(stage.promptsBefore);
      expect(transport.sessionCreates).toBe(stage.sessionsBefore);
    });
  }, 60_000);

  it("M4C-7: a descriptor that loses or fakes its CorrectionContext binding is not dispatchable", async () => {
    await withFixture("probe-descriptor-binding", async (value) => {
      const stage = await correctionStage(value, "binding");
      await persistCorrectionContextV2(stage.store, stage.context, "m4c-probe-context");
      const executor = await createOpenCodeCliExecutorV2({ store: stage.store, authorizedInvocation: stage.admitted.authorizedInvocation, timeoutPolicy: value.timeoutPolicy });
      await executor.invoke(stage.admitted.authorizedInvocation);
      const genuine = (await readProviderInvocationArtifactSetV2(stage.store, stage.core.attemptId)).descriptor!;
      // The honest descriptor carries the exact durable ref and digest.
      expect(genuine.correctionContextRef).toBe(`attempts/${stage.core.attemptId}/correction-context.json`);
      expect(genuine.correctionContextDigest).toBe(stage.context.contextDigest);
      expect(await validateExactCorrectionContextForDispatchV2({ store: stage.store, descriptor: genuine })).toEqual(stage.context);

      for (const mutation of [
        { correctionContextRef: null, correctionContextDigest: null },
        { correctionContextDigest: sha256Canonical({ foreign: "digest" }) },
        { correctionContextRef: `attempts/${stage.core.attemptId}/foreign-context.json` },
      ] as const) {
        const drifted = { ...genuine, ...mutation } as typeof genuine;
        await expect(validateExactCorrectionContextForDispatchV2({ store: stage.store, descriptor: drifted }))
          .rejects.toMatchObject({ m4cCode: "M4C_CORRECTION_DESCRIPTOR_BINDING_INVALID" });
      }
    });
  }, 60_000);

  it("M4C-5/M4C-8: a RESOLVED Finding can never authorize another correction Attempt", async () => {
    await withFixture("probe-stale", async (value) => {
      const first = await runAttempt(value, { label: "s1", auditorFor: rejectingAuditor });
      const finding = Object.values(first.state.findings)[0]!;
      await checkpointWorkspace(value);
      const second = await runAttempt(value, { label: "s2", auditorFor: rejectingAuditor });
      expect(second.auditKind).toBe("AUDIT_ACCEPTED");
      expect(second.state.findings[finding.id]?.status).toBe("RESOLVED");

      const store = value.store();
      const authority = await deriveDurableCorrectionAuthorityV2(store);
      expect(authoritativeOpenFindingsForTaskV2(authority, "T001")).toEqual([]);
      // The Finding is durably RESOLVED, so no correction authority exists for it.
      expect(await buildExactCorrectionContextV2({
        store, runId: value.runId, phaseId: "P01", taskId: "T001", attemptId: "attempt-m4c-s3",
        baseWorkspaceFingerprint: (await fingerprintWorkspace(value.root, value.policy)).fingerprintDigest,
        createdAt: "2026-09-07T13:00:00.000Z",
      })).toBeUndefined();
    }, 3);
  }, 90_000);
});

/** Lay down the exact durable provider facts up to a chosen pre-dispatch point. */
async function seedProviderArtifacts(stage: CorrectionStage, upTo: "descriptor" | "session"): Promise<void> {
  const executable = {
    executablePath: "/home/bruno/.opencode/bin/opencode", executableVersion: "1.18.29",
    conformanceProfileId: PROFILE,
    conformanceRecordDigest: sha256Canonical(await (await import("../../src/vnext/ralph-runtime/operational-b4/opencode-cli-executor.js")).loadExactConformanceRecordV2()),
    conformanceExecutableVersion: "1.18.29",
  };
  const descriptor = await createProviderInvocationDescriptorV2({ store: stage.store, authorizedInvocation: stage.admitted.authorizedInvocation, executable });
  await persistProviderInvocationDescriptorV2(stage.store, descriptor, "m4c-seed-descriptor");
  if (upTo === "descriptor") return;
  const intent = createProviderDispatchIntentV2(descriptor, "2026-09-07T12:50:00.000Z");
  await persistProviderDispatchIntentV2(stage.store, intent, "m4c-seed-intent");
  const host = await defaultProcessIdentityProvider.current();
  const processIdentity = Object.freeze({ ...host, pid: 987_654, processStartIdentity: `sha256:${"a".repeat(64)}` });
  const workerReceipt = createProviderWorkerReceiptV2({ descriptor, dispatchIntent: intent, processIdentity, processGroupId: processIdentity.pid, startedAt: "2026-09-07T12:50:01.000Z" });
  await persistProviderWorkerReceiptV2(stage.store, workerReceipt, "m4c-seed-worker");
  const session = createProviderSessionBindingV2({
    descriptor, dispatchIntent: intent, workerReceipt,
    openCodeSessionId: "ses_m4cSeededSessionCrashWindow", boundAt: "2026-09-07T12:50:02.000Z",
  });
  await persistProviderSessionBindingV2(stage.store, session, "m4c-seed-session");
}

describe("Ralph M4-C — correction crash windows", () => {
  const windows = [
    ["A: CorrectionContext durable before the provider descriptor", "none", "COMPLETES"],
    ["B: descriptor durable before the dispatch intent", "seed-descriptor", "COMPLETES"],
    ["C: dispatch intent durable before worker and session", "startServer", "NO_REDISPATCH"],
    ["D: session binding durable before the correction prompt", "seed-session", "NO_REDISPATCH"],
    ["E: correction prompt durable before the model dispatch", "getSession", "NO_REDISPATCH"],
    ["F: model dispatch crossed before the provider result", "readResult", "NO_REDISPATCH"],
    ["G: provider result durable before the provider terminal", "nonQuiescent", "NO_REDISPATCH"],
    ["H: provider terminal durable before executor.finished", "terminalOnly", "NO_REDISPATCH"],
    ["H2: canonical InvocationResult and executor.finished durable", "canonical", "RECONSTRUCTS"],
  ] as const;

  it.each(windows)("%s recovers on a fresh runtime with the same authority", async (label, arrange, expectation) => {
    await withFixture(`crash-${arrange}`, async (value) => {
      const stage = await correctionStage(value, `cw${label.charCodeAt(0)}`);
      await persistCorrectionContextV2(stage.store, stage.context, "m4c-crash-context");

      let treeSpy: ReturnType<typeof vi.spyOn> | undefined;
      let heldLease: Awaited<ReturnType<typeof acquireLeasedRunV2>> | undefined;
      if (arrange === "seed-descriptor") await seedProviderArtifacts(stage, "descriptor");
      if (arrange === "seed-session") await seedProviderArtifacts(stage, "session");
      if (arrange === "startServer" || arrange === "getSession" || arrange === "readResult") transport.failIn = arrange;
      if (arrange === "nonQuiescent") treeSpy = vi.spyOn(LinuxProviderProcessTreeInspectorV2.prototype, "inspect").mockReturnValue("ACTIVE" as never);

      if (arrange === "canonical") {
        const canonicalExecutor = await createOpenCodeCliExecutorV2({ store: stage.store, authorizedInvocation: stage.admitted.authorizedInvocation, timeoutPolicy: value.timeoutPolicy });
        heldLease = await acquireLeasedRunV2({ ...value.lease, runtimeInstanceId: "m4c-crash-canonical" });
        const first = await executeAuthorizedInvocationV2({
          leasedRun: heldLease, plan: value.document, planIdentity: value.document.artifactId,
          planDigest: sha256Canonical(value.document), attemptId: stage.core.attemptId, runtime: canonicalExecutor,
        });
        expect(first.kind).toBe("EXECUTOR_FINISHED_READY_FOR_CAPTURE");
      } else if (arrange === "startServer" || arrange === "getSession" || arrange === "readResult" || arrange === "nonQuiescent" || arrange === "terminalOnly") {
        const crashing = await createOpenCodeCliExecutorV2({ store: stage.store, authorizedInvocation: stage.admitted.authorizedInvocation, timeoutPolicy: value.timeoutPolicy });
        if (arrange === "terminalOnly") await crashing.invoke(stage.admitted.authorizedInvocation);
        else await expect(crashing.invoke(stage.admitted.authorizedInvocation)).rejects.toThrow();
      }
      transport.failIn = null;
      treeSpy?.mockRestore();

      const promptsAfterCrash = transport.promptCalls;
      const sessionsAfterCrash = transport.sessionCreates;

      // Every runtime object is discarded; only the durable ledger survives.
      const coldStore = value.store();
      const coldDescriptor = (await readProviderInvocationArtifactSetV2(coldStore, stage.core.attemptId)).descriptor;
      if (coldDescriptor) {
        // 14: the correction authority is unchanged and still exactly bound.
        expect(await validateExactCorrectionContextForDispatchV2({ store: coldStore, descriptor: coldDescriptor })).toEqual(stage.context);
        expect(coldDescriptor.correctionContextDigest).toBe(stage.context.contextDigest);
      }
      expect(await readCorrectionContextV2(coldStore, stage.core.attemptId)).toEqual(stage.context);

      const freshExecutor = await createOpenCodeCliExecutorV2({ store: coldStore, authorizedInvocation: stage.admitted.authorizedInvocation, timeoutPolicy: value.timeoutPolicy });
      if (expectation === "NO_REDISPATCH") {
        await expect(freshExecutor.invoke(stage.admitted.authorizedInvocation)).rejects.toMatchObject({ m4bCode: "M4B_REDISPATCH_FORBIDDEN" });
        expect(transport.promptCalls).toBe(promptsAfterCrash);
        expect(transport.sessionCreates).toBe(sessionsAfterCrash);
      }

      // A canonical run keeps its executor lease until Evidence, so the resume
      // reuses that same known-owned handle rather than stranding a second one.
      const resumeLease = heldLease ?? await acquireLeasedRunV2({ ...value.lease, runtimeInstanceId: `m4c-crash-resume-${arrange}` });
      const resumed = await executeAuthorizedInvocationV2({
        leasedRun: resumeLease, plan: value.document, planIdentity: value.document.artifactId,
        planDigest: sha256Canonical(value.document), attemptId: stage.core.attemptId, runtime: freshExecutor,
      });

      // Never reinterpret missing memory as NOT_INVOKED.
      expect(["EXECUTOR_FINISHED_READY_FOR_CAPTURE", "RECONCILIATION_REQUIRED", "EXECUTOR_PROTOCOL_FAILURE"]).toContain(resumed.kind);
      if (expectation === "COMPLETES" || expectation === "RECONSTRUCTS") {
        expect(resumed.kind).toBe("EXECUTOR_FINISHED_READY_FOR_CAPTURE");
        expect(resumed.kind === "EXECUTOR_FINISHED_READY_FOR_CAPTURE" ? resumed.observation.state : null).toBe("TERMINATED_QUIESCENT");
        const prompt = transport.promptTexts[transport.promptTexts.length - 1] ?? "";
        expect(prompt).toContain("CORRECTION ATTEMPT");
        expect(prompt).toContain(stage.finding.id);
        expect(await readFile(join(value.root, STATUS_PATH), "utf8")).toBe(CORRECT_MODULE);
      }
      if (expectation === "RECONSTRUCTS") {
        // The terminal was already durable: recovery mints no second prompt.
        expect(transport.promptCalls).toBe(promptsAfterCrash);
        expect(transport.sessionCreates).toBe(sessionsAfterCrash);
      }
      if (expectation === "NO_REDISPATCH") {
        expect(transport.promptCalls).toBe(promptsAfterCrash);
        expect(transport.sessionCreates).toBe(sessionsAfterCrash);
      }
      // Exactly one dedicated session was ever created for this correction Attempt.
      const finalSession = (await readProviderInvocationArtifactSetV2(coldStore, stage.core.attemptId)).sessionBinding;
      if (finalSession) expect(transport.sessionIds.filter((id) => id === finalSession.openCodeSessionId).length).toBeLessThanOrEqual(1);
    });
  }, 90_000);
});

describe("Ralph M4-C — the Executor has no Finding authority", () => {
  it("M4C-8: the Finding stays OPEN through provider success, workspace mutation and Evidence", async () => {
    await withFixture("no-executor-resolution", async (value) => {
      const stage = await correctionStage(value, "auth");
      await persistCorrectionContextV2(stage.store, stage.context, "m4c-authority-context");

      const executorLease = await acquireLeasedRunV2({ ...value.lease, runtimeInstanceId: "m4c-authority-exec" });
      const executor = await createOpenCodeCliExecutorV2({ store: stage.store, authorizedInvocation: stage.admitted.authorizedInvocation, timeoutPolicy: value.timeoutPolicy });
      const executed = await executeAuthorizedInvocationV2({
        leasedRun: executorLease, plan: value.document, planIdentity: value.document.artifactId,
        planDigest: sha256Canonical(value.document), attemptId: stage.core.attemptId, runtime: executor,
      });
      expect(executed.kind).toBe("EXECUTOR_FINISHED_READY_FOR_CAPTURE");
      if (executed.kind !== "EXECUTOR_FINISHED_READY_FOR_CAPTURE") throw new Error("unreachable");

      // The provider physically succeeded and really corrected the workspace.
      expect(await readOpenCodeProviderResultV2(stage.store, stage.core.attemptId)).toMatchObject({ classification: "SUCCEEDED", observedModelSelector: MODEL });
      expect(await readFile(join(value.root, STATUS_PATH), "utf8")).toBe(CORRECT_MODULE);

      // 10: none of that touches the Finding lifecycle.
      const afterExecutor = await deriveDurableCorrectionAuthorityV2(value.store());
      expect(afterExecutor.findings.get(stage.finding.id)?.status).toBe("OPEN");

      const captured = await captureEvidenceV2({ leasedRun: executorLease, plan: value.document, attemptId: stage.core.attemptId, observation: executed.observation });
      expect(captured.kind).toBe("EVIDENCE_CAPTURED_READY_FOR_VALIDATION");
      const afterEvidence = await deriveDurableCorrectionAuthorityV2(value.store());
      expect(afterEvidence.findings.get(stage.finding.id)?.status).toBe("OPEN");

      const validationLease = await acquireLeasedRunV2({ ...value.lease, runtimeInstanceId: "m4c-authority-validate" });
      const validated = await validateAttemptV2({ leasedRun: validationLease, plan: value.document, attemptId: stage.core.attemptId, executorObservation: executed.observation });
      expect(validated.kind).toBe("VALIDATION_READY_FOR_AUDIT");
      // Even a green ValidationSet does not resolve the Finding on its own.
      const afterValidation = await deriveDurableCorrectionAuthorityV2(value.store());
      expect(afterValidation.findings.get(stage.finding.id)?.status).toBe("OPEN");

      const events = (await value.store().inspect()).events;
      expect(events.some((candidate) => candidate.eventType === "finding.state-changed" && candidate.payload.finding.status !== "OPEN")).toBe(false);
      expect(events.every((candidate) => candidate.eventType !== "finding.state-changed" || candidate.actor === "CORE")).toBe(true);
    });
  }, 90_000);

  it("M4C-6/M4C-9: a session binding and an Evidence capture are bound to exactly one Attempt", async () => {
    await withFixture("attempt-isolation", async (value) => {
      const first = await runAttempt(value, { label: "i1", auditorFor: rejectingAuditor });
      await checkpointWorkspace(value);
      const second = await runAttempt(value, { label: "i2", auditorFor: rejectingAuditor });

      const store = value.store();
      const firstArtifacts = await readProviderInvocationArtifactSetV2(store, first.attemptId);
      const secondArtifacts = await readProviderInvocationArtifactSetV2(store, second.attemptId);
      expect(firstArtifacts.sessionBinding?.openCodeSessionId).not.toBe(secondArtifacts.sessionBinding?.openCodeSessionId);
      expect(firstArtifacts.sessionBinding?.bindingDigest).not.toBe(secondArtifacts.sessionBinding?.bindingDigest);
      expect(firstArtifacts.sessionBinding?.descriptorDigest).not.toBe(secondArtifacts.sessionBinding?.descriptorDigest);
      expect(firstArtifacts.descriptor?.correctionContextRef).toBeNull();
      expect(secondArtifacts.descriptor?.correctionContextRef).toBe(`attempts/${second.attemptId}/correction-context.json`);
      expect(secondArtifacts.descriptor?.correctionContextDigest).toBe(second.correctionContext?.contextDigest);
      expect(firstArtifacts.terminal?.resultDigest).not.toBe(secondArtifacts.terminal?.resultDigest);

      // A session binding minted for Attempt 1 cannot be persisted onto Attempt 2.
      const foreign = createProviderSessionBindingV2({
        descriptor: secondArtifacts.descriptor!, dispatchIntent: secondArtifacts.dispatchIntent!, workerReceipt: secondArtifacts.workerReceipt!,
        openCodeSessionId: firstArtifacts.sessionBinding!.openCodeSessionId, boundAt: "2026-09-07T13:10:00.000Z",
      });
      expect(foreign.bindingDigest).not.toBe(firstArtifacts.sessionBinding?.bindingDigest);
      await expect(persistProviderSessionBindingV2(store, foreign, "m4c-foreign-session")).rejects.toThrow();

      expect(first.evidenceCaptureId).not.toBe(second.evidenceCaptureId);
      expect(first.evidenceDigest).not.toBe(second.evidenceDigest);
      expect(first.validationSetDigest).not.toBe(second.validationSetDigest);
    });
  }, 90_000);
});
