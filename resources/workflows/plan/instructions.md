---
name: rb-plan
description: Plan a feature, bug fix, refactor, migration, performance change, contract change, dependency update, or technical-debt item from free text or a referenced file. Use when Codex must ground a change in .rb/init or .rb/context, inspect the affected code slice, run a short risk-based interview, and generate REQUEST.md, SPEC.md, PLAN.md, optional formal contracts, and a validated rb-execution/v1 PHASES.md without implementing application code.
---

# RB Plan

Turn a scoped change into evidence-grounded, provider-neutral documentation.
Do not implement the change.

## Required references

Read this file completely before producing artifacts:

- [Plan artifact shapes](artifact-shapes.md)

## How your output is delivered

You do not write files and you do not run commands. Return every document as a
`path`/`content` pair in the document bundle envelope described in your prompt.
The orchestrator materializes the files, derives the manifest, IDs, hashes, and
statuses, runs every deterministic validator, and publishes atomically. The
exact output contract for this workflow — required documents, the
`rb-execution/v1` grammar, the `rb-operational/v1` shape, and the conventions —
is supplied in the prompt as `rb-harness-contract-digest/v1`.

## Workflow

1. Resolve free text, `@file`, or `--file` input. Hash source files.
2. Detect request type: feature, bug, refactor, migration, performance,
   contract, dependency, or debt. Do not force feature terminology on fixes. If
   the request changes an established journey, state transition, stored shape,
   permission boundary, public contract, or downstream consumer, route to
   `rb-evolve` even when the developer calls it a new feature.
3. Load `.rb/rb-manifest.json`, relevant init/context documents, and source
   hashes. Inspect the affected code and tests directly; context docs may be
   stale and are navigation, not proof.
4. Normalize objective, observed/current behavior, expected behavior, scope,
   non-goals, constraints, preliminary acceptance criteria, and risk.
5. Run an internal adversarial clarification pass before involving the user:
   verify technical literals, compare request with architecture/domain rules,
   find contradictions, merge duplicate questions, and rank by rework risk.
6. Interview using the shared policy and the request-specific prompts in
   `artifact-shapes.md`. Apply the answer acceptance gate and re-ask material
   partial or ambiguous responses narrowly. Only low-risk unknowns may become
   explicit assumptions; blocking decisions yield `BLOCKED` rather than
   invented requirements.
7. Run the pre-write ambiguity audit, then confirm 1 concise normalized request
   checkpoint that separates accepted decisions, assumptions, deferrals, and
   unresolved conflicts.
8. Return `.rb/features/<slug>/REQUEST.md`, `SPEC.md`, `PLAN.md`, conditional
   formal contracts, source manifest, and `PHASES.md`. Also return
   `OPERATIONS.json` using `rb-operational/v1` when an honest executable
   consumer scenario can be grounded. The scenario must validate the actual
   product form and claimed platforms (desktop, CLI, library, service, web, or
   otherwise), not a presumed HTTP boundary. Reuse verified project-level
   operations only when their exact contract and configuration mode still
   apply, and specialize only what this change affects. Normal phases may
   validate the contract structure but cannot require its future RBF clean-room
   result.
9. Trace every RIGID requirement to acceptance criteria and tasks. Verify every
   code-shaped literal in RIGID against code/config or mark it unresolved.
   Trace further to one observable validation and expected evidence. Audit
   cross-cutting rules at every affected public state, name promised quality
   commands separately, classify unavailable proof as external `human`
   evidence, and require exact standard/dialect matrices plus hostile
   schema/secret cases when relevant.
10. Derive phases from a dependency DAG. `Parallel safe` is descriptive; no
    executor or provider is required to parallelize.
11. The orchestrator runs every deterministic validator after your call; produce documents that already satisfy them, and never claim to have run a command. They cover `rb-execution/v1`, `rb-operational/v1`, the
    manifest, and the whole tree.
12. State readiness, requirements, tasks, and phases in the bundle summary.
    Never edit application code, run a command, or commit.

These resources are loaded by the standalone executable. Generated documents
must not depend on the location of this resource tree or any plugin host.

## Context fallback

If neither init nor context documentation exists, inspect enough to explain the
gap and recommend `rb-harness init` for greenfield or `rb-harness ai-context` for implemented
systems. Proceed only when the request can still be grounded safely.
