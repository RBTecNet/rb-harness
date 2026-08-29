import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateExecutionMarkdown } from "../../src/execution-contract.js";
import { loadManifest, validateManifestTree, validateManifestValue } from "../../src/manifest.js";
import { selectReadyExecutionPlan } from "../../src/vnext/ralph-fidelity.js";

const EVIDENCE_ROOT = fileURLToPath(new URL("./live-evidence/phase3-underspecified-headless/", import.meta.url));

async function files(root: string, relative = ""): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(resolve(root, relative), { withFileTypes: true })) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await files(root, path));
    else result.push(path);
  }
  return result.sort();
}

describe("persisted real Phase 3 underspecified-request evidence", () => {
  it("replays Ralph, manifest, exact-tree and recommendation authority checks offline", async () => {
    const summary = JSON.parse(await readFile(resolve(EVIDENCE_ROOT, "run-evidence.json"), "utf8")) as any;
    expect(summary.originalRequest).toBe("Build me a simple inventory system.");
    expect(summary).toMatchObject({
      selectedProfileId: "anthropic:claude-code-cli:claude-opus-5",
      transport: "claude-code-cli",
      requestAccounting: "opaque",
      terminalState: "published",
      publicationOccurred: true,
      ralph: { status: "READY" },
    });
    expect(summary.questions.length).toBeGreaterThan(0);
    expect(summary.questions.every((question: any) => question.acceptanceMode === "non-interactive-policy"
      && question.selectedValue === question.recommendedValue
      && question.question.trim()
      && question.recommendedRationale.trim())).toBe(true);

    expect(await files(resolve(EVIDENCE_ROOT, ".rb"))).toEqual(["init/BRIEF.md", "init/PHASES.md", "rb-manifest.json"]);
    const manifest = await loadManifest(EVIDENCE_ROOT);
    expect(validateManifestValue(manifest)).toMatchObject({ valid: true, issues: [] });
    expect(await validateManifestTree(EVIDENCE_ROOT)).toMatchObject({ valid: true, issues: [] });
    const phases = await readFile(resolve(EVIDENCE_ROOT, ".rb", "init", "PHASES.md"), "utf8");
    const ralph = validateExecutionMarkdown(phases);
    expect(ralph).toMatchObject({ valid: true, issues: [] });
    expect(selectReadyExecutionPlan(manifest, phases).status).toBe("ready");
    const tasks = ralph.document!.phases.flatMap((phase) => phase.tasks);
    expect(tasks.length).toBeGreaterThanOrEqual(2);
    expect(tasks.every((task) => task.change.trim().length >= 20
      && task.scope.length > 0
      && task.acceptanceCriteria.length > 0
      && task.validation.length > 0
      && task.expectedEvidence.trim().length >= 12)).toBe(true);

    const brief = await readFile(resolve(EVIDENCE_ROOT, ".rb", "init", "BRIEF.md"), "utf8");
    expect(brief).toMatch(/## Objective[\s\S]+## Confirmed determinations[\s\S]+## Requirements/);
    expect(brief).not.toMatch(/acceptanceMode|transportInvocations|correctiveRegenerations|raw response/i);
  });

  it("contains no credential, identity or local-path material and is not imported by production", async () => {
    for (const path of await files(EVIDENCE_ROOT)) {
      const source = await readFile(resolve(EVIDENCE_ROOT, path), "utf8");
      expect(source, path).not.toMatch(/(?:x-api-key|authorization\s*:|oauth(?:\s+token|\s+identity)|session\s+token|api[_ -]?key|\/home\/[^\s"']+)/i);
      if (path.endsWith(".json")) {
        const walk = (value: unknown): void => {
          if (!value || typeof value !== "object") return;
          for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
            expect(key).not.toMatch(/^(?:authorization|apiKey|oauthToken|sessionToken|credentialSecret|accountId|email)$/i);
            walk(child);
          }
        };
        walk(JSON.parse(source));
      }
    }
    const sourceRoot = fileURLToPath(new URL("../../src/", import.meta.url));
    for (const path of await files(sourceRoot)) {
      if (!/\.(?:ts|js)$/.test(path)) continue;
      expect(await readFile(resolve(sourceRoot, path), "utf8"), path).not.toContain("phase3-underspecified-headless");
    }
  });
});
