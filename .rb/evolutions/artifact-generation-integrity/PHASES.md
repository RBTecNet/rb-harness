# RB Execution Plan: artifact-generation-integrity

<!-- generated-by: rb-harness; schema: rb-artifact/v1 -->
<!-- rb-execution-contract: rb-execution/v1 -->
<!-- rb-artifact-id: execution-artifact-generation-integrity -->

## Phase 1: Enforce artifact authority

**Phase ID:** P01
**Goal:** Invalid write authority and cross-artifact contradictions fail deterministically before publication or Ralph execution.
**Depends on:** none
**Context:**
- `.rb/evolutions/artifact-generation-integrity/TO_BE.md`
- `.rb/evolutions/artifact-generation-integrity/IMPACT.md`
- `.rb/evolutions/artifact-generation-integrity/REGRESSION_MATRIX.md`

- [ ] T001 — Reject planning artifacts in task scope
  - **Scope:** `packages/core/src/execution-contract.ts`, `packages/core/test/execution-contract.test.ts`, `tests/fixtures/execution/`
  - **Change:** Parse each backticked Scope token as logical execution authority and reject `.rb`, `.rb/`, and every `.rb/**` descendant or bounded glob with stable `task.scope.control-plane` evidence while leaving read-only references outside Scope valid.
  - **Covers:** RF-001, RF-002
  - **Depends on:** none
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T001-01: Every artifact-root Scope variant in RG-001/RG-002 returns `task.scope.control-plane` and identifies its task.
    - AC-T001-02: The read-only plan in RG-003 remains valid.
    - AC-T001-03: Logical `.rb/**` enforcement is unchanged when the physical artifact directory is `.spec`.
  - **Validation:**
    - `npm test --workspace @rb-harness/core -- execution-contract.test.ts`
  - **Expected evidence:** Contract fixtures and deterministic issue assertions for RG-001 through RG-004.

- [ ] T002 — Validate cross-artifact consistency once
  - **Scope:** `packages/core/src/artifact-consistency.ts`, `packages/core/src/artifact-verifier.ts`, `packages/core/src/harness-workspace.ts`, `packages/core/test/artifact-verifier.test.ts`
  - **Change:** Implement one pure consistency analysis for planning ownership, typed operational path provenance, and document references; call it from staging and artifacts verify, add public check names, and report both conflicting artifacts without invoking a provider.
  - **Covers:** RF-005, RF-007, RF-009
  - **Depends on:** T001
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T002-01: RG-005 produces equivalent blocker criteria in staged validation and artifacts verify.
    - AC-T002-02: RG-006 and RG-007 pass without stack- or extension-specific exceptions.
    - AC-T002-03: A stale hash remains a blocker whose required change does not recommend manifest sync.
  - **Validation:**
    - `npm test --workspace @rb-harness/core -- artifact-verifier.test.ts`
  - **Expected evidence:** Shared analyzer tests plus verifier report snapshots for valid, contradictory, and stale trees.

## Phase 2: Make generation dependency-aware

**Phase ID:** P02
**Goal:** Incremental authors receive finalized bounded authority from prerequisite documents, and publication only completes for the bytes present at the destination.
**Depends on:** P01
**Context:**
- `.rb/evolutions/artifact-generation-integrity/AS_IS.md`
- `.rb/evolutions/artifact-generation-integrity/TO_BE.md`
- `.rb/evolutions/artifact-generation-integrity/PRESERVATION.md`

- [ ] T003 — Add a validated document dependency graph
  - **Scope:** `packages/core/src/harness-incremental-documents.ts`, `packages/core/src/harness-generator.ts`, `packages/core/test/incremental-generation.test.ts`, `packages/core/test/generation-recovery.test.ts`
  - **Change:** Version document-plan checkpoints with validated dependency edges, topologically author dependent documents, and inject bounded code-owned projections so OPERATIONS follows finalized PHASES; reject missing/cyclic dependencies and incompatible legacy checkpoints before resuming.
  - **Covers:** RF-003, RF-004, RF-005
  - **Depends on:** T002
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T003-01: Missing and cyclic dependency fixtures fail before any document-part provider call.
    - AC-T003-02: The operations writer receives the finalized execution projection within its declared prompt budget.
    - AC-T003-03: A contradictory bundle can use the single localized repair and cannot truncate or rewrite unaffected documents.
    - AC-T003-04: A legacy checkpoint fails with a stable restart diagnostic instead of mixing protocol versions.
  - **Validation:**
    - `npm test --workspace @rb-harness/core -- incremental-generation.test.ts generation-recovery.test.ts documentation-core.test.ts`
  - **Expected evidence:** Provider-call logs, prompt byte assertions, dependency fixtures, and full-document preservation tests.

- [ ] T004 — Verify and roll back the published destination
  - **Scope:** `packages/core/src/harness-workspace.ts`, `packages/core/src/standalone-runner.ts`, `packages/core/test/standalone.test.ts`, `packages/core/test/cli-compatibility.test.ts`
  - **Change:** Add a read-only closing validation after atomic rename; mark complete only after success, and on mismatch restore the preserved revision when present while retaining the failed run diagnostic and never resyncing the target.
  - **Covers:** RF-006, RF-009
  - **Depends on:** T002
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T004-01: An unchanged destination closes the run as complete.
    - AC-T004-02: A controlled post-rename mutation prevents complete and restores the exact prior artifact bytes.
    - AC-T004-03: A failed first publication preserves the diagnostic and does not report a ready artifact tree.
  - **Validation:**
    - `npm test --workspace @rb-harness/core -- standalone.test.ts cli-compatibility.test.ts`
  - **Expected evidence:** Integration assertions for RG-013 through RG-015 and run-state transitions.

## Phase 3: Align contracts, consumers, and release proof

**Phase ID:** P03
**Goal:** Every shipped instruction and package expresses the immutable authority model, and generic workflow fixtures prove it.
**Depends on:** P02
**Context:**
- `.rb/evolutions/artifact-generation-integrity/MIGRATION.md`
- `.rb/evolutions/artifact-generation-integrity/PRESERVATION.md`
- `.rb/evolutions/artifact-generation-integrity/REGRESSION_MATRIX.md`

- [ ] T005 — Correct generation and operational authoring guidance
  - **Scope:** `packages/core/src/harness-contract-digest.ts`, `resources/references/`, `resources/workflows/{init,plan,evolve}/instructions.md`, `packages/core/test/operational-lifecycle.test.ts`
  - **Change:** State that generation owns final OPERATIONS content, implementation tasks only read or validate published artifacts, document-plan dependencies are mandatory, and every emitted operational path is grounded in finalized authority.
  - **Covers:** RF-003, RF-004
  - **Depends on:** T003
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T005-01: No shipped authoring text says a normal implementation phase owns creation of OPERATIONS.json.
    - AC-T005-02: The digest explicitly separates Scope writes from Context and validation reads.
    - AC-T005-03: Prompt and resource snapshot tests remain within their byte ceilings.
  - **Validation:**
    - `npm test --workspace @rb-harness/core -- operational-lifecycle.test.ts documentation-core.test.ts`
  - **Expected evidence:** Digest/resource assertions and byte-budget output.

- [ ] T006 — Publish migration and Ralph compatibility requirements
  - **Scope:** `contracts/RB-RALPH-CONTRACT.md`, `README.md`, `README.pt-BR.md`, `packages/core/test/provider-runtime.test.ts`
  - **Change:** Define published artifacts as immutable for sequential, parallel and legacy consumers, require provider-neutral pre/post fingerprints in the coordinated Ralph release, retain direct-tool write denial, and document regeneration rather than manifest resync for legacy offenders.
  - **Covers:** RF-008, RF-009
  - **Depends on:** T004, T005
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T006-01: Public docs state the compatibility boundary and rollout order without claiming the external Ralph change is already implemented.
    - AC-T006-02: Direct provider tools still reject writes to the configured artifact directory.
    - AC-T006-03: Migration guidance never presents manifest sync as repair for an unauthorized mutation.
  - **Validation:**
    - `npm test --workspace @rb-harness/core -- provider-runtime.test.ts`
  - **Expected evidence:** Documentation assertions, direct-tool denial test, and explicit downstream compatibility note.

- [ ] T007 — Gate release with cross-project fixtures
  - **Scope:** `packages/core/test/fixtures/standalone/`, `packages/core/test/readiness.test.ts`, `scripts/check-standalone-package.mjs`, `scripts/check-plugin.mjs`
  - **Change:** Add neutral init, plan and evolve fixtures covering static, CLI/library and service shapes, including repairable drift and valid provenance; execute contract, tree and artifact verification through the packed bin and ensure generated tasks never own `.rb/**`.
  - **Covers:** RF-007, RF-010
  - **Depends on:** T005, T006
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T007-01: RG-017 through RG-019 pass without domain-specific names or assertions.
    - AC-T007-02: The packed binary rejects the invalid writer fixture and approves each corrected artifact tree.
    - AC-T007-03: Source resources, plugin mirrors and bundled scripts are byte-consistent.
    - AC-T007-04: The full repository gate exits zero.
  - **Validation:**
    - `npm run check`
  - **Expected evidence:** Packed-bin verification reports, fixture inspection, plugin sync result, and the complete check output.
