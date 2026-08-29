import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { saveCredential } from "../../../src/credential-store.js";
import { listProviderProfiles, resolveProviderAdapter, resolveProviderCredential, resolveProviderProfile } from "../../../src/vnext/providers/registry.js";

const originalCredentialHome = process.env.RB_CREDENTIAL_HOME;

afterEach(() => {
  if (originalCredentialHome === undefined) delete process.env.RB_CREDENTIAL_HOME;
  else process.env.RB_CREDENTIAL_HOME = originalCredentialHome;
});

describe("vNext provider registry", () => {
  it("resolves only the exact profile without family fallback", () => {
    expect(resolveProviderProfile("anthropic:claude-opus-5").modelId).toBe("claude-opus-5");
    expect(resolveProviderAdapter("anthropic:claude-opus-5").family).toBe("anthropic");
    expect(() => resolveProviderProfile("anthropic:claude-sonnet-5")).toThrow(/unknown provider profile/);
    expect(() => resolveProviderProfile("anthropic:claude-opus-5", "openai")).toThrow(/belongs to anthropic/);
    expect(listProviderProfiles().map((profile) => profile.id)).toEqual(["anthropic:claude-opus-5"]);
  });

  it("cannot become supported through a hand-edited declaration", () => {
    const profile = resolveProviderProfile("anthropic:claude-opus-5");
    expect(profile.conformance).toMatchObject({ tier: "UNSUPPORTED", verifiedRecord: false, runId: null });
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
