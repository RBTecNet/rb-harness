---
name: rb-evolve
description: Plan a safe change to established product behavior by proving the AS IS flow, defining the TO BE delta, mapping impact and readers/writers, preserving unaffected behavior, and covering migration and regressions before producing an RB Ralph-compatible plan. Use when a request changes an existing feature or cross-module workflow even if described as a new feature. Never implements code; use rb-plan for isolated new behavior with no established-flow impact and rb-review for open-ended whole-product auditing.
---

# RB Evolve

Change established behavior without erasing implicit contracts. Treat current
code and tests as evidence, generated context as navigation, and accepted user
answers as intent.

## Required references

Read these files completely before writing artifacts:

- [Interview policy](../../references/interview-policy.md)
- [Artifact conventions](../../references/artifact-conventions.md)
- [Execution template](../../references/execution-template.md)
- [Operational acceptance template](../../references/operational-template.md)
- [Evolution artifact shapes](references/evolve-artifacts.md)

## Routing rule

Use this workflow when the requested result changes an established journey,
state transition, domain rule, stored data shape, permission boundary, public
contract, integration, report, or downstream consumer. Route by impact rather
than by the label "new feature". Use `rb-plan` only when the work is genuinely
isolated from existing behavior.

## Workflow

1. Resolve free text, `@file`, or `--file` input and hash sources. Load the RB
   manifest and relevant context, but verify its source hashes and inspect the
   affected code/tests directly. Refresh only the stale evidence slice.
2. Locate the current capability end to end: actors, UI, domain rules,
   permissions, tenant boundaries, data, APIs, events, reports, jobs,
   integrations, operations, and tests. Map every material reader, writer, and
   reactor for affected state.
3. Document the evidence-grounded `AS IS` before normalizing `TO BE`. Distinguish
   behavior that is intentional, accidental legacy, contradictory, or unknown.
4. Build the delta and preservation matrix: `CHANGE`, `PRESERVE`, `DEPRECATE`,
   and `UNKNOWN`. A behavior not explicitly changed is preserved by default.
5. Model state transitions and side effects when lifecycles exist. Analyze
   compatibility, old records, backfill, temporary nullability, coexistence,
   rollback, public contracts, concurrency, idempotency, and cross-tenant risk.
6. Run an internal impact/adversarial pass. Trace indirect consumers and reject
   opportunistic refactors outside the requested delta.
7. Interview only material gaps using the shared answer acceptance gate. Deepen
   automatically for money, inventory, security, tenancy, migrations, public
   contracts, reservations, queues, or approval workflows.
8. Run the pre-write ambiguity audit and confirm one normalized checkpoint that
   separates accepted delta, preservation rules, assumptions, deferrals, and
   conflicts.
9. Write the artifacts from `evolve-artifacts.md`. Every TO BE RIGID requirement
   traces to an impact, preservation/regression entry, and plan task. Emit formal
   contracts only when the public boundary requires them.
10. Derive `PLAN.md` and a 1:1 `PHASES.md`. Tasks are small, dependency-aware,
    name the AS IS/TO BE delta, preserve legitimate behavior, and own focused
    binary validation. Derive `OPERATIONS.json` when an honest consumer-level
    scenario can validate the evolution and its key preserved path.
11. Run, fix, and repeat until green:
    - `contract validate .rb/evolutions/<slug>/PHASES.md`
    - `operations validate .rb/evolutions/<slug>/OPERATIONS.json` when emitted
    - `manifest sync .`
    - `tree validate .`
12. Report freshness, changed/preserved/deprecated/unknown counts, impact and
    regression coverage, assumptions, blockers, artifact paths, and validation.
    Never edit application code or commit.

Resolve `<plugin-root>` as 2 directories above this skill directory. Pass the
project root explicitly when it differs from the current directory.
