/**
 * Deterministic JSON for the JSON-compatible subset used by Ralph Runtime.
 *
 * The implementation deliberately rejects values that JSON.stringify would
 * silently coerce (undefined, NaN, Infinity, functions and exotic objects).
 * This keeps hashes fail-closed and gives the supported subset JCS-equivalent
 * output: UTF-8 callers receive sorted keys, finite numbers and no newline.
 */
export function canonicalJson(value: unknown): string {
  return encode(value, "$", new WeakSet<object>());
}

function encode(value: unknown, path: string, seen: WeakSet<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`RALPH_CANONICAL_JSON_UNSUPPORTED: non-finite number at ${path}`);
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new Error(`RALPH_CANONICAL_JSON_UNSUPPORTED: ${typeof value} at ${path}`);
  if (seen.has(value)) throw new Error(`RALPH_CANONICAL_JSON_UNSUPPORTED: cyclic value at ${path}`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) throw new Error(`RALPH_CANONICAL_JSON_UNSUPPORTED: sparse array at ${path}[${index}]`);
        items.push(encode(value[index], `${path}[${index}]`, seen));
      }
      return `[${items.join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`RALPH_CANONICAL_JSON_UNSUPPORTED: exotic object at ${path}`);
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${encode(record[key], `${path}.${key}`, seen)}`).join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

export function canonicalJsonBytes(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value), "utf8");
}
