---
description: Audit an existing application end to end, record evidence-grounded findings, and optionally plan remediation for explicitly selected findings.
argument-hint: "[project-path] [--quick|--balanced|--deep] [--focus <areas>] [--baseline <review-id>] [--plan <finding-ids>]"
allowed-tools: Agent, Task, Read, Write, Edit, Glob, Grep, Bash, AskUserQuestion
---

# RB Harness review router

Audit and document only. Never repair application code or commit.

1. Read `${CLAUDE_PLUGIN_ROOT}/references/interview-policy.md`,
   `artifact-conventions.md`, `execution-template.md`,
   `operational-template.md`, and
   `${CLAUDE_PLUGIN_ROOT}/skills/rb-review/references/review-artifacts.md`.
2. Resolve target, depth, focus, optional baseline, and optional selected finding
   IDs. Initialize the RB tree and run the bundled `inspect` command when needed.
3. In audit mode, delegate read-only coverage and candidate discovery to
   `rb-harness:review-inspector`. Permit only safe, non-destructive project
   commands and retain their outputs and limitations.
4. Apply the ambiguity and finding-confidence gates. Deduplicate candidates by
   root cause; never present suspicion as a confirmed defect.
5. Delegate artifact generation to `rb-harness:review-writer`. Do not emit
   PLAN/PHASES without explicit finding selection.
6. In remediation mode, revalidate selected IDs and delegate only those findings
   to `rb-harness:review-planner`. Reject stale, resolved, or unselected items.
7. Validate emitted execution/operational contracts, sync the manifest, and
   validate the tree. Return failures to the owning writer.
8. Report coverage, limitations, severity/confidence counts, baseline delta,
   selected/deferred findings, artifact paths, and checks.

Parallel-safe remediation tasks require disjoint owned paths and interfaces,
no pending dependency, and no shared migration, generated artifact, or stateful
validation surface. Otherwise mark them non-parallel.
