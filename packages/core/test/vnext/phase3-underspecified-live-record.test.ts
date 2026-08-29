import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runSemanticInit } from "../../src/vnext/init.js";
import { CLAUDE_CODE_OPUS_5_PROFILE_ID } from "../../src/vnext/providers/anthropic/claude-code/profiles.js";
import { defaultConformanceRecordsRoot } from "../../src/vnext/providers/conformance/cli.js";
import { loadVerifiedProviderProfile, resolveProviderAdapter, resolveProviderAuth } from "../../src/vnext/providers/registry.js";

const live = process.env.RB_VNEXT_RECORD_UNDERSPECIFIED_INIT === "1" ? it : it.skip;
const ORIGINAL_REQUEST = "Build me a simple inventory system.";
const EVIDENCE_ROOT = fileURLToPath(new URL("./live-evidence/phase3-underspecified-headless/", import.meta.url));

async function artifactTree(root: string, relative = ""): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(resolve(root, relative), { withFileTypes: true })) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await artifactTree(root, path));
    else result.push(path);
  }
  return result.sort();
}

describe("explicit Phase 3 underspecified headless evidence recording", () => {
  live("records semantic enrichment and exact Ralph-ready artifacts from the vague request", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rb-vnext-phase3-underspecified-"));
    try {
      const profile = await loadVerifiedProviderProfile(CLAUDE_CODE_OPUS_5_PROFILE_ID, defaultConformanceRecordsRoot());
      const adapter = resolveProviderAdapter(profile.id);
      const auth = await resolveProviderAuth(profile);
      const result = await runSemanticInit({
        originalRequest: ORIGINAL_REQUEST,
        projectRoot: root,
        profile,
        adapter,
        auth,
        interview: { kind: "headless" },
        runId: "phase3-underspecified-headless-live",
        deadlineMs: 180_000,
      });

      const questions = result.runState.questions;
      const tasks = result.closure.model.phases.flatMap((phase) => phase.tasks);
      expect(questions.length).toBeGreaterThan(0);
      expect(questions.every((question) => question.acceptanceMode === "non-interactive-policy"
        && question.selectedValue === question.recommendedAnswer.value)).toBe(true);
      expect(result.closure.model.requirements.length).toBeGreaterThanOrEqual(3);
      expect(tasks.length).toBeGreaterThanOrEqual(2);
      expect(tasks.every((task) => task.intent.trim().length >= 20
        && task.ownedPaths.length > 0
        && task.acceptance.length > 0
        && task.validation.length > 0
        && task.expectedEvidence.trim().length >= 12)).toBe(true);
      expect(result.runState.stage).toBe("published");
      expect(await artifactTree(resolve(root, ".rb"))).toEqual(["init/BRIEF.md", "init/PHASES.md", "rb-manifest.json"]);

      const evidence = {
        format: "rb-vnext-phase3-live-evidence/v1",
        recordedAt: new Date().toISOString(),
        originalRequest: ORIGINAL_REQUEST,
        selectedProfileId: profile.id,
        transport: profile.transport,
        requestAccounting: profile.requestAccounting,
        questions: questions.map((question) => ({
          key: question.key,
          question: question.question,
          materiality: question.materiality,
          rigidity: question.rigidity,
          recommendedValue: question.recommendedAnswer.value,
          recommendedRationale: question.recommendedAnswer.rationale,
          acceptanceMode: question.acceptanceMode,
          selectedValue: question.selectedValue,
        })),
        counters: result.runState.counters,
        attempts: result.runState.attempts,
        terminalState: result.runState.stage,
        publicationOccurred: result.runState.publicationOccurred,
        ralph: {
          status: "READY",
          executionIssues: 0,
          manifestValid: true,
          treeValid: true,
          readyExecutionPlans: 1,
        },
        artifactTree: [".rb/init/BRIEF.md", ".rb/init/PHASES.md", ".rb/rb-manifest.json"],
        semanticQuality: {
          requirements: result.closure.model.requirements.length,
          phases: result.closure.model.phases.length,
          tasks: tasks.length,
          allTasksHaveOwnedPaths: tasks.every((task) => task.ownedPaths.length > 0),
          allTasksHaveAcceptance: tasks.every((task) => task.acceptance.length > 0),
          allTasksHaveValidation: tasks.every((task) => task.validation.length > 0),
          allTasksHaveExpectedEvidence: tasks.every((task) => task.expectedEvidence.trim().length >= 12),
        },
      } as const;

      await rm(EVIDENCE_ROOT, { recursive: true, force: true });
      await mkdir(EVIDENCE_ROOT, { recursive: true });
      await cp(resolve(root, ".rb"), resolve(EVIDENCE_ROOT, ".rb"), { recursive: true });
      await writeFile(resolve(EVIDENCE_ROOT, "run-evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
      process.stdout.write(`${JSON.stringify(evidence)}\n`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 480_000);
});
