import type { AuditPackageV2 } from "../operational-d/artifacts.js";
import {
  AUDIT_VERDICTS_V2,
  type AuditVerdictV2,
  type ProposedFindingV2,
} from "./artifacts.js";
import { sha256Canonical } from "../hashing.js";

export interface AuditorResultEnvelopeV2 {
  readonly verdict: AuditVerdictV2;
  readonly proposedFindings: readonly ProposedFindingV2[];
  readonly resolvedFindingRefs: readonly string[];
  readonly rationale: string;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface ScriptedAuditorDecisionV2 extends AuditorResultEnvelopeV2 {}

/**
 * Nominal Auditor protocol.  E never accepts a structurally matching object:
 * the runtime membership check below is the sole authority boundary for M3.
 */
export abstract class AuditorRuntimeV2 {
  private readonly auditorRuntimeNominalBrand!: void;

  protected constructor() {}

  abstract readonly kind: "AUDITOR_RUNTIME";
  abstract readonly runtimeIdentity: string;
  abstract readonly profileId: string;
  abstract readonly profileDigest: string;
  abstract invoke(auditPackage: AuditPackageV2): Promise<AuditorResultEnvelopeV2>;
}

const trustedScriptedAuditors = new WeakSet<ScriptedAuditor>();
const scriptedAuditorState = new WeakMap<ScriptedAuditor, {
  readonly defaultDecision: ScriptedAuditorDecisionV2;
  readonly configuredDecisions: ScriptedAuditorOptionsV2["decisions"];
  readonly decisionFunction: ScriptedAuditorOptionsV2["decide"];
  readonly cached: Map<string, AuditorResultEnvelopeV2>;
  invocationCount: number;
}>();

export interface ScriptedAuditorOptionsV2 {
  readonly runtimeIdentity?: string;
  readonly profileId?: string;
  readonly defaultDecision?: Partial<ScriptedAuditorDecisionV2> & Pick<ScriptedAuditorDecisionV2, "verdict">;
  readonly decisions?: ReadonlyMap<string, ScriptedAuditorDecisionV2> | Readonly<Record<string, ScriptedAuditorDecisionV2>>;
  readonly decide?: (auditPackage: AuditPackageV2) => ScriptedAuditorDecisionV2;
}

const DEFAULT_DECISION: ScriptedAuditorDecisionV2 = Object.freeze({
  verdict: "REJECT",
  proposedFindings: [],
  resolvedFindingRefs: [],
  rationale: "Scripted auditor default rejection",
  metadata: Object.freeze({ profile: "scripted-v2" }),
});

/** The only trusted M3 Auditor implementation. It has no process or store. */
export class ScriptedAuditor extends AuditorRuntimeV2 {
  readonly kind = "AUDITOR_RUNTIME" as const;
  readonly runtimeIdentity: string;
  readonly profileId: string;
  readonly profileDigest: string;

  constructor(options: ScriptedAuditorOptionsV2 = {}) {
    super();
    if (new.target !== ScriptedAuditor) throw new Error("RALPH_AUDITOR_AUTHORITY_REQUIRED: only ScriptedAuditor may possess M3 authority");
    this.runtimeIdentity = options.runtimeIdentity ?? "scripted-auditor-v2";
    this.profileId = options.profileId ?? "scripted-auditor-default-v1";
    this.profileDigest = sha256Canonical({ runtimeIdentity: this.runtimeIdentity, profileId: this.profileId });
    scriptedAuditorState.set(this, {
      defaultDecision: freezeDecision({ ...DEFAULT_DECISION, ...(options.defaultDecision ?? {}) }),
      configuredDecisions: options.decisions,
      decisionFunction: options.decide,
      cached: new Map<string, AuditorResultEnvelopeV2>(),
      invocationCount: 0,
    });
    trustedScriptedAuditors.add(this);
    Object.freeze(this);
  }

  async invoke(auditPackage: AuditPackageV2): Promise<AuditorResultEnvelopeV2> {
    const state = scriptedAuditorState.get(this);
    if (!state) throw new Error("RALPH_AUDITOR_AUTHORITY_REQUIRED");
    const key = auditPackage.packageDigest;
    const cached = state.cached.get(key);
    if (cached) return cached;
    state.invocationCount += 1;
    const decision = state.decisionFunction?.(auditPackage)
      ?? decisionForPackage(state.configuredDecisions, key)
      ?? state.defaultDecision;
    const result = freezeDecision(decision);
    assertAuditorResultEnvelopeV2(result);
    state.cached.set(key, result);
    return result;
  }

  get totalInvocations(): number { return scriptedAuditorState.get(this)?.invocationCount ?? 0; }
}

export type TrustedAuditorRuntimeV2 = ScriptedAuditor;

export function isTrustedAuditorRuntimeV2(value: unknown): value is TrustedAuditorRuntimeV2 {
  return typeof value === "object" && value !== null && trustedScriptedAuditors.has(value as ScriptedAuditor);
}

export function assertTrustedAuditorRuntimeV2(value: unknown): asserts value is TrustedAuditorRuntimeV2 {
  if (!isTrustedAuditorRuntimeV2(value)) throw new Error("RALPH_AUDITOR_AUTHORITY_REQUIRED: trusted ScriptedAuditor runtime is required");
}

export function assertAuditorResultEnvelopeV2(value: unknown): asserts value is AuditorResultEnvelopeV2 {
  if (!isRecord(value)) throw new Error("RALPH_AUDITOR_RESULT_INVALID");
  const allowed = new Set(["verdict", "proposedFindings", "resolvedFindingRefs", "rationale", "metadata"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error("RALPH_AUDITOR_RESULT_UNKNOWN_FIELD");
  if (!AUDIT_VERDICTS_V2.includes(value.verdict as AuditVerdictV2)) throw new Error("RALPH_AUDITOR_RESULT_INVALID_VERDICT");
  if (!Array.isArray(value.proposedFindings) || value.proposedFindings.length > 128) throw new Error("RALPH_AUDITOR_RESULT_INVALID_FINDINGS");
  if (!Array.isArray(value.resolvedFindingRefs) || value.resolvedFindingRefs.some((item) => typeof item !== "string" || item.length === 0 || item.length > 512 || item.includes("/"))) throw new Error("RALPH_AUDITOR_RESULT_INVALID_RESOLUTION");
  if (typeof value.rationale !== "string" || value.rationale.length > 4096 || value.rationale.includes("\0")) throw new Error("RALPH_AUDITOR_RESULT_INVALID_RATIONALE");
  if (!isRecord(value.metadata) || Object.entries(value.metadata).some(([key, item]) => !/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(key) || typeof item !== "string" || item.length > 512 || item.includes("\0"))) throw new Error("RALPH_AUDITOR_RESULT_INVALID_METADATA");
  // Proposed finding shape and secrets are checked again while creating the
  // immutable AuditResult.  This guard rejects arbitrary result envelopes at
  // the runtime boundary without minting any Core identity.
}

function decisionForPackage(
  decisions: ScriptedAuditorOptionsV2["decisions"],
  packageDigest: string,
): ScriptedAuditorDecisionV2 | undefined {
  if (!decisions) return undefined;
  if (decisions instanceof Map) return decisions.get(packageDigest);
  return (decisions as Readonly<Record<string, ScriptedAuditorDecisionV2>>)[packageDigest];
}

function freezeDecision(value: Partial<ScriptedAuditorDecisionV2> & Pick<ScriptedAuditorDecisionV2, "verdict">): ScriptedAuditorDecisionV2 {
  const result: ScriptedAuditorDecisionV2 = {
    verdict: value.verdict,
    proposedFindings: [...(value.proposedFindings ?? [])].map((finding) => Object.freeze({ ...finding })),
    resolvedFindingRefs: [...(value.resolvedFindingRefs ?? [])],
    rationale: value.rationale ?? "",
    metadata: Object.freeze({ ...(value.metadata ?? {}) }),
  };
  return Object.freeze(result);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
