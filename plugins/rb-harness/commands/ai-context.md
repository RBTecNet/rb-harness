---
description: Reverse-engineer an existing project into evidence-grounded AGENTS.md and .rb/context documentation, with a short adaptive interview for material gaps.
argument-hint: "[project-path] [--quick|--balanced|--deep] [--adopt]"
allowed-tools: Agent, Task, Read, Write, Edit, Glob, Grep, Bash, AskUserQuestion
---

# RB Harness AI context router

Document implemented reality only. Never plan or implement a change.

1. Read `${CLAUDE_PLUGIN_ROOT}/references/interview-policy.md` and
   `artifact-conventions.md` plus `operational-template.md` completely.
2. Resolve the target and ownership mode. Never read `.env`, credentials,
   dependency/build trees, `.rb/init`, `.rb/features`, `.spec`, or old generated
   context as behavioral evidence.
3. Initialize `.rb/` when absent, then run the bundled `inspect` command.
4. Delegate to `rb-harness:context-inspector`. It returns a compact evidence
   digest and gap map; it writes nothing.
5. Present discoveries first. Ask only high-impact business/operational gaps
   from the digest using the selected interview depth.
6. Delegate digest plus confirmed answers to `rb-harness:context-writer`.
7. Validate `OPERATIONS.json` when emitted, then run `manifest sync` and
   `tree validate`; return failures to the writer.
8. Report coverage, classifications, conflicts, unknowns, skipped areas,
   artifact statuses, and checks.

Every material claim is OBSERVED, CONFIRMED, INFERRED, UNKNOWN, or CONFLICT.
