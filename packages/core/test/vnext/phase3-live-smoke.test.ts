import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runSemanticInit } from "../../src/vnext/init.js";
import { defaultConformanceRecordsRoot } from "../../src/vnext/providers/conformance/cli.js";
import {
  loadVerifiedProviderProfile,
  resolveProviderAdapter,
  resolveProviderAuth,
} from "../../src/vnext/providers/registry.js";
import { CLAUDE_CODE_OPUS_5_PROFILE_ID } from "../../src/vnext/providers/anthropic/claude-code/profiles.js";

const live = process.env.RB_VNEXT_LIVE_INIT === "1" ? it : it.skip;

async function artifactTree(root: string, relative = ""): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(resolve(root, relative), { withFileTypes: true })) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await artifactTree(root, path));
    else result.push(path);
  }
  return result.sort();
}

describe("explicit Phase 3 Claude Code subscription smoke", () => {
  live("publishes a complete request through the exact conformed CLI profile", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rb-vnext-phase3-live-"));
    try {
      const profile = await loadVerifiedProviderProfile(
        CLAUDE_CODE_OPUS_5_PROFILE_ID,
        defaultConformanceRecordsRoot(),
      );
      const adapter = resolveProviderAdapter(profile.id);
      const auth = await resolveProviderAuth(profile);
      const result = await runSemanticInit({
        originalRequest: [
          "Create a Node.js command-line program named hello.",
          "Running node bin/hello.js Ada prints exactly Hello, Ada! and exits successfully.",
          "Running node bin/hello.js without a name prints exactly Hello, world! and exits successfully.",
          "Put automated tests in test/hello.test.js and use npm test as the quality command.",
        ].join(" "),
        projectRoot: root,
        profile,
        adapter,
        auth,
        interview: { kind: "headless" },
        runId: "phase3-live-claude-code-opus-5",
        deadlineMs: 180_000,
      });
      const tree = await artifactTree(resolve(root, ".rb"));
      expect(tree).toEqual(["init/BRIEF.md", "init/PHASES.md", "rb-manifest.json"]);
      expect(result.runState.stage).toBe("published");
      expect(result.runState.counters.providerRequests).toEqual({ measured: false, reason: "unsupported-by-provider" });
      process.stdout.write(`${JSON.stringify({
        profile: profile.id,
        transport: profile.transport,
        requestAccounting: profile.requestAccounting,
        semanticOperations: result.runState.counters.semanticOperations,
        transportInvocations: result.runState.counters.transportInvocations,
        transportRetries: result.runState.counters.transportRetries,
        correctiveRegenerations: result.runState.counters.correctiveRegenerations,
        questions: result.runState.questions.map((question) => ({
          key: question.key,
          acceptanceMode: question.acceptanceMode,
        })),
        providerRequests: result.runState.counters.providerRequests,
        artifactTree: tree,
        ralph: "READY",
      })}\n`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 480_000);
});
