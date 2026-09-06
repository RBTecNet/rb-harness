import type { AuthorizedInvocationV2 } from "../operational-b3/index.js";
import {
  validateExecutorObservationEnvelopeV2,
  type ExecutorObservationEnvelopeV2,
  type ExecutorObservationStateV2,
} from "./execution-observation.js";

export const EXECUTOR_RUNTIME_ERROR_CODES = [
  "B4_EXECUTOR_AUTHORIZATION_REQUIRED",
  "B4_EXECUTOR_INVOCATION_ID_INVALID",
  "B4_EXECUTOR_REDISPATCH_FORBIDDEN",
  "B4_EXECUTOR_PROTOCOL_FAILURE_BEFORE_START",
  "B4_EXECUTOR_CANCEL_REQUEST_FAILED",
] as const;
export type ExecutorRuntimeErrorCode = typeof EXECUTOR_RUNTIME_ERROR_CODES[number];

export class ExecutorRuntimeError extends Error {
  constructor(readonly code: ExecutorRuntimeErrorCode, message: string = code, readonly cause?: unknown) {
    super(message);
    this.name = "ExecutorRuntimeError";
  }
}

export interface ExecutorInvocationReceiptV2 {
  readonly invocationId: string;
  readonly runtimeIdentity: string;
  readonly acceptedAt: string;
  readonly physicalStart: "STARTED" | "NOT_STARTED";
}

export interface CancelRequestReceiptV2 {
  readonly requestId: string;
  readonly invocationId: string;
  readonly runtimeIdentity: string;
  readonly requestedAt: string;
  readonly requestState: "ISSUED" | "UNKNOWN";
}

/**
 * The only side-effecting boundary exposed to M2.  This is an abstract,
 * nominal protocol base rather than a structural interface: Core callers may
 * carry a genuine runtime implementation, but a plain record is not a
 * runtime authority.  The M2 runtime membership check lives with the sole
 * implementation in scripted-executor.ts.
 */
export abstract class ExecutorRuntimeV2 {
  // A TypeScript-private member makes the protocol nominal at compile time.
  // Runtime authority is enforced separately by ScriptedExecutor membership.
  private readonly executorRuntimeNominalBrand!: void;

  protected constructor() {}

  abstract readonly kind: "EXECUTOR_RUNTIME";
  abstract readonly runtimeIdentity: string;
  abstract invoke(authorizedInvocation: AuthorizedInvocationV2): Promise<ExecutorInvocationReceiptV2>;
  abstract observe(invocationId: string): Promise<ExecutorObservationEnvelopeV2>;
  abstract requestCancel(invocationId: string): Promise<CancelRequestReceiptV2>;
}

export type ExecutorRuntime = ExecutorRuntimeV2;

export function assertRuntimeObservation(value: unknown): asserts value is ExecutorObservationEnvelopeV2 {
  validateExecutorObservationEnvelopeV2(value);
}

export function assertObservationForInvocation(observation: ExecutorObservationEnvelopeV2, invocationId: string): void {
  validateExecutorObservationEnvelopeV2(observation);
  if (observation.invocationId !== invocationId) throw new ExecutorRuntimeError("B4_EXECUTOR_INVOCATION_ID_INVALID", "B4_EXECUTOR_INVOCATION_ID_INVALID: observation binding mismatch");
}

export function isQuiescentObservation(value: ExecutorObservationEnvelopeV2): boolean {
  return value.state === "TERMINATED_QUIESCENT";
}

export function observationState(value: ExecutorObservationEnvelopeV2): ExecutorObservationStateV2 {
  return value.state;
}
