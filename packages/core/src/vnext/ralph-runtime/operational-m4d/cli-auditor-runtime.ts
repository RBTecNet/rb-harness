import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { ConformanceRecord } from "../../providers/conformance/recording.js";
import { sha256Canonical } from "../hashing.js";
import { fingerprintWorkspace } from "../fingerprint.js";
import type { RalphEventStoreV2 } from "../operational-b1/index.js";
import { defaultProcessIdentityProvider, type ProcessIdentityProvider } from "../operational-b2/index.js";
import {
  auditPackageIdV2,
  validateAuditPackageV2,
  type AuditPackageV2,
} from "../operational-d/artifacts.js";
import {
  auditInvocationIdV2,
  readAuditInvocationDescriptorV2,
  readAuditResultV2,
  type AuditInvocationDescriptorV2,
} from "../operational-e/artifacts.js";
import {
  assertAuditorResultEnvelopeV2,
  AuditorRuntimeV2,
  type AuditorResultEnvelopeV2,
} from "../operational-e/auditor-runtime.js";
import {
  createM4BTimeoutPolicyV2,
  validateM4BTimeoutPolicyV2,
  type M4BTimeoutPolicyV2,
} from "../operational-b4/opencode-cli-contract.js";
import {
  loadExactConformanceRecordV2,
} from "../operational-b4/opencode-cli-executor.js";
import {
  inspectExactOpenCodeCliExecutableV2,
  openCodeM4BChildEnvironment,
  startOpenCodeCliWorkerV2,
  type OpenCodeCliWorkerV2,
} from "../operational-b4/opencode-cli-process.js";
import {
  OpenCodeCliHttpClientV2,
  readSanitizedExactOpenCodeTurnV2,
  type OpenCodeAssistantResultV2,
} from "../operational-b4/opencode-cli-session-inspector.js";
import { readProviderSessionBindingV2 } from "../operational-b4/provider-invocation-artifacts.js";
import { LinuxProviderProcessTreeInspectorV2 } from "../operational-b4/provider-process-tree-inspector.js";
import {
  auditorProfileDigestV2,
  auditorRuntimeIdentityV2,
  m4d,
  OPENCODE_CLI_AUDITOR_CORE_PROFILE_ID_V2,
  OPENCODE_CLI_AUDITOR_MODEL_V2,
  OPENCODE_CLI_AUDITOR_PROFILE_V2,
  OPENCODE_CLI_AUDITOR_ROLE_V2,
  OPENCODE_CLI_AUDITOR_TRANSPORT_V2,
  OPENCODE_CLI_AUDITOR_TRANSPORT_VERSION_V2,
  RalphM4DError,
} from "./contract.js";
import {
  assertReadOnlyAuditPermissionsV2,
  openCodeAuditReadOnlyChildEnvironmentV2,
  openCodeAuditReadOnlyPermissionPolicyV2,
  type OpenCodeAuditPermissionPolicyV2,
} from "./permissions.js";
import {
  auditPackageBindsDescriptorV2,
  createAuditProviderDescriptorV2,
  createAuditProviderDispatchIntentV2,
  createAuditProviderPromptArtifactV2,
  createAuditProviderResultV2,
  createAuditProviderSessionBindingV2,
  createAuditProviderTerminalArtifactV2,
  createAuditProviderWorkerReceiptV2,
  persistAuditProviderDescriptorV2,
  persistAuditProviderDispatchIntentV2,
  persistAuditProviderPromptArtifactV2,
  persistAuditProviderResultV2,
  persistAuditProviderSessionBindingV2,
  persistAuditProviderTerminalArtifactV2,
  persistAuditProviderWorkerReceiptV2,
  readAuditProviderArtifactSetV2,
  readAuditProviderPromptArtifactV2,
  readAuditProviderSessionBindingV2,
  type AuditProviderDescriptorV2,
  type AuditProviderPromptArtifactV2,
  type AuditProviderResultV2,
} from "./audit-provider-artifacts.js";
import { parseOpenCodeAuditProposalV2, type OpenCodeAuditProposalV2 } from "./audit-envelope.js";
import { projectAuditPackageToOpenCodePromptV2 } from "./audit-prompt.js";

const AUDITOR_SEAL = Symbol("OpenCodeCliAuditorV2");
const trustedOpenCodeAuditors = new WeakSet<OpenCodeCliAuditorV2>();

interface OpenCodeCliAuditorInternalsV2 {
  readonly store: RalphEventStoreV2;
  readonly projectRoot: string;
  readonly timeoutPolicy: M4BTimeoutPolicyV2;
  readonly permissions: OpenCodeAuditPermissionPolicyV2;
  readonly childEnvironment: NodeJS.ProcessEnv;
  readonly executablePath: string;
  readonly executableVersion: string;
  readonly openCodeExecutableIdentity: string;
  readonly conformanceRecordDigest: string;
  readonly processIdentityProvider: ProcessIdentityProvider;
  readonly processTreeInspector: LinuxProviderProcessTreeInspectorV2;
  readonly clock: () => string;
  readonly nonceFactory: () => string;
  readonly runtimeIdentity: string;
  readonly profileDigest: string;
  invocations: number;
}

const auditorInternals = new WeakMap<OpenCodeCliAuditorV2, OpenCodeCliAuditorInternalsV2>();

export interface CreateOpenCodeCliAuditorV2Input {
  readonly store: RalphEventStoreV2;
  readonly timeoutPolicy: M4BTimeoutPolicyV2;
  readonly clock?: () => string;
  readonly nonceFactory?: () => string;
  readonly processIdentityProvider?: ProcessIdentityProvider;
}

/**
 * The first model-bearing Ralph Auditor. It satisfies the frozen AuditorRuntime
 * protocol and nothing else: it has no Executor authority, no WorkUnit, no
 * workspace write capability and no Finding identity.
 */
export class OpenCodeCliAuditorV2 extends AuditorRuntimeV2 {
  readonly kind = "AUDITOR_RUNTIME" as const;
  readonly runtimeIdentity: string;
  readonly profileId = OPENCODE_CLI_AUDITOR_CORE_PROFILE_ID_V2;
  readonly profileDigest: string;

  constructor(internals: OpenCodeCliAuditorInternalsV2, seal: symbol) {
    super();
    if (new.target !== OpenCodeCliAuditorV2 || seal !== AUDITOR_SEAL) throw m4d("M4D_AUDITOR_AUTHORITY_REQUIRED", "M4D_AUDITOR_AUTHORITY_REQUIRED: genuine OpenCodeCliAuditorV2 required");
    this.runtimeIdentity = internals.runtimeIdentity;
    this.profileDigest = internals.profileDigest;
    auditorInternals.set(this, internals);
    trustedOpenCodeAuditors.add(this);
    Object.freeze(this);
  }

  async invoke(auditPackage: AuditPackageV2): Promise<AuditorResultEnvelopeV2> {
    const internal = requireInternals(this);
    return await runOpenCodeAuditInvocationV2(internal, auditPackage);
  }

  /** Physical model-bearing dispatches performed by this runtime instance. */
  get physicalDispatches(): number { return auditorInternals.get(this)?.invocations ?? 0; }
}

export async function createOpenCodeCliAuditorV2(input: CreateOpenCodeCliAuditorV2Input): Promise<OpenCodeCliAuditorV2> {
  validateM4BTimeoutPolicyV2(input.timeoutPolicy);
  const projectRoot = input.store.projectRoot;
  if (resolve(projectRoot) !== projectRoot) throw m4d("M4D_WORKSPACE_BINDING_INVALID");
  const permissions = openCodeAuditReadOnlyPermissionPolicyV2();
  assertReadOnlyAuditPermissionsV2(permissions);
  const record: ConformanceRecord = await loadExactConformanceRecordV2();
  const conformanceRecordDigest = sha256Canonical(record);
  const preflight = await inspectExactOpenCodeCliExecutableV2(projectRoot, input.timeoutPolicy.deadlineMs);
  if (preflight.executableVersion !== OPENCODE_CLI_AUDITOR_TRANSPORT_VERSION_V2 || record.transportVersion !== preflight.executableVersion) {
    throw m4d("M4D_CONFORMANCE_REQUIRED");
  }
  const openCodeExecutableIdentity = sha256Canonical({
    transport: OPENCODE_CLI_AUDITOR_TRANSPORT_V2,
    executablePath: preflight.executablePath,
    executableVersion: preflight.executableVersion,
  });
  const profileDigest = auditorProfileDigestV2({
    conformanceRecordDigest,
    permissionsDigest: permissions.policyDigest,
    timeoutPolicyDigest: input.timeoutPolicy.policyDigest,
  });
  const internals: OpenCodeCliAuditorInternalsV2 = {
    store: input.store,
    projectRoot,
    timeoutPolicy: Object.freeze({ ...input.timeoutPolicy }),
    permissions,
    childEnvironment: Object.freeze(openCodeAuditReadOnlyChildEnvironmentV2(openCodeM4BChildEnvironment(), permissions)),
    executablePath: preflight.executablePath,
    executableVersion: preflight.executableVersion,
    openCodeExecutableIdentity,
    conformanceRecordDigest,
    processIdentityProvider: input.processIdentityProvider ?? defaultProcessIdentityProvider,
    processTreeInspector: new LinuxProviderProcessTreeInspectorV2(),
    clock: input.clock ?? (() => new Date().toISOString()),
    nonceFactory: input.nonceFactory ?? randomUUID,
    runtimeIdentity: auditorRuntimeIdentityV2({ openCodeExecutableIdentity, profileDigest }),
    profileDigest,
    invocations: 0,
  };
  return new OpenCodeCliAuditorV2(internals, AUDITOR_SEAL);
}

export function isGenuineOpenCodeCliAuditorV2(value: unknown): value is OpenCodeCliAuditorV2 {
  return typeof value === "object" && value !== null && trustedOpenCodeAuditors.has(value as OpenCodeCliAuditorV2);
}

export function assertGenuineOpenCodeCliAuditorV2(value: unknown): asserts value is OpenCodeCliAuditorV2 {
  if (!isGenuineOpenCodeCliAuditorV2(value)) throw m4d("M4D_AUDITOR_AUTHORITY_REQUIRED", "M4D_AUDITOR_AUTHORITY_REQUIRED: genuine OpenCodeCliAuditorV2 required");
}

/** Deadline authority for one physical audit invocation. */
export const createAuditTimeoutPolicyV2 = createM4BTimeoutPolicyV2;

function requireInternals(value: OpenCodeCliAuditorV2): OpenCodeCliAuditorInternalsV2 {
  assertGenuineOpenCodeCliAuditorV2(value);
  const internal = auditorInternals.get(value);
  if (!internal) throw m4d("M4D_AUDITOR_AUTHORITY_REQUIRED");
  return internal;
}

async function runOpenCodeAuditInvocationV2(
  internal: OpenCodeCliAuditorInternalsV2,
  auditPackage: AuditPackageV2,
): Promise<AuditorResultEnvelopeV2> {
  try { validateAuditPackageV2(auditPackage); }
  catch (error) { throw m4d("M4D_AUDIT_PACKAGE_INVALID", "M4D_AUDIT_PACKAGE_INVALID: package is not a durable Core AuditPackage", error); }
  if (internal.store.runId !== auditPackage.runId) throw m4d("M4D_AUDIT_PACKAGE_INVALID", "M4D_AUDIT_PACKAGE_INVALID: package is foreign to this run");
  const attemptId = auditPackage.attemptId;
  const auditPackageId = computedAuditPackageIdV2(auditPackage);

  // ── 1. Core audit invocation identity must already be durable ─────────────
  const coreDescriptor = await readAuditInvocationDescriptorV2(internal.store, attemptId);
  if (!coreDescriptor) throw m4d("M4D_AUDIT_INVOCATION_REQUIRED", "M4D_AUDIT_INVOCATION_REQUIRED: Core audit invocation descriptor is not durable");
  assertCoreAuditBindingV2(internal, coreDescriptor, auditPackage, auditPackageId);
  if (await readAuditResultV2(internal.store, attemptId)) throw m4d("M4D_AUDIT_ALREADY_RECONCILED", "M4D_AUDIT_ALREADY_RECONCILED: a durable AuditResult already exists");
  if (!await hasDurableAuditStartedV2(internal.store, attemptId)) throw m4d("M4D_AUDIT_INVOCATION_BINDING_INVALID", "M4D_AUDIT_INVOCATION_BINDING_INVALID: audit.started is not durable");

  // ── 2. Replay or refuse; never redispatch ─────────────────────────────────
  const facts = await readAuditProviderArtifactSetV2(internal.store, attemptId);
  if (facts.descriptor) {
    if (!auditPackageBindsDescriptorV2(facts.descriptor, auditPackage, auditPackageId)
      || facts.descriptor.auditInvocationId !== coreDescriptor.auditInvocationId
      || facts.descriptor.auditorRuntimeIdentity !== internal.runtimeIdentity
      || facts.descriptor.auditorProfileDigest !== internal.profileDigest) {
      throw m4d("M4D_AUDIT_INVOCATION_BINDING_INVALID", "M4D_AUDIT_INVOCATION_BINDING_INVALID: durable audit provider descriptor conflict");
    }
    if (facts.terminal && facts.result && facts.prompt) {
      // The physical audit completed and was proven quiescent before the
      // process died. Replay the identical envelope; dispatch nothing.
      return envelopeFromDurableAuditV2(facts.descriptor, facts.prompt, facts.result);
    }
    if (facts.dispatchIntent) {
      throw m4d("M4D_REDISPATCH_FORBIDDEN", "M4D_REDISPATCH_FORBIDDEN: a physical audit dispatch may already have happened");
    }
  }

  // ── 3. Physical read-only and workspace preconditions ─────────────────────
  assertReadOnlyAuditPermissionsV2(internal.permissions);
  const snapshot = await internal.store.verifyRunSnapshot();
  const before = await fingerprintWorkspace(internal.projectRoot, snapshot.workspacePolicy);
  if (before.fingerprintDigest !== auditPackage.workspaceFingerprint) {
    throw m4d("M4D_WORKSPACE_BINDING_INVALID", "M4D_WORKSPACE_BINDING_INVALID: audited workspace is not the AuditPackage workspace");
  }
  const conformance = await loadExactConformanceRecordV2();
  if (sha256Canonical(conformance) !== internal.conformanceRecordDigest) throw m4d("M4D_CONFORMANCE_REQUIRED");

  // ── 4. Durable audit dispatch chain, before any model-bearing crossing ────
  const descriptor = createAuditProviderDescriptorV2({
    runId: auditPackage.runId,
    phaseId: auditPackage.phaseId,
    taskId: auditPackage.taskId,
    attemptId,
    auditInvocationId: coreDescriptor.auditInvocationId,
    auditPackageId,
    auditPackageDigest: auditPackage.packageDigest,
    auditorRuntimeIdentity: internal.runtimeIdentity,
    auditorProfileId: OPENCODE_CLI_AUDITOR_CORE_PROFILE_ID_V2,
    auditorProfileIdentity: OPENCODE_CLI_AUDITOR_PROFILE_V2,
    auditorProfileDigest: internal.profileDigest,
    modelSelector: OPENCODE_CLI_AUDITOR_MODEL_V2,
    openCodeExecutablePath: internal.executablePath,
    openCodeExecutableVersion: internal.executableVersion,
    openCodeExecutableIdentity: internal.openCodeExecutableIdentity,
    conformanceProfileId: OPENCODE_CLI_AUDITOR_PROFILE_V2,
    conformanceRecordDigest: internal.conformanceRecordDigest,
    conformanceExecutableVersion: internal.executableVersion,
    conformanceState: "MATCH",
    permissionsDigest: internal.permissions.policyDigest,
    timeoutPolicyDigest: internal.timeoutPolicy.policyDigest,
    projectRootIdentity: sha256Canonical({ projectRoot: internal.projectRoot }),
    baseWorkspaceFingerprint: before.fingerprintDigest,
    createdAt: coreDescriptor.startedAt,
  });
  await persistAuditProviderDescriptorV2(internal.store, descriptor, internal.nonceFactory());
  const intent = createAuditProviderDispatchIntentV2(descriptor, coreDescriptor.startedAt);
  await persistAuditProviderDispatchIntentV2(internal.store, intent, internal.nonceFactory());

  const worker = await startOpenCodeCliWorkerV2({
    projectRoot: internal.projectRoot,
    deadlineMs: internal.timeoutPolicy.deadlineMs,
    processIdentityProvider: internal.processIdentityProvider,
    clock: internal.clock,
    environment: internal.childEnvironment,
  });
  const workerReceipt = createAuditProviderWorkerReceiptV2({
    descriptor,
    dispatchIntent: intent,
    processIdentity: worker.processIdentity,
    processGroupId: worker.processGroupId,
    startedAt: worker.startedAt,
  });
  await persistAuditProviderWorkerReceiptV2(internal.store, workerReceipt, internal.nonceFactory());

  let settled = false;
  let settlement: Awaited<ReturnType<OpenCodeCliWorkerV2["settle"]>> | undefined;
  const settle = async (reason: string) => {
    if (settlement) return settlement;
    settled = true;
    settlement = await worker.settle(reason);
    return settlement;
  };

  try {
    const baseUrl = await worker.startServer();
    const client = new OpenCodeCliHttpClientV2({
      baseUrl,
      projectRoot: internal.projectRoot,
      deadlineMs: internal.timeoutPolicy.deadlineMs,
      sessionPermission: internal.permissions.sessionPermission,
      promptTools: internal.permissions.promptTools,
    });
    if (await client.health() !== OPENCODE_CLI_AUDITOR_TRANSPORT_VERSION_V2) throw m4d("M4D_EXECUTABLE_IDENTITY_INVALID");

    const startedAt = internal.clock();
    const sessionRecord = await client.createSession({ title: `ralph-audit-${coreDescriptor.auditInvocationId.slice(0, 40)}` });
    if ((await client.listMessages(sessionRecord.id)).length !== 0) throw m4d("M4D_SESSION_BINDING_INVALID", "M4D_SESSION_BINDING_INVALID: audit session is not empty");
    await assertAuditSessionIsDedicatedV2(internal.store, attemptId, sessionRecord.id);
    const session = createAuditProviderSessionBindingV2({
      descriptor, dispatchIntent: intent, workerReceipt, openCodeSessionId: sessionRecord.id, boundAt: internal.clock(),
    });
    await persistAuditProviderSessionBindingV2(internal.store, session, internal.nonceFactory());

    const projected = projectAuditPackageToOpenCodePromptV2(auditPackage);
    const promptArtifact = createAuditProviderPromptArtifactV2({
      runId: descriptor.runId, phaseId: descriptor.phaseId, taskId: descriptor.taskId, attemptId,
      auditInvocationId: descriptor.auditInvocationId,
      descriptorDigest: descriptor.descriptorDigest, dispatchIntentDigest: intent.intentDigest,
      sessionBindingDigest: session.bindingDigest,
      auditPackageId, auditPackageDigest: auditPackage.packageDigest,
      openCodeSessionId: session.openCodeSessionId, openCodeUserMessageId: intent.openCodeUserMessageId,
      modelSelector: descriptor.modelSelector, promptDigest: projected.promptDigest, promptBytes: projected.byteLength,
      preparedAt: coreDescriptor.startedAt,
    });
    await persistAuditProviderPromptArtifactV2(internal.store, promptArtifact, internal.nonceFactory());
    await assertPreAuditPromptDurabilityV2(internal, descriptor, auditPackage, promptArtifact, session.bindingDigest);

    const rebound = await client.getSession(session.openCodeSessionId);
    if (rebound.id !== session.openCodeSessionId || rebound.modelSelector !== descriptor.modelSelector) throw m4d("M4D_SESSION_BINDING_INVALID");

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(new Error("M4D_PROVIDER_TIMEOUT")); }, internal.timeoutPolicy.deadlineMs);
    let assistant: OpenCodeAssistantResultV2;
    try {
      // This is the sole model-bearing crossing of the audit.
      internal.invocations += 1;
      await client.sendPrompt({ sessionId: session.openCodeSessionId, userMessageId: intent.openCodeUserMessageId, prompt: projected.text }, controller.signal);
      assistant = await client.readExactPromptResult({ sessionId: session.openCodeSessionId, userMessageId: intent.openCodeUserMessageId }, controller.signal);
      const sanitized = await readSanitizedExactOpenCodeTurnV2({
        projectRoot: internal.projectRoot,
        executablePath: internal.executablePath,
        deadlineMs: internal.timeoutPolicy.deadlineMs,
        signal: controller.signal,
        environment: internal.childEnvironment,
      }, { sessionId: session.openCodeSessionId, userMessageId: intent.openCodeUserMessageId });
      if (assistant.observableTurnDigest === null
        || sanitized.observableTurnDigest === null
        || assistant.observableTurnDigest !== sanitized.observableTurnDigest
        || assistant.sessionId !== sanitized.sessionId
        || assistant.userMessageId !== sanitized.userMessageId
        || assistant.assistantMessageId !== sanitized.assistantMessageId
        || assistant.modelSelector !== sanitized.modelSelector
        || assistant.classification !== sanitized.classification) {
        throw m4d("M4D_PROVIDER_RESULT_INVALID", "M4D_PROVIDER_RESULT_INVALID: live and sanitized turn identity differ");
      }
    } finally {
      clearTimeout(timer);
    }
    if (timedOut) throw m4d("M4D_PHYSICAL_STATE_UNKNOWN", "M4D_PHYSICAL_STATE_UNKNOWN: audit dispatch exceeded its deadline");
    if (assistant.modelSelector !== descriptor.modelSelector) throw m4d("M4D_MODEL_MISMATCH");
    if (assistant.classification !== "SUCCEEDED") throw m4d("M4D_PROVIDER_RESULT_INVALID", "M4D_PROVIDER_RESULT_INVALID: provider turn did not succeed");

    const proposal = parseOpenCodeAuditProposalV2(assistantTurnTextV2(assistant), auditPackage);
    const result = createAuditProviderResultV2({
      runId: descriptor.runId, phaseId: descriptor.phaseId, taskId: descriptor.taskId, attemptId,
      auditInvocationId: descriptor.auditInvocationId,
      descriptorDigest: descriptor.descriptorDigest, dispatchIntentDigest: intent.intentDigest,
      sessionBindingDigest: session.bindingDigest, promptArtifactDigest: promptArtifact.artifactDigest,
      auditPackageId, auditPackageDigest: auditPackage.packageDigest,
      openCodeSessionId: session.openCodeSessionId, openCodeUserMessageId: intent.openCodeUserMessageId,
      assistantMessageId: assistant.assistantMessageId, observedModelSelector: assistant.modelSelector,
      classification: "SUCCEEDED", assistantContentDigest: assistant.assistantContentDigest,
      responseDigest: assistant.responseDigest, observableTurnDigest: assistant.observableTurnDigest,
      proposal, startedAt, finishedAt: internal.clock(),
    });
    await persistAuditProviderResultV2(internal.store, result, internal.nonceFactory());

    // ── 5. Positive quiescence, then the workspace immutability proof ───────
    const outcome = await settle("M4-D audit completed");
    const processState = await internal.processIdentityProvider.inspect(workerReceipt.processIdentity);
    const treeState = internal.processTreeInspector.inspect({ processIdentity: workerReceipt.processIdentity, processGroupId: workerReceipt.processGroupId });
    if (!outcome.observed || !outcome.quiescent || !outcome.verified || processState !== "ABSENT" || treeState !== "QUIESCENT") {
      throw m4d("M4D_PROCESS_TREE_NOT_QUIESCENT");
    }
    const after = await fingerprintWorkspace(internal.projectRoot, snapshot.workspacePolicy);
    if (after.fingerprintDigest !== before.fingerprintDigest
      || after.controlPlaneFingerprint !== before.controlPlaneFingerprint
      || after.productWorkspaceFingerprint !== before.productWorkspaceFingerprint) {
      throw m4d("M4D_WORKSPACE_MUTATED_BY_AUDITOR", "M4D_WORKSPACE_MUTATED_BY_AUDITOR: the Auditor changed the workspace it audited");
    }
    const terminal = createAuditProviderTerminalArtifactV2({
      runId: descriptor.runId, phaseId: descriptor.phaseId, taskId: descriptor.taskId, attemptId,
      auditInvocationId: descriptor.auditInvocationId,
      descriptorDigest: descriptor.descriptorDigest, dispatchIntentDigest: intent.intentDigest,
      workerReceiptDigest: workerReceipt.receiptDigest, sessionBindingDigest: session.bindingDigest,
      openCodeSessionId: session.openCodeSessionId,
      status: "SUCCEEDED", termination: "NORMAL", exitCode: 0, signal: null, timedOut: false, cancelled: false,
      resultDigest: result.resultDigest,
      workspaceFingerprintBefore: before.fingerprintDigest,
      workspaceFingerprintAfter: after.fingerprintDigest,
      finishedAt: result.finishedAt,
      quiescence: { workerProcessState: "ABSENT", processTreeState: "QUIESCENT", observedAt: internal.clock() },
    });
    await persistAuditProviderTerminalArtifactV2(internal.store, terminal, internal.nonceFactory());
    return envelopeFromDurableAuditV2(descriptor, promptArtifact, result);
  } finally {
    if (!settled) await settle("M4-D audit scope ended").catch(() => undefined);
  }
}

/**
 * Every field of the untrusted envelope Core receives is either the validated
 * structured proposal or a Core/provider-artifact fact. No provider prose and
 * no provider identity crosses this boundary.
 */
function envelopeFromDurableAuditV2(
  descriptor: AuditProviderDescriptorV2,
  prompt: AuditProviderPromptArtifactV2,
  result: AuditProviderResultV2,
): AuditorResultEnvelopeV2 {
  const proposal: OpenCodeAuditProposalV2 = result.proposal;
  const envelope: AuditorResultEnvelopeV2 = Object.freeze({
    verdict: proposal.verdict,
    proposedFindings: Object.freeze(proposal.proposedFindings.map((finding) => Object.freeze({ ...finding }))),
    resolvedFindingRefs: Object.freeze([...proposal.resolvedFindingRefs]),
    rationale: proposal.rationale,
    metadata: Object.freeze({
      role: OPENCODE_CLI_AUDITOR_ROLE_V2,
      transport: OPENCODE_CLI_AUDITOR_TRANSPORT_V2,
      transportVersion: OPENCODE_CLI_AUDITOR_TRANSPORT_VERSION_V2,
      model: descriptor.modelSelector,
      auditorRuntimeIdentity: descriptor.auditorRuntimeIdentity,
      auditorProfileDigest: descriptor.auditorProfileDigest,
      permissionsDigest: descriptor.permissionsDigest,
      openCodeSessionId: result.openCodeSessionId,
      openCodeUserMessageId: result.openCodeUserMessageId,
      assistantMessageId: result.assistantMessageId,
      observableTurnDigest: result.observableTurnDigest,
      promptDigest: prompt.promptDigest,
      proposalDigest: result.proposalDigest,
      providerResultDigest: result.resultDigest,
    }),
  });
  assertAuditorResultEnvelopeV2(envelope);
  return envelope;
}

/** Bounded text projection of the exact Core-bound assistant turn. */
function assistantTurnTextV2(assistant: OpenCodeAssistantResultV2): string {
  const chunks: string[] = [];
  for (const part of assistant.parts) {
    if (!part || typeof part !== "object" || Array.isArray(part)) continue;
    const record = part as Record<string, unknown>;
    if (record.type !== "text" || typeof record.text !== "string") continue;
    chunks.push(record.text);
  }
  return chunks.join("\n");
}

function assertCoreAuditBindingV2(
  internal: OpenCodeCliAuditorInternalsV2,
  coreDescriptor: AuditInvocationDescriptorV2,
  auditPackage: AuditPackageV2,
  auditPackageId: string,
): void {
  const expected = auditInvocationIdV2({
    runId: auditPackage.runId,
    phaseId: auditPackage.phaseId,
    taskId: auditPackage.taskId,
    attemptId: auditPackage.attemptId,
    auditPackageId,
    auditPackageDigest: auditPackage.packageDigest,
    auditorIdentity: internal.runtimeIdentity,
    auditorProfileId: OPENCODE_CLI_AUDITOR_CORE_PROFILE_ID_V2,
    auditorProfileDigest: internal.profileDigest,
  });
  if (coreDescriptor.auditInvocationId !== expected
    || coreDescriptor.runId !== auditPackage.runId
    || coreDescriptor.phaseId !== auditPackage.phaseId
    || coreDescriptor.taskId !== auditPackage.taskId
    || coreDescriptor.attemptId !== auditPackage.attemptId
    || coreDescriptor.auditPackageId !== auditPackageId
    || coreDescriptor.auditPackageDigest !== auditPackage.packageDigest
    || coreDescriptor.auditorIdentity !== internal.runtimeIdentity
    || coreDescriptor.auditorProfileId !== OPENCODE_CLI_AUDITOR_CORE_PROFILE_ID_V2
    || coreDescriptor.auditorProfileDigest !== internal.profileDigest) {
    throw m4d("M4D_AUDIT_INVOCATION_BINDING_INVALID", "M4D_AUDIT_INVOCATION_BINDING_INVALID: Core audit invocation does not bind this AuditPackage and Auditor");
  }
}

async function assertPreAuditPromptDurabilityV2(
  internal: OpenCodeCliAuditorInternalsV2,
  descriptor: AuditProviderDescriptorV2,
  auditPackage: AuditPackageV2,
  promptArtifact: AuditProviderPromptArtifactV2,
  sessionBindingDigest: string,
): Promise<void> {
  const facts = await readAuditProviderArtifactSetV2(internal.store, descriptor.attemptId);
  const prompt = await readAuditProviderPromptArtifactV2(internal.store, descriptor.attemptId);
  if (facts.descriptor?.descriptorDigest !== descriptor.descriptorDigest
    || !facts.dispatchIntent || !facts.workerReceipt
    || facts.sessionBinding?.bindingDigest !== sessionBindingDigest
    || prompt?.artifactDigest !== promptArtifact.artifactDigest
    || prompt.openCodeUserMessageId !== facts.dispatchIntent.openCodeUserMessageId
    || prompt.openCodeSessionId !== facts.sessionBinding.openCodeSessionId) {
    throw m4d("M4D_PROMPT_ORDER_INVALID", "M4D_PROMPT_ORDER_INVALID: the audit dispatch chain is not durable before the prompt");
  }
  if (facts.result || facts.terminal) throw m4d("M4D_REDISPATCH_FORBIDDEN");
  // The read-only policy, the conformance record and the audited workspace must
  // still be exactly what the descriptor bound, immediately before dispatch.
  assertReadOnlyAuditPermissionsV2(internal.permissions);
  if (internal.permissions.policyDigest !== descriptor.permissionsDigest) throw m4d("M4D_PERMISSIONS_NOT_READ_ONLY");
  const snapshot = await internal.store.verifyRunSnapshot();
  const workspace = await fingerprintWorkspace(internal.projectRoot, snapshot.workspacePolicy);
  if (workspace.fingerprintDigest !== descriptor.baseWorkspaceFingerprint || workspace.fingerprintDigest !== auditPackage.workspaceFingerprint) {
    throw m4d("M4D_WORKSPACE_BINDING_INVALID", "M4D_WORKSPACE_BINDING_INVALID: workspace changed before the audit prompt");
  }
  if (sha256Canonical(await loadExactConformanceRecordV2()) !== descriptor.conformanceRecordDigest) throw m4d("M4D_CONFORMANCE_REQUIRED");
  const coreDescriptor = await readAuditInvocationDescriptorV2(internal.store, descriptor.attemptId);
  if (!coreDescriptor || coreDescriptor.auditInvocationId !== descriptor.auditInvocationId) throw m4d("M4D_AUDIT_INVOCATION_BINDING_INVALID");
  if (await readAuditResultV2(internal.store, descriptor.attemptId)) throw m4d("M4D_AUDIT_ALREADY_RECONCILED");
}

/**
 * One audit is one session. A session already bound to an Executor invocation
 * or to any other audit in this Run is never reused.
 */
async function assertAuditSessionIsDedicatedV2(store: RalphEventStoreV2, attemptId: string, openCodeSessionId: string): Promise<void> {
  const inspected = await store.inspect();
  const attemptIds = new Set<string>([attemptId]);
  for (const event of inspected.events) if (typeof event.attemptId === "string" && event.attemptId.length > 0) attemptIds.add(event.attemptId);
  // Durable bindings are authoritative even for an Attempt whose events this
  // ledger projection does not carry, so the Attempt namespace is enumerated
  // physically as well.
  try {
    for (const entry of await store.fileSystem.readdir(join(store.runDirectory, "attempts"))) {
      if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(entry)) attemptIds.add(entry);
    }
  } catch { /* an absent Attempt namespace simply holds no prior session */ }
  for (const candidate of attemptIds) {
    const executorSession = await readProviderSessionBindingV2(store, candidate);
    if (executorSession?.openCodeSessionId === openCodeSessionId) {
      throw m4d("M4D_SESSION_REUSE_FORBIDDEN", "M4D_SESSION_REUSE_FORBIDDEN: an Executor session may never carry an audit");
    }
    const auditSession = await readAuditProviderSessionBindingV2(store, candidate);
    if (auditSession?.openCodeSessionId === openCodeSessionId) {
      throw m4d("M4D_SESSION_REUSE_FORBIDDEN", "M4D_SESSION_REUSE_FORBIDDEN: this OpenCode session already carried an audit");
    }
  }
}

async function hasDurableAuditStartedV2(store: RalphEventStoreV2, attemptId: string): Promise<boolean> {
  const inspected = await store.inspect();
  return inspected.events.some((event) => event.eventType === "audit.started" && event.attemptId === attemptId);
}

function computedAuditPackageIdV2(auditPackage: AuditPackageV2): string {
  const { schema: _schema, packageDigest: _packageDigest, ...base } = auditPackage;
  return auditPackageIdV2(base);
}

export { RalphM4DError };
