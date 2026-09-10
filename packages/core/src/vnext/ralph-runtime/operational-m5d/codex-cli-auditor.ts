import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { canonicalJson } from "../canonical-json.js";
import { fingerprintWorkspace, type WorkspaceFingerprint } from "../fingerprint.js";
import { sha256, sha256Canonical } from "../hashing.js";
import type { RalphEventStoreV2 } from "../operational-b1/event-store.js";
import { defaultProcessIdentityProvider, type ProcessIdentityProvider } from "../operational-b2/process-identity.js";
import { readAuditPackageV2, validateAuditPackageV2, type AuditPackageV2 } from "../operational-d/artifacts.js";
import {
  auditInvocationIdV2,
  readAuditInvocationDescriptorV2,
  readAuditResultV2,
  type AuditInvocationDescriptorV2,
} from "../operational-e/artifacts.js";
import { assertAuditorResultEnvelopeV2, AuditorRuntimeV2, type AuditorResultEnvelopeV2 } from "../operational-e/auditor-runtime.js";
import { LinuxProviderProcessTreeInspectorV2 } from "../operational-b4/provider-process-tree-inspector.js";
import {
  CODEX_PARENT_ENVIRONMENT_KEYS_V2,
  codexParentEnvironmentV2,
  codexRuntimeReadRootV2,
  codexShellEnvironmentPolicyV2,
  inspectManagedCodexRuntimeV2,
  resolveCodexHomeV2,
  runCodexProcessV2,
  type CodexExecutableIdentityV2,
  type CodexProcessRunV2,
} from "../operational-m5b/codex-process.js";
import { inspectCodexSandboxBackendV2, type CodexSandboxBackendFactsV2 } from "../operational-m5b/codex-sandbox-backend.js";
import { parseExactCodexEventStreamV2 } from "../operational-m5b/codex-jsonl.js";
import { validateM5BTimeoutPolicyV2, type M5BTimeoutPolicyV2 } from "../operational-m5b/contract.js";
import type { CodexManagedRuntimeIdentityV2 } from "../operational-m5b/codex-managed-runtime.js";
import {
  assertCodexAuditorPermissionProfileV2,
  buildCodexAuditorPermissionProfileV2,
  codexAuditorPermissionFactsV2,
  codexAuditorPermissionPolicyShapeDigestV2,
  type CodexAuditorPermissionProfileV2,
} from "./codex-audit-permission-profile.js";
import {
  assertCodexAuditorPhysicalCapabilityV2,
  codexAuditorCapabilityFactsDigestV2,
  probeCodexAuditorPhysicalCapabilityV2,
  type CodexAuditorCapabilityProbeV2,
} from "./codex-audit-capability.js";
import { projectAuditPackageToCodexPromptV2 } from "./codex-audit-prompt.js";
import {
  assertCodexAuditFinalMessageV2,
  codexAuditOutputSchemaJsonV2,
  validateCodexAuditProposalV2,
  validateExactCodexAuditOutputV2,
} from "./codex-audit-output.js";
import { buildCodexAuditorExecArgvV2, codexAuditorArgvDigestV2, codexAuditorArgvFactsV2 } from "./codex-audit-transport.js";
import {
  RALPH_CODEX_AUDIT_DISPATCH_INTENT_SCHEMA_V2,
  RALPH_CODEX_AUDIT_PROCESS_RECEIPT_SCHEMA_V2,
  RALPH_CODEX_AUDIT_PROMPT_SCHEMA_V2,
  RALPH_CODEX_AUDIT_PROVIDER_DESCRIPTOR_SCHEMA_V2,
  RALPH_CODEX_AUDIT_PROVIDER_RESULT_SCHEMA_V2,
  RALPH_CODEX_AUDIT_TERMINAL_SCHEMA_V2,
  RALPH_CODEX_AUDIT_THREAD_BINDING_SCHEMA_V2,
  codexAuditDispatchIntentRefV2,
  codexAuditProcessReceiptRefV2,
  codexAuditProviderDescriptorRefV2,
  codexAuditProviderResultRefV2,
  codexAuditPromptRefV2,
  persistCodexAuditDispatchIntentV2,
  persistCodexAuditProcessReceiptV2,
  persistCodexAuditPromptArtifactV2,
  persistCodexAuditProviderDescriptorV2,
  persistCodexAuditProviderResultV2,
  persistCodexAuditTerminalArtifactV2,
  persistCodexAuditThreadBindingV2,
  readCodexAuditArtifactSetV2,
  sealCodexAuditArtifactV2,
  type CodexAuditDispatchIntentV2,
  type CodexAuditProcessReceiptV2,
  type CodexAuditPromptArtifactV2,
  type CodexAuditProviderDescriptorV2,
  type CodexAuditProviderResultV2,
  type CodexAuditTerminalArtifactV2,
  type CodexAuditThreadBindingV2,
} from "./codex-audit-artifacts.js";
import {
  CODEX_CLI_AUDITOR_CLI_VERSION_V2,
  CODEX_CLI_AUDITOR_PROFILE_IDENTITY_V2,
  CODEX_CLI_AUDITOR_PROFILE_ID_V2,
  CODEX_CLI_AUDITOR_PROVIDER_V2,
  CODEX_CLI_AUDITOR_REASONING_EFFORT_V2,
  CODEX_CLI_AUDITOR_REQUESTED_MODEL_V2,
  CODEX_CLI_AUDITOR_ROLE_V2,
  CODEX_CLI_AUDITOR_TRANSPORT_V2,
  codexAuditorRuntimeIdentityV2,
  computedAuditPackageIdV2,
  m5d,
  RalphM5DError,
} from "./contract.js";

const AUDITOR_SEAL = Symbol("CodexCliAuditorV2");
const trustedCodexAuditors = new WeakSet<CodexCliAuditorV2>();

interface CodexAuditorInternalsV2 {
  readonly store: RalphEventStoreV2;
  readonly auditPackage: AuditPackageV2;
  readonly timeoutPolicy: M5BTimeoutPolicyV2;
  readonly executable: CodexExecutableIdentityV2;
  readonly managedRuntime: CodexManagedRuntimeIdentityV2;
  readonly permissionProfile: CodexAuditorPermissionProfileV2;
  readonly capability: CodexAuditorCapabilityProbeV2;
  readonly capabilityDigest: string;
  readonly sandboxBackend: CodexSandboxBackendFactsV2;
  readonly codexHome: string;
  readonly ioBase: string;
  readonly processIdentityProvider: ProcessIdentityProvider;
  readonly processTreeInspector: LinuxProviderProcessTreeInspectorV2;
  readonly clock: () => string;
  readonly nonceFactory: () => string;
  readonly runtimeIdentity: string;
  readonly profileDigest: string;
  physicalDispatches: number;
}

const auditorInternals = new WeakMap<CodexCliAuditorV2, CodexAuditorInternalsV2>();

export interface CreateCodexCliAuditorV2Input {
  readonly store: RalphEventStoreV2;
  /** The exact already-durable Core AuditPackage this nominal runtime owns. */
  readonly auditPackage: AuditPackageV2;
  readonly timeoutPolicy: M5BTimeoutPolicyV2;
  readonly ioBase?: string;
  readonly processIdentityProvider?: ProcessIdentityProvider;
  readonly clock?: () => string;
  readonly nonceFactory?: () => string;
}

/** Real managed Codex Auditor. It exposes no ExecutorRuntime authority. */
export class CodexCliAuditorV2 extends AuditorRuntimeV2 {
  readonly kind = "AUDITOR_RUNTIME" as const;
  readonly runtimeIdentity: string;
  readonly profileId = CODEX_CLI_AUDITOR_PROFILE_ID_V2;
  readonly profileDigest: string;

  constructor(internals: CodexAuditorInternalsV2, seal: symbol) {
    super();
    if (new.target !== CodexCliAuditorV2 || seal !== AUDITOR_SEAL) throw m5d("M5D_AUDITOR_AUTHORITY_REQUIRED");
    this.runtimeIdentity = internals.runtimeIdentity;
    this.profileDigest = internals.profileDigest;
    auditorInternals.set(this, internals);
    trustedCodexAuditors.add(this);
    Object.freeze(this);
  }

  async invoke(auditPackage: AuditPackageV2): Promise<AuditorResultEnvelopeV2> {
    return runCodexAuditV2(requireInternals(this), auditPackage);
  }

  get physicalDispatches(): number { return auditorInternals.get(this)?.physicalDispatches ?? 0; }
}

export async function createCodexCliAuditorV2(input: CreateCodexCliAuditorV2Input): Promise<CodexCliAuditorV2> {
  validateM5BTimeoutPolicyV2(input.timeoutPolicy);
  validateAuditPackageV2(input.auditPackage);
  if (!isAbsolute(input.store.projectRoot) || resolve(input.store.projectRoot) !== input.store.projectRoot || input.store.runId !== input.auditPackage.runId) throw m5d("M5D_WORKSPACE_BINDING_INVALID");
  const durablePackage = await readAuditPackageV2(input.store, input.auditPackage.attemptId);
  if (!durablePackage || canonicalJson(durablePackage) !== canonicalJson(input.auditPackage)) throw m5d("M5D_AUDIT_PACKAGE_BINDING_INVALID", "M5D_AUDIT_PACKAGE_BINDING_INVALID: package is not exact durable Core authority");
  if (process.platform !== "linux" || process.arch !== "x64") throw m5d("M5D_MANAGED_RUNTIME_INVALID", "M5D_MANAGED_RUNTIME_INVALID: qualified platform is linux-x86_64 only");

  const codexHome = resolveCodexHomeV2();
  const { executable, managedRuntime } = await inspectManagedCodexRuntimeV2(input.timeoutPolicy.deadlineMs).catch((error) => { throw m5d("M5D_MANAGED_RUNTIME_INVALID", undefined, error); });
  const sandboxBackend = await inspectCodexSandboxBackendV2().catch((error) => { throw m5d("M5D_SANDBOX_BACKEND_INVALID", undefined, error); });
  const permissionProfile = buildCodexAuditorPermissionProfileV2({
    productWorkspace: input.store.projectRoot,
    codexHome,
    codexRuntimeReadRoot: codexRuntimeReadRootV2(executable.executablePath),
  });
  const capability = await probeCodexAuditorPhysicalCapabilityV2({ deadlineMs: input.timeoutPolicy.deadlineMs, codexHome, executablePath: executable.executablePath });
  assertCodexAuditorPhysicalCapabilityV2(capability, permissionProfile);
  const capabilityDigest = codexAuditorCapabilityFactsDigestV2(capability);
  const profileDigest = sha256Canonical({
    role: CODEX_CLI_AUDITOR_ROLE_V2,
    profileId: CODEX_CLI_AUDITOR_PROFILE_IDENTITY_V2,
    managedRuntimeIdentityDigest: managedRuntime.identityDigest,
    permissionProfileDigest: permissionProfile.profileDigest,
    capabilityDigest,
    requestedModel: CODEX_CLI_AUDITOR_REQUESTED_MODEL_V2,
    auditPackageId: computedAuditPackageIdV2(input.auditPackage),
    auditPackageDigest: input.auditPackage.packageDigest,
    timeoutPolicyDigest: input.timeoutPolicy.policyDigest,
  });
  if (input.ioBase !== undefined && (!isAbsolute(input.ioBase) || resolve(input.ioBase) !== input.ioBase)) throw m5d("M5D_WORKSPACE_BINDING_INVALID", "M5D_WORKSPACE_BINDING_INVALID: audit I/O base must be absolute and normalized");
  const ioBase = resolve(input.ioBase ?? tmpdir());
  if (ioBase === input.store.projectRoot || ioBase.startsWith(`${input.store.projectRoot}/`) || ioBase === codexHome || ioBase.startsWith(`${codexHome}/`)) throw m5d("M5D_WORKSPACE_BINDING_INVALID", "M5D_WORKSPACE_BINDING_INVALID: audit I/O must be outside workspace and CODEX_HOME");
  const internals: CodexAuditorInternalsV2 = {
    store: input.store,
    auditPackage: Object.freeze(input.auditPackage),
    timeoutPolicy: Object.freeze({ ...input.timeoutPolicy }),
    executable, managedRuntime, permissionProfile, capability, capabilityDigest, sandboxBackend, codexHome, ioBase,
    processIdentityProvider: input.processIdentityProvider ?? defaultProcessIdentityProvider,
    processTreeInspector: new LinuxProviderProcessTreeInspectorV2(),
    clock: input.clock ?? (() => new Date().toISOString()),
    nonceFactory: input.nonceFactory ?? randomUUID,
    runtimeIdentity: codexAuditorRuntimeIdentityV2({ managedRuntime, permissionProfileDigest: permissionProfile.profileDigest, capabilityDigest, auditPackage: input.auditPackage, timeoutPolicyDigest: input.timeoutPolicy.policyDigest }),
    profileDigest,
    physicalDispatches: 0,
  };
  return new CodexCliAuditorV2(internals, AUDITOR_SEAL);
}

export function isGenuineCodexCliAuditorV2(value: unknown): value is CodexCliAuditorV2 {
  return typeof value === "object" && value !== null && trustedCodexAuditors.has(value as CodexCliAuditorV2);
}
export function assertGenuineCodexCliAuditorV2(value: unknown): asserts value is CodexCliAuditorV2 {
  if (!isGenuineCodexCliAuditorV2(value)) throw m5d("M5D_AUDITOR_AUTHORITY_REQUIRED");
}
function requireInternals(value: CodexCliAuditorV2): CodexAuditorInternalsV2 {
  assertGenuineCodexCliAuditorV2(value); const internals = auditorInternals.get(value); if (!internals) throw m5d("M5D_AUDITOR_AUTHORITY_REQUIRED"); return internals;
}

async function runCodexAuditV2(internal: CodexAuditorInternalsV2, auditPackage: AuditPackageV2): Promise<AuditorResultEnvelopeV2> {
  try { validateAuditPackageV2(auditPackage); } catch (error) { throw m5d("M5D_AUDIT_PACKAGE_INVALID", undefined, error); }
  if (canonicalJson(auditPackage) !== canonicalJson(internal.auditPackage)) throw m5d("M5D_AUDIT_PACKAGE_BINDING_INVALID", "M5D_AUDIT_PACKAGE_BINDING_INVALID: caller replaced the bound package");
  const attemptId = auditPackage.attemptId;
  const auditPackageId = computedAuditPackageIdV2(auditPackage);
  const core = await readAuditInvocationDescriptorV2(internal.store, attemptId);
  if (!core) throw m5d("M5D_AUDIT_INVOCATION_REQUIRED");
  assertCoreBinding(internal, core, auditPackage, auditPackageId);
  if (await readAuditResultV2(internal.store, attemptId)) throw m5d("M5D_AUDIT_ALREADY_RECONCILED");
  if (!(await internal.store.inspect()).events.some((event) => event.eventType === "audit.started" && event.attemptId === attemptId)) throw m5d("M5D_AUDIT_INVOCATION_REQUIRED", "M5D_AUDIT_INVOCATION_REQUIRED: audit.started is not durable");

  const existing = await readCodexAuditArtifactSetV2(internal.store, attemptId);
  if (existing.descriptor) {
    assertDescriptorBinding(internal, existing.descriptor, core, auditPackage, auditPackageId);
    if (existing.terminal && existing.providerResult && existing.prompt) return envelopeFromDurable(existing.descriptor, existing.prompt, existing.providerResult, auditPackage);
    if (existing.dispatchIntent) throw m5d("M5D_REDISPATCH_FORBIDDEN", "M5D_PHYSICAL_STATE_UNKNOWN: dispatch intent is durable and no replayable terminal exists");
  }

  // Re-read every managed payload/executable fact directly beside the only
  // physical dispatch path.  Factory-time verification is not a lease on the
  // binary: replacement between construction and invoke must fail closed.
  const currentRuntime = await inspectManagedCodexRuntimeV2(internal.timeoutPolicy.deadlineMs).catch((error) => { throw m5d("M5D_MANAGED_RUNTIME_INVALID", undefined, error); });
  if (canonicalJson(currentRuntime.executable) !== canonicalJson(internal.executable)
    || canonicalJson(currentRuntime.managedRuntime) !== canonicalJson(internal.managedRuntime)) throw m5d("M5D_MANAGED_RUNTIME_INVALID", "M5D_MANAGED_RUNTIME_INVALID: runtime changed before dispatch");
  const currentBackend = await inspectCodexSandboxBackendV2().catch((error) => { throw m5d("M5D_SANDBOX_BACKEND_INVALID", undefined, error); });
  if (currentBackend.backendPath !== "/usr/bin/bwrap" || currentBackend.factsDigest !== internal.sandboxBackend.factsDigest) throw m5d("M5D_SANDBOX_BACKEND_INVALID", "M5D_SANDBOX_BACKEND_INVALID: backend changed before dispatch");
  assertCodexAuditorPermissionProfileV2(internal.permissionProfile);
  assertCodexAuditorPhysicalCapabilityV2(internal.capability, internal.permissionProfile);
  const snapshot = await internal.store.verifyRunSnapshot();
  const before = await fingerprintWorkspace(internal.store.projectRoot, snapshot.workspacePolicy);
  assertWorkspaceBound(before, auditPackage);

  const ioDirectory = resolve(internal.ioBase, `rb-ralph-m5d-audit-${sha256Canonical({ runId: auditPackage.runId, attemptId, auditInvocationId: core.auditInvocationId }).slice(7, 39)}`);
  const outputSchemaPath = resolve(ioDirectory, "audit-output-schema.json");
  const finalOutputPath = resolve(ioDirectory, "audit-final-output.json");
  const outputSchema = codexAuditOutputSchemaJsonV2();
  const argv = buildCodexAuditorExecArgvV2({ productWorkspace: internal.store.projectRoot, outputSchemaPath, finalOutputPath, permissionProfile: internal.permissionProfile });
  const environment = codexParentEnvironmentV2(internal.codexHome);
  const capabilityBindingDigest = sha256Canonical({
    role: CODEX_CLI_AUDITOR_ROLE_V2, managedRuntimeIdentityDigest: internal.managedRuntime.identityDigest,
    permissionProfileDigest: internal.permissionProfile.profileDigest, permissionPolicyShapeDigest: codexAuditorPermissionPolicyShapeDigestV2(internal.permissionProfile),
    capabilityDigest: internal.capabilityDigest, sandboxBackendFactsDigest: internal.sandboxBackend.factsDigest,
  });
  const binding = { runId: auditPackage.runId, phaseId: auditPackage.phaseId, taskId: auditPackage.taskId, attemptId, auditInvocationId: core.auditInvocationId };
  const descriptor = existing.descriptor ?? sealCodexAuditArtifactV2<CodexAuditProviderDescriptorV2>({
    schema: RALPH_CODEX_AUDIT_PROVIDER_DESCRIPTOR_SCHEMA_V2, ...binding, role: CODEX_CLI_AUDITOR_ROLE_V2,
    auditPackageId, auditPackageDigest: auditPackage.packageDigest,
    auditorRuntimeIdentity: internal.runtimeIdentity, auditorProfileId: CODEX_CLI_AUDITOR_PROFILE_ID_V2,
    auditorProfileIdentity: CODEX_CLI_AUDITOR_PROFILE_IDENTITY_V2, auditorProfileDigest: internal.profileDigest,
    provider: CODEX_CLI_AUDITOR_PROVIDER_V2, transport: CODEX_CLI_AUDITOR_TRANSPORT_V2,
    requestedModel: CODEX_CLI_AUDITOR_REQUESTED_MODEL_V2, reasoningEffort: CODEX_CLI_AUDITOR_REASONING_EFFORT_V2,
    observedModelState: "UNAVAILABLE", observedModel: null,
    managedRuntimeKind: internal.managedRuntime.kind, managedRuntimeVersion: internal.managedRuntime.version, managedRuntimeIdentityDigest: internal.managedRuntime.identityDigest,
    executablePath: internal.executable.executablePath, executableVersion: internal.executable.executableVersion,
    executableSizeBytes: internal.executable.executableSizeBytes, executableSha256: internal.executable.executableSha256,
    capabilityDigest: internal.capabilityDigest, capabilityBindingDigest,
    permissionProfileName: internal.permissionProfile.name, permissionProfileDigest: internal.permissionProfile.profileDigest,
    permissionPolicyShapeDigest: codexAuditorPermissionPolicyShapeDigestV2(internal.permissionProfile), permissionProfileFactsDigest: sha256Canonical(codexAuditorPermissionFactsV2(internal.permissionProfile)),
    sandboxBackendPath: internal.sandboxBackend.backendPath, timeoutPolicyDigest: internal.timeoutPolicy.policyDigest,
    projectRootIdentity: sha256Canonical({ projectRoot: resolve(internal.store.projectRoot) }),
    baseWorkspaceFingerprint: before.fingerprintDigest, baseProductWorkspaceFingerprint: before.productWorkspaceFingerprint, baseControlPlaneFingerprint: before.controlPlaneFingerprint,
    argvPolicyDigest: sha256Canonical(codexAuditorArgvFactsV2(argv, internal.permissionProfile)),
    parentEnvironmentPolicyDigest: sha256Canonical({ keys: [...CODEX_PARENT_ENVIRONMENT_KEYS_V2], present: Object.keys(environment).sort() }),
    shellEnvironmentPolicyDigest: sha256Canonical({ inherit: "none", set: codexShellEnvironmentPolicyV2() }),
    outputSchemaDigest: sha256(outputSchema), createdAt: core.startedAt,
  }, "descriptorDigest");
  if (!existing.descriptor) await persistCodexAuditProviderDescriptorV2(internal.store, descriptor, internal.nonceFactory());

  const projected = projectAuditPackageToCodexPromptV2(auditPackage);
  const promptArtifact = existing.prompt ?? sealCodexAuditArtifactV2<CodexAuditPromptArtifactV2>({
    schema: RALPH_CODEX_AUDIT_PROMPT_SCHEMA_V2, ...binding, descriptorDigest: descriptor.descriptorDigest,
    auditPackageId, auditPackageDigest: auditPackage.packageDigest, promptDigest: projected.promptDigest,
    promptBytes: projected.byteLength, outputSchemaDigest: sha256(outputSchema), preparedAt: core.startedAt,
  }, "artifactDigest");
  if (!existing.prompt) await persistCodexAuditPromptArtifactV2(internal.store, promptArtifact, internal.nonceFactory());

  await rm(ioDirectory, { recursive: true, force: true });
  await mkdir(ioDirectory, { recursive: true, mode: 0o700 });
  await writeFile(outputSchemaPath, outputSchema, { mode: 0o600 });
  const intent = sealCodexAuditArtifactV2<CodexAuditDispatchIntentV2>({
    schema: RALPH_CODEX_AUDIT_DISPATCH_INTENT_SCHEMA_V2, ...binding,
    descriptorRef: codexAuditProviderDescriptorRefV2(attemptId), descriptorDigest: descriptor.descriptorDigest,
    promptRef: codexAuditPromptRefV2(attemptId), promptArtifactDigest: promptArtifact.artifactDigest,
    dispatchId: `codex-audit-dispatch-${sha256Canonical({ role: CODEX_CLI_AUDITOR_ROLE_V2, auditInvocationId: core.auditInvocationId, descriptorDigest: descriptor.descriptorDigest }).slice(7, 39)}`,
    argvDigest: codexAuditorArgvDigestV2(argv), ioDirectoryIdentity: sha256Canonical({ ioDirectory }),
    workspaceFingerprintBefore: before.fingerprintDigest, productWorkspaceFingerprintBefore: before.productWorkspaceFingerprint, controlPlaneFingerprintBefore: before.controlPlaneFingerprint,
    createdAt: core.startedAt,
  }, "intentDigest");
  await persistCodexAuditDispatchIntentV2(internal.store, intent, internal.nonceFactory());

  let threadBinding: CodexAuditThreadBindingV2 | undefined;
  let threadBindingError: unknown;
  let pendingThread: Promise<void> = Promise.resolve();
  let scanned = "";
  let threadSeen = false;
  internal.physicalDispatches += 1;
  let run: CodexProcessRunV2;
  try {
    run = await runCodexProcessV2({
      executablePath: internal.executable.executablePath, argv, cwd: internal.store.projectRoot, environment,
      stdin: projected.text, deadlineMs: internal.timeoutPolicy.deadlineMs,
      onSpawned: async (spawned) => {
        const receipt = sealCodexAuditArtifactV2<CodexAuditProcessReceiptV2>({
          schema: RALPH_CODEX_AUDIT_PROCESS_RECEIPT_SCHEMA_V2, ...binding,
          descriptorDigest: descriptor.descriptorDigest, dispatchIntentDigest: intent.intentDigest, dispatchId: intent.dispatchId,
          processIdentity: { ...spawned.processIdentity }, processGroupId: spawned.processGroupId,
          containmentKind: spawned.containmentKind, containmentStructural: spawned.containmentStructural, startedAt: spawned.startedAt,
        }, "receiptDigest");
        await persistCodexAuditProcessReceiptV2(internal.store, receipt, internal.nonceFactory());
      },
      onBeforeStdin: async () => assertImmediatelyBeforePrompt(internal, auditPackage, descriptor, promptArtifact, intent, before),
      onStdoutChunk: (chunk) => {
        if (threadSeen) return;
        scanned = `${scanned}${chunk}`.slice(-8192);
        const match = scanned.match(/"thread_id"\s*:\s*"([A-Za-z0-9][A-Za-z0-9._:-]{1,190})"/);
        if (!match?.[1]) return;
        threadSeen = true;
        const threadId = match[1];
        pendingThread = pendingThread.then(async () => {
          const artifacts = await readCodexAuditArtifactSetV2(internal.store, attemptId);
          if (!artifacts.processReceipt) throw m5d("M5D_THREAD_BINDING_INVALID", "M5D_THREAD_BINDING_INVALID: process receipt missing");
          const artifact = sealCodexAuditArtifactV2<CodexAuditThreadBindingV2>({
            schema: RALPH_CODEX_AUDIT_THREAD_BINDING_SCHEMA_V2, ...binding,
            descriptorDigest: descriptor.descriptorDigest, dispatchIntentDigest: intent.intentDigest,
            processReceiptDigest: artifacts.processReceipt.receiptDigest, threadId, boundAt: internal.clock(),
          }, "bindingDigest");
          await persistCodexAuditThreadBindingV2(internal.store, artifact, internal.nonceFactory());
          threadBinding = artifact;
        }).catch((error) => { threadBindingError = error; });
      },
    });
  } catch (error) {
    await pendingThread;
    if (error instanceof RalphM5DError) throw error;
    throw m5d("M5D_PHYSICAL_STATE_UNKNOWN", "M5D_PHYSICAL_STATE_UNKNOWN: process may have crossed", error);
  }
  await pendingThread;
  if (threadBindingError) throw m5d("M5D_THREAD_BINDING_INVALID", undefined, threadBindingError);

  const after = await fingerprintWorkspace(internal.store.projectRoot, snapshot.workspacePolicy);
  assertWorkspaceEqual(before, after);
  if (run.timedOut || run.cancelled || run.exitCode !== 0 || run.signal !== null || !run.processIdentity) throw m5d("M5D_PHYSICAL_STATE_UNKNOWN", "M5D_PHYSICAL_STATE_UNKNOWN: unsuccessful child terminal");
  const stream = parseExactCodexEventStreamV2(run.stdout, { truncated: run.stdoutTruncated });
  if (!threadBinding || threadBinding.threadId !== stream.threadId) throw m5d("M5D_THREAD_BINDING_INVALID");
  if (stream.terminal !== "TURN_COMPLETED") throw m5d("M5D_TERMINAL_REQUIRED");
  const raw = await readFile(finalOutputPath, "utf8").catch((error) => { throw m5d("M5D_PROVIDER_RESULT_INVALID", "M5D_PROVIDER_RESULT_INVALID: -o missing", error); });
  const structured = validateExactCodexAuditOutputV2(raw, auditPackage);
  assertCodexAuditFinalMessageV2(stream.finalAgentMessage, structured);
  const result = sealCodexAuditArtifactV2<CodexAuditProviderResultV2>({
    schema: RALPH_CODEX_AUDIT_PROVIDER_RESULT_SCHEMA_V2, ...binding,
    descriptorDigest: descriptor.descriptorDigest, dispatchIntentDigest: intent.intentDigest, promptArtifactDigest: promptArtifact.artifactDigest,
    auditPackageId, auditPackageDigest: auditPackage.packageDigest, auditorRuntimeIdentity: internal.runtimeIdentity,
    managedRuntimeIdentityDigest: internal.managedRuntime.identityDigest, threadBindingDigest: threadBinding.bindingDigest, threadId: threadBinding.threadId,
    requestedModel: CODEX_CLI_AUDITOR_REQUESTED_MODEL_V2, observedModelState: "UNAVAILABLE", observedModel: null,
    classification: "SUCCEEDED", terminalKind: stream.terminal, proposal: structured.proposal, proposalDigest: structured.proposalDigest,
    structuredResultDigest: structured.proposalDigest, finalAgentMessageDigest: stream.finalAgentMessageDigest!, eventStreamDigest: stream.streamDigest,
    eventCount: stream.eventCount, agentMessageCount: stream.agentMessageCount, commandExecutionCount: stream.commandExecutionCount,
    usageInputCount: stream.usageInputTokens, usageOutputCount: stream.usageOutputTokens,
    actualExitCode: run.exitCode, actualSignal: null,
    workspaceFingerprintBefore: before.fingerprintDigest, workspaceFingerprintAfter: after.fingerprintDigest,
    productWorkspaceFingerprintBefore: before.productWorkspaceFingerprint, productWorkspaceFingerprintAfter: after.productWorkspaceFingerprint,
    controlPlaneFingerprintBefore: before.controlPlaneFingerprint, controlPlaneFingerprintAfter: after.controlPlaneFingerprint,
    startedAt: run.startedAt, finishedAt: run.finishedAt,
  }, "resultDigest");
  await persistCodexAuditProviderResultV2(internal.store, result, internal.nonceFactory());

  const processState = await internal.processIdentityProvider.inspect(run.processIdentity);
  const treeState = internal.processTreeInspector.inspect({ processIdentity: run.processIdentity, processGroupId: run.processGroupId });
  if (processState !== "ABSENT" || treeState !== "QUIESCENT" || !run.settlement.observed || !run.settlement.quiescent || !run.settlement.verified) throw m5d("M5D_PROCESS_TREE_NOT_QUIESCENT");
  const qBase = { processState: "ABSENT" as const, processTreeState: "QUIESCENT" as const, settlementObserved: true as const, settlementQuiescent: true as const, settlementVerified: true as const, observedAt: internal.clock() };
  const terminal = sealCodexAuditArtifactV2<CodexAuditTerminalArtifactV2>({
    schema: RALPH_CODEX_AUDIT_TERMINAL_SCHEMA_V2, ...binding,
    descriptorDigest: descriptor.descriptorDigest, dispatchIntentDigest: intent.intentDigest,
    processReceiptDigest: (await readCodexAuditArtifactSetV2(internal.store, attemptId)).processReceipt!.receiptDigest,
    threadBindingDigest: threadBinding.bindingDigest, status: "SUCCEEDED", termination: "NORMAL", exitCode: 0, signal: null,
    timedOut: false, cancelled: false, resultRef: codexAuditProviderResultRefV2(attemptId), resultDigest: result.resultDigest,
    workspaceFingerprintBefore: before.fingerprintDigest, workspaceFingerprintAfter: after.fingerprintDigest,
    quiescence: Object.freeze({ ...qBase, evidenceDigest: sha256Canonical(qBase) }), finishedAt: run.finishedAt,
  }, "terminalDigest");
  await persistCodexAuditTerminalArtifactV2(internal.store, terminal, internal.nonceFactory());
  return envelopeFromDurable(descriptor, promptArtifact, result, auditPackage);
}

function assertCoreBinding(internal: CodexAuditorInternalsV2, core: AuditInvocationDescriptorV2, pkg: AuditPackageV2, packageId: string): void {
  const expected = auditInvocationIdV2({ runId: pkg.runId, phaseId: pkg.phaseId, taskId: pkg.taskId, attemptId: pkg.attemptId, auditPackageId: packageId, auditPackageDigest: pkg.packageDigest, auditorIdentity: internal.runtimeIdentity, auditorProfileId: CODEX_CLI_AUDITOR_PROFILE_ID_V2, auditorProfileDigest: internal.profileDigest });
  if (core.auditInvocationId !== expected || core.runId !== pkg.runId || core.phaseId !== pkg.phaseId || core.taskId !== pkg.taskId || core.attemptId !== pkg.attemptId || core.auditPackageId !== packageId || core.auditPackageDigest !== pkg.packageDigest || core.auditorIdentity !== internal.runtimeIdentity || core.auditorProfileId !== CODEX_CLI_AUDITOR_PROFILE_ID_V2 || core.auditorProfileDigest !== internal.profileDigest) throw m5d("M5D_AUDIT_PACKAGE_BINDING_INVALID", "M5D_AUDIT_PACKAGE_BINDING_INVALID: Core descriptor");
}
function assertDescriptorBinding(internal: CodexAuditorInternalsV2, descriptor: CodexAuditProviderDescriptorV2, core: AuditInvocationDescriptorV2, pkg: AuditPackageV2, packageId: string): void {
  if (descriptor.runId !== pkg.runId || descriptor.phaseId !== pkg.phaseId || descriptor.taskId !== pkg.taskId || descriptor.attemptId !== pkg.attemptId || descriptor.auditInvocationId !== core.auditInvocationId || descriptor.auditPackageId !== packageId || descriptor.auditPackageDigest !== pkg.packageDigest || descriptor.auditorRuntimeIdentity !== internal.runtimeIdentity || descriptor.auditorProfileDigest !== internal.profileDigest || descriptor.permissionProfileDigest !== internal.permissionProfile.profileDigest || descriptor.capabilityDigest !== internal.capabilityDigest || descriptor.managedRuntimeIdentityDigest !== internal.managedRuntime.identityDigest || descriptor.timeoutPolicyDigest !== internal.timeoutPolicy.policyDigest) throw m5d("M5D_AUDIT_PACKAGE_BINDING_INVALID", "M5D_AUDIT_PACKAGE_BINDING_INVALID: provider descriptor");
}
async function assertImmediatelyBeforePrompt(internal: CodexAuditorInternalsV2, pkg: AuditPackageV2, descriptor: CodexAuditProviderDescriptorV2, prompt: CodexAuditPromptArtifactV2, intent: CodexAuditDispatchIntentV2, before: WorkspaceFingerprint): Promise<void> {
  const facts = await readCodexAuditArtifactSetV2(internal.store, pkg.attemptId);
  if (facts.descriptor?.descriptorDigest !== descriptor.descriptorDigest || facts.prompt?.artifactDigest !== prompt.artifactDigest || facts.dispatchIntent?.intentDigest !== intent.intentDigest || !facts.processReceipt || facts.threadBinding || facts.providerResult || facts.terminal) throw m5d("M5D_ARTIFACT_INVALID", "M5D_ARTIFACT_INVALID: pre-prompt chain");
  assertCodexAuditorPermissionProfileV2(internal.permissionProfile); assertCodexAuditorPhysicalCapabilityV2(internal.capability, internal.permissionProfile);
  const current = await fingerprintWorkspace(internal.store.projectRoot, (await internal.store.verifyRunSnapshot()).workspacePolicy);
  assertWorkspaceEqual(before, current); assertWorkspaceBound(current, pkg);
  if ((await readAuditInvocationDescriptorV2(internal.store, pkg.attemptId))?.auditInvocationId !== descriptor.auditInvocationId || await readAuditResultV2(internal.store, pkg.attemptId)) throw m5d("M5D_AUDIT_PACKAGE_BINDING_INVALID");
}
function assertWorkspaceBound(value: WorkspaceFingerprint, pkg: AuditPackageV2): void { if (value.fingerprintDigest !== pkg.workspaceFingerprint) throw m5d("M5D_WORKSPACE_BINDING_INVALID"); }
function assertWorkspaceEqual(before: WorkspaceFingerprint, after: WorkspaceFingerprint): void { if (before.fingerprintDigest !== after.fingerprintDigest || before.productWorkspaceFingerprint !== after.productWorkspaceFingerprint || before.controlPlaneFingerprint !== after.controlPlaneFingerprint) throw m5d("M5D_WORKSPACE_MUTATED_BY_AUDITOR"); }
function envelopeFromDurable(descriptor: CodexAuditProviderDescriptorV2, prompt: CodexAuditPromptArtifactV2, result: CodexAuditProviderResultV2, auditPackage: AuditPackageV2): AuditorResultEnvelopeV2 {
  validateCodexAuditProposalV2(result.proposal, auditPackage);
  const envelope = Object.freeze({
    verdict: result.proposal.verdict,
    proposedFindings: Object.freeze(result.proposal.proposedFindings.map((finding) => Object.freeze({ ...finding }))),
    resolvedFindingRefs: Object.freeze([...result.proposal.resolvedFindingRefs]), rationale: result.proposal.rationale,
    metadata: Object.freeze({ role: CODEX_CLI_AUDITOR_ROLE_V2, transport: CODEX_CLI_AUDITOR_TRANSPORT_V2, transportVersion: CODEX_CLI_AUDITOR_CLI_VERSION_V2, model: descriptor.requestedModel, auditorRuntimeIdentity: descriptor.auditorRuntimeIdentity, auditorProfileDigest: descriptor.auditorProfileDigest, permissionProfileDigest: descriptor.permissionProfileDigest, capabilityDigest: descriptor.capabilityDigest, managedRuntimeIdentityDigest: descriptor.managedRuntimeIdentityDigest, threadId: result.threadId, promptDigest: prompt.promptDigest, proposalDigest: result.proposalDigest, providerResultDigest: result.resultDigest }),
  });
  assertAuditorResultEnvelopeV2(envelope); return envelope;
}
