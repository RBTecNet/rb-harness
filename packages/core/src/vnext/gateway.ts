import type { CorrectiveSemanticInput, SemanticAttemptEvidence, InitRunCounters } from "./run-state.js";
import type {
  CanonicalUsage,
  JsonSchemaDocument,
  Measured,
  ModelProfile,
  ProviderAdapter,
  ProviderResponseError,
  ResolvedProviderAuth,
  SemanticRequest,
} from "./providers/contract.js";
import type { WireFinding, WireOutcome } from "./wire.js";
import type { RejectedFindingEvidence } from "./rejected-evidence.js";

export type SemanticSlice = "intent" | "work";

export type SemanticGatewayFailureKind =
  | "provider-failure"
  | "transport-exhausted"
  | "semantic-invalid-after-recovery"
  | "budget-exhausted";

export class SemanticGatewayError extends Error {
  constructor(
    readonly kind: SemanticGatewayFailureKind,
    message: string,
    readonly slice: SemanticSlice,
    readonly findings: readonly WireFinding[] = [],
    readonly providerError?: ProviderResponseError,
  ) {
    super(`${kind}: ${message}`);
    this.name = "SemanticGatewayError";
  }
}

export interface SemanticGatewaySnapshot {
  readonly counters: InitRunCounters;
  readonly attempts: readonly SemanticAttemptEvidence[];
}

export interface GenerateSemanticSlice<T> {
  readonly slice: SemanticSlice;
  readonly schema: JsonSchemaDocument;
  readonly schemaName: string;
  readonly instructions: string;
  readonly input: string;
  readonly correctiveInput: (findings: readonly WireFinding[]) => CorrectiveSemanticInput;
  readonly decode: (payload: unknown) => SemanticDecodeOutcome<T>;
  readonly signal: AbortSignal;
  readonly deadlineMs: number;
  readonly maxOutputTokens: number;
}

export type SemanticDecodeOutcome<T> = WireOutcome<T> | {
  readonly ok: false;
  readonly findings: readonly WireFinding[];
  readonly rejectedFindings: readonly RejectedFindingEvidence[];
};

type SnapshotListener = (snapshot: SemanticGatewaySnapshot) => void | Promise<void>;

function unavailable(reason: "unsupported-by-provider" | "not-reported-in-this-response"): Measured<number> {
  return { measured: false, reason };
}

export class SemanticGateway {
  private semanticOperations = 0;
  private transportInvocations = 0;
  private transportRetries = 0;
  private correctiveRegenerations = 0;
  private readonly correctiveBySlice: Record<SemanticSlice, number> = { intent: 0, work: 0 };
  private readonly operationsBySlice: Record<SemanticSlice, number> = { intent: 0, work: 0 };
  private readonly attempts: SemanticAttemptEvidence[] = [];
  private providerRequests: Measured<number>;

  constructor(
    private readonly adapter: ProviderAdapter,
    readonly profile: ModelProfile,
    private readonly auth: ResolvedProviderAuth,
    private readonly onSnapshot?: SnapshotListener,
  ) {
    if (adapter.family !== profile.family || adapter.transport !== profile.transport || !adapter.profiles.some((entry) => entry.id === profile.id)) {
      throw new Error(`PROFILE_ADAPTER_MISMATCH: ${profile.id}`);
    }
    if (!profile.conformance.verifiedRecord || profile.conformance.tier === "UNSUPPORTED") {
      throw new Error(`PROFILE_NOT_CONFORMED: ${profile.id}`);
    }
    this.providerRequests = profile.requestAccounting === "exact" ? { measured: true, value: 0 } : unavailable("unsupported-by-provider");
  }

  snapshot(): SemanticGatewaySnapshot {
    return {
      counters: {
        semanticOperations: this.semanticOperations,
        transportInvocations: this.transportInvocations,
        transportRetries: this.transportRetries,
        correctiveRegenerations: this.correctiveRegenerations,
        correctiveBySlice: { ...this.correctiveBySlice },
        providerRequests: this.providerRequests,
      },
      attempts: this.attempts.map((entry) => ({
        ...entry,
        findings: [...entry.findings],
        ...(entry.rejectedFindings ? { rejectedFindings: structuredClone(entry.rejectedFindings) } : {}),
        ...(entry.recovery ? {
          recovery: {
            ...entry.recovery,
            recoveryScope: { ...entry.recovery.recoveryScope },
            violatedRules: [...entry.recovery.violatedRules],
            specificPreviousFindings: entry.recovery.specificPreviousFindings.map((finding) => ({ ...finding })),
            hashes: { ...entry.recovery.hashes },
          },
        } : {}),
      })),
    };
  }

  private async changed(): Promise<void> {
    await this.onSnapshot?.(this.snapshot());
  }

  private addUsage(usage: CanonicalUsage): void {
    if (this.profile.requestAccounting === "opaque") {
      this.providerRequests = unavailable("unsupported-by-provider");
      return;
    }
    if (!this.providerRequests.measured || !usage.providerRequests.measured) {
      this.providerRequests = unavailable("not-reported-in-this-response");
      return;
    }
    this.providerRequests = { measured: true, value: this.providerRequests.value + usage.providerRequests.value };
  }

  private beginOperation(slice: SemanticSlice, corrective: boolean): number {
    if (this.semanticOperations >= 4) throw new SemanticGatewayError("budget-exhausted", "semantic operation ceiling of 4 reached", slice);
    if (!corrective && this.operationsBySlice[slice] >= 1) {
      throw new SemanticGatewayError("budget-exhausted", `${slice} already used its normal semantic operation`, slice);
    }
    if (corrective) {
      if (this.correctiveBySlice[slice] >= 1) throw new SemanticGatewayError("budget-exhausted", `${slice} corrective regeneration ceiling reached`, slice);
      if (this.correctiveRegenerations >= 2) throw new SemanticGatewayError("budget-exhausted", "run corrective regeneration ceiling reached", slice);
      this.correctiveBySlice[slice] += 1;
      this.correctiveRegenerations += 1;
    }
    this.operationsBySlice[slice] += 1;
    this.semanticOperations += 1;
    return this.semanticOperations;
  }

  private async invoke(request: SemanticRequest, slice: SemanticSlice): Promise<Awaited<ReturnType<ProviderAdapter["request"]>>> {
    let retryForOperation = 0;
    while (true) {
      if (this.transportInvocations >= 6) throw new SemanticGatewayError("budget-exhausted", "transport invocation ceiling of 6 reached", slice);
      this.transportInvocations += 1;
      await this.changed();
      const outcome = await this.adapter.request(this.profile, this.auth, request);
      if (outcome.ok) {
        this.addUsage(outcome.value.usage);
        return outcome;
      }
      if (outcome.error.usage) this.addUsage(outcome.error.usage);
      if (!outcome.error.transportRetryable) return outcome;
      if (retryForOperation >= 1 || this.transportRetries >= 2) {
        throw new SemanticGatewayError("transport-exhausted", outcome.error.message, slice, [], outcome.error);
      }
      if (this.transportInvocations >= 6) throw new SemanticGatewayError("budget-exhausted", "transport invocation ceiling reached before retry", slice);
      retryForOperation += 1;
      this.transportRetries += 1;
      await this.changed();
    }
  }

  async generate<T>(operation: GenerateSemanticSlice<T>): Promise<T> {
    let corrective = false;
    let findings: readonly WireFinding[] = [];
    while (true) {
      const ordinal = this.beginOperation(operation.slice, corrective);
      const attemptIndex = this.attempts.length;
      const correctiveInput = corrective ? operation.correctiveInput(findings) : undefined;
      this.attempts.push({
        slice: operation.slice,
        ordinal,
        corrective,
        status: "requested",
        findings: [],
        ...(correctiveInput ? {
          recovery: { slice: operation.slice, ordinal, ...correctiveInput.audit },
        } : {}),
      });
      await this.changed();
      const request: SemanticRequest = {
        slice: operation.slice,
        instructions: operation.instructions,
        input: correctiveInput?.input ?? operation.input,
        schema: operation.schema,
        schemaName: operation.schemaName,
        limits: { maxOutputTokens: operation.maxOutputTokens, deadlineMs: operation.deadlineMs },
        reasoning: { mode: "on", effort: "low" },
        signal: operation.signal,
      };
      let outcome: Awaited<ReturnType<ProviderAdapter["request"]>>;
      try {
        outcome = await this.invoke(request, operation.slice);
      } catch (error) {
        this.attempts[attemptIndex] = { ...this.attempts[attemptIndex]!, status: "provider-failed" };
        await this.changed();
        throw error;
      }
      if (!outcome.ok) {
        this.attempts[attemptIndex] = { ...this.attempts[attemptIndex]!, status: "provider-failed" };
        await this.changed();
        throw new SemanticGatewayError("provider-failure", outcome.error.message, operation.slice, [], outcome.error);
      }
      const decoded = operation.decode(outcome.value.payload);
      if (decoded.ok) {
        this.attempts[attemptIndex] = { ...this.attempts[attemptIndex]!, status: "accepted" };
        await this.changed();
        return decoded.value;
      }
      findings = decoded.findings;
      const rejectedFindings = "rejectedFindings" in decoded ? decoded.rejectedFindings : [];
      this.attempts[attemptIndex] = {
        ...this.attempts[attemptIndex]!,
        status: "semantic-invalid",
        findings,
        ...(rejectedFindings.length ? { rejectedFindings } : {}),
      };
      await this.changed();
      if (corrective) {
        throw new SemanticGatewayError("semantic-invalid-after-recovery", `${operation.slice} remained invalid after one corrective regeneration`, operation.slice, findings);
      }
      corrective = true;
    }
  }
}
