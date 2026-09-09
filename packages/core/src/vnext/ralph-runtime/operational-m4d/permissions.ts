import { sha256Canonical } from "../hashing.js";
import type {
  OpenCodeCliPromptToolsV2,
  OpenCodeCliSessionPermissionV2,
} from "../operational-b4/opencode-cli-session-inspector.js";
import { m4d } from "./contract.js";

/**
 * Read-oriented OpenCode 1.18.29 capabilities the Auditor genuinely needs to
 * inspect the workspace independently. The vocabularies below are exactly the
 * ones the frozen, conformance-proven M4-B transport already uses, so no
 * unsupported permission or tool name is ever sent to OpenCode 1.18.29.
 */
export const OPENCODE_AUDIT_READ_TOOLS_V2 = ["read", "glob", "grep", "list"] as const;

/**
 * Every OpenCode 1.18.29 *permission* that can mutate the workspace or reach
 * outside it. These names are used in the child configuration and in the
 * session permission rules.
 */
export const OPENCODE_AUDIT_DENIED_TOOLS_V2 = [
  "edit", "write", "patch", "bash", "task",
  "webfetch", "websearch", "codesearch", "external_directory",
] as const;

/**
 * Every OpenCode 1.18.29 *prompt tool* that can mutate the workspace or reach
 * outside it. The prompt namespace calls the patch tool `apply_patch`, which is
 * why it is a separate vocabulary from the permission namespace above.
 */
export const OPENCODE_AUDIT_DENIED_PROMPT_TOOLS_V2 = [
  "edit", "write", "apply_patch", "bash", "task", "webfetch", "websearch",
] as const;

/** Paths no Auditor may ever write, restated explicitly for auditability. */
export const OPENCODE_AUDIT_PROTECTED_ROOTS_V2 = [".rb", ".rb-harness", ".git"] as const;

/** Ralph control storage and VCS internals are not audit input. */
export const OPENCODE_AUDIT_UNREADABLE_ROOTS_V2 = [".rb-harness", ".git"] as const;

export interface OpenCodeAuditPermissionPolicyV2 {
  readonly role: "AUDITOR";
  readonly environmentPermission: Readonly<Record<string, string>>;
  readonly sessionPermission: OpenCodeCliSessionPermissionV2;
  readonly promptTools: OpenCodeCliPromptToolsV2;
  readonly policyDigest: string;
}

function environmentPermissionV2(): Readonly<Record<string, string>> {
  const value: Record<string, string> = {};
  for (const tool of OPENCODE_AUDIT_READ_TOOLS_V2) value[tool] = "allow";
  for (const tool of OPENCODE_AUDIT_DENIED_TOOLS_V2) value[tool] = "deny";
  return Object.freeze(value);
}

function sessionPermissionV2(): OpenCodeCliSessionPermissionV2 {
  const rules: Record<string, string>[] = [];
  for (const tool of OPENCODE_AUDIT_READ_TOOLS_V2) {
    rules.push({ permission: tool, pattern: "*", action: "allow" });
    for (const root of OPENCODE_AUDIT_UNREADABLE_ROOTS_V2) {
      rules.push({ permission: tool, pattern: root, action: "deny" });
      rules.push({ permission: tool, pattern: `${root}/**`, action: "deny" });
    }
  }
  // OpenCode applies the last matching rule. The blanket denial comes first so
  // no later rule can widen it, and the explicit control-plane denials follow
  // it so the protected roots stay denied under every evaluation order.
  for (const tool of OPENCODE_AUDIT_DENIED_TOOLS_V2) {
    rules.push({ permission: tool, pattern: "*", action: "deny" });
    for (const root of OPENCODE_AUDIT_PROTECTED_ROOTS_V2) {
      rules.push({ permission: tool, pattern: root, action: "deny" });
      rules.push({ permission: tool, pattern: `${root}/**`, action: "deny" });
    }
  }
  return Object.freeze(rules.map((rule) => Object.freeze(rule)));
}

function promptToolsV2(): OpenCodeCliPromptToolsV2 {
  const value: Record<string, boolean> = {};
  for (const tool of OPENCODE_AUDIT_READ_TOOLS_V2) value[tool] = true;
  for (const tool of OPENCODE_AUDIT_DENIED_PROMPT_TOOLS_V2) value[tool] = false;
  return Object.freeze(value);
}

/**
 * The single read-only Auditor permission authority. Its digest is folded into
 * the Auditor profile digest, so a widened policy changes the Auditor runtime
 * identity and therefore the Core auditInvocationId: a silently write-enabled
 * Auditor cannot bind to a durable Core audit descriptor.
 */
export function openCodeAuditReadOnlyPermissionPolicyV2(): OpenCodeAuditPermissionPolicyV2 {
  const base = {
    role: "AUDITOR" as const,
    environmentPermission: environmentPermissionV2(),
    sessionPermission: sessionPermissionV2(),
    promptTools: promptToolsV2(),
  };
  assertReadOnlyAuditPermissionsV2(base);
  return Object.freeze({ ...base, policyDigest: sha256Canonical(base) });
}

/**
 * Physical read-only proof. It is evaluated when the Auditor is created and
 * again immediately before the single model-bearing crossing, so a policy that
 * grants any mutating capability fails closed before a prompt exists.
 */
export function assertReadOnlyAuditPermissionsV2(policy: {
  readonly environmentPermission: Readonly<Record<string, string>>;
  readonly sessionPermission: OpenCodeCliSessionPermissionV2;
  readonly promptTools: OpenCodeCliPromptToolsV2;
}): void {
  for (const tool of OPENCODE_AUDIT_DENIED_TOOLS_V2) {
    if (policy.environmentPermission[tool] !== "deny") throw m4d("M4D_PERMISSIONS_NOT_READ_ONLY", `M4D_PERMISSIONS_NOT_READ_ONLY: environment ${tool}`);
  }
  for (const tool of OPENCODE_AUDIT_DENIED_PROMPT_TOOLS_V2) {
    if (policy.promptTools[tool] !== false) throw m4d("M4D_PERMISSIONS_NOT_READ_ONLY", `M4D_PERMISSIONS_NOT_READ_ONLY: tools ${tool}`);
  }
  for (const [tool, action] of Object.entries(policy.environmentPermission)) {
    if (action !== "allow" && action !== "deny") throw m4d("M4D_PERMISSIONS_NOT_READ_ONLY", `M4D_PERMISSIONS_NOT_READ_ONLY: environment action ${tool}`);
    if (action === "allow" && !(OPENCODE_AUDIT_READ_TOOLS_V2 as readonly string[]).includes(tool)) {
      throw m4d("M4D_PERMISSIONS_NOT_READ_ONLY", `M4D_PERMISSIONS_NOT_READ_ONLY: environment grants ${tool}`);
    }
  }
  for (const [tool, granted] of Object.entries(policy.promptTools)) {
    if (typeof granted !== "boolean") throw m4d("M4D_PERMISSIONS_NOT_READ_ONLY", `M4D_PERMISSIONS_NOT_READ_ONLY: tools action ${tool}`);
    if (granted && !(OPENCODE_AUDIT_READ_TOOLS_V2 as readonly string[]).includes(tool)) {
      throw m4d("M4D_PERMISSIONS_NOT_READ_ONLY", `M4D_PERMISSIONS_NOT_READ_ONLY: tools grant ${tool}`);
    }
  }
  for (const rule of policy.sessionPermission) {
    if (typeof rule.permission !== "string" || typeof rule.pattern !== "string" || typeof rule.action !== "string") {
      throw m4d("M4D_PERMISSIONS_NOT_READ_ONLY", "M4D_PERMISSIONS_NOT_READ_ONLY: malformed session rule");
    }
    if (rule.action !== "deny" && (OPENCODE_AUDIT_DENIED_TOOLS_V2 as readonly string[]).includes(rule.permission)) {
      throw m4d("M4D_PERMISSIONS_NOT_READ_ONLY", `M4D_PERMISSIONS_NOT_READ_ONLY: session rule ${rule.permission}`);
    }
    if (rule.action === "allow" && !(OPENCODE_AUDIT_READ_TOOLS_V2 as readonly string[]).includes(rule.permission)) {
      throw m4d("M4D_PERMISSIONS_NOT_READ_ONLY", `M4D_PERMISSIONS_NOT_READ_ONLY: session grant ${rule.permission}`);
    }
  }
  const denied = (permission: string, pattern: string): boolean =>
    policy.sessionPermission.some((rule) => rule.permission === permission && rule.pattern === pattern && rule.action === "deny");
  for (const tool of OPENCODE_AUDIT_DENIED_TOOLS_V2) {
    if (!denied(tool, "*")) throw m4d("M4D_PERMISSIONS_NOT_READ_ONLY", `M4D_PERMISSIONS_NOT_READ_ONLY: session ${tool} is not denied`);
    for (const root of OPENCODE_AUDIT_PROTECTED_ROOTS_V2) {
      if (!denied(tool, root) || !denied(tool, `${root}/**`)) {
        throw m4d("M4D_PERMISSIONS_NOT_READ_ONLY", `M4D_PERMISSIONS_NOT_READ_ONLY: session ${tool} ${root}`);
      }
    }
  }
  for (const tool of OPENCODE_AUDIT_READ_TOOLS_V2) {
    for (const root of OPENCODE_AUDIT_UNREADABLE_ROOTS_V2) {
      if (!denied(tool, root) || !denied(tool, `${root}/**`)) {
        throw m4d("M4D_PERMISSIONS_NOT_READ_ONLY", `M4D_PERMISSIONS_NOT_READ_ONLY: session ${tool} may read ${root}`);
      }
    }
  }
}

/**
 * Read-only child environment. It reuses the frozen M4-B allowlist so the
 * Auditor inherits exactly the same environment discipline, then replaces the
 * permission payload with the read-only Auditor policy.
 */
export function openCodeAuditReadOnlyChildEnvironmentV2(
  baseEnvironment: NodeJS.ProcessEnv,
  policy: OpenCodeAuditPermissionPolicyV2,
): NodeJS.ProcessEnv {
  assertReadOnlyAuditPermissionsV2(policy);
  const environment: NodeJS.ProcessEnv = { ...baseEnvironment };
  environment.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    instructions: [],
    permission: { ...policy.environmentPermission },
  });
  return environment;
}
