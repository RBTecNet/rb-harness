import { sha256Text } from "../hash.js";
import type { InitProjectModel, ValidationIntent } from "./ir.js";
import type { IntentWire, WorkWire } from "./wire.js";
import { modelFacingRecoveryFindings, type RecoveryRule } from "./recovery-findings.js";
import type { WireFinding } from "./wire.js";

export const REJECTED_EVIDENCE_STRING_LIMIT = 512 as const;
export const REJECTED_EVIDENCE_ENTRY_LIMIT = 64 as const;

export interface RejectedFindingEvidence {
  readonly pointer: string;
  readonly rule?: RecoveryRule;
  readonly value?: unknown;
  readonly valueSha256?: string;
  readonly valueTruncated?: true;
  readonly observed?: { readonly count: number };
}

function redactSecrets(value: string): string {
  return value
    .replace(/\b(?:x-api-key|authorization)\s*[:=]\s*(?:Bearer\s+)?[^\s,;]+/gi, "[REDACTED_HEADER]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "[REDACTED_TOKEN]")
    .replace(/\bsk-ant-[A-Za-z0-9_-]+\b/gi, "[REDACTED]")
    .replace(/\b[A-Z][A-Z0-9_]*(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET|PASSWORD)\s*=\s*[^\s,;]+/g, "[REDACTED_ENV_SECRET]")
    .replace(/\/home\/[^/\s]+\//g, "/home/[REDACTED]/");
}

function boundedString(value: string): { readonly value: string; readonly valueSha256: string; readonly valueTruncated?: true } {
  const sanitized = redactSecrets(value);
  const valueSha256 = sha256Text(sanitized);
  return sanitized.length <= REJECTED_EVIDENCE_STRING_LIMIT
    ? { value: sanitized, valueSha256 }
    : { value: sanitized.slice(0, REJECTED_EVIDENCE_STRING_LIMIT), valueSha256, valueTruncated: true };
}

function validationValue(value: ValidationIntent): unknown {
  if (value.kind === "command") return { kind: "command", commandKey: value.commandKey };
  if (value.kind === "manual") {
    const bounded = boundedString(value.inspection);
    return { kind: "manual", inspection: bounded.value, ...(bounded.valueTruncated ? { valueTruncated: true } : {}) };
  }
  const bounded = boundedString(value.evidence);
  return { kind: "human", evidence: bounded.value, ...(bounded.valueTruncated ? { valueTruncated: true } : {}) };
}

function semanticValidationValue(value: WorkWire["phases"][number]["tasks"][number]["validation"][number]): unknown {
  if (value.kind === "command") return { kind: "command", commandKey: value.commandKey };
  if (value.kind === "manual") {
    const bounded = boundedString(value.inspection);
    return { kind: "manual", inspection: bounded.value, ...(bounded.valueTruncated ? { valueTruncated: true } : {}) };
  }
  const bounded = boundedString(value.evidence);
  return { kind: "human", evidence: bounded.value, ...(bounded.valueTruncated ? { valueTruncated: true } : {}) };
}

function withFinding(finding: WireFinding, extracted: Omit<RejectedFindingEvidence, "pointer" | "rule">): RejectedFindingEvidence {
  const safe = modelFacingRecoveryFindings([finding])[0]!;
  return { pointer: safe.pointer, ...(safe.rule ? { rule: safe.rule } : {}), ...extracted };
}

export function rejectedIntentFindingEvidence(
  candidate: IntentWire,
  findings: readonly WireFinding[],
): readonly RejectedFindingEvidence[] {
  return findings.flatMap((finding) => {
    const match = finding.pointer.match(/^\/qualityCommands\/(\d+)\/command$/);
    if (!match) return [];
    const command = candidate.qualityCommands[Number(match[1])]?.command;
    return command === undefined ? [] : [withFinding(finding, boundedString(command))];
  }).slice(0, REJECTED_EVIDENCE_ENTRY_LIMIT);
}

export function rejectedWorkFindingEvidence(
  candidate: WorkWire,
  findings: readonly WireFinding[],
): readonly RejectedFindingEvidence[] {
  return findings.flatMap((finding) => {
    const match = finding.pointer.match(/^\/phases\/(\d+)\/tasks\/(\d+)\/(acceptance|ownedPaths|validation)(?:\/(\d+))?$/);
    if (!match) return [];
    const task = candidate.phases[Number(match[1])]?.tasks[Number(match[2])];
    if (!task) return [];
    const field = match[3]!;
    const index = match[4] === undefined ? undefined : Number(match[4]);
    const collection = field === "acceptance" ? task.acceptance : field === "ownedPaths" ? task.ownedPaths : task.validation;
    if (index === undefined) return [withFinding(finding, { observed: { count: collection.length } })];
    const value = collection[index];
    if (value === undefined) return [];
    if (field === "acceptance" || field === "ownedPaths") return [withFinding(finding, boundedString(value as string))];
    const sanitized = semanticValidationValue(value as WorkWire["phases"][number]["tasks"][number]["validation"][number]);
    return [withFinding(finding, { value: sanitized, valueSha256: sha256Text(JSON.stringify(sanitized)) })];
  }).slice(0, REJECTED_EVIDENCE_ENTRY_LIMIT);
}

function candidateEvidence(model: InitProjectModel, pointer: string): Omit<RejectedFindingEvidence, "pointer" | "rule"> | undefined {
  let match = pointer.match(/^\/qualityCommands\/(\d+)\/command$/);
  if (match) {
    const value = model.qualityCommands[Number(match[1])]?.command;
    return value === undefined ? undefined : boundedString(value);
  }

  match = pointer.match(/^\/phases\/(\d+)\/tasks\/(\d+)\/(acceptance|ownedPaths|validation)(?:\/(\d+))?$/);
  if (match) {
    const task = model.phases[Number(match[1])]?.tasks[Number(match[2])];
    if (!task) return undefined;
    const field = match[3]!;
    const itemIndex = match[4] === undefined ? undefined : Number(match[4]);
    const collection = field === "acceptance" ? task.acceptance : field === "ownedPaths" ? task.ownedPaths : task.validation;
    if (itemIndex === undefined) return { observed: { count: collection.length } };
    const item = collection[itemIndex];
    if (item === undefined) return undefined;
    if (field === "acceptance") return boundedString((item as InitProjectModel["phases"][number]["tasks"][number]["acceptance"][number]).statement);
    if (field === "ownedPaths") return boundedString(item as string);
    const value = validationValue(item as ValidationIntent);
    return { value, valueSha256: sha256Text(JSON.stringify(value)) };
  }

  match = pointer.match(/^\/phases\/(\d+)\/tasks\/(\d+)\/(intent|expectedEvidence)$/);
  if (match) {
    const task = model.phases[Number(match[1])]?.tasks[Number(match[2])];
    const value = match[3] === "intent" ? task?.intent : task?.expectedEvidence;
    return value === undefined ? undefined : boundedString(value);
  }

  match = pointer.match(/^\/phases\/(\d+)\/tasks$/);
  if (match) {
    const phase = model.phases[Number(match[1])];
    return phase ? { observed: { count: phase.tasks.length } } : undefined;
  }
  return undefined;
}

/** Extracts only allowlisted diagnostic values from the exact rejected Core model. */
export function rejectedFindingEvidence(
  model: InitProjectModel,
  findings: readonly WireFinding[],
): readonly RejectedFindingEvidence[] {
  return findings.flatMap((finding) => {
    const extracted = candidateEvidence(model, finding.pointer);
    if (!extracted) return [];
    return [withFinding(finding, extracted)];
  }).slice(0, REJECTED_EVIDENCE_ENTRY_LIMIT);
}
