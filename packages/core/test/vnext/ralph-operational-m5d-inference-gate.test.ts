import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { inspectManagedCodexRuntimeV2 } from "../../src/vnext/ralph-runtime/operational-m5b/codex-process.js";
import { inspectCodexSandboxBackendV2 } from "../../src/vnext/ralph-runtime/operational-m5b/codex-sandbox-backend.js";
import {
  CODEX_CLI_AUDITOR_EXECUTABLE_PATH_V2,
  assertCodexAuditorPhysicalCapabilityV2,
  probeCodexAuditorPhysicalCapabilityV2,
} from "../../src/vnext/ralph-runtime/operational-m5d/index.js";

const PHYSICAL_GATE_AVAILABLE = existsSync(CODEX_CLI_AUDITOR_EXECUTABLE_PATH_V2) && existsSync("/usr/bin/bwrap");

/** This suite invokes only `codex --version` and `codex sandbox`; never `codex exec`. */
describe("Ralph M5-D — real non-model Auditor capability gate", () => {
  it.runIf(PHYSICAL_GATE_AVAILABLE)("proves the exact managed runtime, system bwrap, credential boundary and read-only matrix", async () => {
    const runtime = await inspectManagedCodexRuntimeV2(180_000);
    expect(runtime.executable).toMatchObject({
      executablePath: "/home/bruno/.local/libexec/rb-harness/codex-cli/0.153.4-rb.1/bin/codex",
      executableVersion: "0.153.4",
      executableSizeBytes: 258_659_424,
      executableSha256: "sha256:56ef98ab4032d317ab26e9b5e5a175650717351edb16ed9cde0cb6d1734d62da",
    });
    expect(runtime.managedRuntime).toMatchObject({
      kind: "stock-codex-cli-managed", upstreamVersion: "0.153.4", version: "0.153.4-rb.1", transport: "codex-exec",
    });
    const backend = await inspectCodexSandboxBackendV2();
    expect(backend).toMatchObject({ backendPath: "/usr/bin/bwrap", bundledFallbackSelected: false, executable: true });
    const report = await probeCodexAuditorPhysicalCapabilityV2({
      deadlineMs: 300_000,
      executablePath: runtime.executable.executablePath,
    });
    assertCodexAuditorPhysicalCapabilityV2(report);
    expect(report).toMatchObject({
      productSourceRead: "PROVEN",
      productWriteDenied: "PROVEN",
      productDeleteDenied: "PROVEN",
      productRenameDenied: "PROVEN",
      credentialOpenCloseDenied: "PROVEN",
      rbHarnessReadWriteDenied: "PROVEN",
      rbReadWriteDenied: "PROVEN",
      gitReadWriteDenied: "PROVEN",
      networkDenied: "PROVEN",
      codexHomeEnvironmentAbsent: "PROVEN",
      workspaceImmutable: "PROVEN",
      probeExitCode: 0,
    });
  }, 360_000);
});
