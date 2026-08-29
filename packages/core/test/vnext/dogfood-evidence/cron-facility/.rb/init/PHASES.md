# RB Execution Plan: cron-explicado

<!-- rb-execution-contract: rb-execution/v1 -->
<!-- rb-artifact-id: cron-explicado-execution -->

## Phase 1: Project skeleton

**Phase ID:** P01
**Goal:** Set up a fully client-side Vite + React + TypeScript app with quality commands wired.
**Depends on:** none
**Context:**
- `.rb/init/BRIEF.md`

- [ ] T001 — Scaffold Vite React TS app
  - **Scope:** `eslint.config.js`, `index.html`, `package.json`, `src/App.tsx`, `src/main.tsx`, `tsconfig.json`, `vite.config.ts`
  - **Change:** Create the Vite React TypeScript project skeleton with test, build, lint and typecheck scripts.
  - **Covers:** R-006
  - **Depends on:** none
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T001-01: The app builds and serves a placeholder page entirely client-side with no network calls.
    - AC-T001-02: All four quality command scripts exist and run successfully.
  - **Validation:**
    - `npm run build`
    - `npm run lint`
    - `npm run typecheck`
    - `npm test -- --run`
  - **Expected evidence:** Build, lint, typecheck and test commands complete without errors on the fresh skeleton.

## Phase 2: Deterministic cron engine

**Phase ID:** P02
**Goal:** Implement parsing, validation, explanation, next-run computation and PT-BR generation as pure local modules.
**Depends on:** P01
**Context:**
- `.rb/init/BRIEF.md`

- [ ] T002 — Cron parser and validator
  - **Scope:** `src/cron/parse.test.ts`, `src/cron/parse.ts`
  - **Change:** Implement a pure parser for five-field cron lines and special @strings that returns structured fields or a field-scoped error.
  - **Covers:** R-002, R-004
  - **Depends on:** T001
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T002-01: Numbers, ranges, lists, steps, wildcards and month/weekday names parse into structured field values.
    - AC-T002-02: @reboot/@daily/@hourly/@weekly/@monthly/@yearly parse to their equivalent schedules.
    - AC-T002-03: Invalid input returns an error naming the offending field.
  - **Validation:**
    - `npm test -- --run`
  - **Expected evidence:** Unit tests covering valid and invalid cron lines pass.

- [ ] T003 — PT-BR explanation of a parsed line
  - **Scope:** `src/cron/explain.test.ts`, `src/cron/explain.ts`
  - **Change:** Implement a function turning a parsed cron line into Brazilian Portuguese descriptions of each time field and the command.
  - **Covers:** R-001
  - **Depends on:** T002
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T003-01: Each of the five time fields plus the command yields a distinct Brazilian Portuguese description.
    - AC-T003-02: Explanation text contains no English terms.
  - **Validation:**
    - `npm test -- --run`
  - **Expected evidence:** Tests assert expected PT-BR strings for representative cron lines.

- [ ] T004 — Next execution times
  - **Scope:** `src/cron/nextRuns.test.ts`, `src/cron/nextRuns.ts`
  - **Change:** Implement local computation of the next few execution times for a parsed schedule in the browser timezone.
  - **Covers:** R-005
  - **Depends on:** T002
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T004-01: Given a valid expression and a reference date, the next five run times are returned in chronological order.
    - AC-T004-02: @reboot returns an explicit 'no scheduled time' result instead of dates.
  - **Validation:**
    - `npm test -- --run`
  - **Expected evidence:** Tests assert exact next-run timestamps from a fixed reference date.

- [ ] T005 — PT-BR request to cron expression
  - **Scope:** `src/cron/generate.test.ts`, `src/cron/generate.ts`, `src/cron/patterns.md`
  - **Change:** Implement rule-based translation of documented Brazilian Portuguese schedule phrases into cron expressions with a 'nao entendi' fallback.
  - **Covers:** R-003
  - **Depends on:** T002
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T005-01: Every documented pattern (every N minutes/hours, daily at a time, weekdays, monthly day, reboot) produces a valid cron expression.
    - AC-T005-02: Unrecognized phrases return the friendly 'nao entendi' result.
  - **Validation:**
    - `npm test -- --run`
    - manual: Confirm src/cron/patterns.md lists each supported PT-BR pattern.
  - **Expected evidence:** Tests pass for each documented pattern plus an unrecognized phrase.

## Phase 3: Local UI

**Phase ID:** P03
**Goal:** Expose explanation and generation flows in a read-only browser interface.
**Depends on:** P02
**Context:**
- `.rb/init/BRIEF.md`

- [ ] T006 — Explain panel
  - **Scope:** `src/ui/ExplainPanel.test.tsx`, `src/ui/ExplainPanel.tsx`
  - **Change:** Add a UI panel where a pasted crontab line shows its PT-BR explanation, errors, and next runs with the timezone displayed.
  - **Covers:** R-001, R-002, R-005, R-006
  - **Depends on:** T003, T004
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T006-01: A valid pasted line renders per-field PT-BR explanation and the next runs list.
    - AC-T006-02: An invalid line renders the field-scoped PT-BR error and no explanation.
    - AC-T006-03: The browser timezone is shown next to the next-runs list.
  - **Validation:**
    - `npm test -- --run`
    - manual: Inspect the panel source to confirm no shell, install, or file-write action exists.
  - **Expected evidence:** Component tests render valid and invalid line states as specified.

- [ ] T007 — Generate panel with copy
  - **Scope:** `src/ui/GeneratePanel.test.tsx`, `src/ui/GeneratePanel.tsx`
  - **Change:** Add a UI panel where a PT-BR request yields a copyable cron line with its explanation.
  - **Covers:** R-003, R-006, R-007
  - **Depends on:** T003, T005
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T007-01: A supported PT-BR request renders a cron expression plus its explanation.
    - AC-T007-02: The generated line is selectable and a copy control places it on the clipboard.
    - AC-T007-03: An unsupported request renders the 'nao entendi' message.
  - **Validation:**
    - `npm test -- --run`
    - human: Confirm in a browser that the copy control puts the cron line on the clipboard.
  - **Expected evidence:** Component tests cover supported and unsupported requests and the copy control.

- [ ] T008 — Assemble app shell
  - **Scope:** `README.md`, `src/App.tsx`
  - **Change:** Wire both panels into the app shell and state the app never runs or installs anything.
  - **Covers:** R-001, R-003, R-006
  - **Depends on:** T006, T007
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T008-01: Both panels are reachable from the single-page app.
    - AC-T008-02: The UI and README state that nothing is executed, installed, or written.
  - **Validation:**
    - `npm run build`
    - `npm run lint`
    - `npm run typecheck`
    - manual: Read README.md to confirm the no-side-effects statement and local-only usage instructions.
  - **Expected evidence:** Production build succeeds and README documents local-only, no-execution behavior.
