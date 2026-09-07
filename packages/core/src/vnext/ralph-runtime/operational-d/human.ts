import type { RalphEventStoreV2 } from "../operational-b1/index.js";
import { assertNoCredentialMaterial, RalphCredentialSafetyError } from "../operational-b1/secret-safety.js";
import { canonicalJson } from "../canonical-json.js";
import { isSha256Digest, sha256Canonical } from "../hashing.js";
import {
  attemptArtifactRefV2,
  persistImmutableJsonArtifactV2,
  readImmutableJsonArtifactV2,
  type ArtifactPersistenceResultV2,
  RalphB4ArtifactError,
} from "../operational-b4/artifacts.js";

export const HUMAN_VALIDATION_DECISION_SCHEMA_V2 = "rb-ralph-human-validation-decision/v1" as const;
export const HUMAN_VALIDATION_DECISIONS_V2 = ["PASS", "FAIL"] as const;
export type HumanValidationDecisionValueV2 = typeof HUMAN_VALIDATION_DECISIONS_V2[number];

export interface HumanValidationRequestV2 {
  readonly runId: string;
  readonly phaseId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly validationSpecId: string;
  readonly validationSpecDigest: string;
  readonly humanRequestRef: string;
}

export interface ScriptedHumanDecisionEnvelopeV2 {
  readonly decision: HumanValidationDecisionValueV2;
  readonly decidedAt: string;
}

export interface HumanValidationAuthorityIdentityV2 {
  readonly kind: "SCRIPTED_HUMAN";
  readonly authorityId: string;
  readonly profileDigest: string;
}

/** Durable observation created only after Core invokes a nominal Human authority. */
export interface HumanValidationDecisionV2 extends HumanValidationRequestV2 {
  readonly schema: typeof HUMAN_VALIDATION_DECISION_SCHEMA_V2;
  readonly decision: HumanValidationDecisionValueV2;
  readonly authority: HumanValidationAuthorityIdentityV2;
  readonly decidedAt: string;
  readonly decisionDigest: string;
}

export interface ScriptedHumanValidationAuthorityOptionsV2 {
  readonly authorityId: string;
  readonly defaultDecision?: HumanValidationDecisionValueV2;
  readonly decide?: (request: HumanValidationRequestV2) => ScriptedHumanDecisionEnvelopeV2 | Promise<ScriptedHumanDecisionEnvelopeV2>;
  readonly clock?: () => string;
}

const trustedAuthorities = new WeakSet<object>();
const authorityState = new WeakMap<object, Readonly<{
  readonly identity: HumanValidationAuthorityIdentityV2;
  readonly defaultDecision?: HumanValidationDecisionValueV2;
  readonly decide?: ScriptedHumanValidationAuthorityOptionsV2["decide"];
  readonly clock: () => string;
}>>();
const trustedDecisions = new WeakSet<object>();
const HUMAN_AUTHORITY_CONSTRUCTION_SEAL = Object.freeze({ kind: "scripted-human-authority-construction" });

/** M3-only nominal Human trust root. It cannot append events or write artifacts. */
export class ScriptedHumanValidationAuthorityV2 {
  constructor(options: ScriptedHumanValidationAuthorityOptionsV2, seal: object = HUMAN_AUTHORITY_CONSTRUCTION_SEAL) {
    if (new.target !== ScriptedHumanValidationAuthorityV2 || seal !== HUMAN_AUTHORITY_CONSTRUCTION_SEAL) throw humanError("D_HUMAN_AUTHORITY_TRUST_REQUIRED");
    assertSafeIdentity(options.authorityId, "D_HUMAN_AUTHORITY_INVALID");
    if ((options.defaultDecision === undefined) === (options.decide === undefined)) throw humanError("D_HUMAN_AUTHORITY_INVALID");
    if (options.defaultDecision !== undefined && !HUMAN_VALIDATION_DECISIONS_V2.includes(options.defaultDecision)) throw humanError("D_HUMAN_AUTHORITY_INVALID");
    const identityCore = { kind: "SCRIPTED_HUMAN" as const, authorityId: options.authorityId };
    const identity = Object.freeze({ ...identityCore, profileDigest: sha256Canonical(identityCore) });
    authorityState.set(this, Object.freeze({
      identity,
      ...(options.defaultDecision === undefined ? {} : { defaultDecision: options.defaultDecision }),
      ...(options.decide === undefined ? {} : { decide: options.decide }),
      clock: options.clock ?? (() => new Date().toISOString()),
    }));
    trustedAuthorities.add(this);
    Object.freeze(this);
  }

  get identity(): HumanValidationAuthorityIdentityV2 {
    return requireAuthorityState(this).identity;
  }

  async decide(request: HumanValidationRequestV2): Promise<ScriptedHumanDecisionEnvelopeV2> {
    validateHumanValidationRequestV2(request);
    const state = requireAuthorityState(this);
    const envelope = state.decide
      ? await state.decide(Object.freeze({ ...request }))
      : { decision: state.defaultDecision!, decidedAt: state.clock() };
    validateScriptedHumanDecisionEnvelopeV2(envelope);
    return Object.freeze({ ...envelope });
  }
}

export function isTrustedHumanValidationAuthorityV2(value: unknown): value is ScriptedHumanValidationAuthorityV2 {
  return typeof value === "object" && value !== null && trustedAuthorities.has(value) && authorityState.has(value);
}

export function assertTrustedHumanValidationAuthorityV2(value: unknown): asserts value is ScriptedHumanValidationAuthorityV2 {
  if (!isTrustedHumanValidationAuthorityV2(value)) throw humanError("D_HUMAN_AUTHORITY_TRUST_REQUIRED");
}

export function humanValidationRequestRefV2(runId: string, attemptId: string, validationSpecId: string): string {
  for (const value of [runId, attemptId, validationSpecId]) assertSafeIdentity(value, "D_HUMAN_REQUEST_INVALID");
  return `human-request-${sha256Canonical({ runId, attemptId, validationSpecId }).slice("sha256:".length)}`;
}

export function createHumanValidationRequestV2(input: Omit<HumanValidationRequestV2, "humanRequestRef">): HumanValidationRequestV2 {
  const request = {
    ...input,
    humanRequestRef: humanValidationRequestRefV2(input.runId, input.attemptId, input.validationSpecId),
  };
  validateHumanValidationRequestV2(request);
  return Object.freeze(request);
}

export async function obtainTrustedHumanValidationDecisionV2(
  authority: ScriptedHumanValidationAuthorityV2,
  request: HumanValidationRequestV2,
): Promise<HumanValidationDecisionV2> {
  assertTrustedHumanValidationAuthorityV2(authority);
  validateHumanValidationRequestV2(request);
  const envelope = await authority.decide(request);
  validateScriptedHumanDecisionEnvelopeV2(envelope);
  const base = {
    schema: HUMAN_VALIDATION_DECISION_SCHEMA_V2,
    ...request,
    decision: envelope.decision,
    authority: authority.identity,
    decidedAt: envelope.decidedAt,
  } as const;
  const decision = Object.freeze({ ...base, decisionDigest: sha256Canonical(base) });
  validateHumanValidationDecisionV2(decision);
  trustedDecisions.add(decision);
  return decision;
}

export function validateHumanValidationRequestV2(value: unknown): asserts value is HumanValidationRequestV2 {
  if (!isRecord(value)) throw humanError("D_HUMAN_REQUEST_INVALID");
  assertExactKeys(value, ["runId", "phaseId", "taskId", "attemptId", "validationSpecId", "validationSpecDigest", "humanRequestRef"], "D_HUMAN_REQUEST_INVALID");
  for (const key of ["runId", "phaseId", "taskId", "attemptId", "validationSpecId", "humanRequestRef"] as const) assertSafeIdentity(value[key], "D_HUMAN_REQUEST_INVALID");
  if (!isSha256Digest(value.validationSpecDigest)) throw humanError("D_HUMAN_REQUEST_INVALID");
  if (value.humanRequestRef !== humanValidationRequestRefV2(value.runId, value.attemptId, value.validationSpecId)) throw humanError("D_HUMAN_REQUEST_INVALID");
}

export function validateScriptedHumanDecisionEnvelopeV2(value: unknown): asserts value is ScriptedHumanDecisionEnvelopeV2 {
  if (!isRecord(value)) throw humanError("D_HUMAN_DECISION_INVALID");
  assertExactKeys(value, ["decision", "decidedAt"], "D_HUMAN_DECISION_INVALID");
  if (!HUMAN_VALIDATION_DECISIONS_V2.includes(value.decision as HumanValidationDecisionValueV2)) throw humanError("D_HUMAN_DECISION_INVALID");
  assertSafeIdentity(value.decidedAt, "D_HUMAN_DECISION_INVALID");
}

export function validateHumanValidationDecisionV2(value: unknown): asserts value is HumanValidationDecisionV2 {
  if (!isRecord(value)) throw humanError("D_HUMAN_DECISION_INVALID");
  assertExactKeys(value, [
    "schema", "runId", "phaseId", "taskId", "attemptId", "validationSpecId", "validationSpecDigest", "humanRequestRef",
    "decision", "authority", "decidedAt", "decisionDigest",
  ], "D_HUMAN_DECISION_INVALID");
  if (value.schema !== HUMAN_VALIDATION_DECISION_SCHEMA_V2) throw humanError("D_HUMAN_DECISION_INVALID");
  validateHumanValidationRequestV2({
    runId: value.runId,
    phaseId: value.phaseId,
    taskId: value.taskId,
    attemptId: value.attemptId,
    validationSpecId: value.validationSpecId,
    validationSpecDigest: value.validationSpecDigest,
    humanRequestRef: value.humanRequestRef,
  });
  if (!HUMAN_VALIDATION_DECISIONS_V2.includes(value.decision as HumanValidationDecisionValueV2)) throw humanError("D_HUMAN_DECISION_INVALID");
  validateAuthorityIdentity(value.authority);
  assertSafeIdentity(value.decidedAt, "D_HUMAN_DECISION_INVALID");
  if (!isSha256Digest(value.decisionDigest)) throw humanError("D_HUMAN_DECISION_INVALID");
  const { decisionDigest: _ignored, ...base } = value;
  if (sha256Canonical(base) !== value.decisionDigest) throw humanError("D_HUMAN_DECISION_INVALID");
  try { assertNoCredentialMaterial(value, "D_HUMAN_DECISION_CREDENTIAL"); }
  catch (error) {
    if (error instanceof RalphCredentialSafetyError) throw humanError("D_HUMAN_DECISION_INVALID", error);
    throw error;
  }
}

export function humanValidationDecisionRefV2(attemptId: string, validationSpecId?: string): string {
  assertSegment(attemptId);
  const suffix = validationSpecId === undefined
    ? "human-validation-decision.json"
    : `human-validation-decision-${sha256Canonical({ validationSpecId }).slice("sha256:".length)}.json`;
  return attemptArtifactRefV2(attemptId, suffix);
}

export async function persistTrustedHumanValidationDecisionV2(
  store: RalphEventStoreV2,
  decision: HumanValidationDecisionV2,
  nonce: string,
): Promise<ArtifactPersistenceResultV2<HumanValidationDecisionV2>> {
  if (!trustedDecisions.has(decision)) throw humanError("D_HUMAN_DECISION_TRUST_REQUIRED");
  validateHumanValidationDecisionV2(decision);
  return persistImmutableJsonArtifactV2({
    store,
    ref: humanValidationDecisionRefV2(decision.attemptId, decision.validationSpecId),
    artifact: decision,
    validate: validateHumanValidationDecisionV2,
    nonce,
  });
}

export async function readHumanValidationDecisionV2(
  store: RalphEventStoreV2,
  attemptId: string,
  validationSpecId?: string,
): Promise<HumanValidationDecisionV2 | undefined> {
  return readImmutableJsonArtifactV2({ store, ref: humanValidationDecisionRefV2(attemptId, validationSpecId), validate: validateHumanValidationDecisionV2 });
}

export function canonicalHumanValidationDecisionV2(value: HumanValidationDecisionV2): string {
  validateHumanValidationDecisionV2(value);
  return canonicalJson(value);
}

function requireAuthorityState(authority: object) {
  if (!trustedAuthorities.has(authority)) throw humanError("D_HUMAN_AUTHORITY_TRUST_REQUIRED");
  const state = authorityState.get(authority);
  if (!state) throw humanError("D_HUMAN_AUTHORITY_TRUST_REQUIRED");
  return state;
}

function validateAuthorityIdentity(value: unknown): asserts value is HumanValidationAuthorityIdentityV2 {
  if (!isRecord(value)) throw humanError("D_HUMAN_DECISION_INVALID");
  assertExactKeys(value, ["kind", "authorityId", "profileDigest"], "D_HUMAN_DECISION_INVALID");
  if (value.kind !== "SCRIPTED_HUMAN") throw humanError("D_HUMAN_DECISION_INVALID");
  assertSafeIdentity(value.authorityId, "D_HUMAN_DECISION_INVALID");
  if (!isSha256Digest(value.profileDigest) || value.profileDigest !== sha256Canonical({ kind: value.kind, authorityId: value.authorityId })) throw humanError("D_HUMAN_DECISION_INVALID");
}

function humanError(message: string, cause?: unknown): RalphB4ArtifactError {
  return new RalphB4ArtifactError("B4_ARTIFACT_INVALID", message, cause);
}

function assertSafeIdentity(value: unknown, code: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || value.includes("\0") || value.includes("/")) throw humanError(code);
}

function assertExactKeys(value: object, allowed: readonly string[], code: string): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key)) || allowed.some((key) => !(key in value))) throw humanError(code);
}

function assertSegment(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new RalphB4ArtifactError("B4_ARTIFACT_PATH_UNSAFE");
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
