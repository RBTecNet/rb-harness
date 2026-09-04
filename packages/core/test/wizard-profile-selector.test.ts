import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { WizardPrompt } from "../src/harness-wizard.js";
import { collectInitWizardConfiguration } from "../src/init-wizard.js";
import { listProviderProfiles } from "../src/vnext/providers/registry.js";
import type { ModelProfile } from "../src/vnext/providers/contract.js";
import {
  groupWizardProfiles,
  selectWizardModel,
  selectWizardProvider,
  wizardModelChoices,
  wizardModelLabel,
  type WizardSelectableProfile,
} from "../src/wizard-profile-selector.js";

function scripted(answers: readonly string[]): WizardPrompt & { readonly output: string[]; readonly prompts: string[] } {
  const queue = [...answers];
  const output: string[] = [];
  const prompts: string[] = [];
  return {
    ask: async (prompt) => {
      prompts.push(prompt);
      const answer = queue.shift();
      if (answer === undefined) throw new Error(`scripted input exhausted at: ${prompt}`);
      return answer;
    },
    write: (text) => void output.push(text),
    output,
    prompts,
  };
}

function group(id: string) {
  const selected = groupWizardProfiles(listProviderProfiles()).groups.find((entry) => entry.id === id);
  if (!selected) throw new Error(`missing fixture group: ${id}`);
  return selected;
}

describe("Wizard provider → model selector", () => {
  it("derives eight isolated access-channel groups from all 169 registry profiles", () => {
    const profiles = listProviderProfiles();
    const catalog = groupWizardProfiles(profiles);
    expect(profiles).toHaveLength(169);
    expect(catalog.unclassified).toEqual([]);
    expect(catalog.groups.map((entry) => [entry.id, entry.label, entry.profiles.length])).toEqual([
      ["anthropic-api", "Anthropic API", 1],
      ["claude-code", "Claude Code", 1],
      ["deepseek-api", "DeepSeek API", 2],
      ["opencode-go", "OpenCode Go", 24],
      ["opencode-zen", "OpenCode Zen", 56],
      ["opencode-cli", "OpenCode CLI", 80],
      ["openai-api", "OpenAI API", 4],
      ["codex-subscription", "Codex / ChatGPT Subscription", 1],
    ]);
    expect(catalog.groups.flatMap((entry) => entry.profiles)).toHaveLength(profiles.length);
  });

  it("keeps OpenAI API and Codex Subscription separate with readable model-only labels", () => {
    const openai = group("openai-api");
    const codex = group("codex-subscription");
    expect(openai.profiles.map((profile) => profile.id)).toEqual([
      "openai:gpt-5.6-sol", "openai:gpt-5.6-terra", "openai:gpt-5.6-luna", "openai:gpt-5.3-codex",
    ]);
    expect(openai.profiles.map(wizardModelLabel)).toEqual(["GPT-5.6 Sol", "GPT-5.6 Terra", "GPT-5.6 Luna", "GPT-5.3 Codex"]);
    expect(codex.profiles.map((profile) => profile.id)).toEqual(["openai:codex:gpt-5.6-sol"]);
    expect(codex.profiles.map(wizardModelLabel)).toEqual(["GPT-5.6 Sol"]);
  });

  it("keeps DeepSeek-owned API profiles separate from OpenCode-hosted DeepSeek models", () => {
    const deepseek = group("deepseek-api");
    expect(deepseek.profiles.map((profile) => profile.id)).toEqual([
      "deepseek:deepseek-v4-pro", "deepseek:deepseek-v4-flash",
    ]);
    expect(deepseek.profiles.every((profile) => profile.family === "deepseek" && profile.transport === "direct-api")).toBe(true);
    expect(deepseek.profiles.some((profile) => profile.id.startsWith("opencode:"))).toBe(false);
  });

  it("isolates OpenCode Go, Zen, and CLI while allowing the same model in distinct channels", () => {
    const go = group("opencode-go");
    const zen = group("opencode-zen");
    const cli = group("opencode-cli");
    expect(go.profiles).toHaveLength(24);
    expect(zen.profiles).toHaveLength(56);
    expect(cli.profiles).toHaveLength(80);
    expect(go.profiles.every((profile) => profile.id.startsWith("opencode:go:") && profile.transport === "direct-api")).toBe(true);
    expect(zen.profiles.every((profile) => profile.id.startsWith("opencode:zen:") && profile.transport === "direct-api")).toBe(true);
    expect(cli.profiles.every((profile) => profile.id.startsWith("opencode:cli:") && profile.transport === "opencode-cli")).toBe(true);
    expect(zen.profiles.some((profile) => profile.modelId === "gpt-5.6-sol")).toBe(true);
    expect(cli.profiles.some((profile) => profile.modelId.endsWith("/gpt-5.6-sol"))).toBe(true);
  });

  it("keeps every real-registry model label unique inside its provider group", () => {
    const catalog = groupWizardProfiles(listProviderProfiles());
    for (const provider of catalog.groups) {
      const baseLabels = provider.profiles.map(wizardModelLabel);
      const baseCounts = new Map<string, number>();
      for (const label of baseLabels) baseCounts.set(label, (baseCounts.get(label) ?? 0) + 1);
      const choices = wizardModelChoices(provider);
      const labels = choices.map((choice) => choice.label);
      expect(labels, provider.label).toHaveLength(provider.profiles.length);
      expect(new Set(labels).size, provider.label).toBe(labels.length);
      choices.forEach((choice, index) => {
        if (baseCounts.get(baseLabels[index]!) === 1) expect(choice.label).toBe(baseLabels[index]);
      });
    }
  });

  it("disambiguates only colliding OpenCode CLI labels from existing namespace facts", () => {
    const cli = group("opencode-cli");
    const choices = wizardModelChoices(cli);
    const go = choices.find((choice) => choice.profile.id === "opencode:cli:opencode-go/grok-4.6")!;
    const zen = choices.find((choice) => choice.profile.id === "opencode:cli:opencode/grok-4.6")!;
    const unique = choices.find((choice) => choice.profile.id === "opencode:cli:opencode/gpt-5.6-sol")!;
    expect(go.label).toBe("Grok 4.6 · OpenCode Go");
    expect(zen.label).toBe("Grok 4.6 · OpenCode Zen");
    expect(go.label).not.toBe(zen.label);
    expect(unique.label).toBe("GPT-5.6 Sol");
  });

  it("returns the original OpenCode CLI registry objects from disambiguated labels", async () => {
    const profiles = listProviderProfiles();
    const cli = groupWizardProfiles(profiles).groups.find((entry) => entry.id === "opencode-cli")!;
    const go = await selectWizardModel(scripted(["Grok 4.6 · OpenCode Go"]), cli);
    const zen = await selectWizardModel(scripted(["Grok 4.6 · OpenCode Zen"]), cli);
    expect(go).toBe(profiles.find((profile) => profile.id === "opencode:cli:opencode-go/grok-4.6"));
    expect(zen).toBe(profiles.find((profile) => profile.id === "opencode:cli:opencode/grok-4.6"));
  });

  it("fails closed when a group-local collision has no unique presentation", () => {
    const source = listProviderProfiles().find((profile) => profile.id === "openai:gpt-5.6-sol")!;
    const duplicate = { ...source };
    expect(() => wizardModelChoices({ id: "openai-api", label: "OpenAI API", profiles: [source, duplicate] }))
      .toThrow("WIZARD_MODEL_LABEL_COLLISION");
  });

  it("returns the exact original registry profile object and never synthesizes its ID", async () => {
    const profiles = listProviderProfiles();
    const catalog = groupWizardProfiles(profiles);
    const io = scripted(["8", "1"]);
    const provider = await selectWizardProvider(io, catalog.groups);
    const selected = await selectWizardModel(io, provider);
    const original = profiles.find((profile) => profile.id === "openai:codex:gpt-5.6-sol");
    expect(selected).toBe(original);
    expect(selected.id).toBe("openai:codex:gpt-5.6-sol");
    const output = io.output.join("");
    expect(output).toContain("Provider:\n");
    expect(output).toContain("Modelo · Codex / ChatGPT Subscription:\n");
    expect(output).toContain("1) GPT-5.6 Sol");
    expect(output).not.toContain("Perfil do modelo:");
    expect(output).not.toContain("opencode:cli:");
  });

  it("preserves support/conformance facts and automatically groups a new recognized profile", () => {
    const original = listProviderProfiles().find((profile) => profile.id === "openai:gpt-5.6-sol")!;
    const synthetic: ModelProfile = {
      ...original,
      id: "openai:gpt-9-test",
      modelId: "gpt-9-test",
      label: "OpenAI GPT-9 Test",
    };
    const catalog = groupWizardProfiles([original, synthetic]);
    expect(catalog.groups[0]!.profiles).toEqual([original, synthetic]);
    expect(catalog.groups[0]!.profiles[0]).toBe(original);
    expect(catalog.groups[0]!.profiles[0]!.conformance).toBe(original.conformance);
  });

  it("fails closed by excluding and diagnosing an unclassifiable profile", () => {
    const source = listProviderProfiles()[0]!;
    const unknown: WizardSelectableProfile = {
      ...source,
      id: "unknown:fixture:model",
      family: "unknown",
    };
    const catalog = groupWizardProfiles([source, unknown]);
    expect(catalog.groups.flatMap((entry) => entry.profiles)).toEqual([source]);
    expect(catalog.unclassified).toEqual([unknown]);
  });

  it("retries invalid provider and model selections within a bounded three-attempt policy", async () => {
    const catalog = groupWizardProfiles(listProviderProfiles());
    const io = scripted(["invalid", "99", "8", "2", "invalid", "1"]);
    const provider = await selectWizardProvider(io, catalog.groups);
    const selected = await selectWizardModel(io, provider);
    expect(provider.id).toBe("codex-subscription");
    expect(selected.id).toBe("openai:codex:gpt-5.6-sol");
    expect(io.output.join("").match(/Seleção inválida/g)).toHaveLength(4);
  });

  it("uses the prior Claude Code default deterministically and its first registry model", async () => {
    const catalog = groupWizardProfiles(listProviderProfiles());
    const io = scripted(["", ""]);
    const provider = await selectWizardProvider(io, catalog.groups);
    const selected = await selectWizardModel(io, provider);
    expect(provider.id).toBe("claude-code");
    expect(selected).toBe(provider.profiles[0]);
    expect(selected.id).toBe("anthropic:claude-code-cli:claude-opus-5");
  });

  it("routes direct credentials by the exact selected profile but never asks Codex for an API credential", async () => {
    const projectRoot = await mkdtemp(`${tmpdir()}/rb-wizard-selector-`);
    const codexIo = scripted(["", "8", "1", "", "Build a small service.", ".", "n"]);
    const codexCollected = await collectInitWizardConfiguration(codexIo, { cwd: projectRoot, profiles: listProviderProfiles() });
    if (codexCollected.kind !== "configured") throw new Error("expected a configured Progressive Init");
    const codex = codexCollected.configuration;
    expect(codex.profileId).toBe("openai:codex:gpt-5.6-sol");
    expect(codex.credential).toBeUndefined();
    expect(codexIo.prompts.some((prompt) => prompt.startsWith("Credencial salva"))).toBe(false);

    const apiIo = scripted(["", "7", "1", "", "Build a small service.", ".", "work", "n"]);
    const apiCollected = await collectInitWizardConfiguration(apiIo, { cwd: projectRoot, profiles: listProviderProfiles() });
    if (apiCollected.kind !== "configured") throw new Error("expected a configured Progressive Init");
    const api = apiCollected.configuration;
    expect(api.profileId).toBe("openai:gpt-5.6-sol");
    expect(api.credential).toBe("work");
    expect(apiIo.prompts.some((prompt) => prompt.startsWith("Credencial salva"))).toBe(true);
  });
});
