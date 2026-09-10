import { sha256Canonical } from "../hashing.js";
import { auditPackageIdV2, type AuditPackageV2 } from "../operational-d/artifacts.js";
import {
  CODEX_CLI_EXECUTOR_CLI_VERSION_V2,
  CODEX_CLI_EXECUTOR_REASONING_EFFORT_V2,
  CODEX_CLI_EXECUTOR_REQUESTED_MODEL_V2,
  CODEX_CLI_NATIVE_EXECUTABLE_PATH_V2,
  CODEX_CLI_NATIVE_EXECUTABLE_SHA256_V2,
  CODEX_CLI_NATIVE_EXECUTABLE_SIZE_BYTES_V2,
} from "../operational-m5b/contract.js";
import type { CodexManagedRuntimeIdentityV2 } from "../operational-m5b/codex-managed-runtime.js";

export const CODEX_CLI_AUDITOR_ROLE_V2 = "AUDITOR" as const;
export const CODEX_CLI_AUDITOR_PROFILE_ID_V2 = "openai-codex-cli-auditor:gpt-5.6-sol" as const;
export const CODEX_CLI_AUDITOR_PROFILE_IDENTITY_V2 = "openai:codex-cli:auditor:gpt-5.6-sol" as const;
export const CODEX_CLI_AUDITOR_PROVIDER_V2 = "openai" as const;
export const CODEX_CLI_AUDITOR_TRANSPORT_V2 = "codex-cli-exec" as const;
export const CODEX_CLI_AUDITOR_REQUESTED_MODEL_V2 = CODEX_CLI_EXECUTOR_REQUESTED_MODEL_V2;
export const CODEX_CLI_AUDITOR_REASONING_EFFORT_V2 = CODEX_CLI_EXECUTOR_REASONING_EFFORT_V2;
export const CODEX_CLI_AUDITOR_CLI_VERSION_V2 = CODEX_CLI_EXECUTOR_CLI_VERSION_V2;
export const CODEX_CLI_AUDITOR_EXECUTABLE_PATH_V2 = CODEX_CLI_NATIVE_EXECUTABLE_PATH_V2;
export const CODEX_CLI_AUDITOR_EXECUTABLE_SIZE_BYTES_V2 = CODEX_CLI_NATIVE_EXECUTABLE_SIZE_BYTES_V2;
export const CODEX_CLI_AUDITOR_EXECUTABLE_SHA256_V2 = CODEX_CLI_NATIVE_EXECUTABLE_SHA256_V2;

export const M5D_ERROR_CODES = [
  "M5D_AUDITOR_AUTHORITY_REQUIRED",
  "M5D_AUDIT_PACKAGE_INVALID",
  "M5D_AUDIT_PACKAGE_BINDING_INVALID",
  "M5D_AUDIT_INVOCATION_REQUIRED",
  "M5D_AUDIT_ALREADY_RECONCILED",
  "M5D_MANAGED_RUNTIME_INVALID",
  "M5D_PERMISSION_PROFILE_INVALID",
  "M5D_CAPABILITY_UNPROVEN",
  "M5D_CREDENTIAL_BOUNDARY_UNSAFE",
  "M5D_SANDBOX_BACKEND_INVALID",
  "M5D_ARGV_POLICY_INVALID",
  "M5D_PROMPT_INVALID",
  "M5D_PROVIDER_RESULT_INVALID",
  "M5D_PROVIDER_OUTPUT_LIMIT",
  "M5D_PROVIDER_CREDENTIAL_MATERIAL",
  "M5D_WORKSPACE_BINDING_INVALID",
  "M5D_WORKSPACE_MUTATED_BY_AUDITOR",
  "M5D_THREAD_BINDING_INVALID",
  "M5D_THREAD_REUSE_FORBIDDEN",
  "M5D_TERMINAL_REQUIRED",
  "M5D_PROCESS_TREE_NOT_QUIESCENT",
  "M5D_REDISPATCH_FORBIDDEN",
  "M5D_PHYSICAL_STATE_UNKNOWN",
  "M5D_ARTIFACT_INVALID",
] as const;
export type M5DErrorCode = typeof M5D_ERROR_CODES[number];

export class RalphM5DError extends Error {
  constructor(readonly code: M5DErrorCode, message: string = code, readonly cause?: unknown) {
    super(message);
    this.name = "RalphM5DError";
  }
}

export function m5d(code: M5DErrorCode, message: string = code, cause?: unknown): RalphM5DError {
  return new RalphM5DError(code, message, cause);
}

export interface CodexAuditorIdentityInputV2 {
  readonly managedRuntime: CodexManagedRuntimeIdentityV2;
  readonly permissionProfileDigest: string;
  readonly capabilityDigest: string;
  readonly auditPackage: AuditPackageV2;
  readonly timeoutPolicyDigest: string;
}

/**
 * Per-audit nominal identity.  The AuditPackage is deliberately in the
 * preimage: an Auditor constructed for one package cannot be rebound to a
 * later Attempt even though both roles use the same managed binary/model.
 */
export function codexAuditorRuntimeIdentityV2(input: CodexAuditorIdentityInputV2): string {
  const digest = sha256Canonical({
    role: CODEX_CLI_AUDITOR_ROLE_V2,
    profile: CODEX_CLI_AUDITOR_PROFILE_IDENTITY_V2,
    managedRuntimeKind: input.managedRuntime.kind,
    managedRuntimeVersion: input.managedRuntime.version,
    managedRuntimeIdentityDigest: input.managedRuntime.identityDigest,
    permissionProfileDigest: input.permissionProfileDigest,
    capabilityDigest: input.capabilityDigest,
    requestedModel: CODEX_CLI_AUDITOR_REQUESTED_MODEL_V2,
    auditPackageId: computedAuditPackageIdV2(input.auditPackage),
    auditPackageDigest: input.auditPackage.packageDigest,
    timeoutPolicyDigest: input.timeoutPolicyDigest,
  });
  return `codex-cli-auditor-${digest.slice("sha256:".length)}`;
}

export function computedAuditPackageIdV2(auditPackage: AuditPackageV2): string {
  const { schema: _schema, packageDigest: _digest, ...base } = auditPackage;
  return auditPackageIdV2(base);
}
