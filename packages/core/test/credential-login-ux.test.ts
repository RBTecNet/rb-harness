import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  LOGIN_PROVIDERS,
  credentialListMetadata,
  loginProvider,
  printCredentialList,
  saveApiKeyLoginCredential,
} from "../src/auth-cli.js";
import { credentialStorePaths, resolveCredential, saveCredential } from "../src/credential-store.js";

const run = promisify(execFile);
const originalCredentialHome = process.env.RB_CREDENTIAL_HOME;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalCredentialHome === undefined) delete process.env.RB_CREDENTIAL_HOME;
  else process.env.RB_CREDENTIAL_HOME = originalCredentialHome;
});

async function renderedList(json = false): Promise<string> {
  let output = "";
  await printCredentialList(json, { write: (value) => { output += value; } });
  return output;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("credential login provider catalog", () => {
  test("preserves existing providers and adds exact OpenCode API namespaces without a CLI credential", () => {
    expect(LOGIN_PROVIDERS.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: "openai", label: "OpenAI API" },
      { id: "anthropic", label: "Claude API (Anthropic)" },
      { id: "gemini", label: "Gemini API" },
      { id: "deepseek", label: "DeepSeek API" },
      { id: "minimax", label: "MiniMax API" },
      { id: "openrouter", label: "OpenRouter" },
      { id: "opencode-go", label: "OpenCode Go" },
      { id: "opencode-zen", label: "OpenCode Zen" },
    ]);
    expect(LOGIN_PROVIDERS.map((entry) => entry.id)).not.toContain("opencode-cli");
    expect(loginProvider("opencode-go").auth.map((entry) => entry.id)).toEqual(["api-key"]);
    expect(loginProvider("opencode-zen").auth.map((entry) => entry.id)).toEqual(["api-key"]);
  });

  test("saves Go and Zen independently through the generic API-key login flow", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rb-login-opencode-"));
    process.env.RB_CREDENTIAL_HOME = root;
    const visible = vi.fn(async () => "must-not-be-read");

    await saveApiKeyLoginCredential(
      { provider: "opencode-go", providerLabel: "OpenCode Go", label: "shared" },
      { hidden: async () => "go-login-secret", visible },
    );
    await saveApiKeyLoginCredential(
      { provider: "opencode-zen", providerLabel: "OpenCode Zen", label: "shared" },
      { hidden: async () => "zen-login-secret", visible },
    );

    expect((await resolveCredential("opencode-go", "shared")).secret).toBe("go-login-secret");
    expect((await resolveCredential("opencode-zen", "shared")).secret).toBe("zen-login-secret");
    expect(visible).not.toHaveBeenCalled();
  });
});

describe("safe credential metadata listing", () => {
  test("has a successful empty state and does not create a credential store", async () => {
    const parent = await mkdtemp(resolve(tmpdir(), "rb-login-list-empty-"));
    const root = resolve(parent, "not-created");
    process.env.RB_CREDENTIAL_HOME = root;

    expect(await renderedList()).toBe("Nenhuma credencial de provedor configurada.\n");
    await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("projects only safe fields, sorts deterministically, and marks namespace-local defaults", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rb-login-list-order-"));
    process.env.RB_CREDENTIAL_HOME = root;
    await saveCredential({ provider: "opencode-zen", protocol: "api-key", label: "shared", secret: "zen-secret" });
    await saveCredential({ provider: "opencode-go", protocol: "api-key", label: "production", secret: "go-production-secret" });
    await saveCredential({ provider: "opencode-go", protocol: "api-key", label: "backup", secret: "go-backup-secret", makeDefault: false });
    await saveCredential({ provider: "deepseek", protocol: "api-key", label: "primary", secret: "deepseek-secret" });

    expect(await credentialListMetadata()).toEqual([
      { provider: "DeepSeek API", namespace: "deepseek", label: "primary", id: "deepseek:primary", default: true },
      { provider: "OpenCode Go", namespace: "opencode-go", label: "backup", id: "opencode-go:backup", default: false },
      { provider: "OpenCode Go", namespace: "opencode-go", label: "production", id: "opencode-go:production", default: true },
      { provider: "OpenCode Zen", namespace: "opencode-zen", label: "shared", id: "opencode-zen:shared", default: true },
    ]);
  });

  test("never emits plaintext secrets, encrypted fields, attributes, or vault material", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rb-login-list-secrets-"));
    process.env.RB_CREDENTIAL_HOME = root;
    const sentinels = [
      "OPENAI_SECRET_SENTINEL",
      "DEEPSEEK_SECRET_SENTINEL",
      "OPENCODE_GO_SECRET_SENTINEL",
      "OPENCODE_ZEN_SECRET_SENTINEL",
    ];
    await saveCredential({ provider: "openai", protocol: "api-key", label: "openai", secret: sentinels[0] });
    await saveCredential({ provider: "deepseek", protocol: "api-key", label: "deepseek", secret: sentinels[1] });
    await saveCredential({ provider: "opencode-go", protocol: "api-key", label: "go", secret: sentinels[2] });
    await saveCredential({ provider: "opencode-zen", protocol: "api-key", label: "zen", secret: sentinels[3] });

    const text = await renderedList();
    const json = await renderedList(true);
    const cliResult = await run(process.execPath, [resolve(process.cwd(), "dist/cli.js"), "--login", "--list"], {
      env: { ...process.env, RB_CREDENTIAL_HOME: root },
    });
    for (const sentinel of sentinels) {
      expect(text).not.toContain(sentinel);
      expect(json).not.toContain(sentinel);
      expect(cliResult.stdout).not.toContain(sentinel);
      expect(cliResult.stderr).not.toContain(sentinel);
    }
    for (const forbidden of ["ciphertext", "algorithm", "\"iv\"", "\"tag\"", "attributes", ".provider-vault-key"]) {
      expect(text).not.toContain(forbidden);
      expect(json).not.toContain(forbidden);
      expect(cliResult.stdout).not.toContain(forbidden);
      expect(cliResult.stderr).not.toContain(forbidden);
    }
    expect(cliResult.stderr).toBe("");
  });

  test("reads an existing v1 OpenCode document without migration, rewrite, re-encryption, or a vault key", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rb-login-list-v1-"));
    process.env.RB_CREDENTIAL_HOME = root;
    const document = `${JSON.stringify({
      contract: "rb-provider-credentials/v1",
      defaults: { "opencode-go": "opencode-go:shared", "opencode-zen": "opencode-zen:shared" },
      credentials: [
        {
          id: "opencode-go:shared", provider: "opencode-go", protocol: "api-key", label: "shared", storage: "encrypted-vault",
          secret: { algorithm: "aes-256-gcm", iv: "GO_IV_SENTINEL", tag: "GO_TAG_SENTINEL", ciphertext: "GO_CIPHERTEXT_SENTINEL" },
          createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "opencode-zen:shared", provider: "opencode-zen", protocol: "api-key", label: "shared", storage: "encrypted-vault",
          secret: { algorithm: "aes-256-gcm", iv: "ZEN_IV_SENTINEL", tag: "ZEN_TAG_SENTINEL", ciphertext: "ZEN_CIPHERTEXT_SENTINEL" },
          createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    }, null, 2)}\n`;
    await writeFile(credentialStorePaths().metadata, document, { encoding: "utf8", mode: 0o600 });
    const before = await readFile(credentialStorePaths().metadata, "utf8");

    const output = await renderedList();
    const after = await readFile(credentialStorePaths().metadata, "utf8");
    expect(output).toContain("OpenCode Go\topencode-go\tshared\topencode-go:shared\tyes");
    expect(output).toContain("OpenCode Zen\topencode-zen\tshared\topencode-zen:shared\tyes");
    expect(output).not.toMatch(/(?:GO|ZEN)_(?:IV|TAG|CIPHERTEXT)_SENTINEL/);
    expect(after).toBe(before);
    expect(sha256(after)).toBe(sha256(before));
    await expect(stat(credentialStorePaths().key)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("keeps identical labels and updates isolated across Go and Zen", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rb-login-list-isolation-"));
    process.env.RB_CREDENTIAL_HOME = root;
    await saveCredential({ provider: "opencode-go", protocol: "api-key", label: "shared", secret: "go-before" });
    await saveCredential({ provider: "opencode-zen", protocol: "api-key", label: "shared", secret: "zen-before" });
    await saveCredential({ provider: "opencode-go", protocol: "api-key", label: "shared", secret: "go-after" });

    expect((await resolveCredential("opencode-go", "shared")).secret).toBe("go-after");
    expect((await resolveCredential("opencode-zen", "shared")).secret).toBe("zen-before");
    expect((await credentialListMetadata()).filter((entry) => entry.label === "shared")).toHaveLength(2);
  });

  test("falls back to an unknown runtime namespace without crashing or exposing private fields", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rb-login-list-future-"));
    process.env.RB_CREDENTIAL_HOME = root;
    await writeFile(credentialStorePaths().metadata, `${JSON.stringify({
      contract: "rb-provider-credentials/v1",
      defaults: { "future-provider": "future-provider:main" },
      credentials: [{
        id: "future-provider:main", provider: "future-provider", protocol: "api-key", label: "main", storage: "encrypted-vault",
        secret: { algorithm: "aes-256-gcm", iv: "future-iv", tag: "future-tag", ciphertext: "FUTURE_SECRET_MATERIAL" },
        attributes: { private: "ATTRIBUTE_SENTINEL" },
        createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      }],
    }, null, 2)}\n`, "utf8");

    expect(await renderedList()).toBe(
      "Provider\tNamespace\tLabel\tCredential ID\tDefault\n"
      + "future-provider\tfuture-provider\tmain\tfuture-provider:main\tyes\n",
    );
  });

  test("the built --login --list route is non-interactive and emits no stderr", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rb-login-list-cli-"));
    process.env.RB_CREDENTIAL_HOME = root;
    await saveCredential({ provider: "opencode-go", protocol: "api-key", label: "cli", secret: "CLI_SECRET_SENTINEL" });
    const cli = resolve(process.cwd(), "dist/cli.js");

    const result = await run(process.execPath, [cli, "--login", "--list"], {
      env: { ...process.env, RB_CREDENTIAL_HOME: root },
    });
    expect(result.stdout).toContain("OpenCode Go\topencode-go\tcli\topencode-go:cli\tyes");
    expect(result.stdout).not.toContain("CLI_SECRET_SENTINEL");
    expect(result.stderr).toBe("");
  });
});
