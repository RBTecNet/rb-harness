import { spawn, type ChildProcess } from "node:child_process";

export const RALPH_PROGRESS_SCHEMA_V1 = "rb-ralph-progress/v1" as const;
export const RALPH_PROGRESS_BUFFER_CAPACITY_V1 = 512 as const;

export type RalphProgressOperationV1 = "EXECUTOR" | "DEPENDENCY_PROVISIONING" | "VALIDATION" | "AUDITOR" | "PUBLICATION";

interface RalphProgressBaseV1 {
  readonly schema: typeof RALPH_PROGRESS_SCHEMA_V1;
  readonly runId: string;
  readonly occurredAt: string;
}

interface RalphAttemptProgressBaseV1 extends RalphProgressBaseV1 {
  readonly phaseId: string;
  readonly taskId: string;
  readonly attemptId: string;
}

export type RalphProgressEventV1 =
  | (RalphProgressBaseV1 & { readonly kind: "run.started"; readonly planId: string; readonly taskCount: number })
  | (RalphProgressBaseV1 & { readonly kind: "task.started"; readonly phaseId: string; readonly taskId: string; readonly ordinal: number; readonly taskCount: number })
  | (RalphAttemptProgressBaseV1 & { readonly kind: "attempt.started"; readonly ordinal: number; readonly maxAttempts: number })
  | (RalphAttemptProgressBaseV1 & { readonly kind: "executor.started"; readonly runtimeIdentity: string; readonly provider?: string; readonly transport?: string; readonly model?: string; readonly effort?: string })
  | (RalphAttemptProgressBaseV1 & { readonly kind: "executor.finished"; readonly elapsedMs: number; readonly outcome: string })
  | (RalphAttemptProgressBaseV1 & { readonly kind: "dependency.started"; readonly manager: "npm" })
  | (RalphAttemptProgressBaseV1 & { readonly kind: "dependency.passed"; readonly manager: "npm"; readonly elapsedMs: number; readonly disposition: "PROVISIONED" | "NOT_REQUIRED" })
  | (RalphAttemptProgressBaseV1 & { readonly kind: "dependency.failed"; readonly manager: "npm"; readonly elapsedMs: number; readonly code: string })
  | (RalphAttemptProgressBaseV1 & { readonly kind: "validation.started"; readonly validationSpecId: string; readonly validationKind: "COMMAND" | "MANUAL" | "HUMAN"; readonly ordinal: number })
  | (RalphAttemptProgressBaseV1 & { readonly kind: "validation.finished"; readonly validationSpecId: string; readonly outcome: "PASS" | "FAIL" | "NOT_APPLICABLE" | "INFRASTRUCTURE_FAILURE" | "HUMAN_REQUIRED"; readonly elapsedMs: number; readonly exitCode?: number | null })
  | (RalphAttemptProgressBaseV1 & { readonly kind: "auditor.started"; readonly runtimeIdentity: string; readonly profileId: string; readonly provider?: string; readonly transport?: string; readonly model?: string; readonly effort?: string })
  | (RalphAttemptProgressBaseV1 & { readonly kind: "auditor.finished"; readonly verdict: "ACCEPT" | "REJECT" | "NOT_AUDITABLE" | "RECONCILIATION_REQUIRED"; readonly findingCount: number; readonly elapsedMs: number })
  | (RalphAttemptProgressBaseV1 & { readonly kind: "correction.retry"; readonly nextAttempt: number; readonly maxAttempts: number })
  | (RalphAttemptProgressBaseV1 & { readonly kind: "publication.started" })
  | (RalphAttemptProgressBaseV1 & { readonly kind: "publication.finished"; readonly outcome: "PASS" | "FAIL"; readonly elapsedMs: number; readonly code?: string })
  | (RalphAttemptProgressBaseV1 & { readonly kind: "human.required"; readonly validationSpecId?: string })
  | (RalphProgressBaseV1 & { readonly kind: "heartbeat"; readonly operation: RalphProgressOperationV1; readonly elapsedMs: number; readonly phaseId?: string; readonly taskId?: string; readonly attemptId?: string; readonly validationSpecId?: string })
  | (RalphProgressBaseV1 & { readonly kind: "run.terminal"; readonly status: "COMPLETE" | "FAILED" | "BLOCKED" | "BUDGET_EXHAUSTED" | "HUMAN_REQUIRED" | "INCOMPLETE_RESUMABLE"; readonly code?: string });

/** Opaque, Core-created bounded publisher. It contains no renderer callback. */
export interface RalphProgressObserverV1 {
  readonly publish: (event: RalphProgressEventV1) => void;
}

export interface RalphProgressBufferV1 extends RalphProgressObserverV1 {
  readonly drain: () => readonly RalphProgressEventV1[];
  readonly droppedCount: () => number;
}

export interface RalphProgressStderrChannelV1 extends RalphProgressObserverV1 {
  readonly close: () => Promise<void>;
}

export interface RalphRuntimePresentationFactsV1 {
  readonly provider: string;
  readonly transport: string;
  readonly model: string;
  readonly effort: string;
}

const trustedPublishers = new WeakSet<object>();

export function createRalphProgressBufferV1(capacity: number = RALPH_PROGRESS_BUFFER_CAPACITY_V1): RalphProgressBufferV1 {
  assertCapacity(capacity);
  const queue: RalphProgressEventV1[] = [];
  let dropped = 0;
  const channel: RalphProgressBufferV1 = Object.freeze({
    publish(event: RalphProgressEventV1) {
      if (queue.length === capacity) { queue.shift(); dropped += 1; }
      queue.push(Object.freeze({ ...event }) as RalphProgressEventV1);
    },
    drain() { return Object.freeze(queue.splice(0)); },
    droppedCount() { return dropped; },
  });
  trustedPublishers.add(channel);
  return channel;
}

/**
 * CLI rendering is isolated in a child process. The Core-side publish path
 * performs one bounded format/write and drops on backpressure; it never waits
 * for terminal IO or invokes user code.
 */
export function createRalphProgressStderrChannelV1(input: { readonly closeTimeoutMs?: number } = {}): RalphProgressStderrChannelV1 {
  const closeTimeoutMs = input.closeTimeoutMs ?? 500;
  if (!Number.isSafeInteger(closeTimeoutMs) || closeTimeoutMs < 1 || closeTimeoutMs > 5_000) throw new Error("RALPH_PROGRESS_POLICY_INVALID");
  const child = spawn(process.execPath, ["-e", "process.stdin.pipe(process.stderr)"], {
    env: {},
    stdio: ["pipe", "ignore", "inherit"],
    windowsHide: true,
  });
  child.unref();
  (child.stdin as (typeof child.stdin & { unref?: () => void }) | null)?.unref?.();
  child.on("error", () => undefined);
  child.stdin?.on("error", () => undefined);
  let saturated = false;
  let closed = false;
  let pendingTerminal: string | undefined;
  const channel: RalphProgressStderrChannelV1 = Object.freeze({
    publish(event: RalphProgressEventV1) {
      if (closed || !child.stdin || child.stdin.destroyed) return;
      let line: string;
      try { line = `${formatRalphProgressEventV1(event)}\n`; }
      catch { return; }
      if (Buffer.byteLength(line) > 2_048) return;
      if (saturated) {
        if (event.kind === "run.terminal") pendingTerminal = line;
        return;
      }
      try {
        if (!child.stdin.write(line)) {
          saturated = true;
          child.stdin.once("drain", () => {
            saturated = false;
            if (!pendingTerminal || closed || !child.stdin || child.stdin.destroyed) return;
            const terminal = pendingTerminal;
            pendingTerminal = undefined;
            try { child.stdin.write(terminal); } catch { /* presentation only */ }
          });
        }
      } catch { /* presentation only */ }
    },
    async close() {
      if (closed) return;
      closed = true;
      try { child.stdin?.end(pendingTerminal); } catch { /* presentation only */ }
      await waitForChildClose(child, closeTimeoutMs);
    },
  });
  trustedPublishers.add(channel);
  return channel;
}

/** Presentation is best-effort by contract and can never affect Core flow. */
export function emitRalphProgressV1(observer: RalphProgressObserverV1 | undefined, event: RalphProgressEventV1): void {
  if (!observer || !trustedPublishers.has(observer)) return;
  try { observer.publish(Object.freeze(event)); }
  catch { /* A presentation channel has zero Core authority. */ }
}

export async function withRalphHeartbeatV1<T>(input: {
  readonly observer?: RalphProgressObserverV1;
  readonly event: Omit<Extract<RalphProgressEventV1, { readonly kind: "heartbeat" }>, "schema" | "occurredAt" | "elapsedMs">;
  readonly operation: () => Promise<T>;
  readonly intervalMs?: number;
  readonly now?: () => number;
  readonly wallClock?: () => string;
}): Promise<{ readonly value: T; readonly elapsedMs: number }> {
  const intervalMs = input.intervalMs ?? 30_000;
  const now = input.now ?? Date.now;
  const wallClock = input.wallClock ?? (() => new Date().toISOString());
  const started = now();
  let timer: ReturnType<typeof setInterval> | undefined;
  if (input.observer && trustedPublishers.has(input.observer) && Number.isSafeInteger(intervalMs) && intervalMs > 0) {
    timer = setInterval(() => emitRalphProgressV1(input.observer, {
      schema: RALPH_PROGRESS_SCHEMA_V1,
      occurredAt: wallClock(),
      elapsedMs: Math.max(0, now() - started),
      ...input.event,
    }), intervalMs);
    timer.unref?.();
  }
  try { return { value: await input.operation(), elapsedMs: Math.max(0, now() - started) }; }
  finally { if (timer) clearInterval(timer); }
}

/**
 * Only Core-selected identifiers and finite numeric facts are rendered.
 * Task titles/instructions, prompts, provider output, diffs, and diagnostics
 * are deliberately absent from the event schema.
 */
export function formatRalphProgressEventV1(event: RalphProgressEventV1): string {
  const elapsed = "elapsedMs" in event ? ` elapsed=${formatElapsed(event.elapsedMs)}` : "";
  const task = "taskId" in event && event.taskId ? ` ${presentationAtom(event.taskId)}` : "";
  switch (event.kind) {
    case "run.started": return `[ralph] START run=${presentationAtom(event.runId)} plan=${presentationAtom(event.planId)} tasks=${boundedNumber(event.taskCount)}`;
    case "task.started": return `[ralph] TASK ${boundedNumber(event.ordinal)}/${boundedNumber(event.taskCount)}${task}`;
    case "attempt.started": return `[ralph] ATTEMPT ${boundedNumber(event.ordinal)}/${boundedNumber(event.maxAttempts)}${task}`;
    case "executor.started": return `[ralph] EXECUTOR START${task}${providerFacts(event)} runtime=${presentationAtom(event.runtimeIdentity)}`;
    case "executor.finished": return `[ralph] EXECUTOR FINISHED${task} outcome=${presentationAtom(event.outcome)}${elapsed}`;
    case "dependency.started": return `[ralph] DEPENDENCIES START${task} manager=${event.manager}`;
    case "dependency.passed": return `[ralph] DEPENDENCIES PASS${task} manager=${event.manager} disposition=${event.disposition}${elapsed}`;
    case "dependency.failed": return `[ralph] DEPENDENCIES FAIL${task} manager=${event.manager} code=${presentationAtom(event.code)}${elapsed}`;
    case "validation.started": return `[ralph] VALIDATION START${task} spec=${presentationAtom(event.validationSpecId)} kind=${event.validationKind}`;
    case "validation.finished": return `[ralph] VALIDATION ${event.outcome === "PASS" ? "PASS" : "FAIL"}${task} spec=${presentationAtom(event.validationSpecId)}${event.exitCode === undefined ? "" : ` exit=${event.exitCode === null ? "null" : boundedNumber(event.exitCode)}`}${elapsed}`;
    case "auditor.started": return `[ralph] AUDITOR START${task}${providerFacts(event)} profile=${presentationAtom(event.profileId)}`;
    case "auditor.finished": return `[ralph] AUDITOR ${event.verdict}${task} findings=${boundedNumber(event.findingCount)}${elapsed}`;
    case "correction.retry": return `[ralph] CORRECTION RETRY${task} next-attempt=${boundedNumber(event.nextAttempt)}/${boundedNumber(event.maxAttempts)}`;
    case "publication.started": return `[ralph] PUBLICATION START${task}`;
    case "publication.finished": return `[ralph] PUBLICATION ${event.outcome}${task}${event.code ? ` code=${presentationAtom(event.code)}` : ""}${elapsed}`;
    case "human.required": return `[ralph] HUMAN_REQUIRED${task}${event.validationSpecId ? ` spec=${presentationAtom(event.validationSpecId)}` : ""}`;
    case "heartbeat": return `[ralph] HEARTBEAT operation=${event.operation}${task}${event.validationSpecId ? ` spec=${presentationAtom(event.validationSpecId)}` : ""}${elapsed}`;
    case "run.terminal": return `[ralph] ${event.status} run=${presentationAtom(event.runId)}${event.code ? ` code=${presentationAtom(event.code)}` : ""}`;
  }
}

function providerFacts(event: { readonly provider?: string; readonly transport?: string; readonly model?: string; readonly effort?: string }): string {
  return [
    event.provider ? `provider=${presentationEnum(event.provider, ["openai"])}` : undefined,
    event.transport ? `transport=${presentationEnum(event.transport, ["codex-cli-exec"])}` : undefined,
    event.model ? `model=${/^gpt-[A-Za-z0-9.-]{1,80}$/.test(event.model) ? event.model : "[invalid]"}` : undefined,
    event.effort ? `effort=${presentationEnum(event.effort, ["low", "medium", "high", "xhigh", "max", "ultra"])}` : undefined,
  ].filter(Boolean).map((value) => ` ${value}`).join("");
}

function presentationEnum(value: string, allowed: readonly string[]): string {
  return allowed.includes(value) ? value : "[invalid]";
}

function presentationAtom(value: string): string {
  return typeof value === "string" && value.length > 0 && value.length <= 160 && /^[A-Za-z0-9@._:+/-]+$/.test(value) ? value : "[invalid]";
}

function boundedNumber(value: number): string {
  return Number.isSafeInteger(value) && Math.abs(value) <= 1_000_000 ? String(value) : "unknown";
}

function formatElapsed(elapsedMs: number): string {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return "unknown";
  return elapsedMs < 1_000 ? `${Math.floor(elapsedMs)}ms` : `${(elapsedMs / 1_000).toFixed(1)}s`;
}

function assertCapacity(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 4_096) throw new Error("RALPH_PROGRESS_POLICY_INVALID");
}

async function waitForChildClose(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveWait) => {
    let settled = false;
    const finish = () => { if (settled) return; settled = true; clearTimeout(timer); resolveWait(); };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* presentation only */ }
      finish();
    }, timeoutMs);
    timer.unref?.();
    child.once("close", finish);
  });
}
