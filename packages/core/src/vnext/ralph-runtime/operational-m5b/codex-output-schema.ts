import { canonicalJson } from "../canonical-json.js";
import { sha256 } from "../hashing.js";
import { assertNoCredentialMaterial, RalphCredentialSafetyError } from "../operational-b1/secret-safety.js";
import { M5B_LIMITS_V2, RalphM5BError } from "./contract.js";

/**
 * The provider's structured result is deliberately minimal and carries NO
 * semantic authority: the model never decides success, Validation, Findings,
 * Task completion or Run completion.  Physical success is derived from the
 * process, the staging delta, the publication and quiescence.
 */
export const CODEX_PROVIDER_OUTPUT_SCHEMA_V2 = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["summary"],
  properties: Object.freeze({
    summary: Object.freeze({
      type: "string",
      minLength: 1,
      maxLength: M5B_LIMITS_V2.providerSummaryMaxChars,
      description: "One bounded sentence describing what was changed in the working directory.",
    }),
  }),
});

export function codexProviderOutputSchemaJsonV2(): string {
  return `${JSON.stringify(CODEX_PROVIDER_OUTPUT_SCHEMA_V2, null, 2)}\n`;
}

export interface CodexProviderStructuredResultV2 {
  readonly summary: string;
  readonly canonicalJson: string;
  readonly resultDigest: string;
}

/**
 * Validate the `-o` final output locally.  Unknown fields, malformed JSON,
 * oversized payloads and credential-like text are all refused.
 */
export function validateExactCodexProviderOutputV2(raw: string): CodexProviderStructuredResultV2 {
  if (typeof raw !== "string") throw new RalphM5BError("M5B_PROVIDER_RESULT_INVALID");
  if (Buffer.byteLength(raw, "utf8") > M5B_LIMITS_V2.providerOutputMaxBytes) throw new RalphM5BError("M5B_PROVIDER_OUTPUT_LIMIT");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (error) { throw new RalphM5BError("M5B_PROVIDER_RESULT_INVALID", "M5B_PROVIDER_RESULT_INVALID: malformed JSON", error); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new RalphM5BError("M5B_PROVIDER_RESULT_INVALID", "M5B_PROVIDER_RESULT_INVALID: not an object");
  const record = parsed as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => key !== "summary");
  if (unknown.length > 0) throw new RalphM5BError("M5B_PROVIDER_RESULT_INVALID", `M5B_PROVIDER_RESULT_INVALID: unknown fields ${unknown.sort().join(",")}`);
  const summary = record.summary;
  if (typeof summary !== "string" || summary.length === 0) throw new RalphM5BError("M5B_PROVIDER_RESULT_INVALID", "M5B_PROVIDER_RESULT_INVALID: summary");
  if (summary.length > M5B_LIMITS_V2.providerSummaryMaxChars) throw new RalphM5BError("M5B_PROVIDER_OUTPUT_LIMIT", "M5B_PROVIDER_OUTPUT_LIMIT: summary");
  try { assertNoCredentialMaterial({ summary }, "M5B_PROVIDER_RESULT"); }
  catch (error) {
    if (error instanceof RalphCredentialSafetyError) throw new RalphM5BError("M5B_PROVIDER_CREDENTIAL_MATERIAL", "M5B_PROVIDER_CREDENTIAL_MATERIAL: provider text");
    throw error;
  }
  const canonical = canonicalJson({ summary });
  return Object.freeze({ summary, canonicalJson: canonical, resultDigest: sha256(canonical) });
}

/**
 * The last completed agent_message of the turn must be the same structured
 * result the provider wrote through `-o`.  A stream whose final message does
 * not correspond to the durable output is refused.
 */
export function assertFinalAgentMessageMatchesOutputV2(finalAgentMessage: string | null, result: CodexProviderStructuredResultV2): void {
  if (finalAgentMessage === null) throw new RalphM5BError("M5B_PROVIDER_RESULT_INVALID", "M5B_PROVIDER_RESULT_INVALID: no final agent message");
  const trimmed = finalAgentMessage.trim();
  if (trimmed === result.canonicalJson) return;
  let parsed: unknown;
  try { parsed = JSON.parse(trimmed); }
  catch { throw new RalphM5BError("M5B_PROVIDER_RESULT_INVALID", "M5B_PROVIDER_RESULT_INVALID: final message is not the structured result"); }
  if (canonicalJson(parsed) !== result.canonicalJson) throw new RalphM5BError("M5B_PROVIDER_RESULT_INVALID", "M5B_PROVIDER_RESULT_INVALID: final message diverges from the -o output");
}
