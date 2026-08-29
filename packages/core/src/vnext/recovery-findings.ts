import type { WireFinding } from "./wire.js";
import { TASK_REQUIRED_SEMANTIC_FIELDS, taskStructuralRule } from "./task-contract.js";

export interface ModelFacingSemanticFinding {
  readonly code: WireFinding["code"];
  readonly pointer: string;
  readonly message: string;
  readonly rule?: RecoveryRule;
}

export type RecoveryRule =
  | "acceptance-no-visual-only"
  | "acceptance-self-contained"
  | "requirement-coverage"
  | "validation-command-executable"
  | "validation-command-terminating"
  | "task-completeness"
  | "rigid-decision-requires-authority"
  | "semantic-key-valid"
  | "dependency-order-valid";

export interface ModelFacingRecoveryRule {
  readonly rule: RecoveryRule;
  readonly constraint: string;
}

export interface ModelFacingRecoveryContext {
  readonly violatedRules: readonly ModelFacingRecoveryRule[];
  readonly specificPreviousFindings: readonly ModelFacingSemanticFinding[];
}

const RECOVERY_RULE_CONSTRAINTS: Readonly<Record<RecoveryRule, string>> = {
  "acceptance-no-visual-only": "Every acceptance statement in the complete regenerated slice, including every UI task, must prove observable functional behavior rather than appearance. Express a concrete precondition or action and its deterministic outcome through application or DOM state, navigation, form submission, data derived from known state, filtering or sorting, authorization-dependent action state, an API effect observable through UI behavior, or an exact count, value, or message. Styling, layout quality, looks-correct language, visibility or positioning, aesthetic judgement, screenshots, pixels, appearance, visual fidelity, and visual comparison are unsupported acceptance boundaries. When genuine visual judgement is required, keep functional acceptance separate and use a human validation intent for that judgement.",
  "acceptance-self-contained": "Every acceptance statement in the complete regenerated slice must independently state an observable success boundary without vague language or reference-only shorthand.",
  "requirement-coverage": "Across the complete regenerated work slice, every declared requirement must be covered by at least one task and every coverage reference must use a declared semantic requirement key.",
  "validation-command-executable": "Across the complete regenerated slice, executable checks must use command with an exact declared quality-command key; manual is only for a non-command inspection the executor can perform, and human is only for evidence requiring human judgement.",
  "validation-command-terminating": "Every quality command in the complete regenerated slice must terminate and return its real exit status; long-running servers and watchers are not validation commands.",
  "task-completeness": "Every task in the complete regenerated work slice must have concrete change intent, owned project-relative paths, declared requirement coverage, self-contained acceptance, supported validation, and concrete expected evidence.",
  "rigid-decision-requires-authority": "Every RIGID product or architecture decision in the complete regenerated intent slice must be represented as a material question with a concrete recommendation unless it is verifiably grounded in the original request.",
  "semantic-key-valid": "Every semantic key and reference in the complete regenerated slice must use the lower-case symbolic key grammar and remain consistent with its declaration.",
  "dependency-order-valid": "Every dependency in the complete regenerated slice must reference declared symbolic work that appears earlier in executable order.",
};

// These are code-owned representations, never semantic vocabulary for a model.
const MACHINE_IDENTITY = /(?:\bAC-T\d{3}-\d{2}\b|\bR-\d{3}\b|\bT\d{3}\b|\bP\d{2}\b|\brb-artifact-id\b)/i;

function safePointer(pointer: string): string {
  return MACHINE_IDENTITY.test(pointer) ? "/" : pointer;
}

function recoveryRule(finding: WireFinding): RecoveryRule | undefined {
  const message = finding.message;
  const pointer = finding.pointer;
  const taskField = TASK_REQUIRED_SEMANTIC_FIELDS.find((field) => pointer.endsWith(`/${field}`));
  if (taskField && message === taskStructuralRule(taskField).message) return "task-completeness";
  if (message.includes("long-running service or watcher")) return "validation-command-terminating";
  if (message.includes("visual acceptance semantics") || /\/acceptance(?:\/|$)/.test(pointer) && message.includes("visual")) return "acceptance-no-visual-only";
  if (message.includes("acceptance is not self-contained")) return "acceptance-self-contained";
  if (message.includes("Manual validation") || /\/validation(?:\/|$)/.test(pointer) && message.includes("manual")) return "validation-command-executable";
  if (message.includes("unknown requirement identity") || message.includes("not covered by any task")) return "requirement-coverage";
  if (message.includes("RIGID product/architecture decisions require a question")) return "rigid-decision-requires-authority";
  if (message.includes("unknown or forward phase") || message.includes("unknown or forward task")) return "dependency-order-valid";
  if (message.toLowerCase().includes("semantic key") || /\/(?:key|dependsOn)(?:\/|$)/.test(pointer)) return "semantic-key-valid";
  return undefined;
}

function semanticGuidance(finding: WireFinding): string {
  const message = finding.message;
  const pointer = finding.pointer;

  const taskField = TASK_REQUIRED_SEMANTIC_FIELDS.find((field) => pointer.endsWith(`/${field}`));
  if (taskField && message === taskStructuralRule(taskField).message) {
    return taskStructuralRule(taskField).guidance;
  }

  if (message.includes("long-running service or watcher")) {
    return "Validation commands must terminate and return their real exit status. Do not use a long-running server or watcher as validation. Express non-command evidence using the supported manual or human validation intent.";
  }
  if (message.includes("visual acceptance semantics") || /\/acceptance(?:\/|$)/.test(pointer) && message.includes("visual")) {
    return "This prior acceptance statement uses visual-only semantics. In the complete regenerated slice, replace it with a concrete precondition or action and deterministic functional outcome such as an application or DOM state change, navigation result, form-submission result, data/count/value/message derived from known state, filter or sort result, authorization-dependent action state, or API effect observable through UI behavior. Do not use styling, layout, looks-correct language, visibility, positioning, aesthetics, screenshots, pixels, or visual comparison as the success boundary; keep genuine visual judgement separate as a human validation intent.";
  }
  if (message.includes("acceptance is not self-contained")) {
    return "This acceptance statement is vague and does not define an independently observable success boundary.";
  }
  if (message.includes("Manual validation") || /\/validation(?:\/|$)/.test(pointer) && message.includes("manual")) {
    return "Use command with an exact declared quality-command key for an executable check, manual for a non-command inspection the executor can perform, or human for evidence that requires human judgement.";
  }
  if (message.toLowerCase().includes("semantic key") || /\/(?:key|dependsOn)(?:\/|$)/.test(pointer)) {
    return "Use a valid stable symbolic semantic key in lower-case kebab-case and keep every reference consistent with its declaration.";
  }
  if (message.includes("unknown requirement identity") || message.includes("not covered by any task")) {
    return "Requirement coverage must reference declared semantic requirement keys, and every declared requirement must be covered by at least one task.";
  }
  if (message.includes("unknown or forward phase") || message.includes("unknown or forward task")) {
    return "Dependencies must use declared symbolic semantic keys and may reference only earlier executable work.";
  }
  if (message.includes("has no executable owned-path scope")) {
    return "This task must declare at least one safe project-relative owned path that gives it executable scope.";
  }
  if (message.includes("exceeds the acceptance ceiling")) {
    return "This task exceeds the acceptance-statement ceiling; keep only the smallest independently observable criteria needed for the task.";
  }
  if (message.includes("exceeds the owned-path ceiling")) {
    return "This task exceeds the owned-path ceiling; narrow its scope or split the semantic work into smaller tasks.";
  }
  if (message.includes("must contain at least one task")) {
    return "Each phase must contain at least one semantic task.";
  }

  // Safe wire/Core messages retain their useful rule. A message containing any
  // code-owned identity fails closed to generic guidance instead of redaction.
  if (!MACHINE_IDENTITY.test(message)) return message;
  return "The value at this semantic location violates deterministic Core validation. Re-author the complete slice using symbolic semantic keys and the supplied schema.";
}

export function modelFacingRecoveryFindings(findings: readonly WireFinding[]): readonly ModelFacingSemanticFinding[] {
  return findings.map((finding) => {
    const rule = recoveryRule(finding);
    return {
      code: finding.code,
      pointer: safePointer(finding.pointer),
      message: semanticGuidance(finding),
      ...(rule ? { rule } : {}),
    };
  });
}

export function modelFacingRecoveryContext(findings: readonly WireFinding[]): ModelFacingRecoveryContext {
  const specificPreviousFindings = modelFacingRecoveryFindings(findings);
  const rules = new Set<RecoveryRule>();
  for (const finding of specificPreviousFindings) if (finding.rule) rules.add(finding.rule);
  return {
    violatedRules: [...rules].map((rule) => ({ rule, constraint: RECOVERY_RULE_CONSTRAINTS[rule] })),
    specificPreviousFindings,
  };
}

export function containsCodeOwnedMachineIdentity(value: string): boolean {
  return MACHINE_IDENTITY.test(value);
}
