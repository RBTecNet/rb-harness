import type { HeadlessInitDocument } from "./headless-contract.js";

/**
 * The init instruction belongs to the Harness.  Callers pass only a declarative
 * request; they never need (or receive) this workflow prompt.
 */
export function buildHeadlessInitPrompt(request: HeadlessInitDocument): string {
  const project = request.project as Record<string, unknown>;
  const specifications = request.specifications as unknown[];
  const answers = request.interviewAnswers as unknown[];

  return [
    "You are the RB Harness rb-init adapter.",
    "Create a declarative package for a new project only. Do not inspect, clone, or modify an existing codebase. Do not run Ralph or create implementation code.",
    "Write only under RB_HEADLESS_OUTPUT_ROOT. The output must be an .rb artifact tree with a valid rb-manifest/v1 and at least one ready rb-execution/v1 PHASES.md.",
    "Do not write secrets, credentials, tokens, or provider diagnostics into artifacts.",
    "\nProject:\n" + JSON.stringify(project),
    "\nSpecifications:\n" + JSON.stringify(specifications),
    "\nAccepted interview answers:\n" + JSON.stringify(answers),
    "\nAdditional constraints:\n" + JSON.stringify(request.additionalInstructions),
  ].join("\n");
}
