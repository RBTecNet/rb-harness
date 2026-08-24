import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import type { ProviderConfiguration } from "./standalone-types.js";
import { isDirectProvider } from "./provider-registry.js";
import { emitHarnessDashboard, harnessDashboardActive } from "./harness-dashboard.js";
import { HARNESS_BUDGET } from "./harness-budget.js";
import { spawnProcessTree, type SettleOutcome } from "./process-tree.js";
import { describeContainment, detectContainmentSupport, type TreeContainment } from "./process-containment.js";
import {
  describeAdapterControl,
  describeReadConfinement,
  providerCapabilities,
  usesStructuredStdout,
} from "./provider-capabilities.js";
import { ProviderStreamObserver, type StreamAccounting, type StreamDialect } from "./provider-events.js";
import type { StdoutTransport } from "./provider-capabilities.js";
import {
  emptyUsage,
  harnessTelemetry,
  type HarnessStage,
  type ProviderUsage,
} from "./harness-telemetry.js";

/**
 * Documentation roles. `audit` is intentionally absent: the semantic manager
 * was removed from the product path, and no mode may reintroduce it.
 */
export type ProviderMode = "interview" | "generation" | "repair";

export interface ProviderRunOptions {
  configuration: ProviderConfiguration;
  mode: ProviderMode;
  stage: HarnessStage;
  /** Test override for the adapter's declared stream mode. */
  streamMode?: "structured" | "opaque";
  /** Test override for the adapter's event dialect. */
  streamDialect?: StreamDialect;
  /** Test seam: force a specific process-tree containment mechanism. */
  containment?: TreeContainment;
  projectRoot: string;
  prompt: string;
  logPath: string;
  timeoutSeconds: number;
  firstOutputTimeoutSeconds: number;
  streamOutput?: boolean;
  attempt?: number;
  /** Test/embedding override. Standalone workflows use the bounded mode default. */
  maxOutputBytes?: number;
}

export interface ProviderRunResult {
  exitCode: number;
  /**
   * The transcript used for envelope extraction. For an event transport this
   * is the text recovered from the stream; for a final-text transport it is
   * the raw stdout, unchanged.
   */
  stdout: string;
  /** Raw stdout exactly as the adapter wrote it, for the log. */
  rawStdout: string;
  stderr: string;
  firstOutputMilliseconds?: number;
  durationMilliseconds: number;
  usage: ProviderUsage;
  /** What the Harness could actually account for on this adapter. */
  stream: StreamAccounting;
  /** The format this adapter actually wrote to stdout. */
  stdoutTransport: StdoutTransport;
  /** What the teardown could actually prove about the process tree. */
  settlement: SettleOutcome;
}

function safeToken(value: string, label: string): string {
  if (value && !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(value)) {
    throw new Error(`${label} contains unsupported characters`);
  }
  return value;
}

/**
 * Orchestrator-private variables never reach a provider. They would tell the
 * model where the RB Harness installation, resources, and run state live, and
 * the documentation core must work on the target project only.
 */
const PRIVATE_ENVIRONMENT = [
  "RB_HARNESS_RESOURCE_ROOT",
  "RB_HARNESS_DASHBOARD_COLS",
  "RB_HARNESS_SPLASH",
  "RB_HARNESS_SPLASH_MS",
  "RB_HARNESS_USAGE_FILE",
  "RB_RALPH_TELEMETRY_FILE",
  "RB_RALPH_ROLE",
  "RB_RALPH_PHASE_ID",
  "RB_RALPH_TASK_ID",
  "RB_RALPH_ATTEMPT",
];

function providerEnvironment(
  configuration: ProviderConfiguration,
  mode: ProviderMode,
  projectRoot: string,
  model: string,
  effort: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const name of PRIVATE_ENVIRONMENT) delete environment[name];
  environment.RB_HARNESS_MODE = mode;
  environment.RB_HARNESS_PROJECT_ROOT = projectRoot;
  environment.RB_HARNESS_PROVIDER = configuration.provider;
  environment.RB_HARNESS_MODEL = model;
  environment.RB_HARNESS_EFFORT = effort;
  return environment;
}

/**
 * Every documentation role is read-only. The generator returns a typed
 * document bundle on stdout and the orchestrator materializes it, so no
 * provider ever needs write access to the developer's project.
 */
export function providerInvocation(
  configuration: ProviderConfiguration,
  mode: ProviderMode,
  projectRoot: string,
): { command: string; args: string[]; environment: NodeJS.ProcessEnv } {
  const model = safeToken(configuration.model, "model");
  const effort = safeToken(configuration.effort, "effort");
  const environment = providerEnvironment(configuration, mode, projectRoot, model, effort);
  if (configuration.provider === "custom") {
    if (!configuration.command) throw new Error("custom provider requires --adapter <executable>");
    return { command: configuration.command, args: [], environment };
  }
  if (configuration.provider === "codex") {
    const args = [
      "exec", "--cd", projectRoot, "--skip-git-repo-check", "--ephemeral", "--color", "never",
      "--sandbox", "read-only",
    ];
    if (model) args.push("--model", model);
    if (effort) args.push("-c", `model_reasoning_effort=\"${effort}\"`);
    args.push("-");
    return { command: process.env.RB_HARNESS_CODEX_BIN ?? "codex", args, environment };
  }
  if (configuration.provider === "claude") {
    const args = ["-p", "--output-format", "text", "--permission-mode", "plan", "--no-session-persistence"];
    if (model) args.push("--model", model);
    if (effort) args.push("--effort", effort);
    delete environment.CLAUDECODE;
    return { command: process.env.RB_HARNESS_CLAUDE_BIN ?? "claude", args, environment };
  }
  if (isDirectProvider(configuration.provider)) {
    const role = mode === "interview" ? "harness-interview" : mode === "repair" ? "harness-repair" : "harness-generation";
    const script = process.argv[1];
    if (!script) throw new Error("could not resolve the installed RB Harness executable for the direct API runtime");
    const args = [
      script, "_provider-run",
      "--provider", configuration.provider,
      "--model", model,
      "--role", role,
      "--project", projectRoot,
      "--permission", "protected",
    ];
    if (effort) args.push("--effort", effort);
    if (configuration.credential) args.push("--credential", configuration.credential);
    return { command: process.execPath, args, environment };
  }
  // `run --format json` is documented by the installed OpenCode as "raw JSON
  // events". It is the most bounded mode this CLI really supports, so the
  // Harness consumes it and holds the run to the documentation event budget.
  const args = ["run", "--dir", projectRoot, "--format", "json"];
  if (model) args.push("--model", model);
  if (effort) args.push("--variant", effort);
  environment.OPENCODE_PERMISSION = '{"edit":"deny","bash":"deny","task":"deny","external_directory":"deny"}';
  return { command: process.env.RB_HARNESS_OPENCODE_BIN ?? "opencode", args, environment };
}

export function providerOutputLimit(mode: ProviderMode): number {
  if (mode === "generation") return HARNESS_BUDGET.provider.generationOutputBytes;
  if (mode === "repair") return HARNESS_BUDGET.provider.repairOutputBytes;
  return HARNESS_BUDGET.provider.interviewOutputBytes;
}

function outputLimitDiagnostic(bytes: number): string {
  if (bytes % (1024 * 1024) === 0) return `provider output exceeded ${bytes / (1024 * 1024)} MiB`;
  return `provider output exceeded ${bytes} bytes`;
}

function redactLog(value: string, environment: NodeJS.ProcessEnv): string {
  const secrets = Object.entries(environment)
    .filter(([name, secret]) => /(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name) && typeof secret === "string" && secret.length >= 8)
    .sort((left, right) => right[1]!.length - left[1]!.length);
  let redacted = value;
  for (const [name, secret] of secrets) redacted = redacted.split(secret!).join(`[REDACTED:${name}]`);
  return redacted;
}

async function writeProviderLog(
  options: ProviderRunOptions,
  environment: NodeJS.ProcessEnv,
  result: Pick<ProviderRunResult, "exitCode" | "stdout" | "stderr" | "firstOutputMilliseconds">,
  diagnostic?: string,
  stream?: StreamAccounting,
  settlementRecord?: SettleOutcome,
  stdoutTransport?: StdoutTransport,
): Promise<void> {
  await writeFile(options.logPath, [
    `provider=${options.configuration.provider}`,
    `model=${options.configuration.model || "provider-default"}`,
    `effort=${options.configuration.effort || "provider-default"}`,
    `mode=${options.mode}`,
    `stage=${options.stage}`,
    `exit_code=${result.exitCode}`,
    `first_output_ms=${result.firstOutputMilliseconds ?? "none"}`,
    ...(stdoutTransport ? [`stdout_transport=${stdoutTransport}`] : []),
    ...(stream
      ? [
        `stream_mode=${stream.mode}${stream.degraded ? " (degraded to unmeasured)" : ""}`,
        `stream_events=${stream.events}`,
        `stream_tool_events=${stream.toolEvents}`,
        `stream_turn_events=${stream.turnEvents}`,
      ]
      : []),
    ...(settlementRecord
      ? [
        `tree_containment=${settlementRecord.containment.kind}`,
        `tree_containment_structural=${settlementRecord.containment.structural}`,
        `tree_observed=${settlementRecord.observed}`,
        `tree_quiescent=${settlementRecord.quiescent}`,
        `tree_quiescence_verified=${settlementRecord.verified}`,
      ]
      : []),
    ...(diagnostic ? [`diagnostic=${diagnostic}`] : []),
    "",
    "--- stdout ---",
    redactLog(result.stdout, environment),
    "--- stderr ---",
    redactLog(result.stderr, environment),
  ].join("\n"), { encoding: "utf8", mode: 0o600 });
  await chmod(options.logPath, 0o600).catch(() => undefined);
}

/** Usage reported by the bundled direct-API runtime, when it ran. */
async function readUsageFile(path: string): Promise<ProviderUsage> {
  const usage = emptyUsage();
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    if (parsed.schema !== "rb-harness-usage/v1") return usage;
    const number = (value: unknown): number => (Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0);
    usage.requests = number(parsed.requests);
    usage.inputTokens = number(parsed.inputTokens);
    usage.cachedInputTokens = number(parsed.cachedInputTokens);
    usage.cacheCreationInputTokens = number(parsed.cacheCreationInputTokens);
    usage.outputTokens = number(parsed.outputTokens);
    usage.totalTokens = number(parsed.totalTokens);
    usage.toolCalls = number(parsed.toolCalls);
    usage.measured = usage.totalTokens > 0 || usage.requests > 0;
  } catch {
    // A CLI provider without usage reporting stays explicitly unmeasured.
  }
  return usage;
}

export async function runProvider(options: ProviderRunOptions): Promise<ProviderRunResult> {
  const invocation = providerInvocation(options.configuration, options.mode, options.projectRoot);
  const telemetry = harnessTelemetry();
  const usagePath = isDirectProvider(options.configuration.provider)
    ? resolve(tmpdir(), `rb-harness-usage-${process.pid}-${randomBytes(6).toString("hex")}.json`)
    : undefined;
  if (usagePath) invocation.environment.RB_HARNESS_USAGE_FILE = usagePath;
  emitHarnessDashboard({
    type: "provider-start",
    provider: options.configuration.provider,
    model: options.configuration.model || "provider-default",
    mode: options.mode,
    stage: options.stage,
  });
  await mkdir(dirname(options.logPath), { recursive: true });
  const started = Date.now();
  let firstOutputAt: number | undefined;
  let stdout = "";
  let stderr = "";
  const maxBytes = options.maxOutputBytes ?? providerOutputLimit(options.mode);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("provider output limit must be a positive safe integer");

  let exitCode = 0;
  let failure: string | undefined;
  let toolCalls = 0;
  let settlement: SettleOutcome | undefined;
  // An adapter's internal control (tool budget, measured usage, read
  // confinement — see `isControlledAdapter`) says nothing about the format it
  // writes to stdout. The bundled direct-API runtime is fully controlled *and*
  // writes plain final text; conflating the two made the observer read an
  // envelope's own `{` as an event and flatten it, turning a complete paid
  // response into "malformed JSON". Only the transport decides parsing.
  const structuredStdout = options.streamMode
    ? options.streamMode === "structured"
    : usesStructuredStdout(options.configuration.provider);
  const transport = structuredStdout ? "jsonl-events" : "final-text";
  const observer = new ProviderStreamObserver({
    mode: structuredStdout ? "structured" : "opaque",
    dialect: options.streamDialect
      ?? (providerCapabilities(options.configuration.provider).stdoutTransport === "jsonl-events"
        && options.configuration.provider === "opencode"
        ? "opencode"
        : "generic"),
  });
  if (!harnessDashboardActive()) {
    process.stderr.write(`[rb-harness] adapter ${options.configuration.provider}: ${describeAdapterControl(options.configuration.provider)}.\n`);
    process.stderr.write(
      `[rb-harness] transporte do stdout: ${transport}`
      + `${structuredStdout ? " (a resposta final é reconstruída a partir dos eventos)" : " (a resposta final é entregue byte a byte)"}.\n`,
    );
    process.stderr.write(`[rb-harness] ${describeContainment(detectContainmentSupport())}.\n`);
    process.stderr.write(`[rb-harness] ${describeReadConfinement(options.configuration.provider)}.\n`);
  }
  const handle = spawnProcessTree(invocation.command, invocation.args, {
    cwd: options.projectRoot,
    env: invocation.environment,
    stdio: ["pipe", "pipe", "pipe"],
    ...(options.containment ? { containment: options.containment } : {}),
  });
  try {
    exitCode = await new Promise<number>((resolveRun, reject) => {
      const child = handle.child;
      let observedBytes = 0;
      const stop = (reason: string) => handle.terminate(reason);
      const wallTimer = options.timeoutSeconds > 0
        ? setTimeout(() => stop(`provider exceeded ${options.timeoutSeconds}s wall timeout`), options.timeoutSeconds * 1000)
        : undefined;
      const firstTimer = options.firstOutputTimeoutSeconds > 0
        ? setTimeout(() => stop(`provider produced no output within ${options.firstOutputTimeoutSeconds}s`), options.firstOutputTimeoutSeconds * 1000)
        : undefined;
      // Conservative limit for every adapter, and the only real one for an
      // opaque adapter: output that repeats itself is not progress.
      const progressTimer = setInterval(() => {
        if (observer.stalled()) {
          stop(`provider produced no new output for ${Math.round(HARNESS_BUDGET.stream.noProgressMilliseconds / 1000)}s`);
        }
      }, 5_000);
      progressTimer.unref();
      const showProgress = !harnessDashboardActive() && Boolean(options.streamOutput || process.stderr.isTTY);
      const heartbeat = showProgress ? setInterval(() => {
        const elapsed = Math.floor((Date.now() - started) / 1000);
        if (firstOutputAt === undefined) process.stderr.write(`[rb-harness] provider ativo há ${elapsed}s; aguardando a primeira saída...\n`);
        else process.stderr.write(`[rb-harness] provider ativo há ${elapsed}s; ${observedBytes} bytes observados.\n`);
      }, 15_000) : undefined;
      const clearTimers = () => {
        if (wallTimer) clearTimeout(wallTimer);
        if (firstTimer) clearTimeout(firstTimer);
        if (heartbeat) clearInterval(heartbeat);
        clearInterval(progressTimer);
      };
      const observe = (chunk: Buffer, channel: "stdout" | "stderr") => {
        if (firstOutputAt === undefined) {
          firstOutputAt = Date.now();
          if (firstTimer) clearTimeout(firstTimer);
          // First sign of life: capture the tree membership now, so a leader
          // that answers and exits quickly cannot hide a detached survivor
          // between two periodic samples.
          handle.sample();
          if (!options.streamOutput && process.stderr.isTTY && !harnessDashboardActive()) {
            process.stderr.write(`[rb-harness] primeira saída do provider recebida após ${Math.max(1, Math.floor((firstOutputAt - started) / 1000))}s; analisando resposta...\n`);
          }
        }
        const text = chunk.toString("utf8");
        observedBytes += Buffer.byteLength(chunk);
        if (channel === "stdout") stdout += text; else stderr += text;
        if (channel === "stdout") {
          const breach = observer.push(text);
          if (breach) stop(breach.message);
        }
        // Evidence discovery is a distinct documentation stage. The bundled
        // direct-API runtime announces each confined tool call; a CLI adapter
        // that announces nothing simply leaves the stage unreported rather
        // than having activity invented for it.
        if (channel === "stderr") {
          const announced = text.match(/\[rb-tool\] /g)?.length ?? 0;
          if (announced) {
            if (!toolCalls) {
              telemetry?.beginStage("evidence");
              emitHarnessDashboard({ type: "stage", stage: "evidence" });
            }
            toolCalls += announced;
            emitHarnessDashboard({ type: "activity", message: `evidência · ${toolCalls} leitura(s) confinada(s)` });
          }
        }
        emitHarnessDashboard({
          type: "provider-output",
          bytes: observedBytes,
          ...(firstOutputAt ? { firstOutputMilliseconds: firstOutputAt - started } : {}),
        });
        if (observedBytes > maxBytes) stop(outputLimitDiagnostic(maxBytes));
        if (options.streamOutput && !harnessDashboardActive()) (channel === "stdout" ? process.stdout : process.stderr).write(text);
      };
      child.stdout?.on("data", (chunk: Buffer) => observe(chunk, "stdout"));
      child.stderr?.on("data", (chunk: Buffer) => observe(chunk, "stderr"));
      child.once("error", (error) => {
        clearTimers();
        reject(error);
      });
      child.once("close", (code, signal) => {
        clearTimers();
        if (toolCalls) {
          telemetry?.beginStage(options.stage);
          emitHarnessDashboard({ type: "stage", stage: options.stage });
        }
        const reason = handle.terminationReason();
        if (reason) return reject(new Error(reason));
        resolveRun(code ?? (signal ? 70 : 1));
      });
      child.stdin?.end(options.prompt, "utf8");
    });
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    exitCode = 70;
  } finally {
    // The lock, the run state, and the next stage may only proceed after the
    // whole tree is confirmed gone. A leader that exits with code zero says
    // nothing about the descendants it detached, so every run settles here —
    // not only the ones that already started a teardown.
    const pending = handle.liveMembers();
    if (pending.length && !handle.terminating()) {
      process.stderr.write(
        `[rb-harness] o provider encerrou deixando ${pending.length} descendente(s) vivo(s); encerrando a árvore.\n`,
      );
    }
    settlement = await handle.settle("provider run finished with live descendants");
    if (!settlement.observed) {
      // Nothing was observed, so there is no survivor count to report. Saying
      // "0 descendants alive" here would be both false and reassuring.
      process.stderr.write(
        `[rb-harness] atenção: a árvore do provider não pôde ser verificada: ${settlement.containment.reason}.\n`,
      );
      failure ??= `the provider tree could not be verified after the teardown ladder: ${settlement.containment.reason}`;
      exitCode = exitCode === 0 ? 70 : exitCode;
    } else if (!settlement.quiescent) {
      process.stderr.write(
        `[rb-harness] atenção: ${settlement.survivors.length} descendente(s) do provider não confirmaram encerramento dentro da janela.\n`,
      );
      failure ??= `provider left ${settlement.survivors.length} descendant process(es) alive after the teardown ladder`;
      exitCode = exitCode === 0 ? 70 : exitCode;
    } else if (!settlement.verified && !harnessDashboardActive()) {
      // The ladder found nothing, but on this platform absence is not proof:
      // a descendant that changed session is invisible to it. Saying so is
      // the whole point — the alternative is a guarantee that is not real.
      process.stderr.write(
        `[rb-harness] encerramento não verificado estruturalmente: ${settlement.containment.reason}.\n`,
      );
    }
    handle.dispose();
  }

  // A stream can be truncated exactly at EOF; the trailing partial event is a
  // protocol failure, not something to accept quietly.
  const trailingBreach = observer.end();
  if (trailingBreach) {
    failure ??= trailingBreach.message;
    exitCode = exitCode === 0 ? 70 : exitCode;
  }
  const stream = observer.report();
  const usage = usagePath ? await readUsageFile(usagePath) : emptyUsage();
  // Tool counts are only claimed where they were actually observed.
  // Stream-derived tool counts are only claimed when a structured stream was
  // actually parsed; a controlled adapter reports its own through the usage
  // file, which is authoritative and already read above.
  if (!usage.toolCalls) usage.toolCalls = toolCalls || (structuredStdout ? stream.toolEvents : 0);
  if (stream.degraded && !harnessDashboardActive()) {
    process.stderr.write(
      `[rb-harness] o adapter ${options.configuration.provider} não emitiu eventos estruturados; `
      + "este eixo fica não medido e apenas os limites conservadores valeram.\n",
    );
  }
  if (usagePath) await rm(usagePath, { force: true }).catch(() => undefined);
  const durationMilliseconds = Date.now() - started;
  const result: ProviderRunResult = {
    exitCode,
    // Only an event transport has an answer to reconstruct. A final-text
    // transport is returned byte for byte, so the envelope parser sees exactly
    // what the provider wrote.
    stdout: structuredStdout && stream.events > 0 ? observer.recoveredText() : stdout,
    rawStdout: stdout,
    stderr,
    ...(firstOutputAt ? { firstOutputMilliseconds: firstOutputAt - started } : {}),
    durationMilliseconds,
    usage,
    stream,
    stdoutTransport: transport,
    settlement: settlement ?? {
      observed: true,
      quiescent: true,
      verified: false,
      containment: handle.containment,
      survivors: [],
    },
  };
  telemetry?.recordProviderCall({
    stage: options.stage,
    provider: options.configuration.provider,
    model: options.configuration.model || "provider-default",
    attempt: options.attempt ?? 1,
    startedAt: new Date(started).toISOString(),
    durationMilliseconds,
    exitCode,
    outputBytes: Buffer.byteLength(stdout) + Buffer.byteLength(stderr),
    ...(firstOutputAt ? { firstOutputMilliseconds: firstOutputAt - started } : {}),
    usage,
  });
  await writeProviderLog(options, invocation.environment, { ...result, stdout }, failure, stream, result.settlement, transport);
  emitHarnessDashboard({
    type: "provider-end",
    exitCode,
    bytes: Buffer.byteLength(stdout) + Buffer.byteLength(stderr),
    usage,
  });
  if (failure) throw new Error(`${failure}; see ${options.logPath}`);
  if (exitCode !== 0) throw new Error(`provider ${options.configuration.provider} exited with code ${exitCode}; see ${options.logPath}`);
  return result;
}
