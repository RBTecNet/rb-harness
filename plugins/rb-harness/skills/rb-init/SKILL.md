---
name: rb-init
description: Initialize a new software project from free text, an @file reference, or an explicit --file prompt. Use when Codex must interview a developer efficiently, define project intent and capabilities without assuming a stack, and generate .rb/init documentation plus an rb-execution/v1 PHASES.md that works with direct LLM execution or RB Ralph. Do not use to reverse-engineer an existing implemented system; use rb-ai-context instead.
---

# RB Init

Create implementation-ready project documentation without application code.
Treat the user's prompt and confirmed answers as intent; never represent a
proposal as implemented fact.

## Required references

Read these files completely before writing artifacts:

- [Interview policy](../../references/interview-policy.md)
- [Artifact conventions](../../references/artifact-conventions.md)
- [Execution template](../../references/execution-template.md)
- [Operational acceptance template](../../references/operational-template.md)
- [Init artifact shapes](references/init-artifacts.md)

## Workflow

1. Resolve input:
   - `@path` or `--file path`: read that file completely and hash it.
   - Existing bare path: treat as a file and tell the user.
   - Other non-empty input: treat as the project description.
   - Empty input: ask 1 open question for the idea.
2. Inspect existing non-secret files before asking. A greenfield directory may
   already contain designs, ADRs, contracts, manifests, or a boilerplate.
3. Normalize the project name, objective, actors, MVP boundary, constraints,
   workflows, and initial acceptance criteria. Classify capabilities instead of
   assuming API, UI, database, auth, queue, or deployment needs.
4. Build a gap map and interview using the shared policy. Ask only questions
   whose answers materially change scope, observable behavior, contracts,
   security, data, or architecture. Apply the answer acceptance gate; follow up
   on material partial or ambiguous responses rather than inventing a precise
   requirement from them.
5. Run the pre-write ambiguity audit, then present a concise normalized summary
   and corrections in 1 checkpoint. Separate accepted decisions, assumptions,
   deferred choices, and unresolved ambiguity.
6. Initialize the artifact tree with the bundled CLI if it is absent:
   `node <plugin-root>/scripts/rb-harness.cjs project init <target> --name <name>`.
7. Write the conditional artifacts defined in `init-artifacts.md`. Preserve
   stable IDs and confirmed manual edits on re-runs; update only impacted
   sections and source hashes. Only `ACCEPTED` responses become confirmed
   intent; unresolved material meaning stays out of RIGID requirements.
8. Derive `PLAN.md`, then derive `PHASES.md` 1:1. `PHASES.md` must not introduce
   requirements or implementation choices absent from the richer artifacts.
   Also derive `.rb/init/OPERATIONS.json` from the confirmed product form,
   claimed platforms, and primary consumer workflow. It must use
   `rb-operational/v1`, remain usable without RB Ralph, and must not assume web
   or any stack. If no honest executable scenario can be defined, omit it and
   record the blocking operational gap instead of inventing proof.
9. Run, fix, and repeat until green:
   - `contract validate .rb/init/PHASES.md`
   - `operations validate .rb/init/OPERATIONS.json` when emitted
   - `manifest sync .`
   - `tree validate .`
10. Report paths, readiness, answer dispositions, assumptions, unresolved
    questions, phase/task counts, and validation results. Never write
    application code or commit.

Resolve `<plugin-root>` as 2 directories above this skill directory. Pass the
project root explicitly to CLI commands when the current directory differs.

## Stack decisions

Detect a declared or bootstrapped stack. If none exists, derive constraints,
offer a recommendation with tradeoffs, and request confirmation only when the
choice is necessary to make the plan executable. Keep unneeded implementation
choices FLEXIBLE.

## Readiness

- `READY`: no blocking unknowns and the contract validates.
- `READY_WITH_ASSUMPTIONS`: only explicit, low-risk assumptions remain.
- `BLOCKED`: a missing decision would make execution unsafe or ambiguous. Do
  not emit a ready execution plan for blocked work.
