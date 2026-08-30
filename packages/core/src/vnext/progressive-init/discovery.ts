import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, extname, relative, resolve, sep } from "node:path";
import { sha256File, sha256Text } from "../../hash.js";
import { progressiveCanonicalJson } from "./canonical-json.js";

const MAX_FILES = 1_000;
const MAX_HASHED_BYTES = 16 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_DEPTH = 8;
const MAX_SIGNAL_BYTES = 64 * 1024;

const OMITTED_DIRECTORIES = new Set([
  ".git", ".hg", ".svn", ".rb", ".rb-harness", ".spec", ".idea", ".vscode",
  "node_modules", "vendor", "venv", ".venv", "dist", "build", "out", "target",
  "coverage", ".next", ".nuxt", ".svelte-kit", ".cache", ".terraform",
]);

const SECRET_NAME = /^(?:\.env(?:\..+)?|id_(?:rsa|dsa|ecdsa|ed25519)|credentials(?:\.json)?|secrets?\.(?:json|ya?ml))$/i;
const SECRET_EXTENSION = /\.(?:pem|key|p12|pfx|jks|keystore|crt|cer)$/i;
const SIGNAL_NAMES = new Set([
  "package.json", "pyproject.toml", "go.mod", "Cargo.toml", "composer.json", "Gemfile",
  "pom.xml", "build.gradle", "build.gradle.kts", "Makefile", "README.md", "AGENTS.md",
]);

export interface ProjectDescriptionDiscoveryFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface ProjectDescriptionDiscoverySignal {
  readonly path: string;
  readonly summary: string;
}

export interface ProjectDescriptionDiscovery {
  readonly contract: "rb-project-description-discovery/v1";
  readonly empty: boolean;
  readonly truncated: boolean;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly extensions: readonly { readonly extension: string; readonly files: number }[];
  readonly files: readonly ProjectDescriptionDiscoveryFile[];
  readonly signals: readonly ProjectDescriptionDiscoverySignal[];
}

function posixRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function secretFile(name: string): boolean {
  return SECRET_NAME.test(name) && !/\.example$/i.test(name) || SECRET_EXTENSION.test(name);
}

function compact(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= 600 ? normalized : `${normalized.slice(0, 599).trimEnd()}…`;
}

async function signalSummary(path: string, name: string): Promise<string | undefined> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) return undefined;
  if (info.size > MAX_SIGNAL_BYTES) return `present (${info.size} bytes; content omitted by discovery limit)`;
  const source = await readFile(path, "utf8").catch(() => undefined);
  if (source === undefined) return undefined;
  if (name === "package.json" || name === "composer.json") {
    try {
      const parsed = JSON.parse(source) as Record<string, unknown>;
      const scripts = Object.keys((parsed.scripts ?? {}) as Record<string, unknown>).sort();
      return compact(`name=${String(parsed.name ?? "")} scripts=[${scripts.join(", ")}]`);
    } catch {
      return "present (unparseable JSON)";
    }
  }
  return compact(source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 8).join(" · "));
}

/** Bounded, deterministic, secret-safe evidence used only by project-description. */
export async function discoverProjectDescriptionEnvironment(projectRoot: string): Promise<ProjectDescriptionDiscovery> {
  const root = resolve(projectRoot);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("project-description discovery requires a regular, non-symlink project directory");
  }

  const files: ProjectDescriptionDiscoveryFile[] = [];
  const signals: ProjectDescriptionDiscoverySignal[] = [];
  const extensions = new Map<string, number>();
  let totalBytes = 0;
  let truncated = false;

  async function visit(directory: string, depth: number): Promise<void> {
    if (files.length >= MAX_FILES || totalBytes >= MAX_HASHED_BYTES) {
      truncated = true;
      return;
    }
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (OMITTED_DIRECTORIES.has(entry.name)) continue;
        if (depth >= MAX_DEPTH) {
          truncated = true;
          continue;
        }
        await visit(absolute, depth + 1);
        continue;
      }
      if (!entry.isFile() || secretFile(entry.name)) continue;
      const info = await lstat(absolute);
      if (!info.isFile() || info.isSymbolicLink()) continue;
      if (info.size > MAX_FILE_BYTES || files.length >= MAX_FILES || totalBytes + info.size > MAX_HASHED_BYTES) {
        truncated = true;
        continue;
      }
      const path = posixRelative(root, absolute);
      files.push({ path, bytes: info.size, sha256: await sha256File(absolute) });
      totalBytes += info.size;
      const extension = extname(entry.name).toLowerCase() || "(none)";
      extensions.set(extension, (extensions.get(extension) ?? 0) + 1);
      if (SIGNAL_NAMES.has(entry.name) && signals.length < 24) {
        const summary = await signalSummary(absolute, entry.name);
        if (summary) signals.push({ path, summary });
      }
    }
  }

  await visit(root, 0);
  files.sort((left, right) => left.path.localeCompare(right.path));
  signals.sort((left, right) => left.path.localeCompare(right.path));
  return {
    contract: "rb-project-description-discovery/v1",
    empty: files.length === 0,
    truncated,
    fileCount: files.length,
    totalBytes,
    extensions: [...extensions.entries()]
      .map(([extension, count]) => ({ extension, files: count }))
      .sort((left, right) => left.extension.localeCompare(right.extension)),
    files,
    signals,
  };
}

export function projectDescriptionDiscoverySha256(discovery: ProjectDescriptionDiscovery): string {
  return sha256Text(progressiveCanonicalJson(discovery));
}
