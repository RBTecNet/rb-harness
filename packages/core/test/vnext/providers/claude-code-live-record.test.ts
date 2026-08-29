import { afterEach, describe, it } from "vitest";
import { runVnextConformanceCommand } from "../../../src/vnext/providers/conformance/cli.js";
import { CLAUDE_CODE_OPUS_5_PROFILE_ID } from "../../../src/vnext/providers/anthropic/claude-code/profiles.js";

const live = process.env.RB_RECORD_CLAUDE_CODE_CONFORMANCE === "1" ? it : it.skip;
const previousExitCode = process.exitCode;

afterEach(() => {
  process.exitCode = previousExitCode;
});

describe("explicit Claude Code subscription conformance recording", () => {
  live("records the exact profile through the public conformance command", async () => {
    await runVnextConformanceCommand({
      profileId: CLAUDE_CODE_OPUS_5_PROFILE_ID,
      record: true,
    });
  }, 180_000);
});
