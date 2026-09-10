import { isAbsolute, resolve, sep } from "node:path";
import { sha256Canonical } from "../hashing.js";
import { m5d } from "./contract.js";

export const CODEX_AUDITOR_PERMISSION_PROFILE_SCHEMA_V2 = "rb-ralph-codex-auditor-permission-profile/v1" as const;
export const CODEX_AUDITOR_PERMISSION_PROFILE_NAME_V2 = "ralph_m5d_auditor" as const;
export const CODEX_AUDITOR_CONTROL_PLANE_ROOTS_V2 = Object.freeze([".rb-harness", ".rb", ".git"] as const);

export const CODEX_AUDITOR_PERMISSION_ROLES_V2 = [
  "ROOT", "MINIMAL", "CODEX_RUNTIME", "PRODUCT_WORKSPACE", "CONTROL_PLANE", "CODEX_HOME",
] as const;
export type CodexAuditorPermissionRoleV2 = typeof CODEX_AUDITOR_PERMISSION_ROLES_V2[number];
export type CodexAuditorFilesystemAccessV2 = "read" | "deny";

export interface CodexAuditorPermissionEntryV2 {
  readonly role: CodexAuditorPermissionRoleV2;
  readonly path: string;
  readonly access: CodexAuditorFilesystemAccessV2;
}

export interface CodexAuditorPermissionProfileV2 {
  readonly schema: typeof CODEX_AUDITOR_PERMISSION_PROFILE_SCHEMA_V2;
  readonly name: typeof CODEX_AUDITOR_PERMISSION_PROFILE_NAME_V2;
  readonly description: string;
  readonly filesystem: readonly CodexAuditorPermissionEntryV2[];
  readonly networkEnabled: false;
  readonly profileDigest: string;
}

export interface BuildCodexAuditorPermissionProfileInputV2 {
  readonly productWorkspace: string;
  readonly codexHome: string;
  readonly codexRuntimeReadRoot: string;
}

const ROLE_ACCESS: Readonly<Record<CodexAuditorPermissionRoleV2, CodexAuditorFilesystemAccessV2>> = Object.freeze({
  ROOT: "deny",
  MINIMAL: "read",
  CODEX_RUNTIME: "read",
  PRODUCT_WORKSPACE: "read",
  CONTROL_PLANE: "deny",
  CODEX_HOME: "deny",
});
const UNSAFE_TOML = /["\\]|[\u0000-\u001F\u007F]/;

export function buildCodexAuditorPermissionProfileV2(input: BuildCodexAuditorPermissionProfileInputV2): CodexAuditorPermissionProfileV2 {
  const workspace = absolute(input.productWorkspace, "workspace");
  const codexHome = absolute(input.codexHome, "CODEX_HOME");
  const runtime = absolute(input.codexRuntimeReadRoot, "runtime");
  if (within(workspace, codexHome) || within(codexHome, workspace)) throw m5d("M5D_PERMISSION_PROFILE_INVALID", "M5D_PERMISSION_PROFILE_INVALID: workspace/CODEX_HOME overlap");
  const entries: CodexAuditorPermissionEntryV2[] = [
    { role: "ROOT", path: ":root", access: "deny" },
    { role: "MINIMAL", path: ":minimal", access: "read" },
    { role: "CODEX_RUNTIME", path: runtime, access: "read" },
    { role: "PRODUCT_WORKSPACE", path: workspace, access: "read" },
    ...CODEX_AUDITOR_CONTROL_PLANE_ROOTS_V2.map((root) => ({ role: "CONTROL_PLANE" as const, path: resolve(workspace, root), access: "deny" as const })),
    { role: "CODEX_HOME", path: codexHome, access: "deny" },
  ];
  const base = {
    schema: CODEX_AUDITOR_PERMISSION_PROFILE_SCHEMA_V2,
    name: CODEX_AUDITOR_PERMISSION_PROFILE_NAME_V2,
    description: "Ralph M5-D canonical workspace read-only audit; control plane, CODEX_HOME, writes and network denied",
    filesystem: Object.freeze(entries.map((entry) => Object.freeze(entry))),
    networkEnabled: false as const,
  };
  const profile = Object.freeze({ ...base, profileDigest: sha256Canonical(base) });
  assertCodexAuditorPermissionProfileV2(profile);
  return profile;
}

export function assertCodexAuditorPermissionProfileV2(value: unknown): asserts value is CodexAuditorPermissionProfileV2 {
  if (!record(value)) throw m5d("M5D_PERMISSION_PROFILE_INVALID");
  const keys = ["schema", "name", "description", "filesystem", "networkEnabled", "profileDigest"];
  exactKeys(value, keys);
  if (value.schema !== CODEX_AUDITOR_PERMISSION_PROFILE_SCHEMA_V2 || value.name !== CODEX_AUDITOR_PERMISSION_PROFILE_NAME_V2) throw m5d("M5D_PERMISSION_PROFILE_INVALID", "M5D_PERMISSION_PROFILE_INVALID: identity");
  if (typeof value.description !== "string" || value.description.length === 0 || value.description.length > 200 || UNSAFE_TOML.test(value.description)) throw m5d("M5D_PERMISSION_PROFILE_INVALID", "M5D_PERMISSION_PROFILE_INVALID: description");
  if (value.networkEnabled !== false || !Array.isArray(value.filesystem)) throw m5d("M5D_PERMISSION_PROFILE_INVALID", "M5D_PERMISSION_PROFILE_INVALID: network/filesystem");
  const entries = value.filesystem as readonly unknown[];
  const parsed: CodexAuditorPermissionEntryV2[] = [];
  const seenPaths = new Set<string>();
  for (const candidate of entries) {
    if (!record(candidate)) throw m5d("M5D_PERMISSION_PROFILE_INVALID", "M5D_PERMISSION_PROFILE_INVALID: entry");
    exactKeys(candidate, ["role", "path", "access"]);
    if (typeof candidate.role !== "string" || !CODEX_AUDITOR_PERMISSION_ROLES_V2.includes(candidate.role as CodexAuditorPermissionRoleV2)) throw m5d("M5D_PERMISSION_PROFILE_INVALID", "M5D_PERMISSION_PROFILE_INVALID: role");
    const role = candidate.role as CodexAuditorPermissionRoleV2;
    if (candidate.access !== ROLE_ACCESS[role]) throw m5d("M5D_PERMISSION_PROFILE_INVALID", `M5D_PERMISSION_PROFILE_INVALID: ${role} access`);
    if (typeof candidate.path !== "string" || candidate.path.length === 0 || UNSAFE_TOML.test(candidate.path)) throw m5d("M5D_PERMISSION_PROFILE_INVALID", "M5D_PERMISSION_PROFILE_INVALID: path");
    if (candidate.path.startsWith(":")) {
      if (candidate.path !== ":root" && candidate.path !== ":minimal") throw m5d("M5D_PERMISSION_PROFILE_INVALID", "M5D_PERMISSION_PROFILE_INVALID: token");
    } else if (!isAbsolute(candidate.path) || resolve(candidate.path) !== candidate.path || candidate.path === sep) throw m5d("M5D_PERMISSION_PROFILE_INVALID", "M5D_PERMISSION_PROFILE_INVALID: absolute path");
    if (seenPaths.has(candidate.path)) throw m5d("M5D_PERMISSION_PROFILE_INVALID", "M5D_PERMISSION_PROFILE_INVALID: duplicate path");
    seenPaths.add(candidate.path);
    parsed.push({ role, path: candidate.path, access: candidate.access as CodexAuditorFilesystemAccessV2 });
  }
  if (parsed.some((entry) => (entry.access as string) === "write")) throw m5d("M5D_PERMISSION_PROFILE_INVALID", "M5D_PERMISSION_PROFILE_INVALID: WRITE authority is forbidden");
  for (const role of ["ROOT", "MINIMAL", "CODEX_RUNTIME", "PRODUCT_WORKSPACE", "CODEX_HOME"] as const) {
    if (parsed.filter((entry) => entry.role === role).length !== 1) throw m5d("M5D_PERMISSION_PROFILE_INVALID", `M5D_PERMISSION_PROFILE_INVALID: ${role}`);
  }
  const workspace = parsed.find((entry) => entry.role === "PRODUCT_WORKSPACE")!;
  const controls = parsed.filter((entry) => entry.role === "CONTROL_PLANE");
  if (controls.length !== CODEX_AUDITOR_CONTROL_PLANE_ROOTS_V2.length
    || CODEX_AUDITOR_CONTROL_PLANE_ROOTS_V2.some((root) => !controls.some((entry) => entry.path === resolve(workspace.path, root)))) {
    throw m5d("M5D_PERMISSION_PROFILE_INVALID", "M5D_PERMISSION_PROFILE_INVALID: control-plane denials");
  }
  if (parsed.find((entry) => entry.role === "ROOT")?.path !== ":root" || parsed.find((entry) => entry.role === "MINIMAL")?.path !== ":minimal") throw m5d("M5D_PERMISSION_PROFILE_INVALID", "M5D_PERMISSION_PROFILE_INVALID: root/minimal");
  const { profileDigest: _digest, ...base } = value;
  if (typeof value.profileDigest !== "string" || sha256Canonical(base) !== value.profileDigest) throw m5d("M5D_PERMISSION_PROFILE_INVALID", "M5D_PERMISSION_PROFILE_INVALID: digest");
}

export function codexAuditorPermissionProfileOverridesV2(profile: CodexAuditorPermissionProfileV2): readonly string[] {
  assertCodexAuditorPermissionProfileV2(profile);
  const filesystem = profile.filesystem.map((entry) => `${toml(entry.path)}=${toml(entry.access)}`).join(",");
  return Object.freeze([
    `permissions.${profile.name}={description=${toml(profile.description)},filesystem={${filesystem}},network={enabled=false}}`,
    `default_permissions=${toml(profile.name)}`,
  ]);
}

export function codexAuditorPermissionPolicyShapeDigestV2(profile: CodexAuditorPermissionProfileV2): string {
  assertCodexAuditorPermissionProfileV2(profile);
  return sha256Canonical({
    schema: profile.schema,
    name: profile.name,
    networkEnabled: profile.networkEnabled,
    roles: [...new Set(profile.filesystem.map((entry) => `${entry.role}:${entry.access}`))].sort(),
  });
}

export function codexAuditorPermissionFactsV2(profile: CodexAuditorPermissionProfileV2): Readonly<Record<string, string>> {
  assertCodexAuditorPermissionProfileV2(profile);
  return Object.freeze({
    name: profile.name,
    profileDigest: profile.profileDigest,
    root: "deny",
    workspace: "read",
    writeCount: "0",
    controlPlaneDenyCount: String(profile.filesystem.filter((entry) => entry.role === "CONTROL_PLANE").length),
    codexHome: "deny",
    network: "deny",
  });
}

function absolute(value: string, label: string): string {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value === sep || UNSAFE_TOML.test(value)) throw m5d("M5D_PERMISSION_PROFILE_INVALID", `M5D_PERMISSION_PROFILE_INVALID: ${label}`);
  return value;
}
function within(candidate: string, root: string): boolean { return candidate === root || candidate.startsWith(`${root}${sep}`); }
function toml(value: string): string { if (UNSAFE_TOML.test(value)) throw m5d("M5D_PERMISSION_PROFILE_INVALID"); return JSON.stringify(value); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = keys.filter((key) => !(key in value));
  if (unknown.length || missing.length) throw m5d("M5D_PERMISSION_PROFILE_INVALID", `M5D_PERMISSION_PROFILE_INVALID: fields ${unknown.join(",")} ${missing.join(",")}`);
}
