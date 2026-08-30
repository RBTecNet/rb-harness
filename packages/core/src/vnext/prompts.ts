import { sha256Text } from "../hash.js";
import type { InterviewQuestionEvidence } from "./interview.js";
import type { SemanticProtectedPathInput } from "./ir.js";
import { modelFacingRecoveryContext } from "./recovery-findings.js";
import type { CorrectiveSemanticInput, RecoveryInputAuditEvidence, RecoveryScopeEvidence } from "./run-state.js";
import type { IntentWire, WireFinding } from "./wire.js";

export const INTENT_INSTRUCTIONS = [
  "Understand the requested MVP and produce the complete init intent semantic slice described by the supplied schema.",
  "Set format to rb-init-intent/v1 and include every required top-level array, using an empty array when there are no entries.",
  "Use stable symbolic semantic keys in lower-case kebab-case, such as api-client, parse-input, or web-interface. Keys are semantic references, not execution IDs.",
  "Do not assign machine IDs, artifact paths, hashes, timestamps, phase/task IDs, acceptance IDs, or document syntax.",
  "Ground request-sourced decisions in an exact meaningful phrase from the request.",
  "For request-sourced decisions put that phrase in evidence; omit evidence for model-default decisions.",
  "A proposed protected path is an existing or user-owned path that the request explicitly says must not be modified; a requested implementation destination is not protected merely because the request names it.",
  "For a genuinely protected path, use sourceKind request with the explicit protection evidence, or sourceKind question with the matching questionKey.",
  "For every material ambiguity, emit a concrete question with exactly one selectable recommended answer and a useful rationale.",
  "Do not silently default a RIGID product or architecture decision; represent it as a question.",
  "Every quality command is a one-shot validation check: it must execute non-interactively, terminate by itself, and return its real exit status.",
  "Do not declare a development or application server, watcher, long-running worker, interactive process, or any command requiring external termination as a quality command. Commands such as npm run dev, a server-starting npm start, vite, nodemon, tsc --watch, and worker/server start commands are invalid validation commands.",
  "Prefer terminating tests, typechecks, builds, lints, and deterministic one-shot verification commands. The quality-command kind run does not make a long-running command valid.",
  "Propose only requirements, decisions, quality commands, and protected paths needed for a coherent MVP.",
].join("\n");

export const WORK_INSTRUCTIONS = [
  "Produce the complete init work semantic slice described by the supplied schema from the resolved project authority.",
  "Set format to rb-init-work/v1 and include every required array, using an empty dependency array when nothing is prerequisite.",
  "Decompose work into semantic phases and tasks with symbolic keys, dependencies, owned project paths, requirement coverage, acceptance semantics, validation intents, and expected evidence.",
  "Use stable symbolic semantic keys in lower-case kebab-case, such as api-client, parse-input, or web-interface. Keys are semantic references, not execution IDs.",
  "Use only requirement and quality-command keys supplied by the resolved intent.",
  "Every semantic task must contain one concrete single-line change intent; one or more owned project-relative paths; one or more declared requirement keys; one or more self-contained single-line acceptance statements; one or more supported validation intents; and concrete single-line expected evidence.",
  "Each ownedPaths entry is one bounded write-authority token: use an explicit project-relative file, a directory token without a trailing slash, or a bounded glob such as src/**/*.ts. A directory token owns its subtree; never append / to it. Do not use a leading slash, empty, . or .. path segments, backslashes, unbounded *, **, or **/*, or the .rb, .rb-harness, .git, or .spec/init protected control planes.",
  "For kind command, value must be an exact declared quality-command key naming an executable check the executor can run to completion and observe its exit result.",
  "Use kind manual only for a non-command inspection or action that a cold executor can itself perform; never paraphrase an executable shell check as manual prose.",
  "Use kind human only when the evidence requires actual human judgement or interaction unavailable to the executor.",
  "UI tasks are allowed, but their acceptance statements must prove observable functional behavior rather than appearance. State a concrete precondition or action and its deterministic application outcome, such as a DOM or application-state change, navigation result, form-submission result, data derived from known state, filter or sort result, authorization-dependent action state, API effect observable through the UI, or exact count, value, or message.",
  "Do not use styling, layout quality, looks-correct language, visibility or positioning, aesthetic judgement, screenshots, pixels, appearance, visual fidelity, or visual comparison as an acceptance success boundary. Convert the criterion to functional behavior; when genuine visual judgement is required, keep functional acceptance separate and use a human validation intent for that judgement.",
  "Do not assign machine IDs, artifact paths, parallel-safety values, hashes, timestamps, Markdown, or document grammar.",
  "Keep the plan small, executable, and sufficient for an MVP.",
].join("\n");

export function intentInput(originalRequest: string): string {
  return JSON.stringify({
    task: "Create the complete rb-init-intent/v1 semantic object for this request.",
    requiredCollections: [
      "determinations",
      "requirements",
      "qualityCommands",
      "proposedProtectedPaths",
      "questions",
      "contradictions",
    ],
    originalRequest,
  }, null, 2);
}

const RECOVERY_SCOPE_EVIDENCE: RecoveryScopeEvidence = {
  completeSliceRegeneration: true,
  rulesApplyGlobally: true,
  pointersArePreviousAttemptEvidence: true,
};

function recoveryAudit(input: {
  readonly originalRequest: string;
  readonly authoritativeInput: unknown;
  readonly resolvedInterviewAuthority?: unknown;
  readonly recovery: ReturnType<typeof modelFacingRecoveryContext>;
  readonly correctiveInput: string;
}): RecoveryInputAuditEvidence {
  return {
    recoveryScope: RECOVERY_SCOPE_EVIDENCE,
    violatedRules: input.recovery.violatedRules.map((entry) => entry.rule),
    specificPreviousFindings: input.recovery.specificPreviousFindings.map((finding) => ({
      pointer: finding.pointer,
      guidance: finding.message,
    })),
    hashes: {
      originalRequestSha256: sha256Text(input.originalRequest),
      authoritativeInputSha256: sha256Text(JSON.stringify(input.authoritativeInput)),
      ...(input.resolvedInterviewAuthority === undefined
        ? {}
        : { resolvedInterviewAuthoritySha256: sha256Text(JSON.stringify(input.resolvedInterviewAuthority)) }),
      recoveryContextSha256: sha256Text(JSON.stringify(input.recovery)),
      correctiveInputSha256: sha256Text(input.correctiveInput),
    },
  };
}

export function correctiveIntentInput(originalRequest: string, findings: readonly WireFinding[]): CorrectiveSemanticInput {
  const recovery = modelFacingRecoveryContext(findings);
  const authoritativeInput = { originalRequest };
  const input = JSON.stringify({
    task: "Produce the COMPLETE intent semantic slice again from authoritative input; do not patch previous fields or return a fragment.",
    recoveryScope: {
      ...RECOVERY_SCOPE_EVIDENCE,
      instruction: "Violated rules apply to the entire regenerated slice, not only the prior locations. Specific pointers are evidence from the previous attempt, not patch targets. Rebuild the whole slice while satisfying every listed rule globally.",
    },
    originalRequest,
    violatedRules: recovery.violatedRules,
    specificPreviousFindings: recovery.specificPreviousFindings,
  }, null, 2);
  return { input, audit: recoveryAudit({ originalRequest, authoritativeInput, recovery, correctiveInput: input }) };
}

export interface ResolvedIntentPromptAuthority {
  readonly originalRequest: string;
  readonly project: IntentWire["project"];
  readonly determinations: IntentWire["determinations"];
  readonly requirements: IntentWire["requirements"];
  readonly qualityCommands: IntentWire["qualityCommands"];
  readonly protectedPaths: readonly {
    readonly path: string;
    readonly reason: string;
    readonly sourceKind: "request" | "user-answer" | "accepted-recommendation";
    readonly questionKey?: string;
  }[];
  readonly selectedDecisions: readonly {
    readonly key: string;
    readonly value: string;
    readonly materiality: string;
    readonly rigidity: string;
    readonly sourceKind: "user-answer" | "accepted-recommendation";
    readonly acceptanceMode: "explicit" | "blank-interactive" | "non-interactive-policy";
  }[];
}

export function resolvedIntentPromptAuthority(
  intent: IntentWire,
  questions: readonly InterviewQuestionEvidence[],
  authority: {
    readonly originalRequest: string;
    readonly protectedPaths: readonly SemanticProtectedPathInput[];
  },
): ResolvedIntentPromptAuthority {
  return {
    originalRequest: authority.originalRequest,
    project: intent.project,
    determinations: intent.determinations,
    requirements: intent.requirements,
    qualityCommands: intent.qualityCommands,
    protectedPaths: authority.protectedPaths.flatMap((path) => path.source.kind === "model-default"
      ? []
      : [{
          path: path.path,
          reason: path.reason,
          sourceKind: path.source.kind,
          ...(path.source.kind === "request" ? {} : { questionKey: path.source.questionKey }),
        }]),
    selectedDecisions: questions.map((question) => ({
      key: question.key,
      value: question.selectedValue ?? "",
      materiality: question.materiality,
      rigidity: question.rigidity,
      sourceKind: question.acceptanceMode === "explicit" ? "user-answer" : "accepted-recommendation",
      acceptanceMode: question.acceptanceMode ?? "non-interactive-policy",
    })),
  };
}

export function workInput(authority: ResolvedIntentPromptAuthority): string {
  return JSON.stringify({
    task: "Create the complete rb-init-work/v1 semantic object for this resolved intent.",
    resolvedIntent: authority,
  }, null, 2);
}

export function correctiveWorkInput(authority: ResolvedIntentPromptAuthority, findings: readonly WireFinding[]): CorrectiveSemanticInput {
  const recovery = modelFacingRecoveryContext(findings);
  const input = JSON.stringify({
    task: "Produce the COMPLETE work semantic slice again from resolved authority; do not patch previous fields, preserve invalid locations mechanically, or return a fragment.",
    recoveryScope: {
      ...RECOVERY_SCOPE_EVIDENCE,
      instruction: "Violated rules apply to the entire regenerated slice, not only the prior locations. Specific pointers are evidence from the previous attempt, not patch targets. Rebuild the whole slice while satisfying every listed rule globally and preserving all resolved authoritative decisions.",
    },
    resolvedIntent: authority,
    violatedRules: recovery.violatedRules,
    specificPreviousFindings: recovery.specificPreviousFindings,
  }, null, 2);
  return {
    input,
    audit: recoveryAudit({
      originalRequest: authority.originalRequest,
      authoritativeInput: authority,
      resolvedInterviewAuthority: authority,
      recovery,
      correctiveInput: input,
    }),
  };
}
