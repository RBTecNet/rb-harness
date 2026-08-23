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

export interface DirectProviderDefinition {
  id: DirectProviderId;
  label: string;
  dialect: ProviderDialect;
  endpoint: string;
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
    auth: [API_KEY],
  },
  {
    id: "anthropic",
    label: "Claude API (Anthropic)",
    dialect: "anthropic-messages",
    endpoint: "https://api.anthropic.com/v1/messages",
    auth: [API_KEY],
  },
  {
    id: "gemini",
    label: "Gemini API",
    dialect: "openai-chat",
    endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
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
    auth: [API_KEY],
  },
  {
    id: "minimax",
    label: "MiniMax API",
    dialect: "openai-chat",
    endpoint: "https://api.minimax.io/v1/chat/completions",
    auth: [API_KEY],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    dialect: "openai-chat",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
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
