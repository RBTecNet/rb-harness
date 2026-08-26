# RB Execution Plan: go-plan-convergence

<!-- generated-by: rb-harness; schema: rb-artifact/v1 -->
<!-- rb-execution-contract: rb-execution/v1 -->
<!-- rb-artifact-id: execution-go-plan-convergence -->

## Phase 1: Enforce convergent Go plans

**Phase ID:** P01
**Goal:** Every Harness publication gate rejects the proven non-convergent Go shape and preserves legitimate module workflows.
**Depends on:** none
**Context:**
- `.rb/evolutions/go-plan-convergence/TO_BE.md`
- `.rb/evolutions/go-plan-convergence/IMPACT.md`
- `.rb/evolutions/go-plan-convergence/REGRESSION_MATRIX.md`

- [ ] T001 — Implement the finite shared classifier
  - **Scope:** `packages/core/src/go-plan-convergence.ts`, `packages/core/src/execution-contract.ts`, `packages/core/src/artifact-consistency.ts`, `packages/core/src/index.ts`, `packages/core/test/go-plan-convergence.test.ts`
  - **Change:** Classify direct Go requirements, module identities, `go mod tidy`, scoped current/ordered import producers, compatible subpackage imports and explicit checkout inventory; fail open when absence cannot be proved.
  - **Covers:** RF-001, RF-002, RF-003, RF-004
  - **Depends on:** none
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T001-01: RG-001 and RG-005 return `execution.go-tidy.nonconvergent-direct-requirement` with task, criterion, module, normalizer and ordering evidence.
    - AC-T001-02: RG-002 through RG-004 and RG-006 return no non-convergence finding.
    - AC-T001-03: RG-007 returns `execution.go-direct-requirement.module-identity-missing` without inferring a commercial name.
  - **Validation:**
    - `npm test --workspace @rb-harness/core -- go-plan-convergence.test.ts`
    - `npm run typecheck`
  - **Expected evidence:** Deterministic positive/negative fixtures and zero exit status from tests and typecheck.

- [ ] T002 — Share the finding across publication gates
  - **Scope:** `packages/core/src/cli-program.ts`, `packages/core/src/harness-workspace.ts`, `packages/core/src/headless-runner.ts`, `packages/core/test/headless-init.test.ts`, `packages/core/test/fixtures/headless/fake-adapter.mjs`, `packages/core/test/cli-compatibility.test.ts`
  - **Change:** Feed project-aware inventory to staging, verifier, CLI and headless, preserve the public finding codes, and expose an explicit `--project` authority to contract validation.
  - **Covers:** RF-005
  - **Depends on:** T001
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T002-01: RG-008 exposes byte-identical finding evidence in staging and artifacts verify, while headless exposes the same stable criterion code.
    - AC-T002-02: `contract validate --project` accepts an explicit project root and uses only that checkout as import authority.
  - **Validation:**
    - `npm test --workspace @rb-harness/core -- headless-init.test.ts cli-compatibility.test.ts`
  - **Expected evidence:** Headless diagnostic assertions and CLI surface/project-root assertions.

- [ ] T003 — Teach and bound structural repair
  - **Scope:** `packages/core/src/harness-contract-digest.ts`, `packages/core/test/standalone.test.ts`, `packages/core/test/fixtures/standalone/repairing-provider.mjs`, `packages/core/test/documentation-core.test.ts`
  - **Change:** Teach post-validation convergence and closed Scope to authors and bounded repair, then prove a localized Go correction changes only the affected plan without inventing source.
  - **Covers:** RF-006
  - **Depends on:** T002
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T003-01: RG-009 publishes a convergent replacement and leaves its sibling specification unchanged.
    - AC-T003-02: The digest forbids sentinel imports, purposeless blank imports and out-of-Scope source.
  - **Validation:**
    - `npm test --workspace @rb-harness/core -- standalone.test.ts documentation-core.test.ts`
  - **Expected evidence:** Repair invocation log, convergent replacement, preserved sibling bytes and digest assertions.

## Phase 2: Prove the distributed package

**Phase ID:** P02
**Goal:** The packed Harness and optional Go integration preserve the same convergence invariant.
**Depends on:** P01
**Context:**
- `.rb/evolutions/go-plan-convergence/MIGRATION.md`
- `.rb/evolutions/go-plan-convergence/PRESERVATION.md`
- `.rb/evolutions/go-plan-convergence/REGRESSION_MATRIX.md`

- [ ] T004 — Add installed-package and idempotency regressions
  - **Scope:** `scripts/check-standalone-package.mjs`, `plugins/rb-harness/scripts/rb-harness.cjs`, `packages/core/test/go-plan-convergence.test.ts`
  - **Change:** Exercise invalid and existing-import variants through the packed bin, run two real `go mod tidy` executions when Go is available, rebuild the plugin mirror, and run the complete release gate.
  - **Covers:** RF-001, RF-005
  - **Depends on:** T002, T003
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T004-01: RG-010 is rejected then accepted by the installed binary according to project inventory.
    - AC-T004-02: RG-011 leaves `go.mod` and `go.sum` hashes unchanged and writes no unexpected root artifact when Go is available.
    - AC-T004-03: The complete repository check exits with status 0.
  - **Validation:**
    - `npm run check`
  - **Expected evidence:** Packed-bin command results, conditional Go hashes, rebuilt plugin consistency and the complete check exit status.
