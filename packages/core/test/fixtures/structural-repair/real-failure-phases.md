# RB Execution Plan: Region splicing regression

<!-- rb-execution-contract: rb-execution/v1 -->
<!-- rb-artifact-id: region-splicing-regression -->

## Phase 1: Establish deterministic ownership

**Phase ID:** P01
**Goal:** Establish stable repair ownership without changing neighboring content.
**Depends on:** none
**Context:**
- `.rb/init/PROJECT.md`
- `.rb/init/REQUIREMENTS.md`

- [ ] T001 — Repair target one
  - **Scope:** `src/task-001.ts`
  - **Change:** Implement bounded behavior for T001.
  - **Covers:** RF-001
  - **Depends on:** none
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T001-01: The T001 fixture behavior is observable.
  - **Validation:**
    - `npm test`
  - **Expected evidence:** T001 passes with exit code 0.

- [ ] T002 — Preserve neighbor two
  - **Scope:** `src/task-002.ts`
  - **Change:** Implement bounded behavior for T002.
  - **Covers:** RF-002
  - **Depends on:** none
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T002-01: The T002 fixture behavior is observable.
  - **Validation:**
    - `npm test`
  - **Expected evidence:** T002 passes with exit code 0.

- [ ] T003 — Preserve neighbor three
  - **Scope:** `src/task-003.ts`
  - **Change:** Implement bounded behavior for T003.
  - **Covers:** RF-003
  - **Depends on:** none
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T003-01: The T003 fixture behavior is observable.
  - **Validation:**
    - `npm test`
  - **Expected evidence:** T003 passes with exit code 0.

- [ ] T004 — Repair target four
  - **Scope:** `src/task-004.ts`
  - **Change:** Implement bounded behavior for T004.
  - **Covers:** RF-004
  - **Depends on:** none
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T004-01: The T004 fixture behavior is observable.
  - **Validation:**
    - `npm test`
  - **Expected evidence:** T004 passes with exit code 0.

- [ ] T005 — Preserve neighbor five
  - **Scope:** `src/task-005.ts`
  - **Change:** Implement bounded behavior for T005.
  - **Covers:** RF-005
  - **Depends on:** none
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T005-01: The T005 fixture behavior is observable.
  - **Validation:**
    - `npm test`
  - **Expected evidence:** T005 passes with exit code 0.

- [ ] T006 — Preserve neighbor six
  - **Scope:** `src/task-006.ts`
  - **Change:** Implement bounded behavior for T006.
  - **Covers:** RF-006
  - **Depends on:** none
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T006-01: The T006 fixture behavior is observable.
  - **Validation:**
    - `npm test`
  - **Expected evidence:** T006 passes with exit code 0.

- [ ] T007 — Final task before phase two
  - **Scope:** `src/task-007.ts`
  - **Change:** Implement bounded behavior for T007.
  - **Covers:** RF-007
  - **Depends on:** none
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T007-01: The T007 fixture behavior is observable.
  - **Validation:**
    - `npm test`
  - **Expected evidence:** T007 passes with exit code 0.

## Phase 2: Preserve phase transitions

**Phase ID:** P02
**Goal:** Preserve the complete second-phase heading and context byte for byte.
**Depends on:** P01
**Context:**
- `.rb/init/ARCHITECTURE.md`
- `.rb/init/PLAN.md`

- [ ] T008 — First untouched task in phase two
  - **Scope:** `src/task-008.ts`
  - **Change:** Preserve the exact T008 checkbox and task block.
  - **Covers:** RF-008
  - **Depends on:** none
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T008-01: The T008 fixture behavior is observable.
  - **Validation:**
    - `npm test`
  - **Expected evidence:** T008 passes with exit code 0.

- [ ] T009 — Preserve neighbor nine
  - **Scope:** `src/task-009.ts`
  - **Change:** Implement bounded behavior for T009.
  - **Covers:** RF-009
  - **Depends on:** none
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T009-01: The T009 fixture behavior is observable.
  - **Validation:**
    - `npm test`
  - **Expected evidence:** T009 passes with exit code 0.

- [ ] T010 — Preserve neighbor ten
  - **Scope:** `src/task-010.ts`
  - **Change:** Implement bounded behavior for T010.
  - **Covers:** RF-010
  - **Depends on:** none
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T010-01: The T010 fixture behavior is observable.
  - **Validation:**
    - `npm test`
  - **Expected evidence:** T010 passes with exit code 0.

- [ ] T011 — Preserve neighbor eleven
  - **Scope:** `src/task-011.ts`
  - **Change:** Implement bounded behavior for T011.
  - **Covers:** RF-011
  - **Depends on:** none
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T011-01: The T011 fixture behavior is observable.
  - **Validation:**
    - `npm test`
  - **Expected evidence:** T011 passes with exit code 0.

- [ ] T012 — Repair target twelve
  - **Scope:** `src/task-012.ts`
  - **Change:** Implement bounded behavior for T012.
  - **Covers:** RF-012
  - **Depends on:** none
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T012-01: The T012 fixture behavior is observable.
  - **Validation:**
    - `npm test`
  - **Expected evidence:** T012 passes with exit code 0.

- [ ] T013 — Preserve neighbor thirteen
  - **Scope:** `src/task-013.ts`
  - **Change:** Implement bounded behavior for T013.
  - **Covers:** RF-013
  - **Depends on:** none
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T013-01: The T013 fixture behavior is observable.
  - **Validation:**
    - `npm test`
  - **Expected evidence:** T013 passes with exit code 0.

- [ ] T014 — Final task before phase three
  - **Scope:** `src/task-014.ts`
  - **Change:** Implement bounded behavior for T014.
  - **Covers:** RF-014
  - **Depends on:** none
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T014-01: The T014 fixture behavior is observable.
  - **Validation:**
    - `npm test`
  - **Expected evidence:** T014 passes with exit code 0.

## Phase 3: Prove immutable reconstruction

**Phase ID:** P03
**Goal:** Preserve untouched examples, context, and blank-line transitions.
**Depends on:** P02
**Context:**
- `.rb/init/SPEC.md`
- `.rb/init/OPERATIONS.json`

- [ ] T015 — Repair target fifteen
  - **Scope:** `src/task-015.ts`
  - **Change:** Implement bounded behavior for T015.
  - **Covers:** RF-015
  - **Depends on:** none
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T015-01: The T015 fixture behavior is observable.
  - **Validation:**
    - `npm test`
  - **Expected evidence:** T015 passes with exit code 0.

- [ ] T016 — Preserve neighbor sixteen
  - **Scope:** `src/task-016.ts`
  - **Change:** Implement bounded behavior for T016.
  - **Covers:** RF-016
  - **Depends on:** none
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T016-01: The T016 fixture behavior is observable.
  - **Validation:**
    - `npm test`
  - **Expected evidence:** T016 passes with exit code 0.

- [ ] T017 — Preserve neighbor seventeen
  - **Scope:** `src/task-017.ts`
  - **Change:** Implement bounded behavior for T017.
  - **Covers:** RF-017
  - **Depends on:** none
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T017-01: The T017 fixture behavior is observable.
  - **Validation:**
    - `npm test`
  - **Expected evidence:** T017 passes with exit code 0.

- [ ] T018 — Repair target eighteen
  - **Scope:** `src/task-018.ts`
  - **Change:** Implement bounded behavior for T018.
  - **Covers:** RF-018
  - **Depends on:** none
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T018-01: The T018 fixture behavior is observable.
  - **Validation:**
    - `npm test`
  - **Expected evidence:** T018 passes with exit code 0.

- [ ] T019 — Repair target nineteen
  - **Scope:** `src/task-019.ts`
  - **Change:** Implement bounded behavior for T019.
  - **Covers:** RF-019
  - **Depends on:** none
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T019-01: The T019 fixture behavior is observable.
  - **Validation:**
    - `npm test`
  - **Expected evidence:** T019 passes with exit code 0.

- [ ] T020 — Preserve untouched JSON example
  - **Scope:** `src/task-020.ts`
  - **Change:** Preserve this exact JSON example in the untouched task:
    ```json
    {"mode":"strict","regions":["task"],"preserveBlankLines":true}
    ```
  - **Covers:** RF-020
  - **Depends on:** none
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T020-01: The T020 fixture behavior is observable.
  - **Validation:**
    - `npm test`
  - **Expected evidence:** T020 and its JSON example remain byte-identical.

- [ ] T021 — Preserve final document task
  - **Scope:** `src/task-021.ts`
  - **Change:** Implement bounded behavior for T021.
  - **Covers:** RF-021
  - **Depends on:** none
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T021-01: The T021 fixture behavior is observable.
  - **Validation:**
    - `npm test`
  - **Expected evidence:** T021 passes with exit code 0.
