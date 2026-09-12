import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { canonicalJson } from "../canonical-json.js";
import { sha256, sha256Canonical } from "../hashing.js";
import { fingerprintWorkspace } from "../fingerprint.js";
import type { RalphEventStoreV2 } from "../operational-b1/index.js";
import { defaultProcessIdentityProvider, type ProcessIdentityProvider } from "../operational-b2/process-identity.js";
import { assertAuthorizedInvocationV2, type AuthorizedInvocationV2 } from "../operational-b3/index.js";
import {
  ExecutorRuntimeError,
  ExecutorRuntimeV2,
  type CancelRequestReceiptV2,
  type ExecutorInvocationReceiptV2,
} from "../operational-b4/executor-runtime.js";
import type { ExecutorObservationEnvelopeV2 } from "../operational-b4/execution-observation.js";
import { LinuxProviderProcessTreeInspectorV2 } from "../operational-b4/provider-process-tree-inspector.js";
import type { ExecutorStatus, ExecutorTermination } from "../operational-v2/contracts.js";
import {
  CODEX_CLI_EXECUTOR_CLI_VERSION_V2,
  CODEX_CLI_EXECUTOR_PROFILE_V2,
  CODEX_CLI_EXECUTOR_PROVIDER_V2,
  CODEX_CLI_EXECUTOR_REASONING_EFFORT_V2,
  CODEX_CLI_EXECUTOR_REQUESTED_MODEL_V2,
  CODEX_CLI_EXECUTOR_TRANSPORT_V2,
  RalphM5BError,
  codexExecutorProfileDigestV2,
  validateM5BTimeoutPolicyV2,
  type M5BTimeoutPolicyV2,
} from "./contract.js";
import {
  CODEX_CLI_CAPABILITY_RECORD_V2,
  assertCodexRealInferenceGateV2,
  assertCodexRuntimeCapabilityV2,
  codexCapabilityBindingDigestV2,
  validateCodexCliCapabilityRecordV2,
  type CodexCliCapabilityRecordV2,
} from "./codex-capability.js";
import {
  buildCodexPermissionProfileV2,
  codexPermissionPolicyShapeDigestV2,
  codexPermissionProfileFactsV2,
  codexPermissionProfileGrantsRootWriteV2,
} from "./codex-permission-profile.js";
import { deriveCodexWriteRootPlanV2 } from "./codex-write-roots.js";
import {
  inspectCodexSandboxBackendV2,
  type CodexSandboxBackendFactsV2,
} from "./codex-sandbox-backend.js";
import {
  assertCodexPhysicalCapabilityV2,
  probeCodexPhysicalCapabilityV2,
  type CodexCapabilityProbeReportV2,
} from "./codex-credential-boundary.js";
import {
  buildCodexExecArgvV2,
  codexArgvPolicyFactsV2,
  codexParentEnvironmentV2,
  codexRuntimeReadRootV2,
  codexShellEnvironmentPolicyV2,
  inspectManagedCodexRuntimeV2,
  resolveCodexHomeV2,
  runCodexProcessV2,
  type CodexExecutableIdentityV2,
  type CodexProcessRunV2,
} from "./codex-process.js";
import type { CodexManagedRuntimeIdentityV2 } from "./codex-managed-runtime.js";
import { parseExactCodexEventStreamV2, type CodexEventStreamV2 } from "./codex-jsonl.js";
import {
  assertFinalAgentMessageMatchesOutputV2,
  codexProviderOutputSchemaJsonV2,
  validateExactCodexProviderOutputV2,
} from "./codex-output-schema.js";
import {
  buildCodexProviderProjectionV2,
  captureCodexSentinelPreimageV2,
  codexStagingWorkspacePathV2,
  readCodexProjectionStateV2,
  verifyCodexRootSentinelsV2,
  type CodexProjectionManifestV2,
  type CodexSentinelPreimageV2,
} from "./codex-projection.js";
import { createCodexWorkspaceDeltaV2, type CodexWorkspaceDeltaV2 } from "./codex-delta.js";
import { publishCodexWorkspaceDeltaV2 } from "./codex-publication.js";
import { projectWorkUnitToCodexPromptV2 } from "./codex-prompt.js";
import {
  RALPH_CODEX_DISPATCH_INTENT_SCHEMA_V2,
  RALPH_CODEX_FINALIZATION_DIAGNOSTIC_SCHEMA_V2,
  RALPH_CODEX_PROCESS_RECEIPT_SCHEMA_V2,
  RALPH_CODEX_PROMPT_SCHEMA_V2,
  RALPH_CODEX_PROVIDER_DESCRIPTOR_SCHEMA_V2,
  RALPH_CODEX_PROVIDER_RESULT_SCHEMA_V2,
  RALPH_CODEX_TERMINAL_SCHEMA_V2,
  RALPH_CODEX_THREAD_BINDING_SCHEMA_V2,
  codexDispatchIntentRefV2,
  codexProcessReceiptRefV2,
  codexProjectionManifestRefV2,
  codexProviderDescriptorRefV2,
  codexProviderResultRefV2,
  codexPromptRefV2,
  codexThreadBindingRefV2,
  codexWorkspaceDeltaRefV2,
  persistCodexDispatchIntentV2,
  persistCodexFinalizationDiagnosticV2,
  persistCodexProcessReceiptV2,
  persistCodexProjectionManifestV2,
  persistCodexPromptArtifactV2,
  persistCodexProviderDescriptorV2,
  persistCodexProviderResultV2,
  persistCodexTerminalArtifactV2,
  persistCodexThreadBindingV2,
  persistCodexWorkspaceDeltaV2,
  readCodexInvocationArtifactSetV2,
  sealCodexArtifactV2,
  type CodexDispatchIntentV2,
  type CodexCoreBindingV2,
  type CodexFinalizationDiagnosticV2,
  type CodexFinalizationStageV2,
  type CodexProcessReceiptV2,
  type CodexPromptArtifactV2,
  type CodexProviderDescriptorV2,
  type CodexProviderResultV2,
  type CodexQuiescenceV2,
  type CodexTerminalArtifactV2,
  type CodexThreadBindingV2,
} from "./codex-artifacts.js";
import { CodexCliInvocationObserverV2 } from "./codex-observer.js";
import {
  resolveExactCodexCorrectionContextV2,
  validateExactCodexCorrectionDescriptorV2,
} from "./codex-correction.js";
import { correctionContextRefV2 } from "../operational-f/correction-context.js";

const CODEX_EXECUTOR_SEAL = Symbol("CodexCliExecutorV2");
const trustedCodexExecutors = new WeakSet<CodexCliExecutorV2>();

export const CODEX_CLI_RUNTIME_IDENTITY_V2 = "codex-cli-runtime-v2" as const;

interface CodexExecutorInternalsV2 {
  readonly store: RalphEventStoreV2;
  readonly authorizedInvocation: AuthorizedInvocationV2;
  readonly timeoutPolicy: M5BTimeoutPolicyV2;
  readonly executable: CodexExecutableIdentityV2;
  /** The verified Harness-managed runtime this Executor is frozen against. */
  readonly managedRuntime: CodexManagedRuntimeIdentityV2;
  readonly capability: CodexCliCapabilityRecordV2;
  /** Live, non-model observations that authorized this Executor to exist. */
  readonly capabilityProbe: CodexCapabilityProbeReportV2;
  readonly sandboxBackend: CodexSandboxBackendFactsV2;
  readonly codexHome: string;
  readonly stagingBase: string;
  readonly observer: CodexCliInvocationObserverV2;
  readonly processIdentityProvider: ProcessIdentityProvider;
  readonly processTreeInspector: LinuxProviderProcessTreeInspectorV2;
  readonly clock: () => string;
  readonly nonceFactory: () => string;
  readonly cancellation: { cancelled: boolean };
}

const executorInternals = new WeakMap<CodexCliExecutorV2, CodexExecutorInternalsV2>();

export interface CreateCodexCliExecutorV2Input {
  readonly store: RalphEventStoreV2;
  readonly authorizedInvocation: AuthorizedInvocationV2;
  readonly timeoutPolicy: M5BTimeoutPolicyV2;
  readonly clock?: () => string;
  readonly nonceFactory?: () => string;
  /** Disposable projection base; must be outside the canonical project root. */
  readonly stagingBase?: string;
}

/**
 * The stock `@openai/codex` CLI Executor.
 *
 * One Attempt is one fresh `codex exec`. There is no resume, no fork and no
 * queued thread. The provider never receives the canonical project root: it
 * runs inside a disposable projection, and only a host-derived, validated
 * delta is mechanically published back.
 */
export class CodexCliExecutorV2 extends ExecutorRuntimeV2 {
  readonly kind = "EXECUTOR_RUNTIME" as const;
  readonly runtimeIdentity = CODEX_CLI_RUNTIME_IDENTITY_V2;

  constructor(internals: CodexExecutorInternalsV2, seal: symbol) {
    super();
    if (new.target !== CodexCliExecutorV2 || seal !== CODEX_EXECUTOR_SEAL) {
      throw new ExecutorRuntimeError("B4_EXECUTOR_AUTHORIZATION_REQUIRED", "B4_EXECUTOR_AUTHORIZATION_REQUIRED: genuine CodexCliExecutorV2 required");
    }
    executorInternals.set(this, internals);
    trustedCodexExecutors.add(this);
    Object.freeze(this);
  }

  async observe(invocationId: string): Promise<ExecutorObservationEnvelopeV2> {
    const internal = requireInternals(this);
    assertExactInvocation(internal, invocationId);
    return internal.observer.observe({
      attemptId: internal.authorizedInvocation.descriptor.attemptId,
      invocationId,
    });
  }

  async requestCancel(invocationId: string): Promise<CancelRequestReceiptV2> {
    const internal = requireInternals(this);
    assertExactInvocation(internal, invocationId);
    internal.cancellation.cancelled = true;
    return Object.freeze({
      requestId: `cancel-${randomUUID()}`,
      invocationId,
      runtimeIdentity: this.runtimeIdentity,
      requestedAt: internal.clock(),
      requestState: "ISSUED",
    });
  }

  async invoke(authorizedInvocation: AuthorizedInvocationV2): Promise<ExecutorInvocationReceiptV2> {
    const internal = requireInternals(this);
    assertAuthorizedInvocationV2(authorizedInvocation);
    assertSameAuthorizedInvocation(internal.authorizedInvocation, authorizedInvocation);
    const descriptorBinding = authorizedInvocation.descriptor;
    const workUnit = authorizedInvocation.workUnit;
    const attemptId = descriptorBinding.attemptId;
    const invocationId = descriptorBinding.invocationId;

    const existing = await readCodexInvocationArtifactSetV2(internal.store, attemptId);
    if (existing.dispatchIntent) throw new RalphM5BError("M5B_REDISPATCH_FORBIDDEN");

    // M5-C reuses the exact frozen M4-C durable authority. Invalid, stale,
    // foreign, missing or incomplete correction input fails here, before a
    // provider descriptor, staging projection or managed `codex exec` exists.
    const correctionContext = await resolveExactCodexCorrectionContextV2({
      store: internal.store,
      authorizedInvocation,
    });

    if (descriptorBinding.executorProfileIdentity !== CODEX_CLI_EXECUTOR_PROFILE_V2) throw new RalphM5BError("M5B_PROFILE_BINDING_INVALID");
    if (workUnit.timeoutPolicyDigest !== internal.timeoutPolicy.policyDigest) throw new RalphM5BError("M5B_TIMEOUT_POLICY_INVALID");
    validateCodexCliCapabilityRecordV2(internal.capability);

    const snapshot = await internal.store.verifyRunSnapshot();
    const baseFingerprint = await fingerprintWorkspace(internal.store.projectRoot, snapshot.workspacePolicy);
    if (baseFingerprint.fingerprintDigest !== workUnit.attemptBaseFingerprint) throw new RalphM5BError("M5B_WORKSPACE_BINDING_INVALID", "M5B_WORKSPACE_BINDING_INVALID: canonical workspace is not at the Attempt baseline");

    const binding = {
      runId: descriptorBinding.runId,
      phaseId: descriptorBinding.phaseId,
      taskId: descriptorBinding.taskId,
      attemptId,
      invocationId,
    };
    const stagingWorkspace = codexStagingWorkspacePathV2(internal.stagingBase, binding, workUnit.attemptBaseFingerprint);
    const ioDirectory = `${stagingWorkspace}-io`;
    const outputSchemaPath = resolve(ioDirectory, "provider-output-schema.json");
    const finalOutputPath = resolve(ioDirectory, "provider-final-output.json");

    // The provider may write only what the WorkUnit already declares it owns.
    // For an ordinary scope that is a set of product directories and the
    // staging root stays read-only. For a WorkUnit whose product genuinely
    // lives at the workspace root — `package.json`, `go.mod`, `**` — the
    // staging root becomes writable and every control-plane name is closed by
    // a pre-created, profile-denied sentinel instead.
    const writeRootPlan = deriveCodexWriteRootPlanV2({
      scope: workUnit.scope,
      covers: workUnit.covers,
      directories: baseFingerprint.productWorkspaceEntries.filter((entry) => entry.kind === "directory").map((entry) => entry.path),
    });
    const permissionProfile = buildCodexPermissionProfileV2({
      stagingWorkspace,
      stagingRootWritable: writeRootPlan.stagingRootWritable,
      writableRoots: writeRootPlan.productRoots,
      sentinelRoots: writeRootPlan.sentinelRoots,
      codexHome: internal.codexHome,
      codexRuntimeReadRoot: codexRuntimeReadRootV2(internal.executable.executablePath),
    });
    if (codexPermissionProfileGrantsRootWriteV2(permissionProfile) !== writeRootPlan.stagingRootWritable) {
      throw new RalphM5BError("M5B_PERMISSION_PROFILE_INVALID", "M5B_PERMISSION_PROFILE_INVALID: the profile does not match the derived write-root plan");
    }

    // The projection is materialized BEFORE the descriptor is sealed: the
    // sentinels must physically exist before the profile can be admitted, and
    // their sealed authority is part of the descriptor's capability binding.
    const projection = await buildCodexProviderProjectionV2({
      projectRoot: internal.store.projectRoot,
      stagingWorkspace,
      binding,
      fingerprint: baseFingerprint,
      writableRoots: writeRootPlan.productRoots,
      stagingRootWritable: writeRootPlan.stagingRootWritable,
      sentinelRoots: writeRootPlan.sentinelRoots,
      createdAt: internal.clock(),
    });
    const sentinelPreimage = await captureCodexSentinelPreimageV2(stagingWorkspace, projection);

    // The Executor could only be constructed because a live probe proved this
    // policy shape physically; re-assert the binding for THIS Attempt's
    // profile, runtime and sentinel authority before anything durable is
    // written.
    assertCodexRuntimeCapabilityV2({
      record: internal.capability,
      probe: internal.capabilityProbe,
      backend: internal.sandboxBackend,
      permissionProfile,
      managedRuntime: internal.managedRuntime,
    });

    const argv = buildCodexExecArgvV2({ stagingWorkspace, outputSchemaPath, finalOutputPath, permissionProfile });
    const outputSchemaJson = codexProviderOutputSchemaJsonV2();
    const environment = codexParentEnvironmentV2(internal.codexHome);

    const descriptor = sealCodexArtifactV2<CodexProviderDescriptorV2>({
      schema: RALPH_CODEX_PROVIDER_DESCRIPTOR_SCHEMA_V2,
      ...binding,
      workUnitId: workUnit.workUnitId,
      workUnitDigest: workUnit.workUnitDigest,
      executorProfileIdentity: CODEX_CLI_EXECUTOR_PROFILE_V2,
      executorProfileDigest: codexExecutorProfileDigestV2(),
      provider: CODEX_CLI_EXECUTOR_PROVIDER_V2,
      transport: CODEX_CLI_EXECUTOR_TRANSPORT_V2,
      cliVersion: CODEX_CLI_EXECUTOR_CLI_VERSION_V2,
      managedRuntimeKind: internal.managedRuntime.kind,
      managedRuntimeVersion: internal.managedRuntime.version,
      managedRuntimeIdentityDigest: internal.managedRuntime.identityDigest,
      requestedModel: CODEX_CLI_EXECUTOR_REQUESTED_MODEL_V2,
      reasoningEffort: CODEX_CLI_EXECUTOR_REASONING_EFFORT_V2,
      observedModelState: "UNAVAILABLE" as const,
      observedModel: null,
      executablePath: internal.executable.executablePath,
      executableVersion: internal.executable.executableVersion,
      executableSizeBytes: internal.executable.executableSizeBytes,
      executableSha256: internal.executable.executableSha256,
      capabilityRecordDigest: internal.capability.recordDigest,
      capabilityBindingDigest: codexCapabilityBindingDigestV2({
        record: internal.capability,
        probe: internal.capabilityProbe,
        backend: internal.sandboxBackend,
        permissionProfile,
        managedRuntime: internal.managedRuntime,
        sentinelDigest: projection.sentinelDigest,
      }),
      permissionProfileName: permissionProfile.name,
      permissionProfileDigest: permissionProfile.profileDigest,
      permissionPolicyShapeDigest: codexPermissionPolicyShapeDigestV2(permissionProfile),
      permissionProfileFactsDigest: sha256Canonical(codexPermissionProfileFactsV2(permissionProfile)),
      stagingRootWritable: writeRootPlan.stagingRootWritable,
      writeRootPlanDigest: writeRootPlan.planDigest,
      rootSentinelManifestDigest: projection.sentinelDigest,
      sandboxBackendPath: internal.sandboxBackend.backendPath,
      legacySandboxMode: "NONE" as const,
      runtimeIdentity: CODEX_CLI_RUNTIME_IDENTITY_V2,
      projectRootIdentity: sha256(resolve(internal.store.projectRoot)),
      baseWorkspaceFingerprint: workUnit.attemptBaseFingerprint,
      argvPolicyDigest: sha256Canonical(codexArgvPolicyFactsV2(argv, permissionProfile)),
      parentEnvironmentPolicyDigest: sha256Canonical(Object.keys(environment).sort()),
      shellEnvironmentPolicyDigest: sha256Canonical({ inherit: "none", set: codexShellEnvironmentPolicyV2() }),
      outputSchemaDigest: sha256(outputSchemaJson),
      correctionContextSupported: correctionContext !== undefined,
      correctionContextRef: correctionContext ? correctionContextRefV2(attemptId) : null,
      correctionContextDigest: correctionContext?.contextDigest ?? null,
      createdAt: internal.clock(),
    }, "descriptorDigest");
    await validateExactCodexCorrectionDescriptorV2({ store: internal.store, descriptor });
    await persistCodexProviderDescriptorV2(internal.store, descriptor, internal.nonceFactory());

    await persistCodexProjectionManifestV2(internal.store, projection, internal.nonceFactory());

    const prompt = projectWorkUnitToCodexPromptV2(workUnit, correctionContext);
    const promptArtifact = sealCodexArtifactV2<CodexPromptArtifactV2>({
      schema: RALPH_CODEX_PROMPT_SCHEMA_V2,
      ...binding,
      descriptorDigest: descriptor.descriptorDigest,
      projectionManifestDigest: projection.manifestDigest,
      promptDigest: prompt.promptDigest,
      promptBytes: prompt.byteLength,
      preparedAt: internal.clock(),
    }, "artifactDigest");
    await persistCodexPromptArtifactV2(internal.store, promptArtifact, internal.nonceFactory());

    // Everything above is deterministic and side-effect free with respect to
    // the model. The credential-file boundary gate is the last thing checked
    // before a model-bearing crossing becomes possible.
    assertCodexRealInferenceGateV2(internal.capability);

    await rm(ioDirectory, { recursive: true, force: true });
    await mkdir(ioDirectory, { recursive: true, mode: 0o700 });
    await writeFile(outputSchemaPath, outputSchemaJson, { mode: 0o600 });

    const dispatchIntent = sealCodexArtifactV2<CodexDispatchIntentV2>({
      schema: RALPH_CODEX_DISPATCH_INTENT_SCHEMA_V2,
      ...binding,
      descriptorRef: codexProviderDescriptorRefV2(attemptId),
      descriptorDigest: descriptor.descriptorDigest,
      dispatchId: `codex-dispatch-${sha256Canonical({ invocationId, descriptorDigest: descriptor.descriptorDigest }).slice(7, 39)}`,
      projectionManifestRef: codexProjectionManifestRefV2(attemptId),
      projectionManifestDigest: projection.manifestDigest,
      rootSentinelManifestDigest: projection.sentinelDigest,
      promptRef: codexPromptRefV2(attemptId),
      promptDigest: prompt.promptDigest,
      argvDigest: sha256Canonical([...argv]),
      stagingRootIdentity: projection.stagingRootIdentity,
      createdAt: internal.clock(),
    }, "intentDigest");
    await persistCodexDispatchIntentV2(internal.store, dispatchIntent, internal.nonceFactory());
    await assertPreDispatchDurabilityV2(internal.store, attemptId, descriptor.descriptorDigest, dispatchIntent.intentDigest, projection);

    // === the single model-bearing crossing ===
    let threadBinding: CodexThreadBindingV2 | undefined;
    let pendingThreadBinding: Promise<void> = Promise.resolve();
    let scanned = "";
    let threadSeen = false;

    let run: CodexProcessRunV2;
    try {
      run = await runCodexProcessV2({
        executablePath: internal.executable.executablePath,
        argv,
        cwd: stagingWorkspace,
        environment,
        stdin: prompt.text,
        deadlineMs: internal.timeoutPolicy.deadlineMs,
        cancellation: internal.cancellation,
        onSpawned: async (spawned) => {
          const receipt = sealCodexArtifactV2<CodexProcessReceiptV2>({
            schema: RALPH_CODEX_PROCESS_RECEIPT_SCHEMA_V2,
            ...binding,
            descriptorRef: codexProviderDescriptorRefV2(attemptId),
            descriptorDigest: descriptor.descriptorDigest,
            dispatchIntentRef: codexDispatchIntentRefV2(attemptId),
            dispatchIntentDigest: dispatchIntent.intentDigest,
            dispatchId: dispatchIntent.dispatchId,
            processIdentity: { ...spawned.processIdentity },
            processGroupId: spawned.processGroupId,
            containmentKind: spawned.containmentKind,
            containmentStructural: spawned.containmentStructural,
            startedAt: spawned.startedAt,
          }, "receiptDigest");
          await persistCodexProcessReceiptV2(internal.store, receipt, internal.nonceFactory());
        },
        onStdoutChunk: (chunk) => {
          if (threadSeen) return;
          scanned = `${scanned}${chunk}`.slice(-8192);
          const match = scanned.match(/"thread_id"\s*:\s*"([A-Za-z0-9][A-Za-z0-9._:-]{1,190})"/);
          if (!match?.[1]) return;
          threadSeen = true;
          const candidate = match[1];
          pendingThreadBinding = pendingThreadBinding.then(async () => {
            const artifact = sealCodexArtifactV2<CodexThreadBindingV2>({
              schema: RALPH_CODEX_THREAD_BINDING_SCHEMA_V2,
              ...binding,
              descriptorRef: codexProviderDescriptorRefV2(attemptId),
              descriptorDigest: descriptor.descriptorDigest,
              dispatchIntentRef: codexDispatchIntentRefV2(attemptId),
              dispatchIntentDigest: dispatchIntent.intentDigest,
              processReceiptRef: codexProcessReceiptRefV2(attemptId),
              processReceiptDigest: (await readCodexInvocationArtifactSetV2(internal.store, attemptId)).processReceipt?.receiptDigest ?? "",
              threadId: candidate,
              boundAt: internal.clock(),
            }, "bindingDigest");
            await persistCodexThreadBindingV2(internal.store, artifact, internal.nonceFactory());
            threadBinding = artifact;
          });
        },
      });
    } finally {
      // The thread binding must become durable even when the run fails: a
      // physical crossing that produced a public thread id is never allowed
      // to look like it never happened.
      await pendingThreadBinding.catch(() => undefined);
    }

    const startedAt = run.startedAt;
    const finishedAt = run.finishedAt;
    const quiescence = await this.observeQuiescence(internal, run);

    let stream: CodexEventStreamV2 | undefined;
    let structuredDigest: string | null = null;
    let classification: ExecutorStatus = "FAILED";
    let termination: ExecutorTermination = "ERROR";
    try {
      stream = parseExactCodexEventStreamV2(run.stdout, { truncated: run.stdoutTruncated });
      if (!threadBinding || threadBinding.threadId !== stream.threadId) {
        throw new RalphM5BError("M5B_THREAD_BINDING_INVALID", "M5B_THREAD_BINDING_INVALID: the durable thread binding does not match the observed stream");
      }
      if (run.timedOut) { classification = "TIMED_OUT"; termination = "TIMEOUT"; }
      else if (run.cancelled) { classification = "CANCELLED"; termination = "CANCELLED"; }
      else if (stream.terminal !== "TURN_COMPLETED" || run.exitCode !== 0 || run.signal !== null) {
        classification = "FAILED";
        termination = "ERROR";
      } else {
        const raw = await readFile(finalOutputPath, "utf8").catch(() => { throw new RalphM5BError("M5B_PROVIDER_RESULT_INVALID", "M5B_PROVIDER_RESULT_INVALID: the -o final output is missing"); });
        const structured = validateExactCodexProviderOutputV2(raw);
        assertFinalAgentMessageMatchesOutputV2(stream.finalAgentMessage, structured);
        structuredDigest = structured.resultDigest;
        classification = "SUCCEEDED";
        termination = "NORMAL";
      }
    } catch (error) {
      // A typed M5-B failure after the physical crossing is a provider
      // failure, not a pre-dispatch protocol failure: it is recorded as a
      // terminal FAILED result rather than rethrown as NOT_INVOKED.
      if (!(error instanceof RalphM5BError)) throw error;
      classification = "FAILED";
      termination = "ERROR";
    }

    if (classification === "SUCCEEDED" && (quiescence.processState !== "ABSENT" || quiescence.processTreeState !== "QUIESCENT" || !quiescence.settlementObserved || !quiescence.settlementQuiescent)) {
      // Ambiguous physical state is never converted into a terminal artifact.
      throw new RalphM5BError("M5B_PROCESS_TREE_NOT_QUIESCENT");
    }

    const providerResult = sealCodexArtifactV2<CodexProviderResultV2>({
      schema: RALPH_CODEX_PROVIDER_RESULT_SCHEMA_V2,
      ...binding,
      descriptorDigest: descriptor.descriptorDigest,
      dispatchIntentDigest: dispatchIntent.intentDigest,
      threadBindingDigest: threadBinding?.bindingDigest ?? "",
      threadId: threadBinding?.threadId ?? "",
      requestedModel: CODEX_CLI_EXECUTOR_REQUESTED_MODEL_V2,
      observedModelState: "UNAVAILABLE" as const,
      observedModel: null,
      classification,
      terminalKind: stream?.terminal ?? null,
      structuredResultDigest: structuredDigest,
      finalAgentMessageDigest: stream?.finalAgentMessageDigest ?? null,
      eventStreamDigest: stream?.streamDigest ?? null,
      eventCount: stream?.eventCount ?? 0,
      agentMessageCount: stream?.agentMessageCount ?? 0,
      commandExecutionCount: stream?.commandExecutionCount ?? 0,
      usageInputTokens: stream?.usageInputTokens ?? null,
      usageOutputTokens: stream?.usageOutputTokens ?? null,
      actualExitCode: run.exitCode,
      actualSignal: run.signal,
      startedAt,
      finishedAt,
    }, "resultDigest");
    await persistCodexProviderResultV2(internal.store, providerResult, internal.nonceFactory());

    let delta: CodexWorkspaceDeltaV2 | undefined;
    let publicationDigest: string | null = null;
    if (classification === "SUCCEEDED") {
      // The sentinel post-check runs BEFORE any delta is derived and long
      // before publication: a control-plane root that was deleted, renamed,
      // replaced, symlinked over or given a child fails the whole Attempt
      // closed rather than reaching the canonical workspace.
      await finalizeCodexHostStageV2(internal, binding, providerResult, "SENTINEL_VERIFICATION", () =>
        verifyCodexRootSentinelsV2(stagingWorkspace, projection, sentinelPreimage));
      const finalState = await finalizeCodexHostStageV2(internal, binding, providerResult, "PROJECTION_OBSERVATION", () =>
        readCodexProjectionStateV2(stagingWorkspace, projection.sentinels));
      delta = await finalizeCodexHostStageV2(internal, binding, providerResult, "DELTA_DERIVATION", () =>
        createCodexWorkspaceDeltaV2({
          stagingWorkspace,
          baseline: projection.entries,
          final: finalState,
          scope: workUnit.scope,
          covers: workUnit.covers,
          ...binding,
          providerDescriptorDigest: descriptor.descriptorDigest,
          threadBindingDigest: threadBinding!.bindingDigest,
          threadId: threadBinding!.threadId,
          baseWorkspaceFingerprint: workUnit.attemptBaseFingerprint,
          projectionManifestDigest: projection.manifestDigest,
          projectionBaselineDigest: projection.baselineDigest,
          providerResultDigest: providerResult.resultDigest,
          createdAt: internal.clock(),
        }));
      await finalizeCodexHostStageV2(internal, binding, providerResult, "DELTA_PERSISTENCE", () =>
        persistCodexWorkspaceDeltaV2(internal.store, delta!, internal.nonceFactory()));
      const publication = await finalizeCodexHostStageV2(internal, binding, providerResult, "WORKSPACE_PUBLICATION", () =>
        publishCodexWorkspaceDeltaV2({
          store: internal.store,
          delta: delta!,
          workspacePolicy: snapshot.workspacePolicy,
          clock: internal.clock,
          nonceFactory: internal.nonceFactory,
        }));
      publicationDigest = publication.receiptDigest;
    }

    await finalizeCodexHostStageV2(internal, binding, providerResult, "TERMINAL_PERSISTENCE", async () => {
      const terminal = sealCodexArtifactV2<CodexTerminalArtifactV2>({
        schema: RALPH_CODEX_TERMINAL_SCHEMA_V2,
        ...binding,
        descriptorDigest: descriptor.descriptorDigest,
        dispatchIntentDigest: (dispatchIntent as { intentDigest: string }).intentDigest,
        processReceiptDigest: (await readCodexInvocationArtifactSetV2(internal.store, attemptId)).processReceipt?.receiptDigest ?? "",
        threadBindingDigest: threadBinding?.bindingDigest ?? null,
        status: classification,
        termination,
        exitCode: run.exitCode,
        signal: run.signal,
        timedOut: run.timedOut,
        cancelled: run.cancelled,
        resultRef: codexProviderResultRefV2(attemptId),
        resultDigest: providerResult.resultDigest,
        deltaRef: delta ? codexWorkspaceDeltaRefV2(attemptId) : null,
        deltaDigest: delta?.deltaDigest ?? null,
        publicationReceiptRef: publicationDigest === null ? null : `attempts/${attemptId}/codex-publication-receipt.json`,
        publicationDigest,
        quiescence,
        finishedAt,
      }, "terminalDigest");
      await persistCodexTerminalArtifactV2(internal.store, terminal, internal.nonceFactory());
    });

    return Object.freeze({
      invocationId,
      runtimeIdentity: this.runtimeIdentity,
      acceptedAt: startedAt,
      physicalStart: "STARTED" as const,
    });
  }

  private async observeQuiescence(internal: CodexExecutorInternalsV2, run: CodexProcessRunV2): Promise<CodexQuiescenceV2> {
    // The dispatch path always has a genuine child identity: `onSpawned`
    // refuses to continue without one.
    const identity = run.processIdentity;
    const processState = identity === null ? "UNKNOWN" : await internal.processIdentityProvider.inspect(identity);
    const treeState = identity === null ? "UNKNOWN" as const : internal.processTreeInspector.inspect({ processIdentity: identity, processGroupId: run.processGroupId });
    return Object.freeze({
      processState: processState === "ABSENT" ? "ABSENT" as const : "QUIESCENCE_UNKNOWN" as const,
      processTreeState: treeState,
      settlementObserved: run.settlement.observed,
      settlementQuiescent: run.settlement.quiescent,
      settlementVerified: run.settlement.verified,
      observedAt: internal.clock(),
    });
  }
}

async function finalizeCodexHostStageV2<T>(
  internal: CodexExecutorInternalsV2,
  binding: CodexCoreBindingV2,
  providerResult: CodexProviderResultV2,
  stage: CodexFinalizationStageV2,
  operation: () => T | Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof RalphM5BError) {
      // Diagnostic durability is best-effort with respect to the original
      // ambiguity: persistence failure cannot replace or reinterpret the
      // exact typed failure which B4 must observe.
      try {
        const diagnostic = sealCodexArtifactV2<CodexFinalizationDiagnosticV2>({
          schema: RALPH_CODEX_FINALIZATION_DIAGNOSTIC_SCHEMA_V2,
          ...binding,
          providerResultDigest: providerResult.resultDigest,
          stage,
          m5bCode: error.m5bCode,
          recordedAt: internal.clock(),
        }, "diagnosticDigest");
        await persistCodexFinalizationDiagnosticV2(internal.store, diagnostic, internal.nonceFactory());
      } catch { /* original execution ambiguity remains authoritative */ }
    }
    throw error;
  }
}

export async function createCodexCliExecutorV2(input: CreateCodexCliExecutorV2Input): Promise<CodexCliExecutorV2> {
  assertAuthorizedInvocationV2(input.authorizedInvocation);
  validateM5BTimeoutPolicyV2(input.timeoutPolicy);
  if (resolve(input.store.projectRoot) !== input.store.projectRoot || input.store.runId !== input.authorizedInvocation.descriptor.runId) {
    throw new RalphM5BError("M5B_WORKSPACE_BINDING_INVALID");
  }
  if (input.authorizedInvocation.descriptor.executorProfileIdentity !== CODEX_CLI_EXECUTOR_PROFILE_V2) throw new RalphM5BError("M5B_PROFILE_BINDING_INVALID");
  if (input.authorizedInvocation.workUnit.timeoutPolicyDigest !== input.timeoutPolicy.policyDigest) throw new RalphM5BError("M5B_TIMEOUT_POLICY_INVALID");
  const capability = CODEX_CLI_CAPABILITY_RECORD_V2;
  validateCodexCliCapabilityRecordV2(capability);
  // There is no capability override seam: a model-bearing Codex Executor
  // cannot even be constructed while the provider tool sandbox can reach the
  // credential file.
  assertCodexRealInferenceGateV2(capability);
  const codexHome = resolveCodexHomeV2();
  // The runtime is the Harness-MANAGED stock Codex, verified whole: every
  // payload file, the executable SHA-256 and the exact `--version`. A global
  // `npm i -g @openai/codex` upgrade changes nothing here, and a drifted
  // managed install refuses construction outright.
  const { executable, managedRuntime } = await inspectManagedCodexRuntimeV2(input.timeoutPolicy.deadlineMs);
  // The system bubblewrap must be the binary Codex will actually select
  // under the pinned parent PATH. When it is not, Codex silently falls back
  // to its bundled copy and every provider command dies before it runs —
  // which looks like a denial but proves nothing at all.
  const sandboxBackend = await inspectCodexSandboxBackendV2();
  // And the boundary is measured, not asserted: a live NON-MODEL probe runs
  // the same policy shape and must physically deny the credential file while
  // still allowing a product write.
  const capabilityProbe = await probeCodexPhysicalCapabilityV2({
    deadlineMs: input.timeoutPolicy.deadlineMs,
    codexHome,
    executablePath: executable.executablePath,
  });
  assertCodexPhysicalCapabilityV2(capabilityProbe);
  if (capabilityProbe.permissionPolicyShapeDigest !== capability.permissionPolicyShapeDigest
    || capabilityProbe.rootPermissionPolicyShapeDigest !== capability.rootPermissionPolicyShapeDigest) {
    throw new RalphM5BError("M5B_PERMISSION_PROFILE_INVALID", "M5B_PERMISSION_PROFILE_INVALID: the probed policy shape does not match the capability record");
  }
  if (managedRuntime.identityDigest !== capability.managedRuntimeIdentityDigest) {
    throw new RalphM5BError("M5B_MANAGED_RUNTIME_INVALID", "M5B_MANAGED_RUNTIME_INVALID: the verified managed runtime does not match the capability record");
  }
  const stagingBase = resolve(input.stagingBase ?? tmpdir());
  if (stagingBase === resolve(input.store.projectRoot) || stagingBase.startsWith(`${resolve(input.store.projectRoot)}/`)) {
    throw new RalphM5BError("M5B_PROJECTION_INVALID", "M5B_PROJECTION_INVALID: the staging base must be outside the canonical project root");
  }
  const internals: CodexExecutorInternalsV2 = {
    store: input.store,
    authorizedInvocation: input.authorizedInvocation,
    timeoutPolicy: Object.freeze({ ...input.timeoutPolicy }),
    executable,
    managedRuntime,
    capability,
    capabilityProbe,
    sandboxBackend,
    codexHome,
    stagingBase,
    observer: new CodexCliInvocationObserverV2({ store: input.store, runtimeIdentity: CODEX_CLI_RUNTIME_IDENTITY_V2, clock: input.clock }),
    processIdentityProvider: defaultProcessIdentityProvider,
    processTreeInspector: new LinuxProviderProcessTreeInspectorV2(),
    clock: input.clock ?? (() => new Date().toISOString()),
    nonceFactory: input.nonceFactory ?? randomUUID,
    cancellation: { cancelled: false },
  };
  return new CodexCliExecutorV2(internals, CODEX_EXECUTOR_SEAL);
}

export function isTrustedCodexCliExecutorV2(value: unknown): value is CodexCliExecutorV2 {
  return typeof value === "object" && value !== null && trustedCodexExecutors.has(value as CodexCliExecutorV2);
}

export function assertTrustedCodexCliExecutorV2(value: unknown): asserts value is CodexCliExecutorV2 {
  if (!isTrustedCodexCliExecutorV2(value)) throw new ExecutorRuntimeError("B4_EXECUTOR_AUTHORIZATION_REQUIRED", "B4_EXECUTOR_AUTHORIZATION_REQUIRED: genuine CodexCliExecutorV2 required");
}

function requireInternals(value: CodexCliExecutorV2): CodexExecutorInternalsV2 {
  if (!isTrustedCodexCliExecutorV2(value)) throw new ExecutorRuntimeError("B4_EXECUTOR_AUTHORIZATION_REQUIRED");
  const internal = executorInternals.get(value);
  if (!internal) throw new ExecutorRuntimeError("B4_EXECUTOR_AUTHORIZATION_REQUIRED");
  return internal;
}

function assertExactInvocation(internal: CodexExecutorInternalsV2, invocationId: string): void {
  if (invocationId !== internal.authorizedInvocation.descriptor.invocationId) throw new ExecutorRuntimeError("B4_EXECUTOR_INVOCATION_ID_INVALID");
}

function assertSameAuthorizedInvocation(expected: AuthorizedInvocationV2, actual: AuthorizedInvocationV2): void {
  assertAuthorizedInvocationV2(expected);
  assertAuthorizedInvocationV2(actual);
  if (canonicalJson(expected.descriptor) !== canonicalJson(actual.descriptor) || canonicalJson(expected.workUnit) !== canonicalJson(actual.workUnit)) {
    throw new ExecutorRuntimeError("B4_EXECUTOR_AUTHORIZATION_REQUIRED");
  }
}

async function assertPreDispatchDurabilityV2(
  store: RalphEventStoreV2,
  attemptId: string,
  descriptorDigest: string,
  intentDigest: string,
  projection: CodexProjectionManifestV2,
): Promise<void> {
  const facts = await readCodexInvocationArtifactSetV2(store, attemptId);
  if (facts.descriptor?.descriptorDigest !== descriptorDigest
    || facts.dispatchIntent?.intentDigest !== intentDigest
    || facts.projectionManifest?.manifestDigest !== projection.manifestDigest
    || facts.prompt?.descriptorDigest !== descriptorDigest) {
    throw new RalphM5BError("M5B_PROVIDER_RESULT_INVALID", "M5B_ARTIFACT_INVALID: pre-dispatch artifacts are not durable");
  }
  if (facts.descriptor) await validateExactCodexCorrectionDescriptorV2({ store, descriptor: facts.descriptor });
}
