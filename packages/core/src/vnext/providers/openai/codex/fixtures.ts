import { CONFORMANCE_CASES } from "../../conformance/fixtures.js";
import type { ConformanceCase } from "../../conformance/suite.js";
import { semanticReasoningForProfile } from "../../reasoning.js";
import { CODEX_SUBSCRIPTION_PROFILE } from "./profiles.js";

const shared = CONFORMANCE_CASES
  .filter((test) => test.id !== "reasoning-enabled")
  .map((test): ConformanceCase => ({
    ...test,
    request: (signal) => ({ ...test.request(signal), reasoning: semanticReasoningForProfile(CODEX_SUBSCRIPTION_PROFILE) }),
  }));

const baseRequest = shared.find((test) => test.id === "valid-structured-response")!.request;

export const CODEX_SUBSCRIPTION_CONFORMANCE_CASES: readonly ConformanceCase[] = [
  ...shared,
  {
    id: "codex-app-server-evidence",
    category: "invocation-bounds",
    mandatory: true,
    happyPath: false,
    request: baseRequest,
    expect: { kind: "runtime-assertion", key: "codex-app-server-evidence" },
  },
];
