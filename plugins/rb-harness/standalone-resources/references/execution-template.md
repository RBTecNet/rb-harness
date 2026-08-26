# Execution Document Template

> Reference material for maintainers.
> The exact `rb-execution/v1` grammar the provider receives is code-owned by `rb-harness-contract-digest/v1` (see `packages/core/src/harness-contract-digest.ts`) and enforced by `packages/core/src/execution-contract.ts`. This document explains the reasoning behind the grammar and is no longer injected into a prompt.

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

Every criterion must map to an observable validation entry. Cross-check the
task Change, Covers IDs, acceptance criteria, declared project scripts, and
quality requirements before emitting the plan. If lint, test, typecheck,
format, build, migration, packaging, or another gate is promised, name its
verified command separately and require its real exit status. Do not hide
several gates in prose or append `|| true`, `; true`, or another construct that
masks failure. An empty or absent test suite is acceptable only when the phase
explicitly explains why no behavior requires tests yet.

`Scope` is execution authority and validation-impact metadata. List only
concrete project-relative files, directories, or bounded globs, each enclosed
in backticks; do not use prose such as "the whole feature", "as needed", or an
unbounded repository-wide claim. Include every source, test, configuration,
migration, generated, and documentation path the task may change. If a shared
path makes two tasks interfere, they are not parallel-safe. Ralph may reuse a
previous successful command on retry only when every changed path is covered by
these declared scopes; an ambiguous or uncovered path forces full validation.

Prefer the smallest existing deterministic command that proves the task and
its affected boundaries. Add a broader integration or project suite only when
the focused command cannot prove cross-boundary behavior. It is valid for
several tasks to name the same genuinely shared command—Ralph deduplicates
identical commands and records all owning task IDs—but do not repeat a command
merely to make both executor and manager run it. Ralph owns command execution;
the manager consumes its canonical result.

Use `manual: <inspection>` only for a precise observation the technical manager
can make from repository or produced evidence. Use `human: <external evidence>`
for a device, credentialed environment, subjective visual decision, or other
observation unavailable to both executor and manager; RB Ralph pauses instead
of retrying it. Never write `manual: run/execute/test ...`: declare the exact
command, provision the required tool, or report the plan as blocked. Never
invent a command. A phase is self-contained for a fresh session through its
goal, context paths, tasks, criteria, and validations.

Visual acceptance has a stricter proof boundary. Criteria containing concepts
such as visible, rendered, visual, layout, aligned, responsive, viewport,
screen/tela, or animation must use a one-shot real browser/visual command, or
`human:` so execution pauses as `HUMAN_PENDING` when honest automation is not
available. `manual:`, selector presence, a fake DOM, syntax checks, and generic
unit tests do not prove rendered visibility. Every visual task must also:

- include a negative acceptance criterion for representative corruption such
  as essential elements hidden, clipped, overlapping, outside the viewport,
  zero-area, or source CSS/JavaScript exposed as content;
- name in Expected evidence a durable screenshot artifact, an exact numeric
  viewport such as `1440x900`, and geometry/computed-style measurements;
- preserve initial/before and resulting/after screenshots or measurements when
  keyboard, pointer, transition, or animation changes visible state.

These are evidence requirements, not permission to invent a product viewport
or frontend stack. Use a supported representative viewport as a validation
parameter and the project's existing browser tooling; otherwise emit `human:`.
Acceptance criteria must state the observable result directly. A criterion that
only says a task satisfies, implements, or matches an RF/RNF/UI/CT ID is
circular and invalid, as is an undefined qualifier such as "appropriately" or
"when possible".

## Traceability and contract audit

Before validation, perform a lossless audit from every source requirement in
`Covers` to task Change, phase criterion, validation, and expected evidence.
Propagate relevant cross-cutting rules—such as locale, accessibility,
confidentiality, authorization, tenancy, observability, compatibility, and
failure behavior—to every affected public boundary and state. Stateful UI
requirements must state initial/default selection, disabled actions and reason,
and the exact condition that enables them again when those distinctions matter.

When behavior follows an external standard, protocol, grammar, file format, or
dialect, name the exact version or authoritative baseline. Replace phrases such
as "where valid" with an exhaustive machine-checkable matrix: fields and order,
ranges, aliases, operators and operands, bounds, allowed combinations,
cross-field rules, and invalid cases as applicable. Convert matrix rows or
equivalence classes into deterministic positive and negative tests. Include
whole-input consumption and literal-preservation cases so a valid prefix with
ignored trailing text cannot pass.

For public schemas and secret-bearing integrations, add independent hostile
fixtures when relevant: mixed mutually exclusive variants, unknown fields,
malformed/nested errors, provider/transport failures, and a unique sentinel
passed through every configured secret/input channel. Exact configured secret
values must be absent from public responses, logs, evidence, and error chains;
regex redaction is only defense in depth.

The Harness owns creation and deterministic validation of `OPERATIONS.json`.
No implementation task may include `.rb`, `.rb/**`, or any generated planning
artifact in `Scope` or `Change`; those files are immutable execution authority.
Tasks may read them through `Context` and invoke read-only validators. Clean-room
execution is the post-phase operational audit (`RBF`) and therefore cannot be
an acceptance dependency of a preceding task.

## Task granularity

The consumer runs one ephemeral, context-free call per task: the executor sees
the validated task extract and the repository, never the planning conversation
or the other tasks' reasoning. A task carrying a whole feature therefore has to
be re-derived from nothing inside a single window, which is where an executor
drops a requirement or invents one.

Decompose every capability into the smallest independently observable steps, and
split along boundaries the code already has — contract before use, storage
before behavior, behavior before interface, happy path before each error path —
ordering them with `Depends on` instead of merging them. Never write a task such
as "implement the X feature" or "wire everything together". More small tasks is
the correct outcome; it costs no completeness, because every requirement must
still be covered by some task.

`packages/core/src/harness-granularity.ts` enforces this deterministically from
what the document itself declares — covered requirement IDs, acceptance
criteria, scope tokens, and task counts per phase — against the ceilings in
`HARNESS_BUDGET.decomposition`. A violation is a repairable structural error
before publication and a blocker in `rb-harness artifacts verify`.

`Parallel safe: true` means the task has no dependency on another pending task
and owns disjoint paths, interfaces, migrations, generated artifacts, shared
state, and validation surfaces. If independence cannot be demonstrated, write
`false`. Never encode the number of agents in PHASES; RB Ralph bounds concurrency
at execution time and must isolate parallel task work before integration.
