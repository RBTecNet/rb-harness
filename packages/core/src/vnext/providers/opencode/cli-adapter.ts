import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { spawnProcessTree, type SettleOutcome } from "../../../process-tree.js";
import type {
  CanonicalSemanticResponse, ExternalCliInvocationPolicyEvidence, ModelProfile, ProviderAdapter, ProviderOutcome, ResolvedProviderAuth, SemanticRequest,
} from "../contract.js";
import { decodeOpenCodeCliJsonl, isOpenCodeCliRawResponse, normalizeOpenCodeCli, observeOpenCodeCli, usageFromOpenCodeCli, type OpenCodeCliRawResponse } from "./cli-normalize.js";
import { OPENCODE_CLI_PROFILES, openCodeProfileConfiguration } from "./profiles.js";

export const OPENCODE_AMBIENT_AUTH_ID = "opencode-ambient-session";
export const OPENCODE_EXECUTABLE = "opencode";
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;

export interface OpenCodeCommandInput {
  readonly executable: string;
  readonly args: readonly string[];
  readonly stdin: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  readonly deadlineMs: number;
}

export interface OpenCodeCommandResult {
  readonly stdout: string;
  readonly exitCode: number | null;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly firstOutputMs?: number;
  readonly cancelled: boolean;
  readonly timedOut: boolean;
  readonly outputLimitExceeded: boolean;
  readonly spawnFailed?: boolean;
  readonly settlement: SettleOutcome;
}

export interface OpenCodeProcess { run(input: OpenCodeCommandInput): Promise<OpenCodeCommandResult> }

export interface OpenCodeCliIdentityFacts {
  readonly assistantMessageCount: number;
  readonly observedModelIds: readonly string[];
}

const SESSION_ID = /^ses_[A-Za-z0-9_-]{1,120}$/;
const IDENTITY_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Whitelist the one transient session identifier needed for the metadata-only export. */
export function extractOpenCodeCliSessionId(stdout: string): string | undefined {
  const ids = new Set<string>();
  try {
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const event = record(JSON.parse(line));
      const properties = record(event.properties);
      const part = record(event.part ?? properties.part);
      for (const candidate of [event.sessionID, properties.sessionID, part.sessionID]) {
        if (typeof candidate === "string" && SESSION_ID.test(candidate)) ids.add(candidate);
      }
    }
  } catch { return undefined; }
  return ids.size === 1 ? [...ids][0] : undefined;
}

/** Parse an export transiently and retain assistant count plus exact provider/model identity only. */
export function decodeOpenCodeSessionExport(stdout: string): OpenCodeCliIdentityFacts | undefined {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    const root = record(parsed);
    const messages = Array.isArray(root.messages) ? root.messages : Array.isArray(parsed) ? parsed : [];
    let assistantMessageCount = 0;
    const observedModelIds = new Set<string>();
    for (const message of messages) {
      const info = record(record(message).info);
      if (info.role !== "assistant") continue;
      assistantMessageCount += 1;
      const provider = info.providerID;
      const model = info.modelID;
      if (typeof provider === "string" && IDENTITY_COMPONENT.test(provider)
        && typeof model === "string" && IDENTITY_COMPONENT.test(model)) {
        observedModelIds.add(`${provider}/${model}`);
      }
    }
    return { assistantMessageCount, observedModelIds: [...observedModelIds].sort() };
  } catch { return undefined; }
}

function lineHasVisibleText(line: string): boolean {
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    const properties = event.properties && typeof event.properties === "object" ? event.properties as Record<string, unknown> : {};
    const value = event.part ?? properties.part;
    const part = value && typeof value === "object" ? value as Record<string, unknown> : {};
    return part.type === "text" && typeof part.text === "string" && part.text.length > 0;
  } catch { return false; }
}

export function openCodeChildEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed = new Set([
    "PATH", "HOME", "TMPDIR", "TEMP", "TMP", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME",
    "LANG", "LANGUAGE", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
    "SystemRoot", "WINDIR", "ComSpec", "PATHEXT",
  ]);
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && (allowed.has(key) || /^LC_[A-Z_]+$/.test(key))) environment[key] = value;
  }
  environment.OPENCODE_CONFIG_CONTENT = JSON.stringify({ permission: "deny", instructions: [] });
  environment.OPENCODE_DISABLE_CLAUDE_CODE = "1";
  environment.DO_NOT_TRACK = "1";
  return environment;
}

export async function withOpenCodeIsolation<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(resolve(tmpdir(), "rb-vnext-opencode-"));
  try { return await run(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

export class SpawnOpenCodeProcess implements OpenCodeProcess {
  async run(input: OpenCodeCommandInput): Promise<OpenCodeCommandResult> {
    const started = Date.now();
    const handle = spawnProcessTree(input.executable, [...input.args], { cwd: input.cwd, env: input.env, stdio: ["pipe", "pipe", "ignore"] });
    let stdout = "";
    let firstOutputMs: number | undefined;
    let cancelled = false;
    let timedOut = false;
    let outputLimitExceeded = false;
    let spawnFailed = false;
    const decoder = new StringDecoder("utf8");
    let lineBuffer = "";
    handle.child.stdout?.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(stdout) + chunk.byteLength > MAX_CAPTURE_BYTES) {
        outputLimitExceeded = true;
        handle.terminate("OpenCode output exceeded capture limit");
      } else {
        const text = decoder.write(chunk);
        stdout += text;
        lineBuffer += text;
        const lines = lineBuffer.split(/\r?\n/);
        lineBuffer = lines.pop() ?? "";
        if (firstOutputMs === undefined && lines.some(lineHasVisibleText)) firstOutputMs = Date.now() - started;
      }
    });
    const onAbort = (): void => { cancelled = true; handle.terminate("OpenCode request cancelled"); };
    input.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; handle.terminate("OpenCode request deadline elapsed"); }, input.deadlineMs);
    const exit = new Promise<number | null>((done) => {
      handle.child.once("error", () => { spawnFailed = true; done(null); });
      handle.child.once("close", (code) => done(code));
    });
    handle.child.stdin?.end(input.stdin, "utf8");
    try {
      const exitCode = await exit;
      const tail = decoder.end();
      stdout += tail;
      lineBuffer += tail;
      if (firstOutputMs === undefined && lineBuffer.trim() && lineHasVisibleText(lineBuffer)) firstOutputMs = Date.now() - started;
      const settlement = await handle.settle("OpenCode command completed");
      return {
        stdout, exitCode, startedAt: new Date(started).toISOString(), completedAt: new Date().toISOString(),
        ...(firstOutputMs === undefined ? {} : { firstOutputMs }), cancelled, timedOut,
        outputLimitExceeded, ...(spawnFailed ? { spawnFailed: true } : {}), settlement,
      };
    } finally {
      clearTimeout(timer);
      input.signal.removeEventListener("abort", onAbort);
      handle.dispose();
    }
  }
}

export interface OpenCodeRuntimePreflight { readonly executable: string; readonly transportVersion: string }

export function openCodeCliArgs(profile: ModelProfile, request: SemanticRequest, cwd: string): readonly string[] {
  return ["--pure", "run", "--dir", cwd, "--format", "json", "--model", profile.modelId,
    ...(request.reasoning.mode === "on" ? ["--variant", request.reasoning.effort] : [])];
}

export function currentOpenCodeCliInvocationPolicy(profile: ModelProfile): ExternalCliInvocationPolicyEvidence {
  return {
    format: "rb-external-cli-invocation-policy/v1",
    outputMode: "json",
    transportFraming: "jsonl",
    inputMode: "stdin",
    ambientAuth: true,
    modelArgument: profile.modelId,
    directoryIsolation: "isolated-temporary",
    stderrPolicy: "ignored-not-recorded",
    pluginMode: "pure",
    toolPolicy: "deny",
    externalInstructions: "disabled",
    legacyCompatibilityRules: "disabled",
    environmentPolicy: "allowlisted",
    modelBearingProcessesPerSemanticRequest: 1,
    metadataProcessesPerSemanticRequest: 1,
    identitySource: "session-export",
    transportRetryLimit: 0,
  };
}

function prompt(request: SemanticRequest): string {
  return `${request.instructions}\nReturn exactly one JSON value matching schema '${request.schemaName}'. No Markdown, tools, or explanation. Schema: ${JSON.stringify(request.schema)}\nInput:\n${request.input}`;
}

function unsupported(message: string): ProviderOutcome<never> {
  return { ok: false, error: { kind: "unsupported-capability", message, transportRetryable: false } };
}

export function preflightOpenCodeCli(profile: ModelProfile, request: SemanticRequest): ProviderOutcome<true> {
  const config = openCodeProfileConfiguration(profile);
  if (profile.family !== "opencode" || profile.transport !== "opencode-cli" || !config || config.mode !== "cli") return unsupported(`unknown OpenCode CLI profile: ${profile.id}`);
  if (profile.structuredOutput !== "json-mode" || profile.strictSchema) return unsupported("OpenCode CLI requires prompt-constrained JSON over JSONL transport");
  if (!Number.isInteger(request.limits.maxOutputTokens) || request.limits.maxOutputTokens < 1 || request.limits.maxOutputTokens > profile.maxOutputTokens) return unsupported(`invalid output limit for ${profile.id}`);
  if (!Number.isFinite(request.limits.deadlineMs) || request.limits.deadlineMs <= 0) return unsupported("deadlineMs must be positive");
  if (request.reasoning.mode === "on" && (!profile.reasoning.supported || !profile.reasoning.efforts.includes(request.reasoning.effort))) return unsupported(`reasoning effort '${request.reasoning.effort}' is not supported by ${profile.id}`);
  return { ok: true, value: true };
}

export class OpenCodeCliAdapter implements ProviderAdapter {
  readonly family = "opencode";
  readonly transport = "opencode-cli" as const;
  readonly profiles = OPENCODE_CLI_PROFILES;
  constructor(private readonly processClient: OpenCodeProcess = new SpawnOpenCodeProcess(), private readonly executable = process.env.RB_HARNESS_OPENCODE_BIN || OPENCODE_EXECUTABLE) {}
  acceptsProfile(profile: ModelProfile): boolean { return profile.family === "opencode" && profile.transport === "opencode-cli" && Boolean(openCodeProfileConfiguration(profile)); }
  checkCapabilities(profile: ModelProfile, request: SemanticRequest): ProviderOutcome<true> { return preflightOpenCodeCli(profile, request); }
  observeRuntime(raw: unknown) { return observeOpenCodeCli(raw); }
  currentExternalCliInvocationPolicy(profile: ModelProfile): ExternalCliInvocationPolicyEvidence { return currentOpenCodeCliInvocationPolicy(profile); }
  replay(profile: ModelProfile, request: SemanticRequest, raw: unknown): ProviderOutcome<CanonicalSemanticResponse> {
    const checked = preflightOpenCodeCli(profile, request);
    if (!checked.ok) return checked;
    if (!isOpenCodeCliRawResponse(raw)) return { ok: false, error: { kind: "malformed-syntax", message: "recorded OpenCode CLI response is invalid", transportRetryable: false } };
    return normalizeOpenCodeCli(profile, request, raw);
  }
  async runtimePreflight(): Promise<ProviderOutcome<OpenCodeRuntimePreflight>> {
    const controller = new AbortController();
    const result = await withOpenCodeIsolation((directory) => this.processClient.run({
      executable: this.executable, args: ["--version"], stdin: "", cwd: directory,
      env: openCodeChildEnvironment(), signal: controller.signal, deadlineMs: 10_000,
    }));
    const version = result.stdout.match(/(?:OpenCode\s+)?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/i)?.[1];
    return result.exitCode === 0 && version
      ? { ok: true, value: { executable: this.executable, transportVersion: version } }
      : { ok: false, error: { kind: "transport", message: "OpenCode CLI version preflight failed", transportRetryable: false } };
  }
  async request(profile: ModelProfile, auth: ResolvedProviderAuth, request: SemanticRequest): Promise<ProviderOutcome<CanonicalSemanticResponse>> {
    const checked = preflightOpenCodeCli(profile, request);
    if (!checked.ok) return checked;
    if (auth.kind !== "ambient-session" || auth.id !== OPENCODE_AMBIENT_AUTH_ID) return { ok: false, error: { kind: "auth", message: "OpenCode CLI requires its ambient session", transportRetryable: false, usage: usageFromOpenCodeCli(profile) } };
    if (request.signal.aborted) return { ok: false, error: { kind: "cancelled", message: "OpenCode CLI request was cancelled before process launch", transportRetryable: false, usage: usageFromOpenCodeCli(profile) } };
    return withOpenCodeIsolation(async (root) => {
      const result = await this.processClient.run({ executable: this.executable, args: openCodeCliArgs(profile, request, root), stdin: prompt(request), cwd: root, env: openCodeChildEnvironment(), signal: request.signal, deadlineMs: request.limits.deadlineMs });
      if (result.timedOut) return { ok: false, error: { kind: "timeout", message: "OpenCode CLI request exceeded its deadline", transportRetryable: true, usage: usageFromOpenCodeCli(profile) } };
      if (result.cancelled) return { ok: false, error: { kind: "cancelled", message: "OpenCode CLI request was cancelled", transportRetryable: false, usage: usageFromOpenCodeCli(profile) } };
      if (result.spawnFailed) return { ok: false, error: { kind: "transport", message: "OpenCode CLI process could not be started", transportRetryable: false, usage: usageFromOpenCodeCli(profile) } };
      if (result.outputLimitExceeded) return { ok: false, error: { kind: "output-truncated", message: "OpenCode CLI output exceeded the bounded capture limit", transportRetryable: false, usage: usageFromOpenCodeCli(profile) } };
      if (result.exitCode !== 0) {
        const decoded = decodeOpenCodeCliJsonl(result.stdout, {
          exitCode: result.exitCode, startedAt: result.startedAt, completedAt: result.completedAt,
          ...(result.firstOutputMs === undefined ? {} : { firstOutputMs: result.firstOutputMs }),
          streamComplete: result.exitCode !== null, treeQuiescent: result.settlement.quiescent, treeVerified: result.settlement.verified,
        });
        return decoded.ok ? normalizeOpenCodeCli(profile, request, decoded.value)
          : { ok: false, error: { ...decoded.error, usage: usageFromOpenCodeCli(profile) } };
      }
      const sessionId = extractOpenCodeCliSessionId(result.stdout);
      if (!sessionId) return { ok: false, error: { kind: "provider-error", message: "OpenCode CLI did not expose one exportable session identity", transportRetryable: false, usage: usageFromOpenCodeCli(profile) } };
      const metadata = await this.processClient.run({
        executable: this.executable, args: ["--pure", "export", sessionId, "--sanitize"], stdin: "", cwd: root,
        env: openCodeChildEnvironment(), signal: request.signal, deadlineMs: request.limits.deadlineMs,
      });
      if (metadata.timedOut) return { ok: false, error: { kind: "timeout", message: "OpenCode CLI session export exceeded its deadline", transportRetryable: true, usage: usageFromOpenCodeCli(profile) } };
      if (metadata.cancelled) return { ok: false, error: { kind: "cancelled", message: "OpenCode CLI session export was cancelled", transportRetryable: false, usage: usageFromOpenCodeCli(profile) } };
      if (metadata.spawnFailed || metadata.exitCode !== 0 || !metadata.settlement.quiescent || !metadata.settlement.verified) {
        return { ok: false, error: { kind: "transport", message: "OpenCode CLI session export failed", transportRetryable: false, usage: usageFromOpenCodeCli(profile) } };
      }
      if (metadata.outputLimitExceeded) return { ok: false, error: { kind: "output-truncated", message: "OpenCode CLI session export exceeded the bounded capture limit", transportRetryable: false, usage: usageFromOpenCodeCli(profile) } };
      const identity = decodeOpenCodeSessionExport(metadata.stdout);
      if (!identity) return { ok: false, error: { kind: "provider-error", message: "OpenCode CLI session export did not contain valid identity metadata", transportRetryable: false, usage: usageFromOpenCodeCli(profile) } };
      const raw = decodeOpenCodeCliJsonl(result.stdout, {
        exitCode: result.exitCode, startedAt: result.startedAt, completedAt: result.completedAt,
        ...(result.firstOutputMs === undefined ? {} : { firstOutputMs: result.firstOutputMs }),
        streamComplete: result.exitCode !== null, treeQuiescent: result.settlement.quiescent, treeVerified: result.settlement.verified,
        assistantMessageCount: identity.assistantMessageCount, observedModelIds: identity.observedModelIds,
      });
      return raw.ok ? normalizeOpenCodeCli(profile, request, raw.value)
        : { ok: false, error: { ...raw.error, usage: usageFromOpenCodeCli(profile) } };
    });
  }
}

export const openCodeCliAdapter = new OpenCodeCliAdapter();
