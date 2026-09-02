import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExternalCliInvocationPolicyEvidence, Measured, ModelInvocationConfigurationEvidence, ProviderErrorKind } from "../contract.js";
import {
  isProviderTransportId,
  isRequestAccounting,
  type ProviderTransportId,
  type RequestAccounting,
} from "../contract.js";
import type { ConformanceResult } from "./suite.js";

export type RecordingOrigin = "live-recorded" | "derived-from-recording" | "local-transport-fixture";

export interface RecordedRawResponse {
  readonly origin: RecordingOrigin;
  /** Provider-neutral value produced by replaying the raw envelope. */
  readonly canonicalPayload?: unknown;
  readonly response: unknown;
  readonly sanitizedRequestBody?: unknown;
  readonly derivedFrom?: string;
  readonly derivation?: string;
  /** A true value makes the profile unsupported; adapters may not hide this. */
  readonly semanticNormalizationRequired?: boolean;
}

export interface LiveSmokeRecord {
  /** Legacy conclusion retained for direct-API records; v2 replay derives from observations below. */
  readonly passed: boolean;
  readonly errorKind: Extract<ProviderErrorKind, "cancelled" | "timeout">;
  readonly durationMs: number;
  /** Legacy direct-API count retained for existing records. */
  readonly providerRequests?: number;
  readonly providerRequestMeasurement?: Measured<number>;
  readonly transportInvocations?: number;
  readonly promptAbort: boolean;
  readonly treeQuiescent?: boolean;
  readonly treeVerified?: boolean;
  readonly skipReason?: string;
}

export type LiveRuntimeAttestation =
  | {
      readonly check: "subscription-auth";
      readonly checkedAt: string;
      readonly transport: ProviderTransportId;
      readonly transportVersion: string;
      readonly authMode: "subscription";
    }
  | {
      readonly check: "environment-api-key-isolation";
      readonly checkedAt: string;
      readonly transport: ProviderTransportId;
      readonly transportVersion: string;
      readonly providerCredentialVariablesPresent: boolean;
      readonly alternateBackendVariablesPresent: boolean;
      readonly observedApiKeySource: "none" | "configured" | "not-reported";
    }
  | {
      readonly check: "transport-version";
      readonly checkedAt: string;
      readonly transport: ProviderTransportId;
      readonly transportVersion: string;
      readonly executable: string;
    };

/** Sanitized, provider-neutral evidence about an external transport runtime. */
export interface TransportRuntimeEvidence {
  readonly format: "rb-external-runtime-evidence/v3";
  readonly cliInvocations: number;
  readonly observedProviderRequests: Measured<number>;
  readonly observedTopLevelModelSteps: readonly number[];
  readonly observedModelIds: readonly string[];
  readonly liveAttestations: readonly LiveRuntimeAttestation[];
  readonly invocationConfiguration: ModelInvocationConfigurationEvidence;
  readonly invocations?: readonly {
    readonly id: string;
    readonly recordingKey: string;
    readonly transportInvocations?: number;
    /** Sanitized result of checking the real cwd before its path was removed. */
    readonly cwdIsolated: boolean;
    readonly numTurns?: number;
    readonly topLevelModelSteps: number;
    readonly modelIds: readonly string[];
    readonly resultSubtype?: string;
  }[];
}

/** Additive provider-neutral evidence for external CLIs using JSONL transport. */
export interface ExternalCliRuntimeEvidence {
  readonly format: "rb-external-cli-evidence/v1";
  readonly executable: string;
  readonly transportVersion: string;
  readonly requestedModel: string;
  readonly transportInvocations: number;
  readonly observedProviderRequests: Measured<number>;
  readonly invocationPolicy: ExternalCliInvocationPolicyEvidence;
  readonly invocations: readonly {
    readonly id: string;
    readonly recordingKey: string;
    readonly transportInvocations: 1;
    readonly processCompleted: boolean;
    readonly treeQuiescent: boolean;
    readonly treeVerified: boolean;
    readonly observedModelIds: readonly string[];
    readonly toolEventsObserved: number;
  }[];
}

export interface ConformanceRecordBody {
  readonly format: "rb-adapter-conformance-record/v1";
  readonly producer: "rb-harness-conformance-runner";
  readonly profileId: string;
  readonly transport: ProviderTransportId;
  /** Integrity-bound when emitted by current external-transport recorders. */
  readonly requestAccounting?: RequestAccounting;
  readonly providerFamily?: string;
  readonly modelId?: string;
  readonly transportVersion?: string;
  readonly suiteVersion: string;
  readonly runId: string;
  readonly recordedAt: string;
  readonly rawResponses: Readonly<Record<string, RecordedRawResponse>>;
  readonly liveSmoke: {
    readonly cancellation: LiveSmokeRecord;
    readonly timeout: LiveSmokeRecord;
  };
  readonly runtimeEvidence?: TransportRuntimeEvidence;
  readonly externalCliEvidence?: ExternalCliRuntimeEvidence;
  readonly result: ConformanceResult;
}

export interface ConformanceRecord extends ConformanceRecordBody {
  readonly integritySha256: string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function recordIntegrity(body: ConformanceRecordBody): string {
  return createHash("sha256").update(canonical(body)).digest("hex");
}

export function sealRecord(body: ConformanceRecordBody): ConformanceRecord {
  return { ...body, integritySha256: recordIntegrity(body) };
}

export function verifyRecordIntegrity(record: ConformanceRecord): boolean {
  const { integritySha256: _integrity, ...body } = record;
  return recordIntegrity(body) === record.integritySha256;
}

export function conformanceRecordFileName(profileId: string): string {
  return `${profileId.replace(/[^a-z0-9._-]+/gi, "_")}.json`;
}

const FORBIDDEN_CREDENTIAL_KEY = /^(?:x-api-key|authorization|api[-_]?key(?:source)?|secret|ciphertext|vault(?:material)?|email|account_?id|org(?:anization)?_?id|org_?name|oauth_?token|session_?token|projects_?directory)$/i;
const PROVIDER_SECRET_VALUE = /\bsk-[A-Za-z0-9_-]{12,}\b/i;

export function assertConformanceRecordSanitized(record: ConformanceRecord): void {
  const visit = (value: unknown, path: string): void => {
    if (typeof value === "string") {
      if (PROVIDER_SECRET_VALUE.test(value)) throw new Error(`conformance record contains credential material at ${path}`);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${path}[${index}]`));
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_CREDENTIAL_KEY.test(key)) throw new Error(`conformance record contains forbidden credential field at ${path}.${key}`);
      visit(entry, `${path}.${key}`);
    }
  };
  visit(record, "$record");
}

export async function writeConformanceRecord(root: string, record: ConformanceRecord): Promise<string> {
  assertConformanceRecordSanitized(record);
  if (!verifyRecordIntegrity(record)) throw new Error("refusing to write a conformance record with invalid integrity");
  await mkdir(root, { recursive: true });
  const path = resolve(root, conformanceRecordFileName(record.profileId));
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return path;
}

export async function readConformanceRecord(root: string, profileId: string): Promise<ConformanceRecord> {
  const path = resolve(root, conformanceRecordFileName(profileId));
  const parsed = JSON.parse(await readFile(path, "utf8")) as ConformanceRecord;
  if (parsed.format !== "rb-adapter-conformance-record/v1" || parsed.producer !== "rb-harness-conformance-runner") {
    throw new Error(`invalid conformance record format: ${path}`);
  }
  if (!isProviderTransportId(parsed.transport)) throw new Error(`invalid conformance record transport: ${String(parsed.transport)}`);
  if (parsed.requestAccounting !== undefined && !isRequestAccounting(parsed.requestAccounting)) {
    throw new Error(`invalid conformance record request accounting: ${String(parsed.requestAccounting)}`);
  }
  assertConformanceRecordSanitized(parsed);
  if (!verifyRecordIntegrity(parsed)) throw new Error(`conformance record integrity mismatch: ${path}`);
  return parsed;
}

export function newRunIdentity(now = new Date()): { runId: string; recordedAt: string } {
  return { runId: randomUUID(), recordedAt: now.toISOString() };
}
