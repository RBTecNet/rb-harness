import { spawn } from "node:child_process";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { HARNESS_BUDGET } from "./harness-budget.js";
import {
  OMITTED_DIRECTORIES,
  classifyProjectPath,
  isVisibleProjectPath,
  resolveProjectPath,
} from "./path-policy.js";

export type ApiAgentRole =
  | "harness-interview"
  | "harness-generation"
  | "harness-repair"
  | "ralph-agent"
  | "ralph-manager";

/**
 * Accumulated tool spend for one documentation session. Independent reads may
 * run concurrently, but the total number of calls and the total retained
 * output stay bounded so a model cannot turn evidence discovery into an
 * open-ended repository crawl.
 */
export interface ToolGovernor {
  calls: number;
  outputBytes: number;
  lastSignature?: string;
  repeats: number;
}

export function createToolGovernor(): ToolGovernor {
  return { calls: 0, outputBytes: 0, repeats: 0 };
}

export interface ApiAgentToolContext {
  projectRoot: string;
  role: ApiAgentRole;
  permissionMode: "yolo" | "protected";
  artifactDirectory?: string;
  evidenceDirectory?: string;
  /** Present for documentation roles; Ralph roles keep their own limits. */
  governor?: ToolGovernor;
}

/** Documentation roles read the target project and never write or execute. */
export function isDocumentationRole(role: ApiAgentRole): boolean {
  return role === "harness-interview" || role === "harness-generation" || role === "harness-repair";
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const SENSITIVE_FILE = /^(?:\.env(?:\..+)?|id_(?:rsa|dsa|ecdsa|ed25519)|credentials(?:\.json)?|secrets?\.json)$/i;
const SENSITIVE_EXTENSION = /\.(?:pem|key|p12|pfx|jks|keystore)$/i;
const MAX_TOOL_OUTPUT = 256 * 1024;

function isWriteRole(role: ApiAgentRole): boolean {
  return role === "ralph-agent";
}

function assertString(value: unknown, label: string, maximum = 4096): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty string of at most ${maximum} characters`);
  }
  return value;
}

function relativeInput(value: unknown, label = "path"): string {
  const path = value === undefined ? "." : assertString(value, label);
  if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) throw new Error(`${label} must be project-relative`);
  return path;
}

function lexicalPath(root: string, input: string): string {
  const absolute = resolve(root, input);
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) throw new Error("path escapes the project root");
  return absolute;
}

/**
 * Resolve an existing project path. The lexical check rejects traversal, the
 * shared policy rejects control-plane and credential targets, and the realpath
 * check rejects a symlink that points out of the project — all three are
 * needed, because each defeats a different escape.
 */
async function existingPath(root: string, input: string, enforcePolicy: boolean): Promise<string> {
  const lexical = enforcePolicy
    ? resolveProjectPath(root, input).absolute
    : lexicalPath(root, input);
  const actual = await realpath(lexical);
  if (actual !== root && !actual.startsWith(`${root}${sep}`)) throw new Error("path resolves outside the project root");
  if (enforcePolicy) {
    // Re-check after symlink resolution: a link inside the project may still
    // aim at a denied area of the same project.
    resolveProjectPath(root, relative(root, actual).replaceAll("\\", "/") || ".");
  }
  return actual;
}

async function writablePath(context: ApiAgentToolContext, input: string): Promise<string> {
  if (!isWriteRole(context.role)) throw new Error(`role ${context.role} is read-only`);
  const root = await realpath(context.projectRoot);
  const absolute = lexicalPath(root, input);
  const relativePath = relative(root, absolute).replaceAll("\\", "/");
  if (!relativePath || relativePath === ".") throw new Error("writing the project root is not allowed");
  if (relativePath === ".git" || relativePath.startsWith(".git/") || relativePath === ".rb/runs" || relativePath.startsWith(".rb/runs/")) {
    throw new Error("orchestrator and Git control-plane paths are read-only");
  }
  if (context.role === "ralph-agent" && context.artifactDirectory) {
    const artifact = context.artifactDirectory.replace(/^\.\//, "").replace(/\/$/, "");
    if (relativePath === artifact || relativePath.startsWith(`${artifact}/`)) throw new Error("Ralph planning artifacts are read-only");
  }
  const parent = await realpath(dirname(absolute)).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    let ancestor = dirname(absolute);
    while (ancestor !== root) {
      try { return await realpath(ancestor); } catch (nested: unknown) {
        if ((nested as NodeJS.ErrnoException).code !== "ENOENT") throw nested;
        ancestor = dirname(ancestor);
      }
    }
    return root;
  });
  if (parent !== root && !parent.startsWith(`${root}${sep}`)) throw new Error("write parent resolves outside the project root");
  try {
    const info = await lstat(absolute);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("write target must be a regular file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return absolute;
}

async function evidenceWritablePath(context: ApiAgentToolContext, input: string): Promise<{ root: string; path: string }> {
  if (context.role !== "ralph-agent" || !context.evidenceDirectory) {
    throw new Error("write_evidence is available only to a Ralph executor with a submission directory");
  }
  const root = await realpath(context.evidenceDirectory);
  const path = lexicalPath(root, input);
  if (path === root) throw new Error("writing the evidence root is not allowed");
  if (sensitive(path)) throw new Error("writing credential or environment-secret evidence files is not allowed");
  let ancestor = dirname(path);
  while (ancestor !== root) {
    try {
      const actual = await realpath(ancestor);
      if (actual !== root && !actual.startsWith(`${root}${sep}`)) throw new Error("evidence parent resolves outside the submission directory");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      ancestor = dirname(ancestor);
    }
  }
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("evidence target must be a regular file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { root, path };
}

function sensitive(path: string): boolean {
  return SENSITIVE_FILE.test(basename(path)) || SENSITIVE_EXTENSION.test(path);
}

function truncate(value: string, maximum = MAX_TOOL_OUTPUT): string {
  if (Buffer.byteLength(value) <= maximum) return value;
  return `${Buffer.from(value).subarray(0, maximum).toString("utf8")}\n[RB tool output truncated at ${maximum} bytes]`;
}

async function walk(root: string, start: string, maximum: number): Promise<string[]> {
  const results: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (results.length >= maximum) return;
      if (entry.isSymbolicLink()) continue;
      const absolute = resolve(directory, entry.name);
      const path = relative(root, absolute).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        if (OMITTED_DIRECTORIES.has(entry.name) || !isVisibleProjectPath(path)) continue;
        await visit(absolute);
      } else if (entry.isFile() && isVisibleProjectPath(path) && !sensitive(absolute)) results.push(path);
    }
  }
  await visit(start);
  return results;
}

function definitions(context: ApiAgentToolContext): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    {
      name: "list_files",
      description: "List regular, non-secret files recursively below a project-relative directory. Large dependency/build directories are omitted.",
      inputSchema: { type: "object", properties: { path: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 2000 } }, additionalProperties: false },
    },
    {
      name: "read_file",
      description: "Read a bounded line range from one regular, non-secret project file.",
      inputSchema: { type: "object", properties: { path: { type: "string" }, start_line: { type: "integer", minimum: 1 }, end_line: { type: "integer", minimum: 1 } }, required: ["path"], additionalProperties: false },
    },
    {
      name: "search_text",
      description: "Search literal text in regular project files and return path, line, and matching content.",
      inputSchema: { type: "object", properties: { query: { type: "string" }, path: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 500 } }, required: ["query"], additionalProperties: false },
    },
  ];
  // A documentation role gets exactly these three read capabilities: no shell,
  // no Git, no test execution, no subagents, no jobs, no application writes.
  if (isDocumentationRole(context.role)) return tools;
  tools.push({
    name: "git_diff",
    description: "Read the current Git status and textual diff without changing the repository.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  });
  if (isWriteRole(context.role)) {
    tools.push(
      {
        name: "write_file",
        description: "Create or replace one UTF-8 file. Harness generation is restricted to .rb; Ralph may not edit planning/control-plane paths.",
        inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false },
      },
      {
        name: "replace_text",
        description: "Replace one exact, unique text occurrence in a UTF-8 file. Fails when the old text is missing or repeated.",
        inputSchema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"], additionalProperties: false },
      },
    );
  }
  if (context.role === "ralph-agent") {
    if (context.evidenceDirectory) {
      tools.push({
        name: "write_evidence",
        description: "Write one optional UTF-8 evidence file into the executor submission directory owned by Ralph.",
        inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false },
      });
    }
    tools.push({
      name: "run_command",
      description: "Run one executable directly (never through a shell) in the project. Available only to the Ralph executor in YOLO mode.",
      inputSchema: {
        type: "object",
        properties: {
          argv: { type: "array", minItems: 1, maxItems: 64, items: { type: "string" } },
          cwd: { type: "string" },
          timeout_seconds: { type: "integer", minimum: 1, maximum: 900 },
        },
        required: ["argv"],
        additionalProperties: false,
      },
    });
  }
  return tools;
}

export function apiAgentToolDefinitions(context: ApiAgentToolContext): ToolDefinition[] {
  return definitions(context);
}

async function command(argv: string[], cwd: string, timeoutSeconds: number): Promise<string> {
  if (!argv.length || argv.some((entry) => typeof entry !== "string" || entry.includes("\0"))) throw new Error("argv must contain safe strings");
  return await new Promise<string>((resolveRun, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd,
      detached: process.platform !== "win32",
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let overflow = false;
    const observe = (chunk: Buffer) => {
      if (Buffer.byteLength(output) < MAX_TOOL_OUTPUT) output += chunk.toString("utf8");
      else overflow = true;
    };
    child.stdout.on("data", observe);
    child.stderr.on("data", observe);
    const timer = setTimeout(() => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch { child.kill("SIGTERM"); }
    }, timeoutSeconds * 1000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolveRun(truncate(`${output}${overflow ? "\n[output truncated]" : ""}\n[exit=${code ?? 1}${signal ? ` signal=${signal}` : ""}]`));
    });
  });
}

/**
 * Charge one call against the documentation budget. Repeated identical calls
 * make no progress; after the repeat limit the runtime refuses them and says
 * so, instead of letting a stuck model burn the whole budget on one query.
 */
function chargeToolCall(context: ApiAgentToolContext, name: string, input: Record<string, unknown>): void {
  const governor = context.governor;
  if (!governor || !isDocumentationRole(context.role)) return;
  governor.calls += 1;
  if (governor.calls > HARNESS_BUDGET.tools.maxCalls) {
    throw new Error(
      `the documentation tool budget of ${HARNESS_BUDGET.tools.maxCalls} calls is exhausted; write the documents from the evidence already gathered`,
    );
  }
  if (governor.outputBytes > HARNESS_BUDGET.tools.accumulatedOutputBytes) {
    throw new Error(
      `the documentation tool output budget of ${HARNESS_BUDGET.tools.accumulatedOutputBytes} bytes is exhausted; write the documents from the evidence already gathered`,
    );
  }
  const signature = `${name}\u0000${JSON.stringify(input, Object.keys(input).sort())}`;
  governor.repeats = signature === governor.lastSignature ? governor.repeats + 1 : 1;
  governor.lastSignature = signature;
  if (governor.repeats >= HARNESS_BUDGET.tools.repeatCallLimit) {
    throw new Error(`${name} was called with identical arguments ${governor.repeats} times without progress; change approach or conclude`);
  }
}

function recordToolOutput(context: ApiAgentToolContext, output: string): string {
  if (context.governor && isDocumentationRole(context.role)) {
    const bounded = truncate(output, HARNESS_BUDGET.tools.maxOutputBytes);
    context.governor.outputBytes += Buffer.byteLength(bounded);
    return bounded;
  }
  return output;
}

export async function executeApiAgentTool(
  context: ApiAgentToolContext,
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
  chargeToolCall(context, name, input);
  return recordToolOutput(context, await runApiAgentTool(context, name, input));
}

async function runApiAgentTool(
  context: ApiAgentToolContext,
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
  const documentation = isDocumentationRole(context.role);
  const root = await realpath(context.projectRoot);
  if (name === "list_files") {
    const start = await existingPath(root, relativeInput(input.path), documentation);
    if (!(await lstat(start)).isDirectory()) throw new Error("list_files path must be a directory");
    const ceiling = documentation ? HARNESS_BUDGET.tools.maxListedFiles : 2000;
    const limit = Number.isInteger(input.limit) ? Math.min(ceiling, Math.max(1, Number(input.limit))) : Math.min(ceiling, 500);
    const files = await walk(root, start, limit + 1);
    const overflow = files.length > limit;
    return `${files.slice(0, limit).join("\n")}${overflow ? `\n[listing truncated at ${limit} files]` : ""}`;
  }
  if (name === "read_file") {
    const path = await existingPath(root, relativeInput(input.path), documentation);
    if (sensitive(path)) throw new Error("reading credential or environment-secret files is not allowed");
    if (!(await lstat(path)).isFile()) throw new Error("read_file path must be a regular file");
    const lines = (await readFile(path, "utf8")).split(/\r?\n/);
    const start = Number.isInteger(input.start_line) ? Math.max(1, Number(input.start_line)) : 1;
    const span = documentation ? HARNESS_BUDGET.tools.maxReadLines : 1000;
    const end = Number.isInteger(input.end_line) ? Math.min(lines.length, Number(input.end_line)) : Math.min(lines.length, start + span - 1);
    if (end < start || end - start >= span) throw new Error(`read_file supports at most ${span} ordered lines`);
    return truncate(lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join("\n"));
  }
  if (name === "search_text") {
    const query = assertString(input.query, "query", 1000);
    const start = await existingPath(root, relativeInput(input.path), documentation);
    const ceiling = documentation ? HARNESS_BUDGET.tools.maxSearchMatches : 500;
    const limit = Number.isInteger(input.limit) ? Math.min(ceiling, Math.max(1, Number(input.limit))) : Math.min(ceiling, 100);
    const info = await lstat(start);
    const files = info.isFile()
      ? [relative(root, start).replaceAll("\\", "/")].filter((file) => !documentation || isVisibleProjectPath(file))
      : await walk(root, start, 10_000);
    const matches: string[] = [];
    for (const file of files) {
      if (matches.length >= limit) break;
      const absolute = resolve(root, file);
      const metadata = await lstat(absolute);
      if (metadata.size > 2 * 1024 * 1024) continue;
      const lines = (await readFile(absolute, "utf8").catch(() => "")).split(/\r?\n/);
      lines.forEach((line, index) => {
        if (matches.length < limit && line.includes(query)) matches.push(`${file}:${index + 1}:${line}`);
      });
    }
    return truncate(matches.length ? matches.join("\n") : "[no literal matches]");
  }
  if (name === "git_diff") {
    return await command(["git", "status", "--short"], root, 30) + "\n" + await command(["git", "diff", "--no-ext-diff", "--"], root, 60);
  }
  if (name === "write_file") {
    const path = await writablePath(context, relativeInput(input.path));
    if (typeof input.content !== "string" || Buffer.byteLength(input.content) > 4 * 1024 * 1024) throw new Error("content must be a UTF-8 string of at most 4 MiB");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, input.content, { encoding: "utf8", mode: 0o644 });
    return `wrote ${relative(root, path).replaceAll("\\", "/")} (${Buffer.byteLength(input.content)} bytes)`;
  }
  if (name === "replace_text") {
    const path = await writablePath(context, relativeInput(input.path));
    const oldText = assertString(input.old_text, "old_text", 512 * 1024);
    if (typeof input.new_text !== "string" || input.new_text.length > 512 * 1024) throw new Error("new_text must be a string of at most 512 KiB");
    const source = await readFile(path, "utf8");
    const first = source.indexOf(oldText);
    if (first < 0) throw new Error("old_text was not found");
    if (source.indexOf(oldText, first + oldText.length) >= 0) throw new Error("old_text is not unique");
    await writeFile(path, `${source.slice(0, first)}${input.new_text}${source.slice(first + oldText.length)}`, "utf8");
    return `replaced one occurrence in ${relative(root, path).replaceAll("\\", "/")}`;
  }
  if (name === "run_command") {
    if (context.role !== "ralph-agent") throw new Error("run_command is available only to the Ralph executor");
    if (context.permissionMode !== "yolo") throw new Error("direct API execution cannot provide an OS sandbox; use --yolo or a sandboxed CLI provider");
    if (!Array.isArray(input.argv) || !input.argv.length || input.argv.length > 64) throw new Error("argv must contain 1-64 strings");
    const argv = input.argv.map((entry, index) => assertString(entry, `argv[${index}]`, 8192));
    const cwd = await existingPath(root, relativeInput(input.cwd, "cwd"), false);
    if (!(await lstat(cwd)).isDirectory()) throw new Error("command cwd must be a directory");
    const timeout = Number.isInteger(input.timeout_seconds) ? Math.min(900, Math.max(1, Number(input.timeout_seconds))) : 300;
    return await command(argv, cwd, timeout);
  }
  if (name === "write_evidence") {
    const { root: evidenceRoot, path } = await evidenceWritablePath(context, relativeInput(input.path));
    if (typeof input.content !== "string" || Buffer.byteLength(input.content) > 1024 * 1024) throw new Error("evidence content must be a string of at most 1 MiB");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, input.content, { encoding: "utf8", mode: 0o600 });
    return `wrote evidence ${relative(evidenceRoot, path).replaceAll("\\", "/")}`;
  }
  throw new Error(`unknown RB API agent tool: ${name}`);
}
