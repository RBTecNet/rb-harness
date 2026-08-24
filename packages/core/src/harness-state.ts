import { chmod, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { HARNESS_VERSION } from "./version.js";
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

/**
 * Lock identity. Enough to tell an active run from residue left by a power
 * loss: the PID alone is ambiguous once it has been reused, and a lock written
 * on another machine (a shared checkout, a container) can never be probed by
 * `kill(0)` here at all.
 */
export interface HarnessLockRecord {
  pid: number;
  host: string;
  runId: string;
  harnessVersion: string;
  startedAt: string;
}

export function harnessLockDisposition(
  current: HarnessLockRecord | undefined,
  alive: (pid: number) => boolean = processAlive,
): { state: "free" | "active" | "residue"; reason?: string } {
  if (!current) return { state: "free" };
  if (current.host !== hostname()) {
    return { state: "active", reason: `held by PID ${current.pid} on host ${current.host}` };
  }
  if (current.pid === process.pid) return { state: "free" };
  if (alive(current.pid)) return { state: "active", reason: `held by live PID ${current.pid}` };
  return { state: "residue", reason: `PID ${current.pid} from ${current.startedAt} is no longer running` };
}

export async function acquireHarnessLock(projectRoot: string, runId: string): Promise<() => Promise<void>> {
  const root = harnessRunRoot(projectRoot, runId);
  const lock = resolve(root, ".lock.json");
  await mkdir(root, { recursive: true, mode: 0o700 });
  let current: HarnessLockRecord | undefined;
  try {
    const parsed = JSON.parse(await readFile(lock, "utf8")) as Partial<HarnessLockRecord>;
    if (typeof parsed.pid === "number") {
      current = {
        pid: parsed.pid,
        host: typeof parsed.host === "string" ? parsed.host : hostname(),
        runId: typeof parsed.runId === "string" ? parsed.runId : runId,
        harnessVersion: typeof parsed.harnessVersion === "string" ? parsed.harnessVersion : "unknown",
        startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "an unknown time",
      };
    }
  } catch {
    // A missing or unreadable lock is treated as residue and reported below.
  }
  const disposition = harnessLockDisposition(current);
  if (disposition.state === "active") {
    throw new Error(`Harness run is already active (${disposition.reason}): ${runId}`);
  }
  if (disposition.state === "residue") {
    process.stdout.write(`[rb-harness] lock residual recuperado automaticamente: ${disposition.reason}.\n`);
  }
  await rm(lock, { force: true });
  const record: HarnessLockRecord = {
    pid: process.pid,
    host: hostname(),
    runId,
    harnessVersion: HARNESS_VERSION,
    startedAt: new Date().toISOString(),
  };
  const handle = await open(lock, "wx", 0o600);
  await handle.writeFile(`${JSON.stringify(record)}\n`);
  await handle.close();
  return async () => { await rm(lock, { force: true }); };
}
