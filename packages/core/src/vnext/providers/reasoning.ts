import type { ModelProfile, SemanticRequest } from "./contract.js";

/** Project exact profile authority into one immutable semantic request policy. */
export function semanticReasoningForProfile(profile: ModelProfile): SemanticRequest["reasoning"] {
  const reasoning = profile.reasoning;
  if (!reasoning.supported || reasoning.defaultMode === "off") return Object.freeze({ mode: "off" });

  if (!reasoning.efforts.includes("low")) {
    throw new Error(`PROFILE_REASONING_EFFORT_REQUIRED: ${profile.id} defaults reasoning on without an allowed effort`);
  }
  return Object.freeze({ mode: "on", effort: "low" });
}
