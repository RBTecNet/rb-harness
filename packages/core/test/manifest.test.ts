import { access, cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
