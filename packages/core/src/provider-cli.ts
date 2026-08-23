import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
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

export interface ProviderTestOptions {
  provider?: string;
  model?: string;
  effort?: string;
  credential?: string;
  timeout: number;
  json?: boolean;
}

export interface ProviderTestWizardIO {
  interactive: boolean;
  question(prompt: string): Promise<string>;
  write(value: string): void;
}

interface ResolvedProviderTestOptions extends ProviderTestOptions {
  provider: string;
  model: string;
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

function providerCliName(): "rb-harness" | "rb-ralph" {
  return process.env.RB_PROVIDER_CLI_NAME === "rb-ralph" ? "rb-ralph" : "rb-harness";
}

function loginCommand(): string {
  return providerCliName() === "rb-ralph" ? "rb-ralph --login" : "rb-harness --login";
}

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
  stdout.write(`\nConfigure APIs diretas com: ${loginCommand()}\n`);
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

async function selectNumber(io: ProviderTestWizardIO, prompt: string, defaultIndex: number, length: number): Promise<number> {
  while (true) {
    const answer = (await io.question(`${prompt} [${defaultIndex + 1}]: `)).trim();
    const selected = Number(answer || String(defaultIndex + 1)) - 1;
    if (Number.isInteger(selected) && selected >= 0 && selected < length) return selected;
    io.write(`Escolha um número entre 1 e ${length}.\n`);
  }
}

async function requiredAnswer(io: ProviderTestWizardIO, prompt: string, initial?: string): Promise<string> {
  if (initial?.trim()) return initial.trim();
  while (true) {
    const answer = (await io.question(prompt)).trim();
    if (answer) return answer;
    io.write("Este valor não pode ficar vazio.\n");
  }
}

export async function collectProviderTestWizardOptions(
  options: ProviderTestOptions,
  io: ProviderTestWizardIO,
): Promise<ResolvedProviderTestOptions | undefined> {
  if (!io.interactive) {
    throw new Error("provider test requires --provider and --model outside an interactive terminal");
  }
  if (options.json) {
    throw new Error("provider test --json requires --provider and --model so stdout remains valid JSON");
  }

  const registry = await providerListValue();
  const configured = registry.providers.filter((entry) => entry.kind === "direct-api" && entry.configuration === "configured");
  if (!configured.length) {
    throw new Error(`no direct API provider is configured; run ${loginCommand()} first`);
  }

  io.write("RB · teste assistido de provider\n\n");
  const requestedProvider = options.provider?.trim();
  let selected = requestedProvider ? configured.find((entry) => entry.id === requestedProvider) : undefined;
  if (requestedProvider && !isDirectProvider(requestedProvider)) {
    throw new Error("provider test supports direct APIs only: openai, anthropic, gemini, deepseek, minimax, openrouter");
  }
  if (requestedProvider && !selected) {
    throw new Error(`provider ${requestedProvider} has no configured credential; run ${loginCommand()} first`);
  }
  if (!selected) {
    io.write("Provedores configurados:\n");
    configured.forEach((entry, index) => {
      io.write(`  ${index + 1}) ${entry.label} (${entry.id}) · ${entry.credentials.length} credencial(is)\n`);
    });
    selected = configured[await selectNumber(io, "Escolha o provider", 0, configured.length)];
  }
  if (!selected) throw new Error("provider selection failed");

  let credential = options.credential?.trim() || undefined;
  if (!credential && selected.credentials.length === 1) {
    credential = selected.credentials[0]!.id;
    io.write(`Credencial: ${credential}\n`);
  } else if (!credential && selected.credentials.length > 1) {
    io.write("\nCredenciais disponíveis:\n");
    selected.credentials.forEach((entry, index) => {
      io.write(`  ${index + 1}) ${entry.label} (${entry.id})${entry.default ? " · padrão" : ""}\n`);
    });
    const defaultIndex = Math.max(0, selected.credentials.findIndex((entry) => entry.default));
    credential = selected.credentials[await selectNumber(io, "Escolha a credencial", defaultIndex, selected.credentials.length)]!.id;
  }

  const model = await requiredAnswer(io, "ID exato do modelo: ", options.model);
  const effort = options.effort === undefined
    ? (await io.question("Effort (vazio não envia): ")).trim() || undefined
    : options.effort.trim() || undefined;
  let timeout = options.timeout;
  while (true) {
    const answer = (await io.question(`Timeout em segundos [${timeout}]: `)).trim();
    const candidate = Number(answer || timeout);
    if (Number.isInteger(candidate) && candidate >= 1 && candidate <= 900) {
      timeout = candidate;
      break;
    }
    io.write("Informe um inteiro entre 1 e 900.\n");
  }

  const args = ["provider", "test", "--provider", selected.id, "--model", model];
  if (credential) args.push("--credential", credential);
  args.push("--timeout", String(timeout));
  if (effort) args.push("--effort", effort);
  io.write(`\nComando equivalente:\n  ${providerCliName()} ${args.map(shellQuote).join(" ")}\n`);
  const execute = (await io.question("\nExecutar teste agora? [S/n]: ")).trim();
  if (/^(?:n|nao|não|no)$/i.test(execute)) {
    io.write("Cancelado; nenhuma requisição foi enviada ao provider.\n");
    return undefined;
  }
  return { provider: selected.id, model, credential, effort, timeout };
}

export async function runProviderTestCommand(options: ProviderTestOptions): Promise<void> {
  let resolved: ResolvedProviderTestOptions | undefined;
  if (options.provider?.trim() && options.model?.trim()) {
    resolved = { ...options, provider: options.provider.trim(), model: options.model.trim() };
  } else {
    const terminal = createInterface({ input: stdin, output: stdout });
    try {
      resolved = await collectProviderTestWizardOptions(options, {
        interactive: Boolean(stdin.isTTY && stdout.isTTY),
        question: (prompt) => terminal.question(prompt),
        write: (value) => stdout.write(value),
      });
    } finally {
      terminal.close();
    }
  }
  if (resolved) await testProviderConnection(resolved);
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
