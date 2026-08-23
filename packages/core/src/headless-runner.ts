import { lstat, mkdir, readdir, readFile, realpath } from "node:fs/promises";
import { isUtf8 } from "node:buffer";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { validateExecutionMarkdown } from "./execution-contract.js";
import { safeProjectPath } from "./fs-utils.js";
import { sha256File, sha256Text } from "./hash.js";
import { isSafeRelativePath, validateHeadlessInitJson, validateHeadlessInitValue, type HeadlessInitDocument } from "./headless-contract.js";
import { loadManifest, syncManifest, validateManifestTree, validateManifestValue } from "./manifest.js";
import { validateOperationalJson } from "./operational-contract.js";
import { buildHeadlessInitPrompt } from "./headless-prompt.js";

export const HEADLESS_HARNESS_VERSION = "0.2.1";
export const HEADLESS_HARNESS_SHA256 = sha256Text(`rb-harness@${HEADLESS_HARNESS_VERSION}`);
const VALIDATIONS = ["request", "paths", "contract", "operations", "manifest", "tree", "secrets"] as const;
const SAFE_BASE_ENV = ["PATH", "LANG", "LC_ALL", "TZ"] as const;
const MAX_FILES = 2_000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 100 * 1024 * 1024;
const PUBLIC_OUTPUT_DIAGNOSTICS = new Set([
  "output_not_absolute", "output_not_isolated", "output_not_empty", "workspace_modified",
  "secret_detected", "output_path", "output_duplicate_path", "output_link", "output_special_file",
  "manifest_schema_invalid", "manifest_project_mismatch", "execution_plan_invalid",
  "execution_contract_invalid", "operations_contract_invalid", "tree_invalid", "result_invalid",
]);

type Status = "ready" | "invalid" | "failed";
type Adapter = { command: string; args: string[]; id: string; version: string; provider: string; model: string };

export interface HeadlessRunOptions {
  input: string | Buffer;
  outputRoot: string;
  workspace?: string;
  environment?: NodeJS.ProcessEnv;
  adapter?: Adapter;
}

export interface HeadlessRunResult {
  exitCode: number;
  result: HeadlessInitDocument;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function configuredAdapter(environment: NodeJS.ProcessEnv): Adapter | undefined {
  const command = environment.RB_HEADLESS_ADAPTER_COMMAND;
  const id = environment.RB_HEADLESS_ADAPTER_ID;
  const version = environment.RB_HEADLESS_ADAPTER_VERSION;
  const provider = environment.RB_HEADLESS_ADAPTER_PROVIDER;
  const model = environment.RB_HEADLESS_ADAPTER_MODEL;
  if (!command || !id || !version || !provider || !model) return undefined;
  let args: string[] = [];
  if (environment.RB_HEADLESS_ADAPTER_ARGS) {
    try {
      const parsed: unknown = JSON.parse(environment.RB_HEADLESS_ADAPTER_ARGS);
      if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) return undefined;
      args = parsed;
    } catch {
      return undefined;
    }
  }
  return { command, args, id, version, provider, model };
}

function validAdapter(adapter: Adapter | undefined): adapter is Adapter {
  return Boolean(adapter
    && adapter.command
    && Array.from(adapter.id).length <= 200 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(adapter.id)
    && Array.from(adapter.version).length >= 1 && Array.from(adapter.version).length <= 100
    && Array.from(adapter.provider).length >= 1 && Array.from(adapter.provider).length <= 120
    && Array.from(adapter.model).length >= 1 && Array.from(adapter.model).length <= 160);
}

function safeAdapter(adapter: Adapter | undefined): Adapter {
  return validAdapter(adapter)
    ? adapter
    : { command: "", args: [], id: "unconfigured", version: "unknown", provider: "unconfigured", model: "unconfigured" };
}

function redactPublicString(value: string, secretValues: string[], fallback: string): string {
  return includesSecret(secretValues, value) ? fallback : value;
}

function publicAdapter(adapter: Adapter | undefined, secretValues: string[]): Adapter {
  const safe = safeAdapter(adapter);
  return {
    command: "", args: [],
    id: redactPublicString(safe.id, secretValues, "redacted"),
    version: redactPublicString(safe.version, secretValues, "redacted"),
    provider: redactPublicString(safe.provider, secretValues, "redacted"),
    model: redactPublicString(safe.model, secretValues, "redacted"),
  };
}

function result(
  requestId: string,
  requestHash: string,
  adapter: Adapter | undefined,
  status: Status,
  diagnosticCode: string,
  startedAt: string,
  validations: Array<{ name: string; passed: boolean; exitCode: number; diagnosticCode?: string }>,
  files: Array<{ path: string; bytes: number; sha256: string; mediaType: string }> = [],
  secretValues: string[] = [],
): HeadlessInitDocument {
  const safe = publicAdapter(adapter, secretValues);
  return {
    contract: "rb-headless-init/v1",
    kind: "result",
    requestId: redactPublicString(requestId, secretValues, "redacted"),
    requestHash,
    status,
    harness: { version: HEADLESS_HARNESS_VERSION, sha256: HEADLESS_HARNESS_SHA256 },
    adapter: { id: safe.id, version: safe.version, provider: safe.provider, model: safe.model },
    files,
    validations,
    diagnosticCode,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}

function nonReady(
  requestId: string,
  requestHash: string,
  adapter: Adapter | undefined,
  status: "invalid" | "failed",
  diagnosticCode: string,
  exitCode: number,
  startedAt: string,
  secretValues: string[] = [],
): HeadlessRunResult {
  return { exitCode, result: result(requestId, requestHash, adapter, status, diagnosticCode, startedAt, [{ name: "request", passed: false, exitCode, diagnosticCode }], [], secretValues) };
}

/**
 * Scope violations are an expected, public failure class.  Keep them distinct
 * from malformed input so the caller can reject plan/evolve/clone requests
 * without treating its request boundary as generically broken.
 */
function invalidRequestDiagnostic(issues: Array<{ code: string }>): string {
  return issues.some((issue) => issue.code === "headless.scope" || issue.code === "headless.instructions.scope")
    ? "unsupported_generation_scope"
    : "invalid_request";
}

/**
 * Filesystem errors carry physical paths in their messages.  Only publish
 * explicitly enumerated output diagnostics; every other post-adapter error is
 * an opaque invalid-output result.
 */
function outputDiagnostic(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  return PUBLIC_OUTPUT_DIAGNOSTICS.has(code) ? code : "output_invalid";
}

function allowlistedEnvironment(environment: NodeJS.ProcessEnv, adapter: Adapter, outputRoot: string, requestId: string): { env: NodeJS.ProcessEnv; secrets: string[] } {
  const allowed = new Set<string>(SAFE_BASE_ENV);
  const configured = environment.RB_HEADLESS_ENV_ALLOWLIST ?? "";
  for (const name of configured.split(",").map((entry) => entry.trim()).filter(Boolean)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error("invalid_environment_allowlist");
    // Ralph's orchestration variables are exclusively for its provider adapter
    // and must never cross into an independent headless-init invocation.
    if (name.startsWith("RB_RALPH_")) throw new Error("invalid_environment_allowlist");
    allowed.add(name);
  }
  const env: NodeJS.ProcessEnv = {};
  const secrets: string[] = [];
  for (const name of allowed) {
    const value = environment[name];
    if (value !== undefined) {
      env[name] = value;
      if (!SAFE_BASE_ENV.includes(name as typeof SAFE_BASE_ENV[number]) && value.length > 0) secrets.push(value);
    }
  }
  Object.assign(env, {
    RB_HEADLESS_OUTPUT_ROOT: outputRoot,
    RB_HEADLESS_REQUEST_ID: requestId,
    RB_HEADLESS_HARNESS_VERSION: HEADLESS_HARNESS_VERSION,
    RB_HEADLESS_ADAPTER_ID: adapter.id,
    RB_HEADLESS_ADAPTER_VERSION: adapter.version,
    RB_HEADLESS_ADAPTER_PROVIDER: adapter.provider,
    RB_HEADLESS_ADAPTER_MODEL: adapter.model,
  });
  return { env, secrets };
}

/** Return values explicitly permitted through the adapter environment. */
function allowlistedSecretValues(environment: NodeJS.ProcessEnv): string[] {
  const configured = environment.RB_HEADLESS_ENV_ALLOWLIST ?? "";
  const secrets: string[] = [];
  for (const name of configured.split(",").map((entry) => entry.trim()).filter(Boolean)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name) || name.startsWith("RB_RALPH_") || SAFE_BASE_ENV.includes(name as typeof SAFE_BASE_ENV[number])) continue;
    const value = environment[name];
    if (value && !secrets.includes(value)) secrets.push(value);
  }
  return secrets;
}

async function verifyAttachments(request: HeadlessInitDocument, workspace: string): Promise<void> {
  const specifications = request.specifications as Array<Record<string, unknown>>;
  for (const specification of specifications) {
    for (const resource of specification.resources as Array<Record<string, unknown>>) {
      if (resource.kind !== "attachment") continue;
      try {
        const path = safeProjectPath(workspace, String(resource.path));
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== resource.bytes) throw new Error("attachment_invalid");
        if (await sha256File(path) !== resource.sha256) throw new Error("attachment_hash_mismatch");
      } catch (error) {
        // Node filesystem errors include physical paths.  They are not safe to
        // return in the public diagnosticCode, so collapse them to a stable
        // attachment failure class before any result is constructed.
        if (error instanceof Error && error.message === "attachment_hash_mismatch") throw error;
        throw new Error("attachment_invalid");
      }
    }
  }
}

async function validatedOutputRoot(outputRoot: string, workspace: string, expectedRoot?: string): Promise<string> {
  if (!isAbsolute(outputRoot)) throw new Error("output_not_absolute");
  const absolute = resolve(outputRoot);
  if (absolute === resolve(workspace)) throw new Error("output_not_isolated");
  const info = await lstat(absolute);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("output_not_isolated");
  const canonical = await realpath(absolute);
  if (expectedRoot !== undefined && canonical !== expectedRoot) throw new Error("output_not_isolated");
  return canonical;
}

async function ensureEmptyOutput(outputRoot: string, workspace: string): Promise<string> {
  if (!isAbsolute(outputRoot)) throw new Error("output_not_absolute");
  const absolute = resolve(outputRoot);
  await mkdir(absolute, { recursive: true });
  const canonical = await validatedOutputRoot(absolute, workspace);
  if ((await readdir(canonical)).length > 0) throw new Error("output_not_empty");
  return canonical;
}

function isDescendant(path: string, parent: string): boolean {
  const candidate = relative(parent, path);
  return candidate !== "" && !candidate.startsWith(`..${sep}`) && candidate !== ".." && !isAbsolute(candidate);
}

/**
 * The adapter is permitted to read the isolated job workspace, but its only
 * write target is the separate output root.  This post-run snapshot is a
 * deterministic backstop for adapters that ignore that boundary.
 */
async function workspaceSnapshot(workspace: string, outputRoot: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  const normalizedWorkspace = resolve(workspace);
  const normalizedOutput = resolve(outputRoot);

  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name);
      if (isDescendant(absolute, normalizedOutput) || absolute === normalizedOutput) continue;
      const relativePath = relative(normalizedWorkspace, absolute).split(sep).join("/");
      const info = await lstat(absolute);
      if (info.isDirectory()) {
        snapshot.set(relativePath, "directory");
        await visit(absolute);
      } else if (info.isFile()) {
        snapshot.set(relativePath, `file:${info.size}:${await sha256File(absolute)}`);
      } else if (info.isSymbolicLink()) {
        snapshot.set(relativePath, "symlink");
      } else {
        snapshot.set(relativePath, "special");
      }
    }
  }

  await visit(normalizedWorkspace);
  return snapshot;
}

function sameSnapshot(before: Map<string, string>, after: Map<string, string>): boolean {
  return before.size === after.size && [...before].every(([path, fingerprint]) => after.get(path) === fingerprint);
}

async function adapterExit(adapter: Adapter, prompt: string, workspace: string, environment: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolveExit, reject) => {
    const child = spawn(adapter.command, adapter.args, { cwd: workspace, env: environment, stdio: ["pipe", "ignore", "ignore"] });
    child.once("error", reject);
    child.once("close", (code, signal) => resolveExit(code ?? (signal ? 70 : 1)));
    // A short-lived adapter can close stdin before a large prompt is written.
    // Its exit code remains authoritative instead of surfacing EPIPE.
    child.stdin.once("error", () => {});
    child.stdin.end(prompt, "utf8");
  });
}

type OutputFile = { path: string; bytes: number; sha256: string; mediaType: string };

function includesSecret(secretValues: string[], ...surfaces: unknown[]): boolean {
  return secretValues.some((value) => value.length > 0 && surfaces.some((surface) => String(surface).includes(value)));
}

function mediaType(path: string): string {
  if (path.endsWith(".md")) return "text/markdown";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".tsv")) return "text/tab-separated-values";
  if (path.endsWith(".yaml") || path.endsWith(".yml")) return "application/yaml";
  if (path.endsWith(".proto")) return "text/plain";
  return "application/octet-stream";
}

async function inspectOutput(outputRoot: string, secretValues: string[]): Promise<OutputFile[]> {
  const files: OutputFile[] = [];
  const normalized = new Set<string>();
  let totalBytes = 0;
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name);
      const relativePath = relative(outputRoot, absolute).split(sep).join("/");
      // Paths and inventory metadata are eventually published in result.files,
      // so they are secret-bearing surfaces just like file content.
      if (includesSecret(secretValues, entry.name, relativePath)) throw new Error("secret_detected");
      if (!isSafeRelativePath(relativePath)) throw new Error("output_path");
      const normalizedPath = relativePath.normalize("NFC").toLowerCase();
      if (normalized.has(normalizedPath)) throw new Error("output_duplicate_path");
      normalized.add(normalizedPath);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error("output_link");
      if (info.isDirectory()) {
        if (relativePath !== ".rb" && relativePath !== ".rb/init" && !relativePath.startsWith(".rb/init/")) throw new Error("output_path");
        await visit(absolute);
      } else if (info.isFile()) {
        if (info.nlink !== 1) throw new Error("output_link");
        if ((relativePath !== ".rb/rb-manifest.json" && relativePath !== ".rb/artifacts.tsv" && !relativePath.startsWith(".rb/init/")) || info.size > MAX_FILE_BYTES || files.length >= MAX_FILES || totalBytes + info.size > MAX_OUTPUT_BYTES) throw new Error("output_path");
        const content = await readFile(absolute);
        const fileMediaType = mediaType(relativePath);
        if (includesSecret(secretValues, content, relativePath, fileMediaType)) throw new Error("secret_detected");
        totalBytes += info.size;
        files.push({ path: relativePath, bytes: info.size, sha256: sha256Text(content), mediaType: fileMediaType });
      } else throw new Error("output_special_file");
    }
  }
  await visit(outputRoot);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function validateOutput(outputRoot: string, projectId: string, secretValues: string[]): Promise<OutputFile[]> {
  const beforeSync = await inspectOutput(outputRoot, secretValues);
  const manifest = await loadManifest(outputRoot);
  if (!validateManifestValue(manifest).valid) throw new Error("manifest_schema_invalid");
  if (manifest.project.id !== projectId) throw new Error("manifest_project_mismatch");
  const phasePaths = beforeSync.filter((file) => file.path.endsWith("/PHASES.md"));
  if (phasePaths.length === 0) throw new Error("execution_plan_invalid");
  for (const file of phasePaths) if (!validateExecutionMarkdown(await readFile(safeProjectPath(outputRoot, file.path), "utf8")).valid) throw new Error("execution_contract_invalid");
  for (const file of beforeSync.filter((entry) => entry.path.endsWith("/OPERATIONS.json"))) if (!validateOperationalJson(await readFile(safeProjectPath(outputRoot, file.path), "utf8")).valid) throw new Error("operations_contract_invalid");
  await syncManifest(outputRoot);
  const synced = await loadManifest(outputRoot);
  const phases = synced.artifacts.filter((artifact) => artifact.kind === "execution-plan");
  if (phases.length === 0 || phases.some((artifact) => artifact.status !== "ready" || artifact.contract !== "rb-execution/v1")) throw new Error("execution_plan_invalid");
  if (!(await validateManifestTree(outputRoot)).valid) throw new Error("tree_invalid");
  return inspectOutput(outputRoot, secretValues);
}

export async function runHeadlessInit(options: HeadlessRunOptions): Promise<HeadlessRunResult> {
  const startedAt = new Date().toISOString();
  const environment = options.environment ?? process.env;
  const workspace = resolve(options.workspace ?? process.cwd());
  const adapter = options.adapter ?? configuredAdapter(environment);
  const publicSecrets = allowlistedSecretValues(environment);
  const input = typeof options.input === "string"
    ? options.input
    : isUtf8(options.input) ? options.input.toString("utf8") : undefined;
  const parsed = input === undefined
    ? { valid: false, issues: [{ code: "headless.encoding", message: "stdin must be valid UTF-8", severity: "error" as const, path: "$" }] }
    : validateHeadlessInitJson(input);
  const request = parsed.document;
  const requestId = typeof request?.requestId === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(request.requestId) ? request.requestId : "invalid-request";
  const requestHash = sha256Text(parsed.valid && request ? canonicalJson(request) : input ?? options.input.toString("hex"));
  if (!parsed.valid || !request) return nonReady(requestId, requestHash, adapter, "invalid", invalidRequestDiagnostic(parsed.issues), 2, startedAt, publicSecrets);
  if (!validAdapter(adapter)) return nonReady(requestId, requestHash, adapter, "failed", "adapter_not_configured", 3, startedAt, publicSecrets);

  try {
    await verifyAttachments(request, workspace);
  } catch (error) {
    const code = error instanceof Error && error.message === "attachment_hash_mismatch" ? "attachment_hash_mismatch" : "attachment_invalid";
    return nonReady(requestId, requestHash, adapter, "invalid", code, 2, startedAt, publicSecrets);
  }
  let outputRoot: string;
  try {
    outputRoot = await ensureEmptyOutput(options.outputRoot, workspace);
  } catch (error) {
    return nonReady(requestId, requestHash, adapter, "invalid", outputDiagnostic(error), 2, startedAt, publicSecrets);
  }

  let adapterEnvironment: { env: NodeJS.ProcessEnv; secrets: string[] };
  try {
    adapterEnvironment = allowlistedEnvironment(environment, adapter, outputRoot, requestId);
  } catch {
    return nonReady(requestId, requestHash, adapter, "failed", "adapter_configuration_invalid", 3, startedAt, publicSecrets);
  }
  const prompt = adapterEnvironment.secrets.reduce((current, value) => current.split(value).join("[REDACTED]"), buildHeadlessInitPrompt(request));
  let workspaceBefore: Map<string, string>;
  try {
    workspaceBefore = await workspaceSnapshot(workspace, outputRoot);
  } catch {
    return nonReady(requestId, requestHash, adapter, "invalid", "workspace_invalid", 2, startedAt, adapterEnvironment.secrets);
  }
  let exitCode: number;
  try {
    exitCode = await adapterExit(adapter, prompt, workspace, adapterEnvironment.env);
  } catch {
    return nonReady(requestId, requestHash, adapter, "failed", "adapter_failed", 70, startedAt, adapterEnvironment.secrets);
  }
  if (exitCode !== 0) return nonReady(requestId, requestHash, adapter, "failed", exitCode === 75 ? "adapter_unavailable" : "adapter_failed", exitCode === 75 ? 75 : 70, startedAt, adapterEnvironment.secrets);

  try {
    const postAdapterOutputRoot = await validatedOutputRoot(options.outputRoot, workspace, outputRoot);
    if (!sameSnapshot(workspaceBefore, await workspaceSnapshot(workspace, postAdapterOutputRoot))) throw new Error("workspace_modified");
    const files = await validateOutput(postAdapterOutputRoot, String((request.project as Record<string, unknown>).id), adapterEnvironment.secrets);
    const validations = VALIDATIONS.map((name) => ({ name, passed: true, exitCode: 0 }));
    const completed = result(requestId, requestHash, adapter, "ready", "", startedAt, validations, files);
    if (includesSecret(adapterEnvironment.secrets, canonicalJson(completed))) throw new Error("secret_detected");
    if (!validateHeadlessInitValue(completed).valid) throw new Error("result_invalid");
    return { exitCode: 0, result: completed };
  } catch (error) {
    return nonReady(requestId, requestHash, adapter, "invalid", outputDiagnostic(error), 2, startedAt, adapterEnvironment.secrets);
  }
}
