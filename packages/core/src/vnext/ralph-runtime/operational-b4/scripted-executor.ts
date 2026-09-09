import type { AuthorizedInvocationV2 } from "../operational-b3/index.js";
import { assertAuthorizedInvocationV2 } from "../operational-b3/index.js";
import { canonicalJson } from "../canonical-json.js";
import {
  buildExecutorObservationEnvelopeV2,
  type ExecutorObservationStateV2,
  type ExecutorObservationEnvelopeV2,
  type ExecutorResultEnvelopeStatusV2,
} from "./execution-observation.js";
import {
  ExecutorRuntimeError,
  ExecutorRuntimeV2,
  type CancelRequestReceiptV2,
  type ExecutorInvocationReceiptV2,
} from "./executor-runtime.js";
import {
  isTrustedOpenCodeCliExecutorV2,
  type OpenCodeCliExecutorV2,
} from "./opencode-cli-executor.js";
import {
  isTrustedCodexCliExecutorV2,
  type CodexCliExecutorV2,
} from "../operational-m5b/codex-cli-executor.js";

export const SCRIPTED_SCENARIO_KINDS = [
  "SUCCESS",
  "FAILED",
  "UNAVAILABLE_BEFORE_START",
  "TIMEOUT",
  "CANCELLED",
  "MALFORMED_RESULT",
  "START_THEN_CRASH",
  "RUNNING",
  "UNKNOWN",
  "PROTOCOL_FAILURE_BEFORE_START",
] as const;
export type ScriptedScenarioKindV2 = typeof SCRIPTED_SCENARIO_KINDS[number];

export interface ScriptedWorkspaceActionContextV2 {
  readonly invocationId: string;
  readonly runId: string;
  readonly phaseId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly workUnitId: string;
  /** Core-validated correction input; absent on the first Attempt. */
  readonly correctionContext?: ScriptedExecutorCorrectionContextV2;
}

export interface ScriptedExecutorCorrectionContextV2 {
  readonly contextId: string;
  readonly contextDigest: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly findingIds: readonly string[];
  readonly findingDigests: readonly string[];
  readonly openFindings: readonly Readonly<Record<string, string>>[];
}

/** Test-fixture-only workspace hook; it is never a plan command or a shell. */
export type ScriptedWorkspaceActionV2 = (context: ScriptedWorkspaceActionContextV2) => void | Promise<void>;

export interface ScriptedExecutorScenarioV2 {
  readonly kind: ScriptedScenarioKindV2;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly quiescence?: "QUIESCENT" | "UNKNOWN";
  readonly safeMetadata?: Readonly<Record<string, string>>;
  /** Injected only by disposable tests to mutate a fixture workspace. */
  readonly fixtureWorkspaceAction?: ScriptedWorkspaceActionV2;
}

export interface ScriptedObservationSeedV2 {
  readonly state: ExecutorObservationStateV2;
  readonly status?: "SUCCEEDED" | "FAILED" | "CANCELLED" | "TIMED_OUT" | "UNAVAILABLE";
  readonly termination?: "NORMAL" | "ERROR" | "TIMEOUT" | "CANCELLED" | "PROVIDER_UNAVAILABLE";
  readonly resultEnvelopeStatus?: ExecutorResultEnvelopeStatusV2;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly safeMetadata?: Readonly<Record<string, string>>;
}

export interface ScriptedExecutorOptionsV2 {
  readonly runtimeIdentity?: string;
  readonly clock?: () => string;
  readonly defaultScenario?: ScriptedExecutorScenarioV2;
  readonly scenarios?: ReadonlyMap<string, ScriptedExecutorScenarioV2> | Readonly<Record<string, ScriptedExecutorScenarioV2>>;
}

interface ScriptRecordV2 {
  scenario: ScriptedExecutorScenarioV2;
  state: ExecutorObservationStateV2;
  status?: ScriptedObservationSeedV2["status"];
  termination?: ScriptedObservationSeedV2["termination"];
  resultEnvelopeStatus?: ExecutorResultEnvelopeStatusV2;
  exitCode?: number | null;
  signal?: string | null;
  startedAt?: string;
  finishedAt?: string;
  startedObservationId?: string;
  physicalStarted: boolean;
  dispatchAttempts: number;
  cancellationRequested: boolean;
}

const DEFAULT_SCENARIO: ScriptedExecutorScenarioV2 = { kind: "SUCCESS", exitCode: 0 };
const trustedExecutorRuntimeMembers = new WeakSet<ScriptedExecutor>();

/**
 * Deterministic M2 runtime.  It records only bounded observations and can
 * mutate a caller-owned disposable fixture through the explicit test hook.
 * There is intentionally no process, network, or external tool surface.
 */
export class ScriptedExecutor extends ExecutorRuntimeV2 {
  readonly kind = "EXECUTOR_RUNTIME" as const;
  readonly runtimeIdentity: string;
  private readonly clock: () => string;
  private readonly defaultScenario: ScriptedExecutorScenarioV2;
  private readonly configuredScenarios: ReadonlyMap<string, ScriptedExecutorScenarioV2> | Readonly<Record<string, ScriptedExecutorScenarioV2>> | undefined;
  private readonly records = new Map<string, ScriptRecordV2>();
  private observationOrdinal = 0;
  private cancelOrdinal = 0;
  private readonly invocationAttempts = new Map<string, number>();
  private readonly correctionContexts = new Map<string, ScriptedExecutorCorrectionContextV2>();

  constructor(options: ScriptedExecutorOptionsV2 = {}) {
    super();
    if (new.target !== ScriptedExecutor) throw new ExecutorRuntimeError("B4_EXECUTOR_AUTHORIZATION_REQUIRED", "B4_EXECUTOR_AUTHORIZATION_REQUIRED: only ScriptedExecutor may possess runtime authority");
    trustedExecutorRuntimeMembers.add(this);
    this.runtimeIdentity = options.runtimeIdentity ?? "scripted-runtime-v2";
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.defaultScenario = options.defaultScenario ?? DEFAULT_SCENARIO;
    this.configuredScenarios = options.scenarios;
  }

  async observe(invocationId: string): Promise<ExecutorObservationEnvelopeV2> {
    assertInvocationId(invocationId);
    const record = this.records.get(invocationId) ?? this.createNotInvokedRecord(invocationId);
    return this.observationFor(invocationId, record);
  }

  async invoke(authorizedInvocation: AuthorizedInvocationV2): Promise<ExecutorInvocationReceiptV2> {
    assertAuthorizedInvocationV2(authorizedInvocation);
    const descriptor = authorizedInvocation.descriptor;
    const invocationId = descriptor.invocationId;
    const record = this.records.get(invocationId) ?? this.createNotInvokedRecord(invocationId);
    if (record.state !== "NOT_INVOKED") {
      throw new ExecutorRuntimeError("B4_EXECUTOR_REDISPATCH_FORBIDDEN", "B4_EXECUTOR_REDISPATCH_FORBIDDEN: observation is not NOT_INVOKED");
    }
    record.dispatchAttempts += 1;
    this.invocationAttempts.set(invocationId, record.dispatchAttempts);
    const scenario = record.scenario;
    if (scenario.kind === "PROTOCOL_FAILURE_BEFORE_START") {
      throw new ExecutorRuntimeError("B4_EXECUTOR_PROTOCOL_FAILURE_BEFORE_START", "B4_EXECUTOR_PROTOCOL_FAILURE_BEFORE_START");
    }
    const acceptedAt = this.clock();
    if (scenario.kind === "UNAVAILABLE_BEFORE_START") {
      record.state = "TERMINATED_QUIESCENT";
      record.status = "UNAVAILABLE";
      record.termination = "PROVIDER_UNAVAILABLE";
      record.resultEnvelopeStatus = "INVALID";
      record.finishedAt = acceptedAt;
      record.physicalStarted = false;
      return { invocationId, runtimeIdentity: this.runtimeIdentity, acceptedAt, physicalStart: "NOT_STARTED" };
    }

    record.physicalStarted = true;
    record.startedAt = acceptedAt;
    record.state = "RUNNING";
    try {
      await this.runFixtureAction(scenario, descriptor);
    } catch {
      record.state = "TERMINATED_QUIESCENT";
      record.status = "FAILED";
      record.termination = "ERROR";
      record.resultEnvelopeStatus = "VALID";
      record.exitCode = 1;
      record.signal = null;
      record.finishedAt = this.clock();
      return { invocationId, runtimeIdentity: this.runtimeIdentity, acceptedAt, physicalStart: "STARTED" };
    }
    const terminal = this.terminalForScenario(scenario);
    if (terminal) {
      record.state = terminal.state;
      record.status = terminal.status;
      record.termination = terminal.termination;
      record.resultEnvelopeStatus = terminal.resultEnvelopeStatus;
      record.exitCode = terminal.exitCode;
      record.signal = terminal.signal;
      record.finishedAt = terminal.finishedAt;
    } else if (scenario.kind === "UNKNOWN" || (scenario.quiescence === "UNKNOWN" && scenario.kind !== "RUNNING")) {
      // The request may have crossed the physical boundary without a trusted
      // quiescence observation.  Keep that ambiguity explicit; never leave a
      // terminal-looking record that could accidentally be redispatched.
      record.state = "UNKNOWN";
    }
    return { invocationId, runtimeIdentity: this.runtimeIdentity, acceptedAt, physicalStart: "STARTED" };
  }

  async requestCancel(invocationId: string): Promise<CancelRequestReceiptV2> {
    assertInvocationId(invocationId);
    const record = this.records.get(invocationId) ?? this.createNotInvokedRecord(invocationId);
    record.cancellationRequested = true;
    const requestedAt = this.clock();
    if (record.state === "RUNNING") {
      const quiescent = record.scenario.quiescence !== "UNKNOWN";
      if (quiescent) {
        record.state = "TERMINATED_QUIESCENT";
        record.status = "CANCELLED";
        record.termination = "CANCELLED";
        record.resultEnvelopeStatus = "VALID";
        record.exitCode = record.scenario.exitCode ?? null;
        record.signal = record.scenario.signal ?? "SIGTERM";
        record.finishedAt = requestedAt;
      } else {
        record.state = "UNKNOWN";
      }
    } else if (record.state === "NOT_INVOKED") {
      record.state = "TERMINATED_QUIESCENT";
      record.status = "CANCELLED";
      record.termination = "CANCELLED";
      record.resultEnvelopeStatus = "VALID";
      record.exitCode = record.scenario.exitCode ?? null;
      record.signal = record.scenario.signal ?? "SIGTERM";
      record.finishedAt = requestedAt;
      record.physicalStarted = false;
    }
    return {
      requestId: `cancel-${++this.cancelOrdinal}`,
      invocationId,
      runtimeIdentity: this.runtimeIdentity,
      requestedAt,
      requestState: record.state === "UNKNOWN" ? "UNKNOWN" : "ISSUED",
    };
  }

  /**
   * Attach a Core-persisted correction context before crossing the Executor
   * side-effect boundary. This method is intentionally available only on the
   * nominal ScriptedExecutor runtime, never on a caller-supplied record.
   */
  setCorrectionContext(invocationId: string, context: ScriptedExecutorCorrectionContextV2): void {
    assertInvocationId(invocationId);
    if (context.taskId.length === 0 || context.attemptId.length === 0 || context.findingIds.length !== context.findingDigests.length || context.findingIds.length !== context.openFindings.length) {
      throw new ExecutorRuntimeError("B4_EXECUTOR_AUTHORIZATION_REQUIRED", "B4_EXECUTOR_AUTHORIZATION_REQUIRED: malformed correction context");
    }
    const existing = this.correctionContexts.get(invocationId);
    if (existing && canonicalJson(existing) !== canonicalJson(context)) throw new ExecutorRuntimeError("B4_EXECUTOR_REDISPATCH_FORBIDDEN", "B4_EXECUTOR_REDISPATCH_FORBIDDEN: correction context is immutable");
    this.correctionContexts.set(invocationId, freezeCorrectionContext(context));
  }

  /** Seed an untrusted recovery observation for a deterministic test. */
  seedObservation(invocationId: string, seed: ScriptedObservationSeedV2): void {
    assertInvocationId(invocationId);
    const scenario = this.scenarioFor(invocationId);
    const record: ScriptRecordV2 = {
      scenario,
      state: seed.state,
      status: seed.status,
      termination: seed.termination,
      resultEnvelopeStatus: seed.resultEnvelopeStatus,
      exitCode: seed.exitCode,
      signal: seed.signal,
      startedAt: seed.startedAt,
      finishedAt: seed.finishedAt,
      physicalStarted: seed.state !== "NOT_INVOKED",
      dispatchAttempts: 0,
      cancellationRequested: false,
    };
    if (seed.state === "RUNNING" && !record.startedAt) record.startedAt = this.clock();
    if (seed.state === "TERMINATED_QUIESCENT" && !record.finishedAt) record.finishedAt = this.clock();
    if (seed.state === "TERMINATED_QUIESCENT") {
      record.status ??= "FAILED";
      record.termination ??= "ERROR";
      record.resultEnvelopeStatus ??= "VALID";
      record.exitCode ??= 1;
    }
    this.records.set(invocationId, record);
  }

  setScenario(invocationId: string, scenario: ScriptedExecutorScenarioV2): void {
    assertInvocationId(invocationId);
    const record = this.records.get(invocationId);
    if (record && record.state !== "NOT_INVOKED") throw new ExecutorRuntimeError("B4_EXECUTOR_REDISPATCH_FORBIDDEN", "B4_EXECUTOR_REDISPATCH_FORBIDDEN: scenario is immutable after start");
    if (record) record.scenario = freezeScenario(scenario);
    else this.records.set(invocationId, this.createRecord(invocationId, scenario));
  }

  getInvocationAttempts(invocationId: string): number {
    assertInvocationId(invocationId);
    return this.invocationAttempts.get(invocationId) ?? 0;
  }

  get totalInvocationAttempts(): number {
    return [...this.invocationAttempts.values()].reduce((total, value) => total + value, 0);
  }

  private createNotInvokedRecord(invocationId: string): ScriptRecordV2 {
    const record = this.createRecord(invocationId, this.scenarioFor(invocationId));
    this.records.set(invocationId, record);
    return record;
  }

  private createRecord(_invocationId: string, scenario: ScriptedExecutorScenarioV2): ScriptRecordV2 {
    return {
      scenario: freezeScenario(scenario),
      // UNKNOWN is an intentionally ambiguous pre-existing observation.  It
      // must block dispatch rather than be converted into a first invoke.
      state: scenario.kind === "UNKNOWN" ? "UNKNOWN" : "NOT_INVOKED",
      physicalStarted: false,
      dispatchAttempts: 0,
      cancellationRequested: false,
    };
  }

  private scenarioFor(invocationId: string): ScriptedExecutorScenarioV2 {
    if (this.configuredScenarios instanceof Map) return this.configuredScenarios.get(invocationId) ?? this.defaultScenario;
    if (this.configuredScenarios) {
      const configured = this.configuredScenarios as Readonly<Record<string, ScriptedExecutorScenarioV2>>;
      if (invocationId in configured) return configured[invocationId]!;
    }
    return this.defaultScenario;
  }

  private async runFixtureAction(scenario: ScriptedExecutorScenarioV2, invocation: AuthorizedInvocationV2["descriptor"]): Promise<void> {
    if (!scenario.fixtureWorkspaceAction) return;
    try {
      await scenario.fixtureWorkspaceAction({
        invocationId: invocation.invocationId,
        runId: invocation.runId,
        phaseId: invocation.phaseId,
        taskId: invocation.taskId,
        attemptId: invocation.attemptId,
        workUnitId: invocation.workUnitId,
        ...(this.correctionContexts.has(invocation.invocationId) ? { correctionContext: this.correctionContexts.get(invocation.invocationId) } : {}),
      });
    } catch {
      // A fixture action failure is represented as a bounded execution failure;
      // the failure text is intentionally not copied into a runtime artifact.
      throw new Error("B4_SCRIPTED_FIXTURE_ACTION_FAILED");
    }
  }

  private terminalForScenario(scenario: ScriptedExecutorScenarioV2): {
    readonly state: ExecutorObservationStateV2;
    readonly status: ScriptRecordV2["status"];
    readonly termination: ScriptRecordV2["termination"];
    readonly resultEnvelopeStatus: ExecutorResultEnvelopeStatusV2;
    readonly exitCode: number | null;
    readonly signal: string | null;
    readonly finishedAt: string;
  } | undefined {
    const finishedAt = this.clock();
    const quiescent = scenario.quiescence !== "UNKNOWN";
    if (scenario.kind === "RUNNING" || scenario.kind === "UNKNOWN" || !quiescent) return undefined;
    switch (scenario.kind) {
      case "SUCCESS":
        return { state: "TERMINATED_QUIESCENT", status: "SUCCEEDED", termination: "NORMAL", resultEnvelopeStatus: "VALID", exitCode: scenario.exitCode ?? 0, signal: scenario.signal ?? null, finishedAt };
      case "FAILED":
        return { state: "TERMINATED_QUIESCENT", status: "FAILED", termination: "ERROR", resultEnvelopeStatus: "VALID", exitCode: scenario.exitCode ?? 1, signal: scenario.signal ?? null, finishedAt };
      case "TIMEOUT":
        return { state: "TERMINATED_QUIESCENT", status: "TIMED_OUT", termination: "TIMEOUT", resultEnvelopeStatus: "VALID", exitCode: scenario.exitCode ?? null, signal: scenario.signal ?? null, finishedAt };
      case "CANCELLED":
        return { state: "TERMINATED_QUIESCENT", status: "CANCELLED", termination: "CANCELLED", resultEnvelopeStatus: "VALID", exitCode: scenario.exitCode ?? null, signal: scenario.signal ?? "SIGTERM", finishedAt };
      case "MALFORMED_RESULT":
        return { state: "TERMINATED_QUIESCENT", status: "FAILED", termination: "ERROR", resultEnvelopeStatus: "INVALID", exitCode: scenario.exitCode ?? 1, signal: scenario.signal ?? null, finishedAt };
      case "START_THEN_CRASH":
        return { state: "TERMINATED_QUIESCENT", status: "FAILED", termination: "ERROR", resultEnvelopeStatus: "VALID", exitCode: scenario.exitCode ?? 1, signal: scenario.signal ?? null, finishedAt };
      case "UNAVAILABLE_BEFORE_START":
      case "PROTOCOL_FAILURE_BEFORE_START":
        return undefined;
    }
  }

  private observationFor(invocationId: string, record: ScriptRecordV2): ExecutorObservationEnvelopeV2 {
    const observationId = `obs-${++this.observationOrdinal}`;
    if ((record.state === "RUNNING" || record.state === "TERMINATED_QUIESCENT") && record.startedAt && !record.startedObservationId) {
      record.startedObservationId = observationId;
    }
    return buildExecutorObservationEnvelopeV2({
      runtimeIdentity: this.runtimeIdentity,
      observationId,
      invocationId,
      state: record.state,
      observedAt: this.clock(),
      ...(record.status === undefined ? {} : { status: record.status }),
      ...(record.termination === undefined ? {} : { termination: record.termination }),
      ...(record.resultEnvelopeStatus === undefined ? {} : { resultEnvelopeStatus: record.resultEnvelopeStatus }),
      ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
      ...(record.signal === undefined ? {} : { signal: record.signal }),
      ...(record.state === "RUNNING" || record.state === "TERMINATED_QUIESCENT" ? (record.startedAt === undefined ? {} : { startedAt: record.startedAt }) : {}),
      ...(record.state === "TERMINATED_QUIESCENT" ? (record.finishedAt === undefined ? {} : { finishedAt: record.finishedAt }) : {}),
      ...(record.state === "RUNNING" || record.state === "TERMINATED_QUIESCENT"
        ? (record.startedObservationId === undefined ? {} : { startedObservationId: record.startedObservationId })
        : {}),
      safeMetadata: { ...(record.scenario.safeMetadata ?? {}), ...(record.cancellationRequested ? { cancellationRequested: "true" } : {}) },
    });
  }
}

/** Explicit union of the only nominal Executor capabilities trusted by Core. */
export type TrustedExecutorRuntimeV2 = ScriptedExecutor | OpenCodeCliExecutorV2 | CodexCliExecutorV2;

export function isTrustedExecutorRuntimeV2(value: unknown): value is TrustedExecutorRuntimeV2 {
  return typeof value === "object" && value !== null
    && (trustedExecutorRuntimeMembers.has(value as ScriptedExecutor)
      || isTrustedOpenCodeCliExecutorV2(value)
      || isTrustedCodexCliExecutorV2(value));
}

export function assertTrustedExecutorRuntimeV2(value: unknown): asserts value is TrustedExecutorRuntimeV2 {
  if (!isTrustedExecutorRuntimeV2(value)) {
    throw new ExecutorRuntimeError("B4_EXECUTOR_AUTHORIZATION_REQUIRED", "B4_EXECUTOR_AUTHORIZATION_REQUIRED: genuine ScriptedExecutor, OpenCodeCliExecutorV2 or CodexCliExecutorV2 runtime is required");
  }
}

function freezeScenario(value: ScriptedExecutorScenarioV2): ScriptedExecutorScenarioV2 {
  return Object.freeze({ ...value, ...(value.safeMetadata === undefined ? {} : { safeMetadata: Object.freeze({ ...value.safeMetadata }) }) });
}

function assertInvocationId(value: string): void {
  if (typeof value !== "string" || !/^inv-[A-Za-z0-9._-]{1,200}$/.test(value)) throw new ExecutorRuntimeError("B4_EXECUTOR_INVOCATION_ID_INVALID");
}

function freezeCorrectionContext(value: ScriptedExecutorCorrectionContextV2): ScriptedExecutorCorrectionContextV2 {
  return Object.freeze({
    ...value,
    findingIds: Object.freeze([...value.findingIds]),
    findingDigests: Object.freeze([...value.findingDigests]),
    openFindings: Object.freeze(value.openFindings.map((finding) => Object.freeze({ ...finding }))),
  });
}
