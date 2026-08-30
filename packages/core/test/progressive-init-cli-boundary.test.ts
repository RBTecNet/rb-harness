import { afterEach, describe, expect, it } from "vitest";
import { runHarnessCli } from "../src/cli-program.js";

const originalArgv = [...process.argv];

afterEach(() => {
  process.argv = [...originalArgv];
});

describe("Progressive Init Phase-1 CLI boundary", () => {
  it("rejects --stage with the canonical dashboard before semantic execution", async () => {
    process.argv = [process.execPath, "rb-harness", "init", "--stage", "project-description", "--dashboard"];
    await expect(runHarnessCli()).rejects.toThrow("PROGRESSIVE_INIT_DASHBOARD_NOT_IMPLEMENTED_PHASE_1");
  });
});
