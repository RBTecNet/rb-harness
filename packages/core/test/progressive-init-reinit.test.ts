import { mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { collectInitWizardConfiguration } from "../src/init-wizard.js";
import type { WizardPrompt } from "../src/harness-wizard.js";
import {
  askProgressiveConfirmation,
  PROGRESSIVE_REINIT_CONFIRMATION_OPTIONS,
  progressiveReinitConfirmationRequest,
  renderProgressiveConfirmation,
} from "../src/vnext/progressive-init/dashboard/confirm.js";
import { createProgressiveSelectionState } from "../src/vnext/progressive-init/dashboard/selection.js";
import {
  assertProgressiveRalphReadiness,
  progressiveStageNeedsReadinessWork,
  projectProgressiveRalphReadiness,
} from "../src/vnext/progressive-init/readiness.js";
import {
  planProgressiveInitPurge,
  ProgressiveInitPurgeUnsafeError,
  purgeProgressiveInitArtifacts,
  verifyProgressiveInitPurgeCandidate,
} from "../src/vnext/progressive-init/purge.js";
import { fakeProgressiveTerminal, key } from "./support/progressive-dashboard.js";
import { resolveProviderProfile } from "../src/vnext/providers/registry.js";

async function write(root: string, relative: string, content: string): Promise<string> {
  const path = resolve(root, relative);
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, content, "utf8");
  return path;
}

/**
 * A project that contains both the complete Harness-owned Progressive artifact
 * set and ordinary developer content that must survive a purge untouched.
 */
async function mixedProject(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "rb-progressive-purge-"));
  for (const stage of ["project-description", "user-stories", "database-schema", "project-phases"]) {
    await write(root, `.spec/init/${stage}.md`, `# ${stage}\n`);
  }
  await write(root, ".spec/notes.md", "developer notes that are not Harness-owned\n");
  await write(root, ".rb/init/BRIEF.md", "# BRIEF\n");
  await write(root, ".rb/init/PHASES.md", "# PHASES\n");
  await write(root, ".rb/rb-manifest.json", "{}\n");
  await write(root, ".rb-harness/progressive-init/project-description.json", "{}\n");
  await write(root, ".rb-harness/runs/progressive-abc/vnext-init-state.json", "{}\n");
  await write(root, ".rb-harness/runs/progressive-abc/staging/.rb/init/PHASES.md", "# staged\n");
  await write(root, ".rb-harness/runs/canonical-xyz/vnext-init-state.json", "{}\n");
  await write(root, ".rb-harness/verifications/2026/report.json", "{}\n");
  await write(root, "src/app.ts", "export const app = 1;\n");
  await write(root, "test/app.test.ts", "// developer test\n");
  await write(root, "package.json", "{ \"name\": \"developer-project\" }\n");
  await write(root, "README.md", "# developer project\n");
  await write(root, ".git/HEAD", "ref: refs/heads/main\n");
  await write(root, ".gitignore", "node_modules\n");
  return root;
}

describe("Progressive Init Ralph readiness projection", () => {
  it("is established only when every stage is fresh and closure is fresh", () => {
    const fresh = projectProgressiveRalphReadiness([
      { stage: "project-description", status: "complete-fresh" },
      { stage: "user-stories", status: "complete-fresh" },
      { stage: "database-schema", status: "complete-fresh" },
      { stage: "project-phases", status: "complete-fresh", closureStatus: "fresh" },
    ]);
    expect(fresh).toMatchObject({ ready: true, closureStatus: "fresh", reasons: [] });

    const staleClosure = projectProgressiveRalphReadiness([
      { stage: "project-description", status: "complete-fresh" },
      { stage: "user-stories", status: "complete-fresh" },
      { stage: "database-schema", status: "complete-fresh" },
      { stage: "project-phases", status: "complete-fresh", closureStatus: "stale" },
    ]);
    expect(staleClosure.ready).toBe(false);
    expect(staleClosure.reasons).toEqual(["canonical closure is stale"]);

    const staleStage = projectProgressiveRalphReadiness([
      { stage: "project-description", status: "complete-fresh" },
      { stage: "user-stories", status: "complete-stale" },
      { stage: "database-schema", status: "incomplete" },
      { stage: "project-phases", status: "incomplete" },
    ]);
    expect(staleStage.ready).toBe(false);
    expect(staleStage.reasons).toContain("User Stories is complete-stale");
    expect(staleStage.reasons).toContain("canonical closure is absent");
  });

  it("proves P4 fresh is not closure fresh and is not Ralph READY", () => {
    const p4FreshWithoutClosure = [
      { stage: "project-description", status: "complete-fresh" },
      { stage: "user-stories", status: "complete-fresh" },
      { stage: "database-schema", status: "complete-fresh" },
      { stage: "project-phases", status: "complete-fresh" },
    ] as const;
    expect(progressiveStageNeedsReadinessWork(p4FreshWithoutClosure[3])).toBe(true);
    const readiness = projectProgressiveRalphReadiness(p4FreshWithoutClosure);
    expect(readiness).toMatchObject({ ready: false, reasons: ["canonical closure is absent"] });
    expect(() => assertProgressiveRalphReadiness(p4FreshWithoutClosure))
      .toThrow("PROGRESSIVE_INIT_CLOSURE_DID_NOT_COMPLETE");
  });
});

describe("Progressive Init reinitialization confirmation", () => {
  it("recommends No and never renders Yes as the default", () => {
    const request = progressiveReinitConfirmationRequest("/home/dev/project");
    expect(request.options.map((option) => [option.id, option.recommended])).toEqual([["no", true], ["yes", false]]);
    const frame = renderProgressiveConfirmation(
      request,
      createProgressiveSelectionState(PROGRESSIVE_REINIT_CONFIRMATION_OPTIONS),
      { width: 76, height: 20, color: false, unicode: true },
    );
    expect(frame).toContain("This project is already Ralph READY.");
    expect(frame).toContain("permanently remove the existing RB");
    expect(frame).toContain("Harness Init artifacts and start again from P1.");
    expect(frame).toContain("❯ No     Recommended");
    expect(frame).toContain("Yes");
    expect(frame).not.toContain("\u276f Yes");
    expect(frame).toContain("↑ ↓ Select · Enter Confirm");
  });

  it("returns No on a bare Enter and Yes only after an explicit move", async () => {
    const declineTerminal = fakeProgressiveTerminal();
    const decline = askProgressiveConfirmation(declineTerminal, progressiveReinitConfirmationRequest("/p"));
    declineTerminal.press(key("enter"));
    expect(await decline).toBe("no");

    const acceptTerminal = fakeProgressiveTerminal();
    const accept = askProgressiveConfirmation(acceptTerminal, progressiveReinitConfirmationRequest("/p"));
    acceptTerminal.press(key("down"), key("enter"));
    expect(await accept).toBe("yes");
  });

  it("refuses to run without a TTY instead of assuming a decision", async () => {
    const headless = { ...fakeProgressiveTerminal(), interactive: false };
    await expect(askProgressiveConfirmation(headless, progressiveReinitConfirmationRequest("/p")))
      .rejects.toThrow("PROGRESSIVE_CONFIRMATION_REQUIRES_TTY");
  });

  it("ends the wizard with zero configuration when the developer declines", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rb-progressive-decline-"));
    const asked: string[] = [];
    const io: WizardPrompt = {
      ask: async (prompt) => { asked.push(prompt); return ""; },
      write: () => undefined,
    };
    const collected = await collectInitWizardConfiguration(io, {
      cwd: root,
      profiles: [],
      preflight: async () => "already-ralph-ready",
    });
    expect(collected).toEqual({ kind: "already-ralph-ready", projectRoot: root });
    // Only the project-folder question was asked: no provider, model or request.
    expect(asked).toHaveLength(1);
  });

  it("records Yes as intent while a later final No performs no mutation", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rb-progressive-intent-only-"));
    await write(root, ".rb/init/BRIEF.md", "original READY bytes\n");
    const answers = ["", "", "", "", "Build a small service.", ".", "n"];
    const io: WizardPrompt = {
      ask: async () => {
        const answer = answers.shift();
        if (answer === undefined) throw new Error("scripted wizard input exhausted");
        return answer;
      },
      write: () => undefined,
    };
    const collected = await collectInitWizardConfiguration(io, {
      cwd: root,
      profiles: [resolveProviderProfile("openai:codex:gpt-5.6-sol")],
      preflight: async () => "reinitialize",
    });
    expect(collected.kind).toBe("configured");
    if (collected.kind !== "configured") throw new Error("expected configured intent");
    expect(collected.configuration).toMatchObject({ reinitialize: true, execute: false });
    expect(await readFile(resolve(root, ".rb/init/BRIEF.md"), "utf8")).toBe("original READY bytes\n");
  });
});

describe("Progressive Init purge ownership boundary", () => {
  it("enumerates only the Harness-owned Progressive artifact set", async () => {
    const root = await mixedProject();
    const plan = await planProgressiveInitPurge(root);
    const relative = plan.targets.map((target) => target.path.slice(root.length + 1)).sort();
    expect(relative).toEqual([
      ".rb-harness/progressive-init/project-description.json",
      ".rb-harness/runs/progressive-abc",
      ".rb/init/BRIEF.md",
      ".rb/init/PHASES.md",
      ".rb/rb-manifest.json",
      ".spec/init/database-schema.md",
      ".spec/init/project-description.md",
      ".spec/init/project-phases.md",
      ".spec/init/user-stories.md",
    ]);
  });

  it("removes every Harness artifact and leaves the project intact", async () => {
    const root = await mixedProject();
    const report = await purgeProgressiveInitArtifacts(root);

    expect(report.removedFiles).toHaveLength(8);
    expect(report.removedDirectories).toHaveLength(1);

    // Harness-owned Progressive artifacts are gone.
    for (const gone of [
      ".spec/init/project-description.md", ".spec/init/user-stories.md",
      ".spec/init/database-schema.md", ".spec/init/project-phases.md",
      ".rb/init/BRIEF.md", ".rb/init/PHASES.md", ".rb/rb-manifest.json",
      ".rb-harness/progressive-init/project-description.json",
      ".rb-harness/runs/progressive-abc/vnext-init-state.json",
    ]) {
      await expect(readFile(resolve(root, gone), "utf8")).rejects.toThrow();
    }

    // Source, git, package manifests, unrelated project files and non-Progressive
    // Harness state all survive.
    expect(await readFile(resolve(root, "src/app.ts"), "utf8")).toContain("export const app");
    expect(await readFile(resolve(root, "test/app.test.ts"), "utf8")).toContain("developer test");
    expect(await readFile(resolve(root, "package.json"), "utf8")).toContain("developer-project");
    expect(await readFile(resolve(root, "README.md"), "utf8")).toContain("developer project");
    expect(await readFile(resolve(root, ".git/HEAD"), "utf8")).toContain("refs/heads/main");
    expect(await readFile(resolve(root, ".gitignore"), "utf8")).toContain("node_modules");
    expect(await readFile(resolve(root, ".spec/notes.md"), "utf8")).toContain("developer notes");
    expect(await readFile(resolve(root, ".rb-harness/runs/canonical-xyz/vnext-init-state.json"), "utf8")).toBe("{}\n");
    expect(await readFile(resolve(root, ".rb-harness/verifications/2026/report.json"), "utf8")).toBe("{}\n");

    // A shared container that still holds developer content is preserved.
    expect(await readdir(resolve(root, ".spec"))).toEqual(["notes.md"]);
    // Emptied Harness-owned containers are removed.
    await expect(readdir(resolve(root, ".rb"))).rejects.toThrow();
    await expect(readdir(resolve(root, ".rb-harness/progressive-init"))).rejects.toThrow();
  });

  it("is idempotent and safe on a project with no Progressive artifacts", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rb-progressive-empty-"));
    await write(root, "src/app.ts", "export const app = 1;\n");
    const first = await purgeProgressiveInitArtifacts(root);
    expect(first.removedFiles).toEqual([]);
    expect(first.removedDirectories).toEqual([]);
    const second = await purgeProgressiveInitArtifacts(root);
    expect(second.removedFiles).toEqual([]);
    expect(await readFile(resolve(root, "src/app.ts"), "utf8")).toContain("export const app");
  });

  it("fails closed on a symlinked candidate and deletes nothing", async () => {
    const root = await mixedProject();
    const outside = await mkdtemp(resolve(tmpdir(), "rb-progressive-outside-"));
    await write(outside, "secret.md", "must never be followed\n");
    await mkdir(resolve(root, ".spec", "init"), { recursive: true });
    const link = resolve(root, ".spec", "init", "user-stories.md");
    await writeFile(link, "temporary", "utf8");
    await (async () => {
      const { unlink } = await import("node:fs/promises");
      await unlink(link);
    })();
    await symlink(resolve(outside, "secret.md"), link);

    await expect(purgeProgressiveInitArtifacts(root)).rejects.toBeInstanceOf(ProgressiveInitPurgeUnsafeError);
    // Nothing was removed: the plan is verified before the first deletion.
    expect(await readFile(resolve(root, ".spec/init/project-description.md"), "utf8")).toContain("project-description");
    expect(await readFile(resolve(root, ".rb/rb-manifest.json"), "utf8")).toBe("{}\n");
    expect(await readFile(resolve(outside, "secret.md"), "utf8")).toContain("must never be followed");
  });

  for (const ancestor of [".spec", ".rb", ".rb-harness"] as const) {
    it(`fails closed when ${ancestor} is a symlinked ancestor and preserves external bytes`, async () => {
      const root = await mkdtemp(resolve(tmpdir(), "rb-progressive-ancestor-root-"));
      const outside = await mkdtemp(resolve(tmpdir(), "rb-progressive-ancestor-outside-"));
      await write(root, "README.md", "ordinary project file\n");
      await write(outside, "init/BRIEF.md", "external brief\n");
      await write(outside, "init/PHASES.md", "external phases\n");
      await write(outside, "rb-manifest.json", "external manifest\n");
      await write(outside, "progressive-init/project-description.json", "external stage record\n");
      await write(outside, "runs/progressive-external/staging/.rb/init/PHASES.md", "external recursive tree\n");
      const before = await Promise.all([
        readFile(resolve(outside, "init/BRIEF.md")),
        readFile(resolve(outside, "init/PHASES.md")),
        readFile(resolve(outside, "rb-manifest.json")),
        readFile(resolve(outside, "progressive-init/project-description.json")),
        readFile(resolve(outside, "runs/progressive-external/staging/.rb/init/PHASES.md")),
      ]);
      await symlink(outside, resolve(root, ancestor));

      await expect(purgeProgressiveInitArtifacts(root)).rejects.toBeInstanceOf(ProgressiveInitPurgeUnsafeError);
      const after = await Promise.all([
        readFile(resolve(outside, "init/BRIEF.md")),
        readFile(resolve(outside, "init/PHASES.md")),
        readFile(resolve(outside, "rb-manifest.json")),
        readFile(resolve(outside, "progressive-init/project-description.json")),
        readFile(resolve(outside, "runs/progressive-external/staging/.rb/init/PHASES.md")),
      ]);
      expect(after.map((bytes) => bytes.toString("hex"))).toEqual(before.map((bytes) => bytes.toString("hex")));
      expect(await readFile(resolve(root, "README.md"), "utf8")).toBe("ordinary project file\n");
    });
  }

  it("fails closed on a symlink below an otherwise real ancestor", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rb-progressive-descendant-link-"));
    const outside = await mkdtemp(resolve(tmpdir(), "rb-progressive-descendant-outside-"));
    await mkdir(resolve(root, ".spec"));
    await write(outside, "project-description.md", "external stage\n");
    await symlink(outside, resolve(root, ".spec", "init"));
    await expect(purgeProgressiveInitArtifacts(root)).rejects.toBeInstanceOf(ProgressiveInitPurgeUnsafeError);
    expect(await readFile(resolve(outside, "project-description.md"), "utf8")).toBe("external stage\n");
  });

  it("rejects a project root whose identity is presented through a symlink", async () => {
    const realRoot = await mkdtemp(resolve(tmpdir(), "rb-progressive-real-root-"));
    const linkParent = await mkdtemp(resolve(tmpdir(), "rb-progressive-root-link-"));
    const linkedRoot = resolve(linkParent, "project");
    await write(realRoot, ".spec/init/project-description.md", "must survive\n");
    await symlink(realRoot, linkedRoot);
    await expect(purgeProgressiveInitArtifacts(linkedRoot)).rejects.toBeInstanceOf(ProgressiveInitPurgeUnsafeError);
    expect(await readFile(resolve(realRoot, ".spec/init/project-description.md"), "utf8")).toBe("must survive\n");
  });

  it("rejects traversal and paths outside the explicit Progressive namespace", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rb-progressive-traversal-"));
    const plan = await planProgressiveInitPurge(root);
    await expect(verifyProgressiveInitPurgeCandidate(plan.rootIdentity, ".spec/init/../README.md", "file"))
      .rejects.toBeInstanceOf(ProgressiveInitPurgeUnsafeError);
    await expect(verifyProgressiveInitPurgeCandidate(plan.rootIdentity, "../outside", "file"))
      .rejects.toBeInstanceOf(ProgressiveInitPurgeUnsafeError);
    await expect(verifyProgressiveInitPurgeCandidate(plan.rootIdentity, "README.md", "file"))
      .rejects.toBeInstanceOf(ProgressiveInitPurgeUnsafeError);
  });

  it("rejects unexpected entry kinds before deleting any valid target", async () => {
    const directoryInsteadOfFile = await mkdtemp(resolve(tmpdir(), "rb-progressive-wrong-file-kind-"));
    await mkdir(resolve(directoryInsteadOfFile, ".spec/init/project-description.md"), { recursive: true });
    await write(directoryInsteadOfFile, ".rb/init/BRIEF.md", "must survive\n");
    await expect(purgeProgressiveInitArtifacts(directoryInsteadOfFile)).rejects.toBeInstanceOf(ProgressiveInitPurgeUnsafeError);
    expect(await readFile(resolve(directoryInsteadOfFile, ".rb/init/BRIEF.md"), "utf8")).toBe("must survive\n");

    const fileInsteadOfDirectory = await mkdtemp(resolve(tmpdir(), "rb-progressive-wrong-directory-kind-"));
    await write(fileInsteadOfDirectory, ".spec/init", "not a directory\n");
    await write(fileInsteadOfDirectory, ".rb/init/BRIEF.md", "must also survive\n");
    await expect(purgeProgressiveInitArtifacts(fileInsteadOfDirectory)).rejects.toBeInstanceOf(ProgressiveInitPurgeUnsafeError);
    expect(await readFile(resolve(fileInsteadOfDirectory, ".rb/init/BRIEF.md"), "utf8")).toBe("must also survive\n");
  });

  it("fails closed on unprovable developer content inside an owned directory", async () => {
    const root = await mixedProject();
    await write(root, ".spec/init/developer-notes.md", "do not classify or delete\n");
    const before = await readFile(resolve(root, ".spec/init/project-description.md"), "utf8");
    await expect(purgeProgressiveInitArtifacts(root)).rejects.toBeInstanceOf(ProgressiveInitPurgeUnsafeError);
    expect(await readFile(resolve(root, ".spec/init/project-description.md"), "utf8")).toBe(before);
    expect(await readFile(resolve(root, ".spec/init/developer-notes.md"), "utf8")).toBe("do not classify or delete\n");
  });

  it("fails closed on unexpected content inside a recursively owned Progressive run", async () => {
    const root = await mixedProject();
    await write(root, ".rb-harness/runs/progressive-abc/developer.txt", "never recursively delete me\n");
    await expect(purgeProgressiveInitArtifacts(root)).rejects.toBeInstanceOf(ProgressiveInitPurgeUnsafeError);
    expect(await readFile(resolve(root, ".rb-harness/runs/progressive-abc/developer.txt"), "utf8"))
      .toBe("never recursively delete me\n");
    expect(await readFile(resolve(root, ".rb/init/BRIEF.md"), "utf8")).toBe("# BRIEF\n");
  });
});
