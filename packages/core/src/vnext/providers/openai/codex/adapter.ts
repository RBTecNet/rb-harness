import type {
  CanonicalSemanticResponse,
  ModelProfile,
  ProviderAdapter,
  ProviderOutcome,
  ProviderRuntimeObservation,
  ResolvedProviderAuth,
  SemanticRequest,
} from "../../contract.js";
import { validateCodexAuth } from "./auth.js";
import { ManagedCodexRuntimeVerifier, type CodexRuntimeVerifier, type VerifiedCodexRuntime } from "./managed-runtime.js";
import {
  isCodexAppServerRawResponse,
  normalizeCodexAppServer,
  observeCodexAppServer,
  validateCodexSemanticPreflight,
  type CodexAppServerRawResponse,
} from "./normalize.js";
import { SpawnCodexAppServerTransport, type CodexAppServerTransport } from "./process.js";
import { CODEX_SUBSCRIPTION_PROFILE_ID, CODEX_SUBSCRIPTION_PROFILES } from "./profiles.js";

function unsupported(message: string): ProviderOutcome<never> {
  return { ok: false, error: { kind: "unsupported-capability", message, transportRetryable: false } };
}

export function preflightCodexSubscription(profile: ModelProfile, request: SemanticRequest): ProviderOutcome<true> {
  if (profile.id !== CODEX_SUBSCRIPTION_PROFILE_ID || profile.family !== "openai" || profile.transport !== "codex-app-server" || profile.modelId !== "gpt-5.6-sol") {
    return unsupported(`profile ${profile.id} is not the certified Codex Subscription profile`);
  }
  if (profile.structuredOutput !== "json-schema" || profile.strictSchema || profile.toolCalling || profile.toolChoiceForcing) {
    return unsupported("Codex Subscription requires non-strict JSON Schema with no Harness tools");
  }
  if (!Number.isInteger(request.limits.maxOutputTokens) || request.limits.maxOutputTokens < 1 || request.limits.maxOutputTokens > profile.maxOutputTokens) {
    return unsupported(`maxOutputTokens must be between 1 and ${profile.maxOutputTokens}`);
  }
  if (!Number.isFinite(request.limits.deadlineMs) || request.limits.deadlineMs <= 0) return unsupported("deadlineMs must be positive");
  if (request.reasoning.mode !== "off") return unsupported("Codex Subscription semantic mode does not accept per-request reasoning overrides");
  return { ok: true, value: true };
}

export interface CodexRequestResult {
  readonly outcome: ProviderOutcome<CanonicalSemanticResponse>;
  readonly raw?: CodexAppServerRawResponse;
  readonly runtime?: VerifiedCodexRuntime;
  readonly treeQuiescent?: boolean;
  readonly treeVerified?: boolean;
}

export class CodexSubscriptionAdapter implements ProviderAdapter {
  readonly family = "openai";
  readonly transport = "codex-app-server" as const;
  readonly profiles = CODEX_SUBSCRIPTION_PROFILES;
  private modelInvocationCount = 0;

  constructor(
    private readonly transportRunner: CodexAppServerTransport = new SpawnCodexAppServerTransport(),
    private readonly runtimeVerifier: CodexRuntimeVerifier = new ManagedCodexRuntimeVerifier(),
  ) {}

  get modelInvocations(): number { return this.modelInvocationCount; }

  checkCapabilities(profile: ModelProfile, request: SemanticRequest): ProviderOutcome<true> {
    return preflightCodexSubscription(profile, request);
  }

  replay(profile: ModelProfile, request: SemanticRequest, raw: unknown): ProviderOutcome<CanonicalSemanticResponse> {
    const capabilities = preflightCodexSubscription(profile, request);
    if (!capabilities.ok) return capabilities;
    if (!isCodexAppServerRawResponse(raw)) return { ok: false, error: { kind: "malformed-syntax", message: "recorded rb-codex app-server response is malformed", transportRetryable: false } };
    const preflight = validateCodexSemanticPreflight(profile, raw.preflight, { semanticRuntimeVersion: raw.preflight.runtimeVersion, semanticModeVersion: raw.preflight.semanticModeVersion });
    if (!preflight.ok) return preflight;
    return normalizeCodexAppServer(profile, request, raw);
  }

  observeRuntime(raw: unknown): ProviderRuntimeObservation | undefined {
    return observeCodexAppServer(raw);
  }

  async runtimePreflight(): Promise<ProviderOutcome<VerifiedCodexRuntime>> {
    return this.runtimeVerifier.verify();
  }

  async requestWithRaw(profile: ModelProfile, auth: ResolvedProviderAuth, request: SemanticRequest): Promise<CodexRequestResult> {
    const capabilities = preflightCodexSubscription(profile, request);
    if (!capabilities.ok) return { outcome: capabilities };
    const checkedAuth = validateCodexAuth(auth);
    if (!checkedAuth.ok) return { outcome: checkedAuth };
    if (request.signal.aborted) return { outcome: { ok: false, error: { kind: "cancelled", message: "Codex Subscription request was cancelled before transport", transportRetryable: false } } };
    const runtime = await this.runtimeVerifier.verify();
    if (!runtime.ok) return { outcome: runtime };
    this.modelInvocationCount += 1;
    try {
      const raw = await this.transportRunner.run({
        executable: runtime.value.executable,
        authFile: checkedAuth.value.path,
        model: profile.modelId,
        instructions: request.instructions,
        input: request.input,
        outputSchema: request.schema,
        deadlineMs: request.limits.deadlineMs,
        signal: request.signal,
        acceptPreflight: (value) => {
          const checked = validateCodexSemanticPreflight(profile, value, runtime.value);
          if (!checked.ok) throw new Error(`${checked.error.kind}: ${checked.error.message}`);
          return checked.value;
        },
      });
      return { outcome: normalizeCodexAppServer(profile, request, raw), raw, runtime: runtime.value, treeQuiescent: raw.processCompleted, treeVerified: raw.processCompleted };
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      const message = error instanceof Error ? error.message : "rb-codex app-server transport failed";
      const kind = name === "AbortError" ? "cancelled" : name === "TimeoutError" ? "timeout"
        : /^auth:/.test(message) ? "auth" : /^unsupported-capability:/.test(message) ? "unsupported-capability" : "transport";
      return { outcome: { ok: false, error: { kind, message: message.replace(/^(?:auth|unsupported-capability):\s*/, ""), transportRetryable: false } }, runtime: runtime.value, treeQuiescent: true, treeVerified: true };
    }
  }

  async request(profile: ModelProfile, auth: ResolvedProviderAuth, request: SemanticRequest): Promise<ProviderOutcome<CanonicalSemanticResponse>> {
    return (await this.requestWithRaw(profile, auth, request)).outcome;
  }
}

export const codexSubscriptionAdapter = new CodexSubscriptionAdapter();
