import { createHash } from "node:crypto";
import { canonicalJsonBytes } from "./canonical-json.js";

export type Sha256Digest = `sha256:${string}`;

export function sha256(value: string | Buffer): Sha256Digest {
  const hex = createHash("sha256").update(value).digest("hex");
  return `sha256:${hex}` as Sha256Digest;
}

export function sha256Canonical(value: unknown): Sha256Digest {
  return sha256(canonicalJsonBytes(value));
}

export function isSha256Digest(value: unknown): value is Sha256Digest {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

export function assertSha256Digest(value: unknown, field: string): asserts value is Sha256Digest {
  if (!isSha256Digest(value)) throw new Error(`RALPH_INVALID_SHA256: ${field}`);
}
