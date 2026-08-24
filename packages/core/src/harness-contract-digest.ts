/**
 * Compact, versioned output contract (RF-002).
 *
 * The model must never open the RB Harness package to discover how to write an
 * artifact. Everything mechanical — manifest, hashes, derived IDs, the TSV
 * projection — is produced by code and is explicitly declared off-limits here,
 * so no tokens are spent asking a model to replicate deterministic data.
 *
 * These digests are code-owned strings: they are byte-stable for a given
 * version, which is what makes provider prefix caching effective, and they are
 * covered by a snapshot test with an explicit byte ceiling.
 */

import { HARNESS_BUDGET, interviewQuestionBudget } from "./harness-budget.js";
import type { HarnessWorkflow } from "./standalone-types.js";

export const HARNESS_CONTRACT_DIGEST_VERSION = "rb-harness-contract-digest/v1" as const;

const WORKFLOW_OUTPUTS: Readonly<Record<HarnessWorkflow, readonly string[]>> = {
  init: [
    ".rb/init/PROJECT.md — intent, capabilities, constraints, and knowledge classification",
    ".rb/init/PHASES.md — rb-execution/v1 initial plan (required, status ready)",
    ".rb/init/OPERATIONS.json — rb-operational/v1 consumer acceptance (when the product form allows one)",
  ],
  "ai-context": [
    ".rb/context/AGENTS.md — compact index of the AS IS context set",
    ".rb/context/ARCHITECTURE.md — implemented structure, boundaries, and data flow",
    ".rb/context/DOMAIN.md — vocabulary and rules proven by code or tests",
    ".rb/context/OPERATIONS.md — build, test, run, and release commands proven in the repository",
    "Additional .rb/context/*.md only when the evidence requires a separate concern",
  ],
  plan: [
    ".rb/features/<slug>/REQUEST.md — the normalized developer request",
    ".rb/features/<slug>/SPEC.md — RIGID/FLEXIBLE requirements with binary criteria",
    ".rb/features/<slug>/PLAN.md — architecture-aware decomposition and risks",
    ".rb/features/<slug>/PHASES.md — rb-execution/v1 plan (required, status ready)",
    ".rb/features/<slug>/OPERATIONS.json — rb-operational/v1 acceptance when the change is consumer-observable",
  ],
  evolve: [
    ".rb/evolutions/<slug>/AS_IS.md — proven current behavior with cited paths",
    ".rb/evolutions/<slug>/TO_BE.md — the delta and its observable outcome",
    ".rb/evolutions/<slug>/IMPACT.md — readers, writers, reactors, and preservation boundaries",
    ".rb/evolutions/<slug>/REGRESSION_MATRIX.md — preserved behavior and its proofs",
    ".rb/evolutions/<slug>/PHASES.md — rb-execution/v1 plan (required, status ready)",
    ".rb/evolutions/<slug>/OPERATIONS.json — rb-operational/v1 acceptance when the change is consumer-observable",
  ],
  review: [
    ".rb/reviews/<review-id>/FINDINGS.md — evidence-grounded findings with stable IDs (required, status ready)",
    ".rb/reviews/<review-id>/BASELINE.json — coverage and limits of this audit",
    ".rb/reviews/<review-id>/DESIGN_SYSTEM.md and RESPONSIVE_INVENTORY.json — only for UI audits with real evidence",
    ".rb/reviews/<review-id>/PHASES.md — only when remediation was explicitly requested",
  ],
};

const OPERATIONAL_WORKFLOWS = new Set<HarnessWorkflow>(["init", "plan", "evolve"]);

/** Whether this workflow may publish an rb-operational/v1 acceptance contract. */
export function workflowSupportsOperations(workflow: HarnessWorkflow): boolean {
  return OPERATIONAL_WORKFLOWS.has(workflow);
}

const CODE_OWNED = `## Owned by the orchestrator — never write these

- \`.rb/rb-manifest.json\` and \`.rb/artifacts.tsv\` are generated after your call.
- Artifact IDs, SHA-256 hashes, \`generatedAt\`, statuses, and kinds are derived from your files.
- Directory creation, atomic publication, and the previous-revision backup are code.
- Do not compute, restate, or "verify" any of the above. Spend your output on documentation content only.`;

const EXECUTION_GRAMMAR = `## rb-execution/v1 — PHASES.md grammar (exact)

\`\`\`markdown
# RB Execution Plan: <name>

<!-- rb-execution-contract: rb-execution/v1 -->
<!-- rb-artifact-id: <stable-kebab-id> -->

## Phase 1: <title>

**Phase ID:** P01
**Goal:** <observable phase outcome>
**Depends on:** none
**Context:**
- \`.rb/<path>/SPEC.md\`

- [ ] T001 — <task title>
  - **Scope:** \`src/thing.ts\`, \`tests/thing.test.ts\`
  - **Change:** <complete bounded change>
  - **Covers:** RF-001
  - **Depends on:** none
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T001-01: <binary observable result>
  - **Validation:**
    - \`npm test -- thing\`
  - **Expected evidence:** <files, tests, or command output>
\`\`\`

Mechanical rules enforced by the validator:

- Phase headings are \`## Phase <n>: <title>\` and \`Phase ID\` must be \`P\` + two digits matching \`<n>\`.
- Every phase declares Goal, \`Depends on\` (\`none\` or a comma list), at least one Context line, and at least one task.
- Task headings are \`- [ ] T### — <title>\`; task IDs are unique and ordered across the document.
- Every task declares Scope, Change, Covers, Depends on, Parallel safe (\`true\`/\`false\`), Acceptance criteria, Validation, Expected evidence.
- Acceptance criteria are \`AC-<taskId>-NN: <criterion>\` and must state an observable result. A criterion that only says a task "satisfies RF-001" is rejected as circular, and vague words (appropriate, adequate, correctly, fast, as needed, when possible, where valid, etc.) are rejected.
- Validation entries are a backtick command, \`manual: <manager-observable inspection>\`, or \`human: <external evidence>\`. \`manual: run ...\` is rejected — declare the real command. Never append \`|| true\` or \`; exit 0\`.
- Scope lists concrete project-relative paths or bounded globs in backticks. \`.\`, \`/\`, \`*\`, \`**\`, \`**/*\` are rejected; shared paths between tasks make them not parallel-safe.
- Phase context paths that start with \`.rb/\` must name a document you actually publish in this bundle.
- A phase must be self-contained for a cold context: goal, context paths, tasks, criteria, and validations only. Never depend on chat history, this conversation, the Harness installation, or an undeclared external file.
- Every clean-room operational scenario belongs to the post-phase audit; a normal task may require that \`OPERATIONS.json\` exists and validates, never that it passed.`;

const OPERATIONAL_GRAMMAR = `## rb-operational/v1 — OPERATIONS.json shape

\`\`\`json
{
  "contract": "rb-operational/v1",
  "cleanRoom": { "exclude": ["node_modules", "dist"] },
  "environment": { "inherit": ["PATH"], "set": { "NODE_ENV": "test" } },
  "scenarios": [{
    "id": "cli-version",
    "title": "A packaged consumer reads the version",
    "platforms": ["linux"],
    "steps": [
      { "id": "build", "kind": "command", "command": { "argv": ["npm", "run", "build"] }, "expect": { "exitCode": 0 } },
      { "id": "run", "kind": "command", "command": { "argv": ["./bin/app", "--version"] }, "expect": { "exitCode": 0, "stdoutIncludes": ["1."] } }
    ]
  }]
}
\`\`\`

- Root keys: \`contract\`, optional \`cleanRoom\`, optional \`environment\`, required non-empty \`scenarios\`.
- Scenario keys: \`id\`, \`title\`, optional \`platforms\` (\`linux\`/\`darwin\`/\`win32\`), non-empty \`steps\`. IDs are unique.
- Step kinds: \`command\`, \`process\` (with \`ready\` probe and optional \`checks\`), \`http\`, \`tcp\`, \`file\`. \`stdout\` exists only as a process probe.
- Commands are \`argv\` arrays; never a shell string, never an invented executable, path, port, or route.
- Never write a secret value. Inherit only the named non-secret variables the scenario needs.
- Identify the real product form (desktop, mobile, CLI, service, library, plugin, job, firmware, mixed). Never default to web. Omit the file entirely rather than inventing a scenario.`;

const CONVENTIONS = `## Conventions

- Write only under \`.rb/\`, plus the optional root \`AGENTS.md\` for the ai-context workflow. All paths are project-root-relative.
- Every generated document carries \`<!-- generated-by: rb-harness; schema: rb-artifact/v1 -->\` immediately after its title.
- IDs (project, requirement, finding, phase, task, decision, artifact) stay stable across re-runs.
- Classify knowledge as OBSERVED (cite the file path), CONFIRMED (an accepted interview decision), INFERRED, UNKNOWN, or CONFLICT. Never present INFERRED as OBSERVED.
- Documents must stay provider-, model-, stack-, and runner-neutral. They must not require a specific CLI, agent topology, RB Ralph, RB Memory, commit strategy, or branch strategy.
- Match the developer's prose language; keep IDs, contract markers, and machine field labels in English.
- Write only the conditional documents the request actually needs. Do not emit an empty template, and do not repeat a rule in several files: name one canonical source and reference it.
- Preserve compatible existing artifacts and confirmed manual edits unless this request supersedes them. Never write credentials, secrets, Ralph runtime state, or provider-specific instructions.`;

const READINESS = `## Readiness

Mark \`status: "complete"\` only when the required ready output for this workflow exists and every RIGID rule has a finite implementation authority: typed data, an exact grammar or matrix, or an explicitly declared classifier with a versioned failure contract. A growing keyword list is never an exhaustive semantic validator.

If a material contradiction still prevents safe readiness, return \`status: "blocked"\` with the missing decision in \`blocked\`. Do not publish a plan that claims readiness it does not have.`;

/** Compact contract handed to the single authoring call. */
export function generationContractDigest(workflow: HarnessWorkflow): string {
  const outputs = WORKFLOW_OUTPUTS[workflow];
  const sections = [
    `# ${HARNESS_CONTRACT_DIGEST_VERSION} · workflow ${workflow}`,
    `## Required output set\n\n${outputs.map((entry) => `- ${entry}`).join("\n")}`,
    CODE_OWNED,
    CONVENTIONS,
    EXECUTION_GRAMMAR,
    ...(workflowSupportsOperations(workflow) ? [OPERATIONAL_GRAMMAR] : []),
    READINESS,
  ];
  return sections.join("\n\n");
}

/**
 * Compact contract handed to the bounded interview analysis.
 *
 * Deliberately round-independent: this text is part of the invariant prompt
 * prefix, so it must be byte-identical in round one and round two. The
 * per-round budget lives in `interviewRoundDirective`, which is appended after
 * the prefix with the rest of the volatile state.
 */
export function interviewContractDigest(workflow: HarnessWorkflow): string {
  return [
    `# ${HARNESS_CONTRACT_DIGEST_VERSION} · interview · workflow ${workflow}`,
    `## Ask decision rule

Ask only when all of these hold:

1. Repository evidence and the supplied request cannot answer it safely.
2. At least two plausible answers exist.
3. The choice changes observable behavior, scope, contracts, security, data, or architecture.
4. A wrong assumption creates meaningful rework or risk.

Never ask about a fact you can discover: commands, dependencies, paths, conventions, existing behavior. Record it in \`discoveries\` instead. A FLEXIBLE choice never blocks: record an explicit assumption in \`assumptions\` and continue.`,
    `## Question shape

Each question carries the evidence already found, the single missing decision, why it matters, and — when a closed set is genuinely appropriate — two to six concrete options plus a recommendation. Use \`type: "text"\` for open decisions, \`"single-choice"\` with 2-6 options, or \`"confirm"\` for a yes/no. IDs are internal correlation keys of 2-80 ASCII letters, digits, dots, underscores, or hyphens.

The CLI presents your batch locally, one question at a time. Never plan for one question per call.`,
    `## Answer acceptance gate

Classify every pending answer exactly once, with one of these five words spelled exactly:

- ACCEPTED — one material interpretation; supply \`normalizedDecision\`.
- PARTIAL — resolves part of the decision; a material boundary, actor, trigger, outcome, or failure case is open.
- AMBIGUOUS — two or more materially different interpretations remain.
- DEFERRED — the developer does not know or wants to decide later; keep it out of RIGID claims.
- CONTRADICTED — it conflicts with evidence, another accepted answer, or itself.

An omitted or unsupported disposition is a protocol failure, not a shortcut to acceptance: the orchestrator will treat that answer as unresolved. PARTIAL, AMBIGUOUS, and CONTRADICTED require \`remainingUncertainty\`, and — while a follow-up round remains — one focused follow-up question whose \`answerFor\` names the original question ID. Never add precision the answer did not supply: no invented numbers, defaults, actors, platforms, or exceptions. "use recommendations" accepts what was shown; "not sure" and "defer" stay DEFERRED.`,
    `## Stop condition

Return \`ready\` when every remaining uncertainty is FLEXIBLE or an explicit low-risk assumption. Return \`blocked\` only when a RIGID decision is still materially unresolved and no round remains; name the missing decision in \`unresolved\`. Never return \`needs_input\` without questions or \`ready\` with questions.`,
  ].join("\n\n");
}

/** Volatile per-round budget, appended after the invariant prefix. */
export function interviewRoundDirective(round: number): string {
  const budget = interviewQuestionBudget(round);
  const remaining = HARNESS_BUDGET.interview.maxRounds - round;
  return [
    `## Round ${round} of ${HARNESS_BUDGET.interview.maxRounds}`,
    `- Return at most ${budget} question(s) in this round.`,
    remaining > 0
      ? `- Exactly ${remaining} follow-up round remains after this one. There is no third round.`
      : "- This is the final round. After it there is no further question opportunity: return ready or blocked.",
    `- A question beyond the ${budget}-question budget is not asked; it is recorded as a deferred open decision and prevents a ready result. Return only the most material ones.`,
  ].join("\n");
}

/** Compact contract handed to the single localized structural repair. */
export function repairContractDigest(workflow: HarnessWorkflow): string {
  return [
    `# ${HARNESS_CONTRACT_DIGEST_VERSION} · structural repair · workflow ${workflow}`,
    `This is the only repair. It is mechanical, not editorial.

- Fix exactly the listed deterministic errors, in the order given.
- Return only the documents you actually changed, plus any new document an error requires.
- Preserve every semantically unrelated line, section, ID, and decision byte for byte.
- Do not reopen the interview, re-explore the repository, restate the manifest, or re-emit the whole tree when a localized change suffices.
- If an error cannot be repaired without a developer decision, return \`status: "blocked"\` and name the decision.`,
    EXECUTION_GRAMMAR,
    ...(workflowSupportsOperations(workflow) ? [OPERATIONAL_GRAMMAR] : []),
  ].join("\n\n");
}
