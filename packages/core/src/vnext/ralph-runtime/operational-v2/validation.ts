import { parseValidationInstruction, type ValidationInstruction } from "../../../execution-contract.js";
import type { Task } from "../../../types.js";
import { canonicalJson } from "../canonical-json.js";
import { sha256 } from "../hashing.js";
import type { ValidationKind, ValidationSpecRef } from "./contracts.js";

/**
 * Convert a validated rb-execution/v1 declaration into a Core-owned,
 * immutable descriptor.  This is only parsing and identity derivation: it
 * never constructs argv, selects a shell, or executes the declaration.
 */
export function parseValidationSpec(
  instruction: string,
  input: { readonly taskId: string; readonly planIdentity: string; readonly ordinal: number },
): ValidationSpecRef {
  const parsed = parseValidationInstruction(instruction);
  if (!parsed) throw new Error("RALPH_V2_VALIDATION_INSTRUCTION_INVALID");
  if (input.ordinal < 1 || !Number.isSafeInteger(input.ordinal)) throw new Error("RALPH_V2_VALIDATION_ORDINAL_INVALID");
  if (!input.taskId || !input.planIdentity) throw new Error("RALPH_V2_VALIDATION_SOURCE_IDENTITY_INVALID");
  const kind = validationKind(parsed);
  const descriptor = {
    validationSpecId: validationSpecId(input.taskId, input.ordinal),
    ordinal: input.ordinal,
    kind,
    instruction: parsed.value,
    sourceTaskId: input.taskId,
    sourcePlanIdentity: input.planIdentity,
  } satisfies Omit<ValidationSpecRef, "digest">;
  return { ...descriptor, digest: sha256(canonicalJson(descriptor)) };
}

export function validationSpecId(taskId: string, ordinal: number): string {
  if (!taskId || !Number.isSafeInteger(ordinal) || ordinal < 1) throw new Error("RALPH_V2_VALIDATION_SPEC_ID_INVALID");
  return `${taskId}:validation:${ordinal}`;
}

export function validationSpecsForTask(task: Pick<Task, "id" | "validation">, planIdentity: string): readonly ValidationSpecRef[] {
  return task.validation.map((instruction, index) => parseValidationSpec(instruction, {
    taskId: task.id,
    planIdentity,
    ordinal: index + 1,
  }));
}

export function validationInstructionKind(instruction: string): ValidationKind {
  const parsed = parseValidationInstruction(instruction);
  if (!parsed) throw new Error("RALPH_V2_VALIDATION_INSTRUCTION_INVALID");
  return validationKind(parsed);
}

function validationKind(instruction: ValidationInstruction): ValidationKind {
  if (instruction.kind === "command") return "COMMAND";
  if (instruction.kind === "manual") return "MANUAL";
  return "HUMAN";
}
