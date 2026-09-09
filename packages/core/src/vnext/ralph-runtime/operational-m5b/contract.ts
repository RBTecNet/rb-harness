import { sha256Canonical } from "../hashing.js";
import { RalphM5BError } from "./contract-errors.js";
import {
  CODEX_MANAGED_RUNTIME_V2,
  codexManagedRuntimeExecutablePathV2,
  codexManagedRuntimeExpectedIdentityDigestV2,
} from "./codex-managed-runtime.js";

export { M5B_ERROR_CODES, RalphM5BError, type M5BErrorCode } from "./contract-errors.js";

/**
 * Ralph M5-B — stock `@openai/codex` CLI Executor contract.
 *
 * This profile is deliberately distinct from the harness-owned rb-codex
 * app-server stack and from the OpenCode CLI Executor.  Nothing here may be
 * satisfied by an OpenCode conformance record: the transport, the process
 * model and the observable surfaces are different.
 */
export const CODEX_CLI_EXECUTOR_PROFILE_V2 = "openai:codex-cli:gpt-5.6-sol" as const;
export const CODEX_CLI_EXECUTOR_PROVIDER_V2 = "openai" as const;
export const CODEX_CLI_EXECUTOR_TRANSPORT_V2 = "codex-cli-exec" as const;
export const CODEX_CLI_EXECUTOR_REQUESTED_MODEL_V2 = "gpt-5.6-sol" as const;
export const CODEX_CLI_EXECUTOR_REASONING_EFFORT_V2 = "xhigh" as const;
export const CODEX_CLI_EXECUTOR_CLI_VERSION_V2 = "0.153.4" as const;

/**
 * The exact stock native binary M5-B executes.
 *
 * This is the HARNESS-MANAGED runtime, not whatever `codex` currently
 * resolves to.  The path is derived from the managed-runtime authority, so a
 * global `npm i -g @openai/codex` upgrade — which rewrites the nvm global
 * package path in place — cannot reach a frozen M5-B Executor at all.
 *
 * Portability of the install ROOT (`~/.local/libexec/rb-harness`) across
 * users remains an explicit M5-B deferral; the identity check is not
 * deferred and never was.
 */
export const CODEX_CLI_NATIVE_EXECUTABLE_PATH_V2: string = codexManagedRuntimeExecutablePathV2();
export const CODEX_CLI_NATIVE_EXECUTABLE_SIZE_BYTES_V2 = 258_659_424 as const;
export const CODEX_CLI_NATIVE_EXECUTABLE_SHA256_V2 =
  "sha256:56ef98ab4032d317ab26e9b5e5a175650717351edb16ed9cde0cb6d1734d62da" as const;

/** Managed runtime coordinates M5-B is frozen against. */
export const CODEX_MANAGED_RUNTIME_UPSTREAM_VERSION_V2 = "0.153.4" as const;
export const CODEX_MANAGED_RUNTIME_RB_REVISION_V2 = "rb.1" as const;
export const CODEX_MANAGED_RUNTIME_VERSION_V2 = "0.153.4-rb.1" as const;

/**
 * Physical state of the credential-file boundary: whether a command running
 * inside the sandbox Codex grants model-spawned tools can OPEN the
 * authenticated `<CODEX_HOME>/auth.json`.
 */
export const CODEX_CREDENTIAL_BOUNDARY_STATES_V2 = ["DENIED", "PROVIDER_READABLE", "UNKNOWN"] as const;
export type CodexCredentialBoundaryStateV2 = typeof CODEX_CREDENTIAL_BOUNDARY_STATES_V2[number];

/** Stock ephemeral `codex exec` exposes no effective-model surface at all. */
export const CODEX_OBSERVED_MODEL_STATES_V2 = ["UNAVAILABLE", "REPORTED"] as const;
export type CodexObservedModelStateV2 = typeof CODEX_OBSERVED_MODEL_STATES_V2[number];

export const M5B_TIMEOUT_POLICY_SCHEMA_V2 = "rb-ralph-codex-timeout/v1" as const;

export interface M5BTimeoutPolicyV2 {
  readonly schema: typeof M5B_TIMEOUT_POLICY_SCHEMA_V2;
  /** Core-owned wall-clock deadline for the one physical provider dispatch. */
  readonly deadlineMs: number;
  readonly policyDigest: string;
}

/** Bounds that keep every M5-B physical surface finite and inspectable. */
export const M5B_LIMITS_V2 = Object.freeze({
  projectionMaxFiles: 2_000,
  projectionMaxFileBytes: 2 * 1024 * 1024,
  projectionMaxTotalBytes: 32 * 1024 * 1024,
  deltaMaxEntries: 64,
  deltaMaxFileBytes: 256 * 1024,
  deltaMaxTotalBytes: 1024 * 1024,
  eventStreamMaxBytes: 4 * 1024 * 1024,
  eventStreamMaxEvents: 20_000,
  eventLineMaxBytes: 512 * 1024,
  stderrMaxBytes: 256 * 1024,
  providerOutputMaxBytes: 64 * 1024,
  providerSummaryMaxChars: 4_000,
  promptMaxBytes: 64 * 1024,
});

export function createM5BTimeoutPolicyV2(deadlineMs: number): M5BTimeoutPolicyV2 {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1) throw new RalphM5BError("M5B_TIMEOUT_POLICY_INVALID");
  const base = { schema: M5B_TIMEOUT_POLICY_SCHEMA_V2, deadlineMs };
  return Object.freeze({ ...base, policyDigest: sha256Canonical(base) });
}

export function validateM5BTimeoutPolicyV2(value: unknown): asserts value is M5BTimeoutPolicyV2 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RalphM5BError("M5B_TIMEOUT_POLICY_INVALID");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["schema", "deadlineMs", "policyDigest"].includes(key))) throw new RalphM5BError("M5B_TIMEOUT_POLICY_INVALID");
  if (record.schema !== M5B_TIMEOUT_POLICY_SCHEMA_V2 || !Number.isSafeInteger(record.deadlineMs) || Number(record.deadlineMs) < 1) throw new RalphM5BError("M5B_TIMEOUT_POLICY_INVALID");
  if (record.policyDigest !== sha256Canonical({ schema: record.schema, deadlineMs: record.deadlineMs })) throw new RalphM5BError("M5B_TIMEOUT_POLICY_INVALID");
}

export function codexExecutorProfileDigestV2(): string {
  return sha256Canonical({
    profileId: CODEX_CLI_EXECUTOR_PROFILE_V2,
    provider: CODEX_CLI_EXECUTOR_PROVIDER_V2,
    transport: CODEX_CLI_EXECUTOR_TRANSPORT_V2,
    requestedModel: CODEX_CLI_EXECUTOR_REQUESTED_MODEL_V2,
    reasoningEffort: CODEX_CLI_EXECUTOR_REASONING_EFFORT_V2,
    cliVersion: CODEX_CLI_EXECUTOR_CLI_VERSION_V2,
    executableSha256: CODEX_CLI_NATIVE_EXECUTABLE_SHA256_V2,
    // The profile is frozen against the MANAGED runtime identity, so a
    // different runtime can never satisfy an existing executor profile.
    managedRuntimeKind: CODEX_MANAGED_RUNTIME_V2.kind,
    managedRuntimeVersion: CODEX_MANAGED_RUNTIME_VERSION_V2,
    managedRuntimeIdentityDigest: codexManagedRuntimeExpectedIdentityDigestV2(),
  });
}
