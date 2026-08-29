import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { listCredentials, removeCredential, saveCredential, credentialStorePaths, type CredentialRecord } from "./credential-store.js";
import {
  DIRECT_PROVIDERS,
  directProvider,
  isDirectProvider,
  type AuthProtocol,
  type DirectProviderId,
} from "./provider-registry.js";
import { isAnthropicWorkspaceId } from "./anthropic-credential.js";

interface LoginOptions {
  provider?: string;
  protocol?: string;
  label?: string;
}

interface ApiKeyLoginPrompts {
  readonly hidden: (prompt: string) => Promise<string>;
  readonly visible: (prompt: string, defaultValue?: string) => Promise<string>;
}

function requireInteractive(): void {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error("login requires an interactive terminal so credentials cannot leak through arguments or redirected input");
  }
}

async function question(prompt: string, defaultValue = ""): Promise<string> {
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    const suffix = defaultValue ? ` [${defaultValue}]` : "";
    const answer = (await terminal.question(`${prompt}${suffix}: `)).trim();
    return answer || defaultValue;
  } finally {
    terminal.close();
  }
}

async function choose<T extends { label: string }>(title: string, values: readonly T[]): Promise<T> {
  stdout.write(`\n${title}\n\n`);
  values.forEach((entry, index) => stdout.write(`  ${index + 1}) ${entry.label}\n`));
  while (true) {
    const answer = await question("Escolha", "1");
    if (/^[1-9][0-9]*$/.test(answer) && Number(answer) <= values.length) return values[Number(answer) - 1]!;
    stdout.write(`Informe um número entre 1 e ${values.length}.\n`);
  }
}

async function hiddenQuestion(prompt: string): Promise<string> {
  requireInteractive();
  stdout.write(`${prompt}: `);
  stdin.setRawMode?.(true);
  stdin.resume();
  let value = "";
  try {
    return await new Promise<string>((resolveSecret, reject) => {
      const onData = (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        for (const character of text) {
          if (character === "\u0003") {
            cleanup();
            stdout.write("\n");
            reject(new Error("login cancelled"));
            return;
          }
          if (character === "\r" || character === "\n") {
            cleanup();
            stdout.write("\n");
            resolveSecret(value.trim());
            return;
          }
          if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
          else if (character >= " ") value += character;
        }
      };
      const cleanup = () => stdin.off("data", onData);
      stdin.on("data", onData);
    });
  } finally {
    stdin.setRawMode?.(false);
    stdin.pause();
  }
}

/** Provider-auth collection only; the generic credential store remains provider-neutral. */
export async function saveApiKeyLoginCredential(input: {
  provider: DirectProviderId;
  providerLabel: string;
  label: string;
}, prompts: ApiKeyLoginPrompts = { hidden: hiddenQuestion, visible: question }): Promise<CredentialRecord> {
  const secret = await prompts.hidden(`API key de ${input.providerLabel} (entrada oculta)`);
  if (!secret) throw new Error("API key cannot be empty");
  let attributes: Record<string, string> | undefined;
  if (input.provider === "anthropic") {
    const workspaceId = await prompts.visible("Workspace ID da Anthropic (opcional; obrigatório para chaves vinculadas a identidade/múltiplos workspaces)");
    if (workspaceId && !isAnthropicWorkspaceId(workspaceId)) {
      throw new Error("Anthropic workspace ID must match wrkspc_ followed by letters or digits");
    }
    if (workspaceId) attributes = { workspaceId };
  }
  return saveCredential({
    provider: input.provider,
    protocol: "api-key",
    label: input.label,
    secret,
    ...(attributes ? { attributes } : {}),
  });
}

function runCommand(command: string, args: string[], options: { inherit?: boolean } = {}): Promise<{ code: number; output: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"] });
    let output = "";
    if (!options.inherit) {
      child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
      child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    }
    child.once("error", reject);
    child.once("close", (code) => resolveRun({ code: code ?? 1, output }));
  });
}

async function commandExists(command: string): Promise<boolean> {
  try { return (await runCommand(command, ["--version"])).code === 0; } catch { return false; }
}

function openBrowser(url: string): void {
  let command: string;
  let args: string[];
  if (process.platform === "darwin") [command, args] = ["open", [url]];
  else if (process.platform === "win32") [command, args] = ["cmd", ["/c", "start", "", url]];
  else [command, args] = ["xdg-open", [url]];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.once("error", () => undefined);
  child.unref();
}

async function openRouterOAuth(): Promise<string> {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  let settle: ((value: string) => void) | undefined;
  let rejectCode: ((error: Error) => void) | undefined;
  const codePromise = new Promise<string>((resolveCode, reject) => { settle = resolveCode; rejectCode = reject; });
  const server = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    if (!code || error) {
      response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      response.end("<h1>RB: autorização não concluída</h1><p>Volte ao terminal para tentar novamente.</p>");
      rejectCode?.(new Error(error ? `OpenRouter OAuth failed: ${error}` : "OpenRouter OAuth callback omitted the authorization code"));
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<h1>RB conectado ao OpenRouter</h1><p>Você já pode fechar esta janela e voltar ao terminal.</p>");
    settle?.(code);
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("could not allocate the local OAuth callback");
  const callbackUrl = `http://127.0.0.1:${address.port}/callback`;
  const authorization = new URL("https://openrouter.ai/auth");
  authorization.searchParams.set("callback_url", callbackUrl);
  authorization.searchParams.set("code_challenge", challenge);
  authorization.searchParams.set("code_challenge_method", "S256");
  stdout.write(`\nAbrindo o navegador para autorizar o OpenRouter.\nSe ele não abrir, use este link:\n${authorization}\n\n`);
  openBrowser(authorization.toString());
  const timeout = setTimeout(() => rejectCode?.(new Error("OpenRouter OAuth callback timed out after 5 minutes")), 300_000);
  timeout.unref();
  try {
    const code = await codePromise;
    const response = await fetch("https://openrouter.ai/api/v1/auth/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
    });
    const body = await response.json().catch(() => ({})) as { key?: string; error?: { message?: string }; message?: string };
    if (!response.ok || !body.key) {
      throw new Error(`OpenRouter OAuth exchange failed (${response.status}): ${body.error?.message || body.message || "no key returned"}`);
    }
    return body.key;
  } finally {
    clearTimeout(timeout);
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
}

async function googleAdcLogin(): Promise<Record<string, string>> {
  if (!(await commandExists("gcloud"))) {
    throw new Error("Gemini OAuth requires the Google Cloud CLI (gcloud); install it or choose API key");
  }
  const clientFile = resolve(await question("Arquivo JSON do OAuth Client desktop"));
  await access(clientFile);
  stdout.write("\nO gcloud abrirá o navegador para concluir o OAuth do Gemini.\n");
  const login = await runCommand("gcloud", [
    "auth", "application-default", "login",
    `--client-id-file=${clientFile}`,
    "--scopes=https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/generative-language.retriever",
  ], { inherit: true });
  if (login.code !== 0) throw new Error(`gcloud OAuth login exited with code ${login.code}`);
  const configured = await runCommand("gcloud", ["config", "get-value", "project"]);
  const defaultProject = configured.code === 0 && configured.output.trim() !== "(unset)" ? configured.output.trim() : "";
  const projectId = await question("Google Cloud project ID para cobrança/quota", defaultProject);
  if (!projectId) throw new Error("Gemini OAuth requires a Google Cloud project ID");
  return { projectId };
}

function selectedProtocol(providerId: DirectProviderId, requested?: string): AuthProtocol | undefined {
  if (!requested) return undefined;
  const definition = directProvider(providerId);
  const protocol = definition.auth.find((entry) => entry.id === requested);
  if (!protocol) throw new Error(`${providerId} does not support auth protocol ${requested}`);
  return protocol.id;
}

export async function runLoginWizard(options: LoginOptions = {}): Promise<void> {
  requireInteractive();
  stdout.write("\nRB · credenciais de provedores\nAs chaves nunca são aceitas por argumento, variável obrigatória ou arquivo de perfil.\n");
  const providerId = options.provider
    ? (() => { if (!isDirectProvider(options.provider!)) throw new Error(`unsupported login provider: ${options.provider}`); return options.provider!; })()
    : (await choose("Provedor", DIRECT_PROVIDERS)).id;
  const definition = directProvider(providerId);
  const requested = selectedProtocol(providerId, options.protocol);
  const protocol = requested ?? (definition.auth.length === 1 ? definition.auth[0]!.id : (await choose("Protocolo de autenticação", definition.auth)).id);
  const label = options.label?.trim() || await question("Nome desta credencial", "default");

  if (protocol === "api-key") {
    const record = await saveApiKeyLoginCredential({ provider: providerId, providerLabel: definition.label, label });
    stdout.write(`Credencial ${record.id} salva no cofre local compartilhado.\n`);
    return;
  }
  if (protocol === "oauth-pkce") {
    const secret = await openRouterOAuth();
    const record = await saveCredential({ provider: providerId, protocol, label, secret });
    stdout.write(`Credencial ${record.id} autorizada e salva no cofre local compartilhado.\n`);
    return;
  }
  const attributes = await googleAdcLogin();
  const record = await saveCredential({ provider: providerId, protocol, label, attributes });
  stdout.write(`Credencial ${record.id} vinculada ao Google ADC.\n`);
}

export async function printCredentialList(json = false): Promise<void> {
  const records = await listCredentials();
  if (json) {
    stdout.write(`${JSON.stringify({ store: credentialStorePaths().metadata, credentials: records }, null, 2)}\n`);
    return;
  }
  stdout.write(`Cofre: ${credentialStorePaths().metadata}\n`);
  if (!records.length) {
    stdout.write("Nenhuma credencial configurada. Use rb-harness --login.\n");
    return;
  }
  for (const record of records) stdout.write(`  ${record.id}\t${record.protocol}\t${record.storage}\n`);
}

export async function logoutCredential(selector: string): Promise<void> {
  const removed = await removeCredential(selector);
  stdout.write(`Credencial removida: ${removed.id}\n`);
}
