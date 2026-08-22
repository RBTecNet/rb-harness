---
description: Audit an existing application end to end, record evidence-grounded findings, and optionally plan remediation for explicitly selected findings.
argument-hint: "[project-path] [--quick|--balanced|--deep] [--focus <areas>] [--baseline <review-id>] [--plan <finding-ids>|--plan-all-confirmed]"
allowed-tools: Agent, Task, Read, Write, Edit, Glob, Grep, Bash, AskUserQuestion
---

# RB Harness review router

Audit and document only. Never repair application code or commit.

1. Read `${CLAUDE_PLUGIN_ROOT}/references/interview-policy.md`,
   `artifact-conventions.md`, `execution-template.md`,
   `operational-template.md`, and
   `${CLAUDE_PLUGIN_ROOT}/skills/rb-review/references/review-artifacts.md`.
   For UI-bearing targets also read
   `${CLAUDE_PLUGIN_ROOT}/skills/rb-review/references/responsive-evidence.md`.
2. Resolve target, depth, focus, optional baseline, and one optional planning
   selector. `--plan <finding-ids>` explicitly selects stable IDs.
   `--plan-all-confirmed` is an explicit selection policy authorizing every and
   only `CONFIRMED` finding produced by this completed audit. The selectors are
   mutually exclusive. Initialize the RB tree and run the bundled `inspect`
   command when needed.
3. In audit mode, delegate read-only coverage and candidate discovery to
   `rb-harness:review-inspector`. Permit only safe, non-destructive project
   commands and retain their outputs and limitations. For UI targets in balanced
   or deep mode, require a complete mechanical first-party UI inventory and all
   high-risk topology candidates inspected or preserved as UNKNOWN.
4. Apply the ambiguity and finding-confidence gates. Deduplicate candidates by
   root cause; never present suspicion as a confirmed defect. Reject broad clean
   responsive claims unless their surface/layout-state matrix has proportional
   full-surface evidence; otherwise preserve explicit partial/UNKNOWN coverage.
   Before invoking the writer, verify that responsive file and candidate totals
   both reconcile as discovered = analyzed + excluded + unresolved; return an
   incomplete inventory to the inspector instead of silently accepting sampling.
   Candidate paths are provenance, not dispositions: require one structured
   parent/child topology record per high-risk candidate.
5. Delegate audit artifact generation to `rb-harness:review-writer`. Freeze the
   finding set, stable IDs, confidence, and audit evidence before resolving any
   automatic selector. Do not emit PLAN/PHASES without an explicit ID selection
   or `--plan-all-confirmed` policy.
6. In remediation mode, resolve the selector only against the frozen audit.
   Persist the raw policy, normalized predicate, resolved stable IDs, and
   selected/deferred/rejected counts. `--plan-all-confirmed` must never include
   `LIKELY`, `UNKNOWN`, or `FALSE_POSITIVE_RISK`; do not widen an empty result or
   create a plan with no selected IDs. Revalidate the resolved IDs against the
   current tree, then start `rb-harness:review-planner` with a fresh context
   containing artifact paths and resolved IDs, not the accumulated audit
   conversation. Reject stale, resolved, contradicted, or unselected items.
7. For UI reviews, validate `RESPONSIVE_INVENTORY.json` with `review
   validate-responsive`. Then validate emitted execution/operational contracts,
   sync the manifest, and validate the tree. Return failures to the owning
   inspector or writer; never finalize a path-only inventory.
8. Report coverage, limitations, severity/confidence counts, baseline delta,
   selection policy/result, selected/deferred findings, artifact paths, and
   checks. Planning authorization never authorizes implementation, commits,
   destructive operations, or bypassing a required `human:` gate.

Parallel-safe remediation tasks require disjoint owned paths and interfaces,
no pending dependency, and no shared migration, generated artifact, or stateful
validation surface. Otherwise mark them non-parallel.
