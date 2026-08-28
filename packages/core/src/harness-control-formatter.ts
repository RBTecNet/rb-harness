/**
 * Provider-neutral formatting boundary for control responses.
 *
 * Semantic work is bought once. If its stdout does not satisfy the declared
 * wire contract, a closed formatter receives the preserved raw response and
 * gets at most three fresh, tool-free attempts to serialize it. A formatter
 * may change representation only; the deterministic parser remains the sole
 * acceptance authority.
 */

import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { HARNESS_BUDGET } from "./harness-budget.js";
import { runProvider, type ProviderMode } from "./harness-provider.js";
import type { HarnessStage, ProviderCallOperation } from "./harness-telemetry.js";
import { ProviderStreamObserver } from "./provider-events.js";
import type { ProviderConfiguration } from "./standalone-types.js";

export async function successfulProviderLogStdout(logPath: string): Promise<string | undefined> {
  let log: string;
  try { log = await readFile(logPath, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const stdoutMarker = "\n--- stdout ---\n";
  const stderrMarker = "\n--- stderr ---\n";
  const stdoutStart = log.indexOf(stdoutMarker);
  const stdoutEnd = log.lastIndexOf(stderrMarker);
  if (!/^exit_code=0$/m.test(log.slice(0, Math.max(0, stdoutStart))) || stdoutStart < 0 || stdoutEnd <= stdoutStart) {
    return undefined;
  }
  const stdout = log.slice(stdoutStart + stdoutMarker.length, stdoutEnd);
  const header = log.slice(0, stdoutStart);
  const transport = header.match(/^stdout_transport=(final-text|jsonl-events)$/m)?.[1];
  if (transport !== "jsonl-events") return stdout;
  const provider = header.match(/^provider=(.+)$/m)?.[1]?.trim();
  const observer = new ProviderStreamObserver({
    mode: "structured",
    dialect: provider === "opencode" ? "opencode" : "generic",
  });
  const breach = observer.push(stdout) ?? observer.end();
  if (breach) throw new Error(`successful provider log could not be reconstructed: ${breach.message}`);
  return observer.recoveredText();
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function bounded(value: string, maximum: number, label: string): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maximum) return value;
  throw new Error(`${label} exceeds the closed formatter input budget of ${maximum} bytes`);
}

/** Prior formatting is diagnostic, never authority; retain its bounded tail. */
function priorExcerpt(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= HARNESS_BUDGET.formatting.maxPriorBytes) return value;
  const notice = "[earlier bytes of the invalid formatting attempt omitted]\n";
  const allowance = HARNESS_BUDGET.formatting.maxPriorBytes - Buffer.byteLength(notice);
  return notice + bytes.subarray(bytes.length - allowance).toString("utf8");
}

export interface ControlFormattingOptions<T> {
  configuration: ProviderConfiguration;
  mode: ProviderMode;
  stage: HarnessStage;
  runRoot: string;
  logPrefix: string;
  label: string;
  rawOutput: string;
  contract: string;
  parse: (output: string) => T;
  timeoutSeconds: number;
  firstOutputTimeoutSeconds: number;
  streamOutput?: boolean;
  /** Opt-in repetition guard for a control response with a stable payload identity. */
  rejectedOutputFingerprint?: (output: string) => string;
  /** Narrow telemetry purpose for formatter calls in a shared stage. */
  providerOperation?: ProviderCallOperation;
  /** Semantic defects must escape instead of becoming formatter instructions. */
  isSemanticError?: (error: unknown) => boolean;
}

/** Parse directly when possible; otherwise buy only bounded formatting calls. */
export async function parseOrFormatControlOutput<T>(options: ControlFormattingOptions<T>): Promise<T> {
  try { return options.parse(options.rawOutput); }
  catch (initialError) {
    if (options.isSemanticError?.(initialError)) throw initialError;
    process.stdout.write(
      `[rb-harness] ${options.label} fora do contrato; iniciando formatador fechado `
      + `(até ${HARNESS_BUDGET.formatting.maxAttempts} tentativa(s)), sem repetir o trabalho semântico.\n`,
    );
    const raw = bounded(options.rawOutput, HARNESS_BUDGET.formatting.maxRawBytes, `${options.label} raw response`);
    const contract = bounded(options.contract, HARNESS_BUDGET.formatting.maxContractBytes, `${options.label} formatter contract`);
    let prior = "";
    let defect = errorText(initialError);
    let attempts = 0;
    let repeated = false;
    const rejectedFingerprints = options.rejectedOutputFingerprint
      ? new Set([options.rejectedOutputFingerprint(options.rawOutput)])
      : undefined;
    const closedRoot = await mkdtemp(resolve(tmpdir(), "rb-harness-closed-formatter-"));
    await chmod(closedRoot, 0o555);
    try {
      for (let attempt = 1; attempt <= HARNESS_BUDGET.formatting.maxAttempts; attempt += 1) {
        attempts = attempt;
        const logPath = resolve(options.runRoot, `logs/${options.logPrefix}-${attempt}.log`);
        let output = await successfulProviderLogStdout(logPath);
        if (output !== undefined) {
          process.stdout.write(`[rb-harness] tentativa ${attempt} do formatador recuperada do log; provider não será reinvocado.\n`);
        } else {
          process.stdout.write(`[rb-harness] ${options.label} formatter call attempt=${attempt}\n`);
          const prompt = [
            "You are the RB Harness control-response formatter. You format existing material; you do not analyze the project or make product decisions.",
            "Do not call tools, inspect files, add facts, remove facts, resolve ambiguity, change IDs, or improve the substance.",
            "Translate only the representation of the RAW SEMANTIC RESPONSE into the exact contract below.",
            "Return only the required contract response, with no Markdown fence or surrounding prose.",
            `\n===== EXACT OUTPUT CONTRACT =====\n${contract}`,
            `\n===== CURRENT DETERMINISTIC DEFECT =====\n${defect}`,
            `\n===== RAW SEMANTIC RESPONSE — IMMUTABLE AUTHORITY =====\n${raw}`,
            prior
              ? `\n===== PREVIOUS INVALID FORMATTING ATTEMPT =====\n${priorExcerpt(prior)}`
              : "",
          ].filter(Boolean).join("\n");
          if (Buffer.byteLength(prompt) > HARNESS_BUDGET.prompt.maxGenerationPromptBytes) {
            throw new Error(`${options.label} formatter prompt exceeds ${HARNESS_BUDGET.prompt.maxGenerationPromptBytes} bytes`);
          }
          const result = await runProvider({
            configuration: options.configuration,
            mode: options.mode,
            stage: options.stage,
            projectRoot: closedRoot,
            prompt,
            logPath,
            timeoutSeconds: options.timeoutSeconds,
            firstOutputTimeoutSeconds: options.firstOutputTimeoutSeconds,
            streamOutput: options.streamOutput,
            attempt,
            toolsEnabled: false,
            operation: options.providerOperation,
          });
          output = result.stdout;
        }
        const fingerprint = options.rejectedOutputFingerprint?.(output);
        if (fingerprint && rejectedFingerprints?.has(fingerprint)) {
          repeated = true;
          process.stdout.write(
            `[rb-harness] ${options.label} formatter repeated rejected payload at attempt=${attempt}; remaining attempts cancelled.\n`,
          );
          break;
        }
        try { return options.parse(output); }
        catch (error) {
          if (options.isSemanticError?.(error)) throw error;
          defect = errorText(error);
          prior = output;
          if (fingerprint) rejectedFingerprints?.add(fingerprint);
          if (attempt < HARNESS_BUDGET.formatting.maxAttempts) {
            process.stdout.write(`[rb-harness] formatador ainda fora do contrato na tentativa ${attempt}: ${defect}; tentando novamente.\n`);
          }
        }
      }
    } finally {
      await chmod(closedRoot, 0o700).catch(() => undefined);
      await rm(closedRoot, { recursive: true, force: true });
    }
    throw new Error(
      `${options.label} formatter could not satisfy the contract after ${attempts} attempt${attempts === 1 ? "" : "s"}: ${defect}`
      + (repeated ? "; repeated identical rejected payload" : ""),
    );
  }
}
