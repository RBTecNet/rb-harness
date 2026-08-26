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
} from "./harness-documents.js";
import {
  DOCUMENT_PART_BEGIN,
  DOCUMENT_PART_CONTRACT,
  DOCUMENT_PART_END,
  DOCUMENT_PLAN_BEGIN,
  DOCUMENT_PLAN_CONTRACT,
  DOCUMENT_PLAN_END,
  assembleDocumentPlan,
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
import { sha256Text } from "./hash.js";
import { validateExecutionMarkdown } from "./execution-contract.js";
import { loadWorkflowResources, requestNeedsHeadlessContracts } from "./standalone-resources.js";
import type { HarnessRunState, ProviderConfiguration } from "./standalone-types.js";

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
    "RB Harness, not you, owns files, checkpoints, validation, manifests, and publication. Your response is data for one bounded authoring step.",
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
    "Declare dependsOn for every document whose finalized decisions, paths, interfaces, or IDs constrain this document. The orchestrator adds mandatory workflow edges, rejects missing/cyclic dependencies, and authors in topological order.",
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
    "Return only the raw UTF-8 content of the requested document segment. Do not wrap it in JSON, protocol markers, commentary, or a Markdown code fence.",
    "Write only the requested contiguous segment. The first part begins the file; every later part continues exactly after the previous segment; concatenation must produce one complete document without omitted or duplicated text.",
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

function parsePartOrLegacyDocument(output: string, expected: { path: string; part: string }): DocumentPart {
  if (output.includes(DOCUMENT_PART_BEGIN)) return parseDocumentPart(output, expected);
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
): string | undefined {
  if (!target.dependsOn.length) return undefined;
  const sourceManifest = target.path.toLowerCase().endsWith("/source-manifest.json");
  const documents = target.dependsOn.map((path) => {
    const dependency = plan.documents.find((document) => document.path === path);
    if (!dependency) throw new Error(`planned dependency disappeared: ${path}`);
    const content = completedDocumentContent(dependency, completed);
    if (content === undefined) throw new Error(`planned dependency was not finalized before ${target.path}: ${path}`);
    if (sourceManifest) return { path, sha256: sha256Text(content) };
    const execution = path.toUpperCase().endsWith("/PHASES.MD") ? executionAuthorityProjection(content) : undefined;
    return execution
      ? { path, kind: "execution-authority", projection: execution }
      : { path, kind: "decision-authority", projection: proseAuthorityProjection(content) };
  });
  return boundedUtf8(JSON.stringify({ target: target.path, documents }), MAX_DEPENDENCY_PROJECTION_BYTES);
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
        return parsePlanOrLegacyBundle(rawPlan);
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
        parse: parsePlanOrLegacyBundle,
        timeoutSeconds: options.timeoutSeconds,
        firstOutputTimeoutSeconds: options.firstOutputTimeoutSeconds,
        streamOutput: options.streamOutput,
      });
    };

    let planned: PlannedOrLegacyBundle | undefined;
    let defect: string | undefined;
    for (let attempt = 1; attempt <= HARNESS_BUDGET.generation.planReplans + 1; attempt += 1) {
      try {
        planned = await requestPlan(attempt === 1 ? options.planPrompt : options.replanPrompt(defect!), attempt);
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
  if (checkpoint.plan.status === "blocked") return assembleDocumentPlan(checkpoint.plan, []);

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
              previousPart,
              options.repairContext,
              undefined,
              dependencyProjection(checkpoint.plan, document, completed),
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
          authored = parsePartOrLegacyDocument(rawPart, expected);
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
                dependencyProjection(checkpoint.plan, document, completed),
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
              authored = parsePartOrLegacyDocument(rawPart, expected);
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
  return assembleDocumentPlan(checkpoint.plan, checkpoint.parts);
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
}

export function buildRepairPrompt(
  state: HarnessRunState,
  bundle: DocumentBundle,
  errors: StructuralError[],
  affected: string[],
  dependencies: string[] = [],
  protocolDefect?: string,
): string {
  const prompt = [
    "You are the RB Harness structural repair writer. Repair only deterministic errors; never rewrite unrelated documents.",
    "RB Harness owns files, validation, checkpoints, and publication. Return a compact plan before any replacement content.",
    `Return exactly ${DOCUMENT_PLAN_BEGIN}, one JSON object, and ${DOCUMENT_PLAN_END}. Do not use Markdown fences or surrounding prose.`,
    `The JSON shape is:\n${PLAN_SHAPE}`,
    repairContractDigest(state.workflow),
    `\n===== DETERMINISTIC ERRORS =====\n${JSON.stringify(errors.map((error, index) => ({ order: index + 1, ...error })))}`,
    `\n===== AFFECTED DOCUMENTS =====\n${JSON.stringify(documentExcerpts(bundle, affected))}`,
    dependencies.length
      ? `\n===== FINALIZED READ-ONLY DEPENDENCIES =====\n${JSON.stringify(documentExcerpts(bundle, dependencies))}`
      : "",
    `\n===== DOCUMENTS THAT MUST NOT CHANGE =====\n${JSON.stringify(bundle.documents.map((document) => document.path).filter((path) => !affected.includes(path)))}`,
    `Plan only replacements or additions required by those errors. Existing documents outside AFFECTED DOCUMENTS are forbidden.`,
    `Every document you plan is rewritten in full from its parts, so plan parts that cover the whole corrected document — not just the fragment that changes. Split it into parts of at most ${HARNESS_BUDGET.documents.maxPartBytes} UTF-8 bytes, and state in each part purpose which span of the original it reproduces and what, if anything, changes inside it. The part writer cannot inspect files; it sees the original under REPAIR AUTHORITY and must reproduce its span byte for byte apart from the listed error.`,
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

/** Reject a repair that dropped what the original document declared. */
export function assertRepairPreservedDocument(original: string, repaired: string, path: string): void {
  const missing = documentInvariants(original).filter((invariant) => {
    if (invariant === "its title line") return !/^#\s+\S.*$/m.test(repaired);
    const value = invariant.slice(invariant.lastIndexOf(" ") + 1);
    return !repaired.includes(value);
  });
  if (!missing.length) return;
  throw new Error(
    `structural repair truncated ${path}: the repaired document no longer carries ${missing.join(", ")}. `
    + "A repaired document replaces the original in full, so its parts must reproduce the complete corrected document, not only the fragment that changed.",
  );
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
      "You are the RB Harness structural repair writer. Write documentation only and change only the authorized affected documents.",
      repairContractDigest(options.state.workflow),
    ].join("\n"),
    planPrompt,
    replanPrompt: (defect) => buildRepairPrompt(options.state, options.bundle, options.errors, affected, dependencies, defect),
    repairContext: JSON.stringify({
      errors: options.errors,
      affected: documentExcerpts(options.bundle, affected),
      dependencies: documentExcerpts(options.bundle, dependencies),
    }),
  });
  const originals = new Map(options.bundle.documents.map((document) => [document.path, document.content]));
  for (const document of repaired.documents) {
    if (known.has(document.path) && !affected.includes(document.path)) {
      throw new Error(`structural repair attempted to rewrite unaffected document ${document.path}`);
    }
    const original = originals.get(document.path);
    if (original) assertRepairPreservedDocument(original, document.content, document.path);
  }
  return mergeDocumentBundles(options.bundle, repaired);
}

// Retained exports keep the internal contract migration source-compatible.
export { DOCUMENT_BUNDLE_BEGIN, DOCUMENT_BUNDLE_CONTRACT, DOCUMENT_BUNDLE_END };
