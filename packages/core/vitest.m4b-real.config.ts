import { defineConfig } from "vitest/config";

/** Explicit opt-in only: ordinary `npm test` never discovers this file. */
export default defineConfig({
  test: {
    include: ["test/vnext/ralph-operational-m4b-real-e2e.ts"],
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
