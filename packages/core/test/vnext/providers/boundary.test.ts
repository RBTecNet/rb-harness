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
  const claudeCode = resolve(anthropic, "claude-code");
  const deepSeek = resolve(core, "src/vnext/providers/deepseek");
  const openCode = resolve(core, "src/vnext/providers/opencode");

  it("forbids semantic Core imports and semantic vocabulary in Anthropic normalization", async () => {
    const source = (await Promise.all((await files(anthropic)).map((file) => readFile(file, "utf8")))).join("\n");
    expect(source).not.toMatch(/vnext\/(ir|resolve|validate|render|closure|ralph-fidelity)/);
    expect(source).not.toMatch(/execution-contract|PHASES\.md|BRIEF\.md|SemanticTask|SemanticPhase|TaskId|AcceptanceId|Ralph/);

    const normalizer = await readFile(resolve(anthropic, "normalize.ts"), "utf8");
    expect(normalizer).not.toMatch(/requirementsList|requirements|phases|tasks|acceptance|ownedPaths|covers|qualityCommands/);
  });

  it("keeps generic contract and conformance code provider-neutral", async () => {
    const generic = resolve(core, "src/vnext/providers/conformance");
    const source = (await Promise.all((await files(generic)).map((file) => readFile(file, "utf8")))).join("\n")
      .replaceAll('"claude-code-cli"', "");
    expect(source).not.toMatch(/anthropic|claude/i);
    const contract = (await readFile(resolve(core, "src/vnext/providers/contract.ts"), "utf8"))
      .replaceAll('"claude-code-cli"', "")
      .replaceAll('"claude-code-json-schema"', "");
    expect(contract).not.toMatch(/anthropic|claude/i);
  });

  it("contains no adapter-authored semantic prompt policy or repair/formatter hook", async () => {
    const source = (await Promise.all((await files(anthropic)).map((file) => readFile(file, "utf8")))).join("\n");
    expect(source).not.toMatch(/Respond with valid JSON|Do not output Markdown|Harness requirements|Follow this schema exactly/i);
    expect(source).not.toMatch(/formatter call|semantic repair|second model call/i);
  });

  it("keeps DeepSeek normalization semantic-blind and independent from Anthropic and the legacy provider stack", async () => {
    const source = (await Promise.all((await files(deepSeek)).map((file) => readFile(file, "utf8")))).join("\n");
    expect(source).not.toMatch(/vnext\/(ir|resolve|validate|render|closure|ralph-fidelity)/);
    expect(source).not.toMatch(/provider-registry|api-agent|api-stream|anthropic-version|x-api-key|v1\/messages|chat\/completions/);
    expect(source).not.toMatch(/Requirement|SemanticTask|SemanticPhase|TaskId|AcceptanceId|PHASES\.md|BRIEF\.md|Ralph/);
    expect(await readFile(resolve(deepSeek, "normalize.ts"), "utf8"))
      .not.toMatch(/requirementsList|requirements|phases|tasks|acceptance|ownedPaths|covers|qualityCommands/);
    expect(await readFile(resolve(deepSeek, "adapter.ts"), "utf8"))
      .not.toMatch(/Respond with valid JSON|Do not output Markdown|Harness requirements|Repair your answer/i);
  });

  it("keeps OpenCode provider-local normalization outside frozen semantic authority", async () => {
    const source = (await Promise.all((await files(openCode)).map((file) => readFile(file, "utf8")))).join("\n");
    expect(source).not.toMatch(/vnext\/(ir|resolve|validate|render|closure|ralph-fidelity)/);
    expect(source).not.toMatch(/ImplementationSubject|SemanticTask|SemanticPhase|TaskId|AcceptanceId|PHASES\.md|BRIEF\.md/);
    for (const name of ["api-normalize.ts", "cli-normalize.ts"]) {
      expect(await readFile(resolve(openCode, name), "utf8"))
        .not.toMatch(/requirementsList|requirements|phases|tasks|acceptance|ownedPaths|covers|qualityCommands/);
    }
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

  it("keeps Claude Code transport semantic-blind and independent from the API vault/direct adapter", async () => {
    const productionFiles = ["adapter.ts", "normalize.ts", "process.ts", "profiles.ts"];
    const source = (await Promise.all(productionFiles.map((name) => readFile(resolve(claudeCode, name), "utf8")))).join("\n");
    expect(source).not.toMatch(/vnext\/(ir|resolve|validate|render|closure|ralph-fidelity)/);
    expect(source).not.toMatch(/credential-store|anthropic\/adapter|x-api-key/);
    expect(source).not.toMatch(/Requirement|SemanticTask|SemanticPhase|TaskId|AcceptanceId|PHASES\.md|BRIEF\.md|Ralph/);
    expect(await readFile(resolve(claudeCode, "normalize.ts"), "utf8"))
      .not.toMatch(/requirementsList|requirements|phases|tasks|acceptance|ownedPaths|covers|qualityCommands/);
    expect(await readFile(resolve(claudeCode, "adapter.ts"), "utf8"))
      .not.toMatch(/Respond with valid JSON|Do not output Markdown|Harness requirements|Repair your answer/i);
  });

  it("promotes semantic Init and removes the experimental/legacy Init routes", () => {
    const surface = harnessCommandSurface();
    expect(surface["rb-harness vnext conformance"]).toEqual(expect.arrayContaining(["--record", "--credential"]));
    expect(surface["rb-harness vnext init"]).toBeUndefined();
    expect(surface["rb-harness init"]).toEqual(expect.arrayContaining(["--profile", "--credential", "--headless"]));
    expect(surface["rb-harness init"]).not.toEqual(expect.arrayContaining(["--provider", "--adapter", "--output"]));
    // The rb-headless-init/v1 and rb-headless-interview/v1 executors are a
    // separate published integration boundary, not a legacy Init route: they
    // keep the entry points their shipped contracts declare.
    expect(surface["rb-harness headless init"]).toEqual(expect.arrayContaining(["--output"]));
    expect(surface["rb-harness headless init"]).not.toEqual(expect.arrayContaining(["--profile"]));
    expect(surface["rb-harness headless interview run"]).toEqual(
      expect.arrayContaining(["--state", "--timeout", "--first-output-timeout"]),
    );
  });
});
