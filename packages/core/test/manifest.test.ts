import { access, cp, mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  initializeProject,
  loadManifest,
  resolveArtifacts,
  syncManifest,
  validateManifestTree,
} from "../src/manifest.js";

const validFixture = resolve(process.cwd(), "../../tests/fixtures/execution/valid/minimal/PHASES.md");

async function project(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "rb-harness-test-"));
  await initializeProject(root, "Fixture Project", "fixture-project");
  const target = resolve(root, ".rb/init/PHASES.md");
  await cp(validFixture, target);
  await writeFile(resolve(root, ".rb/init/PROJECT.md"), "# Fixture Project\n", "utf8");
  await syncManifest(root);
  return root;
}

describe("artifact manifest", () => {
  it("initializes review and evolution artifact roots", async () => {
    const root = await project();
    await expect(access(resolve(root, ".rb/reviews"))).resolves.toBeUndefined();
    await expect(access(resolve(root, ".rb/evolutions"))).resolves.toBeUndefined();
  });

  it("indexes execution plans with stable contract metadata", async () => {
    const root = await project();
    const manifest = await loadManifest(root);
    expect(manifest.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "init-minimal-execution",
          kind: "execution-plan",
          path: ".rb/init/PHASES.md",
          status: "ready",
          contract: "rb-execution/v1",
        }),
      ]),
    );
  });

  it("preserves an invalid execution plan's declared identity instead of adding a false ID mismatch", async () => {
    const root = await project();
    const phasesPath = resolve(root, ".rb/init/PHASES.md");
    const source = await readFile(phasesPath, "utf8");
    await writeFile(
      phasesPath,
      source.replace("AC-T001-01:", "AC-T001-01: quando aplicável "),
      "utf8",
    );

    const manifest = await syncManifest(root);
    expect(manifest.artifacts).toEqual(expect.arrayContaining([expect.objectContaining({
      id: "init-minimal-execution",
      path: ".rb/init/PHASES.md",
      status: "invalid",
      contract: "rb-execution/v1",
    })]));
    const validation = await validateManifestTree(root);
    expect(validation.issues.map((issue) => issue.code)).toContain("task.acceptance.ambiguous");
    expect(validation.issues.map((issue) => issue.code)).not.toContain("artifact.id.mismatch");
  });

  it("resolves ready execution plans without scanning conventions", async () => {
    const root = await project();
    const resolved = await resolveArtifacts(root, { kind: "execution-plan", status: "ready" });
    expect(resolved.map((entry) => entry.path)).toEqual([".rb/init/PHASES.md"]);
    const tsv = await readFile(resolve(root, ".rb/artifacts.tsv"), "utf8");
    expect(tsv).toContain("init-minimal-execution\texecution-plan\tready\trb-execution/v1\t.rb/init/PHASES.md");
  });

  it("indexes operational acceptance as an additive contract", async () => {
    const root = await project();
    await writeFile(resolve(root, ".rb/init/OPERATIONS.json"), `${JSON.stringify({
      contract: "rb-operational/v1",
      scenarios: [{ id: "consumer", title: "Consumer flow", steps: [{ id: "run", kind: "command", command: { argv: ["tool"] } }] }],
    }, null, 2)}\n`, "utf8");
    const manifest = await syncManifest(root);
    expect(manifest.artifacts).toEqual(expect.arrayContaining([expect.objectContaining({
      kind: "operational-verification",
      path: ".rb/init/OPERATIONS.json",
      status: "ready",
      contract: "rb-operational/v1",
    })]));
    expect((await validateManifestTree(root)).valid).toBe(true);
  });

  it("classifies review and evolution artifacts without consumer path guessing", async () => {
    const root = await project();
    await mkdir(resolve(root, ".rb/reviews/security-2026"), { recursive: true });
    await mkdir(resolve(root, ".rb/evolutions/service-order-stock"), { recursive: true });
    await writeFile(resolve(root, ".rb/reviews/security-2026/FINDINGS.md"), "# Findings\n", "utf8");
    await writeFile(resolve(root, ".rb/reviews/security-2026/DESIGN_SYSTEM.md"), "# Design system\n", "utf8");
    await writeFile(resolve(root, ".rb/evolutions/service-order-stock/CHANGE_REQUEST.md"), "# Change request\n", "utf8");
    await writeFile(resolve(root, ".rb/evolutions/service-order-stock/REGRESSION_MATRIX.md"), "# Regressions\n", "utf8");

    const manifest = await syncManifest(root);
    expect(manifest.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "review-findings", path: ".rb/reviews/security-2026/FINDINGS.md" }),
      expect.objectContaining({ kind: "design-system", path: ".rb/reviews/security-2026/DESIGN_SYSTEM.md" }),
      expect.objectContaining({ kind: "request", path: ".rb/evolutions/service-order-stock/CHANGE_REQUEST.md" }),
      expect.objectContaining({ kind: "regression-specification", path: ".rb/evolutions/service-order-stock/REGRESSION_MATRIX.md" }),
    ]));
    expect((await validateManifestTree(root)).valid).toBe(true);
  });

  it("allocates stable unique IDs for long and normalization-colliding artifact paths", async () => {
    const root = await project();
    const sources = resolve(root, ".rb/evolutions/studio-web-workflows/sources/normative");
    await mkdir(sources, { recursive: true });
    const longPaths = [
      resolve(sources, "rb-headless-init-v1.md"),
      resolve(sources, "rb-headless-interview-v1.md"),
    ];
    const punctuationPaths = [
      resolve(root, ".rb/evolutions/studio-web-workflows/contracts/a+b.md"),
      resolve(root, ".rb/evolutions/studio-web-workflows/contracts/a b.md"),
    ];
    await mkdir(dirname(punctuationPaths[0]!), { recursive: true });
    for (const path of [...longPaths, ...punctuationPaths]) await writeFile(path, `# ${path}\n`, "utf8");

    const first = await syncManifest(root);
    const selected = first.artifacts.filter((artifact) => [...longPaths, ...punctuationPaths]
      .some((path) => artifact.path.endsWith(path.slice(resolve(root, ".rb").length).split("\\").join("/").replace(/^\//, ""))));
    expect(selected).toHaveLength(4);
    expect(new Set(selected.map((artifact) => artifact.id)).size).toBe(4);
    expect(selected.every((artifact) => artifact.id.length <= 64)).toBe(true);

    const second = await syncManifest(root);
    expect(second.artifacts
      .filter((artifact) => selected.some((entry) => entry.path === artifact.path))
      .map((artifact) => [artifact.path, artifact.id]))
      .toEqual(selected.map((artifact) => [artifact.path, artifact.id]));
    expect((await validateManifestTree(root)).valid).toBe(true);
  });

  it("never indexes Ralph runtime state under .rb/runs", async () => {
    const root = await project();
    const runRoot = resolve(root, ".rb/runs/example-execution-deadbeef1234");
    await mkdir(resolve(runRoot, "evidence"), { recursive: true });
    await mkdir(resolve(runRoot, "prompts"), { recursive: true });
    await writeFile(resolve(runRoot, "evidence/P01-attempt-1.json"), "{}\n", "utf8");
    await writeFile(resolve(runRoot, "prompts/P01-manager.md"), "# Runtime prompt\n", "utf8");

    const manifest = await syncManifest(root);

    expect(manifest.artifacts.some((artifact) => artifact.path.startsWith(".rb/runs/"))).toBe(false);
    expect((await validateManifestTree(root)).valid).toBe(true);
  });

  it("validates and resolves a compatible manifest from a renamed artifact directory", async () => {
    const root = await project();
    await rename(resolve(root, ".rb"), resolve(root, ".spec"));

    expect((await validateManifestTree(root)).valid).toBe(false);
    expect((await validateManifestTree(root, { artifactDirectory: ".spec" })).valid).toBe(true);
    const artifacts = await resolveArtifacts(root, {
      artifactDirectory: ".spec",
      kind: "execution-plan",
      status: "ready",
    });
    expect(artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "init-minimal-execution", path: ".rb/init/PHASES.md" }),
    ]));
  });

  it("grandfathers a legacy narrative responsive inventory without a contract declaration", async () => {
    const root = await project();
    const review = resolve(root, ".rb/reviews/ui-review");
    await mkdir(review, { recursive: true });
    await writeFile(resolve(review, "RESPONSIVE_INVENTORY.md"), "# Paths\n\n- src/view.ui\n", "utf8");
    await syncManifest(root);

    const result = await validateManifestTree(root);
    expect(result.valid).toBe(true);
    expect(result.issues.map((entry) => entry.code)).not.toContain("responsive.inventory.companion");
  });

  it("rejects a review that declares the responsive contract without its JSON artifact", async () => {
    const root = await project();
    const review = resolve(root, ".rb/reviews/ui-review");
    await mkdir(review, { recursive: true });
    await writeFile(
      resolve(review, "REVIEW.md"),
      "# UI review\n\n<!-- rb-responsive-inventory-contract: rb-responsive-inventory/v1 -->\n",
      "utf8",
    );
    await writeFile(resolve(review, "RESPONSIVE_INVENTORY.md"), "# Paths\n\n- src/view.ui\n", "utf8");
    await syncManifest(root);

    const result = await validateManifestTree(root);
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({
      code: "responsive.inventory.companion",
      path: ".rb/reviews/ui-review/REVIEW.md",
    })]));
  });

  it("fails closed for a malformed operational contract", async () => {
    const root = await project();
    await writeFile(resolve(root, ".rb/init/OPERATIONS.json"), '{"contract":"wrong","scenarios":[]}\n', "utf8");
    await syncManifest(root);
    const result = await validateManifestTree(root);
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({
      code: "operational.contract",
      path: ".rb/init/OPERATIONS.json",
    })]));
  });

  it("detects artifact drift after the manifest was generated", async () => {
    const root = await project();
    const target = resolve(root, ".rb/init/PROJECT.md");
    await writeFile(target, "# Changed after sync\n", "utf8");
    const result = await validateManifestTree(root);
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "artifact.stale", path: ".rb/init/PROJECT.md" })]),
    );
  });

  it("rejects paths that escape the project", async () => {
    const root = await project();
    const manifestPath = resolve(root, ".rb/rb-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.artifacts.push({
      id: "escape",
      kind: "artifact",
      path: "../outside.md",
      status: "ready",
      sha256: "0".repeat(64),
    });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const result = await validateManifestTree(root);
    expect(result.issues.map((entry) => entry.code)).toContain("artifact.path.unsafe");
  });

  it("rejects a manifest that promotes a blocked plan to ready", async () => {
    const root = await project();
    const phasesPath = resolve(root, ".rb/init/PHASES.md");
    const phases = await readFile(phasesPath, "utf8");
    await writeFile(phasesPath, `${phases}\n<!-- rb-readiness: blocked -->\n`, "utf8");
    await syncManifest(root);

    const manifestPath = resolve(root, ".rb/rb-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.artifacts.find((artifact: { kind: string }) => artifact.kind === "execution-plan").status = "ready";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const result = await validateManifestTree(root);
    expect(result.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "artifact.status.mismatch", path: ".rb/init/PHASES.md" })]),
    );
    await expect(resolveArtifacts(root, { kind: "execution-plan", status: "ready" })).rejects.toThrow(
      "Artifact tree is invalid",
    );
  });
});
