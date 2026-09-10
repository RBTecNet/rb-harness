import { defineConfig } from "vitest/config";

/** Explicit opt-in only: ordinary `npm test` never discovers this file. */
export default defineConfig({
  test: {
    include: ["test/vnext/ralph-operational-m5d-real-e2e.ts"],
    fileParallelism: false,
    testTimeout: 2_400_000,
    hookTimeout: 2_400_000,
  },
});
