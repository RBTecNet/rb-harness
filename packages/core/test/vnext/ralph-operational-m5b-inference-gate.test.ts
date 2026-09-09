import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { sha256Canonical } from "../../src/vnext/ralph-runtime/hashing.js";
import {
  CODEX_CLI_CAPABILITY_RECORD_V2,
  assertCodexRealInferenceGateV2,
  assertCodexRuntimeCapabilityV2,
} from "../../src/vnext/ralph-runtime/operational-m5b/codex-capability.js";
import {
  assertCodexPhysicalCapabilityV2,
  probeCodexPhysicalCapabilityV2,
} from "../../src/vnext/ralph-runtime/operational-m5b/codex-credential-boundary.js";
import {
  CODEX_PARENT_PATH_V2,
  CODEX_SYSTEM_SANDBOX_BACKEND_PATH_V2,
  inspectCodexSandboxBackendV2,
} from "../../src/vnext/ralph-runtime/operational-m5b/codex-sandbox-backend.js";
import {
  buildCodexPermissionProfileV2,
  codexPermissionPolicyShapeDigestV2,
} from "../../src/vnext/ralph-runtime/operational-m5b/codex-permission-profile.js";
import { CODEX_CLI_NATIVE_EXECUTABLE_PATH_V2 } from "../../src/vnext/ralph-runtime/operational-m5b/contract.js";
import { assertCodexManagedRuntimeV2 } from "../../src/vnext/ralph-runtime/operational-m5b/codex-managed-runtime.js";
import { CODEX_ROOT_SENTINEL_ATTACKS_V2 } from "../../src/vnext/ralph-runtime/operational-m5b/codex-credential-boundary.js";
import { CODEX_PROJECTION_EXCLUDED_ROOTS_V2 } from "../../src/vnext/ralph-runtime/operational-m5b/codex-projection.js";
import { CODEX_REQUIRED_ROOT_PERMISSION_POLICY_SHAPE_V2 } from "../../src/vnext/ralph-runtime/operational-m5b/codex-permission-profile.js";
import { createCodexCliExecutorV2 } from "../../src/vnext/ralph-runtime/operational-m5b/codex-cli-executor.js";
import { admitM5BAttemptV2, bootstrapM5BRunV2 } from "./fixtures/ralph-m5b-fixture.js";

const STOCK_AVAILABLE = existsSync(CODEX_CLI_NATIVE_EXECUTABLE_PATH_V2) && existsSync(CODEX_SYSTEM_SANDBOX_BACKEND_PATH_V2);

/**
 * The credential-file boundary gate with NOTHING mocked.
 *
 * M5-B.1 proved that stock `codex exec` 0.153.4 honours a named
 * `default_permissions` profile with no legacy `--sandbox` flag, and that
 * such a profile keeps the staging product root writable while physically
 * denying `<CODEX_HOME>/auth.json`.  This suite asserts the shipped gate
 * against the real binary: the boundary is measured here, never declared.
 */
describe("Ralph M5-B — real-inference gate", () => {
  it("declares a denied credential boundary with every capability proven", () => {
    expect(CODEX_CLI_CAPABILITY_RECORD_V2.credentialFileSandboxBoundary).toBe("DENIED");
    expect(CODEX_CLI_CAPABILITY_RECORD_V2.legacySandboxMode).toBe("NONE");
    expect(() => assertCodexRealInferenceGateV2()).not.toThrow();
  });

  it("refuses to authorize a dispatch when any capability regresses", () => {
    for (const field of [
      "stagingWriteCapability",
      "controlPlaneDenialCapability",
      "networkDenialCapability",
      "shellEnvironmentIsolationCapability",
      "rootProductWriteCapability",
      "rootSentinelDenialCapability",
    ] as const) {
      const weakened = { ...CODEX_CLI_CAPABILITY_RECORD_V2, [field]: "UNPROVEN" as const };
      const sealed = { ...weakened, recordDigest: sha256Canonical(Object.fromEntries(Object.entries(weakened).filter(([key]) => key !== "recordDigest"))) };
      expect(() => assertCodexRealInferenceGateV2(sealed as never)).toThrow(/M5B_CREDENTIAL_FILE_BOUNDARY_UNSAFE/);
    }
  });

  it.runIf(STOCK_AVAILABLE)("physically denies the credential file while allowing a product write", async () => {
    const report = await probeCodexPhysicalCapabilityV2({ deadlineMs: 120_000 });
    // Open/close only — no byte of the credential file is ever read.
    expect(report.credentialFileBoundary).toBe("DENIED");
    expect(report.stagingWriteCapability).toBe("PROVEN");
    expect(report.controlPlaneDenialCapability).toBe("PROVEN");
    expect(report.networkDenialCapability).toBe("PROVEN");
    expect(report.shellEnvironmentIsolationCapability).toBe("PROVEN");
    // The root-scope half of the same probe: a writable staging root with
    // every control-plane sentinel physically denied.
    expect(report.rootProductWriteCapability).toBe("PROVEN");
    expect(report.rootSentinelDenialCapability).toBe("PROVEN");
    // The mixed outcome is the whole point: a legacy read-only sandbox could
    // not have written, and legacy workspace-write could have opened auth.
    expect(() => assertCodexPhysicalCapabilityV2(report)).not.toThrow();

    const backend = await inspectCodexSandboxBackendV2();
    const managedRuntime = await assertCodexManagedRuntimeV2({ probeTimeoutMs: 120_000 });
    const profile = buildCodexPermissionProfileV2({
      stagingWorkspace: "/tmp/rb-ralph-m5b-gate",
      writableRoots: ["src"],
      codexHome: "/home/fixture/.codex",
      codexRuntimeReadRoot: "/opt/codex-runtime",
    });
    expect(() => assertCodexRuntimeCapabilityV2({
      record: CODEX_CLI_CAPABILITY_RECORD_V2,
      probe: report,
      backend,
      permissionProfile: profile,
      managedRuntime,
    })).not.toThrow();
    expect(() => assertCodexRuntimeCapabilityV2({
      record: CODEX_CLI_CAPABILITY_RECORD_V2,
      probe: report,
      backend: { ...backend, backendPath: "/opt/bundled/bwrap" },
      permissionProfile: profile,
      managedRuntime,
    })).toThrow(/M5B_SANDBOX_BACKEND_INVALID/);
    // A global or otherwise substituted Codex can never satisfy the record.
    expect(() => assertCodexRuntimeCapabilityV2({
      record: CODEX_CLI_CAPABILITY_RECORD_V2,
      probe: report,
      backend,
      permissionProfile: profile,
      managedRuntime: { ...managedRuntime, executablePath: "/usr/local/bin/codex", identityDigest: `sha256:${"a".repeat(64)}` },
    })).toThrow(/M5B_MANAGED_RUNTIME_INVALID/);
    expect(() => assertCodexRuntimeCapabilityV2({
      record: CODEX_CLI_CAPABILITY_RECORD_V2,
      probe: { ...report, credentialFileBoundary: "PROVIDER_READABLE" as const },
      backend,
      permissionProfile: profile,
      managedRuntime,
    })).toThrow(/M5B_CREDENTIAL_FILE_BOUNDARY_UNSAFE/);
    // The probe only stands as evidence for the dispatch while it exercised
    // the SAME policy shape; a foreign shape must never be waved through.
    expect(() => assertCodexRuntimeCapabilityV2({
      record: CODEX_CLI_CAPABILITY_RECORD_V2,
      probe: { ...report, permissionPolicyShapeDigest: `sha256:${"e".repeat(64)}` },
      backend,
      permissionProfile: profile,
      managedRuntime,
    })).toThrow(/M5B_PERMISSION_PROFILE_INVALID/);
    expect(() => assertCodexPhysicalCapabilityV2({ ...report, permissionPolicyShapeDigest: `sha256:${"e".repeat(64)}` }, profile))
      .toThrow(/M5B_PERMISSION_PROFILE_INVALID/);
  }, 300_000);

  it("treats a multi-root WorkUnit as the same policy shape", () => {
    // Two owned product directories mean two PRODUCT_WRITE entries but the
    // same policy shape; the capability record must accept both.
    const single = buildCodexPermissionProfileV2({
      stagingWorkspace: "/tmp/rb-ralph-m5b-gate",
      writableRoots: ["src"],
      codexHome: "/home/fixture/.codex",
      codexRuntimeReadRoot: "/opt/codex-runtime",
    });
    const multi = buildCodexPermissionProfileV2({
      stagingWorkspace: "/tmp/rb-ralph-m5b-gate",
      writableRoots: ["src", "lib"],
      codexHome: "/home/fixture/.codex",
      codexRuntimeReadRoot: "/opt/codex-runtime",
    });
    expect(multi.filesystem.filter((entry) => entry.role === "PRODUCT_WRITE")).toHaveLength(2);
    expect(codexPermissionPolicyShapeDigestV2(multi)).toBe(codexPermissionPolicyShapeDigestV2(single));
    expect(codexPermissionPolicyShapeDigestV2(multi)).toBe(CODEX_CLI_CAPABILITY_RECORD_V2.permissionPolicyShapeDigest);
  });

  it.runIf(STOCK_AVAILABLE)("constructs a real Executor only after the live gates pass", async () => {
    const fixture = await bootstrapM5BRunV2();
    try {
      const { admitted } = await admitM5BAttemptV2(fixture);
      const executor = await createCodexCliExecutorV2({
        store: fixture.store,
        authorizedInvocation: admitted.authorizedInvocation,
        timeoutPolicy: fixture.timeoutPolicy,
        stagingBase: fixture.stagingBase,
      });
      // Constructing it spawns no model-bearing call: the binary identity,
      // the sandbox backend and the capability probe are all non-model.
      expect(executor.runtimeIdentity).toBe("codex-cli-runtime-v2");
    } finally {
      await rm(fixture.projectRoot, { recursive: true, force: true });
      await rm(fixture.stagingBase, { recursive: true, force: true });
    }
  }, 300_000);

  it("fails closed before dispatch when the parent PATH cannot reach the system bwrap", async () => {
    // This is the exact M5-B.1 environmental failure: without a PATH that
    // finds /usr/bin/bwrap, Codex selects its bundled copy, AppArmor denies
    // it CAP_NET_ADMIN, and every provider command dies before running.
    await expect(inspectCodexSandboxBackendV2("/nonexistent-bin")).rejects.toThrow(/M5B_SANDBOX_BACKEND_INVALID/);
    expect(CODEX_PARENT_PATH_V2).toBe("/usr/bin:/bin");
  });

  it("exposes no capability-record override seam on the Executor input", () => {
    const input: Parameters<typeof createCodexCliExecutorV2>[0] = {} as never;
    expect(Object.keys(input)).not.toContain("capabilityRecord");
    expect(String(createCodexCliExecutorV2)).not.toContain("capabilityRecord");
  });
});

/**
 * The ROOT-SCOPE physical security matrix, measured against the real binary
 * with NO model involved.
 *
 * A writable staging root is only safe if the control-plane names inside it
 * are physically unreachable.  That claim is not argued here — it is
 * exercised: every create, nest, delete, rename-away, replace-with-file,
 * symlink-over, rename-onto and copy-into is attempted against every sentinel
 * under the exact profile a root WorkUnit will dispatch with, and each denial
 * is paired with a positive control proving the same tool works on a product
 * path.
 */
describe.runIf(STOCK_AVAILABLE)("Ralph M5-B — root-scope physical security matrix", () => {
  it("proves root product writes and denies every sentinel attack", async () => {
    const report = await probeCodexPhysicalCapabilityV2({ deadlineMs: 300_000 });
    console.log(JSON.stringify({
      stage: "root-capability-matrix",
      rootProductWriteCapability: report.rootProductWriteCapability,
      rootSentinelDenialCapability: report.rootSentinelDenialCapability,
      rootSentinelCount: report.rootSentinelCount,
      rootAttackCount: report.rootAttackCount,
      rootMatrixDigest: report.rootMatrixDigest,
      rootPermissionPolicyShapeDigest: report.rootPermissionPolicyShapeDigest,
      rootProbeExitCode: report.rootProbeExitCode,
    }));
    expect(report.rootProductWriteCapability).toBe("PROVEN");
    expect(report.rootSentinelDenialCapability).toBe("PROVEN");
    // Three control-plane roots times eight attacks: nothing may be skipped.
    expect(report.rootSentinelCount).toBe(CODEX_PROJECTION_EXCLUDED_ROOTS_V2.length);
    expect(report.rootAttackCount).toBe(CODEX_PROJECTION_EXCLUDED_ROOTS_V2.length * CODEX_ROOT_SENTINEL_ATTACKS_V2.length);
    expect(CODEX_ROOT_SENTINEL_ATTACKS_V2).toEqual([
      "CREATE", "NESTED", "DELETE", "RENAME_AWAY", "REPLACE_FILE", "SYMLINK", "RENAME_ONTO", "COPY_INTO",
    ]);
    // The root half of the probe exercised the ROOT policy shape, which is
    // distinct from the non-root one it also measured.
    expect(report.rootPermissionPolicyShapeDigest).toBe(CODEX_REQUIRED_ROOT_PERMISSION_POLICY_SHAPE_V2);
    expect(report.permissionPolicyShapeDigest).not.toBe(report.rootPermissionPolicyShapeDigest);
  }, 600_000);

  it("refuses to substitute a non-root probe shape for a root dispatch", async () => {
    const report = await probeCodexPhysicalCapabilityV2({ deadlineMs: 300_000 });
    const rootProfile = buildCodexPermissionProfileV2({
      stagingWorkspace: "/tmp/rb-ralph-m5b-root-gate",
      stagingRootWritable: true,
      writableRoots: [],
      sentinelRoots: [...CODEX_PROJECTION_EXCLUDED_ROOTS_V2],
      codexHome: "/home/fixture/.codex",
      codexRuntimeReadRoot: "/opt/codex-runtime",
    });
    expect(() => assertCodexPhysicalCapabilityV2(report, rootProfile)).not.toThrow();
    expect(() => assertCodexPhysicalCapabilityV2({ ...report, rootPermissionPolicyShapeDigest: `sha256:${"e".repeat(64)}` }, rootProfile))
      .toThrow(/M5B_PERMISSION_PROFILE_INVALID/);
  }, 600_000);

  it("executes only the Harness-managed runtime, whatever PATH offers", async () => {
    const managed = await assertCodexManagedRuntimeV2({ probeTimeoutMs: 120_000 });
    expect(managed.executablePath).toBe(CODEX_CLI_NATIVE_EXECUTABLE_PATH_V2);
    expect(managed.version).toBe("0.153.4-rb.1");
    expect(managed.reportedIdentity).toBe("codex-cli 0.153.4");
    expect(managed.identityDigest).toBe(CODEX_CLI_CAPABILITY_RECORD_V2.managedRuntimeIdentityDigest);
    // The managed install is a distinct physical tree from any global one.
    expect(managed.executablePath).toContain("/.local/libexec/rb-harness/codex-cli/0.153.4-rb.1/");
    expect(managed.executablePath).not.toContain("/.nvm/");
    expect(managed.executablePath).not.toContain("/usr/local/bin");
  }, 180_000);
});
