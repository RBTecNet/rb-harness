declare const identityBrand: unique symbol;

type Brand<T, Name extends string> = T & { readonly [identityBrand]: Name };

export type ProjectId = Brand<string, "ProjectId">;
export type RequirementId = Brand<string, "RequirementId">;
export type PhaseId = Brand<string, "PhaseId">;
export type TaskId = Brand<string, "TaskId">;
export type AcceptanceId = Brand<string, "AcceptanceId">;
export type ArtifactId = Brand<string, "ArtifactId">;
export type Sha256 = Brand<string, "Sha256">;
export type RelPath = Brand<string, "RelPath">;
export type SemanticKey = Brand<string, "SemanticKey">;

export function projectId(name: string): ProjectId {
  const normalized = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return (normalized || "project") as ProjectId;
}

function positiveOrdinal(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function requirementId(ordinal: number): RequirementId {
  return `R-${String(positiveOrdinal(ordinal, "requirement ordinal")).padStart(3, "0")}` as RequirementId;
}

export function phaseId(ordinal: number): PhaseId {
  return `P${String(positiveOrdinal(ordinal, "phase ordinal")).padStart(2, "0")}` as PhaseId;
}

export function taskId(ordinal: number): TaskId {
  return `T${String(positiveOrdinal(ordinal, "task ordinal")).padStart(3, "0")}` as TaskId;
}

export function acceptanceId(task: TaskId, ordinal: number): AcceptanceId {
  return `AC-${task}-${String(positiveOrdinal(ordinal, "acceptance ordinal")).padStart(2, "0")}` as AcceptanceId;
}

export function executionArtifactId(project: ProjectId): ArtifactId {
  return `${project}-execution` as ArtifactId;
}

export function briefArtifactId(project: ProjectId): ArtifactId {
  return `${project}-brief` as ArtifactId;
}

export function semanticKey(value: string): SemanticKey | undefined {
  return /^[a-z][a-z0-9-]{1,47}$/.test(value) ? value as SemanticKey : undefined;
}

