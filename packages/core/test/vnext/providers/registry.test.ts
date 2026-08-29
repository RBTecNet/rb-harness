import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { saveCredential } from "../../../src/credential-store.js";
import { listProviderProfiles, resolveProviderAdapter, resolveProviderAuth, resolveProviderCredential, resolveProviderProfile } from "../../../src/vnext/providers/registry.js";

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
    expect(() => resolveProviderProfile("anthropic:claude-sonnet-5")).toThrow(/unknown provider profile/);
    expect(() => resolveProviderProfile("anthropic:claude-opus-5", "openai")).toThrow(/belongs to anthropic/);
    expect(listProviderProfiles().map((profile) => profile.id)).toEqual([
      "anthropic:claude-opus-5",
      "anthropic:claude-code-cli:claude-opus-5",
    ]);
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
});
