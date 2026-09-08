import { sha256Canonical } from "../hashing.js";
import { ExecutorRuntimeError } from "./executor-runtime.js";

export const OPENCODE_CLI_EXECUTOR_PROFILE_V2 = "opencode:cli:opencode-go/deepseek-v4-pro" as const;
export const OPENCODE_CLI_EXECUTOR_MODEL_V2 = "opencode-go/deepseek-v4-pro" as const;
export const OPENCODE_CLI_EXECUTOR_PROVIDER_V2 = "opencode-go" as const;
export const OPENCODE_CLI_EXECUTOR_MODEL_ID_V2 = "deepseek-v4-pro" as const;
export const OPENCODE_CLI_EXECUTOR_TRANSPORT_VERSION_V2 = "1.18.29" as const;
export const OPENCODE_CLI_EXECUTOR_PATH_V2 = "/home/bruno/.opencode/bin/opencode" as const;

export const M4B_TIMEOUT_POLICY_SCHEMA_V2 = "rb-ralph-timeout/v2" as const;

export interface M4BTimeoutPolicyV2 {
  readonly schema: typeof M4B_TIMEOUT_POLICY_SCHEMA_V2;
  /** Total wall-clock deadline for the one physical provider dispatch. */
  readonly deadlineMs: number;
  readonly policyDigest: string;
}

export const M4B_ERROR_CODES = [
  "M4B_CORRECTION_CONTEXT_NOT_SUPPORTED",
  "M4B_PROFILE_BINDING_INVALID",
  "M4B_CONFORMANCE_REQUIRED",
  "M4B_EXECUTABLE_IDENTITY_INVALID",
  "M4B_TIMEOUT_POLICY_INVALID",
  "M4B_WORKSPACE_BINDING_INVALID",
  "M4B_PROCESS_START_FAILED",
  "M4B_PROCESS_IDENTITY_INVALID",
  "M4B_SERVER_START_FAILED",
  "M4B_SESSION_BINDING_INVALID",
  "M4B_PROMPT_ORDER_INVALID",
  "M4B_MODEL_MISMATCH",
  "M4B_PROVIDER_RESULT_INVALID",
  "M4B_PROVIDER_OUTPUT_LIMIT",
  "M4B_PROVIDER_CREDENTIAL_MATERIAL",
  "M4B_PROCESS_TREE_NOT_QUIESCENT",
  "M4B_REDISPATCH_FORBIDDEN",
] as const;
export type M4BErrorCode = typeof M4B_ERROR_CODES[number];

/**
 * A typed M4-B failure before the physical model boundary is also a frozen
 * B4 protocol-before-start failure. This lets the existing B4 closure path
 * remain authoritative without adding an event or closure reason.
 */
export class RalphM4BError extends ExecutorRuntimeError {
  readonly name = "RalphM4BError";

  constructor(readonly m4bCode: M4BErrorCode, message: string = m4bCode, cause?: unknown) {
    super("B4_EXECUTOR_PROTOCOL_FAILURE_BEFORE_START", message, cause);
  }
}

export function createM4BTimeoutPolicyV2(deadlineMs: number): M4BTimeoutPolicyV2 {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1) throw new RalphM4BError("M4B_TIMEOUT_POLICY_INVALID");
  const base = { schema: M4B_TIMEOUT_POLICY_SCHEMA_V2, deadlineMs };
  return Object.freeze({ ...base, policyDigest: sha256Canonical(base) });
}

export function validateM4BTimeoutPolicyV2(value: unknown): asserts value is M4BTimeoutPolicyV2 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RalphM4BError("M4B_TIMEOUT_POLICY_INVALID");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["schema", "deadlineMs", "policyDigest"].includes(key))) throw new RalphM4BError("M4B_TIMEOUT_POLICY_INVALID");
  if (record.schema !== M4B_TIMEOUT_POLICY_SCHEMA_V2 || !Number.isSafeInteger(record.deadlineMs) || Number(record.deadlineMs) < 1) throw new RalphM4BError("M4B_TIMEOUT_POLICY_INVALID");
  const base = { schema: record.schema, deadlineMs: record.deadlineMs };
  if (record.policyDigest !== sha256Canonical(base)) throw new RalphM4BError("M4B_TIMEOUT_POLICY_INVALID");
}
