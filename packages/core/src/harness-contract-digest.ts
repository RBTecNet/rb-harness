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
- Task headings are \`- [ ] T### — <title>\`; task IDs form one global, unique, increasing sequence across the whole document. Never restart at \`T001\` in a later phase and never substitute composite IDs such as \`P02-T001\`.
- Every task declares Scope, Change, Covers, Depends on, Parallel safe (\`true\`/\`false\`), Acceptance criteria, Validation, Expected evidence.
- A phase \`Depends on\` field contains only earlier \`P##\` phase IDs. A task \`Depends on\` field contains only earlier \`T###\` task IDs, never a \`P##\` phase ID. Do not repeat the enclosing phase dependency on its tasks; use \`none\` when a task has no earlier task dependency.
- Acceptance criteria are \`AC-<taskId>-NN: <criterion>\` and must state an observable result. A criterion that only says a task "satisfies RF-001" is rejected as circular, and vague words (appropriate, adequate, correctly, fast, as needed, when applicable, when possible, where valid, etc.) are rejected.
- Never copy a vague source phrase such as \`when applicable\` or \`quando aplicável\` into acceptance. If the uncertainty is FLEXIBLE, keep it in the decision/specification documents and omit it from task acceptance. Otherwise replace it with the finite conditions and observable outcomes already fixed by the closed decisions; never invent a condition during authoring.
- Validation entries are a backtick command, \`manual: <manager-observable inspection>\`, or \`human: <external evidence>\`. \`manual: run ...\` is rejected — declare the real command. Never append \`|| true\` or \`; exit 0\`.
- A validation is judged by its exit code, so it is never a service or watcher: \`npm start\`, \`npm run dev\`, \`vite\`, \`nodemon\`, \`uvicorn\` and \`--watch\` never exit. Prove a service task by importing its entrypoint in a test or invoking it once; leave the running service to \`OPERATIONS.json\`.
- Never put \`manual:\` or \`human:\` inside backticks: backticks mean execute, and no \`manual:\` program exists. Write \`- manual: inspect ...\` bare.
- Scope lists concrete project-relative paths or bounded globs in backticks. \`.\`, \`/\`, \`*\`, \`**\`, \`**/*\` are rejected; shared paths between tasks make them not parallel-safe.
- Phase context paths that start with \`.rb/\` must name a document you actually publish in this bundle.
- A phase must be self-contained for a cold context: goal, context paths, tasks, criteria, and validations only. Never depend on chat history, this conversation, the Harness installation, or an undeclared external file.
- Every clean-room operational scenario belongs to the post-phase audit; a normal task may require that \`OPERATIONS.json\` exists and validates, never that it passed.

## Task granularity — enforced deterministically

The consumer runs **one ephemeral, context-free call per task**: the executor sees the validated task extract and the repository, never this conversation, the other tasks' reasoning, or the documents you are writing now. A task that carries a whole feature must be re-derived from nothing inside one window, which is exactly where an executor forgets a requirement or invents one.

So decompose every capability into the smallest steps that are each independently observable:

- A task declares at most ${HARNESS_BUDGET.decomposition.maxAcceptanceCriteria} acceptance criteria and lists at most ${HARNESS_BUDGET.decomposition.maxScopePaths} scope paths.
- A phase holds at most ${HARNESS_BUDGET.decomposition.maxTasksPerPhase} tasks, and a phase whose single task scopes a whole area (\`src/\`, \`src/**\`) instead of naming files is a feature that was never decomposed.
- \`Covers\` is traceability, not size. List every requirement the task genuinely proves, however many that is; a one-file quality-gate task may legitimately cover several. Never trim \`Covers\` to look smaller.
- Never write a task such as "implement the X feature", "build the module", or "wire everything together". Name the one behavior it makes observable — a data shape, an operation, a boundary, one error path, one regression proof.
- Split along boundaries the code already has: contract before use, storage before behavior, behavior before interface, happy path before each error path. Order them with \`Depends on\` instead of merging them.
- More small tasks is the correct outcome. A plan with many bounded tasks is cheaper and safer to execute than a plan with a few large ones, and it never costs a completeness claim: every requirement must still be covered by some task.

## Parallel safe — decide it, do not default it

\`Parallel safe\` is a real decision with a real cost. The consumer runs a phase's pending tasks concurrently only when *every* one of them declares \`true\`, so a single unjustified \`false\` serializes the whole phase. Marking everything \`false\` is not the safe choice; it is the slow one.

Write \`true\` when all of these hold, which is common for sibling tasks that each own one module:

- its \`Scope\` paths are disjoint from every other pending task in the same phase — no shared file, and no shared directory that both will write;
- it declares \`Depends on: none\`, or depends only on tasks in an earlier phase;
- it does not add to a shared registry, index, barrel file, migration sequence, generated artifact, or lockfile that another pending task also touches.

Write \`false\` when independence cannot be shown — a shared file, an ordering requirement, or an interface one task defines and another consumes. Splitting a shared edit into its own earlier task is usually what unlocks the rest of the phase.

These ceilings are validated mechanically. A plan that breaks one is rejected before publication, so decompose while you write instead of repairing afterwards.`;

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
  }, {
    "id": "service-request",
    "title": "A consumer reaches the running service",
    "platforms": ["linux"],
    "steps": [
      { "id": "serve", "kind": "process", "command": { "argv": ["npm", "start"] },
        "ready": { "kind": "http", "url": "http://127.0.0.1:\${RB_VERIFY_PORT}/", "status": 200 },
        "checks": [
          { "kind": "http", "url": "http://127.0.0.1:\${RB_VERIFY_PORT}/api/thing", "status": 200, "bodyIncludes": ["expected"] }
        ] }
    ]
  }]
}
\`\`\`

- Root keys: \`contract\`, optional \`cleanRoom\`, optional \`environment\`, required non-empty \`scenarios\`.
- Scenario keys: \`id\`, \`title\`, optional \`platforms\` (\`linux\`/\`darwin\`/\`win32\`), non-empty \`steps\`. IDs are unique.
- Step kinds: \`command\`, \`process\` (with \`ready\` probe and optional \`checks\`), \`http\`, \`tcp\`, \`file\`. \`stdout\` exists only as a process probe.
- **A process lives only inside its own step.** The runner starts it, waits for \`ready\`, runs that step's \`checks\`, then stops it. Every assertion that needs the service alive belongs in that step's \`checks\` array. A sibling \`http\`/\`tcp\` step placed after the process step runs against a closed port, and a scenario that probes a local address without starting a process never had a server at all. Both shapes are structurally valid, always fail execution, and cannot be repaired by the executor, which may not edit generated specifications.
- Use \`\${RB_VERIFY_PORT}\` for the local port instead of a fixed one such as 3000, and make the product read it (\`PORT\`/\`process.env\`). The runner allocates a free port per verification; a hard-coded port can collide with something already running on the machine and prove nothing.
- An HTTP probe puts assertions directly on the probe: \`{ "kind": "http", "url": "http://127.0.0.1:3000/", "status": 200, "bodyIncludes": ["expected text"] }\`. Never put an \`expect\` object inside \`ready\`, \`checks\`, or another probe; \`expect\` exists only on a \`command\` step.
- Commands are \`argv\` arrays; never a shell string, never an invented executable, path, port, or route.
- Never write a secret value. Inherit only the named non-secret variables the scenario needs.
- Identify the real product form (desktop, mobile, CLI, service, library, plugin, job, firmware, mixed). Never default to web. Omit the file entirely rather than inventing a scenario.`;

const CONVENTIONS = `## Conventions

- Write only under \`.rb/\`. There is no exception: a path outside it is rejected before publication, and \`rb-manifest/v1\` cannot index one. The ai-context index lives at \`.rb/context/AGENTS.md\` like every other artifact. All paths are project-root-relative.
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

/** Compact contract handed to the plan and bounded authoring calls. */
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

The CLI presents your batch locally, one question at a time. Never plan for one question per call.

Write every question, option, recommendation, and \`why\` in the same language the developer used in their request. That choice is theirs, not yours, and it must not drift between rounds of the same run: a developer who wrote in Portuguese is asked in Portuguese from the first round to the last. Keep IDs, disposition words, and machine field names in English regardless.

Ask for the decision, not for prose. Two runs of the same request should surface the same material gaps, so derive each question from a concrete gap in the evidence rather than from what would be interesting to know.`,
    `## Answer acceptance gate

Classify every pending answer exactly once, with one of these five words spelled exactly:

- ACCEPTED — one material interpretation; supply \`normalizedDecision\`.
- PARTIAL — resolves part of the decision; a material boundary, actor, trigger, outcome, or failure case is open.
- AMBIGUOUS — two or more materially different interpretations remain.
- DEFERRED — the developer does not know or wants to decide later; keep it out of RIGID claims.
- CONTRADICTED — it conflicts with evidence, another accepted answer, or itself.

An omitted or unsupported disposition is a protocol failure, not a shortcut to acceptance: the orchestrator will treat that answer as unresolved. PARTIAL, AMBIGUOUS, and CONTRADICTED require \`remainingUncertainty\`, and — while a follow-up round remains — one focused follow-up question whose \`answerFor\` names the original question ID. Never add precision the answer did not supply: no invented numbers, defaults, actors, platforms, or exceptions. "use recommendations" accepts what was shown; "not sure" and "defer" stay DEFERRED.`,
    `## Stop condition

The interview is adaptive, not a fixed number of rounds. It ends when it converges: return \`ready\` only when every remaining uncertainty is FLEXIBLE or an explicit low-risk assumption, and no material ambiguity, gap, or contradiction is left in the request.

While a material decision is still open — including one an earlier answer just opened — return \`needs_input\` with the questions that close it. Never trade a material decision for an invented assumption to finish sooner, and never keep asking once nothing material is open.

Return \`blocked\` only when a RIGID decision is still materially unresolved and no round remains; name the missing decision in \`unresolved\`. Never return \`needs_input\` without questions or \`ready\` with questions.`,
  ].join("\n\n");
}

/** Volatile per-round budget, appended after the invariant prefix. */
export function interviewRoundDirective(round: number, askedQuestions = 0): string {
  const budget = interviewQuestionBudget(round);
  const remainingRounds = HARNESS_BUDGET.interview.maxRounds - round;
  const remainingQuestions = HARNESS_BUDGET.interview.maxQuestions - askedQuestions;
  const final = remainingRounds <= 0 || remainingQuestions <= budget;
  return [
    `## Round ${round}`,
    `- Return at most ${budget} question(s) in this round.`,
    final
      ? "- This is the final round the safety ceiling allows. After it there is no further question opportunity: return ready, or blocked naming the decision that is still open."
      : "- The interview is adaptive: it continues for as many focused rounds as convergence needs. Ask what this round can actually resolve, not everything at once — a new material decision that an answer opens earns another round.",
    final
      ? ""
      : `- Safety ceilings, not a target: at most ${HARNESS_BUDGET.interview.maxRounds} rounds and ${HARNESS_BUDGET.interview.maxQuestions} questions per run; ${remainingRounds} round(s) and ${remainingQuestions} question(s) remain. Converging earlier is the goal; stretching the interview to fill them is not.`,
    final
      ? `- A question beyond the ${budget}-question budget is not asked at all; it is recorded as a deferred open decision and blocks the run. Return the most material ones first.`
      : `- A question beyond the ${budget}-question budget is not asked in this round; it is carried into the next one and prevents a ready result. Return the most material ones first.`,
    "- Never re-ask a decision the developer already answered and you classified ACCEPTED. Ask only what is still materially open.",
  ].filter(Boolean).join("\n");
}

/** Compact contract handed to the single localized structural repair. */
export function repairContractDigest(workflow: HarnessWorkflow): string {
  return [
    `# ${HARNESS_CONTRACT_DIGEST_VERSION} · structural repair · workflow ${workflow}`,
    `This is the only repair. It is mechanical, not editorial.

- Fix exactly the listed deterministic errors, in the order given.
- Plan only the documents an error actually requires: the ones named as affected, plus any new document an error requires. Never replan a document no error names.
- **A document you replan is replaced in full.** Its parts are concatenated and the result overwrites the whole file — there is no partial patch. So re-emit the complete corrected document: title, contract markers, artifact ID, every phase, every task, every section. Emitting only the corrected fragment deletes the rest of the file and fails the run.
- Outside the exact error, preserve every line, section, ID, and decision byte for byte from the original supplied under REPAIR AUTHORITY.
- Do not reopen the interview, re-explore the repository, or restate the manifest.
- If an error cannot be repaired without a developer decision, return \`status: "blocked"\` and name the decision.`,
    EXECUTION_GRAMMAR,
    ...(workflowSupportsOperations(workflow) ? [OPERATIONAL_GRAMMAR] : []),
  ].join("\n\n");
}
