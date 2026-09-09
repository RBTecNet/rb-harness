/** Ralph Operational Core V2 — Milestone 4-D, real OpenCode CLI Auditor. */
export {
  M4D_ERROR_CODES,
  OPENCODE_CLI_AUDITOR_CORE_PROFILE_ID_V2,
  OPENCODE_CLI_AUDITOR_MODEL_ID_V2,
  OPENCODE_CLI_AUDITOR_MODEL_V2,
  OPENCODE_CLI_AUDITOR_PROFILE_V2,
  OPENCODE_CLI_AUDITOR_PROVIDER_V2,
  OPENCODE_CLI_AUDITOR_ROLE_V2,
  OPENCODE_CLI_AUDITOR_TRANSPORT_V2,
  OPENCODE_CLI_AUDITOR_TRANSPORT_VERSION_V2,
  RalphM4DError,
  auditorProfileDigestV2,
  auditorRuntimeIdentityV2,
} from "./contract.js";
export type { M4DErrorCode } from "./contract.js";
export {
  OPENCODE_AUDIT_DENIED_PROMPT_TOOLS_V2,
  OPENCODE_AUDIT_DENIED_TOOLS_V2,
  OPENCODE_AUDIT_PROTECTED_ROOTS_V2,
  OPENCODE_AUDIT_READ_TOOLS_V2,
  OPENCODE_AUDIT_UNREADABLE_ROOTS_V2,
  assertReadOnlyAuditPermissionsV2,
  openCodeAuditReadOnlyChildEnvironmentV2,
  openCodeAuditReadOnlyPermissionPolicyV2,
} from "./permissions.js";
export type { OpenCodeAuditPermissionPolicyV2 } from "./permissions.js";
export * from "./audit-envelope.js";
export * from "./audit-prompt.js";
export * from "./audit-provider-artifacts.js";
export {
  OpenCodeCliAuditorV2,
  assertGenuineOpenCodeCliAuditorV2,
  createAuditTimeoutPolicyV2,
  createOpenCodeCliAuditorV2,
  isGenuineOpenCodeCliAuditorV2,
} from "./cli-auditor-runtime.js";
export type { CreateOpenCodeCliAuditorV2Input } from "./cli-auditor-runtime.js";
