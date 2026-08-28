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
  + "modificar|alterar|editar|escrever(?:\\s+em)?|criar|excluir|remover|substituir|sobrescrever|corrigir|regenerar|sincronizar|publicar)";

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

/** Conservative extraction: only explicit prohibitions/preservation plus a quoted path. */
export function protectedPathConstraintsFromText(text: string, source: string): ProtectedPathConstraint[] {
  const found: ProtectedPathConstraint[] = [];
  const patterns = [
    new RegExp("(?:must\\s+not|do\\s+not|never|mustn't|n[aã]o\\s+deve|n[aã]o|jamais)\\s+" + MUTATION
      + "[^\\n]{0,60}?[`'\"]([^`'\"\\n]+)[`'\"]", "gi"),
    /(?:must\s+preserve|preserve|preservar|deve\s+preservar)[^\n]{0,60}?[`'"]([^`'"\n]+)[`'"]/gi,
  ];
  let index = 0;
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const item = match[1] ? constraint(`${source}-${String(++index).padStart(3, "0")}`, match[1], source) : undefined;
      if (item) found.push(item);
    }
  }
  return found;
}

/** Canonical machine marker plus conservative stable PRESERVE row/heading support. */
export function protectedPathConstraintsFromArtifact(path: string, content: string): ProtectedPathConstraint[] {
  const found: ProtectedPathConstraint[] = [];
  for (const match of content.matchAll(/<!--\s*rb-authority:\s*protected-path\s*;\s*id=([A-Z][A-Z0-9-]+)\s*;\s*path=([^;>]+)\s*-->/g)) {
    const item = constraint(match[1]!, match[2]!, path);
    if (item) found.push(item);
  }
  if (path.toUpperCase().endsWith("/PRESERVATION.MD")) {
    for (const line of content.split("\n")) {
      const id = line.match(/\b(PRESERVE-\d+)\b/i)?.[1]?.toUpperCase();
      if (!id || !/\bPRESERVE\b/i.test(line)) continue;
      for (const quoted of line.matchAll(/`([^`]+)`/g)) {
        const item = constraint(id, quoted[1]!, path);
        if (item) found.push(item);
      }
    }
  }
  return found;
}

export function authorityConstraintsFromState(state: HarnessRunState): ProtectedPathConstraint[] {
  const constraints = protectedPathConstraintsFromText(state.request, "request");
  for (const answer of state.answers.filter((entry) => entry.disposition === "ACCEPTED")) {
    const text = answer.normalizedDecision ?? answer.rawAnswer;
    constraints.push(...protectedPathConstraintsFromText(text, `decision-${answer.questionId}`));
  }
  return deduplicateProtectedPaths(constraints);
}

const STABLE_AUTHORITY_ID = "(?:RF|RNF|UI|CT|CHANGE|PRESERVE)-\\d+";

function traceability(id: string, source: string): TraceabilityConstraint {
  return { kind: "traceability", id: id.toUpperCase(), source };
}

/** Stable IDs explicitly present in the request or an accepted decision. */
export function traceabilityConstraintsFromState(state: HarnessRunState): TraceabilityConstraint[] {
  const constraints = [...state.request.matchAll(new RegExp(`\\b(${STABLE_AUTHORITY_ID})\\b`, "gi"))]
    .map((match) => traceability(match[1]!, "request"));
  for (const answer of state.answers.filter((entry) => entry.disposition === "ACCEPTED")) {
    const text = answer.normalizedDecision ?? answer.rawAnswer;
    constraints.push(...[...text.matchAll(new RegExp(`\\b(${STABLE_AUTHORITY_ID})\\b`, "gi"))]
      .map((match) => traceability(match[1]!, `decision-${answer.questionId}`)));
  }
  return deduplicateTraceability(constraints);
}

/** Headings, list records, and first table cells are deterministic obligation declarations. */
export function traceabilityConstraintsFromArtifact(path: string, content: string): TraceabilityConstraint[] {
  const constraints = [...content.matchAll(new RegExp(
    `^(?:#{1,6}\\s+|[-*]\\s+(?:\\*\\*)?|\\s*\\|\\s*)(${STABLE_AUTHORITY_ID})\\b`,
    "gim",
  ))].map((match) => traceability(match[1]!, path));
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
    const key = `${entry.id}\0${entry.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function scopeTokenIntersectsProtectedPath(token: string, protectedPath: string): boolean {
  const normalized = canonicalProtectedPath(token);
  if (!normalized) return false;
  if (scopeTokenCoversPath(normalized, protectedPath) || scopeTokenCoversPath(protectedPath, normalized)) return true;
  if (/[*?]/.test(normalized)) {
    return [
      `${protectedPath}/__rb_protected__`,
      `__rb_parent__/${protectedPath}/__rb_protected__`,
    ].some((sample) => scopeTokenCoversPath(normalized, sample));
  }
  return false;
}

export function changeExplicitlyModifiesProtectedPath(change: string, protectedPath: string): boolean {
  const quoted = [...change.matchAll(/[`'"]([^`'"]+)[`'"]/g)]
    .filter((match) => match[1] && scopeTokenIntersectsProtectedPath(match[1], protectedPath));
  if (!quoted.length) return false;
  for (const match of quoted) {
    const before = change.slice(Math.max(0, match.index! - 120), match.index);
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
