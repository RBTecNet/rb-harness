/**
 * The single authoritative authoring call and its one localized repair
 * (RF-004 and RF-005).
 *
 * There is no manager, auditor, or second opinion. One session receives the
 * closed decision checkpoint and returns the complete document bundle; code
 * materializes it, derives every mechanical field, and validates. If — and
 * only if — deterministic validation finds repairable structural errors, one
 * bounded repair receives the ordered error list and the affected documents,
 * and must preserve everything else byte for byte. A second failure is
 * reported to the operator. There is no loop.
 */

import { resolve } from "node:path";
import { HARNESS_BUDGET } from "./harness-budget.js";
import { generationContractDigest, repairContractDigest } from "./harness-contract-digest.js";
import {
  DOCUMENT_BUNDLE_BEGIN,
  DOCUMENT_BUNDLE_CONTRACT,
  DOCUMENT_BUNDLE_END,
  documentExcerpts,
  mergeDocumentBundles,
  parseDocumentBundle,
  type DocumentBundle,
} from "./harness-documents.js";
import { assertPromptWithinBudget, serializeInputPackage, type HarnessInputPackage } from "./harness-input-package.js";
import { runProvider } from "./harness-provider.js";
import { loadWorkflowResources, requestNeedsHeadlessContracts } from "./standalone-resources.js";
import type { HarnessRunState, ProviderConfiguration } from "./standalone-types.js";

const BUNDLE_SHAPE = JSON.stringify({
  contract: DOCUMENT_BUNDLE_CONTRACT,
  status: "complete | blocked",
  summary: "one sentence describing what was written",
  documents: [{ path: ".rb/<directory>/<FILE>.md", content: "the complete UTF-8 file body" }],
  blocked: ["only when status is blocked: the exact missing developer decision"],
});

/**
 * The invariant part of the generation prompt (CR-007): identical bytes across
 * every protocol retry of one authoring call. The repair pass is a separate
 * process with its own prompt and makes no cache claim.
 */
export function stableGenerationPrefix(
  state: HarnessRunState,
  inputPackage: HarnessInputPackage,
  resources: string,
): string {
  return [
    "You are the RB Harness documentation writer. You write documentation only: never application code, never a commit, never a command execution.",
    "You have read-only access to the target project through your tools. Never inspect the RB Harness installation, its source, its tests, or its packaged resources; everything you need about the output contract is below.",
    `Return the complete document set as exactly ${DOCUMENT_BUNDLE_BEGIN}, one JSON object, and ${DOCUMENT_BUNDLE_END}. Do not use Markdown fences around the envelope and do not add surrounding prose.`,
    `The JSON shape is:\n${BUNDLE_SHAPE}`,
    `Every \`content\` value is the full file body, not a diff and not a summary. At most ${HARNESS_BUDGET.documents.maxDocuments} documents and ${HARNESS_BUDGET.documents.maxDocumentBytes} bytes per document.`,
    "This is the only authoring call. There is no later documentation manager and no editorial review pass, so resolve every engineering detail now. Do not ask questions here: the interview is closed.",
    generationContractDigest(state.workflow),
    resources,
    `\n===== INPUT PACKAGE (${inputPackage.contract}) =====\n${serializeInputPackage(inputPackage)}`,
    `\n===== CLOSED DECISION CHECKPOINT =====\n${JSON.stringify({
      summary: state.analysis?.summary ?? "",
      discoveries: state.analysis?.discoveries ?? [],
      assumptions: state.analysis?.assumptions ?? [],
      unresolved: state.analysis?.unresolved ?? [],
    })}`,
  ].join("\n");
}

export function buildGenerationPrompt(
  state: HarnessRunState,
  inputPackage: HarnessInputPackage,
  resources: string,
  repair?: string,
): string {
  const prompt = [
    stableGenerationPrefix(state, inputPackage, resources),
    repair ? `\nA prior response could not be parsed. Correct only the protocol defect and keep the same documents: ${repair}` : "",
  ].filter(Boolean).join("\n");
  assertPromptWithinBudget(prompt, HARNESS_BUDGET.prompt.maxGenerationPromptBytes, "generation");
  return prompt;
}

export interface GenerationRequestOptions {
  state: HarnessRunState;
  inputPackage: HarnessInputPackage;
  runRoot: string;
  /** Read-only evidence projection the provider runs in (CR-005). */
  evidenceRoot: string;
  timeoutSeconds: number;
  firstOutputTimeoutSeconds: number;
  streamOutput?: boolean;
}

export async function requestDocumentBundle(options: GenerationRequestOptions): Promise<DocumentBundle> {
  const { state, runRoot } = options;
  const resources = await loadWorkflowResources(state.workflow, {
    includeHeadlessContracts: requestNeedsHeadlessContracts(state.request),
    section: "generation",
  });
  let repair: string | undefined;
  for (let attempt = 1; attempt <= HARNESS_BUDGET.generation.protocolAttempts; attempt += 1) {
    const result = await runProvider({
      configuration: state.provider as ProviderConfiguration,
      mode: "generation",
      stage: "generation",
      projectRoot: options.evidenceRoot,
      prompt: buildGenerationPrompt(state, options.inputPackage, resources, repair),
      logPath: resolve(runRoot, `logs/generation-protocol-${attempt}.log`),
      timeoutSeconds: options.timeoutSeconds,
      firstOutputTimeoutSeconds: options.firstOutputTimeoutSeconds,
      streamOutput: options.streamOutput,
      attempt,
    });
    try {
      return parseDocumentBundle(result.stdout);
    } catch (error) {
      repair = error instanceof Error ? error.message : String(error);
      if (attempt === HARNESS_BUDGET.generation.protocolAttempts) {
        throw new Error(`provider could not satisfy the document bundle protocol: ${repair}`);
      }
    }
  }
  throw new Error("unreachable document bundle protocol state");
}

export interface StructuralError {
  code: string;
  message: string;
  /** Logical artifact path the error belongs to, when the validator knows it. */
  path?: string;
}

export function buildRepairPrompt(
  state: HarnessRunState,
  bundle: DocumentBundle,
  errors: StructuralError[],
  affected: string[],
  protocolRepair?: string,
): string {
  const prompt = [
    "You are the RB Harness structural repair pass. This is the only repair of this run.",
    `Return exactly ${DOCUMENT_BUNDLE_BEGIN}, one JSON object, and ${DOCUMENT_BUNDLE_END} containing only the documents you changed plus any document an error requires you to add.`,
    `The JSON shape is:\n${BUNDLE_SHAPE}`,
    repairContractDigest(state.workflow),
    `\n===== DETERMINISTIC ERRORS (ordered, all of them) =====\n${JSON.stringify(
      errors.map((error, index) => ({ order: index + 1, code: error.code, path: error.path, message: error.message })),
    )}`,
    `\n===== AFFECTED DOCUMENTS =====\n${JSON.stringify(documentExcerpts(bundle, affected))}`,
    `\n===== DOCUMENTS THAT MUST NOT CHANGE =====\n${JSON.stringify(
      bundle.documents.map((document) => document.path).filter((path) => !affected.includes(path)),
    )}`,
    protocolRepair ? `\nA prior response could not be parsed. Correct only the protocol defect: ${protocolRepair}` : "",
  ].filter(Boolean).join("\n");
  assertPromptWithinBudget(prompt, HARNESS_BUDGET.prompt.maxRepairPromptBytes, "structural repair");
  return prompt;
}

export interface RepairRequestOptions {
  state: HarnessRunState;
  bundle: DocumentBundle;
  errors: StructuralError[];
  runRoot: string;
  /** Read-only evidence projection the provider runs in (CR-005). */
  evidenceRoot: string;
  timeoutSeconds: number;
  firstOutputTimeoutSeconds: number;
  streamOutput?: boolean;
}

export async function requestStructuralRepair(options: RepairRequestOptions): Promise<DocumentBundle> {
  const { state, bundle, errors, runRoot } = options;
  const known = new Set(bundle.documents.map((document) => document.path));
  const affected = [...new Set(errors.map((error) => error.path).filter((path): path is string => Boolean(path && known.has(path))))]
    .sort((left, right) => left.localeCompare(right));
  let protocolRepair: string | undefined;
  for (let attempt = 1; attempt <= HARNESS_BUDGET.generation.protocolAttempts; attempt += 1) {
    const result = await runProvider({
      configuration: state.provider as ProviderConfiguration,
      mode: "repair",
      stage: "structural-repair",
      projectRoot: options.evidenceRoot,
      prompt: buildRepairPrompt(state, bundle, errors, affected, protocolRepair),
      logPath: resolve(runRoot, `logs/structural-repair-protocol-${attempt}.log`),
      timeoutSeconds: options.timeoutSeconds,
      firstOutputTimeoutSeconds: options.firstOutputTimeoutSeconds,
      streamOutput: options.streamOutput,
      attempt,
    });
    try {
      return mergeDocumentBundles(bundle, parseDocumentBundle(result.stdout));
    } catch (error) {
      protocolRepair = error instanceof Error ? error.message : String(error);
      if (attempt === HARNESS_BUDGET.generation.protocolAttempts) {
        throw new Error(`structural repair could not satisfy the document bundle protocol: ${protocolRepair}`);
      }
    }
  }
  throw new Error("unreachable structural repair protocol state");
}
