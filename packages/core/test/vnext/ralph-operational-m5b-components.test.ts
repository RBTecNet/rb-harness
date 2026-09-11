import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256, sha256Canonical } from "../../src/vnext/ralph-runtime/hashing.js";
import { createWorkspacePolicy, fingerprintWorkspace } from "../../src/vnext/ralph-runtime/fingerprint.js";
import {
  CODEX_CLI_EXECUTOR_CLI_VERSION_V2,
  CODEX_CLI_EXECUTOR_PROFILE_V2,
  CODEX_CLI_EXECUTOR_REASONING_EFFORT_V2,
  CODEX_CLI_EXECUTOR_REQUESTED_MODEL_V2,
  CODEX_CLI_NATIVE_EXECUTABLE_PATH_V2,
  CODEX_CLI_NATIVE_EXECUTABLE_SHA256_V2,
  CODEX_CLI_NATIVE_EXECUTABLE_SIZE_BYTES_V2,
  RalphM5BError,
  createM5BTimeoutPolicyV2,
  validateM5BTimeoutPolicyV2,
} from "../../src/vnext/ralph-runtime/operational-m5b/contract.js";
import {
  CODEX_FORBIDDEN_ENVIRONMENT_KEYS_V2,
  CODEX_STOCK_EXECUTABLE_PIN_V2,
  assertCodexArgvPolicyV2,
  buildCodexExecArgvV2,
  codexParentEnvironmentV2,
  codexShellEnvironmentPolicyOverridesV2,
  codexShellEnvironmentPolicyV2,
  inspectExactCodexCliExecutableV2,
} from "../../src/vnext/ralph-runtime/operational-m5b/codex-process.js";
import {
  CODEX_PERMISSION_PROFILE_NAME_V2,
  assertCodexPermissionProfileV2,
  buildCodexPermissionProfileV2,
  codexPermissionPolicyShapeDigestV2,
  codexPermissionProfileOverridesV2,
} from "../../src/vnext/ralph-runtime/operational-m5b/codex-permission-profile.js";
import { deriveCodexWriteRootPlanV2 } from "../../src/vnext/ralph-runtime/operational-m5b/codex-write-roots.js";
import {
  CODEX_PARENT_PATH_V2,
  CODEX_SYSTEM_SANDBOX_BACKEND_PATH_V2,
  inspectCodexSandboxBackendV2,
  resolveSandboxBackendOnPathV2,
} from "../../src/vnext/ralph-runtime/operational-m5b/codex-sandbox-backend.js";
import { parseExactCodexEventStreamV2 } from "../../src/vnext/ralph-runtime/operational-m5b/codex-jsonl.js";
import {
  assertFinalAgentMessageMatchesOutputV2,
  codexProviderOutputSchemaJsonV2,
  validateExactCodexProviderOutputV2,
} from "../../src/vnext/ralph-runtime/operational-m5b/codex-output-schema.js";
import {
  CODEX_PROJECTION_EXCLUDED_ROOTS_V2,
  buildCodexProviderProjectionV2,
  codexStagingWorkspacePathV2,
  readCodexProjectionStateV2,
  validateCodexProjectionManifestV2,
} from "../../src/vnext/ralph-runtime/operational-m5b/codex-projection.js";
import {
  createCodexWorkspaceDeltaV2,
  deriveCodexWorkspaceDeltaEntriesV2,
  validateCodexWorkspaceDeltaV2,
} from "../../src/vnext/ralph-runtime/operational-m5b/codex-delta.js";
import {
  CODEX_CLI_CAPABILITY_RECORD_V2,
  assertCodexRealInferenceGateV2,
  validateCodexCliCapabilityRecordV2,
} from "../../src/vnext/ralph-runtime/operational-m5b/codex-capability.js";
import {
  publishCodexWorkspaceDeltaV2,
  readCodexPublicationIntentV2,
  readCodexPublicationReceiptV2,
} from "../../src/vnext/ralph-runtime/operational-m5b/codex-publication.js";
import { persistCodexWorkspaceDeltaV2 } from "../../src/vnext/ralph-runtime/operational-m5b/codex-artifacts.js";
import { bootstrapM5BRunV2 } from "./fixtures/ralph-m5b-fixture.js";

const BINDING = { runId: "run-m5b-components", phaseId: "P01", taskId: "T001", attemptId: "attempt-m5b-components", invocationId: "inv-m5b-components" };
const STOCK_AVAILABLE = existsSync(CODEX_CLI_NATIVE_EXECUTABLE_PATH_V2);

async function disposableProject(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "rb-ralph-m5b-unit-"));
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    await mkdir(resolve(absolute, ".."), { recursive: true });
    await writeFile(absolute, content);
  }
  return root;
}

function threadStarted(threadId = "thr_m5bComponents0001"): string {
  return JSON.stringify({ type: "thread.started", thread_id: threadId });
}

function agentMessage(text: string): string {
  return JSON.stringify({ type: "item.completed", item: { id: "item_1", item_type: "agent_message", text } });
}

describe("Ralph M5-B — stock Codex CLI executable identity", () => {
  it("pins an absolute native binary rather than a launcher or a bare name", () => {
    expect(CODEX_CLI_NATIVE_EXECUTABLE_PATH_V2.startsWith("/")).toBe(true);
    expect(CODEX_CLI_NATIVE_EXECUTABLE_PATH_V2.endsWith(".js")).toBe(false);
    expect(CODEX_CLI_NATIVE_EXECUTABLE_PATH_V2).not.toBe("/usr/local/bin/codex");
    expect(CODEX_CLI_NATIVE_EXECUTABLE_PATH_V2).not.toBe("codex");
    expect(CODEX_CLI_NATIVE_EXECUTABLE_SIZE_BYTES_V2).toBe(258_659_424);
    expect(CODEX_CLI_NATIVE_EXECUTABLE_SHA256_V2).toBe("sha256:56ef98ab4032d317ab26e9b5e5a175650717351edb16ed9cde0cb6d1734d62da");
    expect(CODEX_CLI_EXECUTOR_CLI_VERSION_V2).toBe("0.153.4");
  });

  it("refuses a non-native path, a relative path and a missing binary", async () => {
    await expect(inspectExactCodexCliExecutableV2(30_000, { ...CODEX_STOCK_EXECUTABLE_PIN_V2, executablePath: "codex" })).rejects.toBeInstanceOf(RalphM5BError);
    await expect(inspectExactCodexCliExecutableV2(30_000, { ...CODEX_STOCK_EXECUTABLE_PIN_V2, executablePath: "/usr/local/lib/node_modules/@openai/codex/bin/codex.js" })).rejects.toBeInstanceOf(RalphM5BError);
    await expect(inspectExactCodexCliExecutableV2(30_000, { ...CODEX_STOCK_EXECUTABLE_PIN_V2, executablePath: "/nonexistent/rb-m5b/codex" })).rejects.toBeInstanceOf(RalphM5BError);
  });

  it("refuses a drifted size or digest for a real file", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rb-ralph-m5b-binary-"));
    try {
      const fake = join(root, "codex");
      await writeFile(fake, "not the stock native binary");
      await chmod(fake, 0o755);
      await expect(inspectExactCodexCliExecutableV2(30_000, { ...CODEX_STOCK_EXECUTABLE_PIN_V2, executablePath: fake })).rejects.toBeInstanceOf(RalphM5BError);
      const bytes = await readFile(fake);
      await expect(inspectExactCodexCliExecutableV2(30_000, {
        executablePath: fake,
        executableVersion: CODEX_CLI_EXECUTOR_CLI_VERSION_V2,
        executableSizeBytes: bytes.byteLength,
        executableSha256: `sha256:${"0".repeat(64)}`,
      })).rejects.toBeInstanceOf(RalphM5BError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.runIf(STOCK_AVAILABLE)("accepts the pinned stock binary and refuses a mutated pin", async () => {
    const identity = await inspectExactCodexCliExecutableV2(60_000);
    expect(identity).toMatchObject({
      executablePath: CODEX_CLI_NATIVE_EXECUTABLE_PATH_V2,
      executableVersion: CODEX_CLI_EXECUTOR_CLI_VERSION_V2,
      executableSha256: CODEX_CLI_NATIVE_EXECUTABLE_SHA256_V2,
    });
    await expect(inspectExactCodexCliExecutableV2(60_000, { ...CODEX_STOCK_EXECUTABLE_PIN_V2, executableSha256: `sha256:${"1".repeat(64)}` })).rejects.toBeInstanceOf(RalphM5BError);
    await expect(inspectExactCodexCliExecutableV2(60_000, { ...CODEX_STOCK_EXECUTABLE_PIN_V2, executableSizeBytes: 1 })).rejects.toBeInstanceOf(RalphM5BError);
    await expect(inspectExactCodexCliExecutableV2(60_000, { ...CODEX_STOCK_EXECUTABLE_PIN_V2, executableVersion: "0.153.2" })).rejects.toBeInstanceOf(RalphM5BError);
  }, 120_000);
});

const PROBE_PROFILE = buildCodexPermissionProfileV2({
  stagingWorkspace: "/tmp/rb-ralph-m5b-staging",
  writableRoots: ["src"],
  codexHome: "/home/fixture/.codex",
  codexRuntimeReadRoot: "/opt/codex-runtime",
});

describe("Ralph M5-B — the typed permission profile is the physical boundary", () => {
  it("denies the root, denies CODEX_HOME and keeps only the product root writable", () => {
    const roles = Object.fromEntries(PROBE_PROFILE.filesystem.map((entry) => [entry.role, entry]));
    expect(roles.ROOT).toMatchObject({ path: ":root", access: "deny" });
    expect(roles.MINIMAL).toMatchObject({ path: ":minimal", access: "read" });
    expect(roles.STAGING).toMatchObject({ path: "/tmp/rb-ralph-m5b-staging", access: "read" });
    expect(roles.PRODUCT_WRITE).toMatchObject({ path: "/tmp/rb-ralph-m5b-staging/src", access: "write" });
    expect(roles.CODEX_HOME).toMatchObject({ path: "/home/fixture/.codex", access: "deny" });
    expect(PROBE_PROFILE.networkEnabled).toBe(false);
    // The staging root is never writable: that is what makes a control-plane
    // write inside the projection physically impossible.
    expect(PROBE_PROFILE.filesystem.filter((entry) => entry.access === "write").map((entry) => entry.path)).toEqual(["/tmp/rb-ralph-m5b-staging/src"]);
  });

  it("refuses an unknown profile field locally, without asking Codex", () => {
    // M5-B.1 proved stock `--strict-config` silently accepts unknown fields
    // inside a permission profile, so strictness is never delegated.
    expect(() => assertCodexPermissionProfileV2({ ...PROBE_PROFILE, bogusUnknownField: true })).toThrow(/M5B_PERMISSION_PROFILE_INVALID: unknown fields bogusUnknownField/);
    expect(() => assertCodexPermissionProfileV2({
      ...PROBE_PROFILE,
      filesystem: [...PROBE_PROFILE.filesystem, { role: "STAGING", path: "/tmp/x", access: "read", missing_path_behaviour: "ignore" }],
    })).toThrow(/M5B_PERMISSION_PROFILE_INVALID: unknown entry fields/);
    expect(() => assertCodexPermissionProfileV2({
      ...PROBE_PROFILE,
      filesystem: PROBE_PROFILE.filesystem.map((entry) => (entry.role === "STAGING" ? { ...entry, access: "reed" } : entry)),
    })).toThrow(/M5B_PERMISSION_PROFILE_INVALID/);
  });

  it("refuses a widened root policy, a lost CODEX_HOME denial and a writable staging root", () => {
    expect(() => assertCodexPermissionProfileV2({
      ...PROBE_PROFILE,
      filesystem: PROBE_PROFILE.filesystem.map((entry) => (entry.role === "ROOT" ? { ...entry, access: "read" } : entry)),
    })).toThrow(/M5B_PERMISSION_PROFILE_INVALID/);
    expect(() => assertCodexPermissionProfileV2({
      ...PROBE_PROFILE,
      filesystem: PROBE_PROFILE.filesystem.filter((entry) => entry.role !== "CODEX_HOME"),
    })).toThrow(/M5B_PERMISSION_PROFILE_INVALID: missing CODEX_HOME entry/);
    expect(() => assertCodexPermissionProfileV2({
      ...PROBE_PROFILE,
      filesystem: PROBE_PROFILE.filesystem.filter((entry) => entry.role !== "PRODUCT_WRITE"),
    })).toThrow(/M5B_PERMISSION_PROFILE_INVALID: no product write root/);
    expect(() => assertCodexPermissionProfileV2({ ...PROBE_PROFILE, networkEnabled: true })).toThrow(/M5B_PERMISSION_PROFILE_INVALID: network must be disabled/);
    expect(() => assertCodexPermissionProfileV2({ ...PROBE_PROFILE, profileDigest: `sha256:${"0".repeat(64)}` })).toThrow(/M5B_PERMISSION_PROFILE_INVALID: digest mismatch/);
  });

  it("never grants a control-plane name or a smuggled staging root as a product write root", () => {
    for (const writableRoots of [["."], [""], [".rb-harness"], [".rb/nested"], [".git"]]) {
      expect(() => buildCodexPermissionProfileV2({
        stagingWorkspace: "/tmp/rb-ralph-m5b-staging",
        writableRoots,
        codexHome: "/home/fixture/.codex",
        codexRuntimeReadRoot: "/opt/codex-runtime",
      })).toThrow(/M5B_PERMISSION_PROFILE_INVALID|M5B_PROJECTION_PATH_UNSAFE/);
    }
  });

  it("derives product write roots from declared ownership only", () => {
    expect(deriveCodexWriteRootPlanV2({ scope: "src/status.js", covers: "src/status.js", directories: ["src"] }).productRoots).toEqual(["src"]);
    expect(deriveCodexWriteRootPlanV2({ scope: "src", covers: "src/deep/a.ts", directories: ["src", "src/deep"] }).productRoots).toEqual(["src"]);
    expect(deriveCodexWriteRootPlanV2({ scope: "packages/core/src/**", covers: "packages/core/src/a.ts", directories: [] }).productRoots).toEqual(["packages/core/src"]);
    for (const plan of [
      deriveCodexWriteRootPlanV2({ scope: "src/status.js", covers: "src/status.js", directories: ["src"] }),
      deriveCodexWriteRootPlanV2({ scope: "packages/core/src/**", covers: "packages/core/src/a.ts", directories: [] }),
    ]) {
      // A non-root plan keeps the staging root read-only, which is what makes
      // the control-plane names unreachable structurally.
      expect(plan.stagingRootWritable).toBe(false);
      expect(plan.sentinelRoots).toEqual([]);
    }
    // A control-plane path is never an owned write root, root scope or not.
    expect(() => deriveCodexWriteRootPlanV2({ scope: ".rb-harness/x.json", covers: ".rb-harness/x.json", directories: [".rb-harness"] })).toThrow(/M5B_PERMISSION_PROFILE_INVALID/);
  });

  it("shares one policy shape across workspaces so the probe can stand for the dispatch", () => {
    const other = buildCodexPermissionProfileV2({
      stagingWorkspace: "/tmp/rb-ralph-m5b-other",
      writableRoots: ["src"],
      codexHome: "/home/fixture/.codex",
      codexRuntimeReadRoot: "/opt/codex-runtime",
    });
    expect(other.profileDigest).not.toBe(PROBE_PROFILE.profileDigest);
    expect(codexPermissionPolicyShapeDigestV2(other)).toBe(codexPermissionPolicyShapeDigestV2(PROBE_PROFILE));
  });
});

describe("Ralph M5-B — argv and child environment policy", () => {
  const argv = buildCodexExecArgvV2({
    stagingWorkspace: "/tmp/rb-ralph-m5b-staging",
    outputSchemaPath: "/tmp/rb-ralph-m5b-staging-io/provider-output-schema.json",
    finalOutputPath: "/tmp/rb-ralph-m5b-staging-io/provider-final-output.json",
    permissionProfile: PROBE_PROFILE,
  });

  it("builds the exact stock invocation with no legacy sandbox flag", () => {
    expect(argv.slice(0, 11)).toEqual([
      "exec",
      "--cd", "/tmp/rb-ralph-m5b-staging",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "--ephemeral",
      "--color", "never",
      "--model", CODEX_CLI_EXECUTOR_REQUESTED_MODEL_V2,
    ]);
    expect(argv).toContain(`model_reasoning_effort="${CODEX_CLI_EXECUTOR_REASONING_EFFORT_V2}"`);
    expect(argv).toContain(`default_permissions="${CODEX_PERMISSION_PROFILE_NAME_V2}"`);
    expect(argv.some((token) => token.startsWith(`permissions.${CODEX_PERMISSION_PROFILE_NAME_V2}=`))).toBe(true);
    expect(argv).toContain("--output-schema");
    expect(argv).toContain("-o");
    expect(argv).toContain("--json");
    expect(argv[argv.length - 1]).toBe("-");
    // The legacy sandbox is gone entirely, in both flag and config form.
    expect(argv).not.toContain("--sandbox");
    expect(argv).not.toContain("workspace-write");
    expect(argv.join(" ")).not.toContain("sandbox_mode");
  });

  it("carries the sealed profile definition and the exact policy", () => {
    for (const override of codexPermissionProfileOverridesV2(PROBE_PROFILE)) expect(argv).toContain(override);
    const table = argv.find((token) => token.startsWith(`permissions.${CODEX_PERMISSION_PROFILE_NAME_V2}=`))!;
    expect(table).toContain('":root"="deny"');
    expect(table).toContain('":minimal"="read"');
    expect(table).toContain('"/home/fixture/.codex"="deny"');
    expect(table).toContain('"/tmp/rb-ralph-m5b-staging/src"="write"');
    expect(table).toContain("network={enabled=false}");
  });

  it("detects a reintroduced legacy sandbox and a missing default_permissions", () => {
    expect(() => assertCodexArgvPolicyV2([...argv.slice(0, 3), "--sandbox", "workspace-write", ...argv.slice(3)], PROBE_PROFILE)).toThrow(/M5B_ARGV_POLICY_INVALID: --sandbox/);
    expect(() => assertCodexArgvPolicyV2(argv.filter((token) => token !== `default_permissions="${CODEX_PERMISSION_PROFILE_NAME_V2}"`), PROBE_PROFILE)).toThrow(/M5B_ARGV_POLICY_INVALID: missing default_permissions/);
    expect(() => assertCodexArgvPolicyV2(argv.filter((token) => !token.startsWith(`permissions.${CODEX_PERMISSION_PROFILE_NAME_V2}=`)), PROBE_PROFILE)).toThrow(/M5B_ARGV_POLICY_INVALID/);
    expect(() => assertCodexArgvPolicyV2([...argv.slice(0, -1), "-c", 'sandbox_mode="workspace-write"', "-"], PROBE_PROFILE)).toThrow(/M5B_ARGV_POLICY_INVALID/);
  });

  it("never carries a resume, fork, escalation, search or strict-config token", () => {
    for (const forbidden of ["resume", "fork", "--last", "--search", "--add-dir", "--oss", "--approve-for-me", "--dangerously-bypass-approvals-and-sandbox", "danger-full-access", "--permission-profile", "--sandbox", "--full-auto", "--strict-config"]) {
      expect(argv).not.toContain(forbidden);
    }
    // `--strict-config` is refused outright: treating it as a security proof
    // is exactly the mistake M5-B.1 disproved.
    expect(() => assertCodexArgvPolicyV2([...argv.slice(0, -1), "--strict-config", "-"], PROBE_PROFILE)).toThrow(/M5B_ARGV_POLICY_INVALID: --strict-config/);
    expect(() => assertCodexArgvPolicyV2([...argv.slice(0, -1), "resume", "-"], PROBE_PROFILE)).toThrow(/M5B_ARGV_POLICY_INVALID/);
    expect(() => assertCodexArgvPolicyV2(["resume", ...argv.slice(1)], PROBE_PROFILE)).toThrow(/M5B_ARGV_POLICY_INVALID/);
  });

  it("rejects a relative or unnormalized argv path", () => {
    expect(() => buildCodexExecArgvV2({ stagingWorkspace: "relative/staging", outputSchemaPath: "/tmp/a.json", finalOutputPath: "/tmp/b.json", permissionProfile: PROBE_PROFILE })).toThrow(/M5B_ARGV_POLICY_INVALID/);
    expect(() => buildCodexExecArgvV2({ stagingWorkspace: "/tmp/../tmp/staging", outputSchemaPath: "/tmp/a.json", finalOutputPath: "/tmp/b.json", permissionProfile: PROBE_PROFILE })).toThrow(/M5B_ARGV_POLICY_INVALID/);
  });

  it("gives the Codex parent exactly PATH, HOME and CODEX_HOME, never the ambient environment", () => {
    const environment = codexParentEnvironmentV2("/home/fixture/.codex", {
      PATH: "/usr/local/sbin:/snap/bin", HOME: "/home/fixture", LANG: "C.UTF-8",
      OPENAI_API_KEY: "sk-must-not-propagate", CODEX_ACCESS_TOKEN: "must-not-propagate",
      SOME_UNRELATED_VARIABLE: "ignored",
    });
    // The pinned PATH is not cosmetic: an ambient or empty PATH makes Codex
    // select its bundled bwrap, which AppArmor denies, and every provider
    // command then dies before it runs.
    expect(environment).toEqual({ PATH: CODEX_PARENT_PATH_V2, HOME: "/home/fixture", CODEX_HOME: "/home/fixture/.codex" });
    expect(Object.keys(environment).sort()).toEqual(["CODEX_HOME", "HOME", "PATH"]);
    for (const key of CODEX_FORBIDDEN_ENVIRONMENT_KEYS_V2) expect(Object.keys(environment)).not.toContain(key);
    expect(JSON.stringify(environment)).not.toContain("sk-must-not-propagate");
    expect(() => codexParentEnvironmentV2("relative/.codex")).toThrow(/M5B_CHILD_ENVIRONMENT_INVALID/);
    expect(() => codexParentEnvironmentV2("/home/fixture/.codex", { PATH: "/usr/bin" })).toThrow(/M5B_CHILD_ENVIRONMENT_INVALID: HOME/);
  });

  it("gives model-spawned commands an inherit-none policy without CODEX_HOME", () => {
    const overrides = codexShellEnvironmentPolicyOverridesV2();
    expect(overrides).toContain('shell_environment_policy.inherit="none"');
    expect(overrides.join(" ")).not.toContain("CODEX_HOME");
    expect(overrides.join(" ")).not.toContain("HOME");
    expect(Object.keys(codexShellEnvironmentPolicyV2())).toEqual(["PATH"]);
    expect(codexShellEnvironmentPolicyV2().PATH).toBe(CODEX_PARENT_PATH_V2);
    expect(argv.join(" ")).toContain('shell_environment_policy.inherit="none"');
  });
});

describe("Ralph M5-B — the sandbox backend gate", () => {
  it("requires the system bwrap and refuses a bundled fallback", async () => {
    expect(await resolveSandboxBackendOnPathV2("/nonexistent-bin-directory")).toBeNull();
    await expect(inspectCodexSandboxBackendV2("/nonexistent-bin-directory")).rejects.toThrow(/M5B_SANDBOX_BACKEND_INVALID/);
    // A PATH that resolves some OTHER bwrap is exactly the failure M5-B.1
    // measured, and it must fail before dispatch rather than silently.
    await expect(inspectCodexSandboxBackendV2(CODEX_PARENT_PATH_V2, "/opt/some/other/bwrap")).rejects.toThrow(/M5B_SANDBOX_BACKEND_INVALID/);
  });

  it.runIf(existsSync(CODEX_SYSTEM_SANDBOX_BACKEND_PATH_V2))("accepts the system bwrap under the pinned parent PATH", async () => {
    const facts = await inspectCodexSandboxBackendV2();
    expect(facts).toMatchObject({
      backendPath: CODEX_SYSTEM_SANDBOX_BACKEND_PATH_V2,
      resolvedFromPath: CODEX_PARENT_PATH_V2,
      bundledFallbackSelected: false,
    });
  });
});

describe("Ralph M5-B — stock JSONL transport parser", () => {
  it("accepts one fresh thread with a terminal turn and binds the LAST agent message", () => {
    const stream = parseExactCodexEventStreamV2([
      threadStarted(),
      JSON.stringify({ type: "turn.started" }),
      agentMessage("interim progress note"),
      JSON.stringify({ type: "item.completed", item: { id: "item_2", item_type: "command_execution", command: "ls", exit_code: 0 } }),
      agentMessage('{"summary":"created src/status.js"}'),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 12, output_tokens: 3 } }),
    ].join("\n"));
    expect(stream.threadId).toBe("thr_m5bComponents0001");
    expect(stream.terminal).toBe("TURN_COMPLETED");
    expect(stream.agentMessageCount).toBe(2);
    expect(stream.finalAgentMessage).toBe('{"summary":"created src/status.js"}');
    expect(stream.commandExecutionCount).toBe(1);
    expect(stream.usageInputTokens).toBe(12);
  });

  it("refuses a duplicated, missing or late thread.started", () => {
    expect(() => parseExactCodexEventStreamV2([threadStarted(), threadStarted("thr_second"), JSON.stringify({ type: "turn.completed" })].join("\n"))).toThrow(/M5B_THREAD_BINDING_INVALID/);
    expect(() => parseExactCodexEventStreamV2([JSON.stringify({ type: "turn.started" }), JSON.stringify({ type: "turn.completed" })].join("\n"))).toThrow(/M5B_THREAD_BINDING_INVALID/);
    expect(() => parseExactCodexEventStreamV2([JSON.stringify({ type: "turn.started" }), threadStarted(), JSON.stringify({ type: "turn.completed" })].join("\n"))).toThrow(/M5B_THREAD_BINDING_INVALID/);
  });

  it("requires exactly one terminal event that closes the stream", () => {
    expect(() => parseExactCodexEventStreamV2([threadStarted(), JSON.stringify({ type: "turn.started" })].join("\n"))).toThrow(/M5B_TERMINAL_REQUIRED/);
    expect(() => parseExactCodexEventStreamV2([threadStarted(), JSON.stringify({ type: "turn.completed" }), agentMessage("late")].join("\n"))).toThrow(/M5B_EVENT_STREAM_INVALID/);
  });

  it("surfaces turn.failed and error terminals honestly", () => {
    expect(parseExactCodexEventStreamV2([threadStarted(), JSON.stringify({ type: "turn.failed", error: { message: "provider refused" } })].join("\n")).terminal).toBe("TURN_FAILED");
    expect(parseExactCodexEventStreamV2([threadStarted(), JSON.stringify({ type: "error", message: "transport error" })].join("\n")).terminal).toBe("ERROR");
  });

  it("refuses unknown event types, unknown item types and malformed lines", () => {
    expect(() => parseExactCodexEventStreamV2([threadStarted(), JSON.stringify({ type: "turn.mystery" })].join("\n"))).toThrow(/M5B_EVENT_STREAM_INVALID/);
    expect(() => parseExactCodexEventStreamV2([threadStarted(), JSON.stringify({ type: "item.completed", item: { item_type: "mystery" } }), JSON.stringify({ type: "turn.completed" })].join("\n"))).toThrow(/M5B_EVENT_STREAM_INVALID/);
    expect(() => parseExactCodexEventStreamV2([threadStarted(), "{not json"].join("\n"))).toThrow(/M5B_EVENT_STREAM_INVALID/);
    expect(() => parseExactCodexEventStreamV2(`${threadStarted()}\n${JSON.stringify({ type: "turn.completed" })}`, { truncated: true })).toThrow(/M5B_EVENT_STREAM_LIMIT/);
  });
});

describe("Ralph M5-B — non-authoritative provider output", () => {
  it("validates a minimal structured result and refuses anything else", () => {
    const result = validateExactCodexProviderOutputV2('{"summary":"created src/status.js"}');
    expect(result.summary).toBe("created src/status.js");
    expect(() => validateExactCodexProviderOutputV2('{"summary":"ok","success":true}')).toThrow(/M5B_PROVIDER_RESULT_INVALID/);
    expect(() => validateExactCodexProviderOutputV2("{not json")).toThrow(/M5B_PROVIDER_RESULT_INVALID/);
    expect(() => validateExactCodexProviderOutputV2(JSON.stringify({ summary: "x".repeat(5_000) }))).toThrow(/M5B_PROVIDER_OUTPUT_LIMIT/);
    expect(() => validateExactCodexProviderOutputV2(JSON.stringify({ summary: "Authorization: Bearer sk-forbidden-material-value" }))).toThrow(/M5B_PROVIDER_CREDENTIAL_MATERIAL/);
  });

  it("never asks the model to decide success, validation or completion", () => {
    const schema = JSON.parse(codexProviderOutputSchemaJsonV2()) as { properties: Record<string, unknown>; additionalProperties: boolean };
    expect(Object.keys(schema.properties)).toEqual(["summary"]);
    expect(schema.additionalProperties).toBe(false);
  });

  it("binds the -o output to the last agent message and rejects a first-message match", () => {
    const result = validateExactCodexProviderOutputV2('{"summary":"created src/status.js"}');
    expect(() => assertFinalAgentMessageMatchesOutputV2('{"summary":"created src/status.js"}', result)).not.toThrow();
    expect(() => assertFinalAgentMessageMatchesOutputV2('{"summary":"a different earlier message"}', result)).toThrow(/M5B_PROVIDER_RESULT_INVALID/);
    expect(() => assertFinalAgentMessageMatchesOutputV2(null, result)).toThrow(/M5B_PROVIDER_RESULT_INVALID/);
  });
});

describe("Ralph M5-B — provider workspace projection", () => {
  it("materializes the product surface and no Core-owned root", async () => {
    const root = await disposableProject({
      "README.md": "# fixture\n",
      "src/keep.js": "module.exports = 1;\n",
      ".rb-harness/canary.txt": "control plane\n",
      ".rb/state.json": "{}\n",
    });
    const staging = await mkdtemp(resolve(tmpdir(), "rb-ralph-m5b-projection-"));
    try {
      const policy = createWorkspacePolicy({ scopePaths: ["src/status.js"], coversPaths: ["src/status.js"] });
      const fingerprint = await fingerprintWorkspace(root, policy);
      const manifest = await buildCodexProviderProjectionV2({
        projectRoot: root,
        stagingWorkspace: join(staging, "workspace"),
        binding: BINDING,
        fingerprint,
        writableRoots: ["src"],
        createdAt: "2026-09-08T00:00:00.000Z",
      });
      validateCodexProjectionManifestV2(manifest);
      const paths = manifest.entries.map((entry) => entry.path);
      expect(paths).toContain("README.md");
      expect(paths).toContain("src/keep.js");
      for (const excluded of CODEX_PROJECTION_EXCLUDED_ROOTS_V2) {
        expect(paths.some((path) => path === excluded || path.startsWith(`${excluded}/`))).toBe(false);
        expect(existsSync(join(staging, "workspace", excluded))).toBe(false);
      }
      expect(await readFile(join(staging, "workspace", "src/keep.js"), "utf8")).toBe("module.exports = 1;\n");
    } finally {
      await rm(staging, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to project into or around the canonical project root", async () => {
    const root = await disposableProject({ "README.md": "# fixture\n" });
    try {
      const policy = createWorkspacePolicy({ scopePaths: ["src/status.js"], coversPaths: ["src/status.js"] });
      const fingerprint = await fingerprintWorkspace(root, policy);
      await expect(buildCodexProviderProjectionV2({ projectRoot: root, stagingWorkspace: join(root, "staging"), binding: BINDING, fingerprint, writableRoots: ["src"], createdAt: "2026-09-08T00:00:00.000Z" }))
        .rejects.toThrow(/M5B_PROJECTION_INVALID/);
      await expect(buildCodexProviderProjectionV2({ projectRoot: root, stagingWorkspace: root, binding: BINDING, fingerprint, writableRoots: ["src"], createdAt: "2026-09-08T00:00:00.000Z" }))
        .rejects.toThrow(/M5B_PROJECTION_INVALID/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a symlink in the source surface and in the provider result", async () => {
    const root = await disposableProject({ "README.md": "# fixture\n", "src/keep.js": "1\n" });
    const staging = await mkdtemp(resolve(tmpdir(), "rb-ralph-m5b-symlink-"));
    try {
      await symlink("/etc/passwd", join(root, "escape.txt"));
      const policy = createWorkspacePolicy({ scopePaths: ["src/status.js"], coversPaths: ["src/status.js"] });
      const fingerprint = await fingerprintWorkspace(root, policy);
      await expect(buildCodexProviderProjectionV2({ projectRoot: root, stagingWorkspace: join(staging, "workspace"), binding: BINDING, fingerprint, writableRoots: ["src"], createdAt: "2026-09-08T00:00:00.000Z" }))
        .rejects.toThrow(/M5B_PROJECTION_PATH_UNSAFE/);

      const provided = join(staging, "provided");
      await mkdir(provided, { recursive: true });
      await symlink("/etc/shadow", join(provided, "leak.txt"));
      await expect(readCodexProjectionStateV2(provided)).rejects.toThrow(/M5B_PROJECTION_PATH_UNSAFE/);
    } finally {
      await rm(staging, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("derives the staging path deterministically from the exact Attempt baseline", () => {
    const first = codexStagingWorkspacePathV2("/tmp/base", BINDING, sha256("baseline"));
    expect(codexStagingWorkspacePathV2("/tmp/base", BINDING, sha256("baseline"))).toBe(first);
    expect(codexStagingWorkspacePathV2("/tmp/base", BINDING, sha256("different"))).not.toBe(first);
    expect(() => codexStagingWorkspacePathV2("relative", BINDING, sha256("baseline"))).toThrow(/M5B_PROJECTION_INVALID/);
  });
});

describe("Ralph M5-B — host-derived provider delta", () => {
  const baseline = [
    { path: "README.md", kind: "file" as const, mode: 0o644, size: 9, contentHash: sha256("# fixture\n") },
    { path: "src", kind: "directory" as const, mode: 0o700, size: 0, contentHash: null },
  ];

  it("derives CREATE, MODIFY and DELETE from two host observations", () => {
    const entries = deriveCodexWorkspaceDeltaEntriesV2({
      stagingWorkspace: "/tmp/unused",
      baseline: [...baseline, { path: "src/old.js", kind: "file", mode: 0o644, size: 2, contentHash: sha256("1\n") }],
      final: [
        { path: "README.md", kind: "file", mode: 0o644, size: 12, contentHash: sha256("# changed\n") },
        { path: "src", kind: "directory", mode: 0o700, size: 0, contentHash: null },
        { path: "src/status.js", kind: "file", mode: 0o644, size: 24, contentHash: sha256('module.exports = "ready";\n') },
      ],
      scope: "README.md src/status.js src/old.js",
      covers: "README.md src/status.js src/old.js",
    });
    expect(entries.map((entry) => `${entry.operation} ${entry.path}`)).toEqual([
      "MODIFY README.md",
      "DELETE src/old.js",
      "CREATE src/status.js",
    ]);
  });

  it("refuses an out-of-scope path, every control-plane path and a traversal", () => {
    const outOfScope = () => deriveCodexWorkspaceDeltaEntriesV2({
      stagingWorkspace: "/tmp/unused", baseline, scope: "src/status.js", covers: "src/status.js",
      final: [...baseline, { path: "src/unexpected.js", kind: "file", mode: 0o644, size: 1, contentHash: sha256("x") }],
    });
    expect(outOfScope).toThrow(/M5B_DELTA_OUT_OF_SCOPE/);
    for (const path of [".rb-harness/injected.txt", ".rb/injected.txt", ".git/config"]) {
      const controlPlane = () => deriveCodexWorkspaceDeltaEntriesV2({
        stagingWorkspace: "/tmp/unused", baseline, scope: "**", covers: "**",
        final: [...baseline, { path, kind: "file" as const, mode: 0o644, size: 1, contentHash: sha256("x") }],
      });
      expect(controlPlane, path).toThrow(/M5B_DELTA_PATH_FORBIDDEN/);
    }
    const traversal = () => deriveCodexWorkspaceDeltaEntriesV2({
      stagingWorkspace: "/tmp/unused", baseline, scope: "**", covers: "**",
      final: [...baseline, { path: "../escaped.js", kind: "file", mode: 0o644, size: 1, contentHash: sha256("x") }],
    });
    expect(traversal).toThrow(/M5B_PROJECTION_PATH_UNSAFE/);
  });

  it("refuses a chmod-only mutation", () => {
    expect(() => deriveCodexWorkspaceDeltaEntriesV2({
      stagingWorkspace: "/tmp/unused", baseline, scope: "README.md", covers: "README.md",
      final: [{ path: "README.md", kind: "file", mode: 0o755, size: 9, contentHash: sha256("# fixture\n") }, baseline[1]!],
    })).toThrow(/M5B_DELTA_UNSUPPORTED_MUTATION/);
  });

  it("derives the exact real T001 file delta and ignores non-publishable directories", async () => {
    const staging = await mkdtemp(resolve(tmpdir(), "rb-ralph-m5b-real-shape-"));
    try {
      await mkdir(join(staging, ".agents"));
      await mkdir(join(staging, ".codex"));
      await mkdir(join(staging, "public"));
      await writeFile(join(staging, "package.json"), '{"name":"fixture"}\n', { mode: 0o664 });
      await writeFile(join(staging, "public/index.html"), "<!doctype html>\n", { mode: 0o664 });
      await writeFile(join(staging, "server.js"), "export {};\n", { mode: 0o664 });

      const final = await readCodexProjectionStateV2(staging);
      expect(final.filter((entry) => entry.kind === "file").map((entry) => entry.mode)).toEqual([0o644, 0o644, 0o644]);
      const entries = deriveCodexWorkspaceDeltaEntriesV2({
        stagingWorkspace: staging,
        baseline: [],
        final,
        scope: "package.json public/index.html server.js",
        covers: "R-002 R-003 R-005 R-007 R-009 R-013",
      });
      expect(entries).toHaveLength(3);
      expect(entries.map((entry) => `${entry.operation} ${entry.path}`)).toEqual([
        "CREATE package.json",
        "CREATE public/index.html",
        "CREATE server.js",
      ]);
      expect(entries.some((entry) => [".agents", ".codex", "public"].includes(entry.path))).toBe(false);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  });

  it("does not let an authorized file confer authority on an unowned sibling", async () => {
    const staging = await mkdtemp(resolve(tmpdir(), "rb-ralph-m5b-unowned-sibling-"));
    try {
      await mkdir(join(staging, "public"));
      await writeFile(join(staging, "public/index.html"), "authorized\n");
      await writeFile(join(staging, "public/secret.txt"), "not authorized\n");
      const final = await readCodexProjectionStateV2(staging);
      expect(() => deriveCodexWorkspaceDeltaEntriesV2({
        stagingWorkspace: staging,
        baseline: [],
        final,
        scope: "public/index.html",
        covers: "public/index.html",
      })).toThrow(/M5B_DELTA_OUT_OF_SCOPE: public\/secret\.txt/);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  });

  it("treats arbitrarily nested parents as structural transport for an authorized file", async () => {
    const staging = await mkdtemp(resolve(tmpdir(), "rb-ralph-m5b-nested-parents-"));
    try {
      await mkdir(join(staging, "src/features/tasks"), { recursive: true });
      await writeFile(join(staging, "src/features/tasks/index.js"), "export {};\n");
      const entries = deriveCodexWorkspaceDeltaEntriesV2({
        stagingWorkspace: staging,
        baseline: [],
        final: await readCodexProjectionStateV2(staging),
        scope: "src/features/tasks/index.js",
        covers: "src/features/tasks/index.js",
      });
      expect(entries.map((entry) => `${entry.operation} ${entry.path}`)).toEqual([
        "CREATE src/features/tasks/index.js",
      ]);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  });

  it("treats an empty directory tree as a disposable projection no-op", async () => {
    const staging = await mkdtemp(resolve(tmpdir(), "rb-ralph-m5b-empty-directories-"));
    try {
      await mkdir(join(staging, "tmp-empty/nested-empty"), { recursive: true });
      const entries = deriveCodexWorkspaceDeltaEntriesV2({
        stagingWorkspace: staging,
        baseline: [],
        final: await readCodexProjectionStateV2(staging),
        scope: "tmp-empty/owned.txt",
        covers: "tmp-empty/owned.txt",
      });
      expect(entries).toEqual([]);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  });

  it("keeps the existing projection file-count bound when empty directories are present", async () => {
    const staging = await mkdtemp(resolve(tmpdir(), "rb-ralph-m5b-bounded-empty-directories-"));
    try {
      await mkdir(join(staging, "tmp-empty/nested-empty"), { recursive: true });
      await mkdir(join(staging, "files"));
      await Promise.all(Array.from({ length: M5B_LIMITS_V2.projectionMaxFiles + 1 }, (_, index) =>
        writeFile(join(staging, "files", `${String(index).padStart(4, "0")}.txt`), "x")));
      await expect(readCodexProjectionStateV2(staging)).rejects.toThrow(/M5B_PROJECTION_LIMIT_EXCEEDED: file count/);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }, 60_000);

  it("seals exact provider bytes and refuses a tampered payload", async () => {
    const staging = await mkdtemp(resolve(tmpdir(), "rb-ralph-m5b-delta-"));
    try {
      await mkdir(join(staging, "src"), { recursive: true });
      await writeFile(join(staging, "src/status.js"), 'module.exports = "ready";\n');
      const final = await readCodexProjectionStateV2(staging);
      const delta = await createCodexWorkspaceDeltaV2({
        stagingWorkspace: staging,
        baseline: [{ path: "src", kind: "directory", mode: 0o700, size: 0, contentHash: null }],
        final,
        scope: "src/status.js",
        covers: "src/status.js",
        ...BINDING,
        providerDescriptorDigest: sha256("descriptor"),
        threadBindingDigest: sha256("thread"),
        threadId: "thr_m5bComponents0001",
        baseWorkspaceFingerprint: sha256("baseline"),
        projectionManifestDigest: sha256("manifest"),
        projectionBaselineDigest: sha256("projection-baseline"),
        providerResultDigest: sha256("result"),
        createdAt: "2026-09-08T00:00:00.000Z",
      });
      validateCodexWorkspaceDeltaV2(delta);
      expect(delta.entries).toHaveLength(1);
      expect(delta.entries[0]).toMatchObject({ path: "src/status.js", operation: "CREATE" });
      expect(Buffer.from(delta.entries[0]!.postimageBase64!, "base64").toString("utf8")).toBe('module.exports = "ready";\n');
      const tampered = { ...delta, entries: [{ ...delta.entries[0]!, postimageBase64: Buffer.from("tampered").toString("base64") }] };
      expect(() => validateCodexWorkspaceDeltaV2(tampered)).toThrow(/M5B_DELTA_INVALID/);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  });
});

describe("Ralph M5-B — stock Codex capability record and the real-inference gate", () => {
  it("is a distinct artifact that never claims OpenCode conformance", () => {
    validateCodexCliCapabilityRecordV2(CODEX_CLI_CAPABILITY_RECORD_V2);
    expect(CODEX_CLI_CAPABILITY_RECORD_V2.schema).toBe("rb-ralph-codex-cli-capability/v1");
    expect(CODEX_CLI_CAPABILITY_RECORD_V2.profileId).toBe(CODEX_CLI_EXECUTOR_PROFILE_V2);
    expect(JSON.stringify(CODEX_CLI_CAPABILITY_RECORD_V2)).not.toContain("opencode");
    expect(JSON.stringify(CODEX_CLI_CAPABILITY_RECORD_V2)).not.toContain("tier");
    expect(CODEX_CLI_CAPABILITY_RECORD_V2.observedModelSurface).toBe("UNAVAILABLE");
    expect(CODEX_CLI_CAPABILITY_RECORD_V2.commandStreamAuthority).toBe("NONE");
    expect(CODEX_CLI_CAPABILITY_RECORD_V2.workspaceAuthority).toBe("HOST_FILESYSTEM");
  });

  it("binds the named permission profile and never a legacy sandbox mode", () => {
    expect(CODEX_CLI_CAPABILITY_RECORD_V2.legacySandboxMode).toBe("NONE");
    expect(CODEX_CLI_CAPABILITY_RECORD_V2.permissionProfileName).toBe(CODEX_PERMISSION_PROFILE_NAME_V2);
    expect(CODEX_CLI_CAPABILITY_RECORD_V2.granularPermissionProfileReachable).toBe(true);
    expect(CODEX_CLI_CAPABILITY_RECORD_V2.systemSandboxBackendPath).toBe(CODEX_SYSTEM_SANDBOX_BACKEND_PATH_V2);
    expect(CODEX_CLI_CAPABILITY_RECORD_V2.permissionPolicyShapeDigest).toBe(codexPermissionPolicyShapeDigestV2(PROBE_PROFILE));
    expect(JSON.stringify(CODEX_CLI_CAPABILITY_RECORD_V2)).not.toContain("workspace-write");
  });

  it("authorizes a dispatch only when every physical capability is proven", () => {
    expect(CODEX_CLI_CAPABILITY_RECORD_V2.credentialFileSandboxBoundary).toBe("DENIED");
    expect(() => assertCodexRealInferenceGateV2()).not.toThrow();
    for (const field of ["stagingWriteCapability", "controlPlaneDenialCapability", "networkDenialCapability", "shellEnvironmentIsolationCapability"] as const) {
      const weakened = { ...CODEX_CLI_CAPABILITY_RECORD_V2, [field]: "UNPROVEN" as const };
      const sealed = { ...weakened, recordDigest: sha256Canonical(Object.fromEntries(Object.entries(weakened).filter(([key]) => key !== "recordDigest"))) };
      expect(() => assertCodexRealInferenceGateV2(sealed as never)).toThrow(/M5B_CREDENTIAL_FILE_BOUNDARY_UNSAFE/);
    }
    const readable = { ...CODEX_CLI_CAPABILITY_RECORD_V2, credentialFileSandboxBoundary: "PROVIDER_READABLE" as const };
    const sealedReadable = { ...readable, recordDigest: sha256Canonical(Object.fromEntries(Object.entries(readable).filter(([key]) => key !== "recordDigest"))) };
    expect(() => assertCodexRealInferenceGateV2(sealedReadable)).toThrow(/M5B_CREDENTIAL_FILE_BOUNDARY_UNSAFE/);
  });

  it("refuses a tampered capability record and a reintroduced legacy sandbox", () => {
    expect(() => validateCodexCliCapabilityRecordV2({ ...CODEX_CLI_CAPABILITY_RECORD_V2, credentialFileSandboxBoundary: "PROVIDER_READABLE" })).toThrow(/M5B_CAPABILITY_RECORD_INVALID/);
    const legacy = { ...CODEX_CLI_CAPABILITY_RECORD_V2, legacySandboxMode: "workspace-write" };
    const sealed = { ...legacy, recordDigest: sha256Canonical(Object.fromEntries(Object.entries(legacy).filter(([key]) => key !== "recordDigest"))) };
    expect(() => validateCodexCliCapabilityRecordV2(sealed)).toThrow(/M5B_CAPABILITY_RECORD_INVALID: legacy sandbox mode/);
  });
});

describe("Ralph M5-B — deterministic publication", () => {
  it("publishes only the sealed delta, is idempotent and recovers a partial publication", async () => {
    const fixture = await bootstrapM5BRunV2();
    const staging = await mkdtemp(resolve(tmpdir(), "rb-ralph-m5b-publish-"));
    try {
      await mkdir(join(staging, "src"), { recursive: true });
      await writeFile(join(staging, "src/status.js"), 'module.exports = "ready";\n');
      await writeFile(join(staging, "README.md"), "# Disposable Ralph M5-B Codex fixture (edited)\n");
      const before = await fingerprintWorkspace(fixture.projectRoot, fixture.snapshot.workspacePolicy);
      const final = await readCodexProjectionStateV2(staging);
      const delta = await createCodexWorkspaceDeltaV2({
        stagingWorkspace: staging,
        baseline: [
          { path: "README.md", kind: "file", mode: 0o644, size: Buffer.byteLength("# Disposable Ralph M5-B Codex fixture\n"), contentHash: sha256("# Disposable Ralph M5-B Codex fixture\n") },
          { path: "src", kind: "directory", mode: 0o700, size: 0, contentHash: null },
        ],
        final,
        scope: "src/status.js README.md",
        covers: "src/status.js README.md",
        runId: fixture.runId,
        phaseId: "P01",
        taskId: "T001",
        attemptId: fixture.attemptId,
        invocationId: "inv-m5b-publication",
        providerDescriptorDigest: sha256("descriptor"),
        threadBindingDigest: sha256("thread"),
        threadId: "thr_m5bPublication0001",
        baseWorkspaceFingerprint: before.fingerprintDigest,
        projectionManifestDigest: sha256("manifest"),
        projectionBaselineDigest: sha256("projection-baseline"),
        providerResultDigest: sha256("result"),
        createdAt: "2026-09-08T00:00:00.000Z",
      });
      await persistCodexWorkspaceDeltaV2(fixture.store, delta, "nonce-delta");

      let ordinal = 0;
      const publishInput = {
        store: fixture.store,
        delta,
        workspacePolicy: fixture.snapshot.workspacePolicy,
        clock: () => "2026-09-08T00:00:01.000Z",
        nonceFactory: () => `pub-${++ordinal}`,
      };
      const receipt = await publishCodexWorkspaceDeltaV2(publishInput);
      expect(receipt.appliedCount).toBe(2);
      expect(await readFile(join(fixture.projectRoot, "src/status.js"), "utf8")).toBe('module.exports = "ready";\n');
      expect(await readFile(join(fixture.projectRoot, ".rb-harness/canary.txt"), "utf8")).toBe("control-plane canary\n");
      expect(receipt.canonicalPostControlPlaneFingerprint).toBe(before.controlPlaneFingerprint);
      expect(await readCodexPublicationIntentV2(fixture.store, fixture.attemptId)).toBeDefined();

      // Idempotent: a second publication of the same sealed delta changes nothing.
      const again = await publishCodexWorkspaceDeltaV2(publishInput);
      expect(again.receiptDigest).toBe(receipt.receiptDigest);
      expect(await readCodexPublicationReceiptV2(fixture.store, fixture.attemptId)).toMatchObject({ deltaDigest: delta.deltaDigest });
    } finally {
      await rm(staging, { recursive: true, force: true });
      await rm(fixture.projectRoot, { recursive: true, force: true });
      await rm(fixture.stagingBase, { recursive: true, force: true });
    }
  });

  it("fails closed on canonical drift and on publication that diverges from the sealed delta", async () => {
    const fixture = await bootstrapM5BRunV2();
    const staging = await mkdtemp(resolve(tmpdir(), "rb-ralph-m5b-drift-"));
    try {
      await mkdir(join(staging, "src"), { recursive: true });
      await writeFile(join(staging, "src/status.js"), 'module.exports = "ready";\n');
      const before = await fingerprintWorkspace(fixture.projectRoot, fixture.snapshot.workspacePolicy);
      const delta = await createCodexWorkspaceDeltaV2({
        stagingWorkspace: staging,
        baseline: [{ path: "src", kind: "directory", mode: 0o700, size: 0, contentHash: null }],
        final: (await readCodexProjectionStateV2(staging)).filter((entry) => entry.path !== "README.md"),
        scope: "src/status.js",
        covers: "src/status.js",
        runId: fixture.runId,
        phaseId: "P01",
        taskId: "T001",
        attemptId: fixture.attemptId,
        invocationId: "inv-m5b-drift",
        providerDescriptorDigest: sha256("descriptor"),
        threadBindingDigest: sha256("thread"),
        threadId: "thr_m5bDrift0001",
        baseWorkspaceFingerprint: before.fingerprintDigest,
        projectionManifestDigest: sha256("manifest"),
        projectionBaselineDigest: sha256("projection-baseline"),
        providerResultDigest: sha256("result"),
        createdAt: "2026-09-08T00:00:00.000Z",
      });

      // Unrelated canonical drift after the provider baseline.
      await writeFile(join(fixture.projectRoot, "README.md"), "# drifted by something else\n");
      let ordinal = 0;
      await expect(publishCodexWorkspaceDeltaV2({
        store: fixture.store, delta, workspacePolicy: fixture.snapshot.workspacePolicy,
        clock: () => "2026-09-08T00:00:01.000Z", nonceFactory: () => `drift-${++ordinal}`,
      })).rejects.toThrow(/M5B_CANONICAL_DRIFT/);
      expect(existsSync(join(fixture.projectRoot, "src/status.js"))).toBe(false);

      // A publication whose bytes were changed independently of the sealed
      // delta is detected: the canonical path already holds foreign content.
      await writeFile(join(fixture.projectRoot, "README.md"), "# Disposable Ralph M5-B Codex fixture\n");
      await writeFile(join(fixture.projectRoot, "src/status.js"), 'module.exports = "tampered";\n');
      await expect(publishCodexWorkspaceDeltaV2({
        store: fixture.store, delta, workspacePolicy: fixture.snapshot.workspacePolicy,
        clock: () => "2026-09-08T00:00:02.000Z", nonceFactory: () => `tamper-${++ordinal}`,
      })).rejects.toThrow(/M5B_CANONICAL_DRIFT|M5B_PUBLICATION_RECONCILIATION_REQUIRED/);
    } finally {
      await rm(staging, { recursive: true, force: true });
      await rm(fixture.projectRoot, { recursive: true, force: true });
      await rm(fixture.stagingBase, { recursive: true, force: true });
    }
  });
});

describe("Ralph M5-B — timeout policy", () => {
  it("is a distinct Core-owned policy", () => {
    const policy = createM5BTimeoutPolicyV2(120_000);
    expect(policy.schema).toBe("rb-ralph-codex-timeout/v1");
    expect(() => validateM5BTimeoutPolicyV2(policy)).not.toThrow();
    expect(() => validateM5BTimeoutPolicyV2({ ...policy, deadlineMs: 1 })).toThrow(/M5B_TIMEOUT_POLICY_INVALID/);
    expect(() => createM5BTimeoutPolicyV2(0)).toThrow(/M5B_TIMEOUT_POLICY_INVALID/);
  });
});

/**
 * Guards for invariants that are otherwise only enforced indirectly.
 *
 * Each of these exists because a mutation of the corresponding shipped check
 * survived the rest of the suite: the boundary held in practice, but nothing
 * would have noticed if the check itself were removed. A security check that
 * no test can see disappear is not a check.
 */
describe("Ralph M5-B — boundary checks that must not be silently removable", () => {
  it("refuses a symlinked executable even when its digest and size match the pin", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rb-ralph-m5b-symlink-exec-"));
    try {
      const real = join(root, "real-codex");
      await writeFile(real, "not the stock native binary");
      await chmod(real, 0o755);
      const link = join(root, "linked-codex");
      await symlink(real, link);
      // The pin is constructed so ONLY the symlink check can reject: lstat
      // reports the link's own size, and the digest stream follows the link
      // to the target, so both would otherwise agree.
      const linkStats = await lstat(link);
      const pin = {
        ...CODEX_STOCK_EXECUTABLE_PIN_V2,
        executablePath: link,
        executableSizeBytes: linkStats.size,
        executableSha256: sha256(await readFile(real)),
      };
      await expect(inspectExactCodexCliExecutableV2(30_000, pin)).rejects.toThrow(/not a regular native file/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("never reads an absent marker as a denial", () => {
    // A sandbox that never started prints nothing. Silence proves nothing.
    const silent = evaluateCodexProbeMarkersV2("", { hostProductWrite: false, hostControlPlane: false });
    expect(silent.completed).toBe(false);
    expect(silent.credentialFileBoundary).toBe("UNKNOWN");
    expect(silent.stagingWriteCapability).toBe("UNPROVEN");
    expect(silent.controlPlaneDenialCapability).toBe("UNPROVEN");
    expect(silent.networkDenialCapability).toBe("UNPROVEN");
    expect(silent.shellEnvironmentIsolationCapability).toBe("UNPROVEN");

    // Even a full set of denial markers proves nothing without the completion
    // marker: a truncated stream must not read as a clean run.
    const truncated = [
      "RBM5B PRODUCT_WRITE=ALLOW", "RBM5B AUTH_OPEN=DENY", "RBM5B RB_HARNESS_WRITE=DENY",
      "RBM5B RB_WRITE=DENY", "RBM5B GIT_WRITE=DENY", "RBM5B STAGING_ROOT_WRITE=DENY",
      "RBM5B NETWORK=DENY", "RBM5B CODEX_HOME_VISIBLE=NO",
    ].join("\n");
    const withoutDone = evaluateCodexProbeMarkersV2(truncated, { hostProductWrite: true, hostControlPlane: false });
    expect(withoutDone.credentialFileBoundary).toBe("UNKNOWN");
    expect(withoutDone.controlPlaneDenialCapability).toBe("UNPROVEN");

    const complete = evaluateCodexProbeMarkersV2(`${truncated}\nRBM5B DONE=1`, { hostProductWrite: true, hostControlPlane: false });
    expect(complete.credentialFileBoundary).toBe("DENIED");
    expect(complete.stagingWriteCapability).toBe("PROVEN");
    expect(complete.controlPlaneDenialCapability).toBe("PROVEN");
    // The host has the last word: a marker claiming denial while the host
    // sees the forbidden path is not a denial.
    expect(evaluateCodexProbeMarkersV2(`${truncated}\nRBM5B DONE=1`, { hostProductWrite: true, hostControlPlane: true }).controlPlaneDenialCapability).toBe("UNPROVEN");
    expect(evaluateCodexProbeMarkersV2(`${truncated}\nRBM5B DONE=1`, { hostProductWrite: false, hostControlPlane: false }).stagingWriteCapability).toBe("UNPROVEN");
  });

  it("refuses a declared record whose credential boundary is not DENIED", () => {
    for (const boundary of ["PROVIDER_READABLE", "UNKNOWN"] as const) {
      const forged = { ...CODEX_CLI_CAPABILITY_RECORD_V2, credentialFileSandboxBoundary: boundary };
      const sealed = { ...forged, recordDigest: sha256Canonical(Object.fromEntries(Object.entries(forged).filter(([key]) => key !== "recordDigest"))) };
      expect(() => assertCodexRealInferenceGateV2(sealed as never), boundary).toThrow(/M5B_CREDENTIAL_FILE_BOUNDARY_UNSAFE/);
    }
  });

  it("refuses a widened model-command or parent environment policy", () => {
    // CODEX_HOME must never reach a model-spawned command: it is the path to
    // the credential store.
    expect(() => assertCodexShellEnvironmentPolicyV2({ PATH: CODEX_PARENT_PATH_V2, CODEX_HOME: "/home/fixture/.codex" })).toThrow(/M5B_CHILD_ENVIRONMENT_INVALID/);
    expect(() => assertCodexShellEnvironmentPolicyV2({ PATH: "/usr/bin:/bin:/opt/extra" })).toThrow(/M5B_CHILD_ENVIRONMENT_INVALID/);
    expect(() => assertCodexShellEnvironmentPolicyV2({} as never)).toThrow(/M5B_CHILD_ENVIRONMENT_INVALID/);
    expect(() => assertCodexShellEnvironmentPolicyV2({ PATH: CODEX_PARENT_PATH_V2 })).not.toThrow();

    // The parent environment is a closed set of exactly three names.
    expect(() => assertCodexParentEnvironmentPolicyV2({ PATH: CODEX_PARENT_PATH_V2, HOME: "/home/fixture", CODEX_HOME: "/home/fixture/.codex", EXTRA: "1" }))
      .toThrow(/M5B_CHILD_ENVIRONMENT_INVALID/);
    expect(() => assertCodexParentEnvironmentPolicyV2({ PATH: CODEX_PARENT_PATH_V2, HOME: "/home/fixture" })).toThrow(/M5B_CHILD_ENVIRONMENT_INVALID/);
    expect(() => assertCodexParentEnvironmentPolicyV2({ PATH: "/usr/bin:/bin:/opt/extra", HOME: "/home/fixture", CODEX_HOME: "/home/fixture/.codex" }))
      .toThrow(/M5B_CHILD_ENVIRONMENT_INVALID/);
    expect(() => assertCodexParentEnvironmentPolicyV2({ PATH: CODEX_PARENT_PATH_V2, HOME: "/home/fixture", CODEX_HOME: "/home/fixture/.codex" })).not.toThrow();
  });

  it("refuses a symlink in the provider result rather than following it", async () => {
    const staging = await mkdtemp(resolve(tmpdir(), "rb-ralph-m5b-follow-"));
    try {
      // The target is an ordinary readable regular file, so a check that
      // followed the link would see nothing wrong and publish its content.
      await writeFile(join(staging, "real.txt"), "real content\n");
      await symlink(join(staging, "real.txt"), join(staging, "alias.txt"));
      await expect(readCodexProjectionStateV2(staging)).rejects.toThrow(/M5B_PROJECTION_PATH_UNSAFE: symlink/);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  });

  it("refuses a FIFO in the provider result as a special file", async () => {
    const staging = await mkdtemp(resolve(tmpdir(), "rb-ralph-m5b-fifo-"));
    try {
      execFileSync("mkfifo", [join(staging, "provider.pipe")]);
      await expect(readCodexProjectionStateV2(staging)).rejects.toThrow(/M5B_PROJECTION_PATH_UNSAFE: special file provider\.pipe/);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  });

  it("enforces the per-file and total delta byte bounds", async () => {
    const staging = await mkdtemp(resolve(tmpdir(), "rb-ralph-m5b-delta-limit-"));
    try {
      await mkdir(join(staging, "src"), { recursive: true });
      const oversized = "x".repeat(M5B_LIMITS_V2.deltaMaxFileBytes + 1);
      await writeFile(join(staging, "src", "big.js"), oversized, { mode: 0o644 });
      const final = await readCodexProjectionStateV2(staging);
      await expect(createCodexWorkspaceDeltaV2({
        stagingWorkspace: staging,
        baseline: [{ path: "src", kind: "directory", mode: 0o700, size: 0, contentHash: null }],
        final,
        scope: "src",
        covers: "src",
        runId: "run-limit", phaseId: "P01", taskId: "T001", attemptId: "attempt-limit", invocationId: "invocation-limit",
        providerDescriptorDigest: `sha256:${"a".repeat(64)}`,
        threadBindingDigest: `sha256:${"b".repeat(64)}`,
        threadId: "thread-limit",
        baseWorkspaceFingerprint: `sha256:${"c".repeat(64)}`,
        projectionManifestDigest: `sha256:${"d".repeat(64)}`,
        projectionBaselineDigest: `sha256:${"e".repeat(64)}`,
        providerResultDigest: `sha256:${"f".repeat(64)}`,
        createdAt: "2026-09-09T00:00:00.000Z",
      })).rejects.toThrow(/M5B_DELTA_LIMIT_EXCEEDED/);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }, 60_000);
});

import { evaluateCodexProbeMarkersV2 } from "../../src/vnext/ralph-runtime/operational-m5b/codex-credential-boundary.js";
import {
  assertCodexParentEnvironmentPolicyV2,
  assertCodexShellEnvironmentPolicyV2,
} from "../../src/vnext/ralph-runtime/operational-m5b/codex-process.js";
import { M5B_LIMITS_V2 } from "../../src/vnext/ralph-runtime/operational-m5b/contract.js";
