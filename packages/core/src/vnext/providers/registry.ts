import type { ModelProfile, ProviderAdapter } from "./contract.js";
import { anthropicAdapter } from "./anthropic/adapter.js";
import { recordAnthropicConformance } from "./anthropic/record.js";
import { resolveCredential } from "../../credential-store.js";
import { readConformanceRecord, type ConformanceRecord } from "./conformance/recording.js";
import type { ResolvedProviderCredential } from "./contract.js";
import { CONFORMANCE_CASES } from "./conformance/fixtures.js";
import { validateConformanceRecord } from "./conformance/runner.js";

export class ProviderRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderRegistryError";
  }
}

const ADAPTERS: readonly ProviderAdapter[] = [anthropicAdapter];

export function listProviderProfiles(): readonly ModelProfile[] {
  return ADAPTERS.flatMap((adapter) => adapter.profiles);
}

export function resolveProviderProfile(profileId: string, family?: string): ModelProfile {
  const matches = listProviderProfiles().filter((profile) => profile.id === profileId);
  if (matches.length !== 1) throw new ProviderRegistryError(`unknown provider profile: ${profileId}`);
  const profile = matches[0]!;
  if (family !== undefined && profile.family !== family) {
    throw new ProviderRegistryError(`profile ${profileId} belongs to ${profile.family}, not ${family}`);
  }
  return profile;
}

export function resolveProviderAdapter(profileId: string, family?: string): ProviderAdapter {
  const profile = resolveProviderProfile(profileId, family);
  const adapter = ADAPTERS.find((candidate) => candidate.family === profile.family);
  if (!adapter) throw new ProviderRegistryError(`no adapter is registered for profile ${profileId}`);
  return adapter;
}

export async function resolveProviderCredential(profile: ModelProfile, selector?: string): Promise<ResolvedProviderCredential> {
  if (profile.family !== "anthropic") throw new ProviderRegistryError(`credential resolution is not registered for family ${profile.family}`);
  const resolved = await resolveCredential("anthropic", selector);
  if (!resolved.secret) throw new ProviderRegistryError(`credential ${resolved.record.id} has no direct API secret`);
  return {
    id: resolved.record.id,
    secret: resolved.secret,
    attributes: Object.freeze({ ...(resolved.record.attributes ?? {}) }),
  };
}

export async function recordProviderConformance(
  profile: ModelProfile,
  credential: ResolvedProviderCredential,
): Promise<{ readonly record: ConformanceRecord; readonly providerRequests: number }> {
  if (profile.family === "anthropic") return recordAnthropicConformance(profile, credential);
  throw new ProviderRegistryError(`live conformance recording is not registered for family ${profile.family}`);
}

/** Load support only from a current, attributable, integrity-checked runner record. */
export async function loadVerifiedProviderProfile(profileId: string, recordsRoot: string): Promise<ModelProfile> {
  const profile = resolveProviderProfile(profileId);
  const adapter = resolveProviderAdapter(profileId);
  const record = await readConformanceRecord(recordsRoot, profileId);
  const result = validateConformanceRecord({ adapter, profile, cases: CONFORMANCE_CASES, record });
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
  };
}
