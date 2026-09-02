import type { ModelProfile } from "../contract.js";
import { CONFORMANCE_SUITE_VERSION } from "../conformance/suite.js";
import {
  OPEN_CODE_COMPATIBILITY,
  OPEN_CODE_SERVICES,
  openCodeCliSelector,
  type OpenCodeProtocol,
  type OpenCodeService,
} from "./catalog.js";

export const OPENCODE_CLI_PROFILE_PREFIX = "opencode:cli:";

function unavailable(reason: string): ModelProfile["conformance"] {
  return {
    tier: "UNSUPPORTED",
    suiteVersion: CONFORMANCE_SUITE_VERSION,
    runId: null,
    recordedAt: null,
    normalizationsOnHappyPath: [],
    verifiedRecord: false,
    reason,
  };
}

export interface OpenCodeProfileConfiguration {
  readonly mode: "cli" | "api";
  readonly service?: OpenCodeService;
  readonly protocol?: OpenCodeProtocol;
  readonly credentialNamespace?: "opencode-go" | "opencode-zen";
  readonly modelSelector: string;
}

function validateSelector(selector: string): string {
  if (selector !== selector.trim() || !/^[A-Za-z0-9][A-Za-z0-9._+-]*\/[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(selector)) {
    throw new Error("OpenCode CLI model selector must use the exact provider/model form");
  }
  if (/\bsk-[A-Za-z0-9_-]{12,}\b/i.test(selector)) throw new Error("OpenCode CLI model selector resembles credential material");
  return selector;
}

export function openCodeCliProfileId(selector: string): string {
  return `${OPENCODE_CLI_PROFILE_PREFIX}${validateSelector(selector)}`;
}

export function createOpenCodeCliProfile(selector: string): ModelProfile {
  const exact = validateSelector(selector);
  return Object.freeze({
    id: openCodeCliProfileId(exact),
    family: "opencode",
    transport: "opencode-cli",
    requestAccounting: "opaque",
    modelId: exact,
    label: `${exact} via OpenCode CLI`,
    runtime: { kind: "external-executable", versionPolicy: "exact-recorded" } as const,
    structuredOutput: "json-mode",
    strictSchema: false,
    toolCalling: false,
    toolChoiceForcing: false,
    reasoning: { supported: true, defaultMode: "on", efforts: ["low"], reportsReasoningTokens: false } as const,
    maxOutputTokens: 32_768,
    systemRole: "none",
    streaming: { supported: true, usageInStream: true },
    usageReporting: {
      inputTokens: true,
      cachedInputTokens: false,
      cacheWriteTokens: false,
      outputTokens: true,
      reasoningTokens: false,
      costUsd: false,
    },
    conformance: unavailable("no verified current-version OpenCode CLI conformance record is loaded"),
  });
}

function apiProfile(service: OpenCodeService, modelId: string, protocol: OpenCodeProtocol): ModelProfile {
  const structuredOutput = protocol === "anthropic-messages" ? "forced-tool-argument"
    : protocol === "openai-responses" ? "json-schema" : "json-mode";
  return Object.freeze({
    id: `opencode:${service}:${modelId}`,
    family: "opencode",
    transport: "direct-api",
    requestAccounting: "exact",
    modelId,
    label: `${modelId} via ${OPEN_CODE_SERVICES[service].label}`,
    runtime: { kind: "built-in" } as const,
    structuredOutput,
    strictSchema: false,
    toolCalling: protocol === "anthropic-messages",
    toolChoiceForcing: protocol === "anthropic-messages",
    reasoning: { supported: true, defaultMode: "on", efforts: ["low"], reportsReasoningTokens: false } as const,
    maxOutputTokens: 32_768,
    systemRole: protocol === "openai-chat" ? "system" : "top-level-system",
    streaming: { supported: true, usageInStream: true },
    usageReporting: {
      inputTokens: true,
      cachedInputTokens: false,
      cacheWriteTokens: false,
      outputTokens: true,
      reasoningTokens: false,
      costUsd: false,
    },
    conformance: unavailable(`no verified current-suite OpenCode ${service} conformance record is loaded`),
  });
}

const supportedEntries = OPEN_CODE_COMPATIBILITY.filter((entry): entry is typeof entry & { protocol: OpenCodeProtocol } => (
  entry.supported && entry.protocol !== "google" && entry.protocol !== "unknown"
));

export const OPENCODE_API_PROFILES: readonly ModelProfile[] = Object.freeze(
  supportedEntries.map((entry) => apiProfile(entry.service, entry.modelId, entry.protocol)),
);

export const OPENCODE_CLI_PROFILES: readonly ModelProfile[] = Object.freeze(
  supportedEntries.map((entry) => createOpenCodeCliProfile(openCodeCliSelector(entry.service, entry.modelId))),
);

export const OPENCODE_PROFILES: readonly ModelProfile[] = Object.freeze([
  ...OPENCODE_CLI_PROFILES,
  ...OPENCODE_API_PROFILES,
]);

const configurationByProfile = new Map<string, OpenCodeProfileConfiguration>();
for (const entry of supportedEntries) {
  const api = apiProfile(entry.service, entry.modelId, entry.protocol);
  configurationByProfile.set(api.id, {
    mode: "api",
    service: entry.service,
    protocol: entry.protocol,
    credentialNamespace: OPEN_CODE_SERVICES[entry.service].credentialNamespace,
    modelSelector: entry.modelId,
  });
  const selector = openCodeCliSelector(entry.service, entry.modelId);
  configurationByProfile.set(openCodeCliProfileId(selector), { mode: "cli", modelSelector: selector });
}

export function openCodeProfileConfiguration(profile: ModelProfile): OpenCodeProfileConfiguration | undefined {
  const declared = configurationByProfile.get(profile.id);
  if (declared && profile.modelId === declared.modelSelector) return declared;
  if (profile.id.startsWith(OPENCODE_CLI_PROFILE_PREFIX) && profile.transport === "opencode-cli" && profile.family === "opencode") {
    const selector = profile.id.slice(OPENCODE_CLI_PROFILE_PREFIX.length);
    if (profile.modelId === selector) return { mode: "cli", modelSelector: validateSelector(selector) };
  }
  return undefined;
}

export function resolveOpenCodeDynamicProfile(profileId: string): ModelProfile | undefined {
  const declared = OPENCODE_PROFILES.find((profile) => profile.id === profileId);
  if (declared) return declared;
  if (!profileId.startsWith(OPENCODE_CLI_PROFILE_PREFIX)) return undefined;
  return createOpenCodeCliProfile(profileId.slice(OPENCODE_CLI_PROFILE_PREFIX.length));
}
