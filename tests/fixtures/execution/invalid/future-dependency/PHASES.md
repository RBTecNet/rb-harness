# RB Execution Plan: future dependency

<!-- rb-execution-contract: rb-execution/v1 -->
<!-- rb-artifact-id: future-dependency-execution -->

## Phase 1: Broken task

**Phase ID:** P01
**Goal:** Demonstrate invalid dependency ordering.
**Depends on:** none
**Context:**
- `.rb/init/PLAN.md`

- [ ] T001 — Depends on the future
  - **Scope:** `src/`
  - **Change:** Change something.
  - **Covers:** RF-001
  - **Depends on:** T002
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T001-01: The change exists.
  - **Validation:**
    - `npm test`
  - **Expected evidence:** A change.
