# RB Execution Plan: missing acceptance

<!-- rb-execution-contract: rb-execution/v1 -->
<!-- rb-artifact-id: missing-acceptance-execution -->

## Phase 1: Broken task

**Phase ID:** P01
**Goal:** Demonstrate invalid input.
**Depends on:** none
**Context:**
- `.rb/init/PLAN.md`

- [ ] T001 — Missing acceptance
  - **Scope:** `src/`
  - **Change:** Change something.
  - **Covers:** RF-001
  - **Depends on:** none
  - **Parallel safe:** false
  - **Validation:**
    - `npm test`
  - **Expected evidence:** A change.
