import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveCredential } from "../src/credential-store.js";
import { claudeCodeAdapter } from "../src/vnext/providers/anthropic/claude-code/adapter.js";
import type { ModelProfile, ProviderAdapter } from "../src/vnext/providers/contract.js";
import { openCodeCliAdapter } from "../src/vnext/providers/opencode/cli-adapter.js";
import { codexSubscriptionAdapter } from "../src/vnext/providers/openai/codex/adapter.js";
import { openAiAdapter } from "../src/vnext/providers/openai/adapter.js";
import { resolveProviderProfile } from "../src/vnext/providers/registry.js";
import { runProgressiveInitDashboard } from "../src/vnext/progressive-init/dashboard/run.js";
import {
  fakeProgressiveTerminal,
  key,
  PROGRESSIVE_FIXTURE_REQUEST,
  ProgressiveFixtureAdapter,
} from "./support/progressive-dashboard.js";

const originalCredentialHome = process.env.RB_CREDENTIAL_HOME;
const originalHome = process.env.HOME;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalCredentialHome === undefined) delete process.env.RB_CREDENTIAL_HOME;
  else process.env.RB_CREDENTIAL_HOME = originalCredentialHome;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

function autoDrivenTerminal() {
  const terminal = fakeProgressiveTerminal();
  const frame = terminal.frame;
  return {
    ...terminal,
    frame(content: string): void {
      frame(content);
      // Enter accepts a Core recommendation. If Core intentionally has no
      // default (approval questions), the following explicit move submits Yes.
      queueMicrotask(() => {
        terminal.press(key("enter"));
        queueMicrotask(() => terminal.press(key("down"), key("enter")));
      });
    },
  };
}

function fakeRequestsAtTransport(adapter: ProviderAdapter, fixture: ProgressiveFixtureAdapter) {
  return vi.spyOn(adapter, "request").mockImplementation((profile, auth, request) => fixture.request(profile, auth, request));
}

describe.sequential("Progressive Dashboard production provider runtime", () => {
  it("resolves representative direct, Codex, OpenCode, and Claude profiles without replacing the Dashboard CLI runtime", async () => {
    const credentialHome = await mkdtemp(resolve(tmpdir(), "rb-dashboard-production-credentials-"));
    process.env.RB_CREDENTIAL_HOME = credentialHome;
    await saveCredential({ provider: "openai", protocol: "api-key", label: "dashboard-test", secret: "fixture-only", makeDefault: true });

    const home = await mkdtemp(resolve(tmpdir(), "rb-dashboard-production-home-"));
    process.env.HOME = home;
    await mkdir(resolve(home, ".codex"), { recursive: true });
    await writeFile(resolve(home, ".codex", "auth.json"), "{}\n", "utf8");

    const codexEvidence = {
      executable: "rb-codex-fixture",
      version: "0.151.0-rb.1",
      sha256: "b68d7cc25105d38cca12977164e45710ae4576a18f898269b563e743e100493d",
      semanticModeVersion: "v1",
      semanticRuntimeVersion: "rb-codex 0.151.0-rb.1 (upstream 78c290807ce710180111df227df3b7a4fe845452)",
      identity: "fixture",
    } as const;
    vi.spyOn(codexSubscriptionAdapter, "runtimePreflight").mockResolvedValue({ ok: true, value: codexEvidence });
    vi.spyOn(openCodeCliAdapter, "runtimePreflight").mockResolvedValue({
      ok: true,
      value: { executable: "opencode-fixture", transportVersion: "1.18.25" },
    });
    vi.spyOn(claudeCodeAdapter, "runtimePreflight").mockResolvedValue({
      ok: true,
      value: { transportVersion: "2.1.251 (Claude Code)", authMode: "subscription" },
    });

    const cases: readonly { profileId: string; adapter: ProviderAdapter; modelSelector?: string }[] = [
      { profileId: "openai:gpt-5.6-sol", adapter: openAiAdapter },
      { profileId: "openai:codex:gpt-5.6-sol", adapter: codexSubscriptionAdapter },
      { profileId: "opencode:cli:opencode-go/deepseek-v4-pro", adapter: openCodeCliAdapter },
      { profileId: "anthropic:claude-code-cli:claude-opus-5", adapter: claudeCodeAdapter },
    ];

    for (const entry of cases) {
      const projectRoot = await mkdtemp(resolve(tmpdir(), "rb-dashboard-production-route-"));
      const fixtureProfile: ModelProfile = resolveProviderProfile("deepseek:deepseek-v4-pro");
      const fixture = new ProgressiveFixtureAdapter(fixtureProfile);
      const requestSpy = fakeRequestsAtTransport(entry.adapter, fixture);
      const identities: string[] = [];
      const result = await runProgressiveInitDashboard({
        configuration: {
          requestParts: [PROGRESSIVE_FIXTURE_REQUEST],
          profileId: entry.profileId,
          ...(entry.modelSelector ? { modelSelector: entry.modelSelector } : {}),
          projectRoot,
          headless: false,
          deadlineSeconds: 120,
        },
        version: "1.0.7",
        terminal: autoDrivenTerminal(),
        describeProvider: (profile) => {
          identities.push(profile.id);
          return {
            providerLabel: profile.family,
            modelLabel: profile.label,
            profileId: profile.id,
            transport: profile.transport,
            requestAccounting: profile.requestAccounting,
          };
        },
      });
      requestSpy.mockRestore();

      expect(result.ralphReady, entry.profileId).toBe(true);
      expect(result.wizard.executedStages, entry.profileId).toEqual([
        "project-description", "user-stories", "database-schema", "project-phases",
      ]);
      expect(identities.length, entry.profileId).toBeGreaterThan(0);
      expect(new Set(identities), entry.profileId).toEqual(new Set([entry.profileId]));
      expect(fixture.requests.length, entry.profileId).toBeGreaterThan(0);
    }
  }, 30_000);
});
