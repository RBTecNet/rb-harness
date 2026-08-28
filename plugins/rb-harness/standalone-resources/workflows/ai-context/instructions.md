---
name: rb-ai-context
description: Reverse-engineer an existing or legacy software project into grounded AS IS context. Discover architecture, domain vocabulary and rules, workflows, permissions, interfaces, data, integrations, operations, and quality commands from code and tests, then ask a short adaptive interview only for material knowledge absent or contradictory in the repository. Writes a portable context index and conditional .rb/context artifacts; never plans a change or treats intent documents as implemented fact.
---

# RB AI Context

Document implemented reality with evidence and calibrated confidence. Never use
`.rb/init`, `.rb/features`, `.spec`, or old generated context as proof of current
behavior.

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

## Workflow

1. Resolve the target. Never read `.env`, credentials, private keys, dependency
   trees, build outputs, Git internals, intent specs, or generated context as
   evidence.
2. The orchestrator supplies a bounded inventory of the target project and
   owns the `.rb` staging tree.
3. Inspect the target project through your read tools and build a bounded,
   secret-safe evidence inventory before deeper inspection. Never depend on a
   plugin path; the orchestrator owns manifest synchronization and
   deterministic validation.
4. Inspect manifests, CI, configs, tests, entrypoints, and only then the domain
   slices needed to confirm signals. Prefer tests for observable rules and code
   for actual paths; cite both when they disagree.
5. Classify every material statement as `OBSERVED`, `CONFIRMED`, `INFERRED`,
   `UNKNOWN`, or `CONFLICT`. Give OBSERVED claims path-level evidence.
6. Build the gap map. Interview only for high-impact business or operational
   knowledge that cannot be discovered: purpose, actors, historical exceptions,
   intended behavior behind contradictions, external ownership, security or
   compliance boundaries, and known accidental legacy behavior.
7. Present discoveries before questions so the developer can answer deltas
   instead of retelling the system. The interview is adaptive: keep returning
   focused questions while any material ambiguity remains, including one an
   earlier answer just opened, and stop the moment nothing material is open.
   Never re-ask a decision that was already answered and accepted.
   Apply the answer acceptance gate; a vague or
   partial response is not `CONFIRMED`. Re-ask material ambiguity narrowly or
   retain it as `UNKNOWN`/`CONFLICT`.
8. Return the compact portable index and conditional context documents declared
   by the injected canonical artifact authority. A subject with no evidence is omitted or marked
   evidence-based N/A; never fabricate it. When the repository proves a real
   consumer setup/start/use workflow, encode it in the authority's conditional
   operational artifact using `rb-operational/v1`. Cover the implemented product form and claimed
   platforms without assuming web. Omit the contract and record the evidence
   gap when commands or observables cannot be grounded.
9. Before returning, run the shared pre-write ambiguity audit. A writer receives
   answer dispositions and may promote only `ACCEPTED` answers to `CONFIRMED`;
   implemented behavior wins over an ungrounded interpretation.
10. The orchestrator runs every deterministic validator after assembly; produce document parts that assemble into compliant artifacts, and never claim to have run a command. They cover `rb-operational/v1`, the manifest, and the whole tree.
   Return only the documents this request actually changes; preserve compatible
   existing context documents unchanged.
11. State coverage, confidence classes, conflicts, unknowns, skipped areas, and
    changed artifacts in the bundle summary. Never produce application code,
    intent specs, or commits.

After context is current, route an open-ended whole-product audit to
`rb-review`, a requested change to established behavior to `rb-evolve`, and a
genuinely isolated feature or fix to `rb-plan`.

These resources are loaded by the standalone executable. Generated documents
must not depend on the location of this resource tree or any plugin host.

## Re-runs

Use prior source hashes to focus on changed evidence. Preserve confirmed
business knowledge unless the developer changes it. Generated prose is not a
source of truth; re-ground changed claims in code and tests.
