import { ExecutorRuntimeError } from "../operational-b4/executor-runtime.js";

/**
 * Ralph M5-B — the typed error vocabulary.
 *
 * It lives in its own module so the managed-runtime binding can raise typed
 * M5-B failures while `contract.ts` derives its pinned identity FROM that
 * binding, without the two importing each other.
 */
export const M5B_ERROR_CODES = [
  "M5B_EXECUTABLE_IDENTITY_INVALID",
  "M5B_MANAGED_RUNTIME_INVALID",
  "M5B_PROFILE_BINDING_INVALID",
  "M5B_CAPABILITY_RECORD_INVALID",
  "M5B_PERMISSION_PROFILE_INVALID",
  "M5B_SANDBOX_BACKEND_INVALID",
  "M5B_CREDENTIAL_FILE_BOUNDARY_UNSAFE",
  "M5B_CORRECTION_CONTEXT_NOT_SUPPORTED",
  "M5B_TIMEOUT_POLICY_INVALID",
  "M5B_WORKSPACE_BINDING_INVALID",
  "M5B_ARGV_POLICY_INVALID",
  "M5B_CHILD_ENVIRONMENT_INVALID",
  "M5B_PROJECTION_INVALID",
  "M5B_PROJECTION_CONTROL_PLANE_PATH",
  "M5B_PROJECTION_PATH_UNSAFE",
  "M5B_PROJECTION_LIMIT_EXCEEDED",
  "M5B_SENTINEL_MANIFEST_INVALID",
  "M5B_SENTINEL_MISSING",
  "M5B_SENTINEL_VIOLATED",
  "M5B_PROCESS_START_FAILED",
  "M5B_PROCESS_IDENTITY_INVALID",
  "M5B_PROCESS_TREE_NOT_QUIESCENT",
  "M5B_THREAD_BINDING_INVALID",
  "M5B_EVENT_STREAM_INVALID",
  "M5B_EVENT_STREAM_LIMIT",
  "M5B_TERMINAL_REQUIRED",
  "M5B_PROVIDER_RESULT_INVALID",
  "M5B_PROVIDER_OUTPUT_LIMIT",
  "M5B_PROVIDER_CREDENTIAL_MATERIAL",
  "M5B_PROVIDER_MODEL_SURFACE_UNEXPECTED",
  "M5B_DELTA_INVALID",
  "M5B_DELTA_PATH_FORBIDDEN",
  "M5B_DELTA_OUT_OF_SCOPE",
  "M5B_DELTA_UNSUPPORTED_MUTATION",
  "M5B_DELTA_LIMIT_EXCEEDED",
  "M5B_CANONICAL_DRIFT",
  "M5B_PUBLICATION_INVALID",
  "M5B_PUBLICATION_DIVERGENCE",
  "M5B_PUBLICATION_RECONCILIATION_REQUIRED",
  "M5B_REDISPATCH_FORBIDDEN",
  "M5B_ACCEPTANCE_RECEIPT_INVALID",
] as const;
export type M5BErrorCode = typeof M5B_ERROR_CODES[number];

/**
 * A typed M5-B failure is also a frozen B4 protocol-before-start failure so
 * the existing closure path stays authoritative.  Whether a given failure is
 * genuinely pre-dispatch is never decided by this class: the Codex observer
 * decides it from durable artifacts, and anything after the dispatch intent
 * is UNKNOWN rather than NOT_INVOKED.
 */
export class RalphM5BError extends ExecutorRuntimeError {
  readonly name = "RalphM5BError";

  constructor(readonly m5bCode: M5BErrorCode, message: string = m5bCode, cause?: unknown) {
    super("B4_EXECUTOR_PROTOCOL_FAILURE_BEFORE_START", message, cause);
  }
}
