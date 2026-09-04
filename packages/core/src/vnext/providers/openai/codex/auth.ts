import { constants } from "node:fs";
import { access, lstat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ProviderOutcome, ResolvedProviderAuth } from "../../contract.js";

export const CODEX_SUBSCRIPTION_AUTH_ID = "codex-chatgpt-subscription";

export function codexAuthStorePath(home = process.env.HOME): string {
  if (!home?.trim()) throw new Error("Codex Subscription authentication requires HOME to resolve ~/.codex/auth.json");
  return resolve(home, ".codex", "auth.json");
}

/** Checks only file metadata/access. Harness never opens or parses the auth store. */
export async function resolveCodexSubscriptionAuth(home = process.env.HOME): Promise<ResolvedProviderAuth> {
  const path = codexAuthStorePath(home);
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile()) throw new Error("not a regular file");
    await access(path, constants.R_OK);
  } catch {
    throw new Error("Codex / ChatGPT Subscription authentication is unavailable; run rb-harness --login and choose Codex / ChatGPT Subscription");
  }
  return { kind: "external-auth-store", id: CODEX_SUBSCRIPTION_AUTH_ID, storeKind: "file", path };
}

export function validateCodexAuth(auth: ResolvedProviderAuth): ProviderOutcome<Extract<ResolvedProviderAuth, { kind: "external-auth-store" }>> {
  if (auth.kind !== "external-auth-store" || auth.id !== CODEX_SUBSCRIPTION_AUTH_ID || auth.storeKind !== "file") {
    return { ok: false, error: { kind: "auth", message: "Codex Subscription requires its rb-codex-owned file auth store", transportRetryable: false } };
  }
  return { ok: true, value: auth };
}
