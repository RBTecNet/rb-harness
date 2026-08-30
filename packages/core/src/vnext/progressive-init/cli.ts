import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { formatInteractiveQuestion, type InterviewQuestionEvidence } from "../interview.js";
import { useHeadlessInterviewPolicy } from "../init-cli.js";
import { defaultConformanceRecordsRoot } from "../providers/conformance/cli.js";
import { loadVerifiedProviderProfile, resolveProviderAdapter, resolveProviderAuth, resolveProviderProfile } from "../providers/registry.js";
import { formatProgressiveStagePresentation, runProgressiveInit } from "./coordinator.js";
import type { ProgressiveInitStage } from "./stages.js";

export interface ProgressiveInitCliOptions {
  readonly requestParts: readonly string[];
  readonly requestFile?: string;
  readonly profileId?: string;
  readonly credential?: string;
  readonly projectRoot: string;
  readonly headless: boolean;
  readonly deadlineSeconds: number;
  readonly stage?: ProgressiveInitStage;
}

async function requestText(options: ProgressiveInitCliOptions): Promise<string | undefined> {
  if (options.requestFile && options.requestParts.length) throw new Error("use either request text or --file, not both");
  const value = options.requestFile ? await readFile(resolve(options.requestFile), "utf8") : options.requestParts.join(" ");
  return value.trim() || undefined;
}

export async function runProgressiveInitCommand(options: ProgressiveInitCliOptions): Promise<void> {
  if (!Number.isFinite(options.deadlineSeconds) || options.deadlineSeconds <= 0 || options.deadlineSeconds > 900) throw new Error("--timeout must be between 1 and 900 seconds");
  let profile;
  let adapter;
  let auth;
  if (options.profileId) {
    const declared = resolveProviderProfile(options.profileId);
    if (declared.transport !== "direct-api" && options.credential) throw new Error(`--credential is not accepted for ambient-session profile ${declared.id}`);
    profile = await loadVerifiedProviderProfile(options.profileId, defaultConformanceRecordsRoot());
    adapter = resolveProviderAdapter(profile.id);
    auth = await resolveProviderAuth(profile, options.credential);
  } else if (options.credential) throw new Error("--credential requires --profile");
  const headless = useHeadlessInterviewPolicy(options.headless, Boolean(stdin.isTTY));
  const terminal = headless ? undefined : createInterface({ input: stdin, output: stdout });
  const answer = async (question: InterviewQuestionEvidence): Promise<string> => terminal!.question(formatInteractiveQuestion(question));
  try {
    const result = await runProgressiveInit({
      projectRoot: resolve(options.projectRoot), originalRequest: await requestText(options), selectedStage: options.stage,
      profile, adapter, auth, interview: headless ? { kind: "headless" } : { kind: "interactive", answer },
      deadlineMs: options.deadlineSeconds * 1_000,
      presentation: {
        stage: (stage, statuses) => { stdout.write(formatProgressiveStagePresentation(stage, statuses)); },
        question: (question) => { stdout.write(`\nProject Description interview — ${question.question}\n`); },
        complete: () => { stdout.write("\n✓ Project Description complete\n"); },
        transition: (next) => { stdout.write(`\nNext stage: ${next}\nThis stage is not implemented in Progressive Init Phase 1.\n`); },
      },
    });
    if (result.artifactPath) stdout.write(`Progressive specification: ${result.artifactPath}\n`);
    stdout.write(`Semantic operations: ${result.semanticOperations}\nCorrective regenerations: ${result.correctiveRegenerations}\n`);
  } finally {
    terminal?.close();
  }
}
