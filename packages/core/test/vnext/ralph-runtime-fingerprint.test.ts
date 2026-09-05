import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { fingerprintWorkspace, nodeWorkspaceFingerprintFileSystem } from "../../src/vnext/ralph-runtime/index.js";

describe("Ralph workspace fingerprint V1", () => {
  it("separates .rb control-plane changes and prunes excluded trees with sentinels", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-fingerprint-"));
    try {
      await mkdir(resolve(root, ".rb"), { recursive: true });
      await mkdir(resolve(root, ".git"), { recursive: true });
      await mkdir(resolve(root, ".rb-harness", "ralph"), { recursive: true });
      await mkdir(resolve(root, "node_modules", "pkg"), { recursive: true });
      await mkdir(resolve(root, "dist"), { recursive: true });
      await writeFile(resolve(root, ".rb", "PHASES.md"), "phase-v1\n");
      await writeFile(resolve(root, "src.txt"), "source\n");
      await writeFile(resolve(root, "node_modules", "internal.txt"), "ignored dependency\n");
      await writeFile(resolve(root, "node_modules", "pkg", "needed.txt"), "scoped dependency\n");
      await writeFile(resolve(root, "dist", "tracked.js"), "tracked output\n");
      await writeFile(resolve(root, "dist", "generated.js"), "untracked output\n");
      await writeFile(resolve(root, ".rb-harness", "ralph", "event.json"), "runtime\n");
      await symlink("src.txt", resolve(root, "source-link"));

      const policy = { scopePaths: ["node_modules/pkg/needed.txt"], trackedPaths: ["dist/tracked.js"] };
      const first = await fingerprintWorkspace(root, policy);
      expect(first.controlPlaneEntries.some((entry) => entry.path === ".rb/PHASES.md")).toBe(true);
      expect(first.productWorkspaceEntries.some((entry) => entry.path.startsWith(".rb/"))).toBe(false);
      expect(first.productWorkspaceEntries.some((entry) => entry.path === "node_modules/pkg/needed.txt")).toBe(true);
      expect(first.productWorkspaceEntries.some((entry) => entry.path === "dist/tracked.js")).toBe(true);
      expect(first.productWorkspaceEntries.some((entry) => entry.path === "dist/generated.js")).toBe(false);
      expect(first.productWorkspaceEntries.some((entry) => entry.path === "source-link" && entry.kind === "symlink")).toBe(true);
      expect(first.excludedRoots.some((entry) => entry.path === "node_modules")).toBe(true);
      expect(first.excludedRoots.some((entry) => entry.path === ".git")).toBe(false);
      expect(first.excludedRoots.some((entry) => entry.path === ".rb-harness/ralph")).toBe(false);

      const beforeInternalChange = first.productWorkspaceFingerprint;
      await writeFile(resolve(root, "node_modules", "internal.txt"), "changed dependency\n");
      const afterInternalChange = await fingerprintWorkspace(root, policy);
      expect(afterInternalChange.productWorkspaceFingerprint).toBe(beforeInternalChange);

      await writeFile(resolve(root, "node_modules", "pkg", "needed.txt"), "changed scoped dependency\n");
      const afterScopedChange = await fingerprintWorkspace(root, policy);
      expect(afterScopedChange.productWorkspaceFingerprint).not.toBe(beforeInternalChange);

      const beforeRuntimeWrite = afterScopedChange.productWorkspaceFingerprint;
      await writeFile(resolve(root, ".rb-harness", "ralph", "another-event.json"), "runtime 2\n");
      expect((await fingerprintWorkspace(root, policy)).productWorkspaceFingerprint).toBe(beforeRuntimeWrite);

      await writeFile(resolve(root, ".rb", "PHASES.md"), "phase-v2\n");
      expect((await fingerprintWorkspace(root, policy)).controlPlaneFingerprint).not.toBe(first.controlPlaneFingerprint);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("works without Git, includes untracked non-ignored paths, and makes policy changes visible", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-fingerprint-nogit-"));
    try {
      await mkdir(resolve(root, "ignored"), { recursive: true });
      await writeFile(resolve(root, "plain.txt"), "plain\n");
      await writeFile(resolve(root, "ignored", "generated.txt"), "ignored\n");
      const first = await fingerprintWorkspace(root, { ignoredPaths: ["ignored"] });
      expect(first.productWorkspaceEntries.some((entry) => entry.path === "plain.txt")).toBe(true);
      expect(first.productWorkspaceEntries.some((entry) => entry.path.startsWith("ignored/") || entry.path === "ignored")).toBe(false);
      const second = await fingerprintWorkspace(root, { ignoredPaths: ["ignored"], additionalExcludes: ["plain.txt"] });
      expect(second.policyDigest).not.toBe(first.policyDigest);
      expect(second.productWorkspaceFingerprint).not.toBe(first.productWorkspaceFingerprint);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects attempts to exclude the control plane or structural runtime paths", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-fingerprint-policy-"));
    try {
      await expect(fingerprintWorkspace(root, { additionalExcludes: [".rb"] })).rejects.toThrow("RALPH_WORKSPACE_POLICY_FORBIDDEN_EXCLUDE");
      await expect(fingerprintWorkspace(root, { additionalExcludes: [".git"] })).rejects.toThrow("RALPH_WORKSPACE_POLICY_FORBIDDEN_EXCLUDE");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records default-excluded root sentinels without traversing descendants", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-fingerprint-sentinel-"));
    try {
      const first = await fingerprintWorkspace(root);
      await mkdir(resolve(root, "node_modules", "pkg"), { recursive: true });
      await writeFile(resolve(root, "node_modules", "pkg", "internal.js"), "internal\n");
      const reads: string[] = [];
      const instrumented = {
        ...nodeWorkspaceFingerprintFileSystem,
        readdir: async (path: string) => { reads.push(path); return nodeWorkspaceFingerprintFileSystem.readdir(path); },
      };
      const present = await fingerprintWorkspace(root, {}, undefined, instrumented);
      expect(present.excludedRoots).toContainEqual(expect.objectContaining({ path: "node_modules", exists: true }));
      expect(present.productWorkspaceFingerprint).not.toBe(first.productWorkspaceFingerprint);
      expect(reads.some((path) => path.includes("node_modules"))).toBe(false);

      await chmod(resolve(root, "node_modules"), 0o755 ^ 0o111);
      const modeChanged = await fingerprintWorkspace(root);
      expect(modeChanged.productWorkspaceFingerprint).not.toBe(present.productWorkspaceFingerprint);
      await chmod(resolve(root, "node_modules"), 0o755);
      await rm(resolve(root, "node_modules"), { recursive: true, force: true });
      const absent = await fingerprintWorkspace(root);
      expect(absent.excludedRoots.some((entry) => entry.path === "node_modules")).toBe(false);
      expect(absent.productWorkspaceFingerprint).toBe(first.productWorkspaceFingerprint);
      await writeFile(resolve(root, "node_modules"), "dependency-file\n");
      const typeChanged = await fingerprintWorkspace(root);
      expect(typeChanged.productWorkspaceFingerprint).not.toBe(absent.productWorkspaceFingerprint);
      expect(typeChanged.excludedRoots).toContainEqual(expect.objectContaining({ path: "node_modules", kind: "file" }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("traverses only the branch required by a Scope/Covers glob under an excluded root", async () => {
    const root = await mkdtemp(resolve(process.env.TMPDIR ?? "/tmp", "rb-ralph-fingerprint-scope-"));
    try {
      await mkdir(resolve(root, "node_modules", "pkg", "nested"), { recursive: true });
      await mkdir(resolve(root, "node_modules", "other"), { recursive: true });
      await writeFile(resolve(root, "node_modules", "pkg", "nested", "needed.ts"), "needed\n");
      await writeFile(resolve(root, "node_modules", "other", "ignored.ts"), "ignored\n");
      const reads: string[] = [];
      const instrumented = {
        ...nodeWorkspaceFingerprintFileSystem,
        readdir: async (path: string) => { reads.push(path); return nodeWorkspaceFingerprintFileSystem.readdir(path); },
      };
      const result = await fingerprintWorkspace(root, { scopePaths: ["node_modules/pkg/**/*.ts"] }, undefined, instrumented);
      expect(result.productWorkspaceEntries.some((entry) => entry.path.endsWith("needed.ts"))).toBe(true);
      expect(result.productWorkspaceEntries.some((entry) => entry.path.endsWith("ignored.ts"))).toBe(false);
      expect(reads.some((path) => path.endsWith("node_modules/other"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
