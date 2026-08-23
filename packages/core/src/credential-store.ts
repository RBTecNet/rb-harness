import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type { AuthProtocol, DirectProviderId } from "./provider-registry.js";

const CONTRACT = "rb-provider-credentials/v1" as const;

interface EncryptedValue {
  algorithm: "aes-256-gcm";
  iv: string;
  tag: string;
  ciphertext: string;
}

export interface CredentialRecord {
  id: string;
  provider: DirectProviderId;
  protocol: AuthProtocol;
  label: string;
  storage: "encrypted-vault" | "external-adc";
  secret?: EncryptedValue;
  attributes?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

interface CredentialDocument {
  contract: typeof CONTRACT;
  defaults: Partial<Record<DirectProviderId, string>>;
  credentials: CredentialRecord[];
}

export interface ResolvedCredential {
  record: Omit<CredentialRecord, "secret">;
  secret?: string;
}

function configurationRoot(): string {
  if (process.env.RB_CREDENTIAL_HOME) return resolve(process.env.RB_CREDENTIAL_HOME);
  if (process.platform === "win32") return resolve(process.env.APPDATA || homedir(), "RB");
  if (process.platform === "darwin") return resolve(homedir(), "Library", "Application Support", "RB");
  return resolve(process.env.XDG_CONFIG_HOME || resolve(homedir(), ".config"), "rb");
}

export function credentialStorePaths(): { root: string; metadata: string; key: string } {
  const root = configurationRoot();
  return { root, metadata: resolve(root, "provider-credentials.json"), key: resolve(root, ".provider-vault-key") };
}

function emptyDocument(): CredentialDocument {
  return { contract: CONTRACT, defaults: {}, credentials: [] };
}

function credentialId(provider: DirectProviderId, label: string): string {
  const normalized = label.normalize("NFKC").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${provider}:${normalized || "default"}`;
}

async function ensureRoot(): Promise<void> {
  const { root } = credentialStorePaths();
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700).catch(() => undefined);
}

async function loadDocument(): Promise<CredentialDocument> {
  const { metadata } = credentialStorePaths();
  try {
    const value = JSON.parse(await readFile(metadata, "utf8")) as CredentialDocument;
    if (value.contract !== CONTRACT || !Array.isArray(value.credentials) || !value.defaults || typeof value.defaults !== "object") {
      throw new Error(`credential store has an unsupported contract: ${metadata}`);
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyDocument();
    throw error;
  }
}

async function atomicWrite(path: string, content: string, mode: number): Promise<void> {
  await ensureRoot();
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporary, content, { encoding: "utf8", mode, flag: "wx" });
  await chmod(temporary, mode).catch(() => undefined);
  await rename(temporary, path);
  await chmod(path, mode).catch(() => undefined);
}

async function vaultKey(): Promise<Buffer> {
  const { key } = credentialStorePaths();
  try {
    const encoded = (await readFile(key, "utf8")).trim();
    const value = Buffer.from(encoded, "base64");
    if (value.length !== 32) throw new Error(`invalid RB provider vault key: ${key}`);
    await chmod(key, 0o600).catch(() => undefined);
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const value = randomBytes(32);
    await atomicWrite(key, `${value.toString("base64")}\n`, 0o600);
    return value;
  }
}

async function encrypt(secret: string): Promise<EncryptedValue> {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", await vaultKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return {
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

async function decrypt(value: EncryptedValue): Promise<string> {
  if (value.algorithm !== "aes-256-gcm") throw new Error("credential uses an unsupported encryption algorithm");
  const decipher = createDecipheriv("aes-256-gcm", await vaultKey(), Buffer.from(value.iv, "base64"));
  decipher.setAuthTag(Buffer.from(value.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64")), decipher.final()]).toString("utf8");
}

async function saveDocument(document: CredentialDocument): Promise<void> {
  const { metadata } = credentialStorePaths();
  document.credentials.sort((left, right) => left.id.localeCompare(right.id));
  await atomicWrite(metadata, `${JSON.stringify(document, null, 2)}\n`, 0o600);
}

export async function saveCredential(input: {
  provider: DirectProviderId;
  protocol: AuthProtocol;
  label: string;
  secret?: string;
  attributes?: Record<string, string>;
  makeDefault?: boolean;
}): Promise<CredentialRecord> {
  const label = input.label.trim();
  if (!label || label.length > 80) throw new Error("credential label must contain 1-80 characters");
  if ((input.protocol === "api-key" || input.protocol === "oauth-pkce") && !input.secret?.trim()) {
    throw new Error(`${input.protocol} requires a non-empty secret`);
  }
  const document = await loadDocument();
  const id = credentialId(input.provider, label);
  const previous = document.credentials.find((entry) => entry.id === id);
  const now = new Date().toISOString();
  const record: CredentialRecord = {
    id,
    provider: input.provider,
    protocol: input.protocol,
    label,
    storage: input.protocol === "google-adc" ? "external-adc" : "encrypted-vault",
    ...(input.secret ? { secret: await encrypt(input.secret.trim()) } : {}),
    ...(input.attributes && Object.keys(input.attributes).length ? { attributes: input.attributes } : {}),
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
  document.credentials = document.credentials.filter((entry) => entry.id !== id);
  document.credentials.push(record);
  if (input.makeDefault !== false || !document.defaults[input.provider]) document.defaults[input.provider] = id;
  await saveDocument(document);
  return record;
}

export async function listCredentials(
  provider?: DirectProviderId,
): Promise<Array<Omit<CredentialRecord, "secret"> & { default: boolean }>> {
  const document = await loadDocument();
  return document.credentials
    .filter((entry) => !provider || entry.provider === provider)
    .map(({ secret: _secret, ...entry }) => ({
      ...entry,
      default: document.defaults[entry.provider] === entry.id,
    }));
}

export async function resolveCredential(provider: DirectProviderId, selector?: string): Promise<ResolvedCredential> {
  const document = await loadDocument();
  const candidates = document.credentials.filter((entry) => entry.provider === provider);
  const normalizedSelectorId = selector ? credentialId(provider, selector) : undefined;
  const record = selector
    ? candidates.find((entry) => entry.id === selector || entry.label === selector || entry.id === normalizedSelectorId)
    : candidates.find((entry) => entry.id === document.defaults[provider]) ?? (candidates.length === 1 ? candidates[0] : undefined);
  if (!record) {
    const hint = selector && candidates.length
      ? `selector '${selector}' did not match; available IDs: ${candidates.map((entry) => entry.id).join(", ")}`
      : candidates.length > 1 && !selector
        ? `multiple credentials exist (${candidates.map((entry) => entry.id).join(", ")}); select one with --credential`
        : `run rb-harness --login and configure ${provider}`;
    throw new Error(`no usable credential for ${provider}: ${hint}`);
  }
  const { secret: encrypted, ...publicRecord } = record;
  return { record: publicRecord, ...(encrypted ? { secret: await decrypt(encrypted) } : {}) };
}

export async function removeCredential(selector: string): Promise<CredentialRecord> {
  const document = await loadDocument();
  const matches = document.credentials.filter((entry) => entry.id === selector || entry.label === selector);
  if (matches.length !== 1) throw new Error(matches.length ? `credential label is ambiguous: ${selector}` : `credential not found: ${selector}`);
  const record = matches[0]!;
  document.credentials = document.credentials.filter((entry) => entry.id !== record.id);
  if (document.defaults[record.provider] === record.id) {
    const replacement = document.credentials.find((entry) => entry.provider === record.provider);
    if (replacement) document.defaults[record.provider] = replacement.id;
    else delete document.defaults[record.provider];
  }
  await saveDocument(document);
  return record;
}
