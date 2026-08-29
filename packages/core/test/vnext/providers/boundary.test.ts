import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { harnessCommandSurface } from "../../../src/cli-program.js";

async function files(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else if (entry.name.endsWith(".ts")) result.push(path);
  }
  return result;
}

describe("Phase 2 provider boundaries", () => {
  const core = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const anthropic = resolve(core, "src/vnext/providers/anthropic");

  it("forbids semantic Core imports and semantic vocabulary in Anthropic normalization", async () => {
    const source = (await Promise.all((await files(anthropic)).map((file) => readFile(file, "utf8")))).join("\n");
    expect(source).not.toMatch(/vnext\/(ir|resolve|validate|render|closure|ralph-fidelity)/);
    expect(source).not.toMatch(/execution-contract|PHASES\.md|BRIEF\.md|SemanticTask|SemanticPhase|TaskId|AcceptanceId|Ralph/);

    const normalizer = await readFile(resolve(anthropic, "normalize.ts"), "utf8");
    expect(normalizer).not.toMatch(/requirementsList|requirements|phases|tasks|acceptance|ownedPaths|covers|qualityCommands/);
  });

  it("keeps generic contract and conformance code provider-neutral", async () => {
    const generic = resolve(core, "src/vnext/providers/conformance");
    const source = (await Promise.all((await files(generic)).map((file) => readFile(file, "utf8")))).join("\n");
    expect(source).not.toMatch(/anthropic|claude/i);
    expect(await readFile(resolve(core, "src/vnext/providers/contract.ts"), "utf8")).not.toMatch(/anthropic|claude/i);
  });

  it("contains no adapter-authored semantic prompt policy or repair/formatter hook", async () => {
    const source = (await Promise.all((await files(anthropic)).map((file) => readFile(file, "utf8")))).join("\n");
    expect(source).not.toMatch(/Respond with valid JSON|Do not output Markdown|Harness requirements|Follow this schema exactly/i);
    expect(source).not.toMatch(/formatter|semantic repair|second model|retry loop/i);
  });

  it("keeps one shared Anthropic workspace ID predicate for wizard and adapter", async () => {
    const wizard = await readFile(resolve(core, "src/auth-cli.ts"), "utf8");
    const adapter = await readFile(resolve(anthropic, "adapter.ts"), "utf8");
    const shared = await readFile(resolve(core, "src/anthropic-credential.ts"), "utf8");
    expect(wizard).toContain("isAnthropicWorkspaceId");
    expect(adapter).toContain("isAnthropicWorkspaceId");
    expect(wizard).not.toMatch(/\^wrkspc_/);
    expect(adapter).not.toMatch(/\^wrkspc_/);
    expect(shared.match(/\^wrkspc_/g)).toHaveLength(1);
  });

  it("adds only conformance beneath vnext and does not register vnext init", () => {
    const surface = harnessCommandSurface();
    expect(surface["rb-harness vnext conformance"]).toEqual(expect.arrayContaining(["--record", "--credential"]));
    expect(surface["rb-harness vnext init"]).toBeUndefined();
    expect(surface["rb-harness init"]).toBeDefined();
  });
});
