import { access, mkdtemp, readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { validateExecutionMarkdown } from "../../src/execution-contract.js";
import { resolveArtifacts, validateManifestTree, validateManifestValue } from "../../src/manifest.js";
import { sha256Text } from "../../src/hash.js";
import { closeInitProject, runDeterministicInit } from "../../src/vnext/closure.js";
import { canonicalize } from "../../src/vnext/validate.js";
import { resolveInitProject } from "../../src/vnext/resolve.js";
import { selectReadyExecutionPlan } from "../../src/vnext/ralph-fidelity.js";
import { HELLO_REQUEST, HELLO_SEMANTIC_FIXTURE } from "./fixtures/hello.js";

async function files(root: string, relative = ""): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(resolve(root, relative), { withFileTypes: true })) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await files(root, path));
    else result.push(path);
  }
  return result.sort();
}

function context(runId: string) {
  return {
    originalRequest: HELLO_REQUEST,
    runId,
    generatedAt: "2026-08-28T12:00:00.000Z",
  } as const;
}

describe("vNext deterministic closure and publication", () => {
  it("publishes exactly the three-artifact Ralph-ready tree from exact staged bytes", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rb-vnext-hello-"));
    await mkdir(resolve(root, ".rb/init"), { recursive: true });
    await writeFile(resolve(root, ".rb/init/LEGACY.md"), "old\n");

    const result = await runDeterministicInit(structuredClone(HELLO_SEMANTIC_FIXTURE), context("hello-run"), root);
    expect(await files(resolve(root, ".rb"))).toEqual(["init/BRIEF.md", "init/PHASES.md", "rb-manifest.json"]);
    expect(await readFile(resolve(root, ".rb-harness/runs/hello-run/previous/.rb/init/LEGACY.md"), "utf8")).toBe("old\n");
    expect(result.counters).toEqual({ providerCalls: 0, adapterCalls: 0, formatterCalls: 0, repairCalls: 0, providerSpecificBranches: 0 });

    const execution = validateExecutionMarkdown(result.phases);
    expect(execution.valid).toBe(true);
    expect(execution.issues).toEqual([]);
    expect(execution.document?.phases.every((phase) => phase.context.length === 1 && phase.context[0] === "`.rb/init/BRIEF.md`")).toBe(true);
    expect(result.brief).not.toMatch(/\bT[0-9]{3}\b|AC-T[0-9]{3}-[0-9]{2}|## Phase|npm test/);
    expect(validateManifestValue(result.manifest).valid).toBe(true);
    expect((await validateManifestTree(root)).valid).toBe(true);
    expect((await resolveArtifacts(root, { kind: "execution-plan", status: "ready" })).map((entry) => entry.id)).toEqual(["hello-execution"]);
    expect(selectReadyExecutionPlan(result.manifest, result.phases).id).toBe("hello-execution");

    for (const artifact of result.manifest.artifacts) {
      const bytes = await readFile(resolve(root, artifact.path));
      expect(artifact.sha256).toBe(sha256Text(bytes));
    }
    expect(result.manifest.artifacts.find((entry) => entry.kind === "execution-plan")?.id).toBe(result.executionDocument.artifactId);
  });

  it("produces byte-identical PHASES, BRIEF, and frozen-clock manifest across equivalent runs", async () => {
    const firstRoot = await mkdtemp(resolve(tmpdir(), "rb-vnext-first-"));
    const secondRoot = await mkdtemp(resolve(tmpdir(), "rb-vnext-second-"));
    const first = await runDeterministicInit(structuredClone(HELLO_SEMANTIC_FIXTURE), context("same-run"), firstRoot);
    const second = await runDeterministicInit(structuredClone(HELLO_SEMANTIC_FIXTURE), context("same-run"), secondRoot);
    expect(Buffer.from(first.phases).equals(Buffer.from(second.phases))).toBe(true);
    expect(Buffer.from(first.brief).equals(Buffer.from(second.brief))).toBe(true);
    expect(first.manifest).toEqual(second.manifest);
    expect(first.model.phases.flatMap((phase) => phase.tasks.map((task) => task.id))).toEqual(["T001", "T002"]);
  });

  it("stops semantic failure before staging or publication", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rb-vnext-invalid-"));
    const invalid = structuredClone(HELLO_SEMANTIC_FIXTURE) as any;
    invalid.qualityCommands[0].command = "npm test || true";
    await expect(runDeterministicInit(invalid, context("invalid-run"), root)).rejects.toThrow("SEMANTIC_INVALID");
    await expect(access(resolve(root, ".rb"))).rejects.toThrow();
    await expect(access(resolve(root, ".rb-harness"))).rejects.toThrow();
  });

  it("enforces determination key grammar when closeInitProject receives a model directly", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rb-vnext-direct-invalid-"));
    const resolved = resolveInitProject(structuredClone(HELLO_SEMANTIC_FIXTURE), context("direct-invalid-run"));
    if (!resolved.ok) throw new Error("fixture did not resolve");
    const model = structuredClone(canonicalize(resolved.value)) as any;
    model.core.determinations[0].key = "A";
    await expect(closeInitProject(model, root)).rejects.toThrow("I-16");
    await expect(access(resolve(root, ".rb"))).rejects.toThrow();
  });
});
