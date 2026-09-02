import { CONFORMANCE_CASES } from "../conformance/fixtures.js";
import type { ConformanceCase } from "../conformance/suite.js";

const baseRequest = CONFORMANCE_CASES.find((test) => test.id === "valid-structured-response")!.request;

export const OPENCODE_CLI_CONFORMANCE_CASES: readonly ConformanceCase[] = [
  ...CONFORMANCE_CASES,
  {
    id: "external-cli-evidence",
    category: "transport-version",
    mandatory: true,
    happyPath: false,
    request: baseRequest,
    expect: { kind: "runtime-assertion", key: "external-cli-evidence" },
  },
];
