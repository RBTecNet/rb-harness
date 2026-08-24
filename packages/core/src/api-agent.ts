import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import {
  apiAgentToolDefinitions,
  createToolGovernor,
  executeApiAgentTool,
  isDocumentationRole,
  type ApiAgentRole,
  type ApiAgentToolContext,
} from "./api-agent-tools.js";
import { HARNESS_BUDGET } from "./harness-budget.js";
import { resolveCredential } from "./credential-store.js";
import { directProvider, type DirectProviderId } from "./provider-registry.js";

export interface DirectApiAgentOptions {
  provider: DirectProviderId;
  model: string;
  effort: string;
  projectRoot: string;
  role: ApiAgentRole;
  permissionMode: "yolo" | "protected";
  credential?: string;
  artifactDirectory?: string;
  evidenceDirectory?: string;
  prompt: string;
}

interface UsageTotals {
  requests: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function addOpenAiUsage(totals: UsageTotals, usage: Record<string, unknown> | undefined): void {
  totals.requests += 1;
  if (!usage) return;
  const details = usage.prompt_tokens_details as Record<string, unknown> | undefined;
  totals.inputTokens += number(usage.prompt_tokens ?? usage.input_tokens);
  totals.cachedInputTokens += number(details?.cached_tokens ?? usage.cached_input_tokens);
  totals.outputTokens += number(usage.completion_tokens ?? usage.output_tokens);
  totals.totalTokens += number(usage.total_tokens) || number(usage.prompt_tokens ?? usage.input_tokens) + number(usage.completion_tokens ?? usage.output_tokens);
}

function addAnthropicUsage(totals: UsageTotals, usage: Record<string, unknown> | undefined): void {
  totals.requests += 1;
  if (!usage) return;
  totals.inputTokens += number(usage.input_tokens);
  totals.cachedInputTokens += number(usage.cache_read_input_tokens);
  totals.cacheCreationInputTokens += number(usage.cache_creation_input_tokens);
  totals.outputTokens += number(usage.output_tokens);
  totals.totalTokens += number(usage.input_tokens) + number(usage.cache_read_input_tokens)
    + number(usage.cache_creation_input_tokens) + number(usage.output_tokens);
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporary, path);
  await chmod(path, 0o600).catch(() => undefined);
}

/**
 * Report what the provider actually measured. The Harness never invents a
 * token count or a price: an adapter that reports no usage stays unmeasured.
 */
async function writeHarnessUsage(usage: UsageTotals, toolCalls: number): Promise<void> {
  const path = process.env.RB_HARNESS_USAGE_FILE;
  if (!path) return;
  await atomicJson(resolve(path), {
    schema: "rb-harness-usage/v1",
    requests: usage.requests,
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    cacheCreationInputTokens: usage.cacheCreationInputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    toolCalls,
  }).catch(() => undefined);
}

async function writeTelemetry(options: DirectApiAgentOptions, usage: UsageTotals): Promise<void> {
  const path = process.env.RB_RALPH_TELEMETRY_FILE;
  if (!path) return;
  await atomicJson(resolve(path), {
    schema: "rb-ralph-usage/v1",
    provider: options.provider,
    model: options.model,
    effort: options.effort || "default",
    role: process.env.RB_RALPH_ROLE || options.role,
    phaseId: process.env.RB_RALPH_PHASE_ID || "unknown",
    taskId: process.env.RB_RALPH_TASK_ID || null,
    attempt: number(process.env.RB_RALPH_ATTEMPT),
    measured: usage.totalTokens > 0,
    ...usage,
    costUsd: null,
    costSource: "unavailable",
  });
}

function systemInstruction(options: DirectApiAgentOptions): string {
  const permission = options.role === "ralph-agent"
    ? "You are the implementation executor. You may inspect, edit, and run commands through the provided local tools."
    : isDocumentationRole(options.role)
      ? "You are a read-only documentation analyst. You may list, search, and read bounded ranges of the target project; you cannot edit files, run commands, start subagents, or execute the project. Documents are delivered in your final answer envelope, never written to disk."
      : "You are an independent read-only analyst. You may inspect with tools but cannot edit or execute commands.";
  return [
    "You are running inside the RB local API agent runtime.",
    permission,
    "The model itself has no filesystem access. Use the supplied tools for every repository fact or change; never invent tool results.",
    "Project-relative paths are required. Never request credentials, environment-secret files, .git internals, or orchestrator-owned run state.",
    "Gather only the evidence the task needs; the tool budget is finite and repeated identical calls are refused.",
    "Complete the full requested task before returning a final answer. Keep the final answer protocol from the user prompt exact.",
  ].join(" ");
}

function runCapture(command: string, args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code) => resolveRun({ code: code ?? 1, output }));
  });
}

async function authorization(
  options: Pick<DirectApiAgentOptions, "provider" | "credential">,
): Promise<{ headers: Record<string, string>; protocol: string; credentialId: string }> {
  const credential = await resolveCredential(options.provider, options.credential);
  if (credential.record.protocol === "google-adc") {
    let token: { code: number; output: string };
    try { token = await runCapture("gcloud", ["auth", "application-default", "print-access-token"]); }
    catch { throw new Error("Gemini OAuth credential requires the gcloud CLI; run rb-harness --login after installing it"); }
    if (token.code !== 0 || !token.output.trim()) throw new Error("gcloud could not refresh the Gemini OAuth access token; run rb-harness --login again");
    const projectId = credential.record.attributes?.projectId;
    return {
      protocol: credential.record.protocol,
      credentialId: credential.record.id,
      headers: {
        authorization: `Bearer ${token.output.trim()}`,
        ...(projectId ? { "x-goog-user-project": projectId } : {}),
      },
    };
  }
  if (!credential.secret) throw new Error(`credential ${credential.record.id} has no usable secret`);
  if (options.provider === "anthropic") {
    return { protocol: credential.record.protocol, credentialId: credential.record.id, headers: { "x-api-key": credential.secret } };
  }
  return {
    protocol: credential.record.protocol,
    credentialId: credential.record.id,
    headers: { authorization: `Bearer ${credential.secret}` },
  };
}

async function requestJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMilliseconds = 15 * 60 * 1000,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMilliseconds),
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const error = payload.error as Record<string, unknown> | undefined;
    const message = String(error?.message ?? payload.message ?? response.statusText ?? "provider request failed").slice(0, 2000);
    const retry = response.headers.get("retry-after");
    throw new Error(`provider HTTP ${response.status}: ${message}${retry ? `; retry after ${retry}s` : ""}`);
  }
  return payload;
}

export interface DirectProviderProbeOptions {
  provider: DirectProviderId;
  model: string;
  effort?: string;
  credential?: string;
  timeoutSeconds?: number;
}

export interface DirectProviderProbeResult {
  provider: DirectProviderId;
  model: string;
  protocol: string;
  credentialId: string;
  latencyMilliseconds: number;
  response: string;
  pong: boolean;
  totalTokens: number;
}

function compactProbeResponse(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 240);
}

export async function probeDirectProvider(options: DirectProviderProbeOptions): Promise<DirectProviderProbeResult> {
  if (!options.model?.trim()) throw new Error("provider connection test requires --model <provider-model-id>");
  const timeoutSeconds = options.timeoutSeconds ?? 60;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 900) {
    throw new Error("provider connection test timeout must be an integer between 1 and 900 seconds");
  }
  const definition = directProvider(options.provider);
  const auth = await authorization({ provider: options.provider, credential: options.credential });
  const prompt = "PING. Reply with exactly PONG and nothing else.";
  const startedAt = Date.now();
  let payload: Record<string, unknown>;
  if (definition.dialect === "anthropic-messages") {
    const body: Record<string, unknown> = {
      model: options.model,
      max_tokens: 64,
      messages: [{ role: "user", content: prompt }],
    };
    if (options.effort) body.output_config = { effort: options.effort };
    payload = await requestJson(definition.endpoint, {
      ...auth.headers,
      "anthropic-version": "2023-06-01",
    }, body, timeoutSeconds * 1000);
  } else {
    const body: Record<string, unknown> = {
      model: options.model,
      messages: [{ role: "user", content: prompt }],
      stream: false,
    };
    if (options.effort) body.reasoning_effort = options.effort;
    payload = await requestJson(definition.endpoint, {
      ...auth.headers,
      ...(options.provider === "openrouter" ? { "http-referer": "https://github.com/RBTecNet/rb-harness", "x-openrouter-title": "RB Provider Test" } : {}),
    }, body, timeoutSeconds * 1000);
  }
  const latencyMilliseconds = Date.now() - startedAt;
  let responseText = "";
  let totalTokens = 0;
  if (definition.dialect === "anthropic-messages") {
    const content = Array.isArray(payload.content) ? payload.content.map(parseObject) : [];
    responseText = content.filter((block) => block.type === "text").map((block) => String(block.text ?? "")).join(" ");
    const usage = parseObject(payload.usage);
    totalTokens = number(usage.input_tokens) + number(usage.output_tokens);
    if (!content.length) throw new Error("provider connection test returned no Anthropic content blocks");
  } else {
    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    const message = parseObject(parseObject(choices[0]).message);
    if (!Object.keys(message).length) throw new Error("provider connection test returned no assistant message");
    responseText = typeof message.content === "string"
      ? message.content
      : String(message.reasoning_content ?? "");
    totalTokens = number(parseObject(payload.usage).total_tokens);
  }
  const response = compactProbeResponse(responseText) || "[assistant response received]";
  return {
    provider: options.provider,
    model: options.model,
    protocol: auth.protocol,
    credentialId: auth.credentialId,
    latencyMilliseconds,
    response,
    pong: /\bPONG\b/i.test(response),
    totalTokens,
  };
}

/**
 * The tool catalog is computed once per session and never mutated. Mode
 * restrictions are execution rules enforced inside the tools, not opportunistic
 * schema edits: a catalog that changes between steps invalidates the provider
 * prefix cache on every turn and silently multiplies input cost.
 */
function openAiTools(context: ApiAgentToolContext): unknown[] {
  return apiAgentToolDefinitions(context).map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  }));
}

function anthropicTools(context: ApiAgentToolContext): unknown[] {
  const tools = apiAgentToolDefinitions(context).map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
  // Cache the stable system + tool prefix; new evidence enters append-only.
  const last = tools.at(-1);
  return last ? [...tools.slice(0, -1), { ...last, cache_control: { type: "ephemeral" } }] : tools;
}

function maximumTurns(role: ApiAgentRole): number {
  return isDocumentationRole(role) ? HARNESS_BUDGET.tools.maxCalls : 80;
}

function parseObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

const READ_ONLY_TOOLS = new Set(["list_files", "read_file", "search_text"]);

/**
 * Independent reads run concurrently; anything that can mutate state stays
 * strictly sequential. Results are always returned in the model's original
 * call order so the transcript — and therefore the cache prefix — is
 * deterministic regardless of completion order.
 */
async function executeCalls(context: ApiAgentToolContext, calls: ToolCall[]): Promise<Array<{ call: ToolCall; output: string }>> {
  const run = async (call: ToolCall): Promise<{ call: ToolCall; output: string }> => {
    process.stderr.write(`[rb-tool] ${call.name}\n`);
    try { return { call, output: await executeApiAgentTool(context, call.name, call.input) }; }
    catch (error) { return { call, output: `ERROR: ${error instanceof Error ? error.message : String(error)}` }; }
  };
  if (calls.length > 1 && calls.every((call) => READ_ONLY_TOOLS.has(call.name))) {
    return Promise.all(calls.map(run));
  }
  const results: Array<{ call: ToolCall; output: string }> = [];
  for (const call of calls) results.push(await run(call));
  return results;
}

async function runOpenAiDialect(
  options: DirectApiAgentOptions,
  headers: Record<string, string>,
  context: ApiAgentToolContext,
  usage: UsageTotals,
  counters: { toolCalls: number },
): Promise<string> {
  const definition = directProvider(options.provider);
  // Byte-stable prefix: system instruction, prompt, and tool catalog are
  // serialized once; every later turn only appends to `messages`.
  const tools = openAiTools(context);
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: systemInstruction(options) },
    { role: "user", content: options.prompt },
  ];
  const turns = maximumTurns(options.role);
  for (let turn = 1; turn <= turns; turn += 1) {
    const body: Record<string, unknown> = {
      model: options.model,
      messages,
      tools,
      tool_choice: "auto",
      stream: false,
    };
    if (options.effort) body.reasoning_effort = options.effort;
    if (options.provider === "deepseek") body.thinking = { type: "enabled" };
    const payload = await requestJson(definition.endpoint, {
      ...headers,
      ...(options.provider === "openrouter" ? { "http-referer": "https://github.com/RBTecNet/rb-harness", "x-openrouter-title": "RB Harness / RB Ralph" } : {}),
    }, body);
    addOpenAiUsage(usage, parseObject(payload.usage));
    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    const choice = parseObject(choices[0]);
    const message = parseObject(choice.message);
    if (!Object.keys(message).length) throw new Error("provider response did not contain an assistant message");
    messages.push(message);
    const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    const calls = rawCalls.map((raw, index): ToolCall => {
      const entry = parseObject(raw);
      const fn = parseObject(entry.function);
      let input: Record<string, unknown>;
      try { input = parseObject(JSON.parse(String(fn.arguments ?? "{}"))); }
      catch { input = { __invalid_arguments: String(fn.arguments ?? "") }; }
      return { id: String(entry.id ?? `call-${turn}-${index}`), name: String(fn.name ?? ""), input };
    }).filter((call) => call.name);
    if (!calls.length) {
      const content = typeof message.content === "string" ? message.content : "";
      if (!content.trim()) throw new Error(`provider stopped without a final response (finish_reason=${String(choice.finish_reason ?? "unknown")})`);
      return content;
    }
    counters.toolCalls += calls.length;
    for (const result of await executeCalls(context, calls)) {
      messages.push({ role: "tool", tool_call_id: result.call.id, content: result.output });
    }
  }
  throw new Error(`direct API agent exceeded ${turns} tool-use turns`);
}

async function runAnthropicDialect(
  options: DirectApiAgentOptions,
  headers: Record<string, string>,
  context: ApiAgentToolContext,
  usage: UsageTotals,
  counters: { toolCalls: number },
): Promise<string> {
  const tools = anthropicTools(context);
  const system = [{ type: "text", text: systemInstruction(options), cache_control: { type: "ephemeral" } }];
  const messages: Array<Record<string, unknown>> = [{ role: "user", content: options.prompt }];
  const turns = maximumTurns(options.role);
  for (let turn = 1; turn <= turns; turn += 1) {
    const body: Record<string, unknown> = {
      model: options.model,
      max_tokens: 32768,
      system,
      messages,
      tools,
    };
    if (options.effort) body.output_config = { effort: options.effort };
    const payload = await requestJson(directProvider(options.provider).endpoint, {
      ...headers,
      "anthropic-version": "2023-06-01",
    }, body);
    addAnthropicUsage(usage, parseObject(payload.usage));
    const content = Array.isArray(payload.content) ? payload.content.map(parseObject) : [];
    messages.push({ role: "assistant", content });
    const calls = content.filter((block) => block.type === "tool_use").map((block, index): ToolCall => ({
      id: String(block.id ?? `tool-${turn}-${index}`),
      name: String(block.name ?? ""),
      input: parseObject(block.input),
    })).filter((call) => call.name);
    if (!calls.length) {
      const text = content.filter((block) => block.type === "text").map((block) => String(block.text ?? "")).join("\n");
      if (!text.trim()) throw new Error(`Anthropic stopped without a final text response (stop_reason=${String(payload.stop_reason ?? "unknown")})`);
      return text;
    }
    counters.toolCalls += calls.length;
    const results = await executeCalls(context, calls);
    messages.push({
      role: "user",
      content: results.map((result) => ({ type: "tool_result", tool_use_id: result.call.id, content: result.output })),
    });
  }
  throw new Error(`direct Anthropic agent exceeded ${turns} tool-use turns`);
}

export async function runDirectApiAgent(options: DirectApiAgentOptions): Promise<string> {
  if (!options.model.trim()) throw new Error(`direct provider ${options.provider} requires --model <provider-model-id>`);
  if (Buffer.byteLength(options.prompt) > 2 * 1024 * 1024) throw new Error("direct API agent prompt exceeds 2 MiB");
  if (options.role === "ralph-agent" && options.permissionMode === "protected") {
    throw new Error("direct API executors do not provide an OS sandbox in protected mode; use --yolo or codex/claude/opencode");
  }
  const projectRoot = resolve(options.projectRoot);
  const context: ApiAgentToolContext = {
    projectRoot,
    role: options.role,
    permissionMode: options.permissionMode,
    artifactDirectory: options.artifactDirectory,
    evidenceDirectory: options.evidenceDirectory,
    ...(isDocumentationRole(options.role) ? { governor: createToolGovernor() } : {}),
  };
  const auth = await authorization(options);
  const counters = { toolCalls: 0 };
  const usage: UsageTotals = { requests: 0, inputTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 0, totalTokens: 0 };
  try {
    const definition = directProvider(options.provider);
    const result = definition.dialect === "anthropic-messages"
      ? await runAnthropicDialect(options, auth.headers, context, usage, counters)
      : await runOpenAiDialect(options, auth.headers, context, usage, counters);
    await writeTelemetry(options, usage);
    await writeHarnessUsage(usage, counters.toolCalls);
    return result;
  } catch (error) {
    await writeTelemetry(options, usage).catch(() => undefined);
    await writeHarnessUsage(usage, counters.toolCalls).catch(() => undefined);
    throw error;
  }
}

export async function readPromptFromStdin(maximum = 2 * 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stdin) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.length;
    if (bytes > maximum) throw new Error(`stdin prompt exceeds ${maximum} bytes`);
    chunks.push(value);
  }
  const prompt = Buffer.concat(chunks).toString("utf8");
  if (!prompt.trim()) throw new Error("direct API agent requires a prompt on stdin");
  return prompt;
}

export async function runDirectApiAgentCli(options: Omit<DirectApiAgentOptions, "prompt">): Promise<void> {
  const result = await runDirectApiAgent({ ...options, prompt: await readPromptFromStdin() });
  stdout.write(result.endsWith("\n") ? result : `${result}\n`);
}
