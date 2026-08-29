import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const LEGACY_ALLOWLIST = new Set([
  "types", "fs-utils", "hash", "path-policy", "path-ownership",
  "execution-contract", "go-plan-convergence", "manifest", "version",
  "credential-store",
  "anthropic-credential",
  "process-tree",
]);

async function typescriptFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) result.push(...await typescriptFiles(path));
    else if (entry.name.endsWith(".ts")) result.push(path);
  }
  return result;
}

function imports(source: string): string[] {
  return [...source.matchAll(/(?:from\s+|import\s*)["']([^"']+)["']/g)].map((match) => match[1]!);
}

describe("vNext import boundary", () => {
  it("keeps legacy imports one-way and restricted to the approved primitive allowlist", async () => {
    const coreRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const sourceRoot = resolve(coreRoot, "src");
    const vnextRoot = resolve(sourceRoot, "vnext");
    const vnextFiles = await typescriptFiles(vnextRoot);
    for (const file of vnextFiles) {
      const source = await readFile(file, "utf8");
      for (const specifier of imports(source)) {
        if (!specifier.startsWith(".")) continue;
        const target = resolve(dirname(file), specifier.replace(/\.js$/, ".ts"));
        if (target.startsWith(`${vnextRoot}/`)) continue;
        const match = target.match(/\/src\/([a-z0-9-]+)\.ts$/);
        if (match?.[1]) expect(LEGACY_ALLOWLIST.has(match[1]), `${file} imports ${specifier}`).toBe(true);
      }
    }

    const legacyFiles = (await typescriptFiles(sourceRoot)).filter((path) => !path.startsWith(`${vnextRoot}/`));
    for (const file of legacyFiles) {
      const mayRegisterVnextCli = file === resolve(sourceRoot, "cli-program.ts");
      expect(imports(await readFile(file, "utf8")).some((specifier) => specifier.includes("/vnext/")), file).toBe(mayRegisterVnextCli);
    }
  });

  it("keeps publication independent from provider, gateway, formatter, and repair layers", async () => {
    const coreRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const source = await readFile(resolve(coreRoot, "src/vnext/publish.ts"), "utf8");
    expect(source).not.toMatch(/provider|gateway|formatter|repair/i);
  });

  it("keeps Phase 3 run state non-semantic and model prompts free of artifact grammar", async () => {
    const coreRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const runState = await readFile(resolve(coreRoot, "src/vnext/run-state.ts"), "utf8");
    expect(runState).not.toMatch(/InitProjectModel|SemanticPhase|SemanticTask|Requirement\[|AcceptanceSemantics|ExecutionDocument/);
    const prompts = await readFile(resolve(coreRoot, "src/vnext/prompts.ts"), "utf8");
    expect(prompts).not.toMatch(/PHASES\.md|BRIEF\.md|AC-T001|T001|rb-manifest|Ralph document/);
    const gateway = await readFile(resolve(coreRoot, "src/vnext/gateway.ts"), "utf8");
    expect(gateway).not.toMatch(/anthropic|claude|direct-api|claude-code-cli/i);
    expect(gateway).not.toMatch(/formatter|field patch|document repair/i);
  });
});
