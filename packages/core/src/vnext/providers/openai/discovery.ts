export const OPENAI_MODELS_ENDPOINT = "https://api.openai.com/v1/models";

export interface OpenAiDiscoveryTransport {
  get(input: {
    readonly endpoint: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly signal: AbortSignal;
  }): Promise<{ readonly status: number; readonly body: string }>;
}

export class FetchOpenAiDiscoveryTransport implements OpenAiDiscoveryTransport {
  async get(input: {
    readonly endpoint: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly signal: AbortSignal;
  }): Promise<{ readonly status: number; readonly body: string }> {
    const response = await fetch(input.endpoint, { method: "GET", headers: input.headers, signal: input.signal });
    return { status: response.status, body: await response.text() };
  }
}

function safeModelId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value);
}

/** Explicit lazy discovery. Returned IDs are availability facts, never support claims. */
export async function discoverOpenAiModels(
  secret: string,
  signal: AbortSignal,
  transport: OpenAiDiscoveryTransport = new FetchOpenAiDiscoveryTransport(),
): Promise<readonly string[]> {
  const response = await transport.get({
    endpoint: OPENAI_MODELS_ENDPOINT,
    headers: { authorization: `Bearer ${secret}`, accept: "application/json" },
    signal,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`OpenAI model discovery failed with HTTP ${response.status}`);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(response.body); } catch { throw new Error("OpenAI model discovery returned malformed JSON"); }
  const data = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>).data
    : undefined;
  if (!Array.isArray(data)) throw new Error("OpenAI model discovery omitted its data array");
  const ids = data.map((entry) => (
    entry !== null && typeof entry === "object" && !Array.isArray(entry)
      ? (entry as Record<string, unknown>).id
      : undefined
  )).filter(safeModelId);
  return [...new Set(ids)].sort();
}
