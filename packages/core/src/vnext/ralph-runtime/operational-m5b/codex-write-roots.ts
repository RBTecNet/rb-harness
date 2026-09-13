import { sha256Canonical } from "../hashing.js";
import { isWorkspacePackageInfrastructurePathV1 } from "../package-infrastructure.js";
import { RalphM5BError } from "./contract-errors.js";
import { tokenizeOwnership } from "./codex-delta.js";
import {
  CODEX_PROJECTION_EXCLUDED_ROOTS_V2,
  assertSafeRelativePathV2,
  isCodexProjectionExcludedPathV2,
} from "./codex-projection.js";

/**
 * Ralph M5-B — derivation of the provider write authority.
 *
 * The provider may write only what the Core WorkUnit already declares it
 * owns.  Nothing here is provider-supplied and nothing widens with use: the
 * plan comes from `scope` and `covers` alone.
 *
 * A WorkUnit whose product genuinely lives at the workspace root —
 * `package.json`, `go.mod`, `go.sum`, `README.md`, `**`, `${RB_VERIFY_ROOT}`
 * — is legitimate and appears throughout the real corpus.  M5-B used to
 * refuse it, because granting write on the STAGING root would have re-opened
 * every control-plane name inside the projection.  It no longer refuses: the
 * staging root becomes writable, and the control-plane names are closed
 * PHYSICALLY instead, by pre-created protected sentinels that the permission
 * profile denies by exact path.
 *
 * Two authorities stay separate and must not be merged.  This plan decides
 * physical CAPABILITY — what the sandbox can touch at all.  The frozen
 * `scopeTokenCoversPath` decides publishable AUTHORITY — what the host delta
 * will accept.  A writable staging root never widens the second.
 */
export const CODEX_WRITE_ROOT_PLAN_SCHEMA_V2 = "rb-ralph-codex-write-root-plan/v1" as const;

export interface CodexWriteRootPlanV2 {
  readonly schema: typeof CODEX_WRITE_ROOT_PLAN_SCHEMA_V2;
  /** True when an ownership token reaches the workspace root itself. */
  readonly stagingRootWritable: boolean;
  /**
   * Project-relative product directories granted write.  Empty when the
   * staging root itself is writable, because it already spans them.
   */
  readonly productRoots: readonly string[];
  /**
   * Control-plane roots that must exist as protected sentinels before the
   * sandbox is admitted.  Empty unless the staging root is writable: when it
   * is not, those names are unreachable structurally and the projection
   * proves them ABSENT instead.
   */
  readonly sentinelRoots: readonly string[];
  /** The ownership tokens the plan was derived from, normalized and sorted. */
  readonly ownershipTokens: readonly string[];
  readonly planDigest: string;
}

export interface DeriveCodexWriteRootPlanInputV2 {
  readonly scope: string;
  readonly covers: string;
  /**
   * Project-relative directories that already exist in the product surface,
   * used to tell an owned directory from an owned file.  Taken from the
   * canonical fingerprint, never from the provider.
   */
  readonly directories: readonly string[];
}

export function deriveCodexWriteRootPlanV2(input: DeriveCodexWriteRootPlanInputV2): CodexWriteRootPlanV2 {
  const tokens = [...tokenizeOwnership(input.scope), ...tokenizeOwnership(input.covers)];
  if (tokens.length === 0) throw new RalphM5BError("M5B_PERMISSION_PROFILE_INVALID", "M5B_PERMISSION_PROFILE_INVALID: the WorkUnit declares no owned path");
  const directories = new Set(input.directories);

  const productRoots = new Set<string>();
  let stagingRootWritable = false;
  for (const token of tokens) {
    const normalized = normalizeV2(token);
    if (normalized === "") {
      // `${RB_VERIFY_ROOT}` and a bare `.`: the whole workspace is the
      // product surface.
      stagingRootWritable = true;
      continue;
    }
    const root = writeRootForV2(normalized, directories);
    if (root === "") {
      // A root-level owned path — `package.json`, `go.mod`, `**`. The write
      // root IS the staging root; sentinels close the control plane.
      stagingRootWritable = true;
      continue;
    }
    assertSafeRelativePathV2(root);
    if (isWorkspacePackageInfrastructurePathV1(root)) {
      throw new RalphM5BError("M5B_PERMISSION_PROFILE_INVALID", `M5B_PERMISSION_PROFILE_INVALID: package infrastructure write root ${root}`);
    }
    if (isCodexProjectionExcludedPathV2(root)) {
      throw new RalphM5BError("M5B_PERMISSION_PROFILE_INVALID", `M5B_PERMISSION_PROFILE_INVALID: control-plane write root ${root}`);
    }
    productRoots.add(root);
  }

  // A writable staging root already spans every product directory beneath it;
  // carrying redundant PRODUCT_WRITE entries would only widen the profile's
  // surface without widening its authority.
  const sorted = stagingRootWritable ? [] : [...productRoots].sort();
  const minimal = sorted.filter((root) => !sorted.some((other) => other !== root && root.startsWith(`${other}/`)));
  const sentinelRoots = stagingRootWritable ? [...CODEX_PROJECTION_EXCLUDED_ROOTS_V2].sort() : [];
  if (stagingRootWritable && sentinelRoots.length === 0) {
    // The sentinel set is derived from the workspace authority, never
    // restated. An empty set would mean the authority itself vanished, which
    // must never silently produce an unguarded writable root.
    throw new RalphM5BError("M5B_SENTINEL_MANIFEST_INVALID", "M5B_SENTINEL_MANIFEST_INVALID: a writable staging root requires at least one protected sentinel");
  }
  if (!stagingRootWritable && minimal.length === 0) {
    throw new RalphM5BError("M5B_PERMISSION_PROFILE_INVALID", "M5B_PERMISSION_PROFILE_INVALID: the WorkUnit declares no writable product root");
  }

  const base = {
    schema: CODEX_WRITE_ROOT_PLAN_SCHEMA_V2,
    stagingRootWritable,
    productRoots: Object.freeze(minimal),
    sentinelRoots: Object.freeze(sentinelRoots),
    ownershipTokens: Object.freeze([...new Set(tokens)].sort()),
  };
  return Object.freeze({ ...base, planDigest: sha256Canonical(base) });
}

/**
 * The product directories the projection must materialize and the profile
 * must grant.  Empty for a root-scope plan, where the staging root itself
 * carries the grant.
 */
export function codexWritableProductRootsV2(plan: CodexWriteRootPlanV2): readonly string[] {
  return plan.productRoots;
}

function normalizeV2(value: string): string {
  const trimmed = value.trim();
  // Matches the frozen ownership normalization: a bare `${RB_VERIFY_ROOT}`
  // is the workspace root itself.
  if (trimmed === "${RB_VERIFY_ROOT}" || trimmed === "." || trimmed === "./") return "";
  return trimmed
    .replaceAll("\\", "/")
    .replace(/^\$\{RB_VERIFY_ROOT\}\/?/, "")
    .replace(/^\.\//, "")
    .replace(/\/{2,}/g, "/")
    .replace(/\/$/, "");
}

function writeRootForV2(normalized: string, directories: ReadonlySet<string>): string {
  const globIndex = normalized.search(/[*?]/);
  if (globIndex >= 0) {
    // Everything up to the last separator before the first wildcard is a
    // literal directory prefix; a partial segment is discarded.
    const separator = normalized.lastIndexOf("/", globIndex);
    return separator < 0 ? "" : normalized.slice(0, separator);
  }
  if (directories.has(normalized)) return normalized;
  const separator = normalized.lastIndexOf("/");
  return separator < 0 ? "" : normalized.slice(0, separator);
}
