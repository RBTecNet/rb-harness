import { describe, expect, it } from "vitest";
import { progressiveProviderIdentity } from "../src/cli-program.js";
import { listProviderProfiles, resolveProviderProfile } from "../src/vnext/providers/registry.js";
import { defaultProgressiveProviderIdentity } from "../src/vnext/progressive-init/dashboard/run.js";

describe("Progressive Dashboard provider identity", () => {
  it("carries the exact registry profile ID verbatim for every registered profile", () => {
    const profiles = listProviderProfiles();
    expect(profiles.length).toBeGreaterThan(50);
    for (const profile of profiles) {
      const identity = progressiveProviderIdentity(profile);
      // The renderer receives the registry object's own ID; it is never derived
      // from a display label.
      expect(identity.profileId).toBe(profile.id);
      expect(identity.transport).toBe(profile.transport);
      expect(identity.requestAccounting).toBe(profile.requestAccounting);
      expect(identity.providerLabel).not.toBe("");
      expect(identity.modelLabel).not.toBe("");
    }
  });

  it("presents Codex / ChatGPT Subscription with its own model label and profile ID", () => {
    const identity = progressiveProviderIdentity(resolveProviderProfile("openai:codex:gpt-5.6-sol"));
    expect(identity).toMatchObject({
      providerLabel: "Codex / ChatGPT Subscription",
      modelLabel: "GPT-5.6 Sol",
      profileId: "openai:codex:gpt-5.6-sol",
      transport: "codex-app-server",
    });
  });

  it("keeps the 1.0.7 OpenCode Go/Zen collision remediation visible", () => {
    const go = progressiveProviderIdentity(resolveProviderProfile("opencode:cli:opencode-go/grok-4.6"));
    const zen = progressiveProviderIdentity(resolveProviderProfile("opencode:cli:opencode/grok-4.6"));
    expect(go.profileId).toBe("opencode:cli:opencode-go/grok-4.6");
    expect(zen.profileId).toBe("opencode:cli:opencode/grok-4.6");
    expect(go.providerLabel).toBe("OpenCode CLI");
    expect(zen.providerLabel).toBe("OpenCode CLI");
    // Same model name, two sources: the labels must remain distinguishable.
    expect(go.modelLabel).toBe("Grok 4.6 · OpenCode Go");
    expect(zen.modelLabel).not.toBe(go.modelLabel);

    const directGo = progressiveProviderIdentity(resolveProviderProfile("opencode:go:deepseek-v4-pro"));
    const directZen = progressiveProviderIdentity(resolveProviderProfile("opencode:zen:deepseek-v4-pro"));
    expect(directGo.providerLabel).toBe("OpenCode Go");
    expect(directZen.providerLabel).toBe("OpenCode Zen");
    expect(directGo.profileId).not.toBe(directZen.profileId);
  });

  it("never produces two identical provider+model pairs across the whole registry", () => {
    const seen = new Map<string, string>();
    for (const profile of listProviderProfiles()) {
      const identity = progressiveProviderIdentity(profile);
      const pair = `${identity.providerLabel} / ${identity.modelLabel}`;
      expect(seen.has(pair), `${pair} is shared by ${seen.get(pair)} and ${profile.id}`).toBe(false);
      seen.set(pair, profile.id);
    }
  });

  it("falls back to the exact profile ID when no selector grouping applies", () => {
    const profile = resolveProviderProfile("deepseek:deepseek-v4-pro");
    expect(defaultProgressiveProviderIdentity(profile).profileId).toBe(profile.id);
  });
});
