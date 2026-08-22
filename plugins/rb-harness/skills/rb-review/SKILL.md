---
name: rb-review
description: Audit an existing application end to end and produce evidence-grounded product, security, tenancy, frontend, design-system, data, operations, and test-quality findings. Use for whole-product reviews, incomplete or broken functionality discovery, frontend/backend interaction audits, or planning remediation from selected review findings. Never edits application code; use rb-evolve for a requested change to known existing behavior and rb-plan for a scoped new feature or fix.
---

# RB Review

Audit implemented product reality without repairing it. A finding is useful only
when another engineer can locate, reproduce or inspect, prioritize, and validate
it without guessing.

## Required references

Read these files completely before writing artifacts:

- [Interview policy](../../references/interview-policy.md)
- [Artifact conventions](../../references/artifact-conventions.md)
- [Execution template](../../references/execution-template.md)
- [Operational acceptance template](../../references/operational-template.md)
- [Review artifact shapes](references/review-artifacts.md)
- For every UI-bearing target, [Responsive evidence](references/responsive-evidence.md)

## Modes

- Audit mode is the default. It discovers and records findings but emits no
  remediation plan.
- Remediation mode applies only when the developer selects stable finding IDs.
  It plans those findings into `PLAN.md`, `PHASES.md`, and conditional
  `OPERATIONS.json`; it never edits application code.

Support `quick`, `balanced`, and `deep`. Accept one or more focus areas:
`product`, `security`, `tenancy`, `frontend`, `design`, `accessibility`,
`performance`, `tests`, `data`, `operations`, and `supply-chain`. A focus narrows
depth, not cross-boundary evidence needed to understand a critical journey.

## Audit workflow

1. Resolve the target, depth, focus, optional baseline review, and safe runtime
   constraints. Never read secrets, dependency/build trees, Git internals, RB
   intent documents, or old generated findings as proof of current behavior.
2. Ensure the RB tree exists, then run the bundled `inspect` command. Inspect
   current code, tests, configs, CI, manifests, migrations, and relevant runtime
   entrypoints before making claims.
3. Build a risk-based coverage map. Trace critical journeys from user action
   through client state, network/API, authorization, tenancy, domain rules,
   persistence or jobs, and final UI feedback.
4. Run only reviewed, non-destructive checks. Prefer existing project commands.
   Never install dependencies, mutate data, launch destructive scanners, or use
   credentials without separate authorization. Record commands, environment,
   outputs, and limitations.
5. Inspect stack-specific mechanisms without narrowing the audit to one stack.
   Examples include Livewire round-trips and `wire:click`, React effects and
   renders, Angular change detection and subscriptions, but findings must be
   expressed as observable product or engineering behavior.
6. For UI-bearing products, discover the formal or informal design system and
   loading/feedback conventions. Apply `responsive-evidence.md`, including its
   depth-specific static inventory and reconciliation gate. In balanced and deep
   reviews, mechanically account for all first-party UI sources and inspect or
   preserve as UNKNOWN every high-risk layout candidate before sampling runtime
   surfaces. Analyze parent and child constraints together at each supported
   breakpoint and, when safe runtime evidence is available, traverse complete
   surfaces including below-the-fold content. Check accessibility, request
   duplication, stale responses, debounce/cancellation, duplicate submits,
   layout stability, and success/empty/error/timeout/cancel states.
7. Evaluate test meaning, not coverage alone: assertions, negative paths,
   mutation sensitivity, mock boundaries, skipped tests, tautologies, and
   whether important behavior is exercised.
8. Classify each candidate as `CONFIRMED`, `LIKELY`, `UNKNOWN`, or
   `FALSE_POSITIVE_RISK`. A confirmed finding needs direct evidence and a
   reproducible or inspectable failure. A clean responsive claim needs evidence
   proportional to its breadth; a token scan, element visibility, one viewport,
   one above-the-fold screenshot, or absence of document-level overflow cannot
   prove an entire surface responsive. Never promote absence of evidence into
   evidence of absence.
9. Apply the shared ambiguity audit. Deduplicate by root cause, preserve
   independent impact paths, and compare with the baseline as new, changed,
   regressed, unchanged, or resolved.
10. Write the conditional artifacts from `review-artifacts.md`, then run
    `manifest sync` and `tree validate`. For UI targets, do not hand work to the
    writer until responsive file and candidate totals reconcile. Report
    coverage, skipped areas, limitations, counts by severity/confidence, and
    artifact paths.

## Remediation workflow

1. Require explicit stable finding IDs and revalidate their evidence against the
   current tree. Resolved, stale, or contradicted findings are not planned.
2. Group by dependency and shared root cause, not merely severity. Keep each task
   bounded enough for a fresh executor context.
3. Preserve unrelated behavior and design-system authority. Every task traces to
   finding IDs, owns binary criteria and focused validation, and names regression
   boundaries.
   For responsive findings, require a falsifiable before/after check at the
   affected narrow and wide layout states, exercise the complete affected
   surface, and validate usable geometry rather than presence alone.
4. Emit valid `rb-execution/v1` and conditional `rb-operational/v1`, validate
   both, sync the manifest, and validate the tree. Use `BLOCKED` rather than
   inventing a security, product, or design decision. Audit selected-finding
   traceability through criteria, explicit executable gates, validation
   capability, and evidence. Normal phases validate operational-contract
   structure; only the post-phase RBF audit owns its clean-room result. Preserve
   exact standards and add independent hostile schema/secret regressions when
   relevant.

Resolve `<plugin-root>` as 2 directories above this skill directory. Pass the
project root explicitly when it differs from the current directory.
