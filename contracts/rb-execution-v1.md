# RB Execution Contract v1

`rb-execution/v1` defines the Markdown document accepted by RB Ralph and usable
as a direct prompt for any capable coding LLM.

## Document grammar

1. The first non-empty line is `# RB Execution Plan: <name>`.
2. Before the first phase, include exactly one marker:
   `<!-- rb-execution-contract: rb-execution/v1 -->`.
3. Before the first phase, include exactly one artifact marker:
   `<!-- rb-artifact-id: <stable-id> -->`.
4. The only level-2 headings are contiguous phases matching
   `## Phase N: <title>`, starting at 1.
5. Every phase contains `Phase ID`, `Goal`, `Depends on`, and `Context`.
6. Every phase contains at least one task matching
   `- [ ] TNNN — <title>` or `- [x] TNNN — <title>`.
7. Task IDs are globally unique and appear in ascending order.
8. Every task contains `Scope`, `Change`, `Covers`, `Depends on`,
   `Parallel safe`, `Acceptance criteria`, `Validation`, and
   `Expected evidence`.
9. Each task has at least one acceptance criterion identified as
   `AC-TNNN-NN` and at least one validation entry.
10. Dependencies refer only to earlier phase/task IDs or `none`.
11. Each validation is either one non-interactive shell command enclosed in
    backticks or `manual: <inspection>`. Validation commands are reviewed input
    and must verify behavior without destructive project or external-state
    changes.

## Execution neutrality

The document may describe dependencies and whether work is parallel-safe. It
must not require a provider, model, CLI, commit strategy, branch strategy,
agent topology, or RB Ralph itself.

## Minimal example

```markdown
# RB Execution Plan: example

<!-- rb-execution-contract: rb-execution/v1 -->
<!-- rb-artifact-id: feature-example-execution -->

## Phase 1: Implement the example

**Phase ID:** P01
**Goal:** Implement the requested observable behavior.
**Depends on:** none
**Context:**
- `.rb/features/example/SPEC.md`
- `.rb/features/example/PLAN.md`

- [ ] T001 — Implement behavior
  - **Scope:** `src/`, `tests/`
  - **Change:** Implement RF-001 without changing unrelated behavior.
  - **Covers:** RF-001
  - **Depends on:** none
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T001-01: The documented behavior is observable through the public interface.
  - **Validation:**
    - `npm test`
  - **Expected evidence:** Changed source, regression tests, and passing validation output.
```

## Compatibility

Consumers must reject unknown major versions before starting an LLM. Additive
minor revisions may only introduce optional fields. Breaking grammar changes
require a new major contract and migration tooling.
