import { sha256Canonical } from "../hashing.js";
import {
  OPENCODE_CLI_EXECUTOR_MODEL_ID_V2,
  OPENCODE_CLI_EXECUTOR_MODEL_V2,
  OPENCODE_CLI_EXECUTOR_PROFILE_V2,
  OPENCODE_CLI_EXECUTOR_PROVIDER_V2,
  OPENCODE_CLI_EXECUTOR_TRANSPORT_VERSION_V2,
} from "../operational-b4/opencode-cli-contract.js";

/**
 * M4-D binds the Auditor to the same conformance-proven OpenCode CLI transport
 * the frozen Executor uses. The transport is shared; the ROLE is not. Every
 * identity minted below is derived from an explicit `role: "AUDITOR"` preimage,
 * so an Auditor identity can never collide with an Executor identity even when
 * both select the same provider and model.
 */
export const OPENCODE_CLI_AUDITOR_ROLE_V2 = "AUDITOR" as const;
export const OPENCODE_CLI_AUDITOR_TRANSPORT_V2 = "opencode-cli" as const;
export const OPENCODE_CLI_AUDITOR_PROFILE_V2 = OPENCODE_CLI_EXECUTOR_PROFILE_V2;
export const OPENCODE_CLI_AUDITOR_MODEL_V2 = OPENCODE_CLI_EXECUTOR_MODEL_V2;
export const OPENCODE_CLI_AUDITOR_PROVIDER_V2 = OPENCODE_CLI_EXECUTOR_PROVIDER_V2;
export const OPENCODE_CLI_AUDITOR_MODEL_ID_V2 = OPENCODE_CLI_EXECUTOR_MODEL_ID_V2;
export const OPENCODE_CLI_AUDITOR_TRANSPORT_VERSION_V2 = OPENCODE_CLI_EXECUTOR_TRANSPORT_VERSION_V2;

/**
 * Core-facing Auditor profile id.
 *
 * The frozen E audit invocation identity forbids `/` in any identity segment,
 * so the exact semantic profile `opencode:cli:opencode-go/deepseek-v4-pro`
 * cannot itself be the Core-facing profile id. This is its deterministic
 * slash-free encoding, prefixed with the role so it can never collide with an
 * Executor profile identity. The exact semantic profile is still bound, byte
 * for byte, by the audit provider descriptor and by the conformance record.
 */
export const OPENCODE_CLI_AUDITOR_CORE_PROFILE_ID_V2 = `opencode-cli-auditor:${OPENCODE_CLI_EXECUTOR_MODEL_V2.replace("/", ":")}` as const;

export const M4D_ERROR_CODES = [
  "M4D_AUDITOR_AUTHORITY_REQUIRED",
  "M4D_AUDIT_PACKAGE_INVALID",
  "M4D_AUDIT_INVOCATION_REQUIRED",
  "M4D_AUDIT_INVOCATION_BINDING_INVALID",
  "M4D_AUDIT_ALREADY_RECONCILED",
  "M4D_PROFILE_BINDING_INVALID",
  "M4D_CONFORMANCE_REQUIRED",
  "M4D_EXECUTABLE_IDENTITY_INVALID",
  "M4D_TIMEOUT_POLICY_INVALID",
  "M4D_PERMISSIONS_NOT_READ_ONLY",
  "M4D_WORKSPACE_BINDING_INVALID",
  "M4D_WORKSPACE_MUTATED_BY_AUDITOR",
  "M4D_PROCESS_START_FAILED",
  "M4D_PROCESS_IDENTITY_INVALID",
  "M4D_SERVER_START_FAILED",
  "M4D_SESSION_BINDING_INVALID",
  "M4D_SESSION_REUSE_FORBIDDEN",
  "M4D_PROMPT_ORDER_INVALID",
  "M4D_MODEL_MISMATCH",
  "M4D_PROVIDER_RESULT_INVALID",
  "M4D_PROVIDER_ENVELOPE_INVALID",
  "M4D_PROVIDER_OUTPUT_LIMIT",
  "M4D_PROVIDER_CREDENTIAL_MATERIAL",
  "M4D_PROCESS_TREE_NOT_QUIESCENT",
  "M4D_REDISPATCH_FORBIDDEN",
  "M4D_PHYSICAL_STATE_UNKNOWN",
] as const;
export type M4DErrorCode = typeof M4D_ERROR_CODES[number];

/**
 * A typed M4-D failure is never an audit verdict. It escapes through the frozen
 * E boundary, which converts an Auditor that did not return a valid envelope
 * into E_AUDITOR_RESULT_INVALID: no AuditResult, no reconciliation, and no
 * ACCEPT/REJECT authority consumed.
 */
export class RalphM4DError extends Error {
  readonly name = "RalphM4DError";

  constructor(readonly m4dCode: M4DErrorCode, message: string = m4dCode, readonly cause?: unknown) {
    super(message);
  }
}

export function m4d(code: M4DErrorCode, message?: string, cause?: unknown): RalphM4DError {
  return new RalphM4DError(code, message ?? code, cause);
}

/** Role-scoped preimage; an Executor never produces these identities. */
export function auditorProfileDigestV2(input: {
  readonly conformanceRecordDigest: string;
  readonly permissionsDigest: string;
  readonly timeoutPolicyDigest: string;
}): string {
  return sha256Canonical({
    role: OPENCODE_CLI_AUDITOR_ROLE_V2,
    transport: OPENCODE_CLI_AUDITOR_TRANSPORT_V2,
    transportVersion: OPENCODE_CLI_AUDITOR_TRANSPORT_VERSION_V2,
    profileId: OPENCODE_CLI_AUDITOR_PROFILE_V2,
    coreProfileId: OPENCODE_CLI_AUDITOR_CORE_PROFILE_ID_V2,
    modelSelector: OPENCODE_CLI_AUDITOR_MODEL_V2,
    conformanceRecordDigest: input.conformanceRecordDigest,
    permissionsDigest: input.permissionsDigest,
    timeoutPolicyDigest: input.timeoutPolicyDigest,
  });
}

/** Auditor runtime identity. The `opencode-cli-auditor-runtime-` prefix and the
 * role-scoped preimage make it structurally impossible to equal the frozen
 * `opencode-cli-runtime-` Executor identity for the same executable/model. */
export function auditorRuntimeIdentityV2(input: {
  readonly openCodeExecutableIdentity: string;
  readonly profileDigest: string;
}): string {
  return `opencode-cli-auditor-runtime-${sha256Canonical({
    role: OPENCODE_CLI_AUDITOR_ROLE_V2,
    openCodeExecutableIdentity: input.openCodeExecutableIdentity,
    auditorProfileIdentity: OPENCODE_CLI_AUDITOR_PROFILE_V2,
    auditorProfileDigest: input.profileDigest,
    modelSelector: OPENCODE_CLI_AUDITOR_MODEL_V2,
  }).slice("sha256:".length)}`;
}
