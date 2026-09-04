import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { askRequest, type WizardPrompt } from "./harness-wizard.js";
import { playHarnessSplash } from "./harness-splash.js";
import {
  groupWizardProfiles,
  selectWizardModel,
  selectWizardProvider,
  type WizardSelectableProfile,
} from "./wizard-profile-selector.js";

async function projectDirectory(value: string): Promise<string> {
  const absolute = resolve(value);
  const info = await lstat(absolute);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`directory does not exist: ${value}`);
  return absolute;
}

export type InitWizardProfile = WizardSelectableProfile;

export interface CollectedInitWizardConfiguration {
  readonly requestParts: readonly string[];
  readonly requestFile?: string;
  readonly profileId: string;
  readonly credential?: string;
  readonly projectRoot: string;
  readonly headless: false;
  readonly deadlineSeconds: number;
  readonly dashboard: boolean;
  readonly execute: boolean;
}

export async function collectInitWizardConfiguration(
  io: WizardPrompt,
  options: { readonly cwd: string; readonly profiles: readonly InitWizardProfile[]; readonly dashboard?: boolean },
): Promise<CollectedInitWizardConfiguration> {
  io.write("RB Harness Progressive Init · configuração\n\n");
  const projectAnswer = (await io.ask(`Pasta do projeto [${options.cwd}]: `)).trim();
  const projectRoot = await projectDirectory(projectAnswer || options.cwd);
  const profiles = options.profiles;
  if (!profiles.length) throw new Error("nenhum perfil Init suportado está registrado");
  const catalog = groupWizardProfiles(profiles);
  if (catalog.unclassified.length) {
    io.write(`\nPerfis sem canal reconhecido foram omitidos: ${catalog.unclassified.map((profile) => profile.id).join(", ")}\n`);
  }
  const provider = await selectWizardProvider(io, catalog.groups);
  const profile = await selectWizardModel(io, provider);
  io.write(`\nPerfil exato selecionado: ${profile.id}\n`);

  const source = (await io.ask("Pedido: digitar ou arquivo [digitar]: ")).trim().toLowerCase() || "digitar";
  let requestParts: string[] = [];
  let requestFile: string | undefined;
  if (source === "arquivo") {
    const path = (await io.ask("Caminho do arquivo: ")).trim();
    if (!path) throw new Error("o caminho do arquivo não pode ficar vazio");
    requestFile = resolve(projectRoot, path);
    const info = await lstat(requestFile);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) throw new Error("arquivo de pedido inválido");
    if (!(await readFile(requestFile, "utf8")).trim()) throw new Error("o pedido não pode ficar vazio");
  } else if (source === "digitar") {
    const request = await askRequest(io, "Descreva o pedido:");
    if (!request) throw new Error("o pedido não pode ficar vazio");
    requestParts = [request];
  } else {
    throw new Error("escolha digitar ou arquivo");
  }

  let credential: string | undefined;
  if (profile.transport === "direct-api") {
    credential = (await io.ask("Credencial salva (ID/rótulo; vazio usa a padrão): ")).trim() || undefined;
  }
  const dashboard = false;
  if (options.dashboard) {
    io.write("\nO dashboard Progressive ainda não está implementado; o Wizard continuará com progresso textual.\n");
  }
  io.write([
    "\nFluxo selecionado:\n",
    "  P1 Project Description\n",
    "  P2 User Stories\n",
    "  P3 Database Schema\n",
    "  P4 Project Phases\n",
    "  canonical closure → Ralph READY\n",
  ].join(""));
  const execute = !/^(?:n|nao|não|no)$/i.test((await io.ask("\nExecutar agora? [S/n]: ")).trim());
  return {
    requestParts,
    ...(requestFile ? { requestFile } : {}),
    profileId: profile.id,
    ...(credential ? { credential } : {}),
    projectRoot,
    headless: false,
    deadlineSeconds: 120,
    dashboard,
    execute,
  };
}

export async function runInitWizard(
  version: string,
  options: {
    readonly profiles: readonly InitWizardProfile[];
    readonly execute: (configuration: CollectedInitWizardConfiguration) => Promise<void>;
    readonly dashboard?: boolean;
    readonly splash?: boolean;
  },
): Promise<void> {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error("the Init wizard requires an interactive terminal");
  if (options.splash !== false) await playHarnessSplash(version);
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    const configuration = await collectInitWizardConfiguration(
      { ask: (prompt) => terminal.question(prompt), write: (text) => void stdout.write(text) },
      { cwd: process.cwd(), profiles: options.profiles, dashboard: options.dashboard },
    );
    if (!configuration.execute) {
      stdout.write("Cancelado; nenhum provider foi iniciado.\n");
      return;
    }
    terminal.close();
    await options.execute(configuration);
  } finally {
    terminal.close();
  }
}
