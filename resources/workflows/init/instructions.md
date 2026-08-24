---
name: rb-init
description: Initialize a new software project from free text, an @file reference, or an explicit --file prompt. Use when Codex must interview a developer efficiently, define project intent and capabilities without assuming a stack, and generate .rb/init documentation plus an rb-execution/v1 PHASES.md that works with direct LLM execution or RB Ralph. Do not use to reverse-engineer an existing implemented system; use rb-ai-context instead.
---

# RB Init

Create implementation-ready project documentation without application code.
Treat the user's prompt and confirmed answers as intent; never represent a
proposal as implemented fact.

## Required references

Read this file completely before producing artifacts:

- [Init artifact shapes](artifact-shapes.md)

## How your output is delivered

You do not write files and you do not run commands. Return every document as a
`path`/`content` pair in the document bundle envelope described in your prompt.
The orchestrator materializes the files, derives the manifest, IDs, hashes, and
statuses, runs every deterministic validator, and publishes atomically. The
exact output contract for this workflow — required documents, the
`rb-execution/v1` grammar, the `rb-operational/v1` shape, and the conventions —
is supplied in the prompt as `rb-harness-contract-digest/v1`.

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
6. Use the `.rb` staging tree initialized by the standalone orchestrator. The
   orchestrator owns initialization, manifest synchronization, and deterministic
   validation; do not depend on a plugin path.
7. Return the conditional artifacts defined in `artifact-shapes.md`. Preserve
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
   Normal phases own creation and structural validation of the operational
   contract; its clean-room pass is owned only by Ralph's post-phase RBF audit.
   Never make a preceding task depend on that future result.
9. The orchestrator runs every deterministic validator after your call; produce documents that already satisfy them, and never claim to have run a command. They cover `rb-execution/v1`, `rb-operational/v1`, the manifest, and
   the whole tree. Before returning, audit lossless requirement/cross-cutting traceability, explicit quality
   commands, validation capability (`command`, manager `manual`, or external
   `human`), exact standard/dialect matrices, hostile public-schema/secret cases
   when relevant, and every materially distinct documented configuration mode.
10. State readiness, assumptions, unresolved questions, and phase/task counts in
    the bundle summary. Never produce application code, run a command, or
    commit.

These resources are loaded by the standalone executable. Generated documents
must not depend on the location of this resource tree or any plugin host.

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
