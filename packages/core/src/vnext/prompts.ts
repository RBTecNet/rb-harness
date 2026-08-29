import type { InterviewQuestionEvidence } from "./interview.js";
import type { IntentWire, WireFinding } from "./wire.js";

export const INTENT_INSTRUCTIONS = [
  "Understand the requested MVP and produce the complete init intent semantic slice described by the supplied schema.",
  "Set format to rb-init-intent/v1 and include every required top-level array, using an empty array when there are no entries.",
  "Use stable symbolic lowercase keys only. Do not assign machine IDs, artifact paths, hashes, timestamps, phase/task IDs, acceptance IDs, or document syntax.",
  "Ground request-sourced decisions in an exact meaningful phrase from the request.",
  "For request-sourced decisions put that phrase in evidence; omit evidence for model-default decisions.",
  "A proposed protected path is an existing or user-owned path that the request explicitly says must not be modified; a requested implementation destination is not protected merely because the request names it.",
  "For a genuinely protected path, use sourceKind request with the explicit protection evidence, or sourceKind question with the matching questionKey.",
  "For every material ambiguity, emit a concrete question with exactly one selectable recommended answer and a useful rationale.",
  "Do not silently default a RIGID product or architecture decision; represent it as a question.",
  "Propose only requirements, decisions, quality commands, and protected paths needed for a coherent MVP.",
].join("\n");

export const WORK_INSTRUCTIONS = [
  "Produce the complete init work semantic slice described by the supplied schema from the resolved project authority.",
  "Set format to rb-init-work/v1 and include every required array, using an empty dependency array when nothing is prerequisite.",
  "Decompose work into semantic phases and tasks with symbolic keys, dependencies, owned project paths, requirement coverage, acceptance semantics, validation intents, and expected evidence.",
  "Use only requirement and quality-command keys supplied by the resolved intent.",
  "Every task must have a concrete single-line change intent, at least one owned project path, requirement coverage, self-contained single-line acceptance statements, at least one validation intent, and concrete single-line expected evidence.",
  "For an executable validation use kind command and set value to an exact declared quality-command key. Use kind manual only for a non-executable inspection a cold executor can perform, and kind human only for evidence unavailable to that executor.",
  "Do not assign machine IDs, artifact paths, parallel-safety values, hashes, timestamps, Markdown, or document grammar.",
  "Keep the plan small, executable, and sufficient for an MVP.",
].join("\n");

function findingsText(findings: readonly WireFinding[]): readonly { code: string; pointer: string; message: string }[] {
  return findings.map(({ code, pointer, message }) => ({ code, pointer, message }));
}

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

export function correctiveIntentInput(originalRequest: string, findings: readonly WireFinding[]): string {
  return JSON.stringify({
    task: "Produce the complete intent semantic slice again; do not patch individual fields.",
    originalRequest,
    deterministicFindings: findingsText(findings),
  }, null, 2);
}

export interface ResolvedIntentPromptAuthority {
  readonly project: IntentWire["project"];
  readonly determinations: IntentWire["determinations"];
  readonly requirements: IntentWire["requirements"];
  readonly qualityCommands: IntentWire["qualityCommands"];
  readonly selectedDecisions: readonly {
    readonly key: string;
    readonly value: string;
    readonly materiality: string;
    readonly rigidity: string;
  }[];
}

export function resolvedIntentPromptAuthority(
  intent: IntentWire,
  questions: readonly InterviewQuestionEvidence[],
): ResolvedIntentPromptAuthority {
  return {
    project: intent.project,
    determinations: intent.determinations,
    requirements: intent.requirements,
    qualityCommands: intent.qualityCommands,
    selectedDecisions: questions.map((question) => ({
      key: question.key,
      value: question.selectedValue ?? "",
      materiality: question.materiality,
      rigidity: question.rigidity,
    })),
  };
}

export function workInput(authority: ResolvedIntentPromptAuthority): string {
  return JSON.stringify({
    task: "Create the complete rb-init-work/v1 semantic object for this resolved intent.",
    resolvedIntent: authority,
  }, null, 2);
}

export function correctiveWorkInput(authority: ResolvedIntentPromptAuthority, findings: readonly WireFinding[]): string {
  return JSON.stringify({
    task: "Produce the complete work semantic slice again; do not patch individual fields.",
    resolvedIntent: authority,
    deterministicFindings: findingsText(findings),
  }, null, 2);
}
