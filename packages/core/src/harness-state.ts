import { chmod, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { STANDALONE_STATE_CONTRACT, type HarnessRunState } from "./standalone-types.js";
import { emitHarnessDashboard } from "./harness-dashboard.js";

export function harnessStateRoot(projectRoot: string): string {
  return resolve(projectRoot, ".rb-harness/runs");
}

export function harnessRunRoot(projectRoot: string, runId: string): string {
  if (!/^[a-z0-9][a-z0-9-]{5,119}$/.test(runId)) throw new Error(`invalid Harness run ID: ${runId}`);
  return resolve(harnessStateRoot(projectRoot), runId);
}

export async function writeRunState(state: HarnessRunState): Promise<void> {
  state.updatedAt = new Date().toISOString();
  const path = resolve(harnessRunRoot(state.projectRoot, state.id), "state.json");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600).catch(() => undefined);
  emitHarnessDashboard({ type: "state", state });
}

export async function readRunState(projectRoot: string, runId: string): Promise<HarnessRunState> {
  const state = JSON.parse(await readFile(resolve(harnessRunRoot(projectRoot, runId), "state.json"), "utf8")) as HarnessRunState;
  if (state.contract !== STANDALONE_STATE_CONTRACT || state.id !== runId || resolve(state.projectRoot) !== resolve(projectRoot)) {
    throw new Error(`invalid or foreign Harness run state: ${runId}`);
  }
  return state;
}

export async function listRunStates(projectRoot: string): Promise<HarnessRunState[]> {
  const root = harnessStateRoot(projectRoot);
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return []; }
  const states: HarnessRunState[] = [];
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    try { states.push(await readRunState(projectRoot, entry.name)); } catch { /* invalid state is ignored by listing, not by explicit resume */ }
  }
  return states;
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function acquireHarnessLock(projectRoot: string, runId: string): Promise<() => Promise<void>> {
  const root = harnessRunRoot(projectRoot, runId);
  const lock = resolve(root, ".lock.json");
  await mkdir(root, { recursive: true, mode: 0o700 });
  try {
    const current = JSON.parse(await readFile(lock, "utf8")) as { pid?: number };
    if (typeof current.pid === "number" && current.pid !== process.pid && processAlive(current.pid)) {
      throw new Error(`Harness run is already active under PID ${current.pid}: ${runId}`);
    }
    await rm(lock, { force: true });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Harness run is already active")) throw error;
  }
  const handle = await open(lock, "wx", 0o600);
  await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
  await handle.close();
  return async () => { await rm(lock, { force: true }); };
}
