import { stdout } from "node:process";
import { probeDirectProvider } from "./api-agent.js";
import { listCredentials } from "./credential-store.js";
import {
  CLI_PROVIDER_IDS,
  DIRECT_PROVIDERS,
  isDirectProvider,
  type DirectProviderId,
} from "./provider-registry.js";

interface SafeCredentialSummary {
  id: string;
  label: string;
  protocol: string;
  storage: string;
  default: boolean;
}

export interface ProviderListEntry {
  id: string;
  label: string;
  kind: "cli" | "direct-api" | "custom-adapter";
  auth: string[];
  configuration: "external-login" | "configured" | "not-configured" | "per-command";
  credentials: SafeCredentialSummary[];
}

const CLI_LABELS: Record<string, string> = {
  codex: "Codex CLI",
  claude: "Claude Code",
  opencode: "OpenCode",
  custom: "Custom adapter",
};

export async function providerListValue(): Promise<{ contract: "rb-provider-list/v1"; providers: ProviderListEntry[] }> {
  const saved = await listCredentials();
  const cli: ProviderListEntry[] = CLI_PROVIDER_IDS.map((id) => ({
    id,
    label: CLI_LABELS[id] ?? id,
    kind: id === "custom" ? "custom-adapter" : "cli",
    auth: [id === "custom" ? "adapter-defined" : "provider-cli-login"],
    configuration: id === "custom" ? "per-command" : "external-login",
    credentials: [],
  }));
  const direct: ProviderListEntry[] = DIRECT_PROVIDERS.map((provider) => {
    const credentials = saved
      .filter((record) => record.provider === provider.id)
      .map((record) => ({
        id: record.id,
        label: record.label,
        protocol: record.protocol,
        storage: record.storage,
        default: record.default,
      }));
    return {
      id: provider.id,
      label: provider.label,
      kind: "direct-api",
      auth: provider.auth.map((protocol) => protocol.id),
      configuration: credentials.length ? "configured" : "not-configured",
      credentials,
    };
  });
  return { contract: "rb-provider-list/v1", providers: [...cli, ...direct] };
}

export async function printProviderList(json = false): Promise<void> {
  const value = await providerListValue();
  if (json) {
    stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  stdout.write("PROVIDER\tTIPO\tAUTENTICAÇÃO\tESTADO\tCREDENCIAIS\n");
  for (const provider of value.providers) {
    const credentials = provider.credentials.length
      ? provider.credentials.map((entry) => `${entry.id} (${entry.protocol}${entry.default ? ", padrão" : ""})`).join(", ")
      : "—";
    stdout.write(`${provider.id}\t${provider.kind}\t${provider.auth.join(",")}\t${provider.configuration}\t${credentials}\n`);
  }
  stdout.write("\nConfigure APIs diretas com: rb-harness --login\n");
}

export async function testProviderConnection(options: {
  provider: string;
  model: string;
  effort?: string;
  credential?: string;
  timeout: number;
  json?: boolean;
}): Promise<void> {
  if (!isDirectProvider(options.provider)) {
    throw new Error("provider test supports direct APIs only: openai, anthropic, gemini, deepseek, minimax, openrouter");
  }
  const result = await probeDirectProvider({
    provider: options.provider as DirectProviderId,
    model: options.model,
    effort: options.effort,
    credential: options.credential,
    timeoutSeconds: options.timeout,
  });
  if (options.json) {
    stdout.write(`${JSON.stringify({ contract: "rb-provider-test/v1", status: "connected", ...result }, null, 2)}\n`);
    return;
  }
  stdout.write(`OK: ${result.provider}/${result.model} conectado via ${result.protocol} (${result.credentialId})\n`);
  stdout.write(`PING → ${result.pong ? "PONG" : result.response}\n`);
  stdout.write(`Latência: ${result.latencyMilliseconds} ms${result.totalTokens ? ` · Tokens: ${result.totalTokens}` : ""}\n`);
}
