import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { playHarnessSplash } from "./harness-splash.js";
import { runHarnessWizard, type WizardPrompt } from "./harness-wizard.js";
import type { HarnessWorkflow } from "./standalone-types.js";

export const ROOT_OPERATIONS = [
  { key: "init", label: "Init · criar um plano Ralph para um projeto novo" },
  { key: "ai-context", label: "AI Context · mapear o AS IS de um projeto implementado" },
  { key: "plan", label: "Plan · planejar uma mudança isolada" },
  { key: "evolve", label: "Evolve · evoluir comportamento existente" },
  { key: "review", label: "Review · auditar o produto" },
] as const satisfies readonly { readonly key: HarnessWorkflow; readonly label: string }[];

export async function selectRootOperation(io: WizardPrompt): Promise<HarnessWorkflow> {
  io.write("RB Harness 🦫\n\nO que você quer fazer?\n\n");
  ROOT_OPERATIONS.forEach((operation, index) => io.write(`  ${index + 1}) ${operation.label}\n`));
  const raw = (await io.ask("Escolha [1]: ")).trim() || "1";
  const byNumber = ROOT_OPERATIONS[Number(raw) - 1]?.key;
  const byKey = ROOT_OPERATIONS.find((operation) => operation.key === raw.toLowerCase())?.key;
  const selected = byNumber ?? byKey;
  if (!selected) throw new Error("operação inválida");
  return selected;
}

export async function dispatchRootOperation(
  workflow: HarnessWorkflow,
  version: string,
  options: { readonly dashboard?: boolean },
  handlers: {
    readonly runInit: (input: { readonly dashboard?: boolean; readonly splash?: boolean }) => Promise<void>;
    readonly runLegacy?: typeof runHarnessWizard;
  },
): Promise<void> {
  if (workflow === "init") {
    await handlers.runInit({ dashboard: options.dashboard, splash: false });
    return;
  }
  await (handlers.runLegacy ?? runHarnessWizard)(version, { selectedWorkflow: workflow, dashboard: options.dashboard, splash: false });
}

export async function runRootWizard(version: string, options: {
  readonly dashboard?: boolean;
  readonly splash?: boolean;
  readonly runInit: (input: { readonly dashboard?: boolean; readonly splash?: boolean }) => Promise<void>;
}): Promise<void> {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error("the root wizard requires an interactive terminal");
  if (options.splash !== false) await playHarnessSplash(version);
  const terminal = createInterface({ input: stdin, output: stdout });
  let workflow: HarnessWorkflow;
  try {
    workflow = await selectRootOperation({ ask: (prompt) => terminal.question(prompt), write: (text) => void stdout.write(text) });
  } finally {
    terminal.close();
  }
  await dispatchRootOperation(workflow, version, options, { runInit: options.runInit });
}
