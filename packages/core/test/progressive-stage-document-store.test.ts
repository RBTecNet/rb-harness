import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectProgressiveInit, runProgressiveInit } from "../src/vnext/progressive-init/coordinator.js";
import {
  loadProjectDescription,
  writeProjectDescriptionAtomically,
} from "../src/vnext/progressive-init/project-description-store.js";
import {
  loadStrictStageDocument,
  strictStageDocumentPath,
  writeStrictStageDocumentAtomically,
} from "../src/vnext/progressive-init/stage-document-store.js";
import { resolveProviderProfile } from "../src/vnext/providers/registry.js";
import {
  PROGRESSIVE_FIXTURE_AUTH,
  PROGRESSIVE_FIXTURE_REQUEST,
  ProgressiveFixtureAdapter,
  supportedFixtureProfile,
} from "./support/progressive-dashboard.js";

const RAW_STAGE = {
  fileName: "project-description.md",
  temporaryPrefix: "project-description",
  concurrentModificationCode: "PROJECT_DESCRIPTION_CONCURRENT_MODIFICATION",
  parse: (source: string) => source,
} as const;

async function writeAndInspectProjectDescription(projectRoot: string): Promise<void> {
  const seedRoot = await mkdtemp(resolve(tmpdir(), "rb-stage-store-seed-"));
  const profile = supportedFixtureProfile(resolveProviderProfile("deepseek:deepseek-v4-pro"));
  const adapter = new ProgressiveFixtureAdapter(profile);
  const result = await runProgressiveInit({
    projectRoot: seedRoot,
    originalRequest: PROGRESSIVE_FIXTURE_REQUEST,
    selectedStage: "project-description",
    profile,
    adapter,
    auth: PROGRESSIVE_FIXTURE_AUTH,
    interview: { kind: "headless" },
  });
  if (!result.artifactPath) throw new Error("fixture did not produce a project-description");
  const source = await readFile(result.artifactPath, "utf8");
  expect(await writeProjectDescriptionAtomically(projectRoot, source, undefined))
    .toBe(resolve(projectRoot, ".spec/init/project-description.md"));
  const loaded = await loadProjectDescription(projectRoot);
  expect(loaded?.document.value.originalRequest).toBe(PROGRESSIVE_FIXTURE_REQUEST);
  expect(loaded?.source).toContain("rb-project-description/v1");
  expect((await inspectProgressiveInit(projectRoot, PROGRESSIVE_FIXTURE_REQUEST)).map((stage) => stage.status))
    .toEqual(["complete-fresh", "incomplete", "incomplete", "incomplete"]);
}

describe("Progressive stage document logical project roots", () => {
  it("saves, strictly loads, and inspects a project addressed through a symlinked root", async () => {
    const sandbox = await mkdtemp(resolve(tmpdir(), "rb-stage-store-root-link-"));
    const realProject = resolve(sandbox, "real-project");
    const projectLink = resolve(sandbox, "project-link");
    await mkdir(realProject);
    await symlink(realProject, projectLink, "dir");

    await writeAndInspectProjectDescription(projectLink);
    expect(await readFile(resolve(realProject, ".spec/init/project-description.md"), "utf8"))
      .toContain("rb-project-description/v1");
  });

  it("saves, strictly loads, and inspects through an intermediate symlink component", async () => {
    const sandbox = await mkdtemp(resolve(tmpdir(), "rb-stage-store-intermediate-link-"));
    const realParent = resolve(sandbox, "real-workspaces");
    const realProject = resolve(realParent, "project");
    const linkedParent = resolve(sandbox, "workspace-link");
    await mkdir(realProject, { recursive: true });
    await symlink(realParent, linkedParent, "dir");

    const logicalProject = resolve(linkedParent, "project");
    await writeAndInspectProjectDescription(logicalProject);
    expect(await readFile(resolve(realProject, ".spec/init/project-description.md"), "utf8"))
      .toContain("rb-project-description/v1");
  });

  it("preserves stage save, strict load, inspection, and freshness on a real path", async () => {
    const projectRoot = await mkdtemp(resolve(tmpdir(), "rb-stage-store-real-root-"));
    await writeAndInspectProjectDescription(projectRoot);
  });

  it("rejects traversal and resolved escape while preserving external bytes", async () => {
    const projectRoot = await mkdtemp(resolve(tmpdir(), "rb-stage-store-escape-root-"));
    const external = await mkdtemp(resolve(tmpdir(), "rb-stage-store-escape-external-"));
    await mkdir(resolve(external, "init"));
    const externalStage = resolve(external, "init/project-description.md");
    await writeFile(externalStage, "external bytes must remain unchanged\n", "utf8");
    const before = await readFile(externalStage);
    await symlink(external, resolve(projectRoot, ".spec"), "dir");

    await expect(loadStrictStageDocument(projectRoot, RAW_STAGE))
      .rejects.toThrow(/UNSAFE_PROGRESSIVE_INIT_PATH.*resolves outside the project root/);
    await expect(writeStrictStageDocumentAtomically(projectRoot, RAW_STAGE, "replacement\n", undefined))
      .rejects.toThrow(/UNSAFE_PROGRESSIVE_INIT_PATH.*resolves outside the project root/);

    const traversalDefinition = { ...RAW_STAGE, fileName: "../escaped.md" };
    expect(() => strictStageDocumentPath(projectRoot, traversalDefinition))
      .toThrow("INVALID_PROGRESSIVE_INIT_STAGE_FILE");
    await expect(writeStrictStageDocumentAtomically(projectRoot, traversalDefinition, "escape\n", undefined))
      .rejects.toThrow("INVALID_PROGRESSIVE_INIT_STAGE_FILE");
    expect((await readFile(externalStage)).toString("hex")).toBe(before.toString("hex"));
  });
});
