export const PROGRESSIVE_INIT_STAGES = [
  "project-description",
  "user-stories",
  "database-schema",
  "project-phases",
] as const;

export type ProgressiveInitStage = typeof PROGRESSIVE_INIT_STAGES[number];

export interface ProgressiveInitStageDefinition {
  readonly kind: ProgressiveInitStage;
  readonly label: string;
  readonly purpose: string;
}

export const PROGRESSIVE_INIT_STAGE_DEFINITIONS: readonly ProgressiveInitStageDefinition[] = [
  {
    kind: "project-description",
    label: "Project Description",
    purpose: "Understand the project, actors, MVP scope, workflows, constraints, and confirmed decisions.",
  },
  {
    kind: "user-stories",
    label: "User Stories",
    purpose: "Convert approved workflows into verifiable user stories.",
  },
  {
    kind: "database-schema",
    label: "Database Schema",
    purpose: "Describe persistence semantics when the project requires them.",
  },
  {
    kind: "project-phases",
    label: "Project Phases",
    purpose: "Compile approved specification semantics into executable project phases.",
  },
] as const;

const STAGE_SET = new Set<string>(PROGRESSIVE_INIT_STAGES);

export function isProgressiveInitStage(value: unknown): value is ProgressiveInitStage {
  return typeof value === "string" && STAGE_SET.has(value);
}

export function parseProgressiveInitStage(value: string): ProgressiveInitStage {
  if (!isProgressiveInitStage(value)) {
    throw new Error(`invalid Progressive Init stage '${value}'; expected one of: ${PROGRESSIVE_INIT_STAGES.join(", ")}`);
  }
  return value;
}

export function progressiveInitStageIndex(stage: ProgressiveInitStage): number {
  return PROGRESSIVE_INIT_STAGES.indexOf(stage);
}

export function progressiveInitStageDefinition(stage: ProgressiveInitStage): ProgressiveInitStageDefinition {
  return PROGRESSIVE_INIT_STAGE_DEFINITIONS[progressiveInitStageIndex(stage)]!;
}

export function progressiveInitPrerequisites(stage: ProgressiveInitStage): readonly ProgressiveInitStage[] {
  return PROGRESSIVE_INIT_STAGES.slice(0, progressiveInitStageIndex(stage));
}
