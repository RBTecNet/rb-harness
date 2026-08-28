import { describe, expect, it } from "vitest";
import { RALPH_EXECUTION_ISSUE_CODES, validateExecutionMarkdown } from "../../src/execution-contract.js";
import { resolveInitProject } from "../../src/vnext/resolve.js";
import { canonicalize, validate } from "../../src/vnext/validate.js";
import { deriveExecutionDocument, renderPhases } from "../../src/vnext/render/execution.js";
import { assertExecutionRoundTrip, assertRalphIssueMapExhaustive, RALPH_ISSUE_FIDELITY } from "../../src/vnext/ralph-fidelity.js";
import { HELLO_REQUEST, HELLO_SEMANTIC_FIXTURE } from "./fixtures/hello.js";

describe("vNext Ralph fidelity", () => {
  it("round-trips every execution-bearing field and exposes no new semantic issue after rendering", () => {
    const resolved = resolveInitProject(structuredClone(HELLO_SEMANTIC_FIXTURE), {
      originalRequest: HELLO_REQUEST,
      runId: "ralph-run",
      generatedAt: "2026-08-28T12:00:00.000Z",
    });
    if (!resolved.ok) throw new Error("fixture did not resolve");
    const model = canonicalize(resolved.value);
    expect(validate(model)).toEqual({ valid: true, findings: [] });
    const document = deriveExecutionDocument(model);
    const source = renderPhases(document);
    expect(() => assertExecutionRoundTrip(source, document)).not.toThrow();
    expect(validateExecutionMarkdown(source)).toMatchObject({ valid: true, issues: [] });
  });

  it("maps the actual exported Ralph execution issue-code set exhaustively", () => {
    expect(() => assertRalphIssueMapExhaustive()).not.toThrow();
    expect(Object.keys(RALPH_ISSUE_FIDELITY).sort()).toEqual([...RALPH_EXECUTION_ISSUE_CODES].sort());
    expect(RALPH_ISSUE_FIDELITY["phase.context.empty"]).toMatchObject({ kind: "renderer-owned" });
    expect(RALPH_ISSUE_FIDELITY["execution.go-tidy.nonconvergent-direct-requirement"]).toMatchObject({ kind: "workspace-only" });
  });
});
