---
name: rb-plan
description: Plan a feature, bug fix, refactor, migration, performance change, contract change, dependency update, or technical-debt item from free text or a referenced file. Use when Codex must ground a change in .rb/init or .rb/context, inspect the affected code slice, run a short risk-based interview, and generate REQUEST.md, SPEC.md, PLAN.md, optional formal contracts, and a validated rb-execution/v1 PHASES.md without implementing application code.
---

# RB Plan

Turn a scoped change into evidence-grounded, provider-neutral documentation.
Do not implement the change.

## Required references

Read these files completely before writing artifacts:

- [Interview policy](../../references/interview-policy.md)
- [Artifact conventions](../../references/artifact-conventions.md)
- [Execution template](../../references/execution-template.md)
- [Operational acceptance template](../../references/operational-template.md)
- [Plan artifact shapes](references/plan-artifacts.md)

## Workflow

1. Resolve free text, `@file`, or `--file` input. Hash source files.
2. Detect request type: feature, bug, refactor, migration, performance,
   contract, dependency, or debt. Do not force feature terminology on fixes.
3. Load `.rb/rb-manifest.json`, relevant init/context documents, and source
   hashes. Inspect the affected code and tests directly; context docs may be
   stale and are navigation, not proof.
4. Normalize objective, observed/current behavior, expected behavior, scope,
   non-goals, constraints, preliminary acceptance criteria, and risk.
5. Run an internal adversarial clarification pass before involving the user:
   verify technical literals, compare request with architecture/domain rules,
   find contradictions, merge duplicate questions, and rank by rework risk.
6. Interview using the shared policy and the request-specific prompts in
   `plan-artifacts.md`. Non-blocking unknowns become explicit assumptions;
   blocking decisions yield `BLOCKED` rather than invented requirements.
7. Confirm 1 concise normalized request checkpoint.
8. Write `.rb/features/<slug>/REQUEST.md`, `SPEC.md`, `PLAN.md`, conditional
   formal contracts, source manifest, and `PHASES.md`. Also write
   `OPERATIONS.json` using `rb-operational/v1` when an honest executable
   consumer scenario can be grounded. The scenario must validate the actual
   product form and claimed platforms (desktop, CLI, library, service, web, or
   otherwise), not a presumed HTTP boundary. Reuse verified project-level
   operations where valid and specialize only what this change affects.
9. Trace every RIGID requirement to acceptance criteria and tasks. Verify every
   code-shaped literal in RIGID against code/config or mark it unresolved.
10. Derive phases from a dependency DAG. `Parallel safe` is descriptive; no
    executor or provider is required to parallelize.
11. Run, fix, and repeat until green:
    - `contract validate .rb/features/<slug>/PHASES.md`
    - `operations validate .rb/features/<slug>/OPERATIONS.json` when emitted
    - `manifest sync .`
    - `tree validate .`
12. Report readiness, artifact paths, requirements/tasks/phases, assumptions,
    risks, contracts, and validation. Never edit application code or commit.

Resolve `<plugin-root>` as 2 directories above this skill directory. Pass the
project root explicitly to CLI commands when the current directory differs.

## Context fallback

If neither init nor context documentation exists, inspect enough to explain the
gap and recommend `rb-init` for greenfield or `rb-ai-context` for implemented
systems. Proceed only when the request can still be grounded safely.
