import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspacePolicy, fingerprintWorkspace } from "../../src/vnext/ralph-runtime/fingerprint.js";
import { scopeTokenCoversPath } from "../../src/path-ownership.js";
import { RalphM5BError } from "../../src/vnext/ralph-runtime/operational-m5b/contract-errors.js";
import { deriveCodexWriteRootPlanV2 } from "../../src/vnext/ralph-runtime/operational-m5b/codex-write-roots.js";
import {
  CODEX_REQUIRED_PERMISSION_POLICY_SHAPE_V2,
  CODEX_REQUIRED_ROOT_PERMISSION_POLICY_SHAPE_V2,
  assertCodexPermissionProfileV2,
  buildCodexPermissionProfileV2,
  codexPermissionPolicyShapeDigestV2,
  codexPermissionProfileGrantsRootWriteV2,
  codexPermissionProfileSentinelPathsV2,
} from "../../src/vnext/ralph-runtime/operational-m5b/codex-permission-profile.js";
import {
  CODEX_PROJECTION_EXCLUDED_ROOTS_V2,
  CODEX_SENTINEL_MODE_V2,
  buildCodexProviderProjectionV2,
  captureCodexSentinelPreimageV2,
  readCodexProjectionStateV2,
  validateCodexProjectionManifestV2,
  verifyCodexRootSentinelsV2,
} from "../../src/vnext/ralph-runtime/operational-m5b/codex-projection.js";
import { createCodexWorkspaceDeltaV2, deriveCodexWorkspaceDeltaEntriesV2 } from "../../src/vnext/ralph-runtime/operational-m5b/codex-delta.js";

/**
 * Ralph M5-B — root-level product scope.
 *
 * The MAJOR this file closes: a WorkUnit whose authoritative product lives at
 * the workspace root — `package.json`, `go.mod`, `go.sum`, `README.md`, `**`,
 * `${RB_VERIFY_ROOT}` — used to be refused outright, because granting write
 * on the staging root would have re-opened every control-plane name inside
 * the projection.  Those WorkUnits are legitimate and appear throughout the
 * real corpus, so they are now supported, with the control plane closed
 * physically by pre-created, profile-denied sentinels instead.
 *
 * Two authorities stay separate throughout and this file tests both:
 * the permission profile decides physical CAPABILITY, and the frozen
 * `scopeTokenCoversPath` decides publishable AUTHORITY.
 */
const BINDING = Object.freeze({
  runId: "run-root", phaseId: "P01", taskId: "T001", attemptId: "attempt-root", invocationId: "invocation-root",
});

const temporaries: string[] = [];
afterEach(async () => {
  await Promise.all(temporaries.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function scratch(prefix: string): Promise<string> {
  const path = await mkdtemp(resolve(tmpdir(), prefix));
  temporaries.push(path);
  return path;
}

/** A disposable canonical project with root product files and canaries. */
async function canonicalProject(files: Readonly<Record<string, string>> = {}): Promise<string> {
  const root = await scratch("rb-ralph-m5b-root-project-");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "index.ts"), "export const ready = true;\n");
  await writeFile(join(root, "README.md"), "# root fixture\n");
  for (const controlRoot of CODEX_PROJECTION_EXCLUDED_ROOTS_V2) {
    await mkdir(join(root, controlRoot), { recursive: true });
    await writeFile(join(root, controlRoot, "canary.txt"), "control-plane canary\n");
  }
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

async function projectRootScope(input: {
  readonly scope: string;
  readonly covers: string;
  readonly files?: Readonly<Record<string, string>>;
}) {
  const projectRoot = await canonicalProject(input.files);
  const stagingBase = await scratch("rb-ralph-m5b-root-staging-");
  const staging = join(stagingBase, "workspace");
  const policy = createWorkspacePolicy({ scopePaths: [input.scope], coversPaths: [input.covers] });
  const fingerprint = await fingerprintWorkspace(projectRoot, policy);
  const plan = deriveCodexWriteRootPlanV2({
    scope: input.scope,
    covers: input.covers,
    directories: fingerprint.productWorkspaceEntries.filter((entry) => entry.kind === "directory").map((entry) => entry.path),
  });
  const manifest = await buildCodexProviderProjectionV2({
    projectRoot,
    stagingWorkspace: staging,
    binding: BINDING,
    fingerprint,
    writableRoots: plan.productRoots,
    stagingRootWritable: plan.stagingRootWritable,
    sentinelRoots: plan.sentinelRoots,
    createdAt: "2026-09-09T00:00:00.000Z",
  });
  const preimage = await captureCodexSentinelPreimageV2(staging, manifest);
  return { projectRoot, staging, plan, manifest, preimage, fingerprint };
}

describe("Ralph M5-B — root-level product scope corpus", () => {
  // The exact corpus the audit named, plus the directory scopes that must
  // keep behaving as they always did.
  const ROOT_SCOPES = ["package.json", "README.md", "go.mod", "go.sum", "composer.json", "**", "${RB_VERIFY_ROOT}"] as const;

  it("accepts every legitimate root-level scope instead of failing closed", () => {
    for (const scope of ROOT_SCOPES) {
      const plan = deriveCodexWriteRootPlanV2({ scope, covers: scope, directories: ["src"] });
      expect(plan.stagingRootWritable, scope).toBe(true);
      // A writable staging root carries no redundant product roots: it
      // already spans everything beneath it.
      expect(plan.productRoots, scope).toEqual([]);
      // And it is never granted without the full sentinel set.
      expect(plan.sentinelRoots, scope).toEqual([...CODEX_PROJECTION_EXCLUDED_ROOTS_V2].sort());
    }
  });

  it("supports multi-root and mixed WorkUnits", () => {
    const multi = deriveCodexWriteRootPlanV2({ scope: "go.mod go.sum", covers: "go.mod go.sum", directories: [] });
    expect(multi.stagingRootWritable).toBe(true);
    expect(multi.sentinelRoots.length).toBeGreaterThan(0);

    // A mixed WorkUnit reaches the root, so the root grant subsumes `src`.
    const mixed = deriveCodexWriteRootPlanV2({ scope: "package.json src/index.ts", covers: "package.json src/index.ts", directories: ["src"] });
    expect(mixed.stagingRootWritable).toBe(true);
    expect(mixed.productRoots).toEqual([]);
  });

  it("leaves ordinary directory scopes exactly as they were", () => {
    for (const [scope, expected] of [["src", ["src"]], ["src/**", ["src"]], ["src/status.js", ["src"]]] as const) {
      const plan = deriveCodexWriteRootPlanV2({ scope, covers: scope, directories: ["src"] });
      expect(plan.stagingRootWritable, scope).toBe(false);
      expect(plan.productRoots, scope).toEqual([...expected]);
      expect(plan.sentinelRoots, scope).toEqual([]);
    }
  });

  it("refuses a control-plane path as an owned write root, root scope or not", () => {
    for (const scope of [".rb-harness/state.json", ".rb/x", ".git/config"]) {
      expect(() => deriveCodexWriteRootPlanV2({ scope, covers: scope, directories: [scope.split("/")[0]!] })).toThrow(/M5B_PERMISSION_PROFILE_INVALID/);
    }
  });
});

describe("Ralph M5-B — the root-write permission profile", () => {
  const STAGING = "/tmp/rb-ralph-m5b-root-profile";
  const SENTINELS = [...CODEX_PROJECTION_EXCLUDED_ROOTS_V2].sort();

  function rootProfile(overrides: Partial<Parameters<typeof buildCodexPermissionProfileV2>[0]> = {}) {
    return buildCodexPermissionProfileV2({
      stagingWorkspace: STAGING,
      stagingRootWritable: true,
      writableRoots: [],
      sentinelRoots: SENTINELS,
      codexHome: "/home/fixture/.codex",
      codexRuntimeReadRoot: "/opt/codex-runtime",
      ...overrides,
    });
  }

  it("grants the staging root and denies every control-plane sentinel by exact path", () => {
    const profile = rootProfile();
    expect(codexPermissionProfileGrantsRootWriteV2(profile)).toBe(true);
    expect(profile.filesystem.find((entry) => entry.role === "STAGING_ROOT_WRITE")).toMatchObject({ path: STAGING, access: "write" });
    expect(codexPermissionProfileSentinelPathsV2(profile)).toEqual(SENTINELS.map((root) => join(STAGING, root)));
    for (const entry of profile.filesystem.filter((entry) => entry.role === "CONTROL_PLANE_SENTINEL")) expect(entry.access).toBe("deny");
    expect(profile.filesystem.find((entry) => entry.role === "CODEX_HOME")?.access).toBe("deny");
    expect(profile.filesystem.find((entry) => entry.path === ":root")?.access).toBe("deny");
    expect(profile.filesystem.find((entry) => entry.path === ":minimal")?.access).toBe("read");
    expect(profile.networkEnabled).toBe(false);
  });

  it("refuses a writable staging root that omits its sentinels", () => {
    expect(() => rootProfile({ sentinelRoots: [] })).toThrow(/M5B_PERMISSION_PROFILE_INVALID/);
    // And the same profile with the sentinel denials stripped after the fact
    // must not validate either: the denial is the whole boundary.
    const profile = rootProfile();
    expect(() => assertCodexPermissionProfileV2({
      ...profile,
      filesystem: profile.filesystem.filter((entry) => entry.role !== "CONTROL_PLANE_SENTINEL"),
    })).toThrow(/M5B_PERMISSION_PROFILE_INVALID/);
  });

  it("keeps the root and non-root policy shapes distinct and non-substitutable", () => {
    const root = rootProfile();
    const nonRoot = buildCodexPermissionProfileV2({
      stagingWorkspace: STAGING,
      writableRoots: ["src"],
      codexHome: "/home/fixture/.codex",
      codexRuntimeReadRoot: "/opt/codex-runtime",
    });
    expect(codexPermissionPolicyShapeDigestV2(root)).toBe(CODEX_REQUIRED_ROOT_PERMISSION_POLICY_SHAPE_V2);
    expect(codexPermissionPolicyShapeDigestV2(nonRoot)).toBe(CODEX_REQUIRED_PERMISSION_POLICY_SHAPE_V2);
    expect(codexPermissionPolicyShapeDigestV2(root)).not.toBe(codexPermissionPolicyShapeDigestV2(nonRoot));
  });

  it("refuses to mix the two shapes", () => {
    expect(() => rootProfile({ writableRoots: ["src"] })).toThrow(/M5B_PERMISSION_PROFILE_INVALID/);
    expect(() => buildCodexPermissionProfileV2({
      stagingWorkspace: STAGING,
      writableRoots: ["src"],
      sentinelRoots: SENTINELS,
      codexHome: "/home/fixture/.codex",
      codexRuntimeReadRoot: "/opt/codex-runtime",
    })).toThrow(/M5B_PERMISSION_PROFILE_INVALID/);
    // A sentinel must be a real control-plane root, never an ordinary product
    // path that would silently narrow the WorkUnit's own authority.
    expect(() => rootProfile({ sentinelRoots: ["src"] })).toThrow(/M5B_PERMISSION_PROFILE_INVALID/);
  });
});

describe("Ralph M5-B — root-scope projection and sentinels", () => {
  it("materializes an empty protected sentinel for every control-plane root", async () => {
    const { staging, manifest } = await projectRootScope({ scope: "package.json", covers: "package.json" });
    expect(manifest.stagingRootWritable).toBe(true);
    expect(manifest.sentinels.map((entry) => entry.path)).toEqual([...CODEX_PROJECTION_EXCLUDED_ROOTS_V2].sort());
    for (const sentinel of manifest.sentinels) {
      expect(sentinel.kind).toBe("directory");
      expect(sentinel.mode).toBe(CODEX_SENTINEL_MODE_V2);
      expect(sentinel.childCount).toBe(0);
      // A sentinel carries no canonical control-plane data whatsoever: the
      // canary that exists in the project must not have been copied.
      expect(await readdir(join(staging, sentinel.path))).toEqual([]);
    }
    // The projected product surface is unaffected.
    expect(await readFile(join(staging, "README.md"), "utf8")).toBe("# root fixture\n");
    expect(() => validateCodexProjectionManifestV2(manifest)).not.toThrow();
  });

  it("keeps a non-root projection free of control-plane names entirely", async () => {
    const { staging, manifest } = await projectRootScope({ scope: "src/index.ts", covers: "src/index.ts" });
    expect(manifest.stagingRootWritable).toBe(false);
    expect(manifest.sentinels).toEqual([]);
    for (const controlRoot of CODEX_PROJECTION_EXCLUDED_ROOTS_V2) {
      await expect(readdir(join(staging, controlRoot))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("refuses a manifest that claims a writable root without a sentinel authority", async () => {
    const { manifest } = await projectRootScope({ scope: "package.json", covers: "package.json" });
    expect(() => validateCodexProjectionManifestV2({ ...manifest, sentinels: [] })).toThrow(/M5B_SENTINEL_MANIFEST_INVALID/);
    expect(() => validateCodexProjectionManifestV2({ ...manifest, sentinels: manifest.sentinels.slice(1) })).toThrow(/M5B_SENTINEL_MANIFEST_INVALID/);
    expect(() => validateCodexProjectionManifestV2({ ...manifest, sentinelDigest: `sha256:${"0".repeat(64)}` })).toThrow(/M5B_SENTINEL_MANIFEST_INVALID/);
  });

  it("fails closed on every way a provider could disturb a sentinel", async () => {
    const cases: readonly (readonly [string, (staging: string, sentinel: string) => Promise<void>])[] = [
      ["deleted", async (staging, sentinel) => { await rm(join(staging, sentinel), { recursive: true, force: true }); }],
      ["renamed away", async (staging, sentinel) => {
        const { rename } = await import("node:fs/promises");
        await rename(join(staging, sentinel), join(staging, "stolen"));
      }],
      ["replaced by a file", async (staging, sentinel) => {
        await rm(join(staging, sentinel), { recursive: true, force: true });
        await writeFile(join(staging, sentinel), "not a sentinel\n");
      }],
      ["replaced by a symlink", async (staging, sentinel) => {
        await rm(join(staging, sentinel), { recursive: true, force: true });
        await symlink("/etc", join(staging, sentinel));
      }],
      ["given a child", async (staging, sentinel) => {
        const { chmod } = await import("node:fs/promises");
        await chmod(join(staging, sentinel), 0o700);
        await writeFile(join(staging, sentinel, "smuggled.txt"), "x\n");
      }],
      ["swapped for a same-named directory", async (staging, sentinel) => {
        const { chmod, rename } = await import("node:fs/promises");
        await rm(join(staging, sentinel), { recursive: true, force: true });
        await mkdir(join(staging, "replacement"), { recursive: true });
        await rename(join(staging, "replacement"), join(staging, sentinel));
        await chmod(join(staging, sentinel), CODEX_SENTINEL_MODE_V2);
      }],
    ];
    for (const [label, mutate] of cases) {
      const { staging, manifest, preimage } = await projectRootScope({ scope: "package.json", covers: "package.json" });
      const sentinel = manifest.sentinels[0]!.path;
      await mutate(staging, sentinel);
      const outcome = await verifyCodexRootSentinelsV2(staging, manifest, preimage).then(() => "RESOLVED", (error) => error);
      expect(outcome, label).toBeInstanceOf(RalphM5BError);
    }
  });

  it("passes the post-check when the provider only touched product paths", async () => {
    const { staging, manifest, preimage } = await projectRootScope({ scope: "package.json", covers: "package.json" });
    await writeFile(join(staging, "package.json"), '{"name":"rb-m5b-probe","private":true}\n', { mode: 0o644 });
    await expect(verifyCodexRootSentinelsV2(staging, manifest, preimage)).resolves.toBeUndefined();
    const state = await readCodexProjectionStateV2(staging, manifest.sentinels);
    // The sentinels are skipped, not published: they never reach a delta.
    expect(state.some((entry) => CODEX_PROJECTION_EXCLUDED_ROOTS_V2.includes(entry.path))).toBe(false);
    expect(state.some((entry) => entry.path === "package.json")).toBe(true);
  });

  it("refuses a state walk that finds a child inside a sentinel", async () => {
    const { chmod } = await import("node:fs/promises");
    const { staging, manifest } = await projectRootScope({ scope: "package.json", covers: "package.json" });
    const sentinel = manifest.sentinels[0]!.path;
    await chmod(join(staging, sentinel), 0o700);
    await writeFile(join(staging, sentinel, "smuggled.txt"), "x\n");
    await expect(readCodexProjectionStateV2(staging, manifest.sentinels)).rejects.toThrow(/M5B_SENTINEL_VIOLATED/);
  });
});

describe("Ralph M5-B — the host delta stays the final path authority under a writable root", () => {
  it("publishes only the exact root product the scope covers", async () => {
    const { staging, manifest } = await projectRootScope({ scope: "package.json", covers: "package.json" });
    await writeFile(join(staging, "package.json"), '{"name":"rb-m5b-probe","private":true}\n', { mode: 0o644 });
    const final = await readCodexProjectionStateV2(staging, manifest.sentinels);
    const entries = deriveCodexWorkspaceDeltaEntriesV2({
      stagingWorkspace: staging, baseline: manifest.entries, final, scope: "package.json", covers: "package.json",
    });
    expect(entries.map((entry) => `${entry.operation} ${entry.path}`)).toEqual(["CREATE package.json"]);
  });

  it("rejects the WHOLE delta when the provider also wrote an out-of-scope root file", async () => {
    const { staging, manifest } = await projectRootScope({ scope: "package.json", covers: "package.json" });
    await writeFile(join(staging, "package.json"), '{"name":"rb-m5b-probe","private":true}\n', { mode: 0o644 });
    await writeFile(join(staging, "extra.txt"), "not covered\n", { mode: 0o644 });
    const final = await readCodexProjectionStateV2(staging, manifest.sentinels);
    // Physical capability let the provider write it; publishable authority
    // does not. Nothing is published, not even the in-scope entry.
    expect(() => deriveCodexWorkspaceDeltaEntriesV2({
      stagingWorkspace: staging, baseline: manifest.entries, final, scope: "package.json", covers: "package.json",
    })).toThrow(/M5B_DELTA_OUT_OF_SCOPE/);
  });

  it("publishes exactly the declared multi-root product and nothing beside it", async () => {
    const { staging, manifest } = await projectRootScope({ scope: "go.mod go.sum", covers: "go.mod go.sum" });
    await writeFile(join(staging, "go.mod"), "module rb\n", { mode: 0o644 });
    await writeFile(join(staging, "go.sum"), "\n", { mode: 0o644 });
    const final = await readCodexProjectionStateV2(staging, manifest.sentinels);
    expect(deriveCodexWorkspaceDeltaEntriesV2({
      stagingWorkspace: staging, baseline: manifest.entries, final, scope: "go.mod go.sum", covers: "go.mod go.sum",
    }).map((entry) => entry.path)).toEqual(["go.mod", "go.sum"]);

    await writeFile(join(staging, "go.work"), "go 1.22\n", { mode: 0o644 });
    expect(() => deriveCodexWorkspaceDeltaEntriesV2({
      stagingWorkspace: staging,
      baseline: manifest.entries,
      final: [...final, { path: "go.work", kind: "file" as const, mode: 0o644, size: 9, contentHash: `sha256:${"1".repeat(64)}` }],
      scope: "go.mod go.sum",
      covers: "go.mod go.sum",
    })).toThrow(/M5B_DELTA_OUT_OF_SCOPE/);
  });

  it("lets a wildcard scope publish arbitrary product while the control plane stays impossible", async () => {
    const { staging, manifest } = await projectRootScope({ scope: "**", covers: "**" });
    await writeFile(join(staging, "package.json"), "{}\n", { mode: 0o644 });
    await mkdir(join(staging, "docs"), { recursive: true });
    await writeFile(join(staging, "docs", "guide.md"), "# guide\n", { mode: 0o644 });
    const final = await readCodexProjectionStateV2(staging, manifest.sentinels);
    expect(deriveCodexWorkspaceDeltaEntriesV2({
      stagingWorkspace: staging, baseline: manifest.entries, final, scope: "**", covers: "**",
    }).map((entry) => entry.path)).toEqual(["docs/guide.md", "package.json"]);

    // `**` covers a control-plane path logically, and it is STILL refused:
    // the forbidden-root check runs before ownership is even consulted.
    expect(scopeTokenCoversPath("**", ".rb-harness/state.json")).toBe(true);
    expect(() => deriveCodexWorkspaceDeltaEntriesV2({
      stagingWorkspace: staging,
      baseline: manifest.entries,
      final: [...final, { path: ".rb-harness/state.json", kind: "file" as const, mode: 0o644, size: 2, contentHash: `sha256:${"2".repeat(64)}` }],
      scope: "**",
      covers: "**",
    })).toThrow(/M5B_DELTA_PATH_FORBIDDEN/);
  });

  it("grants a root verifier physical capability without widening publishable authority", async () => {
    // `${RB_VERIFY_ROOT}` normalizes to the workspace root under the frozen
    // ownership rules, so it makes the staging root writable but covers no
    // concrete product path. Capability and authority are not the same thing,
    // and M5-B does not quietly merge them.
    const plan = deriveCodexWriteRootPlanV2({ scope: "${RB_VERIFY_ROOT}", covers: "${RB_VERIFY_ROOT}", directories: [] });
    expect(plan.stagingRootWritable).toBe(true);
    expect(scopeTokenCoversPath("${RB_VERIFY_ROOT}", "package.json")).toBe(false);

    const { staging, manifest } = await projectRootScope({ scope: "${RB_VERIFY_ROOT}", covers: "${RB_VERIFY_ROOT}" });
    await writeFile(join(staging, "package.json"), "{}\n", { mode: 0o644 });
    const final = await readCodexProjectionStateV2(staging, manifest.sentinels);
    expect(() => deriveCodexWorkspaceDeltaEntriesV2({
      stagingWorkspace: staging, baseline: manifest.entries, final, scope: "${RB_VERIFY_ROOT}", covers: "${RB_VERIFY_ROOT}",
    })).toThrow(/M5B_DELTA_OUT_OF_SCOPE/);
  });

  it("seals CREATE, MODIFY and DELETE of root product files", async () => {
    const { staging, manifest } = await projectRootScope({
      scope: "package.json README.md go.sum",
      covers: "package.json README.md go.sum",
      files: { "go.sum": "old\n" },
    });
    await writeFile(join(staging, "package.json"), '{"name":"rb-m5b-probe","private":true}\n', { mode: 0o644 });
    await writeFile(join(staging, "README.md"), "# rewritten\n", { mode: 0o644 });
    await rm(join(staging, "go.sum"), { force: true });
    const final = await readCodexProjectionStateV2(staging, manifest.sentinels);
    const delta = await createCodexWorkspaceDeltaV2({
      stagingWorkspace: staging,
      baseline: manifest.entries,
      final,
      scope: "package.json README.md go.sum",
      covers: "package.json README.md go.sum",
      ...BINDING,
      providerDescriptorDigest: `sha256:${"a".repeat(64)}`,
      threadBindingDigest: `sha256:${"b".repeat(64)}`,
      threadId: "thread-root",
      baseWorkspaceFingerprint: `sha256:${"c".repeat(64)}`,
      projectionManifestDigest: manifest.manifestDigest,
      projectionBaselineDigest: manifest.baselineDigest,
      providerResultDigest: `sha256:${"d".repeat(64)}`,
      createdAt: "2026-09-09T00:00:00.000Z",
    });
    expect(delta.entries.map((entry) => `${entry.operation} ${entry.path}`))
      .toEqual(["MODIFY README.md", "DELETE go.sum", "CREATE package.json"]);
    // No sentinel path is ever carried by a sealed delta.
    for (const entry of delta.entries) expect(CODEX_PROJECTION_EXCLUDED_ROOTS_V2).not.toContain(entry.path.split("/")[0]);
  });
});
