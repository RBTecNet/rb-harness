/**
 * Presentation payload sanitation.
 *
 * Nothing reaching a frame may carry a credential, an authorization header, or
 * a raw provider request/response body. Text is normalized to one printable
 * form and bounded so a hostile or accidental blob cannot be rendered verbatim.
 */

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

// The value may be a scheme-prefixed token, so the scheme is consumed with it.
const KEYED_ASSIGNMENT = /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|secret|password)\b(\s*[:=]\s*)(?:(?:Bearer|Basic|Token)\s+)?\S+/gi;

const REDACTIONS: readonly { readonly pattern: RegExp; readonly replacement: string }[] = [
  { pattern: /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}/g, replacement: "[redacted-credential]" },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, replacement: "Bearer [redacted-credential]" },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/g, replacement: "[redacted-credential]" },
  { pattern: /\bxox[abprs]-[A-Za-z0-9-]{8,}/g, replacement: "[redacted-credential]" },
];

export const PROGRESSIVE_TEXT_LIMIT = 2_000;

function redact(value: string): string {
  let text = value.replace(KEYED_ASSIGNMENT, "$1$2[redacted-credential]");
  for (const redaction of REDACTIONS) text = text.replace(redaction.pattern, redaction.replacement);
  return text;
}

function bound(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, Math.max(0, limit - 1))}…` : value;
}

/** One-line safe projection of arbitrary text. Newlines become spaces. */
export function sanitizeProgressiveText(value: unknown, limit = PROGRESSIVE_TEXT_LIMIT): string {
  const raw = typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
  const text = redact(raw.replace(CONTROL_CHARACTERS, " ")).replace(/\s+/g, " ").trim();
  return bound(text, limit);
}

/** Multi-line safe projection; paragraph structure survives, control bytes do not. */
export function sanitizeProgressiveBlock(value: unknown, limit = PROGRESSIVE_TEXT_LIMIT): string {
  const raw = typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
  const lines = raw.split(/\r?\n/).map((line) => sanitizeProgressiveText(line, limit));
  return bound(lines.join("\n").replace(/\n{3,}/g, "\n\n").trim(), limit);
}

/** Failure text a developer is authorized to see: the message only, never a stack. */
export function sanitizeProgressiveFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return sanitizeProgressiveText(message) || "unspecified failure";
}
