import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { stdout } from "node:process";
import { codexAuthStorePath, resolveCodexSubscriptionAuth } from "./auth.js";
import { codexSubscriptionAdapter } from "./adapter.js";

export const CODEX_SUBSCRIPTION_LOGIN = {
  id: "codex-subscription",
  label: "Codex / ChatGPT Subscription",
} as const;

function launch(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env });
    child.once("error", reject);
    child.once("close", (code) => resolveRun(code ?? 1));
  });
}

export async function runCodexSubscriptionLogin(): Promise<void> {
  try {
    await resolveCodexSubscriptionAuth();
    stdout.write("Codex / ChatGPT Subscription authentication detected (owned by rb-codex).\n");
    return;
  } catch {
    // Authentication remains rb-codex-owned; Harness only launches its official flow.
  }
  const runtime = await codexSubscriptionAdapter.runtimePreflight();
  if (!runtime.ok) throw new Error(runtime.error.message);
  const authFile = codexAuthStorePath();
  stdout.write("\nStarting the official rb-codex ChatGPT login flow. RB Harness does not receive or store token contents.\n\n");
  const code = await launch(runtime.value.executable, ["login"], { ...process.env, CODEX_HOME: dirname(authFile) });
  if (code !== 0) throw new Error(`rb-codex login exited with code ${code}`);
  await resolveCodexSubscriptionAuth();
  stdout.write("Codex / ChatGPT Subscription authentication detected.\n");
}

export const CODEX_EXTERNAL_LOGIN_PROVIDER = {
  ...CODEX_SUBSCRIPTION_LOGIN,
  aliases: ["codex"],
  run: runCodexSubscriptionLogin,
};
