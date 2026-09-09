import type { RalphEventStoreV2 } from "../operational-b1/index.js";
import {
  defaultProcessIdentityProvider,
  type ProcessIdentityProvider,
} from "../operational-b2/process-identity.js";
import {
  buildExecutorObservationEnvelopeV2,
  type ExecutorObservationEnvelopeV2,
} from "../operational-b4/execution-observation.js";
import { LinuxProviderProcessTreeInspectorV2 } from "../operational-b4/provider-process-tree-inspector.js";
import type { ProviderProcessTreeInspectorV2 } from "../operational-b4/opencode-cli-observer.js";
import { readCodexInvocationArtifactSetV2 } from "./codex-artifacts.js";
import { readCodexPublicationReceiptV2 } from "./codex-publication.js";

export interface CodexInvocationObserverOptionsV2 {
  readonly store: RalphEventStoreV2;
  readonly runtimeIdentity: string;
  readonly processIdentityProvider?: ProcessIdentityProvider;
  readonly processTreeInspector?: ProviderProcessTreeInspectorV2;
  readonly clock?: () => string;
}

/**
 * Fresh-process observation for the stock Codex Executor.
 *
 * `--ephemeral` leaves no provider-side state to recover from, so a physical
 * crossing that produced no durable terminal is UNKNOWN — never NOT_INVOKED,
 * and never a licence to dispatch again.
 */
export class CodexCliInvocationObserverV2 {
  private ordinal = 0;
  private readonly store: RalphEventStoreV2;
  private readonly runtimeIdentity: string;
  private readonly processIdentityProvider: ProcessIdentityProvider;
  private readonly processTreeInspector: ProviderProcessTreeInspectorV2;
  private readonly clock: () => string;

  constructor(options: CodexInvocationObserverOptionsV2) {
    this.store = options.store;
    this.runtimeIdentity = options.runtimeIdentity;
    this.processIdentityProvider = options.processIdentityProvider ?? defaultProcessIdentityProvider;
    this.processTreeInspector = options.processTreeInspector ?? new LinuxProviderProcessTreeInspectorV2();
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  async observe(binding: { readonly attemptId: string; readonly invocationId: string }): Promise<ExecutorObservationEnvelopeV2> {
    const observationId = `codex-obs-${++this.ordinal}`;
    const observedAt = this.clock();
    const artifacts = await readCodexInvocationArtifactSetV2(this.store, binding.attemptId);

    // Before a dispatch intent exists nothing physical can have crossed.
    if (!artifacts.dispatchIntent) {
      return buildExecutorObservationEnvelopeV2({
        runtimeIdentity: this.runtimeIdentity,
        observationId,
        invocationId: binding.invocationId,
        state: "NOT_INVOKED",
        observedAt,
        safeMetadata: { codexStage: artifacts.descriptor ? "DESCRIPTOR_DURABLE" : "NO_DESCRIPTOR" },
      });
    }
    if (artifacts.dispatchIntent.invocationId !== binding.invocationId) {
      return this.unknown(observationId, binding.invocationId, observedAt, "INVOCATION_BINDING_MISMATCH");
    }

    const terminal = artifacts.terminal;
    const result = artifacts.providerResult;
    if (terminal && result) {
      if (result.invocationId !== binding.invocationId || terminal.resultDigest !== result.resultDigest) {
        return this.unknown(observationId, binding.invocationId, observedAt, "TERMINAL_RESULT_MISMATCH");
      }
      if (terminal.status === "SUCCEEDED") {
        // A successful Attempt is only quiescent once the sealed delta has
        // been mechanically published into the canonical workspace.
        const publication = await readCodexPublicationReceiptV2(this.store, binding.attemptId);
        if (!artifacts.workspaceDelta || !publication || publication.deltaDigest !== artifacts.workspaceDelta.deltaDigest) {
          return this.unknown(observationId, binding.invocationId, observedAt, "PUBLICATION_INCOMPLETE");
        }
      }
      if (terminal.quiescence.processTreeState !== "QUIESCENT" || terminal.quiescence.processState !== "ABSENT" || !terminal.quiescence.settlementObserved) {
        return this.unknown(observationId, binding.invocationId, observedAt, "QUIESCENCE_NOT_POSITIVE");
      }
      return buildExecutorObservationEnvelopeV2({
        runtimeIdentity: this.runtimeIdentity,
        observationId,
        invocationId: binding.invocationId,
        state: "TERMINATED_QUIESCENT",
        observedAt,
        status: terminal.status,
        termination: terminal.termination,
        resultEnvelopeStatus: terminal.status === "SUCCEEDED" ? "VALID" : terminal.resultDigest === null ? "INVALID" : "VALID",
        exitCode: terminal.exitCode,
        signal: terminal.signal,
        startedAt: artifacts.processReceipt?.startedAt ?? artifacts.dispatchIntent.createdAt,
        finishedAt: terminal.finishedAt,
        safeMetadata: this.metadata(artifacts, "TERMINAL"),
      });
    }

    const receipt = artifacts.processReceipt;
    if (receipt) {
      const processState = await this.processIdentityProvider.inspect(receipt.processIdentity);
      const treeState = this.processTreeInspector.inspect({ processIdentity: receipt.processIdentity, processGroupId: receipt.processGroupId });
      if (processState === "MATCH" || treeState === "ACTIVE") {
        return buildExecutorObservationEnvelopeV2({
          runtimeIdentity: this.runtimeIdentity,
          observationId,
          invocationId: binding.invocationId,
          state: "RUNNING",
          observedAt,
          startedAt: receipt.startedAt,
          safeMetadata: this.metadata(artifacts, "RUNNING"),
        });
      }
    }
    // The intent is durable and the process is gone without a durable
    // terminal: this is intentionally ambiguous and must never be
    // redispatched.
    return this.unknown(observationId, binding.invocationId, observedAt, receipt ? "PROCESS_GONE_WITHOUT_TERMINAL" : "DISPATCH_INTENT_WITHOUT_RECEIPT");
  }

  private unknown(observationId: string, invocationId: string, observedAt: string, reason: string): ExecutorObservationEnvelopeV2 {
    return buildExecutorObservationEnvelopeV2({
      runtimeIdentity: this.runtimeIdentity,
      observationId,
      invocationId,
      state: "UNKNOWN",
      observedAt,
      safeMetadata: { codexStage: "UNKNOWN", codexReason: reason },
    });
  }

  private metadata(artifacts: Awaited<ReturnType<typeof readCodexInvocationArtifactSetV2>>, stage: string): Readonly<Record<string, string>> {
    return {
      codexStage: stage,
      ...(artifacts.threadBinding ? { codexThreadId: artifacts.threadBinding.threadId } : {}),
      ...(artifacts.providerResult ? {
        codexRequestedModel: artifacts.providerResult.requestedModel,
        codexObservedModelState: artifacts.providerResult.observedModelState,
      } : {}),
      ...(artifacts.workspaceDelta ? { codexDeltaEntryCount: String(artifacts.workspaceDelta.entryCount) } : {}),
    };
  }
}
