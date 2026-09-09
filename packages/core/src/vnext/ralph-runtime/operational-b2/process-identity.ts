import { readFile as nodeReadFile } from "node:fs/promises";
import { hostname } from "node:os";
import { sha256 } from "../hashing.js";

/**
 * The identity carried by a run lease.  PID is only an index; ownership is
 * established by the complete identity.
 */
export interface ProcessIdentity {
  readonly pid: number;
  readonly processStartIdentity: string;
  readonly hostIdentity: string;
  readonly bootSessionIdentity: string;
}

export const PROCESS_IDENTITY_INSPECTIONS = ["MATCH", "ABSENT", "START_MISMATCH", "UNKNOWN"] as const;
export type ProcessIdentityInspection = typeof PROCESS_IDENTITY_INSPECTIONS[number];

export type MaybePromise<T> = T | PromiseLike<T>;

/**
 * Narrow injectable boundary used by lease acquisition and recovery.  The
 * implementation must never reduce an answer to PID liveness alone.
 */
export interface ProcessIdentityProvider {
  readonly current: () => MaybePromise<ProcessIdentity>;
  readonly inspect: (identity: ProcessIdentity) => MaybePromise<ProcessIdentityInspection>;
}

export class ProcessIdentityError extends Error {
  constructor(readonly code: string, message = code, readonly cause?: unknown) {
    super(message);
    this.name = "ProcessIdentityError";
  }
}

interface ProcessIdentityFileSystem {
  readonly readFile: (path: string) => Promise<Buffer>;
}

const nodeProcessIdentityFileSystem: ProcessIdentityFileSystem = { readFile: nodeReadFile };

/**
 * Linux identity provider.  All procfs parsing is deliberately isolated in
 * this module; lease code consumes only the typed inspection result.
 */
export class LinuxProcessIdentityProvider implements ProcessIdentityProvider {
  constructor(private readonly fileSystem: ProcessIdentityFileSystem = nodeProcessIdentityFileSystem) {}

  async current(): Promise<ProcessIdentity> {
    if (process.platform !== "linux") throw new ProcessIdentityError("PROCESS_IDENTITY_UNSUPPORTED_PLATFORM");
    try {
      return await readLinuxProcessIdentity(process.pid, this.fileSystem);
    } catch (error) {
      if (error instanceof ProcessIdentityError) throw error;
      throw new ProcessIdentityError("PROCESS_IDENTITY_UNAVAILABLE", "PROCESS_IDENTITY_UNAVAILABLE", error);
    }
  }

  /**
   * Identity of a process this host owns right now, by PID.  A child spawned
   * without an IPC channel cannot report its own identity, so the parent
   * reads it from procfs.  An unreadable process is an error, never a guess.
   */
  async identify(pid: number): Promise<ProcessIdentity> {
    if (process.platform !== "linux") throw new ProcessIdentityError("PROCESS_IDENTITY_UNSUPPORTED_PLATFORM");
    try {
      return await readLinuxProcessIdentity(pid, this.fileSystem);
    } catch (error) {
      if (error instanceof ProcessIdentityError) throw error;
      throw new ProcessIdentityError("PROCESS_IDENTITY_UNAVAILABLE", "PROCESS_IDENTITY_UNAVAILABLE", error);
    }
  }

  async inspect(identity: ProcessIdentity): Promise<ProcessIdentityInspection> {
    if (process.platform !== "linux") return "UNKNOWN";
    if (!isProcessIdentity(identity)) return "UNKNOWN";

    let localHostIdentity: string;
    try {
      localHostIdentity = await readLinuxHostIdentity(this.fileSystem);
    } catch {
      return "UNKNOWN";
    }
    if (identity.hostIdentity !== localHostIdentity) return "UNKNOWN";

    let observed: ProcessIdentity;
    try {
      observed = await readLinuxProcessIdentity(identity.pid, this.fileSystem);
    } catch (error) {
      if (isMissing(error)) return "ABSENT";
      return "UNKNOWN";
    }

    if (observed.hostIdentity !== identity.hostIdentity || observed.bootSessionIdentity !== identity.bootSessionIdentity) {
      return "UNKNOWN";
    }
    if (observed.processStartIdentity !== identity.processStartIdentity) return "START_MISMATCH";
    return "MATCH";
  }
}

export const nodeProcessIdentityProvider: ProcessIdentityProvider = new LinuxProcessIdentityProvider();
export const defaultProcessIdentityProvider = nodeProcessIdentityProvider;

async function readLinuxProcessIdentity(pid: number, fileSystem: ProcessIdentityFileSystem): Promise<ProcessIdentity> {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new ProcessIdentityError("PROCESS_IDENTITY_PID_INVALID");
  const stat = await readProcStat(pid, fileSystem);
  const bootId = await readFirstNonEmpty(["/proc/sys/kernel/random/boot_id"], fileSystem);
  const hostIdentity = await readLinuxHostIdentity(fileSystem);
  return {
    pid,
    processStartIdentity: sha256(`rb-linux-process-start:${pid}:${stat.startTime}`),
    hostIdentity,
    bootSessionIdentity: sha256(`rb-linux-boot-session:${bootId}:${stat.sessionId}`),
  };
}

async function readLinuxHostIdentity(fileSystem: ProcessIdentityFileSystem): Promise<string> {
  const machineId = await readFirstNonEmpty(["/etc/machine-id", "/var/lib/dbus/machine-id"], fileSystem);
  const hostName = hostname().trim();
  if (!hostName) throw new ProcessIdentityError("PROCESS_IDENTITY_HOST_UNAVAILABLE");
  return sha256(`rb-linux-host:${machineId}:${hostName}`);
}

async function readProcStat(pid: number, fileSystem: ProcessIdentityFileSystem): Promise<{ readonly startTime: string; readonly sessionId: string }> {
  const path = `/proc/${pid}/stat`;
  const bytes = await fileSystem.readFile(path);
  const value = bytes.toString("utf8");
  const closingCommand = value.lastIndexOf(")");
  if (closingCommand < 0) throw new ProcessIdentityError("PROCESS_IDENTITY_PROC_STAT_INVALID");
  const fields = value.slice(closingCommand + 1).trim().split(/\s+/);
  // The suffix begins at procfs field 3 (state). Session is field 6 and
  // process start time is field 22, hence offsets 3 and 19.
  const sessionId = fields[3];
  const startTime = fields[19];
  if (!sessionId || !startTime) throw new ProcessIdentityError("PROCESS_IDENTITY_PROC_STAT_INVALID");
  return { sessionId, startTime };
}

async function readFirstNonEmpty(paths: readonly string[], fileSystem: ProcessIdentityFileSystem): Promise<string> {
  let lastError: unknown;
  for (const path of paths) {
    try {
      const value = (await fileSystem.readFile(path)).toString("utf8").trim();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
  }
  throw new ProcessIdentityError("PROCESS_IDENTITY_SYSTEM_FACT_UNAVAILABLE", "PROCESS_IDENTITY_SYSTEM_FACT_UNAVAILABLE", lastError);
}

function isProcessIdentity(value: unknown): value is ProcessIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return Number.isSafeInteger(candidate.pid)
    && typeof candidate.processStartIdentity === "string" && candidate.processStartIdentity.length > 0
    && typeof candidate.hostIdentity === "string" && candidate.hostIdentity.length > 0
    && typeof candidate.bootSessionIdentity === "string" && candidate.bootSessionIdentity.length > 0;
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { readonly code?: unknown }).code === "ENOENT");
}
