/**
 * Real ownership of a provider process tree.
 *
 * A provider CLI can create nested sandbox sessions, helper daemons, and
 * grandchildren that trap `SIGTERM`. Killing only the direct child leaves those
 * descendants running, consuming provider quota and holding the Harness lock
 * hostage. Every spawn therefore starts a detached POSIX process group (or a
 * Windows job tree) and is torn down through one idempotent ladder:
 *
 *   1. close admission so no new action starts;
 *   2. `SIGTERM` the whole tree;
 *   3. wait one short bounded grace window;
 *   4. `SIGKILL` the survivors;
 *   5. confirm quiescence before the caller may release the run lock.
 *
 * The escalation timer is never cancelled merely because the direct child
 * exited: the leader dying does not mean the tree died.
 */

import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { HARNESS_BUDGET } from "./harness-budget.js";
import { createTreeContainment, type ContainmentSupport, type TreeContainment } from "./process-containment.js";

export interface ProcessTreeSpawnOptions extends SpawnOptions {
  /** Milliseconds between SIGTERM and the SIGKILL escalation. */
  graceMilliseconds?: number;
  /** Test seam: force a specific containment mechanism. */
  containment?: TreeContainment;
}

/**
 * The outcome of settling a tree. `verified` is the honest part: it is true
 * only when the containment mechanism can enumerate membership independently
 * of the parent chain, so absence really means absence.
 */
export interface SettleOutcome {
  quiescent: boolean;
  verified: boolean;
  containment: ContainmentSupport;
  /** Members still alive, when the mechanism can tell. */
  survivors: number[];
}

export interface ProcessTreeHandle {
  readonly pid: number;
  readonly child: ChildProcess;
  /** What this platform could actually guarantee for this tree. */
  readonly containment: ContainmentSupport;
  /** PIDs of this tree that are alive right now. */
  liveMembers(): number[];
  /**
   * Record the tree's current membership immediately. Callers invoke this at
   * the first sign of life so a short-lived leader cannot detach a survivor
   * and exit between two periodic samples.
   */
  sample(): void;
  /**
   * Confirm the tree is gone, escalating first when it is not. A leader that
   * exits with code zero says nothing about the descendants it detached, so
   * every run settles through here — not only the failing ones.
   */
  settle(reason: string, timeoutMilliseconds?: number): Promise<SettleOutcome>;
  /** Whether a teardown ladder has already started. */
  terminating(): boolean;
  /** Reason recorded by the first teardown request. */
  terminationReason(): string | undefined;
  /** Start (or re-arm) the idempotent teardown ladder. */
  terminate(reason: string): void;
  /** Resolve once no member of the tree is alive; false when the wait timed out. */
  waitForQuiescence(timeoutMilliseconds?: number): Promise<boolean>;
  /** Synchronous last-resort kill used on host exit. */
  terminateForHostExit(): void;
  /** Stop tracking this tree once the caller has confirmed quiescence. */
  dispose(): void;
}

export interface ProcessRow {
  pid: number;
  parentPid: number;
  groupId: number;
  zombie: boolean;
}

const handles = new Set<ProcessTreeHandle>();
let shutdownInstalled = false;
let shuttingDown = false;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, milliseconds);
  });
}

/** One process-table snapshot; an empty list means the table was unreadable. */
export function readProcessTable(): ProcessRow[] {
  if (process.platform === "win32") return [];
  const listed = spawnSync("ps", ["-axo", "pid=,ppid=,pgid=,stat="], {
    encoding: "utf8",
    timeout: 4_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (listed.status !== 0 || !listed.stdout) return [];
  const rows: ProcessRow[] = [];
  for (const line of listed.stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)/);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      groupId: Number(match[3]),
      zombie: (match[4] ?? "").startsWith("Z"),
    });
  }
  return rows;
}

/**
 * Live members of the tree rooted at `rootPid`: the process group plus every
 * transitive descendant that escaped it. Unreaped zombies are excluded — they
 * still answer `kill(0)` but can execute no work.
 */
export function liveTreeMembers(rootPid: number, rows = readProcessTable()): number[] {
  const children = new Map<number, number[]>();
  const byPid = new Map<number, ProcessRow>();
  for (const row of rows) {
    byPid.set(row.pid, row);
    const siblings = children.get(row.parentPid) ?? [];
    siblings.push(row.pid);
    children.set(row.parentPid, siblings);
  }
  const members = new Set<number>();
  const visit = (pid: number): void => {
    for (const child of children.get(pid) ?? []) {
      if (members.has(child)) continue;
      members.add(child);
      visit(child);
    }
  };
  if (byPid.has(rootPid)) members.add(rootPid);
  visit(rootPid);
  for (const row of rows) {
    if (row.groupId === rootPid) members.add(row.pid);
  }
  return [...members]
    .filter((pid) => pid > 0 && !byPid.get(pid)?.zombie)
    .sort((left, right) => left - right);
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone, reparented away, or owned by another user.
  }
}

function windowsTreeKill(pid: number): void {
  spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { timeout: 5_000 });
}

export function spawnProcessTree(
  command: string,
  args: string[],
  options: ProcessTreeSpawnOptions = {},
): ProcessTreeHandle {
  const { graceMilliseconds = HARNESS_BUDGET.process.graceMilliseconds, containment: injected, ...spawnOptions } = options;
  // Containment is created before the spawn so the child can join it before it
  // is able to fork anything at all.
  const containment: TreeContainment = injected ?? createTreeContainment();
  const wrapped = containment.wrap(command, args);
  const child = spawn(wrapped.command, wrapped.args, {
    ...spawnOptions,
    detached: process.platform !== "win32",
  });
  const rootPid = child.pid ?? 0;
  /**
   * Members observed while the run was alive, each pinned to the process group
   * it belonged to. Re-signalling verifies that pairing against a fresh
   * snapshot, so a PID recycled by an unrelated process is never signalled.
   */
  const remembered = new Map<number, number>();
  let terminated = false;
  let reason: string | undefined;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let sampler: ReturnType<typeof setInterval> | undefined;
  let disposed = false;

  const rememberMembers = (rows = readProcessTable()): number[] => {
    if (!rootPid || process.platform === "win32") return [];
    const members = liveTreeMembers(rootPid, rows);
    for (const pid of members) {
      if (pid === rootPid) continue;
      const row = rows.find((entry) => entry.pid === pid);
      remembered.set(pid, row?.groupId ?? rootPid);
    }
    return members;
  };

  /**
   * Descendant identity is captured while the run is alive. Discovering it only
   * after the leader died would miss anything that reparented to init in the
   * meantime, which is precisely how a detached survivor escapes.
   */
  const startSampling = (): void => {
    if (process.platform === "win32" || !rootPid) return;
    sampler = setInterval(() => {
      if (disposed) return;
      rememberMembers();
    }, HARNESS_BUDGET.process.treeSampleMilliseconds);
    sampler.unref();
  };

  const signalTree = (signal: NodeJS.Signals): void => {
    if (signal === "SIGKILL" && containment.killAll()) {
      // One atomic kill of every member; nothing can outrun it by forking.
      return;
    }
    if (!rootPid) return;
    if (process.platform === "win32") {
      if (signal === "SIGKILL") windowsTreeKill(rootPid);
      else {
        try {
          child.kill(signal);
        } catch {
          // Already exited.
        }
      }
      return;
    }
    const rows = readProcessTable();
    const members = rememberMembers(rows);
    // The group signal reaches everything that stayed in the detached group;
    // the remembered map covers descendants that created their own group.
    try {
      process.kill(-rootPid, signal);
    } catch {
      signalPid(rootPid, signal);
    }
    const targets = new Set(members);
    for (const [pid, groupId] of remembered) {
      const row = rows.find((entry) => entry.pid === pid);
      // Only signal a remembered PID that still exists in the group we saw it
      // in. Anything else is a recycled PID belonging to someone else.
      if (rows.length && (!row || row.groupId !== groupId)) continue;
      targets.add(pid);
    }
    for (const pid of targets) {
      if (pid === rootPid) continue;
      signalPid(pid, signal);
    }
  };

  const members = (): number[] => {
    // A structural mechanism enumerates the real membership, including a
    // descendant that changed session and lost every link to the leader.
    const contained = containment.members();
    if (contained !== undefined) return [...contained].sort((left, right) => left - right);
    if (!rootPid) return [];
    if (process.platform === "win32") {
      return child.exitCode === null && child.signalCode === null ? [rootPid] : [];
    }
    const rows = readProcessTable();
    if (!rows.length) return child.exitCode === null && child.signalCode === null ? [rootPid] : [];
    const live = new Set(liveTreeMembers(rootPid, rows));
    for (const [pid, groupId] of remembered) {
      const row = rows.find((entry) => entry.pid === pid);
      if (row && !row.zombie && row.groupId === groupId) live.add(pid);
    }
    return [...live].sort((left, right) => left - right);
  };

  const alive = (): boolean => members().length > 0;

  const handle: ProcessTreeHandle = {
    pid: rootPid,
    child,
    containment: { kind: containment.kind, structural: containment.structural, reason: containment.reason },
    liveMembers: members,
    sample(): void {
      if (!disposed) rememberMembers();
    },
    async settle(settleReason: string, timeoutMilliseconds?: number): Promise<SettleOutcome> {
      const declared: ContainmentSupport = {
        kind: containment.kind,
        structural: containment.structural,
        reason: containment.reason,
      };
      if (alive()) {
        handle.terminate(settleReason);
        await handle.waitForQuiescence(timeoutMilliseconds);
      }
      if (sampler) {
        clearInterval(sampler);
        sampler = undefined;
      }
      const survivors = members();
      return {
        quiescent: survivors.length === 0,
        // Absence only proves absence when membership is enumerable
        // independently of the parent chain.
        verified: containment.structural && survivors.length === 0,
        containment: declared,
        survivors,
      };
    },
    terminating: () => terminated,
    terminationReason: () => reason,
    terminate(nextReason: string): void {
      if (terminated) return;
      terminated = true;
      reason = nextReason;
      rememberMembers();
      signalTree("SIGTERM");
      // Deliberately ref'd and never cleared on child exit: the pending
      // SIGKILL is a commitment to descendants that trapped SIGTERM.
      graceTimer = setTimeout(() => signalTree("SIGKILL"), graceMilliseconds);
    },
    async waitForQuiescence(
      timeoutMilliseconds = HARNESS_BUDGET.process.quiescenceTimeoutMilliseconds,
    ): Promise<boolean> {
      const deadline = Date.now() + Math.max(0, timeoutMilliseconds);
      let escalated = false;
      while (alive()) {
        if (Date.now() >= deadline) {
          if (escalated) return false;
          escalated = true;
          signalTree("SIGKILL");
          await sleep(HARNESS_BUDGET.process.quiescencePollMilliseconds * 4);
          continue;
        }
        await sleep(HARNESS_BUDGET.process.quiescencePollMilliseconds);
      }
      if (graceTimer) {
        clearTimeout(graceTimer);
        graceTimer = undefined;
      }
      if (sampler) {
        clearInterval(sampler);
        sampler = undefined;
      }
      return true;
    },
    terminateForHostExit(): void {
      terminated = true;
      reason ??= "host exit";
      signalTree("SIGKILL");
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (graceTimer) {
        clearTimeout(graceTimer);
        graceTimer = undefined;
      }
      if (sampler) {
        clearInterval(sampler);
        sampler = undefined;
      }
      containment.destroy();
      handles.delete(handle);
    },
  };
  handles.add(handle);
  startSampling();
  installShutdownHandlers();
  return handle;
}

/** Live provider trees still owned by this process. */
export function trackedProcessTrees(): number {
  return handles.size;
}

/** Force-kill every tracked tree; used by the host-exit fallback and tests. */
export function terminateAllProcessTrees(reason: string): void {
  for (const handle of [...handles]) handle.terminate(reason);
}

async function shutdown(signal: NodeJS.Signals, exitCode: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  if (!handles.size) {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    process.kill(process.pid, signal);
    return;
  }
  process.stderr.write(`\n[rb-harness] ${signal} recebido; encerrando a árvore do provider...\n`);
  const pending = [...handles];
  const quiet = await Promise.all(pending.map((handle) => handle.settle(`harness received ${signal}`)));
  for (const handle of pending) handle.dispose();
  if (quiet.some((outcome) => !outcome.quiescent)) {
    process.stderr.write("[rb-harness] atenção: um descendente do provider não confirmou encerramento.\n");
  } else {
    process.stderr.write("[rb-harness] árvore do provider encerrada; estado permanece retomável.\n");
  }
  process.exit(exitCode);
}

function onSigint(): void {
  void shutdown("SIGINT", 130);
}

function onSigterm(): void {
  void shutdown("SIGTERM", 143);
}

function onHostExit(): void {
  for (const handle of [...handles]) handle.terminateForHostExit();
}

function installShutdownHandlers(): void {
  if (shutdownInstalled) return;
  shutdownInstalled = true;
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  process.on("exit", onHostExit);
}
