/**
 * Liveness for tests, using the same definition the Harness itself applies.
 *
 * `kill(pid, 0)` is not a liveness check. It succeeds for a zombie — a process
 * that has already exited and is only waiting to be reaped by its parent. A
 * zombie holds no resources and can execute no work, which is why
 * `liveTreeMembers` filters state `Z` out of the process table.
 *
 * A test that asserted with bare `kill(pid, 0)` therefore counted a
 * not-yet-reaped process as a survivor. Reaping latency grows with machine
 * load, so the assertion passed on an idle machine and failed under a loaded
 * one — a flake produced by the check, not by the teardown.
 */

import { readFileSync } from "node:fs";

/**
 * Whether `pid` is a process that can still execute work.
 *
 * On Linux the state comes from `/proc/<pid>/stat`; the comm field is
 * parenthesized and may contain spaces, so the state is read after the last
 * `") "`. Elsewhere `kill(pid, 0)` is the best signal available.
 */
export function isExecutable(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(") ") + 2).trimStart()[0];
    // `Z` is an exited process awaiting reaping; `X` is already dead.
    return state !== "Z" && state !== "X";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}

/** The subset of `pids` that can still execute work. */
export function executablePids(pids: number[]): number[] {
  return pids.filter(isExecutable);
}
