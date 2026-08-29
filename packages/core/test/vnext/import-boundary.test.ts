import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const LEGACY_ALLOWLIST = new Set([
  "types", "fs-utils", "hash", "path-policy", "path-ownership",
  "execution-contract", "go-plan-convergence", "manifest", "version",
  "credential-store",
  "anthropic-credential",
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
});
