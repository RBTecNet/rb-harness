import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { formatInteractiveQuestion, type InterviewQuestionEvidence } from "./interview.js";
import { runSemanticInit } from "./init.js";
import { defaultConformanceRecordsRoot } from "./providers/conformance/cli.js";
import {
  loadVerifiedProviderProfile,
  resolveProviderAdapter,
  resolveProviderAuth,
  resolveProviderProfile,
} from "./providers/registry.js";

export interface VnextInitCliOptions {
  readonly requestParts: readonly string[];
  readonly requestFile?: string;
  readonly profileId: string;
  readonly credential?: string;
  readonly projectRoot: string;
  readonly headless: boolean;
  readonly deadlineSeconds: number;
}

async function requestText(options: VnextInitCliOptions): Promise<string> {
  if (options.requestFile && options.requestParts.length) throw new Error("use either request text or --file, not both");
  const value = options.requestFile
    ? await readFile(resolve(options.requestFile), "utf8")
    : options.requestParts.join(" ");
  if (!value.trim()) throw new Error("vnext init requires request text or --file");
  return value.trim();
}

export async function runVnextInitCommand(options: VnextInitCliOptions): Promise<void> {
  if (!Number.isFinite(options.deadlineSeconds) || options.deadlineSeconds <= 0 || options.deadlineSeconds > 900) {
    throw new Error("--timeout must be between 1 and 900 seconds");
  }
  const declaredProfile = resolveProviderProfile(options.profileId);
  if (declaredProfile.transport !== "direct-api" && options.credential) {
    throw new Error(`--credential is not accepted for ambient-session profile ${declaredProfile.id}`);
  }
  const profile = await loadVerifiedProviderProfile(options.profileId, defaultConformanceRecordsRoot());
  const adapter = resolveProviderAdapter(profile.id);
  const auth = await resolveProviderAuth(profile, options.credential);
  const headless = options.headless || !stdin.isTTY;
  const terminal = headless ? undefined : createInterface({ input: stdin, output: stdout });
  const answer = async (question: InterviewQuestionEvidence): Promise<string> => {
    if (!terminal) throw new Error("interactive answer channel is unavailable");
    return terminal.question(formatInteractiveQuestion(question));
  };
  try {
    const result = await runSemanticInit({
      originalRequest: await requestText(options),
      projectRoot: resolve(options.projectRoot),
      profile,
      adapter,
      auth,
      interview: headless ? { kind: "headless" } : { kind: "interactive", answer },
      deadlineMs: options.deadlineSeconds * 1_000,
    });
    const counters = result.runState.counters;
    stdout.write(`vNext init published: ${result.closure.publishedRoot}\n`);
    stdout.write(`Profile: ${profile.id}\nTransport: ${profile.transport}\nRequest accounting: ${profile.requestAccounting}\n`);
    stdout.write(`Semantic operations: ${counters.semanticOperations}\nTransport invocations: ${counters.transportInvocations}\n`);
    stdout.write(`Corrective regenerations: ${counters.correctiveRegenerations}\n`);
    stdout.write(`Provider requests: ${counters.providerRequests.measured ? counters.providerRequests.value : `unmeasured (${counters.providerRequests.reason})`}\n`);
    stdout.write(`Questions: ${result.runState.questions.length}\nRalph: READY\nRun state: ${result.runStatePath}\n`);
  } finally {
    terminal?.close();
  }
}
