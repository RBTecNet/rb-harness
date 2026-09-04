import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classifyRootCliArgs } from "../src/init-routing.js";

const coreRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dashboardRoot = resolve(coreRoot, "src/vnext/progressive-init/dashboard");

async function sources(root: string): Promise<{ readonly name: string; readonly text: string }[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: { name: string; text: string }[] = [];
  for (const entry of entries) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) files.push(...await sources(path));
    else if (entry.name.endsWith(".ts")) files.push({ name: entry.name, text: await readFile(path, "utf8") });
  }
  return files;
}

describe("Progressive Dashboard never starts Ralph", () => {
  it("contains no process, command or plan execution anywhere in the Dashboard", async () => {
    const files = await sources(dashboardRoot);
    expect(files.length).toBeGreaterThan(6);
    for (const file of files) {
      expect(file.text, file.name).not.toMatch(/node:child_process|child_process/);
      expect(file.text, file.name).not.toMatch(/\bspawn(?:Sync)?\s*\(|\bexecFile\s*\(|\bfork\s*\(/);
      expect(file.text, file.name).not.toMatch(/process\.exit\s*\(/);
      expect(file.text, file.name).not.toMatch(/\b(?:startRalph|runRalph|executeRalph|launchRalph)\b/);
      expect(file.text, file.name).not.toMatch(/ralphReady\s*\)\s*\{[^}]*Ralph\s*\(/);
    }
  });

  it("mentions the Ralph entry point only as text the developer runs themselves", async () => {
    const renderer = await readFile(resolve(dashboardRoot, "renderer.ts"), "utf8");
    expect(renderer).toContain("Run `rb-harness --ralph` to start Ralph.");
    // The only Ralph reference is the rendered hint, never an invocation.
    expect(renderer).not.toMatch(/exec|spawn|child_process/);
  });

  it("declares no ralph-started event in the presentation contract", async () => {
    const presentation = await readFile(resolve(dashboardRoot, "presentation.ts"), "utf8");
    expect(presentation).not.toMatch(/ralph-started|ralph-execution|startRalph/);
    expect(presentation).toContain('"readiness"');
  });
});

describe("Progressive Dashboard layering", () => {
  it("keeps the renderer free of Core, store, provider and filesystem access", async () => {
    const renderer = await readFile(resolve(dashboardRoot, "renderer.ts"), "utf8");
    expect(renderer).not.toMatch(/node:fs|coordinator\.js|-store\.js|providers\//);
    expect(renderer).not.toMatch(/inspectProgressiveInit|runProgressiveInit|publishProjectPhasesClosure/);
  });

  it("keeps the pure presentation layer free of terminal and process dependencies", async () => {
    for (const name of ["presentation.ts", "reducer.ts", "selection.ts", "text-input.ts", "text.ts", "safety.ts"]) {
      const text = await readFile(resolve(dashboardRoot, name), "utf8");
      expect(text, name).not.toMatch(/node:fs|node:process|process\.stdout|process\.stdin/);
      // Measuring an escape sequence is fine; emitting cursor or clear control
      // is the terminal layer's job alone.
      expect(text, name).not.toMatch(/\[\?25[lh]|\[2J|setRawMode/);
    }
  });

  it("keeps the ownership-aware purge inside Core and out of the Dashboard", async () => {
    for (const file of await sources(dashboardRoot)) {
      expect(file.text, file.name).not.toMatch(/\brm\s*\(|\bunlink\s*\(|\brmdir\s*\(|node:fs/);
    }
    const purge = await readFile(resolve(coreRoot, "src/vnext/progressive-init/purge.ts"), "utf8");
    expect(purge).toContain("node:fs/promises");
  });

  it("keeps orchestration observability additive", async () => {
    const orchestrator = await readFile(resolve(coreRoot, "src/vnext/progressive-init/wizard-orchestrator.ts"), "utf8");
    // Every observation is optional and contained, so execution is identical
    // whether or not a subscriber exists.
    expect(orchestrator).toContain("readonly observe?:");
    expect(orchestrator).toContain("try { runtime.observe?.(observation); } catch");
    expect(orchestrator).not.toMatch(/dashboard/i);
  });
});

describe("Progressive Init interactive routing", () => {
  it("keeps --init interactive-only and bare init unchanged", () => {
    expect(classifyRootCliArgs(["--init"], true)).toEqual({ kind: "init-wizard" });
    expect(classifyRootCliArgs(["--init"], false)).toEqual({ kind: "non-interactive-error", operation: "init" });
    expect(classifyRootCliArgs(["init", "request"], true)).toEqual({ kind: "command" });
    expect(classifyRootCliArgs(["--init", "--stage", "project-description", "request"], true))
      .toEqual({ kind: "init-direct", argv: ["--stage", "project-description", "request"] });
  });
});
