import { isGenuineScriptedAuditorV2, ScriptedAuditor } from "./auditor-runtime.js";
import {
  isGenuineOpenCodeCliAuditorV2,
  type OpenCodeCliAuditorV2,
} from "../operational-m4d/cli-auditor-runtime.js";
import {
  isGenuineCodexCliAuditorV2,
  type CodexCliAuditorV2,
} from "../operational-m5d/codex-cli-auditor.js";

/**
 * Explicit nominal union of the only Auditor capabilities Core trusts.
 *
 * There is deliberately no `trustAuditor`/`registerAuditor`/`wrapAuditor`
 * surface: membership is granted only by the genuine constructor of one of the
 * three implementations below, recorded in module-private WeakSets that the
 * implementations themselves own. A structural record, a JSON or structured clone,
 * an `Object.create(prototype)` spoof, a subclass, a `Reflect.construct` call
 * and a TypeScript cast are all rejected.
 */
export type TrustedAuditorRuntimeV2 = ScriptedAuditor | OpenCodeCliAuditorV2 | CodexCliAuditorV2;

export function isTrustedAuditorRuntimeV2(value: unknown): value is TrustedAuditorRuntimeV2 {
  return isGenuineScriptedAuditorV2(value) || isGenuineOpenCodeCliAuditorV2(value) || isGenuineCodexCliAuditorV2(value);
}

export function assertTrustedAuditorRuntimeV2(value: unknown): asserts value is TrustedAuditorRuntimeV2 {
  if (!isTrustedAuditorRuntimeV2(value)) {
    throw new Error("RALPH_AUDITOR_AUTHORITY_REQUIRED: genuine ScriptedAuditor, OpenCodeCliAuditorV2 or CodexCliAuditorV2 runtime is required");
  }
}
