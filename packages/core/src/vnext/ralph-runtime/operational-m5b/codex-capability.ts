import { sha256Canonical } from "../hashing.js";
import {
  CODEX_CLI_EXECUTOR_CLI_VERSION_V2,
  CODEX_CLI_EXECUTOR_PROFILE_V2,
  CODEX_CLI_EXECUTOR_PROVIDER_V2,
  CODEX_CLI_EXECUTOR_REASONING_EFFORT_V2,
  CODEX_CLI_EXECUTOR_REQUESTED_MODEL_V2,
  CODEX_CLI_EXECUTOR_TRANSPORT_V2,
  CODEX_CLI_NATIVE_EXECUTABLE_PATH_V2,
  CODEX_CLI_NATIVE_EXECUTABLE_SHA256_V2,
  CODEX_CLI_NATIVE_EXECUTABLE_SIZE_BYTES_V2,
  CODEX_CREDENTIAL_BOUNDARY_STATES_V2,
  CODEX_MANAGED_RUNTIME_RB_REVISION_V2,
  CODEX_MANAGED_RUNTIME_UPSTREAM_VERSION_V2,
  CODEX_MANAGED_RUNTIME_VERSION_V2,
  type CodexCredentialBoundaryStateV2,
} from "./contract.js";
import { RalphM5BError } from "./contract-errors.js";
import {
  MANAGED_STOCK_CODEX_RUNTIME_KIND,
  codexManagedRuntimeExpectedIdentityDigestV2,
  type CodexManagedRuntimeIdentityV2,
} from "./codex-managed-runtime.js";
import { CODEX_PROJECTION_EXCLUDED_ROOTS_V2 } from "./codex-projection.js";
import {
  CODEX_PERMISSION_PROFILE_NAME_V2,
  CODEX_PERMISSION_PROFILE_SCHEMA_V2,
  CODEX_REQUIRED_PERMISSION_POLICY_SHAPE_V2,
  CODEX_REQUIRED_ROOT_PERMISSION_POLICY_SHAPE_V2,
  codexPermissionPolicyShapeDigestV2,
  codexPermissionProfileGrantsRootWriteV2,
  type CodexPermissionProfileV2,
} from "./codex-permission-profile.js";
import {
  CODEX_PARENT_PATH_V2,
  CODEX_SYSTEM_SANDBOX_BACKEND_PATH_V2,
  type CodexSandboxBackendFactsV2,
} from "./codex-sandbox-backend.js";
import {
  assertCodexPhysicalCapabilityV2,
  type CodexCapabilityProbeReportV2,
  type CodexCapabilityStateV2,
} from "./codex-credential-boundary.js";
import {
  CODEX_PARENT_ENVIRONMENT_KEYS_V2,
  codexShellEnvironmentPolicyV2,
} from "./codex-process.js";

/**
 * Stock Codex CLI runtime capability record.
 *
 * This is deliberately NOT an OpenCode conformance record and shares no
 * schema with one.  It states only what was physically observed of the stock
 * `codex exec` surface — including what is missing.  There is no tier, no
 * case list and no 17/17 claim, because none was ever measured here.
 *
 * The record is a DECLARATION of the physical boundary M5-B requires.  It is
 * never evidence on its own: a live, non-model capability probe and a live
 * sandbox-backend inspection must match it before any model-bearing dispatch.
 */
export const RALPH_CODEX_CLI_CAPABILITY_SCHEMA_V2 = "rb-ralph-codex-cli-capability/v1" as const;

export const CODEX_SURFACE_STATES_V2 = ["PUBLIC", "UNAVAILABLE"] as const;
export type CodexSurfaceStateV2 = typeof CODEX_SURFACE_STATES_V2[number];

export interface CodexCliCapabilityRecordV2 {
  readonly schema: typeof RALPH_CODEX_CLI_CAPABILITY_SCHEMA_V2;
  readonly profileId: string;
  readonly provider: string;
  readonly transport: string;
  readonly cliVersion: string;
  /**
   * The runtime is Harness-MANAGED: installed, pinned and verified under
   * `~/.local/libexec/rb-harness`.  A global `npm i -g @openai/codex` cannot
   * reach it, and a drifted managed install fails before dispatch.
   */
  readonly managedRuntimeKind: typeof MANAGED_STOCK_CODEX_RUNTIME_KIND;
  readonly managedRuntimeVersion: string;
  readonly managedRuntimeUpstreamVersion: string;
  readonly managedRuntimeRbRevision: string;
  readonly managedRuntimeTransport: "codex-exec";
  readonly managedRuntimeIdentityDigest: string;
  readonly executablePath: string;
  readonly executableSizeBytes: number;
  readonly executableSha256: string;
  readonly requestedModel: string;
  readonly reasoningEffort: string;
  /** One Attempt is always one fresh `codex exec`; resume/fork are refused. */
  readonly threadModel: "FRESH_EXEC_PER_ATTEMPT";
  readonly threadIdSurface: CodexSurfaceStateV2;
  readonly turnIdSurface: CodexSurfaceStateV2;
  readonly observedModelSurface: CodexSurfaceStateV2;
  readonly workspaceAuthority: "HOST_FILESYSTEM";
  readonly commandStreamAuthority: "NONE";
  /**
   * M5-B binds a named permission profile and no legacy sandbox mode at all.
   * The legacy `workspace-write` mode is what granted full-disk read.
   */
  readonly legacySandboxMode: "NONE";
  readonly permissionProfileName: typeof CODEX_PERMISSION_PROFILE_NAME_V2;
  readonly permissionProfileSchema: typeof CODEX_PERMISSION_PROFILE_SCHEMA_V2;
  readonly permissionPolicyShapeDigest: string;
  /** The distinct shape a root-scope WorkUnit's profile must present. */
  readonly rootPermissionPolicyShapeDigest: string;
  /**
   * The control-plane roots that must exist as protected sentinels whenever
   * the staging root is writable.  Derived from the single workspace
   * authority, never restated by hand.
   */
  readonly controlPlaneSentinelRoots: readonly string[];
  readonly granularPermissionProfileReachable: boolean;
  readonly parentEnvironmentPolicyDigest: string;
  readonly shellEnvironmentPolicyDigest: string;
  readonly systemSandboxBackendPath: string;
  readonly credentialFileSandboxBoundary: CodexCredentialBoundaryStateV2;
  readonly stagingWriteCapability: CodexCapabilityStateV2;
  readonly controlPlaneDenialCapability: CodexCapabilityStateV2;
  readonly networkDenialCapability: CodexCapabilityStateV2;
  readonly shellEnvironmentIsolationCapability: CodexCapabilityStateV2;
  readonly rootProductWriteCapability: CodexCapabilityStateV2;
  readonly rootSentinelDenialCapability: CodexCapabilityStateV2;
  readonly credentialFileBoundaryEvidence: string;
  readonly observedAt: string;
  readonly recordDigest: string;
}

const CAPABILITY_KEYS: readonly string[] = Object.freeze([
  "schema", "profileId", "provider", "transport", "cliVersion", "managedRuntimeKind", "managedRuntimeVersion",
  "managedRuntimeUpstreamVersion", "managedRuntimeRbRevision", "managedRuntimeTransport", "managedRuntimeIdentityDigest",
  "executablePath", "executableSizeBytes", "executableSha256",
  "requestedModel", "reasoningEffort", "threadModel", "threadIdSurface", "turnIdSurface", "observedModelSurface",
  "workspaceAuthority", "commandStreamAuthority", "legacySandboxMode", "permissionProfileName", "permissionProfileSchema",
  "permissionPolicyShapeDigest", "rootPermissionPolicyShapeDigest", "controlPlaneSentinelRoots",
  "granularPermissionProfileReachable", "parentEnvironmentPolicyDigest",
  "shellEnvironmentPolicyDigest", "systemSandboxBackendPath", "credentialFileSandboxBoundary", "stagingWriteCapability",
  "controlPlaneDenialCapability", "networkDenialCapability", "shellEnvironmentIsolationCapability",
  "rootProductWriteCapability", "rootSentinelDenialCapability",
  "credentialFileBoundaryEvidence", "observedAt", "recordDigest",
]);

/** Digest of the closed parent-environment policy (names and pinned PATH). */
export function codexParentEnvironmentPolicyDigestV2(): string {
  return sha256Canonical({ keys: [...CODEX_PARENT_ENVIRONMENT_KEYS_V2], path: CODEX_PARENT_PATH_V2 });
}

/** Digest of the closed model-command environment policy. */
export function codexShellEnvironmentPolicyDigestV2(): string {
  return sha256Canonical({ inherit: "none", set: codexShellEnvironmentPolicyV2() });
}

function seal(base: Omit<CodexCliCapabilityRecordV2, "recordDigest">): CodexCliCapabilityRecordV2 {
  return Object.freeze({ ...base, recordDigest: sha256Canonical(base) });
}

/**
 * The record as physically established on 2026-09-09 against stock
 * codex-cli 0.153.4.
 *
 * One fact remains deliberately negative and must not be softened: stock
 * ephemeral `codex exec` publishes no effective-model surface at all.  The
 * credential-file boundary is now DENIED — not by prose, but because M5-B
 * selects a named `default_permissions` profile whose staging root is
 * read-only and whose CODEX_HOME entry is an explicit deny.
 */
export const CODEX_CLI_CAPABILITY_RECORD_V2: CodexCliCapabilityRecordV2 = seal({
  schema: RALPH_CODEX_CLI_CAPABILITY_SCHEMA_V2,
  profileId: CODEX_CLI_EXECUTOR_PROFILE_V2,
  provider: CODEX_CLI_EXECUTOR_PROVIDER_V2,
  transport: CODEX_CLI_EXECUTOR_TRANSPORT_V2,
  cliVersion: CODEX_CLI_EXECUTOR_CLI_VERSION_V2,
  managedRuntimeKind: MANAGED_STOCK_CODEX_RUNTIME_KIND,
  managedRuntimeVersion: CODEX_MANAGED_RUNTIME_VERSION_V2,
  managedRuntimeUpstreamVersion: CODEX_MANAGED_RUNTIME_UPSTREAM_VERSION_V2,
  managedRuntimeRbRevision: CODEX_MANAGED_RUNTIME_RB_REVISION_V2,
  managedRuntimeTransport: "codex-exec",
  managedRuntimeIdentityDigest: codexManagedRuntimeExpectedIdentityDigestV2(),
  executablePath: CODEX_CLI_NATIVE_EXECUTABLE_PATH_V2,
  executableSizeBytes: CODEX_CLI_NATIVE_EXECUTABLE_SIZE_BYTES_V2,
  executableSha256: CODEX_CLI_NATIVE_EXECUTABLE_SHA256_V2,
  requestedModel: CODEX_CLI_EXECUTOR_REQUESTED_MODEL_V2,
  reasoningEffort: CODEX_CLI_EXECUTOR_REASONING_EFFORT_V2,
  threadModel: "FRESH_EXEC_PER_ATTEMPT",
  threadIdSurface: "PUBLIC",
  turnIdSurface: "UNAVAILABLE",
  observedModelSurface: "UNAVAILABLE",
  workspaceAuthority: "HOST_FILESYSTEM",
  commandStreamAuthority: "NONE",
  legacySandboxMode: "NONE",
  permissionProfileName: CODEX_PERMISSION_PROFILE_NAME_V2,
  permissionProfileSchema: CODEX_PERMISSION_PROFILE_SCHEMA_V2,
  permissionPolicyShapeDigest: CODEX_REQUIRED_PERMISSION_POLICY_SHAPE_V2,
  rootPermissionPolicyShapeDigest: CODEX_REQUIRED_ROOT_PERMISSION_POLICY_SHAPE_V2,
  controlPlaneSentinelRoots: [...CODEX_PROJECTION_EXCLUDED_ROOTS_V2].sort(),
  granularPermissionProfileReachable: true,
  parentEnvironmentPolicyDigest: codexParentEnvironmentPolicyDigestV2(),
  shellEnvironmentPolicyDigest: codexShellEnvironmentPolicyDigestV2(),
  systemSandboxBackendPath: CODEX_SYSTEM_SANDBOX_BACKEND_PATH_V2,
  credentialFileSandboxBoundary: "DENIED",
  stagingWriteCapability: "PROVEN",
  controlPlaneDenialCapability: "PROVEN",
  networkDenialCapability: "PROVEN",
  shellEnvironmentIsolationCapability: "PROVEN",
  rootProductWriteCapability: "PROVEN",
  rootSentinelDenialCapability: "PROVEN",
  credentialFileBoundaryEvidence: "codex sandbox under the exact dispatch profile, no model: non-root staging product write ALLOW and staging-root write DENY; root-scope staging-root write ALLOW with every control-plane sentinel create/nest/delete/rename/replace/symlink/rename-onto/copy DENIED and each sentinel intact; <CODEX_HOME>/auth.json OPEN DENIED; network DENIED; open/close only, no bytes read",
  observedAt: "2026-09-09T00:00:00.000Z",
});

export function validateCodexCliCapabilityRecordV2(value: unknown): asserts value is CodexCliCapabilityRecordV2 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new RalphM5BError("M5B_CAPABILITY_RECORD_INVALID");
  const record = value as Record<string, unknown>;
  const allowed = new Set(CAPABILITY_KEYS);
  if (Object.keys(record).some((key) => !allowed.has(key)) || CAPABILITY_KEYS.some((key) => !(key in record))) throw new RalphM5BError("M5B_CAPABILITY_RECORD_INVALID", "M5B_CAPABILITY_RECORD_INVALID: fields");
  if (record.schema !== RALPH_CODEX_CLI_CAPABILITY_SCHEMA_V2) throw new RalphM5BError("M5B_CAPABILITY_RECORD_INVALID", "M5B_CAPABILITY_RECORD_INVALID: schema");
  if (record.profileId !== CODEX_CLI_EXECUTOR_PROFILE_V2 || record.provider !== CODEX_CLI_EXECUTOR_PROVIDER_V2
    || record.transport !== CODEX_CLI_EXECUTOR_TRANSPORT_V2 || record.cliVersion !== CODEX_CLI_EXECUTOR_CLI_VERSION_V2
    || record.requestedModel !== CODEX_CLI_EXECUTOR_REQUESTED_MODEL_V2 || record.reasoningEffort !== CODEX_CLI_EXECUTOR_REASONING_EFFORT_V2
    || record.executablePath !== CODEX_CLI_NATIVE_EXECUTABLE_PATH_V2 || record.executableSha256 !== CODEX_CLI_NATIVE_EXECUTABLE_SHA256_V2
    || record.executableSizeBytes !== CODEX_CLI_NATIVE_EXECUTABLE_SIZE_BYTES_V2) {
    throw new RalphM5BError("M5B_CAPABILITY_RECORD_INVALID", "M5B_CAPABILITY_RECORD_INVALID: identity");
  }
  if (record.threadModel !== "FRESH_EXEC_PER_ATTEMPT" || record.workspaceAuthority !== "HOST_FILESYSTEM" || record.commandStreamAuthority !== "NONE") {
    throw new RalphM5BError("M5B_CAPABILITY_RECORD_INVALID", "M5B_CAPABILITY_RECORD_INVALID: authority");
  }
  // The legacy sandbox is the exact hole M5-B.1 was opened to close; a record
  // that reintroduces it is refused outright.
  if (record.legacySandboxMode !== "NONE") throw new RalphM5BError("M5B_CAPABILITY_RECORD_INVALID", "M5B_CAPABILITY_RECORD_INVALID: legacy sandbox mode");
  if (record.permissionProfileName !== CODEX_PERMISSION_PROFILE_NAME_V2 || record.permissionProfileSchema !== CODEX_PERMISSION_PROFILE_SCHEMA_V2) {
    throw new RalphM5BError("M5B_CAPABILITY_RECORD_INVALID", "M5B_CAPABILITY_RECORD_INVALID: permission profile binding");
  }
  if (record.permissionPolicyShapeDigest !== CODEX_REQUIRED_PERMISSION_POLICY_SHAPE_V2
    || record.rootPermissionPolicyShapeDigest !== CODEX_REQUIRED_ROOT_PERMISSION_POLICY_SHAPE_V2) {
    throw new RalphM5BError("M5B_CAPABILITY_RECORD_INVALID", "M5B_CAPABILITY_RECORD_INVALID: permission policy shape");
  }
  // The sentinel set is the workspace authority's own excluded-root set. A
  // record that drops one would declare a control-plane name unguarded.
  const requiredSentinels = [...CODEX_PROJECTION_EXCLUDED_ROOTS_V2].sort();
  const declaredSentinels = Array.isArray(record.controlPlaneSentinelRoots) ? [...record.controlPlaneSentinelRoots as readonly string[]].sort() : [];
  if (declaredSentinels.length !== requiredSentinels.length || declaredSentinels.some((root, index) => root !== requiredSentinels[index])) {
    throw new RalphM5BError("M5B_CAPABILITY_RECORD_INVALID", `M5B_CAPABILITY_RECORD_INVALID: control-plane sentinel roots must be exactly ${requiredSentinels.join(",")}`);
  }
  // The runtime identity is the whole point of the managed pin: a record that
  // names any other runtime cannot authorize a dispatch.
  if (record.managedRuntimeKind !== MANAGED_STOCK_CODEX_RUNTIME_KIND
    || record.managedRuntimeTransport !== "codex-exec"
    || record.managedRuntimeVersion !== CODEX_MANAGED_RUNTIME_VERSION_V2
    || record.managedRuntimeUpstreamVersion !== CODEX_MANAGED_RUNTIME_UPSTREAM_VERSION_V2
    || record.managedRuntimeRbRevision !== CODEX_MANAGED_RUNTIME_RB_REVISION_V2
    || record.managedRuntimeIdentityDigest !== codexManagedRuntimeExpectedIdentityDigestV2()) {
    throw new RalphM5BError("M5B_CAPABILITY_RECORD_INVALID", "M5B_CAPABILITY_RECORD_INVALID: managed runtime identity");
  }
  if (record.parentEnvironmentPolicyDigest !== codexParentEnvironmentPolicyDigestV2()
    || record.shellEnvironmentPolicyDigest !== codexShellEnvironmentPolicyDigestV2()
    || record.systemSandboxBackendPath !== CODEX_SYSTEM_SANDBOX_BACKEND_PATH_V2) {
    throw new RalphM5BError("M5B_CAPABILITY_RECORD_INVALID", "M5B_CAPABILITY_RECORD_INVALID: environment or sandbox backend policy");
  }
  if (!(CODEX_CREDENTIAL_BOUNDARY_STATES_V2 as readonly string[]).includes(record.credentialFileSandboxBoundary as string)) {
    throw new RalphM5BError("M5B_CAPABILITY_RECORD_INVALID", "M5B_CAPABILITY_RECORD_INVALID: credential boundary");
  }
  const { recordDigest: _ignored, ...base } = record;
  if (sha256Canonical(base) !== record.recordDigest) throw new RalphM5BError("M5B_CAPABILITY_RECORD_INVALID", "M5B_CAPABILITY_RECORD_INVALID: digest mismatch");
}

/**
 * The M5-B real-inference gate.  A model-bearing `codex exec` may not be
 * dispatched while the provider's own tool sandbox can open the credential
 * file, nor while any of the physical capabilities the boundary depends on is
 * merely declared rather than proven.  This is enforced in shipped code, not
 * by prompt text.
 */
export function assertCodexRealInferenceGateV2(record: CodexCliCapabilityRecordV2 = CODEX_CLI_CAPABILITY_RECORD_V2): void {
  validateCodexCliCapabilityRecordV2(record);
  if (record.credentialFileSandboxBoundary !== "DENIED") {
    throw new RalphM5BError(
      "M5B_CREDENTIAL_FILE_BOUNDARY_UNSAFE",
      `M5B_CREDENTIAL_FILE_BOUNDARY_UNSAFE: the provider tool sandbox boundary is ${record.credentialFileSandboxBoundary}; no model-bearing dispatch is authorized`,
    );
  }
  for (const [label, state] of [
    ["staging write", record.stagingWriteCapability],
    ["control-plane denial", record.controlPlaneDenialCapability],
    ["network denial", record.networkDenialCapability],
    ["shell environment isolation", record.shellEnvironmentIsolationCapability],
    ["root product write", record.rootProductWriteCapability],
    ["root sentinel denial", record.rootSentinelDenialCapability],
  ] as const) {
    if (state !== "PROVEN") throw new RalphM5BError("M5B_CREDENTIAL_FILE_BOUNDARY_UNSAFE", `M5B_CREDENTIAL_FILE_BOUNDARY_UNSAFE: ${label} is ${state}`);
  }
  if (record.granularPermissionProfileReachable !== true) {
    throw new RalphM5BError("M5B_CAPABILITY_RECORD_INVALID", "M5B_CAPABILITY_RECORD_INVALID: the permission profile must be reachable");
  }
}

/**
 * Bind the DECLARED record to LIVE physical observations.  The record alone
 * never authorizes a dispatch: the probe must have observed the same
 * boundary, under the same policy shape, with the system sandbox backend.
 */
export function assertCodexRuntimeCapabilityV2(input: {
  readonly record: CodexCliCapabilityRecordV2;
  readonly probe: CodexCapabilityProbeReportV2;
  readonly backend: CodexSandboxBackendFactsV2;
  readonly permissionProfile: CodexPermissionProfileV2;
  /** The physically verified managed runtime this Attempt will execute. */
  readonly managedRuntime: CodexManagedRuntimeIdentityV2;
}): void {
  assertCodexRealInferenceGateV2(input.record);
  assertCodexPhysicalCapabilityV2(input.probe, input.permissionProfile);
  if (input.backend.backendPath !== input.record.systemSandboxBackendPath || input.backend.bundledFallbackSelected !== false) {
    throw new RalphM5BError("M5B_SANDBOX_BACKEND_INVALID", "M5B_SANDBOX_BACKEND_INVALID: the observed sandbox backend does not match the capability record");
  }
  // The runtime that will actually be executed, not the one a record hopes
  // for: a global Codex upgrade changes this digest and stops the dispatch.
  if (input.managedRuntime.identityDigest !== input.record.managedRuntimeIdentityDigest
    || input.managedRuntime.executablePath !== input.record.executablePath
    || input.managedRuntime.executableSha256 !== input.record.executableSha256.replace(/^sha256:/, "")
    || input.managedRuntime.executableSizeBytes !== input.record.executableSizeBytes
    || input.managedRuntime.version !== input.record.managedRuntimeVersion) {
    throw new RalphM5BError("M5B_MANAGED_RUNTIME_INVALID", "M5B_MANAGED_RUNTIME_INVALID: the verified managed runtime does not match the capability record");
  }
  const shape = codexPermissionPolicyShapeDigestV2(input.permissionProfile);
  const rootScope = codexPermissionProfileGrantsRootWriteV2(input.permissionProfile);
  const required = rootScope ? input.record.rootPermissionPolicyShapeDigest : input.record.permissionPolicyShapeDigest;
  if (shape !== required) {
    throw new RalphM5BError("M5B_PERMISSION_PROFILE_INVALID", "M5B_PERMISSION_PROFILE_INVALID: the dispatched policy shape does not match the capability record");
  }
  const probedShape = rootScope ? input.probe.rootPermissionPolicyShapeDigest : input.probe.permissionPolicyShapeDigest;
  if (shape !== probedShape) {
    throw new RalphM5BError("M5B_PERMISSION_PROFILE_INVALID", "M5B_PERMISSION_PROFILE_INVALID: the probe did not exercise the dispatched policy shape");
  }
  if (input.probe.credentialFileBoundary !== input.record.credentialFileSandboxBoundary) {
    throw new RalphM5BError("M5B_CREDENTIAL_FILE_BOUNDARY_UNSAFE", `M5B_CREDENTIAL_FILE_BOUNDARY_UNSAFE: observed ${input.probe.credentialFileBoundary}, declared ${input.record.credentialFileSandboxBoundary}`);
  }
}

/** The digest a provider descriptor binds so a policy change invalidates it. */
export function codexCapabilityBindingDigestV2(input: {
  readonly record: CodexCliCapabilityRecordV2;
  readonly probe: CodexCapabilityProbeReportV2;
  readonly backend: CodexSandboxBackendFactsV2;
  readonly permissionProfile: CodexPermissionProfileV2;
  readonly managedRuntime: CodexManagedRuntimeIdentityV2;
  /** The sealed sentinel authority of this Attempt's projection. */
  readonly sentinelDigest: string;
}): string {
  return sha256Canonical({
    capabilityRecordDigest: input.record.recordDigest,
    capabilityProbeDigest: input.probe.reportDigest,
    sandboxBackendDigest: input.backend.factsDigest,
    managedRuntimeIdentityDigest: input.managedRuntime.identityDigest,
    permissionProfileDigest: input.permissionProfile.profileDigest,
    permissionPolicyShapeDigest: codexPermissionPolicyShapeDigestV2(input.permissionProfile),
    stagingRootWritable: codexPermissionProfileGrantsRootWriteV2(input.permissionProfile),
    sentinelDigest: input.sentinelDigest,
  });
}
