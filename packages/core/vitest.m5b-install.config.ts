import { defineConfig } from "vitest/config";

/**
 * Explicit opt-in only: ordinary `npm test` never discovers this file.
 *
 * This entry INSTALLS the Harness-managed stock Codex runtime by copying an
 * already-qualified upstream tree.  It is a deliberate side-effecting
 * operation, gated by an environment variable, and it uses exactly the typed
 * authority the Executor itself uses so the install can never drift from the
 * pin it is verified against.
 */
export default defineConfig({
  test: {
    include: ["test/vnext/ralph-operational-m5b-runtime-install.ts"],
    fileParallelism: false,
    testTimeout: 900_000,
    hookTimeout: 900_000,
  },
});
