# Execution Document Template

Emit only when readiness is `READY` or `READY_WITH_ASSUMPTIONS`. Copy this
grammar exactly and expand it; do not add other level-2 headings.

```markdown
# RB Execution Plan: <slug>

<!-- rb-execution-contract: rb-execution/v1 -->
<!-- rb-artifact-id: <stable-artifact-id> -->

## Phase 1: <title>

**Phase ID:** P01
**Goal:** <observable phase outcome>
**Depends on:** none
**Context:**
- `.rb/<path>/SPEC.md`
- `.rb/<path>/PLAN.md`

- [ ] T001 — <task title>
  - **Scope:** `path/`, `path/file.ext`
  - **Change:** <complete bounded change>
  - **Covers:** RF-001
  - **Depends on:** none
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T001-01: <binary observable criterion>
  - **Validation:**
    - `<verified project command>`
  - **Expected evidence:** <files, tests, command output, or inspection evidence>
```

Use `manual: <inspection>` only when no deterministic command can validate the
criterion. Never invent a command. A phase is self-contained for a fresh
session through its goal, context paths, tasks, criteria, and validations.
