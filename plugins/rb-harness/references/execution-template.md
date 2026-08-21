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
Acceptance criteria must state the observable result directly. A criterion that
only says a task satisfies, implements, or matches an RF/RNF/UI/CT ID is
circular and invalid, as is an undefined qualifier such as "appropriately" or
"when possible".

`Parallel safe: true` means the task has no dependency on another pending task
and owns disjoint paths, interfaces, migrations, generated artifacts, shared
state, and validation surfaces. If independence cannot be demonstrated, write
`false`. Never encode the number of agents in PHASES; RB Ralph bounds concurrency
at execution time and must isolate parallel task work before integration.
