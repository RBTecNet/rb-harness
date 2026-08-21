---
description: Initialize a new project from text or a prompt file and generate grounded .rb/init documentation plus a validated provider-neutral execution plan.
argument-hint: "<description | @prompt-file | --file prompt-file>"
allowed-tools: Agent, Task, Read, Write, Edit, Glob, Grep, Bash, AskUserQuestion
---

# RB Harness init router

Generate documentation only. Never implement application code or commit.

1. Read `${CLAUDE_PLUGIN_ROOT}/references/interview-policy.md`,
   `artifact-conventions.md`, `execution-template.md`, and
   `operational-template.md` completely.
2. Resolve `$ARGUMENTS`: `@path`, `--file path`, an existing bare path, free
   text, or one open question when empty. Hash file inputs.
3. Inspect non-secret files already present before asking. Normalize objective,
   actors, MVP, workflows, constraints, capabilities, and draft criteria.
4. Apply the balanced interview policy. Ask only material gaps, in batches.
   Classify responses with the answer acceptance gate and follow up narrowly on
   material partial or ambiguous meaning.
5. Run the shared pre-write ambiguity audit. Confirm one concise normalized
   summary that separates accepted decisions, assumptions, deferrals, and
   unresolved ambiguity.
6. Initialize `.rb/` with
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/rb-harness.cjs" project init . --name "<name>"`
   when needed.
7. Delegate to `rb-harness:project-documenter` with source paths/hashes, raw
   responses, normalized decisions, answer dispositions, assumptions,
   remaining uncertainty, and target root. Only `ACCEPTED` responses are
   confirmed input. The agent owns artifact content.
8. Validate `.rb/init/PHASES.md` and `OPERATIONS.json` when emitted, sync the manifest, and validate the tree with
   the bundled CLI. A failed check returns to the writer; never patch around the
   contract in the router.
9. Report artifacts, readiness, answer dispositions, assumptions/questions,
   phases/tasks, and checks.

Do not assume database, UI, API, web, authentication, queue, deployment, provider,
executor, commit, branch, or agent strategy.
