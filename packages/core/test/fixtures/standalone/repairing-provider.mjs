#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const prompt = Buffer.concat(chunks).toString("utf8");

if (process.env.RB_HARNESS_MODE === "interview") {
  const result = {
    contract: "rb-harness-interview/v1",
    status: "ready",
    summary: "The fixture request is ready.",
    discoveries: [],
    assumptions: [],
    unresolved: [],
    answerReviews: [],
    questions: [],
  };
  process.stdout.write(`RB_HARNESS_INTERVIEW_JSON_BEGIN\n${JSON.stringify(result)}\nRB_HARNESS_INTERVIEW_JSON_END\n`);
  process.exit(0);
}

if (process.env.RB_HARNESS_MODE === "audit") {
  const specification = await readFile(resolve(process.cwd(), ".rb/features/audit-repair/SPEC.md"), "utf8");
  const repaired = specification.includes("request.targetMode");
  const result = repaired ? {
    contract: "rb-harness-artifact-audit/v1",
    status: "pass",
    summary: "The scope rule now has a typed authority and finite test matrix.",
    findings: [],
  } : {
    contract: "rb-harness-artifact-audit/v1",
    status: "revise",
    summary: "The deterministic scope rule depends on unbounded natural-language inference.",
    findings: [{
      id: "proofability.scope-authority",
      category: "proofability",
      artifact: ".rb/features/audit-repair/SPEC.md",
      criterion: "RF-001",
      evidence: "RF-001 asks deterministic code to reject every phrase implying existing-system work without a finite authority.",
      requiredChange: "Define a typed scope authority and positive/negative matrix instead of semantic keyword inference.",
    }],
  };
  process.stdout.write(`RB_HARNESS_ARTIFACT_AUDIT_JSON_BEGIN\n${JSON.stringify(result)}\nRB_HARNESS_ARTIFACT_AUDIT_JSON_END\n`);
  process.exit(0);
}

const feature = resolve(process.cwd(), ".rb/features/audit-repair");
await mkdir(feature, { recursive: true });
const repaired = prompt.includes("proofability.scope-authority");
await writeFile(resolve(feature, "REQUEST.md"), "# Request\n\nGenerate a deterministic new-project scope gate.\n", "utf8");
await writeFile(resolve(feature, "SPEC.md"), repaired
  ? "# Specification\n\n## RF-001\n\nThe request is accepted only when `request.targetMode` equals `greenfield`; every other enum value is rejected. Text fields are project content and do not override `targetMode`. Test `greenfield` as accepted and `existing`, missing, and unknown values as rejected.\n"
  : "# Specification\n\n## RF-001\n\nDeterministically reject every phrase that implies work on an existing system.\n", "utf8");
await writeFile(resolve(feature, "PLAN.md"), "# Plan\n\nImplement the typed scope gate and its finite matrix.\n", "utf8");
await writeFile(resolve(feature, "PHASES.md"), `# RB Execution Plan: Audit repair

<!-- rb-execution-contract: rb-execution/v1 -->
<!-- rb-artifact-id: audit-repair-execution -->

## Phase 1: Build the scope gate

**Phase ID:** P01
**Goal:** Enforce the documented typed scope authority.
**Depends on:** none
**Context:**
- \`.rb/features/audit-repair/SPEC.md\`
- \`.rb/features/audit-repair/PLAN.md\`

- [ ] T001 — Implement the typed scope gate
  - **Scope:** \`src/\`, \`tests/\`
  - **Change:** Enforce RF-001 using the declared request field and matrix.
  - **Covers:** RF-001
  - **Depends on:** none
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T001-01: The finite accepted and rejected values produce the documented outcomes.
  - **Validation:**
    - \`npm test\`
  - **Expected evidence:** Positive and negative regression results with exit code 0.
`, "utf8");
process.stdout.write(repaired ? "Repaired artifact root cause.\n" : "Generated initial ambiguous artifacts.\n");
