/**
 * Provider-neutral incremental document generation.
 *
 * The old writer had to return every artifact inside one JSON response. That
 * tied correctness to a provider's output window and made a retry repeat the
 * same impossible request. The writer now returns a compact plan followed by
 * bounded document parts. Each completed part is checkpointed before the next
 * provider process starts; the orchestrator still owns assembly, validation,
 * and atomic publication.
 */

import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { HARNESS_BUDGET } from "./harness-budget.js";
import { parseOrFormatControlOutput, successfulProviderLogStdout } from "./harness-control-formatter.js";
import { generationContractDigest, repairContractDigest } from "./harness-contract-digest.js";
import {
  DOCUMENT_BUNDLE_BEGIN,
  DOCUMENT_BUNDLE_CONTRACT,
  DOCUMENT_BUNDLE_END,
  DocumentSubstanceError,
  documentExcerpts,
  mergeDocumentBundles,
  parseDocumentBundle,
  type DocumentBundle,
  type GeneratedDocument,
} from "./harness-documents.js";
import {
  DOCUMENT_PART_BEGIN,
  DOCUMENT_PART_CONTRACT,
  DOCUMENT_PART_END,
  DOCUMENT_PLAN_BEGIN,
  DOCUMENT_PLAN_CONTRACT,
  DOCUMENT_PLAN_END,
  assembleDocumentPlan,
  documentPlanFormattingFingerprint,
  parseDocumentPart,
  parseDocumentPlan,
  parsePlanOrLegacyBundle,
  type DocumentPart,
  type DocumentPlan,
  type DocumentPlanPart,
  type PlannedDocument,
  type PlannedOrLegacyBundle,
} from "./harness-incremental-documents.js";
import { assertPromptWithinBudget, serializeInputPackage, type HarnessInputPackage } from "./harness-input-package.js";
import { runProvider } from "./harness-provider.js";
import { harnessTelemetry } from "./harness-telemetry.js";
import { sha256Text } from "./hash.js";
import { validateExecutionMarkdown } from "./execution-contract.js";
import { loadWorkflowResources, requestNeedsHeadlessContracts } from "./standalone-resources.js";
import type { HarnessRunState, HarnessWorkflow, ProviderConfiguration } from "./standalone-types.js";
import {
  isCanonicalWorkflowArtifactPath,
  requiredWorkflowArtifactPaths,
  workflowScopeFromPaths,
} from "./workflow-definition.js";

const PLAN_SHAPE = JSON.stringify({
  contract: DOCUMENT_PLAN_CONTRACT,
  status: "complete | blocked",
  summary: "one sentence describing the complete set",
  coordination: "compact shared ID and traceability ledger used by every document",
  documents: [{
    path: ".rb/<directory>/<FILE>.md",
    purpose: "what this document must prove",
    dependsOn: ["finalized sibling documents this writer must use"],
    parts: [{ id: "stable-part-id", purpose: "bounded contiguous section, at most 12 KiB" }],
  }],
  blocked: ["only when status is blocked: the exact missing developer decision"],
});

/** Byte-stable authority prefix shared by the plan and every document part. */
export function stableGenerationPrefix(
  state: HarnessRunState,
  inputPackage: HarnessInputPackage,
  resources: string,
): string {
  return [
    "You are the RB Harness documentation writer. You write documentation only: never application code, never a commit, never a command execution.",
    "You have read-only access to the target project through your tools. Never inspect the RB Harness installation, its source, its tests, or its packaged resources; everything you need about the output contract is below.",
    "RB Harness materializes files and owns checkpoints, validation, publication, .rb/rb-manifest.json, and .rb/artifacts.tsv. You author the workflow-local documents, including source-manifest.json. Your response is data for one bounded authoring step.",
    "There is no documentation manager or editorial review. Use the closed decisions exactly, preserve grounded existing behavior, and do not ask questions during authoring.",
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

/** The first, deliberately small response: paths, shared IDs, and part boundaries only. */
export function buildGenerationPrompt(
  state: HarnessRunState,
  inputPackage: HarnessInputPackage,
  resources: string,
  protocolDefect?: string,
): string {
  const prompt = [
    stableGenerationPrefix(state, inputPackage, resources),
    `Return exactly ${DOCUMENT_PLAN_BEGIN}, one JSON object, and ${DOCUMENT_PLAN_END}. Do not use Markdown fences or surrounding prose.`,
    `The JSON shape is:\n${PLAN_SHAPE}`,
    `Plan every required artifact, but do not write any document content yet. At most ${HARNESS_BUDGET.documents.maxPlannedDocuments} documents and ${HARNESS_BUDGET.documents.maxPlannedParts} total parts.`,
    `Split every document into semantic, contiguous parts whose authored content will each be at most ${HARNESS_BUDGET.documents.maxPartBytes} UTF-8 bytes.`,
    "For PHASES.md, allocate **one part per phase**. A part that carries several phases is the single most common way a plan becomes unwritable: one phase with five tasks already approaches the limit, so a part named for a range such as `phases-p01-p04` will overflow and the run fails there. Name each part for the one phase it writes.",
    "For any other document, split at a heading boundary and keep one part to a few thousand words at most. When in doubt, plan more parts: an extra part costs one bounded call, while an oversized one costs the run.",
    `Keep the entire plan below ${HARNESS_BUDGET.documents.maxPlanBytes} UTF-8 bytes and target 12 KiB. Be concise, but never try to count bytes in an individual prose field; RB Harness enforces the total response budget deterministically.`,
    "The plan is a compact index, never documentation prose. Do not repeat the request, rationale, acceptance criteria, evidence, or decisions inside every purpose. Put shared decisions and stable IDs once in the coordination ledger; a part purpose names only its boundary, required sections, and referenced IDs.",
    "Part writers receive the complete authority prefix, closed decision checkpoint, coordination ledger, and whole plan. They do not need duplicated facts in each purpose and cannot inspect the project again.",
    "dependsOn is only an authoring prerequisite, not a semantic cross-reference: declare it only when this document cannot be authored before that sibling is finalized. Never declare reciprocal dependencies. The orchestrator owns mandatory workflow edges, deterministically discards suggested edges that would create a cycle, rejects missing documents, and authors in topological order.",
    "For PHASES.md, allocate the final globally unique T### sequence in the coordination ledger and every part purpose now. Never use phase-local task numbering, never restart T001 in a later phase, and never use P##-T### as a substitute ID.",
    "A legacy adapter may return a complete rb-harness-documents/v1 bundle for backward compatibility, but a normal writer must return the plan.",
    protocolDefect ? `A prior plan response was rejected. Do not repeat it: ${protocolDefect}` : "",
  ].filter(Boolean).join("\n");
  assertPromptWithinBudget(prompt, HARNESS_BUDGET.prompt.maxGenerationPromptBytes, "generation plan");
  return prompt;
}

export function buildDocumentPartPrompt(
  prefix: string,
  plan: DocumentPlan,
  document: PlannedDocument,
  part: DocumentPlanPart,
  documentIndex: number,
  partIndex: number,
  previousPart?: DocumentPart,
  repairContext?: string,
  defect?: string,
  dependencyProjection?: string,
): string {
  const prompt = [
    prefix,
    `\n===== AUTHORING PLAN (${plan.contract}) =====\n${JSON.stringify(plan)}`,
    repairContext ? `\n===== REPAIR AUTHORITY =====\n${repairContext}` : "",
    dependencyProjection ? `\n===== FINALIZED DOCUMENT DEPENDENCIES — READ-ONLY AUTHORITY =====\n${dependencyProjection}` : "",
    `\n===== TARGET DOCUMENT PART =====\n${JSON.stringify({
      path: document.path,
      documentPurpose: document.purpose,
      document: documentIndex + 1,
      documents: plan.documents.length,
      part: part.id,
      partPurpose: part.purpose,
      partNumber: partIndex + 1,
      parts: document.parts.length,
      maximumUtf8Bytes: HARNESS_BUDGET.documents.maxPartBytes,
    })}`,
    previousPart ? `\n===== IMMEDIATELY PREVIOUS CONTIGUOUS PART =====\n${JSON.stringify({
      part: previousPart.part,
      content: previousPart.content,
    })}` : "",
    repairContext
      ? `Return exactly ${DOCUMENT_PART_BEGIN}, one JSON object, and ${DOCUMENT_PART_END}. The object must use contract ${DOCUMENT_PART_CONTRACT}, the target path, the target region ID as part, and only the replacement bytes as content.`
      : "Return only the raw UTF-8 content of the requested document segment. Do not wrap it in JSON, protocol markers, commentary, or a Markdown code fence.",
    repairContext
      ? "Write only the requested repair-region replacement. Do not include complete-document content, neighboring tasks, outside headings, or immutable transitions. The Harness splices this content into the original document using code-owned offsets."
      : "Write only the requested contiguous segment. The first part begins the file; every later part continues exactly after the previous segment; concatenation must produce one complete document without omitted or duplicated text.",
    "This is a closed authoring step. Do not inspect files, call tools, rediscover evidence, or change the plan. All authority needed for this segment is in the plan, coordination ledger, finalized dependency projection, target brief, and previous segment above.",
    `The content must not exceed ${HARNESS_BUDGET.documents.maxPartBytes} UTF-8 bytes. If the plan assigned too much to this part, be concise while preserving every RIGID fact and contract requirement; never spill into another response.`,
    defect ? `A prior attempt at this exact segment was rejected: ${defect}. Author the same span again and make it fit: the limit is ${HARNESS_BUDGET.documents.maxPartBytes} UTF-8 bytes, so remove clearly more than the overflow rather than trimming to the edge. Keep every RIGID fact, ID, and contract requirement; cut restatement, rationale, and examples that repeat what the plan or an earlier segment already says.` : "",
  ].filter(Boolean).join("\n");
  assertPromptWithinBudget(prompt, repairContext ? HARNESS_BUDGET.prompt.maxRepairPromptBytes : HARNESS_BUDGET.prompt.maxGenerationPromptBytes, "document part");
  return prompt;
}

interface IncrementalCheckpoint {
  contract: "rb-harness-incremental-generation/v2";
  authoritySha256: string;
  plan: DocumentPlan;
  parts: Array<DocumentPart & { sha256: string }>;
}

function checkpointPath(runRoot: string, name: string): string {
  return resolve(runRoot, `${name}.json`);
}

async function saveCheckpoint(runRoot: string, name: string, checkpoint: IncrementalCheckpoint): Promise<void> {
  await mkdir(runRoot, { recursive: true, mode: 0o700 });
  const target = checkpointPath(runRoot, name);
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(checkpoint, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
}

function planEnvelope(plan: DocumentPlan): string {
  return `${DOCUMENT_PLAN_BEGIN}\n${JSON.stringify(plan)}\n${DOCUMENT_PLAN_END}`;
}

function partEnvelope(part: DocumentPart): string {
  return `${DOCUMENT_PART_BEGIN}\n${JSON.stringify(part)}\n${DOCUMENT_PART_END}`;
}

async function loadCheckpoint(runRoot: string, name: string, authoritySha256: string): Promise<IncrementalCheckpoint | undefined> {
  let raw: string;
  try { raw = await readFile(checkpointPath(runRoot, name), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error(`incremental checkpoint ${name} is malformed`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`incremental checkpoint ${name} is invalid`);
  const value = parsed as Record<string, unknown>;
  if (value.contract !== "rb-harness-incremental-generation/v2") {
    throw new Error(`incremental checkpoint ${name} predates dependency-aware authoring; restart document generation from its preserved provider logs`);
  }
  if (value.authoritySha256 !== authoritySha256) throw new Error(`incremental checkpoint ${name} is stale for the current authoring authority`);
  const plan = parseDocumentPlan(planEnvelope(value.plan as DocumentPlan));
  if (!Array.isArray(value.parts)) throw new Error(`incremental checkpoint ${name} has no parts array`);
  const expected = new Map<string, { path: string; part: string }>(plan.documents.flatMap((document) => document.parts.map((part) => [
    `${document.path}\0${part.id}`,
    { path: document.path, part: part.id },
  ] as const)));
  const seen = new Set<string>();
  const parts = value.parts.map((rawPart): DocumentPart & { sha256: string } => {
    if (!rawPart || typeof rawPart !== "object" || Array.isArray(rawPart)) throw new Error(`incremental checkpoint ${name} contains an invalid part`);
    const record = rawPart as Record<string, unknown>;
    const key = `${String(record.path ?? "")}\0${String(record.part ?? "")}`;
    const target = expected.get(key);
    if (!target || seen.has(key)) throw new Error(`incremental checkpoint ${name} contains an unexpected or duplicate part`);
    seen.add(key);
    const part = parseDocumentPart(partEnvelope({
      contract: DOCUMENT_PART_CONTRACT,
      path: record.path as string,
      part: record.part as string,
      content: record.content as string,
    }), target);
    const sha256 = typeof record.sha256 === "string" ? record.sha256 : "";
    if (sha256 !== sha256Text(part.content)) throw new Error(`incremental checkpoint ${name} contains a stale part ${part.path}#${part.part}`);
    return { ...part, sha256 };
  });
  return { contract: "rb-harness-incremental-generation/v2", authoritySha256, plan, parts };
}

function parsePartOrLegacyDocument(
  output: string,
  expected: { path: string; part: string },
  requireIdentity = false,
): DocumentPart {
  if (output.includes(DOCUMENT_PART_BEGIN)) return parseDocumentPart(output, expected);
  if (requireIdentity) {
    throw new Error(`provider did not identify the requested repair region ${expected.path}#${expected.part}`);
  }
  if (output.includes(DOCUMENT_BUNDLE_BEGIN)) {
    const bundle = parseDocumentBundle(output);
    if (bundle.status !== "complete" || bundle.documents.length !== 1 || bundle.documents[0]?.path !== expected.path) {
      throw new Error(`provider did not return the requested bounded document part ${expected.path}#${expected.part}`);
    }
    return parseDocumentPart(partEnvelope({
      contract: DOCUMENT_PART_CONTRACT,
      path: expected.path,
      part: expected.part,
      content: bundle.documents[0].content,
    }), expected);
  }
  // The target path and part ID are already owned by the checkpoint, so a CLI
  // that returns plain Markdown cannot redirect a write. Accepting its bounded
  // stdout removes a redundant JSON failure mode without weakening identity,
  // size, checkpoint, assembly, or publication validation.
  return parseDocumentPart(partEnvelope({
    contract: DOCUMENT_PART_CONTRACT,
    path: expected.path,
    part: expected.part,
    content: output,
  }), expected);
}

function planFormattingContract(): string {
  return [
    `Return exactly ${DOCUMENT_PLAN_BEGIN}, one JSON object, and ${DOCUMENT_PLAN_END}.`,
    `The exact JSON shape is ${PLAN_SHAPE}`,
    "Allowed root fields: contract, status, summary, coordination, documents, blocked.",
    "Allowed document fields: path, purpose, dependsOn, parts. Allowed part fields: id, purpose. No other field is permitted.",
    "Keep every original path, purpose, part ID, decision, and blocker unchanged; remove presentation-only or explanatory keys instead of translating them into new authority.",
  ].join("\n");
}

function partFormattingContract(expected: { path: string; part: string }): string {
  return [
    `Return exactly ${DOCUMENT_PART_BEGIN}, one JSON object, and ${DOCUMENT_PART_END}.`,
    `The exact JSON shape is {"contract":"${DOCUMENT_PART_CONTRACT}","path":${JSON.stringify(expected.path)},"part":${JSON.stringify(expected.part)},"content":"<the original authored document segment>"}.`,
    "Allowed fields are exactly contract, path, part, and content.",
    "Recover the authored document segment from the raw semantic response without rewriting, summarizing, extending, or improving it. JSON-escape the content correctly.",
  ].join("\n");
}

interface IncrementalAuthoringOptions {
  state: HarnessRunState;
  runRoot: string;
  evidenceRoot: string;
  timeoutSeconds: number;
  firstOutputTimeoutSeconds: number;
  streamOutput?: boolean;
  mode: "generation" | "repair";
  stage: "generation" | "structural-repair";
  checkpointName: string;
  logPrefix: string;
  prefix: string;
  planPrompt: string;
  /** Rebuild the plan prompt after a defect the formatter cannot repair. */
  replanPrompt: (defect: string) => string;
  repairContext?: string;
  /** Finalized documents in this run, never historical workspace artifacts. */
  currentRunDocuments?: readonly GeneratedDocument[];
  /** Existing documents this localized repair is authorized to replace. */
  repairAuthorizedPaths?: readonly string[];
  /** Code-owned regions that a repair plan must reference exactly by part ID. */
  repairAuthorizedRegions?: readonly StructuralRepairRegion[];
  /** Region-local authority selected for the current repair part. */
  repairContextForPart?: (path: string, part: string) => string | undefined;
  /** Repair parts must carry their checkpoint-owned region identity. */
  requirePartIdentity?: boolean;
  /** Validate one authored part before it can enter the checkpoint. */
  validatePart?: (part: DocumentPart) => void;
  /** Alternate deterministic assembly, used by code-owned repair splicing. */
  assemble?: (plan: DocumentPlan, parts: readonly DocumentPart[]) => DocumentBundle;
}

export function assertGenerationPlanComplete(workflow: HarnessWorkflow, plan: DocumentPlan): void {
  if (plan.status === "blocked") return;
  const paths = plan.documents.map((document) => document.path);
  const scope = workflowScopeFromPaths(workflow, paths);
  if (!scope) {
    throw new DocumentSubstanceError(
      `document plan for ${workflow} must place every authored artifact under exactly one canonical workflow root`,
    );
  }
  const unknown = paths.filter((path) => !isCanonicalWorkflowArtifactPath(workflow, scope, path));
  if (unknown.length) {
    throw new DocumentSubstanceError(
      `document plan for ${workflow} contains non-canonical current-run artifacts: ${unknown.join(", ")}`,
    );
  }
  const present = new Set(paths);
  const missing = requiredWorkflowArtifactPaths(workflow, scope).filter((path) => !present.has(path));
  if (missing.length) {
    throw new DocumentSubstanceError(
      `document plan for ${workflow} omits mandatory current-run artifacts: ${missing.join(", ")}`,
    );
  }
}

const MAX_DEPENDENCY_PROJECTION_BYTES = 96 * 1024;
const MAX_DEPENDENCY_DOCUMENT_BYTES = 16 * 1024;

function completedDocumentContent(
  document: PlannedDocument,
  completed: ReadonlyMap<string, DocumentPart>,
): string | undefined {
  const parts: string[] = [];
  for (const part of document.parts) {
    const completedPart = completed.get(`${document.path}\0${part.id}`);
    if (!completedPart) return undefined;
    parts.push(completedPart.content);
  }
  return parts.join("");
}

function boundedUtf8(source: string, maximum: number): string {
  const bytes = Buffer.from(source, "utf8");
  if (bytes.byteLength <= maximum) return source;
  return `${bytes.subarray(0, maximum).toString("utf8")}\n[projection truncated at ${maximum} bytes]`;
}

function executionAuthorityProjection(content: string): unknown {
  const parsed = validateExecutionMarkdown(content);
  if (!parsed.valid || !parsed.document) return undefined;
  return {
    contract: parsed.document.contract,
    artifactId: parsed.document.artifactId,
    phases: parsed.document.phases.map((phase) => ({
      id: phase.id,
      goal: phase.goal,
      tasks: phase.tasks.map((task) => ({
        id: task.id,
        scope: task.scope,
        change: task.change,
        validation: task.validation,
      })),
    })),
  };
}

function proseAuthorityProjection(content: string): string {
  const selected = content.replace(/\r\n/g, "\n").split("\n").filter((line) =>
    /^#{1,6}\s/.test(line)
    || /\b(?:RF|RNF|UI|CT)-\d+\b/.test(line)
    || /\b(?:RIGID|FLEXIBLE|OBSERVED|CONFIRMED|UNKNOWN|CONFLICT)\b/i.test(line)
    || /`[^`/]*(?:\/|\.[A-Za-z0-9]+)[^`]*`/.test(line)
    || /\b(?:entrypoint|launcher|command|argv|route|path|file|directory|contract|interface|scope)\b/i.test(line),
  );
  return boundedUtf8(selected.join("\n"), MAX_DEPENDENCY_DOCUMENT_BYTES);
}

function dependencyProjection(
  plan: DocumentPlan,
  target: PlannedDocument,
  completed: ReadonlyMap<string, DocumentPart>,
  currentRunDocuments: readonly GeneratedDocument[] = [],
): string | undefined {
  if (!target.dependsOn.length) return undefined;
  const sourceManifest = target.path.toLowerCase().endsWith("/source-manifest.json");
  const documents = target.dependsOn.map((path) => {
    const dependency = plan.documents.find((document) => document.path === path);
    const content = dependency
      ? completedDocumentContent(dependency, completed)
      : currentRunDocuments.find((document) => document.path === path)?.content;
    if (!dependency && content === undefined) throw new Error(`planned dependency disappeared: ${path}`);
    if (content === undefined) throw new Error(`planned dependency was not finalized before ${target.path}: ${path}`);
    if (sourceManifest) return { path, sha256: sha256Text(content) };
    const execution = path.toUpperCase().endsWith("/PHASES.MD") ? executionAuthorityProjection(content) : undefined;
    return execution
      ? { path, kind: "execution-authority", projection: execution }
      : { path, kind: "decision-authority", projection: proseAuthorityProjection(content) };
  });
  return boundedUtf8(JSON.stringify({ target: target.path, documents }), MAX_DEPENDENCY_PROJECTION_BYTES);
}

/** A localized repair may replace only documents granted by its deterministic errors. */
export function assertStructuralRepairPlanAuthority(
  candidate: PlannedOrLegacyBundle,
  authorizedPaths: readonly string[],
  authorizedRegions: readonly StructuralRepairRegion[] = [],
): void {
  const authorized = new Set(authorizedPaths);
  const documents = candidate.kind === "plan" ? candidate.plan.documents : candidate.bundle.documents;
  const unauthorized = documents.map((document) => document.path).filter((path) => !authorized.has(path));
  if (unauthorized.length) {
    throw new DocumentSubstanceError(
      `structural repair cannot add or rewrite documents without current-run repair authority: ${unauthorized.join(", ")}`,
    );
  }
  if (!authorizedRegions.length) return;
  if (candidate.kind !== "plan") {
    throw new DocumentSubstanceError(
      "structural repair must return a region plan; a complete document bundle cannot identify code-owned repair regions",
    );
  }
  if (candidate.plan.status === "blocked") return;
  const authorizedRegionKeys = new Map(authorizedRegions.map((region) => [`${region.path}\0${region.id}`, region]));
  const planned = candidate.plan.documents.flatMap((document) =>
    document.parts.map((part) => `${document.path}\0${part.id}`));
  const unknown = planned.filter((key) => !authorizedRegionKeys.has(key));
  if (unknown.length) {
    throw new DocumentSubstanceError(
      `structural repair plan references unknown repair-region ID(s): ${unknown.map((key) => key.split("\0")[1]).join(", ")}`,
    );
  }
  const missing = [...authorizedRegionKeys.keys()].filter((key) => !planned.includes(key));
  if (missing.length) {
    throw new DocumentSubstanceError(
      `structural repair plan omits code-owned repair-region ID(s): ${missing.map((key) => key.split("\0")[1]).join(", ")}`,
    );
  }
}

async function authorIncrementally(options: IncrementalAuthoringOptions): Promise<DocumentBundle> {
  const authoritySha256 = sha256Text(options.planPrompt);
  let checkpoint = await loadCheckpoint(options.runRoot, options.checkpointName, authoritySha256);
  if (!checkpoint) {
    const label = options.mode === "repair" ? "structural repair plan" : "document plan";
    /** One planning turn: provider call, then the representation-only formatter. */
    const requestPlan = async (prompt: string, attempt: number): Promise<PlannedOrLegacyBundle> => {
      const suffix = attempt > 1 ? `-replan-${attempt}` : "";
      const planLogPath = resolve(options.runRoot, `logs/${options.logPrefix}-plan${suffix}.log`);
      let rawPlan = await successfulProviderLogStdout(planLogPath);
      if (rawPlan !== undefined) {
        process.stdout.write("[rb-harness] resposta bruta do plano recuperada do log; geração semântica não será reinvocada.\n");
      }
      // A repair receives the complete affected excerpts and deterministic error
      // list in its prompt. Giving it discovery tools made it search the original
      // project for staged artifacts that intentionally do not exist there,
      // multiplying requests and inventing blockers. Generation planning still
      // gets the bounded evidence projection; repair planning is closed.
      const closedPlanRoot = rawPlan === undefined && options.mode === "repair"
        ? await mkdtemp(resolve(tmpdir(), "rb-harness-closed-repair-plan-"))
        : undefined;
      if (closedPlanRoot) await chmod(closedPlanRoot, 0o555);
      if (rawPlan === undefined) {
        if (options.mode === "repair") {
          process.stdout.write("[rb-harness] repair-plan generation call\n");
        }
        let result: Awaited<ReturnType<typeof runProvider>>;
        try {
          result = await runProvider({
            configuration: options.state.provider as ProviderConfiguration,
            mode: options.mode,
            stage: options.stage,
            projectRoot: closedPlanRoot ?? options.evidenceRoot,
            prompt,
            logPath: planLogPath,
            timeoutSeconds: options.timeoutSeconds,
            firstOutputTimeoutSeconds: options.firstOutputTimeoutSeconds,
            streamOutput: options.streamOutput,
            attempt,
            // A greenfield init already carries its complete request and closed
            // decisions in the authority prefix. Re-reading the same PRD buys a
            // second provider turn and input bill without discovering AS IS code.
            toolsEnabled: options.mode !== "repair" && options.state.workflow !== "init",
            operation: options.mode === "repair" ? "repair-plan-generation" : undefined,
          });
        } finally {
          if (closedPlanRoot) {
            await chmod(closedPlanRoot, 0o700).catch(() => undefined);
            await rm(closedPlanRoot, { recursive: true, force: true });
          }
        }
        rawPlan = result.stdout;
      }
      // A substance defect is never sent to the formatter: it may only change
      // representation, so all three of its attempts would fail identically.
      try {
        return parsePlanOrLegacyBundle(rawPlan, options.mode === "repair" ? {
          context: "structural-repair",
          availableDocumentPaths: options.currentRunDocuments?.map((document) => document.path) ?? [],
        } : undefined);
      } catch (error) {
        if (error instanceof DocumentSubstanceError) throw error;
      }
      return parseOrFormatControlOutput({
        configuration: options.state.provider as ProviderConfiguration,
        mode: options.mode,
        stage: options.stage,
        runRoot: options.runRoot,
        logPrefix: `${options.logPrefix}-plan${suffix}-format`,
        label,
        rawOutput: rawPlan,
        contract: planFormattingContract(),
        parse: (output) => parsePlanOrLegacyBundle(output, options.mode === "repair" ? {
          context: "structural-repair",
          availableDocumentPaths: options.currentRunDocuments?.map((document) => document.path) ?? [],
        } : undefined),
        timeoutSeconds: options.timeoutSeconds,
        firstOutputTimeoutSeconds: options.firstOutputTimeoutSeconds,
        streamOutput: options.streamOutput,
        rejectedOutputFingerprint: documentPlanFormattingFingerprint,
        providerOperation: options.mode === "repair" ? "repair-plan-formatter" : undefined,
      });
    };

    let planned: PlannedOrLegacyBundle | undefined;
    let defect: string | undefined;
    for (let attempt = 1; attempt <= HARNESS_BUDGET.generation.planReplans + 1; attempt += 1) {
      try {
        const candidate = await requestPlan(attempt === 1 ? options.planPrompt : options.replanPrompt(defect!), attempt);
        if (options.mode === "generation" && candidate.kind === "plan") {
          assertGenerationPlanComplete(options.state.workflow, candidate.plan);
        }
        if (options.mode === "repair") {
          assertStructuralRepairPlanAuthority(
            candidate,
            options.repairAuthorizedPaths ?? [],
            options.repairAuthorizedRegions ?? [],
          );
        }
        planned = candidate;
        break;
      } catch (error) {
        // Only a substance defect earns a replan. A persistent formatting
        // defect already has its own bounded formatter allowance; replanning it
        // would buy a second full planning turn for the same failure mode.
        if (!(error instanceof DocumentSubstanceError) || attempt > HARNESS_BUDGET.generation.planReplans) throw error;
        defect = error.message;
        process.stdout.write(`[rb-harness] ${label} rejeitado por defeito de substância: ${error.message}\n`);
        process.stdout.write("[rb-harness] replanejando uma vez com o defeito declarado (o formatador só corrige representação).\n");
      }
    }
    if (!planned) throw new Error(`${label} could not be planned`);
    if (planned.kind === "bundle") return planned.bundle;
    checkpoint = {
      contract: "rb-harness-incremental-generation/v2",
      authoritySha256,
      plan: planned.plan,
      parts: [],
    };
    await saveCheckpoint(options.runRoot, options.checkpointName, checkpoint);
    const totalParts = checkpoint.plan.documents.reduce((sum, document) => sum + document.parts.length, 0);
    process.stdout.write(`[rb-harness] plano incremental recebido: ${checkpoint.plan.documents.length} documento(s), ${totalParts} parte(s) limitada(s).\n`);
  } else {
    process.stdout.write(`[rb-harness] checkpoint incremental recuperado: ${checkpoint.parts.length} parte(s) já concluída(s).\n`);
  }
  if (options.mode === "repair" && options.repairAuthorizedRegions?.length) {
    assertStructuralRepairPlanAuthority(
      { kind: "plan", plan: checkpoint.plan },
      options.repairAuthorizedPaths ?? [],
      options.repairAuthorizedRegions,
    );
  }
  if (checkpoint.plan.status === "blocked") {
    return options.assemble?.(checkpoint.plan, []) ?? assembleDocumentPlan(checkpoint.plan, []);
  }

  const completed = new Map(checkpoint.parts.map((part) => [`${part.path}\0${part.part}`, part]));
  /** Segments already re-authored once after a substance defect. */
  const rewritten = new Set<string>();
  const totalParts = checkpoint.plan.documents.reduce((sum, document) => sum + document.parts.length, 0);
  const closedRoot = await mkdtemp(resolve(tmpdir(), "rb-harness-closed-authoring-"));
  await chmod(closedRoot, 0o555);
  try {
    let ordinal = 0;
    for (let documentIndex = 0; documentIndex < checkpoint.plan.documents.length; documentIndex += 1) {
      const document = checkpoint.plan.documents[documentIndex]!;
      for (let partIndex = 0; partIndex < document.parts.length; partIndex += 1) {
        ordinal += 1;
        const part = document.parts[partIndex]!;
        const key = `${document.path}\0${part.id}`;
        if (completed.has(key)) continue;
        const previousPlanPart = partIndex > 0 ? document.parts[partIndex - 1] : undefined;
        const previousPart = previousPlanPart ? completed.get(`${document.path}\0${previousPlanPart.id}`) : undefined;
        const logPath = resolve(options.runRoot, `logs/${options.logPrefix}-document-${String(documentIndex + 1).padStart(3, "0")}-part-${String(partIndex + 1).padStart(3, "0")}.log`);
        const expected = { path: document.path, part: part.id };
        let rawPart = await successfulProviderLogStdout(logPath);
        if (rawPart !== undefined) {
          process.stdout.write(`[rb-harness] resposta bruta da parte recuperada do log: ${document.path} · ${part.id}; autoria semântica não será reinvocada.\n`);
        } else {
          process.stdout.write(`[rb-harness] escrevendo ${ordinal}/${totalParts}: ${document.path} · ${part.id}.\n`);
          const result = await runProvider({
            configuration: options.state.provider as ProviderConfiguration,
            mode: options.mode,
            stage: options.stage,
            projectRoot: closedRoot,
            prompt: buildDocumentPartPrompt(
              options.prefix,
              checkpoint.plan,
              document,
              part,
              documentIndex,
              partIndex,
              options.mode === "repair" ? undefined : previousPart,
              options.repairContextForPart?.(document.path, part.id) ?? options.repairContext,
              undefined,
              dependencyProjection(checkpoint.plan, document, completed, options.currentRunDocuments),
            ),
            logPath,
            timeoutSeconds: options.timeoutSeconds,
            firstOutputTimeoutSeconds: options.firstOutputTimeoutSeconds,
            streamOutput: options.streamOutput,
            attempt: ordinal + 1,
            toolsEnabled: false,
          });
          rawPart = result.stdout;
        }
        let authored: DocumentPart;
        try {
          authored = parsePartOrLegacyDocument(rawPart, expected, options.requirePartIdentity);
        } catch (error) {
          // A substance defect — an oversized segment — cannot be repaired by
          // the formatter, which may only change representation. The writer
          // authors the same span again, told exactly what was rejected.
          if (error instanceof DocumentSubstanceError && !rewritten.has(key)) {
            rewritten.add(key);
            process.stdout.write(`[rb-harness] ${error.message}; reescrevendo o segmento uma vez.\n`);
            const retryLog = resolve(options.runRoot, `logs/${options.logPrefix}-document-${String(documentIndex + 1).padStart(3, "0")}-part-${String(partIndex + 1).padStart(3, "0")}-rewrite.log`);
            const retry = await runProvider({
              configuration: options.state.provider as ProviderConfiguration,
              mode: options.mode,
              stage: options.stage,
              projectRoot: closedRoot,
              prompt: buildDocumentPartPrompt(
                options.prefix,
                checkpoint.plan,
                document,
                part,
                documentIndex,
                partIndex,
                previousPart,
                options.repairContext,
                error.message,
                dependencyProjection(checkpoint.plan, document, completed, options.currentRunDocuments),
              ),
              logPath: retryLog,
              timeoutSeconds: options.timeoutSeconds,
              firstOutputTimeoutSeconds: options.firstOutputTimeoutSeconds,
              streamOutput: options.streamOutput,
              attempt: ordinal + 1,
              toolsEnabled: false,
            });
            rawPart = retry.stdout;
            // A rewrite that is still oversized is a planning defect, not a
            // formatting one: the plan gave this segment more document than a
            // part can hold. The formatter cannot shorten prose, so failing
            // here costs three fewer paid attempts and says what to change.
            try {
              authored = parsePartOrLegacyDocument(rawPart, expected, options.requirePartIdentity);
              options.validatePart?.(authored);
              const stored = { ...authored, sha256: sha256Text(authored.content) };
              checkpoint.parts.push(stored);
              completed.set(key, stored);
              await saveCheckpoint(options.runRoot, options.checkpointName, checkpoint);
              continue;
            } catch (rewriteError) {
              if (rewriteError instanceof DocumentSubstanceError) {
                throw new Error(
                  `${rewriteError.message}, and the rewrite did not fit either. `
                  + `The plan assigned too much of ${document.path} to part ${part.id}; it needs more parts, `
                  + "each covering a smaller contiguous span — for an execution plan, one phase per part.",
                );
              }
              rawPart = retry.stdout;
            }
          }
          authored = await parseOrFormatControlOutput({
            configuration: options.state.provider as ProviderConfiguration,
            mode: options.mode,
            stage: options.stage,
            runRoot: options.runRoot,
            logPrefix: `${options.logPrefix}-document-${String(documentIndex + 1).padStart(3, "0")}-part-${String(partIndex + 1).padStart(3, "0")}-format`,
            label: `document part ${document.path}#${part.id}`,
            rawOutput: rawPart,
            contract: partFormattingContract(expected),
            parse: (output) => parseDocumentPart(output, expected),
            timeoutSeconds: options.timeoutSeconds,
            firstOutputTimeoutSeconds: options.firstOutputTimeoutSeconds,
            streamOutput: options.streamOutput,
          });
        }
        options.validatePart?.(authored);
        const stored = { ...authored, sha256: sha256Text(authored.content) };
        checkpoint.parts.push(stored);
        completed.set(key, stored);
        await saveCheckpoint(options.runRoot, options.checkpointName, checkpoint);
      }
    }
  } finally {
    await chmod(closedRoot, 0o700).catch(() => undefined);
    await rm(closedRoot, { recursive: true, force: true });
  }
  return options.assemble?.(checkpoint.plan, checkpoint.parts) ?? assembleDocumentPlan(checkpoint.plan, checkpoint.parts);
}

export interface GenerationRequestOptions {
  state: HarnessRunState;
  inputPackage: HarnessInputPackage;
  runRoot: string;
  evidenceRoot: string;
  timeoutSeconds: number;
  firstOutputTimeoutSeconds: number;
  streamOutput?: boolean;
}

export async function requestDocumentBundle(options: GenerationRequestOptions): Promise<DocumentBundle> {
  const resources = await loadWorkflowResources(options.state.workflow, {
    includeHeadlessContracts: requestNeedsHeadlessContracts(options.state.request),
    section: "generation",
  });
  const prefix = stableGenerationPrefix(options.state, options.inputPackage, resources);
  return authorIncrementally({
    ...options,
    mode: "generation",
    stage: "generation",
    checkpointName: "incremental-generation",
    logPrefix: "generation",
    prefix,
    planPrompt: buildGenerationPrompt(options.state, options.inputPackage, resources),
    replanPrompt: (defect) => buildGenerationPrompt(options.state, options.inputPackage, resources, defect),
  });
}

export interface StructuralError {
  code: string;
  message: string;
  path?: string;
  line?: number;
}

export interface StructuralRepairRegion {
  id: string;
  path: string;
  /** Original UTF-8 byte offsets. These are Harness authority and never enter prompts. */
  start: number;
  end: number;
  findingIds: string[];
  anchor: { kind: "task" | "phase" | "document-line"; id: string };
  originalContent: string;
}

export function buildRepairPrompt(
  state: HarnessRunState,
  bundle: DocumentBundle,
  errors: StructuralError[],
  affected: string[],
  dependencies: string[] = [],
  protocolDefect?: string,
): string {
  const regions = deriveStructuralRepairRegions(bundle, errors);
  const prompt = [
    "You are the RB Harness structural repair writer. Repair only deterministic errors; never rewrite unrelated documents.",
    "RB Harness owns region boundaries, files, validation, checkpoints, deterministic splicing, and publication. Return a compact region plan before any replacement content.",
    `Return exactly ${DOCUMENT_PLAN_BEGIN}, one JSON object, and ${DOCUMENT_PLAN_END}. Do not use Markdown fences or surrounding prose.`,
    `The JSON shape is:\n${PLAN_SHAPE}`,
    repairContractDigest(state.workflow),
    `\n===== DETERMINISTIC ERRORS =====\n${JSON.stringify(errors.map((error, index) => ({ order: index + 1, ...error })))}`,
    `\n===== CODE-OWNED MUTABLE REGIONS =====\n${JSON.stringify(regions.map((region) => ({
      regionId: region.id,
      path: region.path,
      anchor: region.anchor,
      findingIds: region.findingIds,
      content: region.originalContent,
    })))}`,
    dependencies.length
      ? `\n===== FINALIZED READ-ONLY DEPENDENCIES =====\n${JSON.stringify(documentExcerpts(bundle, dependencies))}`
      : "",
    `\n===== DOCUMENTS THAT MUST NOT CHANGE =====\n${JSON.stringify(bundle.documents.map((document) => document.path).filter((path) => !affected.includes(path)))}`,
    "Plan exactly the supplied CODE-OWNED MUTABLE REGIONS under their existing paths. Each document part ID must be one supplied regionId, every regionId must appear exactly once, and no other part/document is authorized.",
    "Part purposes may group or describe repairs, but any line number, byte range, or span mentioned by the model is presentation-only and cannot change authority. Do not add a conditional artifact to satisfy a dependency.",
    "Each part writer returns only that region's replacement content in an rb-harness-document-part/v1 envelope identifying the assigned regionId. It must not reproduce the full document, neighboring tasks, outside phase headings, or immutable transitions.",
    protocolDefect ? `A prior repair response was rejected. Do not repeat it: ${protocolDefect}` : "",
  ].filter(Boolean).join("\n");
  assertPromptWithinBudget(prompt, HARNESS_BUDGET.prompt.maxRepairPromptBytes, "structural repair plan");
  return prompt;
}

export interface RepairRequestOptions {
  state: HarnessRunState;
  bundle: DocumentBundle;
  errors: StructuralError[];
  runRoot: string;
  evidenceRoot: string;
  timeoutSeconds: number;
  firstOutputTimeoutSeconds: number;
  streamOutput?: boolean;
  repairPass?: number;
}

/**
 * Load-bearing markers a repaired document must not lose.
 *
 * A repaired document replaces its original in full, so a repair that emits
 * only the corrected fragment silently deletes the rest of the file. The
 * deterministic validators then report the *symptoms* — missing title, missing
 * contract marker, no phases — which read as a rewrite that went wrong rather
 * than as a truncation. These invariants name the real defect instead.
 */
function documentInvariants(content: string): string[] {
  const invariants: string[] = [];
  const title = content.match(/^#\s+\S.*$/m);
  if (title) invariants.push("its title line");
  for (const marker of content.matchAll(/<!--\s*(rb-execution-contract|rb-artifact-id)\s*:\s*(\S+?)\s*-->/g)) {
    invariants.push(`the ${marker[1]} marker ${marker[2]}`);
  }
  return invariants;
}

interface RepairRange { start: number; end: number }
interface RepairCandidate extends RepairRange {
  path: string;
  findingId: string;
  anchor: StructuralRepairRegion["anchor"];
}

function lineOffsets(source: string): Array<{ start: number; end: number; text: string }> {
  const lines: Array<{ start: number; end: number; text: string }> = [];
  let start = 0;
  for (const match of source.matchAll(/.*(?:\n|$)/g)) {
    if (!match[0]) continue;
    const bytes = Buffer.byteLength(match[0], "utf8");
    lines.push({ start, end: start + bytes, text: match[0].replace(/\r?\n$/, "") });
    start += bytes;
  }
  return lines;
}

function taskRegion(
  lines: ReturnType<typeof lineOffsets>,
  taskStart: number,
): RepairRange {
  let boundary = taskStart + 1;
  while (boundary < lines.length
    && !/^- \[[ x]\] T\d{3,} —/.test(lines[boundary]!.text)
    && !/^## Phase \d+:/.test(lines[boundary]!.text)) boundary += 1;
  let lastOwned = boundary - 1;
  while (lastOwned > taskStart && lines[lastOwned]!.text.trim() === "") lastOwned -= 1;
  return { start: lines[taskStart]!.start, end: lines[lastOwned]!.end };
}

function structuralRegion(
  original: string,
  path: string,
  error: StructuralError,
  findingId: string,
): RepairCandidate | undefined {
  const lines = lineOffsets(original);
  const taskId = error.message.match(/\b(T\d{3,})\b/)?.[1];
  let anchor = error.line ? Math.max(0, error.line - 1) : -1;
  if (taskId) {
    const matches = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => new RegExp(`^- \\[.\\] ${taskId} —`).test(line.text));
    if (matches.length !== 1) return undefined;
    anchor = matches[0]!.index;
  }
  if (anchor < 0 || anchor >= lines.length) {
    if (error.code.startsWith("document.title")) anchor = lines.findIndex((line) => /^#\s+/.test(line.text));
    else if (error.code.startsWith("document.contract")) anchor = lines.findIndex((line) => /rb-execution-contract/.test(line.text));
    else if (error.code.startsWith("document.artifact-id")) anchor = lines.findIndex((line) => /rb-artifact-id/.test(line.text));
  }
  if (anchor < 0 || anchor >= lines.length) return undefined;

  let taskStart = (() => {
    for (let index = anchor; index >= 0; index -= 1) if (/^- \[[ x]\] T\d{3,} —/.test(lines[index]!.text)) return index;
    return -1;
  })();
  if (taskStart >= 0) {
    const nextPhase = (() => {
      for (let index = taskStart + 1; index <= anchor; index += 1) if (/^## Phase \d+:/.test(lines[index]!.text)) return index;
      return -1;
    })();
    if (nextPhase >= 0) taskStart = -1;
  }
  if (taskStart >= 0) {
    const id = lines[taskStart]!.text.match(/^- \[[ x]\] (T\d{3,}) —/)?.[1];
    if (!id) return undefined;
    return { path, findingId, anchor: { kind: "task", id }, ...taskRegion(lines, taskStart) };
  }
  if (/^phase\./.test(error.code) && /^## Phase \d+:/.test(lines[anchor]!.text)) {
    const id = lines[anchor]!.text.match(/^## Phase (\d+):/)?.[1];
    if (!id) return undefined;
    return {
      path,
      findingId,
      anchor: { kind: "phase", id: `Phase ${id}` },
      start: lines[anchor]!.start,
      end: lines[anchor]!.end,
    };
  }
  if (/^document\./.test(error.code)) {
    return {
      path,
      findingId,
      anchor: { kind: "document-line", id: error.code },
      start: lines[anchor]!.start,
      end: lines[anchor]!.end,
    };
  }
  return undefined;
}

function mergeRepairRanges(candidates: RepairCandidate[]): Array<Omit<StructuralRepairRegion, "id" | "originalContent">> {
  const merged: Array<Omit<StructuralRepairRegion, "id" | "originalContent">> = [];
  const sorted = [...candidates].sort((left, right) =>
    left.path.localeCompare(right.path) || left.start - right.start || left.end - right.end);
  for (const candidate of sorted) {
    const previous = merged.at(-1);
    if (previous && previous.path === candidate.path && candidate.start < previous.end) {
      if (previous.start !== candidate.start || previous.end !== candidate.end
        || previous.anchor.kind !== candidate.anchor.kind || previous.anchor.id !== candidate.anchor.id) {
        throw new Error(
          `structural repair cannot merge overlapping code-owned boundaries in ${candidate.path}: ${previous.anchor.id} and ${candidate.anchor.id}`,
        );
      }
      previous.findingIds.push(candidate.findingId);
      continue;
    }
    if (previous && previous.path === candidate.path
      && previous.start === candidate.start && previous.end === candidate.end) {
      previous.findingIds.push(candidate.findingId);
      continue;
    }
    merged.push({
      path: candidate.path,
      start: candidate.start,
      end: candidate.end,
      findingIds: [candidate.findingId],
      anchor: candidate.anchor,
    });
  }
  return merged;
}

export function deriveStructuralRepairRegions(
  bundle: DocumentBundle,
  errors: readonly StructuralError[],
): StructuralRepairRegion[] {
  const originals = new Map(bundle.documents.map((document) => [document.path, document.content]));
  const candidates = errors.map((error, index) => {
    if (!error.path || !originals.has(error.path)) {
      throw new Error("structural repair cannot derive a bounded mutable region for a finding without a current-run document path");
    }
    const region = structuralRegion(originals.get(error.path)!, error.path, error, `finding-${String(index + 1).padStart(3, "0")}`);
    if (!region) {
      throw new Error(
        `structural repair cannot prove semantic preservation for ${error.path}: the deterministic error does not identify a safely mutable structural region`,
      );
    }
    return region;
  });
  return mergeRepairRanges(candidates).map((region, index) => ({
    ...region,
    id: `repair-region-${String(index + 1).padStart(3, "0")}`,
    originalContent: Buffer.from(originals.get(region.path)!, "utf8").subarray(region.start, region.end).toString("utf8"),
  }));
}

export function assertImmutableChunks(original: string, repaired: string, ranges: RepairRange[], path: string): void {
  const originalBytes = Buffer.from(original, "utf8");
  const repairedBytes = Buffer.from(repaired, "utf8");
  const chunks: Buffer[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) chunks.push(originalBytes.subarray(cursor, range.start));
    cursor = range.end;
  }
  if (cursor < originalBytes.length) chunks.push(originalBytes.subarray(cursor));
  if (!chunks.length) {
    throw new Error(`structural repair cannot prove semantic preservation for ${path}: no immutable region remains outside the authorized structural errors.`);
  }
  let repairedCursor = 0;
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index]!;
    const found = repairedBytes.indexOf(chunk, repairedCursor);
    if (found < 0 || (index === 0 && ranges[0]!.start > 0 && found !== 0)) {
      throw new Error(`structural repair changed unrelated semantic content in ${path} outside the explicitly authorized structural region.`);
    }
    repairedCursor = found + chunk.length;
  }
  if (ranges.at(-1)!.end < originalBytes.length && repairedCursor !== repairedBytes.length) {
    throw new Error(`structural repair changed unrelated semantic content in ${path} outside the explicitly authorized structural region.`);
  }
}

/** Reject a repair that dropped identity or changed bytes outside listed structural errors. */
export function assertRepairPreservedDocument(
  original: string,
  repaired: string,
  path: string,
  errors: readonly StructuralError[] = [],
): void {
  const missing = documentInvariants(original).filter((invariant) => {
    if (invariant === "its title line") return !/^#\s+\S.*$/m.test(repaired);
    const value = invariant.slice(invariant.lastIndexOf(" ") + 1);
    return !repaired.includes(value);
  });
  if (missing.length) {
    throw new Error(
      `structural repair truncated ${path}: the repaired document no longer carries ${missing.join(", ")}. `
      + "A repaired document replaces the original in full, so its parts must reproduce the complete corrected document, not only the fragment that changed.",
    );
  }
  if (original === repaired) return;
  const relevant = errors.filter((error) => !error.path || error.path === path);
  const identified = relevant.map((error, index) => structuralRegion(
    original,
    path,
    error,
    `finding-${String(index + 1).padStart(3, "0")}`,
  ));
  if (!identified.length || identified.some((range) => !range)) {
    throw new Error(`structural repair cannot prove semantic preservation for ${path}: the deterministic error does not identify a safely mutable structural region.`);
  }
  const ranges = mergeRepairRanges(identified as RepairCandidate[]);
  assertImmutableChunks(original, repaired, ranges, path);
}

function assertRegionLocalReplacement(region: StructuralRepairRegion, content: string): void {
  if (!content) throw new Error(`structural repair region ${region.id} has no replacement content`);
  if (region.originalContent.endsWith("\n") && !content.endsWith("\n")) {
    throw new Error(`structural repair region ${region.id} must end at its existing line boundary`);
  }
  if (region.anchor.kind !== "task") {
    if (/\r?\n/.test(content.replace(/\r?\n$/, ""))) {
      throw new Error(`structural repair region ${region.id} returned complete-document or outside-region content`);
    }
    return;
  }
  if (/^# RB Execution Plan:/m.test(content) || /^## Phase \d+:/m.test(content)
    || /<!--\s*(?:rb-execution-contract|rb-artifact-id)\s*:/m.test(content)) {
    throw new Error(`structural repair region ${region.id} returned complete-document or outside-region content`);
  }
  const taskHeadings = [...content.matchAll(/^(?:- )?\[[ x]\] (T\d{3,})(?:\s+—)?/gm)].map((match) => match[1]);
  if (taskHeadings.length > 1 || (taskHeadings.length === 1 && taskHeadings[0] !== region.anchor.id)) {
    throw new Error(
      `structural repair region ${region.id} contains a task outside its owned anchor ${region.anchor.id}`,
    );
  }
}

function validateRepairedDocument(path: string, original: string, content: string): void {
  if (!/\/PHASES\.md$/i.test(path)) return;
  const validation = validateExecutionMarkdown(content);
  if (!validation.valid) {
    throw new Error(
      `structural repair produced an invalid execution document ${path}: `
      + validation.issues.map((issue) => `${issue.code}: ${issue.message}`).join("; "),
    );
  }
  const originalDocument = validateExecutionMarkdown(original).document;
  if (originalDocument && validation.document) {
    const originalPhases = originalDocument.phases.map((phase) => phase.id);
    const repairedPhases = validation.document.phases.map((phase) => phase.id);
    const originalTasks = originalDocument.phases.flatMap((phase) => phase.tasks.map((task) => task.id));
    const repairedTasks = validation.document.phases.flatMap((phase) => phase.tasks.map((task) => task.id));
    if (JSON.stringify(originalPhases) !== JSON.stringify(repairedPhases)
      || JSON.stringify(originalTasks) !== JSON.stringify(repairedTasks)) {
      throw new Error(
        `structural repair produced an invalid execution document ${path}: phase/task structural anchors changed`,
      );
    }
  }
}

export function spliceStructuralRepairParts(
  bundle: DocumentBundle,
  regions: readonly StructuralRepairRegion[],
  plan: DocumentPlan,
  parts: readonly DocumentPart[],
): DocumentBundle {
  if (plan.status === "blocked") return assembleDocumentPlan(plan, []);
  assertStructuralRepairPlanAuthority(
    { kind: "plan", plan },
    [...new Set(regions.map((region) => region.path))],
    regions,
  );
  const originals = new Map(bundle.documents.map((document) => [document.path, document.content]));
  const replacements = new Map(parts.map((part) => [`${part.path}\0${part.part}`, part.content]));
  const documents: GeneratedDocument[] = [];
  for (const path of [...new Set(regions.map((region) => region.path))].sort((left, right) => left.localeCompare(right))) {
    const original = originals.get(path);
    if (original === undefined) throw new Error(`structural repair original disappeared: ${path}`);
    let result = Buffer.from(original, "utf8");
    const documentRegions = regions.filter((region) => region.path === path)
      .sort((left, right) => right.start - left.start);
    for (const region of documentRegions) {
      const replacement = replacements.get(`${path}\0${region.id}`);
      if (replacement === undefined) throw new Error(`structural repair is missing replacement ${path}#${region.id}`);
      assertRegionLocalReplacement(region, replacement);
      result = Buffer.concat([
        result.subarray(0, region.start),
        Buffer.from(replacement, "utf8"),
        result.subarray(region.end),
      ]);
    }
    const content = result.toString("utf8");
    assertImmutableChunks(original, content, [...documentRegions].sort((left, right) => left.start - right.start), path);
    assertRepairPreservedDocument(
      original,
      content,
      path,
      regions.filter((region) => region.path === path).flatMap((region) =>
        region.findingIds.map((findingId) => ({ code: findingId, message: region.anchor.id, path }))),
    );
    validateRepairedDocument(path, original, content);
    documents.push({ path, content });
  }
  if (replacements.size !== regions.length) {
    throw new Error("structural repair returned duplicate or unexpected region replacements");
  }
  process.stdout.write(
    `[rb-harness] structural repair splice ${JSON.stringify({
      mutableRegions: regions.length,
      regionIds: regions.map((region) => region.id),
      anchors: regions.map((region) => region.anchor.id),
      replacementsApplied: regions.length,
    })}\n`,
  );
  harnessTelemetry()?.recordStructuralRepair({
    mutableRegions: regions.length,
    regionIds: regions.map((region) => region.id),
    anchors: regions.map((region) => region.anchor.id),
    replacementsApplied: regions.length,
  });
  return {
    contract: DOCUMENT_BUNDLE_CONTRACT,
    status: "complete",
    summary: plan.summary,
    documents,
    blocked: [],
  };
}

export async function requestStructuralRepair(options: RepairRequestOptions): Promise<DocumentBundle> {
  const known = new Set(options.bundle.documents.map((document) => document.path));
  const affected = [...new Set(options.errors.map((error) => error.path).filter((path): path is string => Boolean(path && known.has(path))))]
    .sort((left, right) => left.localeCompare(right));
  const affectedDirectories = new Set(affected.map((path) => path.slice(0, path.lastIndexOf("/"))));
  const dependencies = options.bundle.documents
    .map((document) => document.path)
    .filter((path) => !affected.includes(path)
      && affectedDirectories.has(path.slice(0, path.lastIndexOf("/")))
      && /\/(?:PHASES\.md|OPERATIONS\.json|SPEC\.md|REQUIREMENTS\.md|PLAN\.md)$/i.test(path))
    .sort((left, right) => left.localeCompare(right));
  const regions = deriveStructuralRepairRegions(options.bundle, options.errors);
  process.stdout.write(
    `[rb-harness] structural repair regions ${JSON.stringify({
      mutableRegions: regions.length,
      regionIds: regions.map((region) => region.id),
      anchors: regions.map((region) => region.anchor.id),
    })}\n`,
  );
  const planPrompt = buildRepairPrompt(options.state, options.bundle, options.errors, affected, dependencies);
  const repaired = await authorIncrementally({
    state: options.state,
    runRoot: options.runRoot,
    evidenceRoot: options.evidenceRoot,
    timeoutSeconds: options.timeoutSeconds,
    firstOutputTimeoutSeconds: options.firstOutputTimeoutSeconds,
    streamOutput: options.streamOutput,
    mode: "repair",
    stage: "structural-repair",
    checkpointName: `incremental-structural-repair-${options.repairPass ?? 1}`,
    logPrefix: `structural-repair-${options.repairPass ?? 1}`,
    prefix: [
      "You are the RB Harness structural repair writer. Write documentation only and replace only the one code-owned repair region named by the target part.",
      repairContractDigest(options.state.workflow),
    ].join("\n"),
    planPrompt,
    replanPrompt: (defect) => buildRepairPrompt(options.state, options.bundle, options.errors, affected, dependencies, defect),
    repairContextForPart: (path, part) => {
      const region = regions.find((candidate) => candidate.path === path && candidate.id === part);
      if (!region) return undefined;
      return JSON.stringify({
        regionId: region.id,
        path: region.path,
        anchor: region.anchor,
        findingIds: region.findingIds,
        errors: region.findingIds.map((findingId) => options.errors[Number(findingId.slice(-3)) - 1]),
        originalRegionContent: region.originalContent,
        instruction: "Return only this region's replacement content; do not include neighboring or complete-document content.",
      });
    },
    currentRunDocuments: options.bundle.documents,
    repairAuthorizedPaths: affected,
    repairAuthorizedRegions: regions,
    requirePartIdentity: true,
    validatePart: (part) => {
      const region = regions.find((candidate) => candidate.path === part.path && candidate.id === part.part);
      if (!region) throw new Error(`structural repair returned unknown repair-region ID ${part.part}`);
      assertRegionLocalReplacement(region, part.content);
    },
    assemble: (plan, parts) => spliceStructuralRepairParts(options.bundle, regions, plan, parts),
  });
  const originals = new Map(options.bundle.documents.map((document) => [document.path, document.content]));
  for (const document of repaired.documents) {
    if (known.has(document.path) && !affected.includes(document.path)) {
      throw new Error(`structural repair attempted to rewrite unaffected document ${document.path}`);
    }
    const original = originals.get(document.path);
    if (original) assertRepairPreservedDocument(original, document.content, document.path, options.errors);
  }
  return mergeDocumentBundles(options.bundle, repaired);
}

// Retained exports keep the internal contract migration source-compatible.
export { DOCUMENT_BUNDLE_BEGIN, DOCUMENT_BUNDLE_CONTRACT, DOCUMENT_BUNDLE_END };
