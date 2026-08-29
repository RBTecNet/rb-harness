import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { sha256Text } from "../hash.js";
import type { InterviewQuestionEvidence } from "./interview.js";
import type { Measured, ProviderTransportId, RequestAccounting } from "./providers/contract.js";
import type { WireFinding } from "./wire.js";

export type InitRunStage =
  | "request-received"
  | "intent-requested"
  | "intent-decoded"
  | "interview-pending"
  | "intent-resolved"
  | "work-requested"
  | "work-resolved"
  | "deterministic-closure"
  | "published"
  | "failed";

export interface SemanticAttemptEvidence {
  readonly slice: "intent" | "work";
  readonly ordinal: number;
  readonly corrective: boolean;
  readonly status: "requested" | "provider-failed" | "semantic-invalid" | "accepted";
  readonly findings: readonly WireFinding[];
}

export interface InitRunCounters {
  readonly semanticOperations: number;
  readonly transportInvocations: number;
  readonly transportRetries: number;
  readonly correctiveRegenerations: number;
  readonly correctiveBySlice: Readonly<Record<"intent" | "work", number>>;
  readonly providerRequests: Measured<number>;
}

/** Persisted orchestration/evidence only. It never contains requirements, phases or tasks. */
export interface VnextInitRunState {
  readonly format: "rb-vnext-init-run/v1";
  readonly runId: string;
  readonly workflow: "init";
  readonly originalRequest: string;
  readonly requestSha256: string;
  readonly selectedProfileId: string;
  readonly transport: ProviderTransportId;
  readonly requestAccounting: RequestAccounting;
  readonly stage: InitRunStage;
  readonly questions: readonly InterviewQuestionEvidence[];
  readonly resolvedAuthority: readonly {
    readonly questionKey: string;
    readonly source: "user-answer" | "accepted-recommendation";
    readonly acceptanceMode: "explicit" | "blank-interactive" | "non-interactive-policy";
  }[];
  readonly attempts: readonly SemanticAttemptEvidence[];
  readonly counters: InitRunCounters;
  readonly terminalStatus?: "published" | "failed";
  readonly failureKind?: string;
  readonly publicationOccurred: boolean;
  readonly updatedAt: string;
}

const ALLOWED_TRANSITIONS: Readonly<Record<InitRunStage, readonly InitRunStage[]>> = {
  "request-received": ["intent-requested", "failed"],
  "intent-requested": ["intent-decoded", "failed"],
  "intent-decoded": ["interview-pending", "intent-resolved", "failed"],
  "interview-pending": ["interview-pending", "intent-resolved", "failed"],
  "intent-resolved": ["work-requested", "failed"],
  "work-requested": ["work-resolved", "failed"],
  "work-resolved": ["deterministic-closure", "failed"],
  "deterministic-closure": ["published", "failed"],
  published: [],
  failed: [],
};

export function createInitRunState(input: {
  readonly runId: string;
  readonly originalRequest: string;
  readonly profileId: string;
  readonly transport: ProviderTransportId;
  readonly requestAccounting: RequestAccounting;
  readonly now: string;
}): VnextInitRunState {
  return {
    format: "rb-vnext-init-run/v1",
    runId: input.runId,
    workflow: "init",
    originalRequest: input.originalRequest,
    requestSha256: sha256Text(input.originalRequest),
    selectedProfileId: input.profileId,
    transport: input.transport,
    requestAccounting: input.requestAccounting,
    stage: "request-received",
    questions: [],
    resolvedAuthority: [],
    attempts: [],
    counters: {
      semanticOperations: 0,
      transportInvocations: 0,
      transportRetries: 0,
      correctiveRegenerations: 0,
      correctiveBySlice: { intent: 0, work: 0 },
      providerRequests: { measured: input.requestAccounting === "exact", ...(input.requestAccounting === "exact" ? { value: 0 } : { reason: "unsupported-by-provider" }) } as Measured<number>,
    },
    publicationOccurred: false,
    updatedAt: input.now,
  };
}

export function transitionInitRunState(
  state: VnextInitRunState,
  stage: InitRunStage,
  now: string,
  patch: Partial<Omit<VnextInitRunState, "format" | "runId" | "workflow" | "stage" | "updatedAt">> = {},
): VnextInitRunState {
  if (!ALLOWED_TRANSITIONS[state.stage].includes(stage)) {
    throw new Error(`INVALID_INIT_STATE_TRANSITION: ${state.stage} -> ${stage}`);
  }
  if (state.stage === "published" || state.stage === "failed") throw new Error(`INIT_RUN_TERMINAL: ${state.stage}`);
  return { ...state, ...patch, stage, updatedAt: now };
}

export function initRunStatePath(projectRoot: string, runId: string): string {
  return resolve(projectRoot, ".rb-harness", "runs", runId, "vnext-init-state.json");
}

export async function persistInitRunState(projectRoot: string, state: VnextInitRunState): Promise<string> {
  const path = initRunStatePath(projectRoot, state.runId);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  return path;
}
