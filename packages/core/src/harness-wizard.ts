import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { formatProjectInventory, inspectProjectInventory } from "./harness-inventory.js";
import { playHarnessSplash } from "./harness-splash.js";
import { resumableRuns, resumeStandaloneWorkflow, runStandaloneWorkflow } from "./standalone-runner.js";
import { PROVIDER_HELP, isDirectProvider, isCliProvider } from "./provider-registry.js";
import { finishHarnessDashboard, startHarnessDashboard } from "./harness-dashboard.js";
import type { HarnessWorkflow, ProviderConfiguration } from "./standalone-types.js";

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * Ask until the answer is one of the offered choices.
 *
 * A single `question()` accepts whatever arrives, so pasting a request into the
 * "digitar ou arquivo" prompt used to be read as a mode, silently swallowing
 * the pasted line and leaving the rest of the paste to be consumed — one line
 * each — by the questions that followed.
 */
export interface WizardPrompt {
  ask: (prompt: string) => Promise<string>;
  write: (text: string) => void;
}

export async function askChoice(
  io: WizardPrompt,
  prompt: string,
  choices: readonly string[],
  fallback: string,
): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const answer = (await io.ask(prompt)).trim().toLowerCase();
    if (!answer) return fallback;
    if (choices.includes(answer)) return answer;
    io.write(`Responda com ${choices.join(", ")} — recebi ${answer.length} caractere(s) que não são uma dessas opções.\n`);
    if (answer.length > 40) {
      io.write("Se você colou o pedido aqui, escolha \"digitar\" primeiro; o texto completo é pedido na pergunta seguinte.\n");
    }
  }
  throw new Error(`resposta inválida após 5 tentativas; esperado: ${choices.join(", ")}`);
}

/**
 * Read a request that spans several lines.
 *
 * A request is normally a paragraph or a pasted specification, and `question()`
 * returns at the first newline. Everything after it stayed in the input buffer
 * and was answered into the following prompts, which is how a pasted brief
 * ended up scattered across the provider, model, and effort answers.
 */
export async function askRequest(io: WizardPrompt, prompt: string): Promise<string> {
  io.write(`${prompt}\n`);
  io.write("Cole ou digite quantas linhas quiser. Finalize com uma linha contendo apenas . (ponto) ou pressione Ctrl-D.\n");
  const lines: string[] = [];
  for (;;) {
    let line: string;
    try {
      line = await io.ask("> ");
    } catch {
      break; // Ctrl-D closes the interface.
    }
    if (line.trim() === ".") break;
    lines.push(line);
  }
  return lines.join("\n").trim();
}

async function directory(path: string): Promise<string> {
  const absolute = resolve(path);
  const info = await lstat(absolute);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`directory does not exist: ${path}`);
  return absolute;
}

export interface LegacyWorkflowWizardOptions {
  readonly selectedWorkflow?: Exclude<HarnessWorkflow, "init">;
  readonly dashboard?: boolean;
  readonly splash?: boolean;
}

/** Presentation retained for non-Init legacy workflows during the Init cutover. */
export async function runHarnessWizard(version: string, options: LegacyWorkflowWizardOptions = {}): Promise<void> {
  if (options.splash !== false) await playHarnessSplash(version);
  const terminal = createInterface({ input, output });
  try {
    process.stdout.write("RB Harness · geração assistida de artefatos\n\n");
    const projectAnswer = (await terminal.question(`Pasta do projeto [${process.cwd()}]: `)).trim();
    const projectRoot = await directory(projectAnswer || process.cwd());
    const defaultArtifacts = await lstat(resolve(projectRoot, ".rb")).then(() => ".rb").catch(async () =>
      lstat(resolve(projectRoot, ".spec")).then(() => ".spec").catch(() => ".rb"));
    const artifactDirectory = (await terminal.question(`Pasta de saída dos artefatos [${defaultArtifacts}]: `)).trim() || defaultArtifacts;
    const inventory = await inspectProjectInventory(projectRoot, artifactDirectory);
    process.stdout.write(`\n${formatProjectInventory(inventory)}\n`);
    if (inventory.manifestFound) {
      process.stdout.write(
        "\nO conjunto atual será usado como contexto. Você pode complementar, corrigir, replanejar ou evoluir o projeto; " +
        "a publicação só ocorre após validação e a revisão anterior fica preservada no histórico da execução.\n",
      );
    }

    const unfinished = (await resumableRuns(projectRoot)).filter((state) => state.workflow === options.selectedWorkflow);
    if (unfinished.length) {
      const latest = unfinished.at(-1)!;
      const resume = (await terminal.question(`\nGeração interrompida encontrada (${latest.id}, ${latest.status}). Retomar? [S/n]: `)).trim();
      if (!/^(?:n|nao|não|no)$/i.test(resume)) {
        terminal.close();
        await resumeStandaloneWorkflow(projectRoot, latest.id);
        return;
      }
    }

    if (!options.selectedWorkflow) process.stdout.write("\nO que deseja fazer?\n");
    const workflows: Array<[Exclude<HarnessWorkflow, "init">, string]> = [
      ["ai-context", "Mapear o AS IS de um projeto implementado"],
      ["plan", "Planejar uma funcionalidade ou correção isolada"],
      ["evolve", "Planejar uma mudança em comportamento existente"],
      ["review", "Executar um code review de produto completo"],
    ];
    if (!options.selectedWorkflow) workflows.forEach(([, label], index) => process.stdout.write(`  ${index + 1}) ${label}\n`));
    const workflowIndex = options.selectedWorkflow === undefined
      ? Number((await terminal.question("Escolha [2]: ")).trim() || "2") - 1
      : -1;
    const workflow = options.selectedWorkflow ?? workflows[workflowIndex]?.[0];
    if (!workflow) throw new Error("workflow inválido");

    let request = "";
    let requestSource: string | undefined;
    if (workflow === "ai-context") request = "Reverse-engineer this implemented project into evidence-grounded AS IS documentation.";
    else if (workflow === "review") request = "Audit this implemented project end to end and record evidence-grounded findings.";
    const io: WizardPrompt = {
      ask: (prompt) => terminal.question(prompt),
      write: (text) => void process.stdout.write(text),
    };
    const sourceMode = await askChoice(
      io,
      `Pedido: digitar ou arquivo [${request ? "padrão/digitar/arquivo" : "digitar/arquivo"}]: `,
      request ? ["padrao", "padrão", "digitar", "arquivo"] : ["digitar", "arquivo"],
      request ? "padrao" : "digitar",
    );
    if (sourceMode === "arquivo") {
      const path = (await terminal.question("Caminho do arquivo: ")).trim();
      if (!path) throw new Error("o caminho do arquivo não pode ficar vazio");
      const absolute = resolve(projectRoot, path);
      const info = await lstat(absolute);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) throw new Error("arquivo de pedido inválido");
      request = await readFile(absolute, "utf8");
      requestSource = absolute;
    } else if (sourceMode === "digitar" || !request) {
      request = await askRequest(io, "Descreva o pedido:");
    }
    if (!request.trim()) throw new Error("o pedido não pode ficar vazio");
    const requestForCommand = request;

    let depth: string | undefined;
    let planAllConfirmed = false;
    if (workflow === "ai-context" || workflow === "review") {
      depth = (await terminal.question("Profundidade (quick/balanced/deep) [balanced]: ")).trim() || "balanced";
      if (!["quick", "balanced", "deep"].includes(depth)) throw new Error("profundidade inválida");
      request += `\n\nRB Harness operator controls (authoritative):\n- Inspection depth: ${depth}.`;
    }
    if (workflow === "review") {
      const remediation = (await terminal.question("Após a auditoria, planejar todos os achados CONFIRMED? [s/N]: ")).trim();
      planAllConfirmed = /^(?:s|sim|yes|y)$/i.test(remediation);
      if (planAllConfirmed) {
        request += "\n- Remediation selector: plan every and only CONFIRMED finding after the audit set is frozen; do not create a zero-finding plan.";
      }
    }

    const providerName = (await terminal.question(`Provider (${PROVIDER_HELP}) [codex]: `)).trim() || "codex";
    if (!isCliProvider(providerName) && !isDirectProvider(providerName)) throw new Error("provider inválido");
    const model = (await terminal.question("Modelo (vazio usa o padrão do provider): ")).trim();
    if (isDirectProvider(providerName) && !model) throw new Error("providers de API direta exigem o ID explícito do modelo");
    const effort = (await terminal.question("Effort (vazio usa o padrão do provider; no DeepSeek direto o padrão é none, sem reasoning): ")).trim();
    let command: string | undefined;
    let credential: string | undefined;
    if (providerName === "custom") {
      command = (await terminal.question("Executável do adapter customizado: ")).trim();
      if (!command) throw new Error("adapter customizado não informado");
    }
    if (isDirectProvider(providerName)) {
      credential = (await terminal.question("Credencial salva (ID/rótulo; vazio usa a padrão): ")).trim() || undefined;
      process.stdout.write("Se ainda não estiver autenticado, cancele e execute rb-harness --login.\n");
    }
    const provider: ProviderConfiguration = {
      provider: providerName as ProviderConfiguration["provider"], model, effort,
      ...(command ? { command } : {}), ...(credential ? { credential } : {}),
    };
    const args = [workflow, "--project", projectRoot, "--output", artifactDirectory, "--provider", providerName];
    if (requestSource) args.push("--file", requestSource); else args.push("--prompt", requestForCommand);
    if (model) args.push("--model", model);
    if (effort) args.push("--effort", effort);
    if (command) args.push("--adapter", command);
    if (credential) args.push("--credential", credential);
    if (depth) args.push("--depth", depth);
    if (planAllConfirmed) args.push("--plan-all-confirmed");
    const dashboardAnswer = options.dashboard === undefined
      ? (await terminal.question("Usar o dashboard ao vivo? [S/n]: ")).trim()
      : undefined;
    const dashboard = options.dashboard ?? !/^(?:n|nao|não|no)$/i.test(dashboardAnswer ?? "");
    if (dashboard) args.push("--dashboard");
    process.stdout.write(`\nComando equivalente:\n  rb-harness ${args.map(shellQuote).join(" ")}\n`);
    const execute = (await terminal.question("\nExecutar agora? [S/n]: ")).trim();
    if (/^(?:n|nao|não|no)$/i.test(execute)) {
      process.stdout.write("Cancelado; nenhum provider foi iniciado.\n");
      return;
    }
    terminal.close();
    if (dashboard) startHarnessDashboard(version);
    try {
      await runStandaloneWorkflow({
        workflow,
        projectRoot,
        artifactDirectory,
        request: request.trim(),
        requestSource,
        provider,
        questionMode: "one-by-one",
        nonInteractive: false,
        timeoutSeconds: 3600,
        firstOutputTimeoutSeconds: 300,
      });
    } finally {
      if (dashboard) finishHarnessDashboard();
    }
  } finally {
    terminal.close();
  }
}
