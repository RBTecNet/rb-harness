---
description: Plan a feature, bug fix, refactor, migration, performance or contract change into REQUEST, SPEC, PLAN, and validated rb-execution/v1 PHASES documents.
argument-hint: "<description | @request-file | --file request-file>"
allowed-tools: Agent, Task, Read, Write, Edit, Glob, Grep, Bash, AskUserQuestion
---

# RB Harness plan router

Plan documentation only. Never edit application code or commit.

1. Read `${CLAUDE_PLUGIN_ROOT}/references/interview-policy.md`,
   `artifact-conventions.md`, `execution-template.md`, and
   `operational-template.md` completely.
2. Resolve and hash input. Detect request type rather than forcing feature
   semantics on bugs, refactors, or migrations.
3. Load the RB manifest and relevant init/context sources. Inspect the affected
   code/test slice directly because generated context may be stale.
4. Normalize current/expected behavior, objective, scope, non-goals,
   constraints, risk, and preliminary acceptance criteria.
5. Delegate read-only adversarial analysis to `rb-harness:clarifier`. Present
   only its material, deduplicated questions using the balanced policy.
6. Confirm one concise normalized request checkpoint.
7. Delegate SPEC writing to `rb-harness:specifier`, then planning and execution
   view generation to `rb-harness:planner`.
8. Validate the resulting PHASES document and `OPERATIONS.json` when emitted,
   sync the manifest, and validate the tree. Return failures to the owning agent.
9. Report readiness, paths, requirements, phases/tasks, risks, assumptions,
   contracts, and checks.

Every RIGID requirement traces to tasks and binary criteria. Parallel safety is
descriptive and never forces an execution strategy.
