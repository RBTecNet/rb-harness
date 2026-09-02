import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { saveCredential } from "../../../src/credential-store.js";
import {
  listProviderProfiles,
  recordProviderConformance,
  resolveProviderAdapter,
  resolveProviderAuth,
  resolveProviderConformanceCases,
  resolveProviderCredential,
  resolveProviderProfile,
} from "../../../src/vnext/providers/registry.js";

const originalCredentialHome = process.env.RB_CREDENTIAL_HOME;

afterEach(() => {
  if (originalCredentialHome === undefined) delete process.env.RB_CREDENTIAL_HOME;
  else process.env.RB_CREDENTIAL_HOME = originalCredentialHome;
});

describe("vNext provider registry", () => {
  it("resolves only the exact profile without family fallback", () => {
    expect(resolveProviderProfile("anthropic:claude-opus-5").modelId).toBe("claude-opus-5");
    expect(resolveProviderAdapter("anthropic:claude-opus-5")).toMatchObject({ family: "anthropic", transport: "direct-api" });
    expect(resolveProviderAdapter("anthropic:claude-code-cli:claude-opus-5")).toMatchObject({ family: "anthropic", transport: "claude-code-cli" });
    expect(resolveProviderProfile("deepseek:deepseek-v4-pro")).toMatchObject({
      family: "deepseek",
      transport: "direct-api",
      modelId: "deepseek-v4-pro",
      conformance: { tier: "UNSUPPORTED", verifiedRecord: false },
    });
    expect(resolveProviderProfile("deepseek:deepseek-v4-flash")).toMatchObject({
      family: "deepseek",
      transport: "direct-api",
      modelId: "deepseek-v4-flash",
      conformance: { tier: "UNSUPPORTED", verifiedRecord: false, runId: null, recordedAt: null },
    });
    const proAdapter = resolveProviderAdapter("deepseek:deepseek-v4-pro");
    const flashAdapter = resolveProviderAdapter("deepseek:deepseek-v4-flash");
    expect(proAdapter).toMatchObject({ family: "deepseek", transport: "direct-api" });
    expect(flashAdapter).toBe(proAdapter);
    expect(() => resolveProviderProfile("anthropic:claude-sonnet-5")).toThrow(/unknown provider profile/);
    expect(() => resolveProviderProfile("anthropic:claude-opus-5", "openai")).toThrow(/belongs to anthropic/);
    expect(listProviderProfiles().map((profile) => profile.id)).toEqual(expect.arrayContaining([
      "anthropic:claude-opus-5",
      "anthropic:claude-code-cli:claude-opus-5",
      "deepseek:deepseek-v4-pro",
      "deepseek:deepseek-v4-flash",
      "opencode:go:deepseek-v4-pro",
      "opencode:zen:gpt-5.6-luna",
      "opencode:cli:opencode/gpt-5.6-luna",
    ]));
  });

  it("cannot become supported through a hand-edited declaration", () => {
    const profile = resolveProviderProfile("anthropic:claude-opus-5");
    expect(profile.conformance).toMatchObject({ tier: "UNSUPPORTED", verifiedRecord: false, runId: null });
  });

  it("keeps same-family same-model transports independent with no fallback", () => {
    const direct = resolveProviderProfile("anthropic:claude-opus-5");
    const cli = resolveProviderProfile("anthropic:claude-code-cli:claude-opus-5");
    expect(direct.modelId).toBe(cli.modelId);
    expect(direct.transport).toBe("direct-api");
    expect(cli.transport).toBe("claude-code-cli");
    expect(direct.requestAccounting).toBe("exact");
    expect(cli.requestAccounting).toBe("opaque");
    expect(resolveProviderAdapter(direct.id)).not.toBe(resolveProviderAdapter(cli.id));
    expect(() => resolveProviderProfile("anthropic:claude-code-cli:claude-sonnet-5")).toThrow(/unknown provider profile/);
  });

  it("resolves CLI ambient auth without touching the credential vault and rejects credential selectors", async () => {
    process.env.RB_CREDENTIAL_HOME = "/dev/null/vault-must-not-be-opened";
    const cli = resolveProviderProfile("anthropic:claude-code-cli:claude-opus-5");
    await expect(resolveProviderAuth(cli)).resolves.toEqual({ kind: "ambient-session", id: "claude-code-subscription" });
    await expect(resolveProviderAuth(cli, "claudeAPI")).rejects.toThrow(/--credential is not accepted/);
    await expect(resolveProviderCredential(cli)).rejects.toThrow(/does not use a vault credential/);
  });

  it("preserves immutable generic credential attributes and supplies an empty map when absent", async () => {
    process.env.RB_CREDENTIAL_HOME = await mkdtemp(resolve(tmpdir(), "rb-vnext-credential-"));
    await saveCredential({
      provider: "anthropic",
      protocol: "api-key",
      label: "workspace",
      secret: "registry-secret-sentinel",
      attributes: { workspaceId: "wrkspc_TEST123" },
    });
    await saveCredential({ provider: "anthropic", protocol: "api-key", label: "plain", secret: "plain-secret-sentinel" });
    const profile = resolveProviderProfile("anthropic:claude-opus-5");
    const workspace = await resolveProviderCredential(profile, "workspace");
    const plain = await resolveProviderCredential(profile, "plain");
    expect(workspace.attributes).toEqual({ workspaceId: "wrkspc_TEST123" });
    expect(Object.isFrozen(workspace.attributes)).toBe(true);
    expect(plain.attributes).toEqual({});
    expect(Object.isFrozen(plain.attributes)).toBe(true);
  });

  it("resolves DeepSeek credentials only from the DeepSeek vault namespace", async () => {
    process.env.RB_CREDENTIAL_HOME = await mkdtemp(resolve(tmpdir(), "rb-vnext-deepseek-credential-"));
    await saveCredential({ provider: "anthropic", protocol: "api-key", label: "shared-label", secret: "anthropic-secret" });
    await saveCredential({ provider: "deepseek", protocol: "api-key", label: "shared-label", secret: "deepseek-secret" });
    for (const profileId of ["deepseek:deepseek-v4-pro", "deepseek:deepseek-v4-flash"]) {
      const profile = resolveProviderProfile(profileId);
      await expect(resolveProviderCredential(profile, "shared-label")).resolves.toMatchObject({
        id: "deepseek:shared-label",
        secret: "deepseek-secret",
      });
      await expect(resolveProviderAuth(profile, "shared-label")).resolves.toMatchObject({
        kind: "credential",
        credential: { id: "deepseek:shared-label", secret: "deepseek-secret" },
      });
    }
  });

  it("uses the existing OpenCode Go/Zen vault namespaces with zero migration or fallback", async () => {
    process.env.RB_CREDENTIAL_HOME = await mkdtemp(resolve(tmpdir(), "rb-vnext-opencode-credential-"));
    await saveCredential({ provider: "opencode-go", protocol: "api-key", label: "shared", secret: "go-secret" });
    await saveCredential({ provider: "opencode-zen", protocol: "api-key", label: "shared", secret: "zen-secret" });
    const go = resolveProviderProfile("opencode:go:deepseek-v4-pro");
    const zen = resolveProviderProfile("opencode:zen:gpt-5.6-luna");
    await expect(resolveProviderCredential(go, "shared")).resolves.toMatchObject({ id: "opencode-go:shared", secret: "go-secret" });
    await expect(resolveProviderCredential(zen, "shared")).resolves.toMatchObject({ id: "opencode-zen:shared", secret: "zen-secret" });
    await expect(resolveProviderCredential(go, "opencode-zen:shared")).rejects.toThrow(/did not match/);
    await expect(resolveProviderCredential(zen, "opencode-go:shared")).rejects.toThrow(/did not match/);
  });

  it("exposes DeepSeek to generic conformance without invoking the live recorder offline", async () => {
    for (const profileId of ["deepseek:deepseek-v4-pro", "deepseek:deepseek-v4-flash"]) {
      const profile = resolveProviderProfile(profileId);
      expect(resolveProviderConformanceCases(profile.id).map((test) => test.id)).toContain("valid-structured-response");
      await expect(recordProviderConformance(profile, { kind: "ambient-session", id: "not-a-vault-credential" }))
        .rejects.toThrow(/requires a vault credential/);
    }
  });
});
