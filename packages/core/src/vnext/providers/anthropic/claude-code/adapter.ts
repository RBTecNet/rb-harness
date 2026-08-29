import {
  type CanonicalSemanticResponse,
  type ModelProfile,
  type ProviderAdapter,
  type ProviderOutcome,
  type ProviderRuntimeObservation,
  type ResolvedProviderAuth,
  type SemanticRequest,
} from "../../contract.js";
import {
  decodeClaudeCodeStream,
  extractClaudeCodePayload,
  observeClaudeCode,
  type ClaudeCodeRawResponse,
} from "./normalize.js";
import {
  CLAUDE_CODE_EXECUTABLE,
  SpawnClaudeCodeProcess,
  claudeCodeChildEnvironment,
  withClaudeCodeIsolation,
  type ClaudeCodeProcess,
} from "./process.js";
import { CLAUDE_CODE_OPUS_5_PROFILE_ID, CLAUDE_CODE_PROFILES } from "./profiles.js";

export const CLAUDE_CODE_AMBIENT_AUTH_ID = "claude-code-subscription";

export interface ClaudeCodeRuntimePreflight {
  readonly transportVersion: string;
  readonly authMode: "subscription";
}

function unsupported(message: string): ProviderOutcome<never> {
  return { ok: false, error: { kind: "unsupported-capability", message, transportRetryable: false } };
}

export function preflightClaudeCode(profile: ModelProfile, request: SemanticRequest): ProviderOutcome<true> {
  if (profile.family !== "anthropic" || profile.transport !== "claude-code-cli") {
    return unsupported(`profile ${profile.id} is not an Anthropic Claude Code CLI profile`);
  }
  if (profile.id !== CLAUDE_CODE_OPUS_5_PROFILE_ID || profile.modelId !== "claude-opus-5") {
    return unsupported(`unknown Claude Code CLI profile: ${profile.id}`);
  }
  if (profile.structuredOutput !== "claude-code-json-schema") {
    return unsupported(`profile ${profile.id} does not declare Claude Code JSON Schema output`);
  }
  if (!Number.isInteger(request.limits.maxOutputTokens) || request.limits.maxOutputTokens < 1) {
    return unsupported("maxOutputTokens must be a positive integer");
  }
  if (request.limits.maxOutputTokens > profile.maxOutputTokens) {
    return unsupported(`requested output limit exceeds ${profile.id}'s ${profile.maxOutputTokens}-token capability`);
  }
  if (!Number.isFinite(request.limits.deadlineMs) || request.limits.deadlineMs <= 0) {
    return unsupported("deadlineMs must be positive");
  }
  if (request.reasoning.mode !== "on" || request.reasoning.effort !== "low") {
    return unsupported(`${profile.id} is conformed only for reasoning effort low`);
  }
  return { ok: true, value: true };
}

export function claudeCodeInvocationArgs(input: {
  readonly profile: ModelProfile;
  readonly request: SemanticRequest;
  readonly systemPromptFile: string;
}): string[] {
  return [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--safe-mode",
    "--restricted",
    "--setting-sources", "",
    "--strict-mcp-config",
    "--mcp-config", JSON.stringify({ mcpServers: {} }),
    "--tools", "",
    "--disallowedTools", "mcp__*",
    "--disable-slash-commands",
    "--no-chrome",
    "--no-session-persistence",
    "--prompt-suggestions", "false",
    "--max-turns", "1",
    "--model", input.profile.modelId,
    "--effort", input.request.reasoning.mode === "on" ? input.request.reasoning.effort : "low",
    "--system-prompt-file", input.systemPromptFile,
    "--json-schema", JSON.stringify(input.request.schema),
  ];
}

function parseVersion(stdout: string): string | undefined {
  const value = stdout.trim();
  return /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?(?: \(Claude Code\))?$/.test(value) ? value : undefined;
}

function parseSubscriptionAuth(stdout: string): ProviderOutcome<{ authMode: "subscription" }> {
  try {
    const status = JSON.parse(stdout) as Record<string, unknown>;
    const subscription = typeof status.subscriptionType === "string" && status.subscriptionType.trim().length > 0;
    if (status.loggedIn === true && status.authMethod === "claude.ai" && status.apiProvider === "firstParty" && subscription) {
      return { ok: true, value: { authMode: "subscription" } };
    }
    return { ok: false, error: { kind: "auth", message: "Claude Code is not authenticated through a first-party Claude subscription", transportRetryable: false } };
  } catch {
    return { ok: false, error: { kind: "malformed-syntax", message: "Claude Code auth status was not valid JSON", transportRetryable: false } };
  }
}

export interface ClaudeCodeRequestResult {
  readonly outcome: ProviderOutcome<CanonicalSemanticResponse>;
  readonly raw?: ClaudeCodeRawResponse;
  readonly treeQuiescent?: boolean;
  readonly treeVerified?: boolean;
}

export class ClaudeCodeAdapter implements ProviderAdapter {
  readonly family = "anthropic";
  readonly transport = "claude-code-cli" as const;
  readonly profiles = CLAUDE_CODE_PROFILES;
  private preflightPromise: Promise<ProviderOutcome<ClaudeCodeRuntimePreflight>> | undefined;
  private modelInvocationCount = 0;
  private runtimeCommandCount = 0;

  constructor(private readonly processRunner: ClaudeCodeProcess = new SpawnClaudeCodeProcess()) {}

  get modelInvocations(): number {
    return this.modelInvocationCount;
  }

  get runtimeCommands(): number {
    return this.runtimeCommandCount;
  }

  checkCapabilities(profile: ModelProfile, request: SemanticRequest): ProviderOutcome<true> {
    return preflightClaudeCode(profile, request);
  }

  replay(profile: ModelProfile, request: SemanticRequest, raw: unknown): ProviderOutcome<CanonicalSemanticResponse> {
    const preflight = preflightClaudeCode(profile, request);
    if (!preflight.ok) return preflight;
    if (!raw || typeof raw !== "object") {
      return { ok: false, error: { kind: "malformed-syntax", message: "recorded Claude Code response is not an object", transportRetryable: false } };
    }
    return extractClaudeCodePayload(profile, request, raw as ClaudeCodeRawResponse);
  }

  observeRuntime(raw: unknown): ProviderRuntimeObservation | undefined {
    if (!raw || typeof raw !== "object") return undefined;
    const response = raw as ClaudeCodeRawResponse;
    if (!Array.isArray(response.events)) return undefined;
    const observation = observeClaudeCode(response);
    return {
      ...(observation.numTurns === undefined ? {} : { numTurns: observation.numTurns }),
      assistantMessageIds: observation.assistantStepIds,
      modelIds: observation.modelIds,
      declaredTools: observation.tools,
      usedTools: observation.toolUses,
      mcpServers: observation.mcpServers,
      ...(observation.resultSubtype === undefined ? {} : { resultSubtype: observation.resultSubtype }),
      structuredOutputPresent: observation.hasStructuredOutput,
      ...(observation.subagentsSpawned === undefined ? {} : { subagentsSpawned: observation.subagentsSpawned }),
      streamComplete: response.streamComplete,
      treeQuiescent: response.treeQuiescent,
      treeVerified: response.treeVerified,
    };
  }

  async runtimePreflight(): Promise<ProviderOutcome<ClaudeCodeRuntimePreflight>> {
    this.preflightPromise ??= this.performRuntimePreflight();
    return this.preflightPromise;
  }

  private async performRuntimePreflight(): Promise<ProviderOutcome<ClaudeCodeRuntimePreflight>> {
    return withClaudeCodeIsolation("", async ({ cwd }) => {
      const signal = new AbortController().signal;
      const env = claudeCodeChildEnvironment();
      this.runtimeCommandCount += 1;
      const version = await this.processRunner.run({ args: ["--version"], stdin: "", cwd, env, signal, deadlineMs: 10_000 });
      if (version.exitCode !== 0 || !version.settlement.quiescent) {
        return unsupported(`${CLAUDE_CODE_EXECUTABLE} executable/version preflight failed`);
      }
      const transportVersion = parseVersion(version.stdout);
      if (!transportVersion) return unsupported("Claude Code returned an unrecognized version string");

      this.runtimeCommandCount += 1;
      const auth = await this.processRunner.run({ args: ["auth", "status", "--json"], stdin: "", cwd, env, signal, deadlineMs: 10_000 });
      if (auth.exitCode !== 0 || !auth.settlement.quiescent) {
        return { ok: false, error: { kind: "auth", message: "Claude Code auth status preflight failed", transportRetryable: false } };
      }
      const classified = parseSubscriptionAuth(auth.stdout);
      if (!classified.ok) return classified;
      return { ok: true, value: { transportVersion, authMode: classified.value.authMode } };
    });
  }

  async requestWithRaw(
    profile: ModelProfile,
    auth: ResolvedProviderAuth,
    request: SemanticRequest,
  ): Promise<ClaudeCodeRequestResult> {
    const capabilities = preflightClaudeCode(profile, request);
    if (!capabilities.ok) return { outcome: capabilities };
    if (auth.kind !== "ambient-session" || auth.id !== CLAUDE_CODE_AMBIENT_AUTH_ID) {
      return { outcome: { ok: false, error: { kind: "auth", message: "Claude Code CLI requires its ambient authenticated subscription session", transportRetryable: false } } };
    }
    if (request.signal.aborted) {
      return { outcome: { ok: false, error: { kind: "cancelled", message: "Claude Code request was cancelled before transport", transportRetryable: false } } };
    }
    const runtime = await this.runtimePreflight();
    if (!runtime.ok) return { outcome: runtime };
    if (request.signal.aborted) {
      return { outcome: { ok: false, error: { kind: "cancelled", message: "Claude Code request was cancelled during runtime preflight", transportRetryable: false } } };
    }

    return withClaudeCodeIsolation(request.instructions, async ({ cwd, systemPromptFile }) => {
      this.modelInvocationCount += 1;
      const processResult = await this.processRunner.run({
        args: claudeCodeInvocationArgs({ profile, request, systemPromptFile }),
        stdin: request.input,
        cwd,
        env: claudeCodeChildEnvironment(process.env, request.limits.maxOutputTokens),
        signal: request.signal,
        deadlineMs: request.limits.deadlineMs,
      });
      if (processResult.timedOut) {
        return {
          outcome: { ok: false, error: { kind: "timeout", message: "Claude Code request exceeded its deadline", transportRetryable: true } },
          treeQuiescent: processResult.settlement.quiescent,
          treeVerified: processResult.settlement.verified,
        };
      }
      if (processResult.cancelled || request.signal.aborted) {
        return {
          outcome: { ok: false, error: { kind: "cancelled", message: "Claude Code request was cancelled", transportRetryable: false } },
          treeQuiescent: processResult.settlement.quiescent,
          treeVerified: processResult.settlement.verified,
        };
      }
      const decoded = decodeClaudeCodeStream(processResult);
      if (!decoded.ok) return { outcome: decoded };
      return {
        raw: decoded.value,
        outcome: extractClaudeCodePayload(profile, request, decoded.value),
        treeQuiescent: processResult.settlement.quiescent,
        treeVerified: processResult.settlement.verified,
      };
    });
  }

  async request(
    profile: ModelProfile,
    auth: ResolvedProviderAuth,
    request: SemanticRequest,
  ): Promise<ProviderOutcome<CanonicalSemanticResponse>> {
    return (await this.requestWithRaw(profile, auth, request)).outcome;
  }
}

export const claudeCodeAdapter = new ClaudeCodeAdapter();
