export const CLI_PROVIDER_IDS = ["codex", "claude", "opencode", "custom"] as const;
export const DIRECT_PROVIDER_IDS = ["openai", "anthropic", "gemini", "deepseek", "minimax", "openrouter"] as const;

export type CliProviderId = typeof CLI_PROVIDER_IDS[number];
export type DirectProviderId = typeof DIRECT_PROVIDER_IDS[number];
export type ProviderId = CliProviderId | DirectProviderId;
export type AuthProtocol = "api-key" | "oauth-pkce" | "google-adc";
export type ProviderDialect = "openai-chat" | "anthropic-messages";

export interface ProviderAuthProtocol {
  id: AuthProtocol;
  label: string;
  description: string;
}

/**
 * How a direct provider streams, declared once per provider instead of being
 * inferred from its id at each call site.
 */
export interface DirectProviderStreaming {
  /** The provider serves the dialect's documented incremental protocol. */
  supported: boolean;
  /**
   * The provider documents `stream_options: { include_usage: true }`. Where it
   * does not, usage simply stays unmeasured — it is never guessed.
   */
  usageOption: boolean;
}

/**
 * How a provider is told whether to reason at all, and how hard.
 *
 * A provider that offers reasoning as a separate, billable mode needs two
 * independent decisions: whether thinking happens, and — only if it does — at
 * what intensity. Conflating them is what let RB Harness silently enable
 * high-intensity reasoning: a run with no `--effort` inherited the provider's
 * own default, and a model spent its entire output allowance on
 * `reasoning_content` without ever emitting a document.
 *
 * The toggle and the intensity are therefore declared here, per provider, and
 * the runtime asks the registry instead of testing an id at the call site.
 */
export type ReasoningProtocol = "thinking-toggle";

export interface DirectProviderReasoning {
  protocol: ReasoningProtocol;
  /** What an omitted `--effort` means. The economical answer is `disabled`. */
  defaultMode: "disabled" | "enabled";
  /** The effort value that turns reasoning off; it carries no intensity. */
  disabledEffort: string;
  /** Efforts that turn reasoning on, in increasing intensity. */
  supportedEfforts: readonly string[];
  /** Intensity used when `defaultMode` is `enabled` and no effort is given. */
  defaultEffort?: string;
}

/** The decision the registry makes for one request. */
export interface ReasoningDecision {
  /** Whether the provider was asked to reason. */
  enabled: boolean;
  /** The intensity actually sent, when one was. */
  effort?: string;
  /** Fields merged into the completion body. */
  fields: Record<string, unknown>;
  /** One honest sentence for the log and the help text. */
  description: string;
}

export interface DirectProviderDefinition {
  id: DirectProviderId;
  label: string;
  dialect: ProviderDialect;
  endpoint: string;
  streaming: DirectProviderStreaming;
  /**
   * Whether the provider exposes reasoning as an explicit mode. Providers that
   * declare nothing here keep their previous behaviour untouched.
   */
  reasoning?: DirectProviderReasoning;
  /** Provider-specific request fields merged into every completion body. */
  requestExtensions?: Record<string, unknown>;
  /** Provider-specific headers merged into every request. */
  headers?: Record<string, string>;
  auth: ProviderAuthProtocol[];
}

const API_KEY: ProviderAuthProtocol = {
  id: "api-key",
  label: "API key",
  description: "Cole uma chave; ela não aparece no terminal nem é gravada em argumentos, logs ou perfis.",
};

export const DIRECT_PROVIDERS: readonly DirectProviderDefinition[] = [
  {
    id: "openai",
    label: "OpenAI API",
    dialect: "openai-chat",
    endpoint: "https://api.openai.com/v1/chat/completions",
    streaming: { supported: true, usageOption: true },
    auth: [API_KEY],
  },
  {
    id: "anthropic",
    label: "Claude API (Anthropic)",
    dialect: "anthropic-messages",
    endpoint: "https://api.anthropic.com/v1/messages",
    streaming: { supported: true, usageOption: false },
    auth: [API_KEY],
  },
  {
    id: "gemini",
    label: "Gemini API",
    dialect: "openai-chat",
    endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    // The OpenAI compatibility endpoint streams, but does not document
    // `stream_options`; usage therefore stays unmeasured rather than guessed.
    streaming: { supported: true, usageOption: false },
    auth: [
      API_KEY,
      {
        id: "google-adc",
        label: "OAuth 2.0 (Google ADC)",
        description: "Usa um OAuth Client desktop e o gcloud para abrir o login no navegador.",
      },
    ],
  },
  {
    id: "deepseek",
    label: "DeepSeek API",
    dialect: "openai-chat",
    endpoint: "https://api.deepseek.com/chat/completions",
    streaming: { supported: true, usageOption: true },
    // DeepSeek Chat Completions gates reasoning behind an explicit toggle. The
    // Harness defaults it off: reasoning is a deliberate, costlier choice, and
    // an omitted `--effort` must never buy it silently.
    reasoning: {
      protocol: "thinking-toggle",
      defaultMode: "disabled",
      disabledEffort: "none",
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
    },
    auth: [API_KEY],
  },
  {
    id: "minimax",
    label: "MiniMax API",
    dialect: "openai-chat",
    endpoint: "https://api.minimax.io/v1/chat/completions",
    streaming: { supported: true, usageOption: true },
    auth: [API_KEY],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    dialect: "openai-chat",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    streaming: { supported: true, usageOption: true },
    headers: {
      "http-referer": "https://github.com/RBTecNet/rb-harness",
      "x-openrouter-title": "RB Harness / RB Ralph",
    },
    auth: [
      API_KEY,
      {
        id: "oauth-pkce",
        label: "OAuth 2.0 + PKCE",
        description: "Abre o OpenRouter no navegador e provisiona uma chave controlada pelo usuário.",
      },
    ],
  },
] as const;

export function isCliProvider(value: string): value is CliProviderId {
  return (CLI_PROVIDER_IDS as readonly string[]).includes(value);
}

export function isDirectProvider(value: string): value is DirectProviderId {
  return (DIRECT_PROVIDER_IDS as readonly string[]).includes(value);
}

export function directProvider(value: string): DirectProviderDefinition {
  const definition = DIRECT_PROVIDERS.find((entry) => entry.id === value);
  if (!definition) throw new Error(`unsupported direct API provider: ${value}`);
  return definition;
}

export const PROVIDER_HELP = [...CLI_PROVIDER_IDS, ...DIRECT_PROVIDER_IDS].join(", ");

/**
 * The reasoning fields for one request, decided from the declared capability.
 *
 * An unrecognised effort throws, and it throws here — before any credential is
 * read and before any socket is opened — because a request that was going to be
 * refused, or silently promoted to a more expensive mode, must not be paid for.
 */
export function reasoningRequestFields(
  definition: DirectProviderDefinition,
  effort: string | undefined,
): ReasoningDecision {
  const requested = (effort ?? "").trim();
  const declared = definition.reasoning;
  if (!declared) {
    // No declared capability: the provider keeps exactly the request it got
    // before this capability existed.
    if (!requested) return { enabled: false, fields: {}, description: "provider default" };
    return definition.dialect === "anthropic-messages"
      ? { enabled: true, effort: requested, fields: { output_config: { effort: requested } }, description: `effort ${requested}` }
      : { enabled: true, effort: requested, fields: { reasoning_effort: requested }, description: `effort ${requested}` };
  }
  const accepted = [declared.disabledEffort, ...declared.supportedEfforts];
  const value = requested
    || (declared.defaultMode === "disabled" ? declared.disabledEffort : declared.defaultEffort ?? "");
  if (!accepted.includes(value)) {
    throw new Error(
      `provider ${definition.id} does not accept --effort "${requested}"; `
      + `accepted values are ${accepted.join(", ")}. No request was started and nothing was charged.`,
    );
  }
  if (value === declared.disabledEffort) {
    // The toggle owns the shutdown. Sending an intensity of "none" alongside it
    // would be a second, contradictory statement of the same decision.
    return {
      enabled: false,
      fields: { thinking: { type: "disabled" } },
      description: requested ? `reasoning disabled by --effort ${requested}` : "reasoning disabled by default",
    };
  }
  return {
    enabled: true,
    effort: value,
    fields: { thinking: { type: "enabled" }, reasoning_effort: value },
    description: `reasoning enabled at ${value}`,
  };
}

/** Efforts a provider accepts, for help text and error messages. */
export function acceptedEfforts(definition: DirectProviderDefinition): readonly string[] | undefined {
  const declared = definition.reasoning;
  return declared ? [declared.disabledEffort, ...declared.supportedEfforts] : undefined;
}
