export const TASK_REQUIRED_TEXT_MIN_LENGTH = 1 as const;
export const TASK_REQUIRED_COLLECTION_MIN_ITEMS = 1 as const;
export const TASK_ACCEPTANCE_MAX_ITEMS = 6 as const;

export const TASK_REQUIRED_SEMANTIC_FIELDS = [
  "intent",
  "ownedPaths",
  "covers",
  "acceptance",
  "validation",
  "expectedEvidence",
] as const;

export type TaskRequiredSemanticField = typeof TASK_REQUIRED_SEMANTIC_FIELDS[number];

export interface TaskStructuralRule {
  readonly field: TaskRequiredSemanticField;
  readonly message: string;
  readonly guidance: string;
}

export const TASK_STRUCTURAL_RULES: Readonly<Record<TaskRequiredSemanticField, TaskStructuralRule>> = {
  intent: {
    field: "intent",
    message: "Task change intent must be non-empty, single-line, and concrete.",
    guidance: "Provide one concrete semantic change intent describing what this task changes.",
  },
  ownedPaths: {
    field: "ownedPaths",
    message: "Task must own at least one safe project-relative path.",
    guidance: "Declare one or more safe project-relative paths owned by this semantic task.",
  },
  covers: {
    field: "covers",
    message: "Task must cover at least one declared requirement key.",
    guidance: "Reference one or more declared semantic requirement keys covered by this task.",
  },
  acceptance: {
    field: "acceptance",
    message: "Task must contain at least one self-contained acceptance statement.",
    guidance: "Provide one or more independently observable, self-contained acceptance statements.",
  },
  validation: {
    field: "validation",
    message: "Task must contain at least one supported validation intent.",
    guidance: "Provide one or more supported command, manual, or human validation intents.",
  },
  expectedEvidence: {
    field: "expectedEvidence",
    message: "Task must contain concrete expected evidence.",
    guidance: "Describe the concrete observable evidence that demonstrates completion of this task.",
  },
};

export function taskStructuralRule(field: TaskRequiredSemanticField): TaskStructuralRule {
  return TASK_STRUCTURAL_RULES[field];
}
