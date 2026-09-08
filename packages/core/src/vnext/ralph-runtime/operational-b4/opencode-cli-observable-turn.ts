import { canonicalJson } from "../canonical-json.js";
import { sha256Canonical } from "../hashing.js";
import { assertNoCredentialMaterial, RalphCredentialSafetyError } from "../operational-b1/secret-safety.js";
import { RalphM4BError } from "./opencode-cli-contract.js";
import { validateOpenCodeTransportMessageV2 } from "./opencode-cli-transport-safety.js";

export const OPENCODE_OBSERVABLE_TURN_SCHEMA_V2 = "rb-ralph-opencode-observable-turn/v1" as const;

export interface ObservableOpenCodeTurnInputV2 {
  readonly user: unknown;
  readonly assistants: readonly unknown[];
}

export interface ObservableOpenCodePartV2 {
  readonly id: string;
  readonly sessionId: string;
  readonly messageId: string;
  readonly type: string;
  readonly structural: Readonly<Record<string, unknown>>;
}

export interface ObservableOpenCodeTurnV2 {
  readonly schema: typeof OPENCODE_OBSERVABLE_TURN_SCHEMA_V2;
  readonly sessionId: string;
  readonly userMessage: {
    readonly id: string;
    readonly sessionId: string;
    readonly createdAt: number | null;
    readonly agent: string | null;
    readonly providerId: string | null;
    readonly modelId: string | null;
    readonly parts: readonly ObservableOpenCodePartV2[];
  };
  readonly assistants: readonly {
    readonly id: string;
    readonly sessionId: string;
    readonly parentId: string;
    readonly providerId: string;
    readonly modelId: string;
    readonly finish: string | null;
    readonly classification: "SUCCEEDED" | "FAILED";
    readonly createdAt: number | null;
    readonly completedAt: number | null;
    readonly mode: string | null;
    readonly agent: string | null;
    readonly variant: string | null;
    readonly parts: readonly ObservableOpenCodePartV2[];
  }[];
  readonly terminalAssistantId: string;
}

/**
 * Project the exact public OpenCode turn onto fields that survive
 * `opencode export --sanitize`. Text, tool input/output, paths, snapshots,
 * accounting and other provider content are intentionally excluded.
 */
export function projectObservableOpenCodeTurnV2(input: ObservableOpenCodeTurnInputV2): ObservableOpenCodeTurnV2 {
  if (!Array.isArray(input.assistants) || input.assistants.length < 1 || input.assistants.length > 256) invalid();
  const user = validateOpenCodeTransportMessageV2(input.user);
  const userInfo = record(user.info);
  const sessionId = requiredString(userInfo.sessionID);
  const userMessageId = requiredString(userInfo.id);
  if (userInfo.role !== "user") invalid();

  const assistants = input.assistants.map((candidate) => {
    const envelope = validateOpenCodeTransportMessageV2(candidate);
    const info = record(envelope.info);
    if (info.role !== "assistant" || info.sessionID !== sessionId || info.parentID !== userMessageId) invalid();
    const finish = optionalString(info.finish);
    const failed = info.error !== undefined && info.error !== null;
    return Object.freeze({
      id: requiredString(info.id),
      sessionId: requiredString(info.sessionID),
      parentId: requiredString(info.parentID),
      providerId: requiredString(info.providerID),
      modelId: requiredString(info.modelID),
      finish,
      classification: failed ? "FAILED" as const : "SUCCEEDED" as const,
      createdAt: timeNumber(info.time, "created"),
      completedAt: timeNumber(info.time, "completed"),
      mode: optionalString(info.mode),
      agent: optionalString(info.agent),
      variant: optionalString(info.variant),
      parts: Object.freeze(envelope.parts.map(projectPart)),
    });
  });
  const terminals = assistants.filter((assistant) => assistant.finish === "stop");
  if (terminals.length !== 1 || assistants.at(-1)?.id !== terminals[0]!.id) invalid();

  const userModel = record(userInfo.model);
  const value: ObservableOpenCodeTurnV2 = {
    schema: OPENCODE_OBSERVABLE_TURN_SCHEMA_V2,
    sessionId,
    userMessage: Object.freeze({
      id: userMessageId,
      sessionId,
      createdAt: timeNumber(userInfo.time, "created"),
      agent: optionalString(userInfo.agent),
      providerId: optionalString(userModel.providerID),
      modelId: optionalString(userModel.modelID),
      parts: Object.freeze(user.parts.map(projectPart)),
    }),
    assistants: Object.freeze(assistants),
    terminalAssistantId: terminals[0]!.id,
  };
  assertProjectionSafe(value);
  return freezeDeep(value);
}

export function digestObservableOpenCodeTurnV2(input: ObservableOpenCodeTurnInputV2): string {
  return sha256Canonical(projectObservableOpenCodeTurnV2(input));
}

function projectPart(value: unknown): ObservableOpenCodePartV2 {
  const part = record(value);
  const type = requiredString(part.type);
  const structural: Record<string, unknown> = {};
  switch (type) {
    case "text":
      assignOptionalBoolean(structural, "synthetic", part.synthetic);
      assignOptionalBoolean(structural, "ignored", part.ignored);
      assignTime(structural, part.time, ["start", "end"]);
      break;
    case "reasoning":
      assignTime(structural, part.time, ["start", "end"]);
      break;
    case "tool": {
      structural.callId = requiredString(part.callID);
      structural.tool = requiredString(part.tool);
      const state = record(part.state);
      structural.status = requiredString(state.status);
      assignTime(structural, state.time, ["start", "end", "compacted"]);
      if (Array.isArray(state.attachments)) {
        structural.attachmentIds = Object.freeze(state.attachments.map((attachment) => requiredString(record(attachment).id)));
      }
      break;
    }
    case "step-finish":
      structural.reason = requiredString(part.reason);
      break;
    case "patch":
      structural.hash = requiredString(part.hash);
      break;
    case "agent":
      structural.name = requiredString(part.name);
      break;
    case "subtask": {
      structural.agent = requiredString(part.agent);
      const model = record(part.model);
      structural.providerId = optionalString(model.providerID);
      structural.modelId = optionalString(model.modelID);
      break;
    }
    case "retry":
      structural.attempt = requiredNonNegativeInteger(part.attempt);
      structural.errorName = requiredString(record(part.error).name);
      assignTime(structural, part.time, ["created"]);
      break;
    case "compaction":
      structural.auto = requiredBoolean(part.auto);
      assignOptionalBoolean(structural, "overflow", part.overflow);
      structural.tailStartId = optionalString(part.tail_start_id);
      break;
    case "file": {
      structural.mime = requiredString(part.mime);
      const source = record(part.source);
      structural.sourceType = optionalString(source.type);
      break;
    }
    case "step-start":
    case "snapshot":
      break;
    default:
      invalid();
  }
  return freezeDeep({
    id: requiredString(part.id),
    sessionId: requiredString(part.sessionID),
    messageId: requiredString(part.messageID),
    type,
    structural: freezeDeep(structural),
  });
}

function assignTime(target: Record<string, unknown>, value: unknown, keys: readonly string[]): void {
  if (value === undefined) return;
  const time = record(value);
  const projected: Record<string, number> = {};
  for (const key of keys) {
    if (time[key] !== undefined) projected[key] = requiredNonNegativeInteger(time[key]);
  }
  target.time = Object.freeze(projected);
}

function timeNumber(value: unknown, key: string): number | null {
  if (value === undefined) return null;
  const candidate = record(value)[key];
  return candidate === undefined ? null : requiredNonNegativeInteger(candidate);
}

function assignOptionalBoolean(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) target[key] = requiredBoolean(value);
}

function requiredBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") invalid();
  return value;
}

function requiredNonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) invalid();
  return Number(value);
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || value.includes("\0")) invalid();
  return value;
}

function optionalString(value: unknown): string | null {
  return value === undefined || value === null ? null : requiredString(value);
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function assertProjectionSafe(value: ObservableOpenCodeTurnV2): void {
  if (Buffer.byteLength(canonicalJson(value), "utf8") > 256 * 1024) invalid();
  try { assertNoCredentialMaterial(value, "M4B_PROVIDER_CREDENTIAL_MATERIAL"); }
  catch (error) {
    if (error instanceof RalphCredentialSafetyError) throw new RalphM4BError("M4B_PROVIDER_CREDENTIAL_MATERIAL", undefined, error);
    throw error;
  }
}

function invalid(): never {
  throw new RalphM4BError("M4B_PROVIDER_RESULT_INVALID");
}

function freezeDeep<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  return value;
}
