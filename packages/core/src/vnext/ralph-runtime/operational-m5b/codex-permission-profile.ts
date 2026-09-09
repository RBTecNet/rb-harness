import { isAbsolute, resolve, sep } from "node:path";
import { sha256Canonical } from "../hashing.js";
import { RalphM5BError } from "./contract-errors.js";
import { assertSafeRelativePathV2, isCodexProjectionExcludedPathV2 } from "./codex-projection.js";

/**
 * Ralph M5-B — the typed stock Codex permission profile.
 *
 * M5-B.1 proved that stock codex-cli 0.153.4 honours a named
 * `default_permissions` profile during `codex exec` with no legacy
 * `--sandbox` flag at all, and that such a profile can keep the staging
 * product root writable while physically denying `<CODEX_HOME>/auth.json`.
 * This module is the only place an M5-B permission policy may be expressed.
 *
 * There is deliberately no caller-supplied extension map and no free-form
 * `-c` seam: a profile is built from typed input, validated against the
 * exact 0.153.4 schema, and sealed with a digest that the provider
 * descriptor and the capability record both bind.
 */
export const CODEX_PERMISSION_PROFILE_SCHEMA_V2 = "rb-ralph-codex-permission-profile/v1" as const;

/** The single profile name M5-B may select. Never caller-supplied. */
export const CODEX_PERMISSION_PROFILE_NAME_V2 = "ralph_m5b" as const;

/**
 * The exact filesystem access vocabulary of the 0.153.4 profile schema, as
 * derived from the binary's own serde metadata during M5-B.1.  A value
 * outside this set is refused locally: stock `--strict-config` silently
 * accepts unknown permission-profile fields and is never security authority.
 */
export const CODEX_FILESYSTEM_ACCESS_MODES_V2 = ["read", "write", "deny"] as const;
export type CodexFilesystemAccessModeV2 = typeof CODEX_FILESYSTEM_ACCESS_MODES_V2[number];

/** Special path tokens understood by the stock profile schema. */
export const CODEX_PROFILE_ROOT_TOKEN_V2 = ":root" as const;
export const CODEX_PROFILE_MINIMAL_TOKEN_V2 = ":minimal" as const;

/**
 * The role an entry plays in the policy.  Roles make the profile validatable
 * and comparable independently of the absolute paths of a particular
 * Attempt, which is what lets the non-model capability probe prove the exact
 * same policy shape the real dispatch will use.
 */
export const CODEX_PERMISSION_ROLES_V2 = [
  "ROOT", "MINIMAL", "CODEX_RUNTIME", "STAGING", "STAGING_ROOT_WRITE", "PRODUCT_WRITE", "CONTROL_PLANE_SENTINEL", "CODEX_HOME",
] as const;
export type CodexPermissionRoleV2 = typeof CODEX_PERMISSION_ROLES_V2[number];

/** The access every role must carry; a deviation is refused locally. */
export const CODEX_PERMISSION_ROLE_ACCESS_V2: Readonly<Record<CodexPermissionRoleV2, CodexFilesystemAccessModeV2>> = Object.freeze({
  ROOT: "deny",
  MINIMAL: "read",
  CODEX_RUNTIME: "read",
  STAGING: "read",
  STAGING_ROOT_WRITE: "write",
  PRODUCT_WRITE: "write",
  CONTROL_PLANE_SENTINEL: "deny",
  CODEX_HOME: "deny",
});

export interface CodexPermissionFilesystemEntryV2 {
  readonly role: CodexPermissionRoleV2;
  readonly path: string;
  readonly access: CodexFilesystemAccessModeV2;
}

export interface CodexPermissionProfileV2 {
  readonly schema: typeof CODEX_PERMISSION_PROFILE_SCHEMA_V2;
  readonly name: typeof CODEX_PERMISSION_PROFILE_NAME_V2;
  readonly description: string;
  /** Ordered, deterministic; the order is part of the digest. */
  readonly filesystem: readonly CodexPermissionFilesystemEntryV2[];
  readonly networkEnabled: false;
  readonly profileDigest: string;
}

export interface BuildCodexPermissionProfileInputV2 {
  /** Absolute isolated staging projection; never the canonical project root. */
  readonly stagingWorkspace: string;
  /**
   * True when the WorkUnit's authoritative scope reaches the workspace root
   * itself — `package.json`, `go.mod`, `**`, `${RB_VERIFY_ROOT}`.  The
   * STAGING projection root then carries WRITE, and every control-plane name
   * inside it is closed by an exact-path sentinel DENY instead.
   */
  readonly stagingRootWritable?: boolean;
  /**
   * Project-relative control-plane roots that exist as protected sentinels
   * inside the projection.  Required — and only meaningful — when the
   * staging root is writable.  Derived from the single workspace authority.
   */
  readonly sentinelRoots?: readonly string[];
  /**
   * Project-relative product directories the provider may write.  Derived
   * from the WorkUnit's declared ownership, never from the provider.  Empty
   * for a root-scope profile, where the staging root already spans them.
   */
  readonly writableRoots: readonly string[];
  /** Absolute authenticated Codex home; denied to model-spawned commands. */
  readonly codexHome: string;
  /**
   * Absolute directory holding the stock Codex runtime.  The sandbox re-execs
   * the pinned binary as its own arg0 helper, so this read grant is
   * physically required: without it no sandboxed command can start at all.
   */
  readonly codexRuntimeReadRoot: string;
}

const PROFILE_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
/**
 * Characters that cannot appear inside a TOML basic string without escaping.
 * A path or description carrying one is refused outright rather than escaped,
 * so every emitted `-c` override stays a literal we can reason about.
 */
const UNSAFE_TOML_PATTERN = /["\\]|[\u0000-\u001F\u007F]/;

const PROFILE_KEYS: readonly string[] = Object.freeze([
  "schema", "name", "description", "filesystem", "networkEnabled", "profileDigest",
]);

/**
 * Build the exact M5-B permission profile.
 *
 * The resulting policy always denies the filesystem root, grants the minimal
 * runtime read set, grants read on the Codex runtime tree and denies
 * CODEX_HOME.  The product write authority comes in exactly one of two
 * shapes, and they are never interchangeable:
 *
 *   NON-ROOT — the staging root is READ-only and each declared product
 *   directory carries WRITE.  Control-plane names are unreachable
 *   structurally: the projection materializes none of them.
 *
 *   ROOT — the WorkUnit's product genuinely lives at the workspace root, so
 *   the staging root itself carries WRITE.  Every control-plane name is then
 *   closed PHYSICALLY: the projection pre-creates a protected sentinel at
 *   each one and this profile denies each by exact path.  Stock 0.153.4 only
 *   enforces a path that exists when the sandbox starts, which is precisely
 *   why the sentinels are pre-created rather than merely named.
 *
 * The two shapes produce different policy-shape digests, so a profile built
 * for a non-root WorkUnit can never be substituted for a root one.
 */
export function buildCodexPermissionProfileV2(input: BuildCodexPermissionProfileInputV2): CodexPermissionProfileV2 {
  const staging = requireAbsoluteDirectoryV2(input.stagingWorkspace, "stagingWorkspace");
  const codexHome = requireAbsoluteDirectoryV2(input.codexHome, "codexHome");
  const runtimeRead = requireAbsoluteDirectoryV2(input.codexRuntimeReadRoot, "codexRuntimeReadRoot");
  if (isWithinV2(codexHome, staging) || isWithinV2(staging, codexHome)) {
    throw new RalphM5BError("M5B_PERMISSION_PROFILE_INVALID", "M5B_PERMISSION_PROFILE_INVALID: CODEX_HOME and the staging projection must not contain one another");
  }
  const stagingRootWritable = input.stagingRootWritable === true;
  const declaredRoots = Array.isArray(input.writableRoots) ? input.writableRoots : [];
  if (!stagingRootWritable && declaredRoots.length === 0) {
    throw new RalphM5BError("M5B_PERMISSION_PROFILE_INVALID", "M5B_PERMISSION_PROFILE_INVALID: at least one product write root is required");
  }
  if (stagingRootWritable && declaredRoots.length > 0) {
    // A writable staging root already spans every directory beneath it. A
    // redundant PRODUCT_WRITE entry would make two profiles with identical
    // authority disagree on their digest.
    throw new RalphM5BError("M5B_PERMISSION_PROFILE_INVALID", "M5B_PERMISSION_PROFILE_INVALID: a writable staging root may not carry additional product write roots");
  }

  const writable: string[] = [];
  for (const root of declaredRoots) {
    if (typeof root !== "string" || root === "." || root === "" || root === "./") {
      // Reaching the staging root is expressed by `stagingRootWritable`, and
      // only together with the sentinel denials. It is never a write root
      // smuggled in as a relative path.
      throw new RalphM5BError("M5B_PERMISSION_PROFILE_INVALID", "M5B_PERMISSION_PROFILE_INVALID: the staging root is not a relative write root");
    }
    const relative = assertSafeRelativePathV2(root);
    if (isCodexProjectionExcludedPathV2(relative)) {
      throw new RalphM5BError("M5B_PERMISSION_PROFILE_INVALID", `M5B_PERMISSION_PROFILE_INVALID: control-plane write root ${relative}`);
    }
    const absolute = resolve(staging, relative);
    if (!isWithinV2(absolute, staging)) {
      throw new RalphM5BError("M5B_PERMISSION_PROFILE_INVALID", `M5B_PERMISSION_PROFILE_INVALID: write root escapes the projection: ${relative}`);
    }
    writable.push(absolute);
  }

  const sentinels: string[] = [];
  const declaredSentinels = Array.isArray(input.sentinelRoots) ? input.sentinelRoots : [];
  if (stagingRootWritable && declaredSentinels.length === 0) {
    throw new RalphM5BError("M5B_PERMISSION_PROFILE_INVALID", "M5B_PERMISSION_PROFILE_INVALID: a writable staging root requires at least one control-plane sentinel denial");
  }
  if (!stagingRootWritable && declaredSentinels.length > 0) {
    throw new RalphM5BError("M5B_PERMISSION_PROFILE_INVALID", "M5B_PERMISSION_PROFILE_INVALID: sentinel denials are only meaningful with a writable staging root");
  }
  for (const root of declaredSentinels) {
    const relative = assertSafeRelativePathV2(root);
    if (!isCodexProjectionExcludedPathV2(relative)) {
      // A sentinel that is not a control-plane root would deny an ordinary
      // product path, silently narrowing the WorkUnit's own authority.
      throw new RalphM5BError("M5B_PERMISSION_PROFILE_INVALID", `M5B_PERMISSION_PROFILE_INVALID: ${relative} is not a control-plane root`);
    }
    if (relative.includes("/")) {
      throw new RalphM5BError("M5B_PERMISSION_PROFILE_INVALID", `M5B_PERMISSION_PROFILE_INVALID: a sentinel must be a top-level root: ${relative}`);
    }
    sentinels.push(resolve(staging, relative));
  }

  const filesystem: CodexPermissionFilesystemEntryV2[] = [
    { role: "ROOT", path: CODEX_PROFILE_ROOT_TOKEN_V2, access: "deny" },
    { role: "MINIMAL", path: CODEX_PROFILE_MINIMAL_TOKEN_V2, access: "read" },
    { role: "CODEX_RUNTIME", path: runtimeRead, access: "read" },
    ...(stagingRootWritable
      ? [{ role: "STAGING_ROOT_WRITE" as const, path: staging, access: "write" as const }]
      : [{ role: "STAGING" as const, path: staging, access: "read" as const }]),
    ...[...new Set(writable)].sort().map((path) => ({ role: "PRODUCT_WRITE" as const, path, access: "write" as const })),
    ...[...new Set(sentinels)].sort().map((path) => ({ role: "CONTROL_PLANE_SENTINEL" as const, path, access: "deny" as const })),
    { role: "CODEX_HOME", path: codexHome, access: "deny" },
  ];

  const base = {
    schema: CODEX_PERMISSION_PROFILE_SCHEMA_V2,
    name: CODEX_PERMISSION_PROFILE_NAME_V2,
    description: stagingRootWritable
      ? "Ralph M5-B isolated staging projection; root denied, staging root writable, control-plane sentinels denied, CODEX_HOME denied, network disabled"
      : "Ralph M5-B isolated staging projection; root denied, CODEX_HOME denied, network disabled",
    filesystem: Object.freeze(filesystem.map((entry) => Object.freeze({ ...entry }))),
    networkEnabled: false as const,
  };
  const profile: CodexPermissionProfileV2 = Object.freeze({ ...base, profileDigest: sha256Canonical(base) });
  assertCodexPermissionProfileV2(profile);
  return profile;
}

/** Whether this profile grants WRITE on the staging projection root itself. */
export function codexPermissionProfileGrantsRootWriteV2(profile: CodexPermissionProfileV2): boolean {
  return profile.filesystem.some((entry) => entry.role === "STAGING_ROOT_WRITE");
}

/** The absolute sentinel paths this profile denies by exact path. */
export function codexPermissionProfileSentinelPathsV2(profile: CodexPermissionProfileV2): readonly string[] {
  return Object.freeze(profile.filesystem.filter((entry) => entry.role === "CONTROL_PLANE_SENTINEL").map((entry) => entry.path));
}

/**
 * Validate a permission profile completely and locally.
 *
 * Unknown fields, an unknown access mode, a widened root policy, a missing
 * CODEX_HOME denial, a missing product write root and enabled network are all
 * refused here — before any Codex process exists.  Stock `--strict-config`
 * is never relied upon: M5-B.1 proved it silently accepts unknown fields
 * inside a permission profile.
 */
export function assertCodexPermissionProfileV2(value: unknown): asserts value is CodexPermissionProfileV2 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RalphM5BError("M5B_PERMISSION_PROFILE_INVALID", "M5B_PERMISSION_PROFILE_INVALID: not a record");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(PROFILE_KEYS);
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new RalphM5BError("M5B_PERMISSION_PROFILE_INVALID", `M5B_PERMISSION_PROFILE_INVALID: unknown fields ${unknown.sort().join(",")}`);
  if (PROFILE_KEYS.some((key) => !(key in record))) throw new RalphM5BError("M5B_PERMISSION_PROFILE_INVALID", "M5B_PERMISSION_PROFILE_INVALID: missing fields");
  if (record.schema !== CODEX_PERMISSION_PROFILE_SCHEMA_V2) throw new RalphM5BError("M5B_PERMISSION_PROFILE_INVALID", "M5B_PERMISSION_PROFILE_INVALID: schema");
  if (typeof record.name !== "string" || record.name !== CODEX_PERMISSION_PROFILE_NAME_V2 || !PROFILE_NAME_PATTERN.test(record.name)) {
    throw new RalphM5BError("M5B_PERMISSION_PROFILE_INVALID", "M5B_PERMISSION_PROFILE_INVALID: name");
  }
  if (typeof record.description !== "string" || record.description.length === 0 || record.description.length > 200 || UNSAFE_TOML_PATTERN.test(record.description)) {
    throw new RalphM5BError("M5B_PERMISSION_PROFILE_INVALID", "M5B_PERMISSION_PROFILE_INVALID: description");
  }
  if (record.networkEnabled !== false) throw new RalphM5BError("M5B_PERMISSION_PROFILE_INVALID", "M5B_PERMISSION_PROFILE_INVALID: network must be disabled");
  if (!Array.isArray(record.filesystem) || record.filesystem.length === 0) {
    throw new RalphM5BError("M5B_PERMISSION_PROFILE_INVALID", "M5B_PERMISSION_PROFILE_INVALID: filesystem");
  }

  const seen = new Set<string>();
  const entries: CodexPermissionFilesystemEntryV2[] = [];
  for (const raw of record.filesystem as readonly unknown[]) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new RalphM5BError("M5B_PERMISSION_PROFILE_INVALID", "M5B_PERMISSION_PROFILE_INVALID: filesystem entry");
    const entry = raw as Record<string, unknown>;
    const entryUnknown = Object.keys(entry).filter((key) => key !== "role" && key !== "path" && key !== "access");
    if (entryUnknown.length > 0) throw new RalphM5BError("M5B_PERMISSION_PROFILE_INVALID", `M5B_PERMISSION_PROFILE_INVALID: unknown entry fields ${entryUnknown.sort().join(",")}`);
    const { role, path, access } = entry;
    if (typeof role !== "string" || !(CODEX_PERMISSION_ROLES_V2 as readonly string[]).includes(role)) {
      throw new RalphM5BError("M5B_PERMISSION_PROFILE_INVALID", `M5B_PERMISSION_PROFILE_INVALID: role ${String(role)}`);
    }
    if (access !== CODEX_PERMISSION_ROLE_ACCESS_V2[role as CodexPermissionRoleV2]) {
      throw new RalphM5BError("M5B_PERMISSION_PROFILE_INVALID", `M5B_PERMISSION_PROFILE_INVALID: role ${role} must be ${CODEX_PERMISSION_ROLE_ACCESS_V2[role as CodexPermissionRoleV2]}`);
    }
    if (typeof path !== "string" || path.length === 0 || UNSAFE_TOML_PATTERN.test(path)) {
      throw new RalphM5BError("M5B_PERMISSION_PROFILE_INVALID", "M5B_PERMISSION_PROFILE_INVALID: entry path");
    }
    if (typeof access !== "string" || !(CODEX_FILESYSTEM_ACCESS_MODES_V2 as readonly string[]).includes(access)) {
      throw new RalphM5BError("M5B_PERMISSION_PROFILE_INVALID", `M5B_PERMISSION_PROFILE_INVALID: access ${String(access)}`);
    }
    if (path.startsWith(":")) {
      if (path !== CODEX_PROFILE_ROOT_TOKEN_V2 && path !== CODEX_PROFILE_MINIMAL_TOKEN_V2) {
        throw new RalphM5BError("M5B_PERMISSION_PROFILE_INVALID", `M5B_PERMISSION_PROFILE_INVALID: special token ${path}`);
      }
    } else if (!isAbsolute(path) || resolve(path) !== path) {
      throw new RalphM5BError("M5B_PERMISSION_PROFILE_INVALID", `M5B_PERMISSION_PROFILE_INVALID: entry path must be absolute and normalized: ${path}`);
    }
    if (seen.has(path)) throw new RalphM5BError("M5B_PERMISSION_PROFILE_INVALID", `M5B_PERMISSION_PROFILE_INVALID: duplicate ${path}`);
    seen.add(path);
    entries.push({ role: role as CodexPermissionRoleV2, path, access: access as CodexFilesystemAccessModeV2 });
  }

  for (const required of ["ROOT", "MINIMAL", "CODEX_RUNTIME", "CODEX_HOME"] as const) {
    if (!entries.some((entry) => entry.role === required)) {
      throw new RalphM5BError("M5B_PERMISSION_PROFILE_INVALID", `M5B_PERMISSION_PROFILE_INVALID: missing ${required} entry`);
    }
  }
  const root = entries.find((entry) => entry.path === CODEX_PROFILE_ROOT_TOKEN_V2);
  if (!root || root.access !== "deny") throw new RalphM5BError("M5B_PERMISSION_PROFILE_INVALID", "M5B_PERMISSION_PROFILE_INVALID: the filesystem root must be denied");
  const minimal = entries.find((entry) => entry.path === CODEX_PROFILE_MINIMAL_TOKEN_V2);
  if (!minimal || minimal.access !== "read") throw new RalphM5BError("M5B_PERMISSION_PROFILE_INVALID", "M5B_PERMISSION_PROFILE_INVALID: minimal runtime must be read-only");

  // Exactly one staging shape. The two are mutually exclusive by
  // construction, and mixing them would mean a root-write profile that also
  // claims the staging root is read-only.
  const stagingRead = entries.filter((entry) => entry.role === "STAGING");
  const stagingWrite = entries.filter((entry) => entry.role === "STAGING_ROOT_WRITE");
  const productWrites = entries.filter((entry) => entry.role === "PRODUCT_WRITE");
  const sentinels = entries.filter((entry) => entry.role === "CONTROL_PLANE_SENTINEL");
  if (stagingRead.length + stagingWrite.length !== 1) {
    throw new RalphM5BError("M5B_PERMISSION_PROFILE_INVALID", "M5B_PERMISSION_PROFILE_INVALID: exactly one staging root entry is required");
  }
  if (stagingWrite.length === 1) {
    if (productWrites.length > 0) throw new RalphM5BError("M5B_PERMISSION_PROFILE_INVALID", "M5B_PERMISSION_PROFILE_INVALID: a writable staging root may not carry additional product write roots");
    // A writable staging root without an exact-path sentinel denial would
    // re-open every control-plane name inside the projection. This is the
    // single condition the whole root-scope design rests on.
    if (sentinels.length === 0) throw new RalphM5BError("M5B_PERMISSION_PROFILE_INVALID", "M5B_PERMISSION_PROFILE_INVALID: a writable staging root requires at least one control-plane sentinel denial");
    const stagingPath = stagingWrite[0]!.path;
    for (const sentinel of sentinels) {
      if (!isWithinV2(sentinel.path, stagingPath) || sentinel.path === stagingPath) {
        throw new RalphM5BError("M5B_PERMISSION_PROFILE_INVALID", `M5B_PERMISSION_PROFILE_INVALID: sentinel ${sentinel.path} is not inside the writable staging root`);
      }
    }
  } else {
    if (productWrites.length === 0) throw new RalphM5BError("M5B_PERMISSION_PROFILE_INVALID", "M5B_PERMISSION_PROFILE_INVALID: no product write root");
    if (sentinels.length > 0) throw new RalphM5BError("M5B_PERMISSION_PROFILE_INVALID", "M5B_PERMISSION_PROFILE_INVALID: sentinel denials require a writable staging root");
  }

  const writes = entries.filter((entry) => entry.access === "write");
  if (writes.length === 0) throw new RalphM5BError("M5B_PERMISSION_PROFILE_INVALID", "M5B_PERMISSION_PROFILE_INVALID: no product write root");
  const denies = entries.filter((entry) => entry.access === "deny" && entry.path !== CODEX_PROFILE_ROOT_TOKEN_V2);
  if (!entries.some((entry) => entry.role === "CODEX_HOME" && entry.access === "deny")) {
    throw new RalphM5BError("M5B_PERMISSION_PROFILE_INVALID", "M5B_PERMISSION_PROFILE_INVALID: CODEX_HOME must be denied");
  }
  for (const write of writes) {
    for (const deny of denies) {
      // A sentinel lives INSIDE the writable staging root by design; that is
      // the whole point. What must never happen is the reverse — a write
      // root that sits inside a denied one, which would be a rule the
      // sandbox cannot honour.
      if (isWithinV2(write.path, deny.path)) throw new RalphM5BError("M5B_PERMISSION_PROFILE_INVALID", `M5B_PERMISSION_PROFILE_INVALID: write root inside a denied root: ${write.path}`);
    }
  }

  const { profileDigest, ...base } = record;
  if (typeof profileDigest !== "string" || sha256Canonical(base) !== profileDigest) {
    throw new RalphM5BError("M5B_PERMISSION_PROFILE_INVALID", "M5B_PERMISSION_PROFILE_INVALID: digest mismatch");
  }
}

/**
 * The exact `-c` overrides that select this profile.  There is no legacy
 * `--sandbox` companion: permission profiles and the legacy sandbox are
 * distinct systems and M5-B binds only the profile.
 */
export function codexPermissionProfileOverridesV2(profile: CodexPermissionProfileV2): readonly string[] {
  assertCodexPermissionProfileV2(profile);
  const filesystem = profile.filesystem.map((entry) => `${tomlString(entry.path)}=${tomlString(entry.access)}`).join(",");
  const table = `{description=${tomlString(profile.description)},filesystem={${filesystem}},network={enabled=false}}`;
  return Object.freeze([
    `permissions.${profile.name}=${table}`,
    `default_permissions=${tomlString(profile.name)}`,
  ]);
}

/**
 * The exact policy shape every M5-B permission profile must present,
 * expressed independently of any particular Attempt's absolute paths.  It
 * lives here, with the builder, so nothing that merely consumes a profile can
 * drift away from it.
 */
export const CODEX_REQUIRED_PERMISSION_POLICY_SHAPE_V2 = policyShapeDigestOfRoles([
  "CODEX_HOME:deny",
  "CODEX_RUNTIME:read",
  "MINIMAL:read",
  "PRODUCT_WRITE:write",
  "ROOT:deny",
  "STAGING:read",
]);

/**
 * The exact policy shape a ROOT-SCOPE WorkUnit must present.  It is a
 * different shape from the non-root one — the staging root carries WRITE and
 * the control-plane sentinels carry DENY — so a profile built for one can
 * never satisfy the capability binding of the other.
 */
export const CODEX_REQUIRED_ROOT_PERMISSION_POLICY_SHAPE_V2 = policyShapeDigestOfRoles([
  "CODEX_HOME:deny",
  "CODEX_RUNTIME:read",
  "CONTROL_PLANE_SENTINEL:deny",
  "MINIMAL:read",
  "ROOT:deny",
  "STAGING_ROOT_WRITE:write",
]);

function policyShapeDigestOfRoles(roles: readonly string[]): string {
  return sha256Canonical({
    schema: CODEX_PERMISSION_PROFILE_SCHEMA_V2,
    name: CODEX_PERMISSION_PROFILE_NAME_V2,
    networkEnabled: false,
    roles: [...roles].sort(),
  });
}

/**
 * A path-independent digest of the policy SHAPE: the ordered sequence of
 * (role, access) pairs.  Two profiles built for different workspaces share
 * it, which is exactly what lets the non-model capability probe stand as
 * evidence for the real dispatch.
 */
export function codexPermissionPolicyShapeDigestV2(profile: CodexPermissionProfileV2): string {
  assertCodexPermissionProfileV2(profile);
  // Deduplicated and sorted: a WorkUnit owning two product directories has
  // two PRODUCT_WRITE entries but the SAME policy shape as one owning a
  // single directory, and both must satisfy the capability record.
  const roles = [...new Set(profile.filesystem.map((entry) => `${entry.role}:${entry.access}`))].sort();
  return sha256Canonical({
    schema: profile.schema,
    name: profile.name,
    networkEnabled: profile.networkEnabled,
    roles,
  });
}

/** Bounded credential-free facts describing the effective profile. */
export function codexPermissionProfileFactsV2(profile: CodexPermissionProfileV2): Readonly<Record<string, string>> {
  assertCodexPermissionProfileV2(profile);
  return Object.freeze({
    name: profile.name,
    profileDigest: profile.profileDigest,
    rootPolicy: "deny",
    networkEnabled: "false",
    stagingRootWritable: String(codexPermissionProfileGrantsRootWriteV2(profile)),
    sentinelDenyCount: String(codexPermissionProfileSentinelPathsV2(profile).length),
    entryCount: String(profile.filesystem.length),
    writeRootCount: String(profile.filesystem.filter((entry) => entry.access === "write").length),
    denyRootCount: String(profile.filesystem.filter((entry) => entry.access === "deny").length),
  });
}

function tomlString(value: string): string {
  if (UNSAFE_TOML_PATTERN.test(value)) throw new RalphM5BError("M5B_PERMISSION_PROFILE_INVALID", "M5B_PERMISSION_PROFILE_INVALID: unencodable value");
  return `"${value}"`;
}

function requireAbsoluteDirectoryV2(value: string, label: string): string {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value === sep || UNSAFE_TOML_PATTERN.test(value)) {
    throw new RalphM5BError("M5B_PERMISSION_PROFILE_INVALID", `M5B_PERMISSION_PROFILE_INVALID: ${label}`);
  }
  return value;
}

/** True when `candidate` is `root` itself or lives beneath it. */
export function isWithinV2(candidate: string, root: string): boolean {
  if (root.startsWith(":")) return false;
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}
