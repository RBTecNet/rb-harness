import { defineConfig } from "vitest/config";

/** Explicit opt-in only: ordinary `npm test` never discovers this file. */
export default defineConfig({
  test: {
    include: ["test/vnext/ralph-operational-m5c-real-e2e.ts"],
    fileParallelism: false,
    testTimeout: 1_200_000,
    hookTimeout: 1_200_000,
  },
});
