import { measured, type Measured, type ModelProfile, type ProviderAdapter, type ResolvedProviderAuth } from "./contract.js";
import { anthropicAdapter } from "./anthropic/adapter.js";
import { recordAnthropicConformance } from "./anthropic/record.js";
import { CLAUDE_CODE_AMBIENT_AUTH_ID, claudeCodeAdapter } from "./anthropic/claude-code/adapter.js";
import { CLAUDE_CODE_CONFORMANCE_CASES } from "./anthropic/claude-code/fixtures.js";
import { recordClaudeCodeConformance } from "./anthropic/claude-code/record.js";
import { resolveCredential } from "../../credential-store.js";
import { readConformanceRecord, type ConformanceRecord } from "./conformance/recording.js";
import type { ResolvedProviderCredential } from "./contract.js";
import { CONFORMANCE_CASES } from "./conformance/fixtures.js";
import { validateConformanceRecord } from "./conformance/runner.js";
import type { ConformanceCase } from "./conformance/suite.js";
import { CLAUDE_CODE_TRANSPORT_PROFILE_ID } from "./anthropic/claude-code/runtime-model.js";
import { deepSeekAdapter } from "./deepseek/adapter.js";
import { recordDeepSeekConformance } from "./deepseek/record.js";
import { openCodeApiAdapter } from "./opencode/api-adapter.js";
import { OPENCODE_AMBIENT_AUTH_ID, openCodeCliAdapter } from "./opencode/cli-adapter.js";
import { OPENCODE_CLI_CONFORMANCE_CASES } from "./opencode/cli-fixtures.js";
import { OPEN_CODE_SERVICES } from "./opencode/catalog.js";
import { resolveOpenCodeDynamicProfile, openCodeProfileConfiguration } from "./opencode/profiles.js";
import { recordOpenCodeApiConformance } from "./opencode/api-record.js";
import { recordOpenCodeCliConformance } from "./opencode/cli-record.js";
import { openAiAdapter } from "./openai/adapter.js";
import { recordOpenAiConformance } from "./openai/record.js";

export class ProviderRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderRegistryError";
  }
}

const ADAPTERS: readonly ProviderAdapter[] = [
  anthropicAdapter,
  claudeCodeAdapter,
  deepSeekAdapter,
  openCodeApiAdapter,
  openCodeCliAdapter,
  openAiAdapter,
];

export function listProviderProfiles(): readonly ModelProfile[] {
  return ADAPTERS.flatMap((adapter) => adapter.profiles);
}

export function resolveProviderProfile(profileId: string, family?: string): ModelProfile {
  const dynamic = resolveOpenCodeDynamicProfile(profileId);
  const matches = dynamic ? [dynamic] : listProviderProfiles().filter((profile) => profile.id === profileId);
  if (matches.length !== 1) throw new ProviderRegistryError(`unknown provider profile: ${profileId}`);
  const profile = matches[0]!;
  if (family !== undefined && profile.family !== family) {
    throw new ProviderRegistryError(`profile ${profileId} belongs to ${profile.family}, not ${family}`);
  }
  return profile;
}

export function resolveProviderAdapter(profileId: string, family?: string): ProviderAdapter {
  if (profileId === CLAUDE_CODE_TRANSPORT_PROFILE_ID) {
    if (family !== undefined && family !== "anthropic") {
      throw new ProviderRegistryError(`profile ${profileId} belongs to anthropic, not ${family}`);
    }
    return claudeCodeAdapter;
  }
  const profile = resolveProviderProfile(profileId, family);
  const adapter = ADAPTERS.find((candidate) => candidate.family === profile.family && candidate.transport === profile.transport);
  if (!adapter) throw new ProviderRegistryError(`no adapter is registered for profile ${profileId}`);
  return adapter;
}

export function resolveProviderConformanceCases(profileId: string): readonly ConformanceCase[] {
  const profile = resolveProviderProfile(profileId);
  return profile.transport === "claude-code-cli" ? CLAUDE_CODE_CONFORMANCE_CASES
    : profile.transport === "opencode-cli" ? OPENCODE_CLI_CONFORMANCE_CASES : CONFORMANCE_CASES;
}

export async function resolveProviderCredential(profile: ModelProfile, selector?: string): Promise<ResolvedProviderCredential> {
  if (profile.transport !== "direct-api") throw new ProviderRegistryError(`profile ${profile.id} does not use a vault credential`);
  if (profile.family === "opencode") {
    const config = openCodeProfileConfiguration(profile);
    if (!config || config.mode !== "api" || !config.service) throw new ProviderRegistryError(`credential resolution is not registered for ${profile.id}`);
    const resolved = await resolveCredential(OPEN_CODE_SERVICES[config.service].credentialNamespace, selector);
    if (!resolved.secret) throw new ProviderRegistryError(`credential ${resolved.record.id} has no OpenCode API secret`);
    return { id: resolved.record.id, secret: resolved.secret, attributes: Object.freeze({ ...(resolved.record.attributes ?? {}) }) };
  }
  if (profile.family !== "anthropic" && profile.family !== "deepseek" && profile.family !== "openai") {
    throw new ProviderRegistryError(`credential resolution is not registered for family ${profile.family}`);
  }
  const resolved = await resolveCredential(profile.family, selector);
  if (!resolved.secret) throw new ProviderRegistryError(`credential ${resolved.record.id} has no direct API secret`);
  return {
    id: resolved.record.id,
    secret: resolved.secret,
    attributes: Object.freeze({ ...(resolved.record.attributes ?? {}) }),
  };
}

export async function resolveProviderAuth(profile: ModelProfile, selector?: string): Promise<ResolvedProviderAuth> {
  if (profile.transport === "claude-code-cli") {
    if (selector) throw new ProviderRegistryError(`--credential is not accepted for ambient-session profile ${profile.id}`);
    return { kind: "ambient-session", id: CLAUDE_CODE_AMBIENT_AUTH_ID };
  }
  if (profile.transport === "opencode-cli") {
    if (selector) throw new ProviderRegistryError(`--credential is not accepted for ambient-session profile ${profile.id}`);
    return { kind: "ambient-session", id: OPENCODE_AMBIENT_AUTH_ID };
  }
  return { kind: "credential", credential: await resolveProviderCredential(profile, selector) };
}

export async function recordProviderConformance(
  profile: ModelProfile,
  auth: ResolvedProviderAuth,
): Promise<{ readonly record: ConformanceRecord; readonly providerRequests: Measured<number>; readonly transportInvocations: number }> {
  if (profile.family === "anthropic" && profile.transport === "direct-api") {
    if (auth.kind !== "credential") throw new ProviderRegistryError(`profile ${profile.id} requires a vault credential`);
    const direct = await recordAnthropicConformance(profile, auth.credential);
    return { record: direct.record, providerRequests: measured(direct.providerRequests), transportInvocations: direct.providerRequests };
  }
  if (profile.family === "deepseek" && profile.transport === "direct-api") {
    if (auth.kind !== "credential") throw new ProviderRegistryError(`profile ${profile.id} requires a vault credential`);
    const direct = await recordDeepSeekConformance(profile, auth.credential);
    return { record: direct.record, providerRequests: measured(direct.providerRequests), transportInvocations: direct.providerRequests };
  }
  if (profile.family === "openai" && profile.transport === "direct-api") {
    if (auth.kind !== "credential") throw new ProviderRegistryError(`profile ${profile.id} requires a vault credential`);
    const direct = await recordOpenAiConformance(profile, auth.credential);
    return { record: direct.record, providerRequests: measured(direct.providerRequests), transportInvocations: direct.providerRequests };
  }
  if (profile.family === "anthropic" && profile.transport === "claude-code-cli") {
    if (auth.kind !== "ambient-session") throw new ProviderRegistryError(`profile ${profile.id} requires an ambient Claude Code session`);
    return recordClaudeCodeConformance(profile, auth);
  }
  if (profile.family === "opencode" && profile.transport === "direct-api") {
    if (auth.kind !== "credential") throw new ProviderRegistryError(`profile ${profile.id} requires a vault credential`);
    const direct = await recordOpenCodeApiConformance(profile, auth.credential);
    return { record: direct.record, providerRequests: measured(direct.providerRequests), transportInvocations: direct.providerRequests };
  }
  if (profile.family === "opencode" && profile.transport === "opencode-cli") {
    if (auth.kind !== "ambient-session") throw new ProviderRegistryError(`profile ${profile.id} requires an ambient OpenCode session`);
    const cli = await recordOpenCodeCliConformance(profile, auth);
    return { record: cli.record, providerRequests: { measured: false, reason: "unsupported-by-provider" }, transportInvocations: cli.transportInvocations };
  }
  throw new ProviderRegistryError(`live conformance recording is not registered for ${profile.family}/${profile.transport}`);
}

export function assertProviderRuntimeVersion(profile: ModelProfile, record: ConformanceRecord, observedVersion: string): void {
  if (profile.runtime.kind !== "external-executable") return;
  if (observedVersion !== record.transportVersion) {
    throw new ProviderRegistryError(`external transport version '${observedVersion}' does not match conformed version '${String(record.transportVersion)}'`);
  }
}

/** Load support only from a current, attributable, integrity-checked runner record. */
export async function loadVerifiedProviderProfile(profileId: string, recordsRoot: string): Promise<ModelProfile> {
  const profile = resolveProviderProfile(profileId);
  const adapter = resolveProviderAdapter(profileId);
  const record = await readConformanceRecord(recordsRoot, profileId);
  const result = validateConformanceRecord({ adapter, profile, cases: resolveProviderConformanceCases(profileId), record });
  if ((profile.transport === "claude-code-cli" || profile.transport === "opencode-cli") && result.tier !== "UNSUPPORTED") {
    const runtime = profile.transport === "claude-code-cli" ? await claudeCodeAdapter.runtimePreflight() : await openCodeCliAdapter.runtimePreflight();
    if (!runtime.ok) throw new ProviderRegistryError(runtime.error.message);
    assertProviderRuntimeVersion(profile, record, runtime.value.transportVersion);
  }
  return {
    ...profile,
    conformance: {
      tier: result.tier,
      suiteVersion: result.suiteVersion,
      runId: result.runId,
      recordedAt: result.recordedAt,
      normalizationsOnHappyPath: result.normalizationsOnHappyPath,
      verifiedRecord: true,
    },
    ...(profile.transport === "claude-code-cli" || profile.transport === "opencode-cli" ? {
      runtimeModel: {
        transportProfileId: profile.transport === "claude-code-cli" ? CLAUDE_CODE_TRANSPORT_PROFILE_ID : profile.id,
        transportVersion: record.transportVersion!,
        requestedModel: profile.modelId,
        selectorKind: "exact" as const,
        resolvedModel: profile.modelId,
        compatibilityEvidenceId: `packaged:${record.integritySha256}`,
        compatibilityEvidenceSha256: record.integritySha256,
        compatibilitySource: "packaged" as const,
      },
    } : {}),
  };
}
