---
name: rb-evolve
description: Plan a safe change to established product behavior by proving the AS IS flow, defining the TO BE delta, mapping impact and readers/writers, preserving unaffected behavior, and covering migration and regressions before producing an RB Ralph-compatible plan. Use when a request changes an existing feature or cross-module workflow even if described as a new feature. Never implements code; use rb-plan for isolated new behavior with no established-flow impact and rb-review for open-ended whole-product auditing.
---

# RB Evolve

Change established behavior without erasing implicit contracts. Treat current
code and tests as evidence, generated context as navigation, and accepted user
answers as intent.

## Artifact authority

The orchestrator injects the canonical machine-owned artifact definition into
the generation prompt. That definition owns required names, paths, readiness,
and code/model ownership.

## How your output is delivered

You do not write files and you do not run commands. During the planning call,
return only the compact document plan requested by the stage prompt, without
document content. During each later closed authoring call, return only the
requested raw document segment. Never emit a complete document bundle unless
the stage prompt explicitly requests the legacy compatibility form. The
orchestrator checkpoints and assembles parts, materializes files, derives the
manifest, IDs, hashes and statuses, runs deterministic validators, and publishes
atomically. The
exact output contract for this workflow — required documents, the
`rb-execution/v1` grammar, the `rb-operational/v1` shape, and the conventions —
is supplied in the prompt as `rb-harness-contract-digest/v1`.

## Routing rule

Use this workflow when the requested result changes an established journey,
state transition, domain rule, stored data shape, permission boundary, public
contract, integration, report, or downstream consumer. Route by impact rather
than by the label "new feature". Use `rb-harness plan` only when the work is genuinely
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
   The interview is adaptive: keep returning focused questions while any
   material ambiguity remains, including one an earlier answer just opened,
   and stop the moment nothing material is open. Never re-ask a decision that
   was already answered and accepted.
8. Run the pre-write ambiguity audit and confirm one normalized checkpoint that
   separates accepted delta, preservation rules, assumptions, deferrals, and
   conflicts.
9. Return the artifacts from the injected canonical artifact authority. Every TO BE RIGID requirement
   traces to an impact, preservation/regression entry, and plan task. Emit formal
   contracts only when the public boundary requires them.
10. Derive the authority's decomposition and executable readiness artifacts 1:1. Tasks are small enough for a fresh,
    context-free executor call, dependency-aware,
    name the AS IS/TO BE delta, preserve legitimate behavior, and own focused
    binary validation. The decomposition ceilings in the contract digest are
    validated mechanically, so respect them while writing. Derive the authority's conditional operational artifact when an honest consumer-level
    scenario can validate the evolution and its key preserved path. Harness
    generation owns its structure; `.rb` and descendants never belong in task
    Scope/Change. Only the post-phase RBF audit owns the clean-room pass. Audit exact standard/dialect matrices, independent hostile
    schema/secret cases, explicit quality commands, validation capability, and
    lossless RIGID/preservation/regression traceability before returning.
    For a visual/UI delta or preserved visual path, require the digest's durable
    viewport/screenshot/geometry contract and a negative corruption regression.
    Use grounded browser automation or `human:`; never use `manual:` or
    presence-only/fake-DOM checks as proof of visibility. Preserve before/after
    evidence whenever interaction changes visible state.
11. The orchestrator runs every deterministic validator after assembly; produce document parts that assemble into compliant artifacts, and never claim to have run a command. They cover `rb-execution/v1`, `rb-operational/v1`, the manifest, and
    the whole tree.
12. State freshness, changed/preserved/deprecated/unknown counts, impact and
    regression coverage, assumptions, and blockers in the bundle summary.
    Never edit application code, run a command, or commit.

These resources are loaded by the standalone executable. Generated documents
must not depend on the location of this resource tree or any plugin host.
