/**
 * One path policy for every documentation capability (CR-005).
 *
 * Listing, reading, searching, and link resolution all consult this module, so
 * a directory that is hidden from a listing cannot be reached by naming it
 * directly. The Harness control plane is the sharpest case: a model that can
 * read `.rb-harness/runs/<id>/state.json` reads its own prompt, its own
 * interview answers, and its own budget, and starts documenting the
 * orchestrator instead of the project.
 */

import { relative, resolve, sep } from "node:path";

/** Control-plane and version-control roots, matched at any depth. */
const DENIED_ROOTS = [
  ".rb-harness",
  ".git",
  ".hg",
  ".svn",
];

/** Logical paths inside the artifact tree that belong to the executor. */
const DENIED_PREFIXES = [
  ".rb/runs",
];

/** Generated or dependency trees that are omitted from listings and searches. */
export const OMITTED_DIRECTORIES = new Set([
  "node_modules", "bower_components", "vendor", "venv", ".venv", "__pycache__",
  ".mypy_cache", ".pytest_cache", ".ruff_cache", ".tox", ".terraform",
  "dist", "build", "out", "target", "coverage", ".nyc_output",
  ".next", ".nuxt", ".svelte-kit", ".turbo", ".parcel-cache", ".cache",
  ".gradle", ".dart_tool", ".pnpm-store", ".yarn", "Pods",
]);

const SECRET_FILE = /^(?:\.env(?:\..+)?|id_(?:rsa|dsa|ecdsa|ed25519)|credentials(?:\.json)?|secrets?\.(?:json|ya?ml))$/i;
const SECRET_EXTENSION = /\.(?:pem|key|p12|pfx|jks|keystore)$/i;

export type PathDenial =
  | "orchestrator-state"
  | "version-control"
  | "executor-state"
  | "credential"
  | "generated";

const DENIAL_MESSAGE: Readonly<Record<PathDenial, string>> = {
  "orchestrator-state": "Harness orchestrator state is not project evidence and is not readable",
  "version-control": "version-control internals are not project evidence and are not readable",
  "executor-state": "executor run state is control-plane data and is not readable",
  "credential": "reading credential or environment-secret files is not allowed",
  "generated": "generated and dependency directories are omitted from documentation evidence",
};

function segments(relativePath: string): string[] {
  return relativePath.split("/").filter((segment) => segment && segment !== ".");
}

/**
 * Classify a project-relative POSIX path. `undefined` means the path carries no
 * policy objection; callers still enforce their own root containment.
 */
export function classifyProjectPath(relativePath: string): PathDenial | undefined {
  const parts = segments(relativePath.replaceAll("\\", "/"));
  if (!parts.length) return undefined;
  for (const prefix of DENIED_PREFIXES) {
    const wanted = segments(prefix);
    if (wanted.every((segment, index) => parts[index] === segment)) return "executor-state";
  }
  for (const part of parts) {
    if (DENIED_ROOTS.includes(part)) return part === ".rb-harness" ? "orchestrator-state" : "version-control";
  }
  const name = parts.at(-1) ?? "";
  if (SECRET_FILE.test(name) && !/\.example$/i.test(name)) return "credential";
  if (SECRET_EXTENSION.test(name)) return "credential";
  for (const part of parts) if (OMITTED_DIRECTORIES.has(part)) return "generated";
  return undefined;
}

/** Whether a path may appear in a listing or a search result. */
export function isVisibleProjectPath(relativePath: string): boolean {
  return classifyProjectPath(relativePath) === undefined;
}

/**
 * Throw when a path is denied. `generated` is a listing-level omission rather
 * than a refusal: naming a build output explicitly is answered honestly, but it
 * never appears on its own in evidence.
 */
export function assertReadableProjectPath(relativePath: string): void {
  const denial = classifyProjectPath(relativePath);
  if (!denial || denial === "generated") return;
  throw new Error(`${DENIAL_MESSAGE[denial]}: ${relativePath}`);
}

/**
 * Resolve a project-relative path inside `root`, rejecting traversal, absolute
 * inputs, and anything the policy denies. The caller supplies the real
 * (symlink-resolved) root; the returned absolute path is lexically contained.
 */
export function resolveProjectPath(root: string, input: string): { absolute: string; relative: string } {
  const normalized = input.replaceAll("\\", "/");
  if (normalized.includes("\0")) throw new Error("path must not contain a null byte");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) throw new Error("path must be project-relative");
  const absolute = resolve(root, normalized);
  const relativePath = relative(root, absolute).split(sep).join("/");
  if (relativePath.startsWith("..") || (absolute !== root && !absolute.startsWith(`${root}${sep}`))) {
    throw new Error(`path escapes the project root: ${input}`);
  }
  assertReadableProjectPath(relativePath);
  return { absolute, relative: relativePath };
}
