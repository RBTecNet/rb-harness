import { defineConfig } from "vitest/config";

/** Explicit opt-in only: ordinary `npm test` never discovers this file. */
export default defineConfig({
  test: {
    include: ["test/vnext/ralph-operational-m4c-real-e2e.ts"],
    fileParallelism: false,
    testTimeout: 900_000,
    hookTimeout: 900_000,
  },
});
