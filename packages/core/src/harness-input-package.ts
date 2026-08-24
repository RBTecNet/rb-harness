/**
 * Deterministic, bounded input package (RF-001).
 *
 * Everything the model sees before the first provider call is built here by
 * code: the request and its hash, the selected workflow, a summarized
 * inventory of the target project, the existing RB artifacts, the decisions
 * already accepted, and the compact output contract. Nothing else is shipped.
 *
 * The package deliberately excludes version control, dependencies, build and
 * coverage output, live Harness state, credentials, and temporary files, and
 * it never contains a path into the RB Harness source, `dist`, tests, or
 * global installation. Additional content is obtainable only through the
 * confined documentation tools, inside the target project.
 */

import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, extname, relative, resolve, sep } from "node:path";
import { HARNESS_BUDGET } from "./harness-budget.js";
import type { HarnessWorkflow, InterviewAnswer, ProjectInventory } from "./standalone-types.js";

export const HARNESS_INPUT_CONTRACT = "rb-harness-input/v1" as const;

const EXCLUDED_DIRECTORIES = new Set([
  ".git", ".hg", ".svn", ".rb-harness", ".idea", ".vscode", ".vs", ".gradle",
  "node_modules", "bower_components", "vendor", "venv", ".venv", "__pycache__",
  ".mypy_cache", ".pytest_cache", ".ruff_cache", ".tox", ".terraform",
  "dist", "build", "out", "target", "bin", "obj", "coverage", ".nyc_output",
  ".next", ".nuxt", ".svelte-kit", ".turbo", ".parcel-cache", ".cache", "cache",
  "tmp", "temp", ".DS_Store", ".pnpm-store", ".yarn", "Pods", ".dart_tool",
]);

const SECRET_NAMES = /^(?:\.env(?:\..+)?|id_(?:rsa|dsa|ecdsa|ed25519)|credentials(?:\.json)?|secrets?\.(?:json|ya?ml))$/i;
const SECRET_EXTENSIONS = /\.(?:pem|key|p12|pfx|jks|keystore|crt|cer)$/i;
const TEMPORARY = /(?:\.tmp(?:-[^/]*)?|\.swp|\.orig|\.rej|~)$/i;
const LOCKFILE = /^(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|poetry\.lock|Cargo\.lock|composer\.lock|Gemfile\.lock|go\.sum)$/i;

/** Well-known project descriptors summarized instead of being shipped whole. */
const SIGNAL_FILES = [
  "package.json", "pyproject.toml", "setup.py", "requirements.txt", "go.mod",
  "Cargo.toml", "composer.json", "Gemfile", "pom.xml", "build.gradle",
  "build.gradle.kts", "pubspec.yaml", "Makefile", "justfile", "Taskfile.yml",
  "docker-compose.yml", "compose.yaml", "Dockerfile", "README.md", "AGENTS.md",
] as const;

export interface InventoryDirectory {
  path: string;
  files: number;
  bytes: number;
  sample: string[];
}

export interface ProjectSnapshot {
  name: string;
  totalFiles: number;
  totalBytes: number;
  truncated: boolean;
  directories: InventoryDirectory[];
  extensions: Array<{ extension: string; files: number }>;
  signals: Array<{ path: string; summary: string }>;
}

export interface HarnessInputPackage {
  contract: typeof HARNESS_INPUT_CONTRACT;
  workflow: HarnessWorkflow;
  request: {
    text: string;
    sha256: string;
    source: "inline" | "file";
    sourceName?: string;
  };
  project: ProjectSnapshot;
  artifacts: {
    directory: string;
    manifestFound: boolean;
    manifestValid: boolean;
    projectId?: string;
    projectName?: string;
    total: number;
    byKind: Record<string, number>;
    byStatus: Record<string, number>;
    readyPlans: Array<{ id: string; path: string }>;
    highlights: Array<{ id: string; kind: string; status: string; path: string; title?: string; summary?: string }>;
    /** Declared when the highlight budget left existing artifacts out. */
    omittedHighlights?: number;
    issues: Array<{ code: string; message: string }>;
  };
  decisions: Array<{ questionId: string; question: string; decision: string }>;
  assumptions: string[];
  unresolved: string[];
  /** Declared when the checkpoint budget left assumptions or unknowns out. */
  omittedCheckpointEntries?: number;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
}

/**
 * Deterministic JSON with sorted properties. The prefix handed to a direct API
 * must be byte-identical across steps for provider prefix caching to hit.
 */
export function stableJson(value: unknown): string {
  return stableStringify(value);
}

function compact(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1).trimEnd()}…`;
}

function excludedFile(name: string): boolean {
  if (SECRET_NAMES.test(name) && !/\.example$/i.test(name)) return true;
  if (SECRET_EXTENSIONS.test(name)) return true;
  if (TEMPORARY.test(name)) return true;
  if (LOCKFILE.test(name)) return true;
  return false;
}

async function summarizeSignal(path: string, name: string): Promise<string | undefined> {
  let info;
  try {
    info = await lstat(path);
  } catch {
    return undefined;
  }
  if (!info.isFile() || info.isSymbolicLink()) return undefined;
  if (info.size > HARNESS_BUDGET.inventory.maxSummarizedFileBytes) return `present (${info.size} bytes, not summarized)`;
  const source = await readFile(path, "utf8").catch(() => undefined);
  if (source === undefined) return undefined;
  if (name === "package.json" || name === "composer.json") {
    try {
      const parsed = JSON.parse(source) as Record<string, unknown>;
      const scripts = Object.keys((parsed.scripts ?? {}) as Record<string, unknown>).sort();
      const dependencies = Object.keys((parsed.dependencies ?? {}) as Record<string, unknown>).length
        + Object.keys((parsed.devDependencies ?? parsed["require-dev"] ?? {}) as Record<string, unknown>).length;
      return compact(
        `name=${String(parsed.name ?? "")} version=${String(parsed.version ?? "")} `
        + `scripts=[${scripts.join(", ")}] dependencies=${dependencies}`,
        400,
      );
    } catch {
      return "present (unparseable JSON)";
    }
  }
  const headline = source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("<!--"))
    .slice(0, 6)
    .join(" · ");
  return compact(headline, 400);
}

async function scanProject(projectRoot: string, artifactDirectory: string): Promise<ProjectSnapshot> {
  const root = resolve(projectRoot);
  const artifactRoot = resolve(root, artifactDirectory);
  const directories: InventoryDirectory[] = [];
  const extensions = new Map<string, number>();
  let totalFiles = 0;
  let totalBytes = 0;
  let truncated = false;

  async function visit(directory: string, depth: number): Promise<void> {
    if (directories.length >= HARNESS_BUDGET.inventory.maxDirectories) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    const files: Array<{ name: string; size: number }> = [];
    const children: string[] = [];
    for (const entry of entries) {
      const absolute = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (absolute === artifactRoot) continue;
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRECTORIES.has(entry.name)) continue;
        children.push(absolute);
        continue;
      }
      if (!entry.isFile() || excludedFile(entry.name)) continue;
      let size = 0;
      try {
        size = (await lstat(absolute)).size;
      } catch {
        continue;
      }
      files.push({ name: entry.name, size });
      totalFiles += 1;
      totalBytes += size;
      const extension = extname(entry.name).toLowerCase() || "(none)";
      extensions.set(extension, (extensions.get(extension) ?? 0) + 1);
      if (totalFiles >= HARNESS_BUDGET.inventory.maxFiles) truncated = true;
    }
    if (files.length) {
      const relativePath = relative(root, directory).split(sep).join("/") || ".";
      const sample = files.slice(0, HARNESS_BUDGET.inventory.directorySample).map((file) => file.name);
      directories.push({
        path: relativePath,
        files: files.length,
        bytes: files.reduce((sum, file) => sum + file.size, 0),
        sample,
      });
      if (files.length > sample.length) truncated = true;
    }
    if (depth >= HARNESS_BUDGET.inventory.maxDepth) {
      if (children.length) truncated = true;
      return;
    }
    for (const child of children) {
      if (totalFiles >= HARNESS_BUDGET.inventory.maxFiles) {
        truncated = true;
        return;
      }
      await visit(child, depth + 1);
    }
  }

  await visit(root, 0);
  directories.sort((left, right) => left.path.localeCompare(right.path));

  const signals: Array<{ path: string; summary: string }> = [];
  for (const name of [...SIGNAL_FILES].sort()) {
    const summary = await summarizeSignal(resolve(root, name), name);
    if (summary) signals.push({ path: name, summary });
  }

  return {
    name: basename(root) || "project",
    totalFiles,
    totalBytes,
    truncated,
    directories,
    extensions: [...extensions.entries()]
      .map(([extension, files]) => ({ extension, files }))
      .sort((left, right) => right.files - left.files || left.extension.localeCompare(right.extension))
      .slice(0, 20),
    signals,
  };
}

export interface InputPackageOptions {
  workflow: HarnessWorkflow;
  projectRoot: string;
  artifactDirectory: string;
  request: string;
  requestSource?: string;
  inventory: ProjectInventory;
  answers?: InterviewAnswer[];
  assumptions?: string[];
  unresolved?: string[];
}

export async function buildInputPackage(options: InputPackageOptions): Promise<HarnessInputPackage> {
  // The request is authority. It is checked before anything is scanned and
  // before any provider process can be created, and it is never shortened.
  const requestBytes = Buffer.byteLength(options.request);
  if (requestBytes > HARNESS_BUDGET.prompt.maxRequestBytes) {
    throw new Error(
      `the request is ${bytes(requestBytes)}, above its ${bytes(HARNESS_BUDGET.prompt.maxRequestBytes)} budget. `
      + "A request is authority and is never truncated: split it into smaller requests, "
      + "or move the supporting detail into project files the writer can read as evidence.",
    );
  }
  const project = await scanProject(options.projectRoot, options.artifactDirectory);
  const allDecisions = (options.answers ?? [])
    .filter((answer) => answer.disposition === "ACCEPTED")
    .map((answer) => ({
      questionId: answer.questionId,
      question: answer.question,
      decision: answer.normalizedDecision ?? answer.rawAnswer,
    }))
    .sort((left, right) => left.questionId.localeCompare(right.questionId));
  const decisionBudget = boundedSection(
    allDecisions,
    HARNESS_BUDGET.interview.firstRoundQuestions + HARNESS_BUDGET.interview.followUpQuestions,
    HARNESS_BUDGET.prompt.maxDecisionBytes,
    (decision) => stableJson(decision),
  );
  if (decisionBudget.omitted) {
    // Dropping an accepted decision would change what the documentation may
    // claim, so an over-budget decision set fails instead of being trimmed.
    throw new Error(
      `${allDecisions.length} accepted decisions exceed the ${bytes(HARNESS_BUDGET.prompt.maxDecisionBytes)} decision budget. `
      + "Accepted decisions are authority and are never dropped; shorten the answers or split the request.",
    );
  }
  const decisions = decisionBudget.kept;
  const highlightBudget = boundedSection(
    options.inventory.artifactHighlights,
    64,
    HARNESS_BUDGET.prompt.maxHighlightBytes,
    (highlight) => stableJson(highlight),
  );
  const assumptions = boundedSection(
    options.assumptions ?? [],
    50,
    HARNESS_BUDGET.prompt.maxCheckpointBytes,
    (entry) => entry,
  );
  const unresolved = boundedSection(
    options.unresolved ?? [],
    50,
    HARNESS_BUDGET.prompt.maxCheckpointBytes,
    (entry) => entry,
  );
  return {
    contract: HARNESS_INPUT_CONTRACT,
    workflow: options.workflow,
    request: {
      text: options.request,
      sha256: createHash("sha256").update(options.request).digest("hex"),
      source: options.requestSource ? "file" : "inline",
      ...(options.requestSource ? { sourceName: basename(options.requestSource) } : {}),
    },
    project,
    artifacts: {
      directory: options.artifactDirectory,
      manifestFound: options.inventory.manifestFound,
      manifestValid: options.inventory.manifestValid,
      ...(options.inventory.projectId ? { projectId: options.inventory.projectId } : {}),
      ...(options.inventory.projectName ? { projectName: options.inventory.projectName } : {}),
      total: options.inventory.artifacts,
      byKind: options.inventory.byKind,
      byStatus: options.inventory.byStatus,
      readyPlans: options.inventory.readyPlans,
      highlights: highlightBudget.kept,
      ...(highlightBudget.omitted ? { omittedHighlights: highlightBudget.omitted } : {}),
      issues: options.inventory.issues.slice(0, 12),
    },
    decisions,
    assumptions: assumptions.kept,
    unresolved: unresolved.kept,
    ...(assumptions.omitted + unresolved.omitted
      ? { omittedCheckpointEntries: assumptions.omitted + unresolved.omitted }
      : {}),
  };
}

/** Human-readable byte size for a diagnostic. */
function bytes(value: number): string {
  return value >= 1024 ? `${(value / 1024).toFixed(1)} KiB (${value} bytes)` : `${value} bytes`;
}

/**
 * Enforce a declared prompt ceiling before a provider is started (CR-006).
 *
 * Silently truncating a prompt would drop authority the documentation depends
 * on, so an over-budget prompt fails the preflight instead. The message names
 * the observed size, the limit, and the safe way forward — never the content.
 */
export function assertPromptWithinBudget(prompt: string, limit: number, label: string): void {
  const observed = Buffer.byteLength(prompt);
  if (observed <= limit) return;
  throw new Error(
    `the ${label} prompt is ${bytes(observed)}, above its ${bytes(limit)} budget. `
    + "Reduce the request, split the change into smaller requests, or narrow the artifact directory; "
    + "the Harness never truncates a prompt silently.",
  );
}

/**
 * Bound one authority-bearing section by item count and total bytes, keeping
 * the earliest items and declaring what was left out.
 */
export function boundedSection<T>(
  items: T[],
  maxItems: number,
  maxBytes: number,
  render: (item: T) => string,
): { kept: T[]; omitted: number } {
  const kept: T[] = [];
  let used = 0;
  for (const item of items.slice(0, maxItems)) {
    const size = Buffer.byteLength(render(item));
    if (used + size > maxBytes) break;
    used += size;
    kept.push(item);
  }
  return { kept, omitted: items.length - kept.length };
}

/**
 * Serialize the package deterministically and enforce its byte ceiling by
 * dropping the least load-bearing detail first: directory samples, then
 * whole directory rows. Truncation is always declared to the model, and a
 * package that still does not fit fails loudly rather than being cut short.
 */
export function serializeInputPackage(input: HarnessInputPackage): string {
  let candidate = { ...input };
  let serialized = stableJson(candidate);
  if (Buffer.byteLength(serialized) <= HARNESS_BUDGET.inventory.maxPackageBytes) return serialized;

  candidate = {
    ...candidate,
    project: {
      ...candidate.project,
      truncated: true,
      directories: candidate.project.directories.map((directory) => ({ ...directory, sample: directory.sample.slice(0, 3) })),
    },
  };
  serialized = stableJson(candidate);
  if (Buffer.byteLength(serialized) <= HARNESS_BUDGET.inventory.maxPackageBytes) return serialized;

  let directories = candidate.project.directories;
  while (directories.length > 1 && Buffer.byteLength(serialized) > HARNESS_BUDGET.inventory.maxPackageBytes) {
    directories = directories.slice(0, Math.max(1, Math.floor(directories.length / 2)));
    candidate = { ...candidate, project: { ...candidate.project, truncated: true, directories } };
    serialized = stableJson(candidate);
  }
  if (Buffer.byteLength(serialized) > HARNESS_BUDGET.inventory.maxPackageBytes) {
    // Reducing the inventory cannot shrink the request, the accepted
    // decisions, or the existing artifact summary — those are authority, and
    // trimming them would change what the documentation is allowed to say.
    throw new Error(
      `the input package is ${bytes(Buffer.byteLength(serialized))} after inventory reduction, `
      + `above its ${bytes(HARNESS_BUDGET.inventory.maxPackageBytes)} budget. `
      + "The request, accepted decisions, or existing artifact summary is too large to carry safely; "
      + "split the change into smaller requests or narrow the artifact directory.",
    );
  }
  return serialized;
}
