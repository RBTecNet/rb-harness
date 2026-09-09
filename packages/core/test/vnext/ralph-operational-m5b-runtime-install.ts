import { describe, expect, it } from "vitest";
import {
  STOCK_CODEX_CLI_RUNTIME,
  installManagedStockCodexRuntime,
  managedStockCodexExecutablePath,
  verifyManagedStockCodexRuntime,
} from "../../src/managed-stock-codex-runtime.js";

if (process.env.RB_RALPH_M5B_INSTALL_RUNTIME !== "1") {
  throw new Error("Managed stock Codex runtime install is opt-in; set RB_RALPH_M5B_INSTALL_RUNTIME=1 explicitly");
}

const source = process.env.RB_RALPH_M5B_RUNTIME_SOURCE;
if (!source) {
  throw new Error("Set RB_RALPH_M5B_RUNTIME_SOURCE to the already-qualified upstream Codex runtime tree");
}

describe("Ralph M5-B — managed stock Codex runtime install", () => {
  it("installs the exact qualified stock bytes and verifies them", async () => {
    const result = await installManagedStockCodexRuntime({ sourceDirectory: source });
    expect(result.identity).toMatchObject({
      kind: "stock-codex-cli-managed",
      upstreamVersion: STOCK_CODEX_CLI_RUNTIME.upstreamVersion,
      rbRevision: STOCK_CODEX_CLI_RUNTIME.rbRevision,
      version: STOCK_CODEX_CLI_RUNTIME.version,
      transport: "codex-exec",
      executablePath: managedStockCodexExecutablePath(),
      executableSizeBytes: 258_659_424,
      executableSha256: "56ef98ab4032d317ab26e9b5e5a175650717351edb16ed9cde0cb6d1734d62da",
      reportedIdentity: "codex-cli 0.153.4",
    });

    // Verification is re-run independently of the install path that produced
    // it: nothing is trusted because it was just written.
    const verified = await verifyManagedStockCodexRuntime();
    expect(verified.ok).toBe(true);
    console.log(JSON.stringify({ stage: "managed-runtime-install", status: result.status, versionDirectory: result.versionDirectory, identity: result.identity }));
  }, 900_000);
});
