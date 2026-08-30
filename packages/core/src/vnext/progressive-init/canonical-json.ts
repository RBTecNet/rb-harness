/** Canonical JSON for hashing Progressive Init's JSON-only contract values. */
export function progressiveCanonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("PROGRESSIVE_CANONICAL_JSON: non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(progressiveCanonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${progressiveCanonicalJson(record[key])}`).join(",")}}`;
  }
  throw new Error(`PROGRESSIVE_CANONICAL_JSON: unsupported ${typeof value}`);
}
