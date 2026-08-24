/**
 * Structural ownership of a provider process tree.
 *
 * Polling a process table is not containment. A leader can `setsid()` a
 * descendant into a fresh session and exit within a few milliseconds; by the
 * time any sampler looks, the descendant has reparented to init and nothing
 * links it back to the run. Signalling a process group cannot reach it either,
 * because it left that group by design.
 *
 * The only mechanism on this platform that actually contains such a descendant
 * is a cgroup: membership is inherited across `fork` and `setsid`, cannot be
 * left without privilege, is enumerable after the leader dies, and can be
 * killed atomically. Where a writable cgroup v2 subtree exists, the Harness
 * uses it and can *prove* quiescence.
 *
 * Where it does not exist, the Harness says so. It still runs the signal
 * ladder, but it reports the containment as best-effort rather than claiming a
 * guarantee it cannot make. On Windows the mechanism is `taskkill /T`, which
 * walks a parent chain — it is explicitly **not** a Job Object, and is declared
 * as best-effort for the same reason.
 */

import { mkdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

export type ContainmentKind = "cgroup2" | "process-group" | "windows-taskkill";

export interface ContainmentSupport {
  kind: ContainmentKind;
  /**
   * Whether membership is inherited and enumerable independently of the
   * parent chain. Only a structural mechanism can prove a tree is gone.
   */
  structural: boolean;
  reason: string;
}

export interface TreeContainment extends ContainmentSupport {
  /**
   * Wrap the command so the child joins the containment before it can fork.
   * Returns the command unchanged for a non-structural mechanism.
   */
  wrap(command: string, args: string[]): { command: string; args: string[] };
  /** Members alive right now, or `undefined` when the mechanism cannot tell. */
  members(): number[] | undefined;
  /** Kill every member atomically; `false` when the mechanism cannot. */
  killAll(): boolean;
  /** Release the mechanism's resources. */
  destroy(): void;
}

const CGROUP_ROOT = "/sys/fs/cgroup";

/** The cgroup v2 path of this process, or `undefined` outside cgroup v2. */
export function currentCgroupPath(source?: string): string | undefined {
  let content = source;
  if (content === undefined) {
    try {
      content = readFileSync("/proc/self/cgroup", "utf8");
    } catch {
      return undefined;
    }
  }
  for (const line of content.split("\n")) {
    // cgroup v2 is the unified hierarchy, written as `0::<path>`.
    const match = line.match(/^0::(\/.*)$/);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function nonStructural(kind: ContainmentKind, reason: string): TreeContainment {
  return {
    kind,
    structural: false,
    reason,
    wrap: (command, args) => ({ command, args }),
    members: () => undefined,
    killAll: () => false,
    destroy: () => undefined,
  };
}

function cgroupContainment(directory: string): TreeContainment {
  let destroyed = false;
  return {
    kind: "cgroup2",
    structural: true,
    reason: `cgroup v2 subtree ${directory}`,
    wrap(command, args) {
      // The child joins the cgroup before `exec`, so it cannot fork anything
      // outside it. `exec` keeps the PID, so the caller still owns the leader.
      const quoted = [command, ...args];
      return {
        command: "/bin/sh",
        args: [
          "-c",
          `printf '%s\\n' "$$" > ${JSON.stringify(`${directory}/cgroup.procs`)} && exec "$0" "$@"`,
          ...quoted,
        ],
      };
    },
    members(): number[] | undefined {
      if (destroyed) return [];
      try {
        return readFileSync(resolve(directory, "cgroup.procs"), "utf8")
          .split("\n")
          .map((line) => Number(line.trim()))
          .filter((pid) => Number.isInteger(pid) && pid > 0);
      } catch {
        // The directory is gone, which means the cgroup is empty and removed.
        return [];
      }
    },
    killAll(): boolean {
      if (destroyed) return true;
      try {
        writeFileSync(resolve(directory, "cgroup.kill"), "1");
        return true;
      } catch {
        return false;
      }
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      try {
        rmdirSync(directory);
      } catch {
        // A cgroup with live members cannot be removed; the teardown ladder
        // already reported that, and a stale empty directory is harmless.
      }
    },
  };
}

/** What this platform can offer, without creating anything. */
export function detectContainmentSupport(): ContainmentSupport {
  if (process.platform === "win32") {
    return {
      kind: "windows-taskkill",
      structural: false,
      // Stated precisely on purpose: `taskkill /T` walks the parent chain and
      // misses a re-parented process. A Job Object would contain it, and the
      // Harness does not create one.
      reason: "taskkill /T walks the parent chain; this is not a Job Object and cannot contain a re-parented descendant",
    };
  }
  if (process.platform !== "linux") {
    return {
      kind: "process-group",
      structural: false,
      reason: `${process.platform} offers no delegated cgroup; a descendant that calls setsid() leaves the process group`,
    };
  }
  const own = currentCgroupPath();
  if (!own) {
    return {
      kind: "process-group",
      structural: false,
      reason: "no cgroup v2 unified hierarchy for this process",
    };
  }
  return {
    kind: "cgroup2",
    structural: true,
    reason: `cgroup v2 subtree under ${own}`,
  };
}

/**
 * Create the strongest containment this platform allows. Falls back to the
 * declared non-structural mechanism whenever the cgroup subtree is not
 * writable — a container, a restricted session, or a non-delegated slice.
 */
export function createTreeContainment(): TreeContainment {
  const support = detectContainmentSupport();
  if (support.kind !== "cgroup2") return nonStructural(support.kind, support.reason);
  const own = currentCgroupPath();
  if (!own) return nonStructural("process-group", "no cgroup v2 unified hierarchy for this process");
  const directory = resolve(CGROUP_ROOT, `.${own}`, `rb-harness-${process.pid}-${randomBytes(4).toString("hex")}`);
  try {
    mkdirSync(directory, { recursive: false });
    // Prove the control files are usable before promising containment.
    readFileSync(resolve(directory, "cgroup.procs"), "utf8");
  } catch (error) {
    return nonStructural(
      "process-group",
      `the cgroup v2 subtree is not writable (${error instanceof Error ? error.message : String(error)}); `
      + "a descendant that calls setsid() cannot be contained",
    );
  }
  return cgroupContainment(directory);
}

/** One honest sentence for the log, the dashboard, and the report. */
export function describeContainment(containment: ContainmentSupport): string {
  return containment.structural
    ? `contenção estrutural da árvore via ${containment.kind} (${containment.reason})`
    : `contenção da árvore é de melhor esforço via ${containment.kind}: ${containment.reason}`;
}
