import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { liveTreeMembers, spawnProcessTree, trackedProcessTrees } from "../src/process-tree.js";
import { runProvider } from "../src/harness-provider.js";
import { acquireHarnessLock } from "../src/harness-state.js";

const stubbornProvider = resolve(process.cwd(), "test/fixtures/standalone/stubborn-provider.mjs");

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

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
