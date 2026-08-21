---
name: rb-ai-context
description: Reverse-engineer an existing or legacy software project into grounded AS IS context. Use when Codex must discover architecture, domain vocabulary and rules, workflows, permissions, interfaces, data, integrations, operations, and quality commands from code and tests, then ask a short adaptive interview only for material knowledge absent or contradictory in the repository. Writes AGENTS.md and .rb/context artifacts; never plans a change or treats intent documents as implemented fact.
---

# RB AI Context

Document implemented reality with evidence and calibrated confidence. Never use
`.rb/init`, `.rb/features`, `.spec`, or old generated context as proof of current
behavior.

## Required references

Read these files completely before writing artifacts:

- [Interview policy](../../references/interview-policy.md)
- [Artifact conventions](../../references/artifact-conventions.md)
- [Operational acceptance template](../../references/operational-template.md)
- [Context artifact shapes](references/context-artifacts.md)

## Workflow

1. Resolve the target. Never read `.env`, credentials, private keys, dependency
   trees, build outputs, Git internals, intent specs, or generated context as
   evidence.
2. Ensure the RB tree exists. If absent, initialize it with the detected project
   name using the bundled CLI.
3. Run `node <plugin-root>/scripts/rb-harness.cjs inspect <target>` to create the
   bounded evidence inventory. Read it before deeper inspection.
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
   instead of retelling the system.
8. Write `AGENTS.md` as a compact index and the conditional context documents
   from `context-artifacts.md`. A subject with no evidence is omitted or marked
   evidence-based N/A; never fabricate it. When the repository proves a real
   consumer setup/start/use workflow, encode it as `.rb/context/OPERATIONS.json`
   using `rb-operational/v1`. Cover the implemented product form and claimed
   platforms without assuming web. Omit the contract and record the evidence
   gap when commands or observables cannot be grounded.
9. Run `operations validate .rb/context/OPERATIONS.json` when emitted, then
   `manifest sync` and `tree validate`. Re-run generation only for artifacts
   affected by evidence or confirmed-answer changes.
10. Report coverage, confidence classes, conflicts, unknowns, skipped areas,
    changed artifacts, and validation. Never write application code, intent
    specs, or commits.

Resolve `<plugin-root>` as 2 directories above this skill directory. Pass the
project root explicitly to CLI commands when the current directory differs.

## Re-runs

Use prior source hashes to focus on changed evidence. Preserve confirmed
business knowledge unless the developer changes it. Generated prose is not a
source of truth; re-ground changed claims in code and tests.
