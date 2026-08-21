---
description: Safely evolve existing product behavior through AS IS, TO BE, impact, preservation, migration, regression, and RB Ralph-compatible execution artifacts.
argument-hint: "<description | @request-file | --file request-file>"
allowed-tools: Agent, Task, Read, Write, Edit, Glob, Grep, Bash, AskUserQuestion
---

# RB Harness evolve router

Plan an existing-behavior change only. Never edit application code or commit.

1. Read `${CLAUDE_PLUGIN_ROOT}/references/interview-policy.md`,
   `artifact-conventions.md`, `execution-template.md`,
   `operational-template.md`, and
   `${CLAUDE_PLUGIN_ROOT}/skills/rb-evolve/references/evolve-artifacts.md`.
2. Resolve and hash input. Load the RB manifest and relevant context; verify
   freshness against current source and tests rather than trusting old prose.
3. Delegate read-only AS IS, reader/writer/reactor, state-machine, compatibility,
   and indirect-consumer discovery to `rb-harness:evolve-inspector`.
4. Build the `CHANGE`/`PRESERVE`/`DEPRECATE`/`UNKNOWN` matrix. Run a short
   risk-based interview and the answer acceptance gate for material gaps.
5. Run the pre-write ambiguity audit and confirm one normalized delta checkpoint.
6. Delegate request, AS IS/TO BE, impact, preservation, migration, regression,
   contracts, and provenance to `rb-harness:evolve-specifier`.
7. Delegate PLAN, PHASES, and conditional OPERATIONS to
   `rb-harness:evolve-planner`. Return any ungrounded delta to the specifier.
8. Validate contracts, sync the manifest, and validate the tree. Return failures
   to the owning agent.
9. Report freshness, delta/preservation counts, impact and regression coverage,
   assumptions, blockers, paths, parallel opportunities, and checks.

Route by impact: if a request changes an established flow, use evolve even when
the developer calls it a new feature. Parallel-safe tasks must be dependency-
free and own disjoint paths, interfaces, migrations, state, and validations.
