import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { walkFiles } from "./fs-utils.js";
import type { ExecutionDocument, Task, ValidationIssue } from "./types.js";

export const GO_TIDY_NONCONVERGENCE_CODE = "execution.go-tidy.nonconvergent-direct-requirement" as const;
export const GO_MODULE_IDENTITY_MISSING_CODE = "execution.go-direct-requirement.module-identity-missing" as const;

const DIRECT_GO_NOUN = "(?:direct(?:\\s+go)?\\s+(?:dependenc(?:y|ies)|requirements?|modules?)|direct\\s+`?require`?\\s+entr(?:y|ies)|depend[eê]ncias?\\s+diretas?|requisitos?\\s+diretos?|m[oó]dulos?\\s+diretos?)";
const DIRECT_GO_STATUS = new RegExp(`\\b(?:is|are|remain(?:s)?|stay(?:s)?|must be|shall be|é|são|permanece(?:m)?|deve(?:m)? ser)\\s+(?:an?\\s+)?${DIRECT_GO_NOUN}\\b`, "i");
const DIRECT_GO_ACTION = new RegExp(`\\b(?:add(?:s)?|declare(?:s)?|require(?:s)?|list(?:s)?|contain(?:s)?|include(?:s)?|keep(?:s)?|preserve(?:s)?|adiciona|declara|exige|lista|cont[eé]m|inclui|mant[eé]m|preserva)\\b.{0,120}\\b${DIRECT_GO_NOUN}\\b`, "i");
const DIRECT_GO_MODAL = new RegExp(`\\b(?:must|shall|should|deve(?:m)?|precisa(?:m)?|tem de)\\b.{0,120}\\b${DIRECT_GO_NOUN}\\b`, "i");
const DIRECT_GO_NEGATION = new RegExp(`(?:\\b(?:no|without|zero|nenhum(?:a|as)?|sem)\\b.{0,80}\\b${DIRECT_GO_NOUN}\\b|\\b(?:does not|do not|must not|shall not|não deve(?:m)?|não pode(?:m)?)\\b.{0,80}\\b${DIRECT_GO_NOUN}\\b)`, "i");
const IMPORT_INTENT = /\b(?:import(?:s|ed|ing)?|use[sd]?|using|consume[sd]?|integrat(?:e|es|ed|ing)|importa(?:r|do|dos|da|das)?|us(?:a|ar|ado|ados|a-se)|utiliza(?:r|do|dos)?|consum(?:e|ir|ido)|integra(?:r|do|dos)?)\b/i;
const GO_TIDY_COMMAND = /(?:^|(?:&&|;)\s*)go\s+mod\s+tidy(?=\s|$|&&|;)/i;
const GO_MODULE_PATH = /^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*(?:\/[A-Za-z0-9._~+/-]+)+$/i;

export interface GoImportInventory {
  imports: ReadonlySet<string>;
  /** False means the bounded scan stopped before absence could be proved. */
  complete: boolean;
}

export interface GoPlanConvergenceOptions {
  /** Omit for document-only validation; absence is then deliberately not inferred. */
  existingImports?: ReadonlySet<string>;
  path?: string;
}

function scopeTokens(value: string): string[] {
  return [...value.matchAll(/`([^`]+)`/g)]
    .map((match) => match[1]?.trim())
    .filter((path): path is string => Boolean(path));
}

function modulePaths(value: string): string[] {
  return [...new Set([...value.matchAll(/`([^`]+)`/g)]
    .map((match) => match[1]?.trim() ?? "")
    .filter((token) => GO_MODULE_PATH.test(token)))];
}

function requiresDirectGoDependency(value: string): boolean {
  if (DIRECT_GO_NEGATION.test(value)) return false;
  return DIRECT_GO_STATUS.test(value) || DIRECT_GO_ACTION.test(value) || DIRECT_GO_MODAL.test(value);
}

function runsGoModTidy(task: Task): boolean {
  return task.validation.some((entry) => {
    const command = entry.match(/^`([^`]+)`$/)?.[1]?.trim();
    return Boolean(command && GO_TIDY_COMMAND.test(command));
  });
}

function ownsGoMod(task: Task): boolean {
  return scopeTokens(task.scope).some((token) => /(?:^|\/)go\.mod$/.test(token.replace(/^\.\//, "")))
    || /`(?:\.\/)?(?:[^`/]+\/)*go\.mod`/.test(`${task.change}\n${task.acceptanceCriteria.join("\n")}`);
}

function ownsGoSource(task: Task): boolean {
  return scopeTokens(task.scope).some((token) => /\.go$/.test(token) || /\.go(?:[*?]|$)/.test(token));
}

function taskCitesImport(task: Task, module: string): boolean {
  const text = `${task.change}\n${task.acceptanceCriteria.join("\n")}`;
  return ownsGoSource(task)
    && IMPORT_INTENT.test(text)
    && modulePaths(text).some((candidate) => importSatisfiesModule(candidate, module));
}

function importSatisfiesModule(importPath: string, module: string): boolean {
  return importPath === module || importPath.startsWith(`${module}/`);
}

function criterionId(value: string, task: Task): string {
  return value.match(/^(AC-T[0-9]{3,}-[0-9]{2}):/)?.[1] ?? `${task.id} acceptance criterion`;
}

function validationIssue(code: string, message: string, task: Task, path?: string): ValidationIssue {
  return {
    code,
    message,
    severity: "error",
    line: task.line,
    ...(path ? { path } : {}),
  };
}

/** Whether proving absence/presence of an existing import can affect the result. */
export function goPlanNeedsImportInventory(document: ExecutionDocument): boolean {
  return document.phases.some((phase) => phase.tasks.some((task) =>
    runsGoModTidy(task)
      && ownsGoMod(task)
      && task.acceptanceCriteria.some(requiresDirectGoDependency)
      && modulePaths(`${task.change}\n${task.acceptanceCriteria.join("\n")}`).length > 0));
}

/**
 * Classify the finite Go shape whose canonical normalizer removes a required
 * direct dependency. Filesystem knowledge is an explicit input: the pure
 * document parser never reads a checkout and never guesses that an import is
 * absent.
 */
export function validateGoPlanConvergence(
  document: ExecutionDocument,
  options: GoPlanConvergenceOptions = {},
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const ordered = document.phases.flatMap((phase) => phase.tasks.map((task) => ({ phase, task })));

  for (const [taskIndex, entry] of ordered.entries()) {
    const task = entry.task;
    if (!ownsGoMod(task)) continue;
    const requirements = task.acceptanceCriteria.filter(requiresDirectGoDependency);
    if (!requirements.length) continue;
    const taskModules = modulePaths(`${task.change}\n${task.acceptanceCriteria.join("\n")}`);

    for (const criterion of requirements) {
      const modules = modulePaths(criterion).length ? modulePaths(criterion) : taskModules;
      if (!modules.length) {
        issues.push(validationIssue(
          GO_MODULE_IDENTITY_MISSING_CODE,
          `${task.id} ${criterionId(criterion, task)} requires direct Go dependencies but names no verifiable Go module path in backticks. `
            + "Names of products or libraries are insufficient authority; name each module path, for example `github.com/charmbracelet/bubbletea`.",
          task,
          options.path,
        ));
        continue;
      }

      if (!runsGoModTidy(task)) continue;

      // With no explicit inventory, absence is unknown. The caller may still
      // use the identity finding above, but must not claim non-convergence.
      if (!options.existingImports) continue;

      for (const module of modules) {
        if ([...options.existingImports].some((importPath) => importSatisfiesModule(importPath, module))) continue;
        if (taskCitesImport(task, module)) continue;

        const orderedProducer = ordered.slice(0, taskIndex).find(({ task: producer }) =>
          task.dependsOn.includes(producer.id) && taskCitesImport(producer, module));
        if (orderedProducer) continue;

        const laterProducer = ordered.slice(taskIndex + 1).find(({ task: producer }) => taskCitesImport(producer, module));
        const later = laterProducer
          ? ` The first planned compatible use is ${laterProducer.task.id} in ${laterProducer.phase.id}, after ${task.id}.`
          : " No task ordered before it both owns a `.go` source path and declares a legitimate import of that module.";
        issues.push(validationIssue(
          GO_TIDY_NONCONVERGENCE_CODE,
          `${task.id} ${criterionId(criterion, task)} requires direct Go module \`${module}\`, but its canonical \`go mod tidy\` validation has no compatible existing or explicitly ordered import producer in the current Scope/Depends on graph.${later} `
            + "Move the direct declaration to the first-use task, introduce the legitimate import in this task and include its `.go` file in Scope, or make this task depend on an earlier scoped import producer.",
          task,
          options.path,
        ));
      }
    }
  }
  return issues;
}

function goImports(source: string): string[] {
  const imports: string[] = [];
  for (const match of source.matchAll(/^\s*import\s+(?:[._A-Za-z][\w.]*\s+)?["`]([^"`]+)["`]/gm)) {
    if (match[1]) imports.push(match[1]);
  }
  for (const block of source.matchAll(/^\s*import\s*\(([^)]*)\)/gms)) {
    for (const match of (block[1] ?? "").matchAll(/^\s*(?:[._A-Za-z][\w.]*\s+)?["`]([^"`]+)["`]/gm)) {
      if (match[1]) imports.push(match[1]);
    }
  }
  return imports;
}

/** Bounded, deterministic inventory used only by workspace-aware gates. */
export async function inspectExistingGoImports(projectRoot: string): Promise<GoImportInventory> {
  const maxFiles = 50_000;
  const files = await walkFiles(projectRoot, maxFiles);
  const imports = new Set<string>();
  let complete = files.length < maxFiles;
  for (const path of files) {
    if (extname(path).toLowerCase() !== ".go") continue;
    let source: string;
    try {
      source = await readFile(path, "utf8");
    } catch {
      // Absence is authoritative only when every candidate source was read.
      // A permission/race failure must fail open instead of rejecting a plan
      // whose existing import may be in the unreadable file.
      complete = false;
      continue;
    }
    for (const importPath of goImports(source)) imports.add(importPath);
  }
  return { imports, complete };
}
