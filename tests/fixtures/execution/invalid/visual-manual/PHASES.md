# RB Execution Plan: visual-manual-regression

<!-- rb-execution-contract: rb-execution/v1 -->
<!-- rb-artifact-id: visual-manual-regression -->

## Phase 1: Render the board

**Phase ID:** P01
**Goal:** Render the browser board.
**Depends on:** none
**Context:**
- `.rb/init/PROJECT.md`

- [ ] T001 — Render the board
  - **Scope:** `src/ui/board-renderer.js`, `tests/fake-dom.js`
  - **Change:** Render the board and install its stylesheet.
  - **Covers:** UI-001
  - **Depends on:** none
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T001-01: The rendered board keeps the chicken and vehicles visible inside the viewport.
    - AC-T001-02: No stylesheet source text is visible and no essential element is hidden, clipped, overlapping, or outside the viewport.
  - **Validation:**
    - manual: inspect selectors in the fake DOM and confirm that keyboard state changes
  - **Expected evidence:** Screenshots at viewport 1440x900 and getBoundingClientRect geometry with positive area and viewport intersection.
