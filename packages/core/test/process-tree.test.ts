import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { liveTreeMembers, readProcessTable, spawnProcessTree, trackedProcessTrees } from "../src/process-tree.js";
import { cgroupAbsenceProven, creatorProvenGone } from "../src/process-containment.js";
import { runProvider } from "../src/harness-provider.js";
import { acquireHarnessLock } from "../src/harness-state.js";
import { isExecutable } from "./support/process-liveness.js";

const stubbornProvider = resolve(process.cwd(), "test/fixtures/standalone/stubborn-provider.mjs");
const orphaningProvider = resolve(process.cwd(), "test/fixtures/standalone/orphaning-provider.mjs");

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

/**
 * A process that can still execute work. Deliberately not `kill(pid, 0)`,
 * which also succeeds for a zombie awaiting reaping — see
 * `test/support/process-liveness.ts`.
 */
const alive = isExecutable;

async function recordedPids(path: string, expected: number): Promise<number[]> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const source = await readFile(path, "utf8").catch(() => "");
    const pids = [...source.matchAll(/=(\d+)/g)].map((match) => Number(match[1]));
    if (pids.length >= expected) return pids;
    await sleep(50);
  }
  throw new Error(`the provider tree never reported ${expected} processes`);
}

describe.skipIf(process.platform === "win32")("provider process-tree ownership", () => {
  it("terminates a SIGTERM-trapping grandchild and confirms quiescence", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "rb-harness-tree-"));
    const pidFile = resolve(directory, "tree.pids");
    await writeFile(pidFile, "", "utf8");
    await chmod(stubbornProvider, 0o755);
    const handle = spawnProcessTree(process.execPath, [stubbornProvider], {
      cwd: directory,
      env: { ...process.env, RB_HARNESS_TEST_TREE_PID_FILE: pidFile },
      stdio: ["pipe", "pipe", "pipe"],
      graceMilliseconds: 300,
    });
    handle.child.stdin?.end("prompt", "utf8");
    const pids = await recordedPids(pidFile, 3);
    expect(pids.every(alive)).toBe(true);
    expect(liveTreeMembers(handle.pid).length).toBeGreaterThan(0);

    handle.terminate("simulated Ctrl+C");
    expect(await handle.waitForQuiescence(20_000)).toBe(true);
    expect(pids.filter(alive)).toEqual([]);
    expect(liveTreeMembers(handle.pid)).toEqual([]);
    handle.dispose();
    expect(trackedProcessTrees()).toBe(0);

    // The lock is only released after quiescence, so it can be reacquired.
    const release = await acquireHarnessLock(directory, "tree-lock-recovery-run");
    await release();
  }, 60_000);

  it("kills the whole tree on a provider timeout before reporting failure", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "rb-harness-tree-timeout-"));
    const pidFile = resolve(directory, "tree.pids");
    await writeFile(pidFile, "", "utf8");
    await chmod(stubbornProvider, 0o755);
    process.env.RB_HARNESS_TEST_TREE_PID_FILE = pidFile;
    try {
      await expect(runProvider({
        configuration: { provider: "custom", model: "fixture", effort: "high", command: stubbornProvider },
        mode: "generation",
        stage: "generation",
        projectRoot: directory,
        prompt: "fixture prompt",
        logPath: resolve(directory, "provider.log"),
        timeoutSeconds: 2,
        firstOutputTimeoutSeconds: 0,
      })).rejects.toThrow("wall timeout");
      const pids = [...(await readFile(pidFile, "utf8")).matchAll(/=(\d+)/g)].map((match) => Number(match[1]));
      expect(pids.length).toBeGreaterThanOrEqual(3);
      expect(pids.filter(alive)).toEqual([]);
    } finally {
      delete process.env.RB_HARNESS_TEST_TREE_PID_FILE;
    }
  }, 60_000);

  it("never reports quiescence from a process table it could not read", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "rb-harness-unreadable-table-"));
    const pidFile = resolve(directory, "tree.pids");
    await writeFile(pidFile, "", "utf8");
    await chmod(orphaningProvider, 0o755);
    // A `ps` that fails, standing in for the process table becoming unreadable
    // — a timeout or a buffer overflow under a loaded machine. Absence of data
    // is not absence of processes, and must never be reported as quiescence.
    const fakeBin = await mkdtemp(resolve(tmpdir(), "rb-harness-fake-ps-"));
    await writeFile(resolve(fakeBin, "ps"), "#!/bin/sh\nexit 1\n", "utf8");
    await chmod(resolve(fakeBin, "ps"), 0o755);

    const handle = spawnProcessTree(process.execPath, [orphaningProvider], {
      cwd: directory,
      env: { ...process.env, RB_HARNESS_TEST_TREE_PID_FILE: pidFile },
      stdio: ["pipe", "pipe", "pipe"],
      graceMilliseconds: 200,
      // Force the non-structural path, as on a host with no writable cgroup.
      containment: {
        kind: "process-group",
        structural: false,
        reason: "fixture fallback",
        wrap: (command, args) => ({ command, args }),
        members: () => undefined,
        killAll: () => false,
        destroy: () => undefined,
      },
    });
    handle.child.stdin?.end("prompt", "utf8");
    handle.child.stdout?.on("data", () => handle.sample());
    const pids = await recordedPids(pidFile, 2);
    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${originalPath}`;
    try {
      const outcome = await handle.settle("unreadable table", 800);
      // The table is deliberately unreadable, so the teardown proved nothing —
      // regardless of what survived. Absence of data is never quiescence.
      expect(outcome.observed).toBe(false);
      expect(outcome.quiescent).toBe(false);
      expect(outcome.verified).toBe(false);
      expect(outcome.containment.reason).toContain("process table could not be read");
    } finally {
      process.env.PATH = originalPath;
      for (const pid of pids) {
        try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
      }
      handle.dispose();
    }
  }, 60_000);

  it("separates a readable, an empty, and an unreadable process table", async () => {
    const bin = await mkdtemp(resolve(tmpdir(), "rb-harness-ps-shim-"));
    const shim = async (name: string, body: string): Promise<string> => {
      const directory = resolve(bin, name);
      await mkdir(directory, { recursive: true });
      await writeFile(resolve(directory, "ps"), body, "utf8");
      await chmod(resolve(directory, "ps"), 0o755);
      return directory;
    };
    // Two real rows, a header-only listing with nothing parseable, a non-zero
    // exit, and a zero exit with no output at all.
    const readable = await shim(
      "readable",
      ['#!/bin/sh', 'echo "  10     1    10 Ss"', 'echo "  11    10    10 S"', ''].join("\n"),
    );
    const empty = await shim(
      "empty",
      ['#!/bin/sh', 'echo "  PID  PPID  PGID STAT"', ''].join("\n"),
    );
    const failing = await shim("failing", ["#!/bin/sh", "exit 1", ""].join("\n"));
    const silent = await shim("silent", ["#!/bin/sh", "exit 0", ""].join("\n"));
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = `${readable}:${originalPath}`;
      expect(readProcessTable()).toEqual([
        { pid: 10, parentPid: 1, groupId: 10, zombie: false },
        { pid: 11, parentPid: 10, groupId: 10, zombie: false },
      ]);

      // Readable but carrying no process rows is a fact: an empty list.
      process.env.PATH = `${empty}:${originalPath}`;
      expect(readProcessTable()).toEqual([]);

      // Both failure shapes are unknown, never an empty table.
      process.env.PATH = `${failing}:${originalPath}`;
      expect(readProcessTable()).toBeUndefined();
      process.env.PATH = `${silent}:${originalPath}`;
      expect(readProcessTable()).toBeUndefined();
    } finally {
      process.env.PATH = originalPath;
    }
    // An empty list stays a fact for the membership walk.
    expect(liveTreeMembers(100, [])).toEqual([]);
  });

  it("never falls back to the process table when structural containment cannot be read", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "rb-harness-blind-cgroup-"));
    // A structural mechanism that cannot answer right now: EACCES on
    // cgroup.procs, an I/O error, a remount. `ps` cannot stand in for it —
    // it cannot see a descendant that left the parental relationship.
    const handle = spawnProcessTree(process.execPath, ["-e", "setTimeout(() => {}, 3000)"], {
      cwd: directory,
      stdio: ["ignore", "ignore", "ignore"],
      graceMilliseconds: 200,
      containment: {
        kind: "cgroup2",
        structural: true,
        reason: "fixture cgroup that cannot be observed",
        wrap: (command, args) => ({ command, args }),
        members: () => undefined,
        killAll: () => false,
        destroy: () => undefined,
      },
    });
    try {
      const outcome = await handle.settle("blind structural containment", 600);
      expect(outcome.observed).toBe(false);
      expect(outcome.quiescent).toBe(false);
      expect(outcome.verified).toBe(false);
      expect(outcome.containment.reason).toContain("could not be observed");
      expect(outcome.survivors).toEqual([]);
    } finally {
      try { process.kill(handle.pid, "SIGKILL"); } catch { /* already gone */ }
      handle.dispose();
    }
  }, 30_000);

  it("does not sample the process table when containment is structural", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "rb-harness-no-sampler-"));
    const handle = spawnProcessTree(process.execPath, ["-e", "setTimeout(() => {}, 400)"], {
      cwd: directory,
      stdio: ["ignore", "ignore", "ignore"],
      graceMilliseconds: 200,
    });
    // Compared against the containment this handle actually got: detection can
    // announce cgroup2 while creation falls back for lack of permission.
    expect(handle.samplesProcessTable()).toBe(!handle.containment.structural);
    await handle.settle("fixture teardown");
    handle.dispose();
  }, 30_000);

  it("treats only a missing cgroup as proof that it holds no process", () => {
    // The kernel refuses to remove a populated cgroup, so a missing directory
    // is evidence of emptiness.
    expect(cgroupAbsenceProven("ENOENT")).toBe(true);
    expect(cgroupAbsenceProven("ENODEV")).toBe(true);
    // These prove nothing about membership and must stay unknown.
    for (const code of ["EACCES", "EPERM", "EIO", "EBUSY", "ENOMEM", undefined]) {
      expect(cgroupAbsenceProven(code)).toBe(false);
    }
  });

  it("reaps an abandoned cgroup only when its creator is proven gone", () => {
    expect(creatorProvenGone("ESRCH")).toBe(true);
    // EPERM means the creator is alive and owned by another user; anything
    // else means the probe failed. Removing on either would strip the
    // containment from a run that is still starting.
    for (const code of ["EPERM", "EACCES", "EINVAL", undefined]) {
      expect(creatorProvenGone(code)).toBe(false);
    }
  });

  it("excludes the caller and unknown roots from tree membership", () => {
    const rows = [
      { pid: 100, parentPid: 1, groupId: 100, zombie: false },
      { pid: 101, parentPid: 100, groupId: 100, zombie: false },
      { pid: 102, parentPid: 101, groupId: 102, zombie: false },
      { pid: 103, parentPid: 101, groupId: 100, zombie: true },
      { pid: 200, parentPid: 1, groupId: 200, zombie: false },
    ];
    expect(liveTreeMembers(100, rows)).toEqual([100, 101, 102]);
    expect(liveTreeMembers(999, rows)).toEqual([]);
  });
});
