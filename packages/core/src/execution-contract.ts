import type {
  ExecutionDocument,
  ExecutionValidation,
  Phase,
  Task,
  ValidationIssue,
} from "./types.js";
import { validateGoPlanConvergence } from "./go-plan-convergence.js";

const CONTRACT = "rb-execution/v1" as const;
const PHASE_HEADING = /^## Phase ([0-9]+):\s+(.+)$/;
const TASK_HEADING = /^- \[([ x])\] (T[0-9]{3,}) —\s+(.+)$/;
const PHASE_FIELD = /^\*\*(Phase ID|Goal|Depends on):\*\*\s*(.*)$/;
const TASK_FIELD = /^  - \*\*(Scope|Change|Covers|Depends on|Parallel safe|Acceptance criteria|Validation|Expected evidence):\*\*\s*(.*)$/;

export interface ValidationInstruction {
  kind: "command" | "manual" | "human";
  value: string;
}

export function parseValidationInstruction(value: string): ValidationInstruction | undefined {
  if (value.includes("\t") || value.includes("\r") || value.includes("\n")) return undefined;
  const command = value.match(/^`([^`]+)`$/);
  if (command?.[1]?.trim()) return { kind: "command", value: command[1].trim() };
  const manual = value.match(/^manual:\s+(.+)$/i);
  if (manual?.[1]?.trim()) return { kind: "manual", value: manual[1].trim() };
  const human = value.match(/^human:\s+(.+)$/i);
  if (human?.[1]?.trim()) return { kind: "human", value: human[1].trim() };
  return undefined;
}

/**
 * Service commands that never return on their own.
 *
 * A validation is run to completion and judged by its exit code. A server or
 * watcher has no exit code to give: the runner waits out the validation
 * timeout, fails the phase, and repeats it. An observed plan declared
 * `npm start` as the validation for the task that made `npm start` work, which
 * would have cost fifteen minutes per attempt to discover.
 */
const LONG_RUNNING_COMMAND = new RegExp(
  "^(?:"
  // JVM, BEAM, PHP, Ruby, and Python service entrypoints. This is a list, not
  // a proof: it recognizes the common ones across ecosystems and will miss a
  // service it has never seen. A miss costs one validation timeout, which is
  // why the contract text also tells the writer the rule.
  + "(?:mvn|\\./mvnw)\\s+[^|;&]*(?:spring-boot:run|jetty:run|tomcat7?:run|quarkus:dev)"
  + "|(?:gradle|\\./gradlew)\\s+[^|;&]*(?:bootRun|run|quarkusDev)(?=\\s|$)"
  + "|mix\\s+(?:phx\\.server|run\\s+--no-halt)"
  + "|(?:php\\s+)?artisan\\s+serve(?=\\s|$)"
  + "|php\\s+-S(?=\\s|$)"
  + "|(?:bundle\\s+exec\\s+)?(?:puma|unicorn|thin|rackup|passenger\\s+start)(?=\\s|$)"
  + "|(?:bundle\\s+exec\\s+)?rails\\s+(?:s|server)(?=\\s|$)"
  + "|sbt\\s+[^|;&]*\\brun(?=\\s|$)"
  + "|(?:air|watchexec|entr|reflex|fswatch|caddy\\s+run|nginx(?:\\s|$))"
  + "|"
  // The script name must end here: `npm run start:check` is a one-shot check,
  // not the dev server, and rejecting it would be a false positive.
  + "(?:npm|pnpm|yarn|bun)\\s+(?:run\\s+)?(?:start|dev|serve|preview|watch)(?=\\s|$)"
  + "|(?:npx|pnpx)\\s+(?:serve|http-server|vite|nodemon)(?=\\s|$)"
  + "|(?:vite|nodemon|serve|http-server|webpack-dev-server)(?=\\s|$)"
  + "|(?:python3?\\s+-m\\s+http\\.server)(?=\\s|$)"
  + "|(?:docker(?:-compose)?\\s+up)(?!\\s+[^|;&]*--(?:abort-on-container-exit|exit-code-from))"
  + "|(?:go\\s+run|cargo\\s+run|dotnet\\s+run|rails\\s+server|flask\\s+run|uvicorn|gunicorn)(?=\\s|$)"
  + ")",
  "i",
);

/** A `--watch`-style flag turns any command into one that never returns. */
const WATCH_FLAG = /(^|\s)--watch(?:=(?:true|always))?(\s|$)|(^|\s)-w(\s|$)/i;

/**
 * A syntax checker aimed at a format it cannot parse.
 *
 * `node --check` validates JavaScript. Pointed at JSON it reads the object as a
 * labelled block and fails on the first comma, so it exits non-zero for a
 * perfectly valid file — it cannot distinguish a good one from a broken one.
 * An observed plan used exactly `node --check .rb/init/OPERATIONS.json` to prove
 * the operational contract, which meant that phase could never complete.
 *
 * Only data and markup formats are listed. `.ts` is deliberately absent: whether
 * `node --check` accepts it depends on the runtime's type stripping, so
 * rejecting it could be wrong on a project that has it enabled.
 */
const NON_JAVASCRIPT_TARGET = /\.(?:json|jsonc|ya?ml|toml|ini|md|markdown|html?|css|xml|csv|txt|lock)(?=\s|$)/i;

function impossibleChecker(command: string): string | undefined {
  const nodeCheck = command.match(/^node\s+(?:[^|;&]*\s)?--check\s+(\S+)/i);
  if (nodeCheck?.[1] && NON_JAVASCRIPT_TARGET.test(nodeCheck[1])) {
    const target = nodeCheck[1];
    const suggestion = /operations?\.json$/i.test(target)
      ? ` Use \`rb-harness operations validate ${target}\` instead.`
      : " Use a checker for that format instead.";
    return `runs \`node --check\`, which parses JavaScript, against ${target}; it exits non-zero for a valid file `
      + `and cannot tell one from a broken one, so this validation can never pass.${suggestion}`;
  }
  return undefined;
}

function ambiguousValidationInstruction(instruction: ValidationInstruction): string | undefined {
  if (instruction.kind === "command") {
    if (/(^|\s)(?:\|\|\s*true|;\s*(?:true|exit\s+0))(?:\s|$)/i.test(instruction.value)) {
      return "must not mask a failing command with a forced successful exit";
    }
    // The mirror of the `manual: run ...` defect below: prose that names a
    // manager inspection, wrapped in backticks so the runner executes it. The
    // shell has no `manual:` program, so the phase can only ever fail.
    const disguised = instruction.value.match(/^(manual|human)\s*:/i);
    if (disguised) {
      const kind = disguised[1]!.toLowerCase();
      return `is prose written as a command; drop the backticks and declare it as \`${kind}: ...\` so it reaches the ${
        kind === "manual" ? "manager as an inspection" : "operator as external evidence"
      }`;
    }
    const impossible = impossibleChecker(instruction.value);
    if (impossible) return impossible;
    if (LONG_RUNNING_COMMAND.test(instruction.value) || WATCH_FLAG.test(instruction.value)) {
      return "starts a long-running service or watcher and never exits; a validation must run to completion "
        + "and return its real exit code, so prove the running service through OPERATIONS.json instead";
    }
    return undefined;
  }

  if (instruction.kind === "manual") {
    const executableProse = /^(?:run|execute|invoke|launch|start|test|verify by running|executar|rodar|iniciar|testar|verificar executando)\b/i;
    if (executableProse.test(instruction.value)) {
      return "uses manual prose for an executable check; declare the exact command or use human: for evidence unavailable to the executor";
    }
  }
  return undefined;
}

function ambiguousAcceptanceCriterion(value: string): string | undefined {
  const body = value.replace(/^AC-T[0-9]{3,}-[0-9]{2}:\s*/i, "").trim();
  const requirementId = "(?:RF|RNF|UI|CT)-[0-9]+";
  const circularPatterns = [
    new RegExp(`\\b(?:satisf(?:y|ies)|meet(?:s)?|fulfill(?:s)?|implement(?:s)?)\\s+(?:the\\s+)?(?:requirements?\\s+)?${requirementId}\\b`, "i"),
    new RegExp(`\\b(?:behavior|behaviour|contract|interface|change)\\s+(?:required|described|defined|specified)\\s+(?:by|in)\\s+${requirementId}\\b`, "i"),
    new RegExp(`\\bmatches\\s+(?:every\\s+)?(?:field(?:s)?(?:\\s+and\\s+errors?)?\\s+)?(?:in\\s+)?${requirementId}\\b`, "i"),
    new RegExp(`\\b(?:according to|as (?:defined|described|documented|specified) in)\\s+${requirementId}\\b`, "i"),
  ];
  if (circularPatterns.some((pattern) => pattern.test(body))) {
    return "must state the observable result instead of delegating meaning to a requirement ID";
  }

  const vaguePatterns = [
    /\b(?:appropriate(?:ly)?|adequate(?:ly)?|reasonable|reasonably|proper(?:ly)?|correctly|fast|securely)\b/i,
    /\b(?:as needed|when possible|if appropriate|where valid|where applicable|works? as expected|handles? errors?)\b/i,
    /\b(?:adequad[ao]s?|apropriad[ao]s?|corretamente|razoavelmente)\b/i,
    /\b(?:conforme necess[aá]rio|quando poss[ií]vel|onde (?:for|seja) v[aá]lid[oa]|quando aplic[aá]vel|funciona conforme esperado|trata (?:os )?erros?)\b/i,
    /(?:^|\s)etc\.(?:\s|$)/i,
  ];
  if (vaguePatterns.some((pattern) => pattern.test(body))) {
    return "contains vague language without an observable boundary";
  }
  if (/\bOPERATIONS\.json\b/i.test(body)
    && /\b(?:pass(?:es|ed)?|succeed(?:s|ed)?|run(?:s)? successfully|clean[- ]room|passes? in|executad[oa]|passa|sucesso|ambiente limpo)\b/i.test(body)) {
    return "requires future final-audit evidence; Harness generation owns the valid operational contract, while its execution belongs to the post-phase operational audit";
  }
  return undefined;
}

/**
 * User-visible presentation cannot be proved by DOM presence alone.
 *
 * This intentionally recognizes semantics rather than a particular frontend
 * stack. Strong visual words are sufficient; weaker "show/display" verbs only
 * count when the criterion also names a UI surface. The latter avoids treating
 * a CLI criterion such as "the command displays its version" as visual UI.
 */
const STRONG_VISUAL_CRITERION = /\b(?:visib(?:le|ility|ly|ilidade|ilidades)|vis[ií]v(?:el|eis)|visual(?:ly|mente|s)?|render(?:ed|ing|iza(?:do|da|dos|das|r|ção))?|responsive|responsiv[oa]s?|aligned?|alinhad[oa]s?|viewport|screen|tela|graphical|gr[aá]fic[oa]s?|stylesheet|css|animation|animated|anima(?:tion|ted|ção|do|da|dos|das))\b/i;
const LAYOUT_CRITERION = /\blayout\b/i;
const WEAK_VISUAL_VERB = /\b(?:show(?:s|n)?|display(?:s|ed)?|appear(?:s|ed)?|exib(?:e|em|ido|ida|idos|idas|ir)|aparec(?:e|em|er))\b/i;
const UI_SURFACE = /\b(?:ui|interface|page|p[aá]gina|view|screen|tela|board|tabuleiro|button|bot[aã]o|panel|painel|dialog|modal|menu|form|formul[aá]rio|input|field|campo|message|mensagem|error|erro|image|imagem|icon|[ií]cone|vehicle|ve[ií]culo|chicken|galinha|flag|bandeirinha|element|elemento)\b/i;
const META_VISUAL_CONTRACT = /\b(?:contract|criterion|criteria|plan|instruction|evidence|contrato|crit[eé]rio|crit[eé]rios|plano|instru[cç][aã]o|evid[eê]ncia)\b/i;
const META_VISUAL_VALIDATOR = /\b(?:validator|validation|validador|valida[cç][aã]o)\b/i;
const NEGATIVE_VISUAL_CONTROL = /(?:\b(?:off[- ]?screen|overflow|overlap(?:ping)?|obscured|clipped|cropped|hidden|zero[- ]area|source\s+text|stylesheet\s+text|fora\s+(?:da|do)\s+viewport|sobrepost[oa]s?|sobreposi[cç][aã]o|ocult[oa]s?|cortad[oa]s?|texto[- ]fonte|texto\s+(?:css|javascript))\b|\b(?:no|not|never|without|none|absence|absent|n[aã]o|nenhum[ao]?|sem)\b.{0,100}\b(?:hidden|obscured|clipped|cropped|outside|overflow|overlap|source\s+text|stylesheet|ocult[oa]|cortad[oa]|fora|sobrepost[oa]|texto[- ]fonte|css|javascript)\b)/i;
const VISUAL_AUTOMATION_COMMAND = /\b(?:playwright|cypress|puppeteer|selenium|webdriver|chrom(?:e|ium)|firefox|webkit|cdp|browser|e2e|end[- ]to[- ]end|visual|screenshot|ui[-_: ]?test)\b/i;
const DURABLE_VISUAL_ARTIFACT = /\b(?:screenshots?|screen\s+captures?|capturas?\s+de\s+tela|\.png|\.jpe?g|\.webp)\b/i;
const EXACT_VIEWPORT = /\b[1-9][0-9]{2,3}\s*[x×]\s*[1-9][0-9]{2,3}\b/i;
const GEOMETRY_EVIDENCE = /\b(?:getBoundingClientRect|getComputedStyle|bounding\s+boxes?|computed\s+styles?|geometry|geometria|dimens(?:ions|ões)|positive\s+area|[aá]rea\s+positiva|intersect(?:ion|s)?|interse[cç][aã]o)\b/i;
const VISUAL_INTERACTION = /\b(?:before|after|press(?:ing|ed)?|click(?:ing|ed)?|keyboard|move(?:ment|d)?|transition|animation|initial\s+state|resulting\s+state|antes|depois|ap[oó]s|pression(?:ar|ado|ada)|clic(?:ar|ado|ada)|teclado|movimento|transi[cç][aã]o|anima[cç][aã]o|estado\s+inicial|estado\s+resultante)\b/i;
const BEFORE_EVIDENCE = /\b(?:before|initial|baseline|antes|inicial)\b/i;
const AFTER_EVIDENCE = /\b(?:after|resulting|final|depois|ap[oó]s|resultante)\b/i;

function isVisualAcceptanceCriterion(value: string): boolean {
  if (META_VISUAL_CONTRACT.test(value)) return false;
  if (META_VISUAL_VALIDATOR.test(value) && !UI_SURFACE.test(value)) return false;
  return STRONG_VISUAL_CRITERION.test(value)
    || ((WEAK_VISUAL_VERB.test(value) || LAYOUT_CRITERION.test(value)) && UI_SURFACE.test(value));
}

function validateVisualEvidenceContract(
  id: string,
  acceptanceCriteria: string[],
  validation: string[],
  expectedEvidence: string,
  issues: ValidationIssue[],
  line: number,
): void {
  const visualCriteria = acceptanceCriteria.filter(isVisualAcceptanceCriterion);
  if (visualCriteria.length === 0) return;

  const instructions = validation
    .map(parseValidationInstruction)
    .filter((entry): entry is ValidationInstruction => Boolean(entry));
  if (instructions.some((entry) => entry.kind === "manual")) {
    issue(
      issues,
      "task.validation.visual-manual",
      `${id} has visual acceptance criteria but uses manual: as if an inspection instruction were proof. `
        + "Use an executable browser/visual validation, or human: so execution pauses for external evidence.",
      line,
    );
  }

  const hasHumanGate = instructions.some((entry) => entry.kind === "human");
  const hasVisualCommand = instructions.some((entry) =>
    entry.kind === "command" && VISUAL_AUTOMATION_COMMAND.test(entry.value));
  if (!hasHumanGate && !hasVisualCommand) {
    issue(
      issues,
      "task.validation.visual-unproven",
      `${id} has visual acceptance criteria without an executable browser/visual command or a human: gate; `
        + "DOM presence, syntax checks, and generic unit tests do not prove rendered visibility.",
      line,
    );
  }

  const missingEvidence: string[] = [];
  if (!DURABLE_VISUAL_ARTIFACT.test(expectedEvidence)) missingEvidence.push("a durable screenshot artifact");
  if (!EXACT_VIEWPORT.test(expectedEvidence)) missingEvidence.push("an exact viewport such as 1440x900");
  if (!GEOMETRY_EVIDENCE.test(expectedEvidence)) missingEvidence.push("geometry/computed-style measurements");
  if (missingEvidence.length > 0) {
    issue(
      issues,
      "task.evidence.visual-contract",
      `${id} visual Expected evidence must name ${missingEvidence.join(", ")}; `
        + "the artifact must let a later manager distinguish visibility from selector presence.",
      line,
    );
  }

  if (!visualCriteria.some((criterion) => NEGATIVE_VISUAL_CONTROL.test(criterion))) {
    issue(
      issues,
      "task.acceptance.visual-negative-control",
      `${id} visual acceptance needs a negative control for corruption such as hidden/clipped/off-viewport elements, `
        + "overlap, exposed source text, or zero-area geometry.",
      line,
    );
  }

  if (visualCriteria.some((criterion) => VISUAL_INTERACTION.test(criterion))
    && !(BEFORE_EVIDENCE.test(expectedEvidence) && AFTER_EVIDENCE.test(expectedEvidence))) {
    issue(
      issues,
      "task.evidence.visual-state-pair",
      `${id} changes or observes visual state over an interaction, so Expected evidence must preserve before/initial `
        + "and after/resulting screenshots or measurements.",
      line,
    );
  }
}

function issue(
  issues: ValidationIssue[],
  code: string,
  message: string,
  line?: number,
): void {
  issues.push({ code, message, severity: "error", ...(line ? { line } : {}) });
}

function parseList(value: string): string[] {
  if (value.trim().toLowerCase() === "none") return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function taskScopeTokens(value: string): string[] {
  return [...value.matchAll(/`([^`]+)`/g)]
    .map((match) => match[1]?.trim())
    .filter((path): path is string => Boolean(path));
}

/**
 * Planning artifacts are immutable execution input.
 *
 * The manifest always uses the logical `.rb/` namespace, including when the
 * operator publishes it to a custom physical directory such as `.spec`.
 * Scope is write authority, so matching the logical namespace here keeps the
 * rule provider-, runner-, and output-directory-neutral.
 */
export function scopeTokenOwnsPlanningArtifacts(value: string): boolean {
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/");
  if (normalized === ".rb" || normalized.startsWith(".rb/")) return true;
  const firstSegment = normalized.split("/")[0] ?? "";
  if (!/[*?]/.test(firstSegment)) return false;
  const pattern = firstSegment
    .replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")
    .replaceAll("\\*", ".*")
    .replaceAll("\\?", ".");
  return new RegExp(`^${pattern}$`).test(".rb");
}

function changeReferencesPlanningArtifacts(value: string): boolean {
  // Scope is the primary write-authority boundary. Change adds a second guard
  // for an explicit mutation instruction, but must still allow a task to
  // describe the protection itself (for example, "reject `.rb/**`" or
  // "ensure tasks never own `.rb/**`"). Keep the mutation verb adjacent to
  // the protected path so explanatory references do not become false
  // positives.
  const mutation = "(?:update|edit|write(?:\s+to)?|create|delete|remove|replace|overwrite|patch|modify|regenerate|sync|publish|mutate|"
    + "atualizar|editar|escrever(?:\s+em)?|criar|excluir|remover|substituir|sobrescrever|corrigir|modificar|regenerar|sincronizar|publicar)";
  const optionalTarget = "(?:\\s+(?:the|a|an|o|a|os|as))?(?:\\s+(?:file|directory|artifact|manifest|arquivo|diret[oó]rio|artefato|manifesto))?";
  const planningPath = "\\s+[`'\"]?(?:\\./)?\\.rb(?:[\\\\/][^`'\"\\s,;]*)?[`'\"]?";
  return new RegExp(`\\b${mutation}${optionalTarget}${planningPath}`, "i").test(value);
}

function ambiguousTaskScope(value: string): string | undefined {
  const paths = taskScopeTokens(value);
  if (paths.length === 0) return "must declare at least one project-relative file, directory, or bounded glob in backticks";
  if (paths.some((path) => [".", "./", "/", "*", "**", "**/*"].includes(path!))) {
    return "must not use an unbounded project-wide path; split the task into concrete owned paths";
  }
  return undefined;
}

function findMarker(lines: string[], name: string): { values: string[]; lines: number[] } {
  const pattern = new RegExp(`^<!--\\s*${name}:\\s*([^>]+?)\\s*-->$`);
  const values: string[] = [];
  const markerLines: number[] = [];
  lines.forEach((line, index) => {
    const match = line.match(pattern);
    if (match?.[1]) {
      values.push(match[1].trim());
      markerLines.push(index + 1);
    }
  });
  return { values, lines: markerLines };
}

function phaseField(lines: string[], name: string): { value: string; line?: number } {
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index]?.match(PHASE_FIELD);
    if (match?.[1] === name) return { value: match[2]?.trim() ?? "", line: index + 1 };
  }
  return { value: "" };
}

function parseContext(lines: string[]): string[] {
  const start = lines.findIndex((line) => line === "**Context:**");
  if (start < 0) return [];
  const result: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (TASK_HEADING.test(line) || /^\*\*/.test(line)) break;
    const item = line.match(/^-\s+(.+)$/);
    if (item?.[1]) result.push(item[1].trim());
  }
  return result;
}

function parseTask(
  lines: string[],
  offset: number,
  match: RegExpMatchArray,
  issues: ValidationIssue[],
): Task {
  const values = new Map<string, string>();
  const lists = new Map<string, string[]>();

  for (let index = 1; index < lines.length; index += 1) {
    const field = lines[index]?.match(TASK_FIELD);
    if (!field?.[1]) continue;
    const name = field[1];
    const inline = field[2]?.trim() ?? "";
    if (name === "Acceptance criteria" || name === "Validation") {
      const entries: string[] = [];
      if (inline) entries.push(inline);
      for (let nested = index + 1; nested < lines.length; nested += 1) {
        const nestedLine = lines[nested] ?? "";
        if (TASK_FIELD.test(nestedLine)) break;
        const listItem = nestedLine.match(/^    -\s+(.+)$/);
        if (listItem?.[1]) entries.push(listItem[1].trim());
      }
      lists.set(name, entries);
    } else {
      values.set(name, inline);
    }
  }

  const id = match[2] ?? "";
  const required = ["Scope", "Change", "Covers", "Depends on", "Parallel safe", "Expected evidence"];
  for (const field of required) {
    if (!values.get(field)) issue(issues, "task.field.missing", `${id} is missing ${field}`, offset);
  }
  const acceptanceCriteria = lists.get("Acceptance criteria") ?? [];
  const validation = lists.get("Validation") ?? [];
  if (acceptanceCriteria.length === 0) {
    issue(issues, "task.acceptance.empty", `${id} has no acceptance criteria`, offset);
  }
  if (validation.length === 0) {
    issue(issues, "task.validation.empty", `${id} has no validation entries`, offset);
  }
  validation.forEach((entry) => {
    const instruction = parseValidationInstruction(entry);
    if (!instruction) {
      issue(
        issues,
        "task.validation.format",
        `${id} validation must be a backtick-delimited command, manual: <manager inspection>, or human: <external evidence>`,
        offset,
      );
      return;
    }
    const ambiguity = ambiguousValidationInstruction(instruction);
    if (ambiguity) {
      issue(issues, "task.validation.ambiguous", `${id} validation ${ambiguity}`, offset);
    }
  });
  acceptanceCriteria.forEach((criterion) => {
    const expected = new RegExp(`^AC-${id}-[0-9]{2}:\\s+.+`);
    if (!expected.test(criterion)) {
      issue(
        issues,
        "task.acceptance.id",
        `${id} acceptance criterion must match AC-${id}-NN: <criterion>`,
        offset,
      );
      return;
    }
    const ambiguity = ambiguousAcceptanceCriterion(criterion);
    if (ambiguity) {
      issue(
        issues,
        "task.acceptance.ambiguous",
        `${id} acceptance criterion ${ambiguity}`,
        offset,
      );
    }
  });
  validateVisualEvidenceContract(
    id,
    acceptanceCriteria,
    validation,
    values.get("Expected evidence") ?? "",
    issues,
    offset,
  );
  const parallel = values.get("Parallel safe")?.toLowerCase();
  if (parallel !== "true" && parallel !== "false") {
    issue(issues, "task.parallel.invalid", `${id} Parallel safe must be true or false`, offset);
  }
  const scopeAmbiguity = ambiguousTaskScope(values.get("Scope") ?? "");
  if (scopeAmbiguity) issue(issues, "task.scope.ambiguous", `${id} Scope ${scopeAmbiguity}`, offset);
  const protectedScopes = taskScopeTokens(values.get("Scope") ?? "").filter(scopeTokenOwnsPlanningArtifacts);
  if (protectedScopes.length) {
    issue(
      issues,
      "task.scope.control-plane",
      `${id} Scope must not own immutable planning artifacts: ${protectedScopes.join(", ")}. `
        + "Reference them through phase Context or a read-only Validation instead.",
      offset,
    );
  }
  if (changeReferencesPlanningArtifacts(values.get("Change") ?? "")) {
    issue(
      issues,
      "task.change.control-plane",
      `${id} Change must not direct edits to immutable .rb planning artifacts. `
        + "Move the artifact to phase Context and describe only the implementation change.",
      offset,
    );
  }

  return {
    id,
    title: match[3]?.trim() ?? "",
    done: match[1] === "x",
    scope: values.get("Scope") ?? "",
    change: values.get("Change") ?? "",
    covers: values.get("Covers") ?? "",
    dependsOn: parseList(values.get("Depends on") ?? ""),
    parallelSafe: parallel === "true",
    acceptanceCriteria,
    validation,
    expectedEvidence: values.get("Expected evidence") ?? "",
    line: offset,
  };
}

function parsePhase(
  lines: string[],
  offset: number,
  number: number,
  title: string,
  issues: ValidationIssue[],
): Phase {
  const idField = phaseField(lines, "Phase ID");
  const goalField = phaseField(lines, "Goal");
  const dependsField = phaseField(lines, "Depends on");
  const context = parseContext(lines);
  const expectedId = `P${String(number).padStart(2, "0")}`;

  if (!idField.value) issue(issues, "phase.id.missing", `Phase ${number} is missing Phase ID`, offset);
  if (idField.value && idField.value !== expectedId) {
    issue(issues, "phase.id.invalid", `Phase ${number} ID must be ${expectedId}`, offset + (idField.line ?? 1) - 1);
  }
  if (!goalField.value) issue(issues, "phase.goal.missing", `Phase ${number} is missing Goal`, offset);
  if (dependsField.line === undefined) {
    issue(issues, "phase.depends.missing", `Phase ${number} is missing Depends on`, offset);
  }
  if (context.length === 0) {
    issue(issues, "phase.context.empty", `Phase ${number} must list at least one context path`, offset);
  }

  const starts: Array<{ index: number; match: RegExpMatchArray }> = [];
  lines.forEach((line, index) => {
    const match = line.match(TASK_HEADING);
    if (match) starts.push({ index, match });
  });
  if (starts.length === 0) issue(issues, "phase.tasks.empty", `Phase ${number} has no tasks`, offset);

  const tasks = starts.map(({ index, match }, taskIndex) => {
    const end = starts[taskIndex + 1]?.index ?? lines.length;
    return parseTask(lines.slice(index, end), offset + index, match, issues);
  });

  return {
    number,
    id: idField.value,
    title,
    goal: goalField.value,
    dependsOn: parseList(dependsField.value),
    context,
    tasks,
    line: offset,
  };
}

export function validateExecutionMarkdown(source: string): ExecutionValidation {
  const normalized = source.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const issues: ValidationIssue[] = [];
  const firstIndex = lines.findIndex((line) => line.trim().length > 0);
  const titleMatch = firstIndex >= 0 ? lines[firstIndex]?.match(/^# RB Execution Plan:\s+(.+)$/) : undefined;
  if (!titleMatch?.[1]) {
    issue(issues, "document.title", "First non-empty line must be # RB Execution Plan: <name>", firstIndex + 1);
  }

  const contractMarker = findMarker(lines, "rb-execution-contract");
  if (contractMarker.values.length !== 1 || contractMarker.values[0] !== CONTRACT) {
    issue(issues, "document.contract", `Document must contain exactly one ${CONTRACT} marker`);
  }
  const artifactMarker = findMarker(lines, "rb-artifact-id");
  if (artifactMarker.values.length !== 1 || !/^[a-z0-9][a-z0-9-]*$/.test(artifactMarker.values[0] ?? "")) {
    issue(issues, "document.artifact-id", "Document must contain one valid rb-artifact-id marker");
  }

  const phaseStarts: Array<{ index: number; number: number; title: string }> = [];
  lines.forEach((line, index) => {
    if (!line.startsWith("## ")) return;
    const match = line.match(PHASE_HEADING);
    if (!match?.[1] || !match[2]) {
      issue(issues, "document.heading.h2", "Only ## Phase N: <title> level-2 headings are allowed", index + 1);
      return;
    }
    phaseStarts.push({ index, number: Number(match[1]), title: match[2].trim() });
  });
  if (phaseStarts.length === 0) issue(issues, "document.phases.empty", "Document must contain at least one phase");

  const phases = phaseStarts.map((start, index) => {
    const expected = index + 1;
    if (start.number !== expected) {
      issue(issues, "phase.sequence", `Expected Phase ${expected}, found Phase ${start.number}`, start.index + 1);
    }
    const end = phaseStarts[index + 1]?.index ?? lines.length;
    return parsePhase(lines.slice(start.index + 1, end), start.index + 2, start.number, start.title, issues);
  });

  const seenTasks = new Set<string>();
  let previousTask = 0;
  const knownPhases = new Set<string>();
  for (const phase of phases) {
    for (const dependency of phase.dependsOn) {
      if (!knownPhases.has(dependency)) {
        issue(issues, "phase.dependency.invalid", `${phase.id || `Phase ${phase.number}`} depends on unknown or later ${dependency}`, phase.line);
      }
    }
    knownPhases.add(phase.id);
    for (const task of phase.tasks) {
      const numeric = Number(task.id.slice(1));
      if (seenTasks.has(task.id)) issue(issues, "task.duplicate", `Duplicate task ID ${task.id}`, task.line);
      if (numeric <= previousTask) issue(issues, "task.sequence", `${task.id} is not in ascending order`, task.line);
      for (const dependency of task.dependsOn) {
        if (!seenTasks.has(dependency)) {
          issue(issues, "task.dependency.invalid", `${task.id} depends on unknown or later ${dependency}`, task.line);
        }
      }
      seenTasks.add(task.id);
      previousTask = numeric;
    }
  }

  const document: ExecutionDocument | undefined = titleMatch?.[1] && artifactMarker.values[0]
    ? {
        contract: CONTRACT,
        artifactId: artifactMarker.values[0],
        title: titleMatch[1].trim(),
        phases,
      }
    : undefined;

  if (document) issues.push(...validateGoPlanConvergence(document));

  return { valid: issues.length === 0, issues, ...(document ? { document } : {}) };
}

export function extractExecutionPhaseMarkdown(source: string, phaseId: string): string {
  const validation = validateExecutionMarkdown(source);
  if (!validation.valid || !validation.document) {
    const details = validation.issues.map((entry) => `${entry.code}: ${entry.message}`).join("; ");
    throw new Error(`Execution document is invalid: ${details}`);
  }

  const phase = validation.document.phases.find((entry) => entry.id === phaseId);
  if (!phase) throw new Error(`Unknown phase ${phaseId}`);

  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const phaseHeadings = lines
    .map((line, index) => ({ index, match: line.match(PHASE_HEADING) }))
    .filter((entry): entry is { index: number; match: RegExpMatchArray } => Boolean(entry.match));
  const selectedIndex = phaseHeadings.findIndex((entry) => Number(entry.match[1]) === phase.number);
  const selected = phaseHeadings[selectedIndex];
  if (!selected) throw new Error(`Could not locate phase heading for ${phaseId}`);

  const preambleEnd = phaseHeadings[0]?.index ?? 0;
  const phaseEnd = phaseHeadings[selectedIndex + 1]?.index ?? lines.length;
  const preamble = lines.slice(0, preambleEnd);
  const phaseLines = lines.slice(selected.index, phaseEnd);
  return `${[...preamble, ...phaseLines].join("\n").trimEnd()}\n`;
}

export function extractExecutionTaskMarkdown(source: string, taskId: string): string {
  const validation = validateExecutionMarkdown(source);
  if (!validation.valid || !validation.document) {
    const details = validation.issues.map((entry) => `${entry.code}: ${entry.message}`).join("; ");
    throw new Error(`Execution document is invalid: ${details}`);
  }

  const phase = validation.document.phases.find((entry) => entry.tasks.some((task) => task.id === taskId));
  if (!phase) throw new Error(`Unknown task ${taskId}`);

  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const phaseHeadings = lines
    .map((line, index) => ({ index, match: line.match(PHASE_HEADING) }))
    .filter((entry): entry is { index: number; match: RegExpMatchArray } => Boolean(entry.match));
  const phaseIndex = phaseHeadings.findIndex((entry) => Number(entry.match[1]) === phase.number);
  const phaseHeading = phaseHeadings[phaseIndex];
  if (!phaseHeading) throw new Error(`Could not locate phase heading for ${phase.id}`);
  const phaseEnd = phaseHeadings[phaseIndex + 1]?.index ?? lines.length;
  const taskHeadings = lines
    .slice(phaseHeading.index, phaseEnd)
    .map((line, index) => ({ index: phaseHeading.index + index, match: line.match(TASK_HEADING) }))
    .filter((entry): entry is { index: number; match: RegExpMatchArray } => Boolean(entry.match));
  const taskIndex = taskHeadings.findIndex((entry) => entry.match[2] === taskId);
  const taskHeading = taskHeadings[taskIndex];
  if (!taskHeading) throw new Error(`Could not locate task heading for ${taskId}`);

  const preambleEnd = phaseHeadings[0]?.index ?? 0;
  const taskEnd = taskHeadings[taskIndex + 1]?.index ?? phaseEnd;
  const preamble = lines.slice(0, preambleEnd);
  const phaseContext = lines.slice(phaseHeading.index, taskHeadings[0]?.index ?? phaseEnd);
  const taskLines = lines.slice(taskHeading.index, taskEnd);
  return `${[...preamble, ...phaseContext, ...taskLines].join("\n").trimEnd()}\n`;
}
