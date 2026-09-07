import { randomUUID } from "node:crypto";
import type { RalphEventStoreV2 } from "../operational-b1/index.js";
import {
  defaultProcessIdentityProvider,
  type ProcessIdentity,
  type ProcessIdentityInspection,
  type ProcessIdentityProvider,
} from "../operational-b2/index.js";
import { assertAuthorizedInvocationV2, type AuthorizedInvocationV2 } from "../operational-b3/index.js";
import {
  buildExecutorObservationEnvelopeV2,
  type ExecutorObservationEnvelopeV2,
} from "./execution-observation.js";
import {
  createProviderInvocationDescriptorV2,
  readProviderInvocationArtifactSetV2,
  type OpenCodeCliExecutableIdentityInputV2,
  type ProviderDispatchIntentV2,
  type ProviderInvocationDescriptorV2,
  type ProviderSessionBindingV2,
  type ProviderTerminalArtifactV2,
  type ProviderWorkerReceiptV2,
  RalphM4AError,
} from "./provider-invocation-artifacts.js";

export const OPENCODE_SESSION_IDENTITY_STATES_V2 = ["MATCH", "FOREIGN", "ABSENT", "UNKNOWN"] as const;
export type OpenCodeSessionIdentityStateV2 = typeof OPENCODE_SESSION_IDENTITY_STATES_V2[number];

export const OPENCODE_SESSION_ACTIVITY_STATES_V2 = ["ACTIVE", "STATUS_UNPROVEN", "INACTIVE", "UNKNOWN"] as const;
export type OpenCodeSessionActivityStateV2 = typeof OPENCODE_SESSION_ACTIVITY_STATES_V2[number];

export const OPENCODE_SESSION_MODEL_STATES_V2 = ["MATCH", "MISMATCH", "UNKNOWN"] as const;
export type OpenCodeSessionModelStateV2 = typeof OPENCODE_SESSION_MODEL_STATES_V2[number];

export const OPENCODE_SESSION_RESULT_STATES_V2 = ["MATCH", "MISMATCH", "ABSENT", "UNKNOWN"] as const;
export type OpenCodeSessionResultStateV2 = typeof OPENCODE_SESSION_RESULT_STATES_V2[number];

export const OPENCODE_SESSION_MESSAGE_STATES_V2 = ["MATCH", "MISMATCH", "ABSENT", "UNKNOWN"] as const;
export type OpenCodeSessionMessageStateV2 = typeof OPENCODE_SESSION_MESSAGE_STATES_V2[number];

export const PROVIDER_PROCESS_TREE_STATES_V2 = ["ACTIVE", "QUIESCENT", "UNKNOWN"] as const;
export type ProviderProcessTreeStateV2 = typeof PROVIDER_PROCESS_TREE_STATES_V2[number];

export interface OpenCodeCliSessionObservationV2 {
  readonly sessionIdentity: OpenCodeSessionIdentityStateV2;
  readonly observedSessionId: string | null;
  readonly activity: OpenCodeSessionActivityStateV2;
  readonly modelIdentity: OpenCodeSessionModelStateV2;
  readonly observedModelSelector: string | null;
  readonly userMessageIdentity: OpenCodeSessionMessageStateV2;
  readonly observedUserMessageId: string | null;
  readonly resultIdentity: OpenCodeSessionResultStateV2;
  readonly observedResultRef: string | null;
  readonly observedResultDigest: string | null;
}

export interface OpenCodeCliSessionInspectionInputV2 {
  readonly descriptor: ProviderInvocationDescriptorV2;
  readonly dispatchIntent: ProviderDispatchIntentV2;
  readonly sessionBinding: ProviderSessionBindingV2;
  readonly terminal: ProviderTerminalArtifactV2 | null;
}

/**
 * The session inspector is a physical-facts boundary. Its records are always
 * untrusted and are checked against the immutable session/result bindings.
 * M4-B will supply the supported OpenCode API/export implementation.
 */
export interface OpenCodeCliSessionInspectorV2 {
  readonly inspect: (input: OpenCodeCliSessionInspectionInputV2) => OpenCodeCliSessionObservationV2 | PromiseLike<OpenCodeCliSessionObservationV2>;
}

export interface ProviderProcessTreeInspectorV2 {
  readonly inspect: (input: {
    readonly processIdentity: ProcessIdentity;
    readonly processGroupId: number | null;
  }) => ProviderProcessTreeStateV2 | PromiseLike<ProviderProcessTreeStateV2>;
}

export interface OpenCodeCliInvocationObserverOptionsV2 {
  readonly store: RalphEventStoreV2;
  readonly executable: OpenCodeCliExecutableIdentityInputV2;
  readonly processIdentityProvider?: ProcessIdentityProvider;
  readonly processTreeInspector?: ProviderProcessTreeInspectorV2;
  readonly sessionInspector?: OpenCodeCliSessionInspectorV2;
  readonly clock?: () => string;
  readonly observationIdFactory?: () => string;
}

interface OpenCodeCliInvocationObserverInternalsV2 {
  readonly store: RalphEventStoreV2;
  readonly executable: Readonly<OpenCodeCliExecutableIdentityInputV2>;
  readonly processIdentityProvider: ProcessIdentityProvider;
  readonly processTreeInspector: ProviderProcessTreeInspectorV2;
  readonly sessionInspector: OpenCodeCliSessionInspectorV2;
  readonly clock: () => string;
  readonly observationIdFactory: () => string;
}

const observerInternals = new WeakMap<OpenCodeCliInvocationObserverV2, OpenCodeCliInvocationObserverInternalsV2>();
const trustedObserverMembers = new WeakSet<OpenCodeCliInvocationObserverV2>();

const conservativeProcessTreeInspector: ProviderProcessTreeInspectorV2 = Object.freeze({
  inspect: () => "UNKNOWN" as const,
});

const conservativeSessionInspector: OpenCodeCliSessionInspectorV2 = Object.freeze({
  inspect: () => ({
    sessionIdentity: "UNKNOWN" as const,
    observedSessionId: null,
    activity: "UNKNOWN" as const,
    modelIdentity: "UNKNOWN" as const,
    observedModelSelector: null,
    userMessageIdentity: "UNKNOWN" as const,
    observedUserMessageId: null,
    resultIdentity: "UNKNOWN" as const,
    observedResultRef: null,
    observedResultDigest: null,
  }),
});

/**
 * Nominal M4-A observer authority. It does not invoke OpenCode and is not an
 * ExecutorRuntimeV2. A future nominal M4-B runtime may delegate its observe()
 * method to this durable state machine.
 */
export class OpenCodeCliInvocationObserverV2 {
  readonly kind = "OPENCODE_CLI_INVOCATION_OBSERVER" as const;

  constructor(options: OpenCodeCliInvocationObserverOptionsV2) {
    if (new.target !== OpenCodeCliInvocationObserverV2) throw new RalphM4AError("M4A_PROVIDER_BINDING_INVALID", "M4A_OBSERVER_TRUST_REQUIRED");
    if (!options || typeof options !== "object" || !options.store || !options.executable) throw new RalphM4AError("M4A_PROVIDER_BINDING_INVALID", "M4A_OBSERVER_TRUST_REQUIRED");
    observerInternals.set(this, {
      store: options.store,
      executable: Object.freeze({ ...options.executable }),
      processIdentityProvider: options.processIdentityProvider ?? defaultProcessIdentityProvider,
      processTreeInspector: options.processTreeInspector ?? conservativeProcessTreeInspector,
      sessionInspector: options.sessionInspector ?? conservativeSessionInspector,
      clock: options.clock ?? (() => new Date().toISOString()),
      observationIdFactory: options.observationIdFactory ?? randomUUID,
    });
    trustedObserverMembers.add(this);
    Object.freeze(this);
  }

  async observe(authorizedInvocation: AuthorizedInvocationV2): Promise<ExecutorObservationEnvelopeV2> {
    assertTrustedOpenCodeCliInvocationObserverV2(this);
    assertAuthorizedInvocationV2(authorizedInvocation);
    const internal = requireObserverInternals(this);
    const expectedDescriptor = await createProviderInvocationDescriptorV2({
      store: internal.store,
      authorizedInvocation,
      executable: internal.executable,
    });
    const facts = await readProviderInvocationArtifactSetV2(internal.store, expectedDescriptor.attemptId);
    if (facts.descriptor && facts.descriptor.descriptorDigest !== expectedDescriptor.descriptorDigest) {
      throw new RalphM4AError("M4A_PROVIDER_BINDING_INVALID", "M4A_PROVIDER_BINDING_INVALID: provider descriptor differs from current Core authority");
    }
    if (facts.descriptor && facts.descriptor.invocationId !== authorizedInvocation.descriptor.invocationId) {
      throw new RalphM4AError("M4A_PROVIDER_BINDING_INVALID", "M4A_PROVIDER_BINDING_INVALID: foreign invocation");
    }

    const observedAt = internal.clock();
    const common = {
      runtimeIdentity: expectedDescriptor.runtimeIdentity,
      observationId: `m4a-observation-${internal.observationIdFactory()}`,
      invocationId: expectedDescriptor.invocationId,
      observedAt,
    };

    if (!facts.descriptor || !facts.dispatchIntent) {
      return buildExecutorObservationEnvelopeV2({
        ...common,
        state: "NOT_INVOKED",
        safeMetadata: {
          descriptor: facts.descriptor ? "PRESENT" : "ABSENT",
          dispatchIntent: "ABSENT",
          authority: "ATTEMPT_NAMESPACE",
        },
      });
    }

    // Once intent is durable, ambiguity never flows back to NOT_INVOKED.
    let processInspection: ProcessIdentityInspection = "UNKNOWN";
    let processTree: ProviderProcessTreeStateV2 = "UNKNOWN";
    if (facts.workerReceipt) {
      processInspection = await safelyInspectProcess(internal.processIdentityProvider, facts.workerReceipt);
      processTree = await safelyInspectProcessTree(internal.processTreeInspector, facts.workerReceipt);
    }
    const session = facts.sessionBinding
      ? await safelyInspectSession(internal.sessionInspector, expectedDescriptor, facts.dispatchIntent, facts.sessionBinding, facts.terminal ?? null)
      : undefined;

    const sessionBindingValid = session === undefined || (
      session.sessionIdentity === "MATCH"
      && session.observedSessionId === facts.sessionBinding?.openCodeSessionId
      && session.modelIdentity !== "MISMATCH"
      && (session.observedModelSelector === null || session.observedModelSelector === expectedDescriptor.modelSelector)
    );

    if (facts.terminal) {
      const terminalReady = facts.workerReceipt !== undefined
        && facts.sessionBinding !== undefined
        && processInspection === "ABSENT"
        && processTree === "QUIESCENT"
        && facts.terminal.quiescence.workerProcessState === "ABSENT"
        && facts.terminal.quiescence.processTreeState === "QUIESCENT"
        && sessionBindingValid
        && session?.modelIdentity === "MATCH"
        && session.observedModelSelector === expectedDescriptor.modelSelector
        && session.userMessageIdentity === "MATCH"
        && session.observedUserMessageId === facts.dispatchIntent.openCodeUserMessageId
        && session?.resultIdentity === "MATCH"
        && facts.terminal.resultRef !== null
        && facts.terminal.resultDigest !== null
        && session.observedResultRef === facts.terminal.resultRef
        && session.observedResultDigest === facts.terminal.resultDigest;
      if (terminalReady) {
        return buildExecutorObservationEnvelopeV2({
          ...common,
          state: "TERMINATED_QUIESCENT",
          status: facts.terminal.status,
          termination: facts.terminal.termination,
          resultEnvelopeStatus: facts.terminal.status === "UNAVAILABLE" ? "INVALID" : "VALID",
          exitCode: facts.terminal.exitCode,
          signal: facts.terminal.signal,
          startedAt: facts.workerReceipt.startedAt,
          finishedAt: facts.terminal.finishedAt,
          safeMetadata: observationMetadata(facts, processInspection, processTree, session),
        });
      }
      return unknownObservation(common, facts, processInspection, processTree, session);
    }

    // A live PID with a different birth identity is an explicit conflict. A
    // session status cannot rehabilitate that worker binding after PID reuse.
    if (processInspection === "START_MISMATCH") {
      return unknownObservation(common, facts, processInspection, processTree, session);
    }
    const exactWorkerActive = facts.workerReceipt !== undefined && processInspection === "MATCH";
    const exactSessionActive = facts.sessionBinding !== undefined && sessionBindingValid && session?.activity === "ACTIVE";
    if ((exactWorkerActive || exactSessionActive) && sessionBindingValid) {
      return buildExecutorObservationEnvelopeV2({
        ...common,
        state: "RUNNING",
        startedAt: facts.workerReceipt?.startedAt ?? facts.dispatchIntent.createdAt,
        safeMetadata: observationMetadata(facts, processInspection, processTree, session),
      });
    }
    return unknownObservation(common, facts, processInspection, processTree, session);
  }
}

export function isTrustedOpenCodeCliInvocationObserverV2(value: unknown): value is OpenCodeCliInvocationObserverV2 {
  return typeof value === "object" && value !== null && trustedObserverMembers.has(value as OpenCodeCliInvocationObserverV2);
}

export function assertTrustedOpenCodeCliInvocationObserverV2(value: unknown): asserts value is OpenCodeCliInvocationObserverV2 {
  if (!isTrustedOpenCodeCliInvocationObserverV2(value)) throw new RalphM4AError("M4A_PROVIDER_BINDING_INVALID", "M4A_OBSERVER_TRUST_REQUIRED");
}

function requireObserverInternals(value: OpenCodeCliInvocationObserverV2): OpenCodeCliInvocationObserverInternalsV2 {
  const internal = observerInternals.get(value);
  if (!internal) throw new RalphM4AError("M4A_PROVIDER_BINDING_INVALID", "M4A_OBSERVER_TRUST_REQUIRED");
  return internal;
}

async function safelyInspectProcess(provider: ProcessIdentityProvider, receipt: ProviderWorkerReceiptV2): Promise<ProcessIdentityInspection> {
  try {
    const observed = await provider.inspect(receipt.processIdentity);
    return ["MATCH", "ABSENT", "START_MISMATCH", "UNKNOWN"].includes(observed) ? observed : "UNKNOWN";
  } catch {
    return "UNKNOWN";
  }
}

async function safelyInspectProcessTree(inspector: ProviderProcessTreeInspectorV2, receipt: ProviderWorkerReceiptV2): Promise<ProviderProcessTreeStateV2> {
  try {
    const observed = await inspector.inspect({ processIdentity: receipt.processIdentity, processGroupId: receipt.processGroupId });
    return PROVIDER_PROCESS_TREE_STATES_V2.includes(observed) ? observed : "UNKNOWN";
  } catch {
    return "UNKNOWN";
  }
}

async function safelyInspectSession(
  inspector: OpenCodeCliSessionInspectorV2,
  descriptor: ProviderInvocationDescriptorV2,
  dispatchIntent: ProviderDispatchIntentV2,
  sessionBinding: ProviderSessionBindingV2,
  terminal: ProviderTerminalArtifactV2 | null,
): Promise<OpenCodeCliSessionObservationV2> {
  try {
    const observed = await inspector.inspect({ descriptor, dispatchIntent, sessionBinding, terminal });
    validateSessionObservation(observed);
    return Object.freeze({ ...observed });
  } catch {
    return {
      sessionIdentity: "UNKNOWN",
      observedSessionId: null,
      activity: "UNKNOWN",
      modelIdentity: "UNKNOWN",
      observedModelSelector: null,
      userMessageIdentity: "UNKNOWN",
      observedUserMessageId: null,
      resultIdentity: "UNKNOWN",
      observedResultRef: null,
      observedResultDigest: null,
    };
  }
}

function validateSessionObservation(value: OpenCodeCliSessionObservationV2): void {
  if (!value || typeof value !== "object") throw new Error("M4A_SESSION_OBSERVATION_INVALID");
  const keys = new Set(["sessionIdentity", "observedSessionId", "activity", "modelIdentity", "observedModelSelector", "userMessageIdentity", "observedUserMessageId", "resultIdentity", "observedResultRef", "observedResultDigest"]);
  if (Object.keys(value).some((key) => !keys.has(key))) throw new Error("M4A_SESSION_OBSERVATION_INVALID");
  if (!OPENCODE_SESSION_IDENTITY_STATES_V2.includes(value.sessionIdentity) || !OPENCODE_SESSION_ACTIVITY_STATES_V2.includes(value.activity) || !OPENCODE_SESSION_MODEL_STATES_V2.includes(value.modelIdentity) || !OPENCODE_SESSION_MESSAGE_STATES_V2.includes(value.userMessageIdentity) || !OPENCODE_SESSION_RESULT_STATES_V2.includes(value.resultIdentity)) throw new Error("M4A_SESSION_OBSERVATION_INVALID");
  for (const item of [value.observedSessionId, value.observedModelSelector, value.observedUserMessageId, value.observedResultRef, value.observedResultDigest]) {
    if (item !== null && (typeof item !== "string" || item.length === 0 || item.length > 512 || item.includes("\0"))) throw new Error("M4A_SESSION_OBSERVATION_INVALID");
  }
}

function unknownObservation(
  common: { readonly runtimeIdentity: string; readonly observationId: string; readonly invocationId: string; readonly observedAt: string },
  facts: Awaited<ReturnType<typeof readProviderInvocationArtifactSetV2>>,
  processInspection: ProcessIdentityInspection,
  processTree: ProviderProcessTreeStateV2,
  session: OpenCodeCliSessionObservationV2 | undefined,
): ExecutorObservationEnvelopeV2 {
  return buildExecutorObservationEnvelopeV2({
    ...common,
    state: "UNKNOWN",
    safeMetadata: observationMetadata(facts, processInspection, processTree, session),
  });
}

function observationMetadata(
  facts: Awaited<ReturnType<typeof readProviderInvocationArtifactSetV2>>,
  processInspection: ProcessIdentityInspection,
  processTree: ProviderProcessTreeStateV2,
  session: OpenCodeCliSessionObservationV2 | undefined,
): Readonly<Record<string, string>> {
  return {
    descriptor: facts.descriptor ? "PRESENT" : "ABSENT",
    dispatchIntent: facts.dispatchIntent ? "PRESENT" : "ABSENT",
    workerReceipt: facts.workerReceipt ? "PRESENT" : "ABSENT",
    sessionBinding: facts.sessionBinding ? "PRESENT" : "ABSENT",
    terminal: facts.terminal ? "PRESENT" : "ABSENT",
    processIdentity: processInspection,
    processTree,
    sessionIdentity: session?.sessionIdentity ?? "UNOBSERVED",
    sessionActivity: session?.activity ?? "UNOBSERVED",
    sessionModel: session?.modelIdentity ?? "UNOBSERVED",
    sessionMessage: session?.userMessageIdentity ?? "UNOBSERVED",
    sessionResult: session?.resultIdentity ?? "UNOBSERVED",
  };
}
