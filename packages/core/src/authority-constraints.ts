import { scopeTokenCoversPath } from "./path-ownership.js";
import type { ArtifactRecord, ExecutionDocument, ValidationIssue } from "./types.js";
import type { HarnessRunState } from "./standalone-types.js";

export interface ProtectedPathConstraint {
  kind: "protected-path";
  id: string;
  path: string;
  source: string;
}

export interface TraceabilityConstraint {
  kind: "traceability";
  id: string;
  source: string;
}

export const BUILT_IN_PROTECTED_PATH_CONSTRAINTS: readonly ProtectedPathConstraint[] = [{
  kind: "protected-path",
  id: "RB-CONTROL-PLANE",
  path: ".rb",
  source: "harness-contract",
}];

const MUTATION = "(?:modify|change|edit|write(?:\\s+to)?|create|delete|remove|replace|overwrite|patch|regenerate|sync|publish|mutate|"
  + "modificar|modifique|alterar|altere|editar|edite|mexer(?:\\s+em)?|mexa(?:\\s+em)?|tocar(?:\\s+em)?|toque(?:\\s+em)?|"
  + "escrever(?:\\s+em)?|escreva(?:\\s+em)?|criar|crie|excluir|exclua|remover|remova|substituir|substitua|sobrescrever|"
  + "sobrescreva|corrigir|corrija|regenerar|regenere|sincronizar|sincronize|publicar|publique)";

export function canonicalProtectedPath(value: string): string | undefined {
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/").replace(/\/$/, "");
  if (!normalized || normalized.includes("\0") || normalized.includes("${") || /\s/.test(normalized)) return undefined;
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.split("/").includes("..")) return undefined;
  if (normalized.includes("://") || normalized.startsWith("-")) return undefined;
  return normalized;
}

function constraint(id: string, path: string, source: string): ProtectedPathConstraint | undefined {
  const canonical = canonicalProtectedPath(path);
  return canonical ? { kind: "protected-path", id, path: canonical, source } : undefined;
}

function pathLike(value: string): boolean {
  return value.includes("/") || value.startsWith(".") || /\.[A-Za-z0-9*?_-]+$/.test(value);
}

function directivePath(value: string): string | undefined {
  const tail = value.trim().replace(/^(?:the\s+(?:file|path)|file|path|o\s+arquivo|a\s+pasta|arquivo|caminho)\s+/i, "");
  const quoted = tail.match(/^[`'"]([^`'"]+)[`'"]/);
  const unquoted = tail.match(/^([A-Za-z0-9._*?-]+(?:\/[A-Za-z0-9._*?-]+)*)/);
  const raw = (quoted?.[1] ?? unquoted?.[1])?.replace(/[.,;:!?)]$/, "");
  return raw && pathLike(raw) ? raw : undefined;
}

function explicitPathLiterals(text: string): Array<{ path: string; index: number }> {
  const found: Array<{ path: string; index: number }> = [];
  for (const match of text.matchAll(/[`'"]([^`'"]+)[`'"]/g)) {
    if (match[1] && pathLike(match[1])) found.push({ path: match[1], index: match.index! });
  }
  for (const match of text.matchAll(/(?:^|\s)([A-Za-z0-9._*?-]+(?:\/[A-Za-z0-9._*?-]+)*)(?=$|[\s,;:!?)])/g)) {
    const raw = match[1]?.replace(/[.,;:!?)]$/, "");
    if (raw && pathLike(raw)) found.push({ path: raw, index: match.index! + match[0].indexOf(match[1]!) });
  }
  return found;
}

/** Conservative extraction: explicit line-local prohibition/preservation plus a safe path literal. */
export function protectedPathConstraintsFromText(text: string, source: string): ProtectedPathConstraint[] {
  const found: ProtectedPathConstraint[] = [];
  let index = 0;
  const directive = new RegExp(
    "(?:must\\s+not|do\\s+not|don['’]t|never|mustn['’]t|(?:n[aã]o|nao|jamais)(?:\\s+deve)?)\\s+" + MUTATION
      + "\\s+|(?:must\\s+preserve|preserve|deve\\s+preservar|preservar)\\s+",
    "gi",
  );
  for (const line of text.split(/\r?\n/)) {
    for (const match of line.matchAll(directive)) {
      const path = directivePath(line.slice(match.index! + match[0].length));
      const item = path ? constraint(`${source}-${String(++index).padStart(3, "0")}`, path, source) : undefined;
      if (item) found.push(item);
    }
  }
  return found;
}

function tableCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function normalizedHeader(value: string): string {
  return value.replace(/[*_`]/g, "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .trim().toLowerCase().replace(/\s+/g, " ");
}

interface MarkdownTable { headers: string[]; rows: string[][] }

function markdownTables(content: string): MarkdownTable[] {
  const lines = content.split(/\r?\n/);
  const tables: MarkdownTable[] = [];
  for (let index = 0; index + 1 < lines.length; index += 1) {
    if (!lines[index]!.includes("|") || !lines[index + 1]!.includes("|")) continue;
    const headers = tableCells(lines[index]!);
    const separator = tableCells(lines[index + 1]!);
    if (headers.length !== separator.length || !separator.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
    const rows: string[][] = [];
    index += 2;
    while (index < lines.length && lines[index]!.includes("|")) {
      const cells = tableCells(lines[index]!);
      if (cells.length !== headers.length) break;
      rows.push(cells);
      index += 1;
    }
    index -= 1;
    tables.push({ headers: headers.map(normalizedHeader), rows });
  }
  return tables;
}

const ID_HEADERS = new Set(["id", "obligation id", "change id", "preserve id", "requirement id", "identificador", "id da obrigacao"]);
const PROTECTED_PATH_HEADERS = new Set(["protected path", "preserved path", "caminho protegido", "caminho preservado"]);

function tableColumn(headers: readonly string[], names: ReadonlySet<string>): number {
  return headers.findIndex((header) => names.has(header));
}

function singlePathCell(cell: string): string | undefined {
  const quoted = [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1]!);
  if (quoted.length > 1) return undefined;
  return quoted[0] ?? cell.trim();
}

/** Canonical machine marker plus conservative stable PRESERVE row/heading support. */
export function protectedPathConstraintsFromArtifact(path: string, content: string): ProtectedPathConstraint[] {
  const found: ProtectedPathConstraint[] = [];
  for (const match of content.matchAll(/<!--\s*rb-authority:\s*protected-path\s*;\s*id=([A-Z][A-Z0-9-]+)\s*;\s*path=([^;>]+)\s*-->/g)) {
    const item = constraint(match[1]!, match[2]!, path);
    if (item) found.push(item);
  }
  if (path.toUpperCase().endsWith("/PRESERVATION.MD")) {
    for (const table of markdownTables(content)) {
      const idColumn = tableColumn(table.headers, ID_HEADERS);
      const pathColumn = tableColumn(table.headers, PROTECTED_PATH_HEADERS);
      if (idColumn < 0 || pathColumn < 0) continue;
      for (const row of table.rows) {
        const id = row[idColumn]?.match(/\b(PRESERVE-\d+)\b/i)?.[1]?.toUpperCase();
        const preservedPath = row[pathColumn] ? singlePathCell(row[pathColumn]!) : undefined;
        const item = id && preservedPath ? constraint(id, preservedPath, path) : undefined;
        if (item) found.push(item);
      }
    }
  }
  return found;
}

export function authorityConstraintsFromState(state: HarnessRunState): ProtectedPathConstraint[] {
  const constraints = protectedPathConstraintsFromText(state.request, "request");
  for (const answer of state.answers.filter((entry) => entry.disposition === "ACCEPTED")) {
    constraints.push(...protectedPathConstraintsFromText(answer.rawAnswer, `decision-${answer.questionId}`));
    if (answer.normalizedDecision) {
      constraints.push(...protectedPathConstraintsFromText(answer.normalizedDecision, `decision-${answer.questionId}`));
    }
  }
  return deduplicateProtectedPaths(constraints);
}

const STABLE_AUTHORITY_ID = "(?:CHANGE|PRESERVE)-\\d+";

function traceability(id: string, source: string): TraceabilityConstraint {
  return { kind: "traceability", id: id.toUpperCase(), source };
}

function declaredStateTraceability(text: string, source: string): TraceabilityConstraint[] {
  const pattern = new RegExp(
    `^(?:\\*\\*)?(${STABLE_AUTHORITY_ID})(?:\\*\\*)?\\s*(?::|[—–]|-\\s|\\|)`,
    "gim",
  );
  return [...text.matchAll(pattern)].map((match) => traceability(match[1]!, source));
}

/** Explicit CHANGE/PRESERVE declarations in the request or an accepted decision. */
export function traceabilityConstraintsFromState(state: HarnessRunState): TraceabilityConstraint[] {
  const constraints = declaredStateTraceability(state.request, "request");
  for (const answer of state.answers.filter((entry) => entry.disposition === "ACCEPTED")) {
    constraints.push(...declaredStateTraceability(answer.rawAnswer, `decision-${answer.questionId}`));
    if (answer.normalizedDecision) {
      constraints.push(...declaredStateTraceability(answer.normalizedDecision, `decision-${answer.questionId}`));
    }
  }
  return deduplicateTraceability(constraints);
}

/** Evolve headings, lists, and table ID columns are deterministic obligation declarations. */
export function traceabilityConstraintsFromArtifact(path: string, content: string): TraceabilityConstraint[] {
  const name = path.slice(path.lastIndexOf("/") + 1).toUpperCase();
  const prefix = name === "TO_BE.MD" ? "CHANGE" : name === "PRESERVATION.MD" ? "PRESERVE" : undefined;
  if (!prefix) return [];
  const constraints = [...content.matchAll(new RegExp(
    `^(?:#{1,6}\\s+|[-*]\\s+)(?:\\*\\*)?(${prefix}-\\d+)(?:\\*\\*)?\\b`,
    "gim",
  ))].map((match) => traceability(match[1]!, path));
  for (const table of markdownTables(content)) {
    const idColumn = tableColumn(table.headers, ID_HEADERS);
    if (idColumn < 0) continue;
    for (const row of table.rows) {
      const id = row[idColumn]?.match(new RegExp(`\\b(${prefix}-\\d+)\\b`, "i"))?.[1];
      if (id) constraints.push(traceability(id, path));
    }
  }
  return deduplicateTraceability(constraints);
}

export function deduplicateTraceability(constraints: readonly TraceabilityConstraint[]): TraceabilityConstraint[] {
  const seen = new Set<string>();
  return constraints.filter((entry) => {
    if (seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  });
}

export function deduplicateProtectedPaths(constraints: readonly ProtectedPathConstraint[]): ProtectedPathConstraint[] {
  const seen = new Set<string>();
  return constraints.filter((entry) => {
    const key = entry.path;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function scopeTokenIntersectsProtectedPath(token: string, protectedPath: string): boolean {
  const normalized = canonicalProtectedPath(token);
  const protectedCanonical = canonicalProtectedPath(protectedPath);
  if (!normalized || !protectedCanonical) return false;
  if (scopeTokenCoversPath(normalized, protectedPath) || scopeTokenCoversPath(protectedPath, normalized)) return true;
  if (!/[*?]/.test(normalized)) return false;
  if (/[*?]/.test(protectedCanonical)) {
    const tokenRoot = normalized.split("/").find((segment) => !/[*?]/.test(segment));
    const protectedRoot = protectedCanonical.split("/").find((segment) => !/[*?]/.test(segment));
    return !tokenRoot || !protectedRoot || tokenRoot === protectedRoot;
  }
  const pattern = normalized.split("/");
  const target = protectedCanonical.split("/");
  const memo = new Map<string, boolean>();
  const intersects = (patternIndex: number, targetIndex: number): boolean => {
    const key = `${patternIndex}:${targetIndex}`;
    const known = memo.get(key);
    if (known !== undefined) return known;
    if (targetIndex === target.length) return true;
    if (patternIndex === pattern.length) return false;
    const segment = pattern[patternIndex]!;
    let result: boolean;
    if (segment === "**") {
      result = intersects(patternIndex + 1, targetIndex) || intersects(patternIndex, targetIndex + 1);
    } else {
      const expression = new RegExp(`^${segment.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&").replaceAll("\\*", "[^/]*").replaceAll("\\?", "[^/]")}$`);
      result = expression.test(target[targetIndex]!) && intersects(patternIndex + 1, targetIndex + 1);
    }
    memo.set(key, result);
    return result;
  };
  return intersects(0, 0);
}

export function changeExplicitlyModifiesProtectedPath(change: string, protectedPath: string): boolean {
  const paths = explicitPathLiterals(change).filter((entry) => scopeTokenIntersectsProtectedPath(entry.path, protectedPath));
  if (!paths.length) return false;
  for (const match of paths) {
    const before = change.slice(Math.max(0, match.index - 120), match.index);
    const mutation = before.match(new RegExp(`\\b${MUTATION}\\b`, "i"));
    if (!mutation) continue;
    const tail = before.slice(Math.max(0, mutation.index! - 30));
    if (new RegExp(`(?:not|never|without|n[aã]o|sem)\\s+(?:\\w+\\s+){0,2}${MUTATION}`, "i").test(tail)) continue;
    return true;
  }
  return false;
}

export function artifactAuthoritySources(artifacts: readonly ArtifactRecord[]): ArtifactRecord[] {
  const names = new Set(["REQUEST.MD", "SPEC.MD", "CHANGE_REQUEST.MD", "TO_BE.MD", "PRESERVATION.MD"]);
  return artifacts.filter((artifact) => names.has(artifact.path.slice(artifact.path.lastIndexOf("/") + 1).toUpperCase()));
}

function taskScopeTokens(value: string): string[] {
  return [...value.matchAll(/`([^`]+)`/g)].map((match) => match[1]!.trim()).filter(Boolean);
}

export function validateAuthorityConstraints(
  document: ExecutionDocument,
  constraints: readonly ProtectedPathConstraint[],
  path: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const phase of document.phases) {
    for (const task of phase.tasks) {
      for (const protectedPath of constraints) {
        const owned = taskScopeTokens(task.scope).filter((token) =>
          scopeTokenIntersectsProtectedPath(token, protectedPath.path));
        if (owned.length) {
          issues.push({
            code: "authority.protected-path.scope",
            message: `${task.id} Scope owns protected path ${protectedPath.path} through ${owned.join(", ")} `
              + `(${protectedPath.id} from ${protectedPath.source}).`,
            severity: "error",
            line: task.line,
            path,
          });
        }
        if (changeExplicitlyModifiesProtectedPath(task.change, protectedPath.path)) {
          issues.push({
            code: "authority.protected-path.change",
            message: `${task.id} Change explicitly directs modification of protected path ${protectedPath.path} `
              + `(${protectedPath.id} from ${protectedPath.source}).`,
            severity: "error",
            line: task.line,
            path,
          });
        }
      }
    }
  }
  return issues;
}

export function validateTraceabilityConstraints(
  document: ExecutionDocument,
  constraints: readonly TraceabilityConstraint[],
  path: string,
): ValidationIssue[] {
  const covered = new Set(document.phases.flatMap((phase) => phase.tasks)
    .flatMap((task) => task.covers.match(new RegExp(`\\b${STABLE_AUTHORITY_ID}\\b`, "gi")) ?? [])
    .map((id) => id.toUpperCase()));
  const uncovered = deduplicateTraceability(constraints).filter((entry) => !covered.has(entry.id));
  if (!uncovered.length) return [];
  return [{
    code: "authority.traceability.coverage",
    message: `Authoritative obligations have no task coverage: ${uncovered.map((entry) => `${entry.id} (${entry.source})`).join(", ")}.`,
    severity: "error",
    path,
  }];
}
