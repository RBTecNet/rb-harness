---
name: rb-review
description: Audit an existing application end to end and produce evidence-grounded product, security, tenancy, frontend, design-system, data, operations, and test-quality findings. Use for whole-product reviews, incomplete or broken functionality discovery, frontend/backend interaction audits, or planning remediation from selected review findings. Never edits application code; use rb-evolve for a requested change to known existing behavior and rb-plan for a scoped new feature or fix.
---

# RB Review

Audit implemented product reality without repairing it. A finding is useful only
when another engineer can locate, reproduce or inspect, prioritize, and validate
it without guessing.

## Artifact authority

The orchestrator injects the canonical machine-owned artifact definition into
the generation prompt. That definition owns required names, paths, readiness,
and code/model ownership.

## How your output is delivered

You do not write files and you do not run commands. During the planning call,
return only the compact document plan requested by the stage prompt, without
document content. During each later closed authoring call, return only the
requested raw document segment. Never emit a complete document bundle unless
the stage prompt explicitly requests the legacy compatibility form. You author
the workflow-local `source-manifest.json`, including its required source
provenance and hashes. The orchestrator checkpoints and assembles parts,
materializes files, and derives the code-owned `.rb/rb-manifest.json` and
`.rb/artifacts.tsv`, including their artifact hashes, kinds, generated metadata,
identities, and statuses. It then runs deterministic validators and publishes
atomically. The
exact output contract for this workflow — required documents, the
`rb-execution/v1` grammar, the `rb-operational/v1` shape, and the conventions —
is supplied in the prompt as `rb-harness-contract-digest/v1`.
- For every UI-bearing target, [Responsive evidence](responsive-evidence.md)

## Modes

- Audit mode is the default. It discovers and records findings but emits no
  remediation plan.
- Remediation mode applies only when the developer selects stable finding IDs
  or supplies the explicit `--plan-all-confirmed` selection policy in the same
  review request. It plans the resolved findings into the conditional
  remediation artifacts declared by the injected authority; it never edits application code.

`--plan-all-confirmed` means every and only finding classified `CONFIRMED` after
the audit artifacts and stable IDs are finalized. It never promotes or selects
`LIKELY`, `UNKNOWN`, or `FALSE_POSITIVE_RISK`, never widens an empty selection,
and never creates a zero-finding plan. It is mutually exclusive with explicit
`--plan <finding-ids>`. The policy preauthorizes selection for planning only;
it does not authorize implementation, commits, destructive actions, or bypass
of a `human:` execution gate.

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
10. Plan and incrementally author the conditional artifacts from the injected canonical artifact authority. The orchestrator runs every deterministic validator after assembly; produce document parts that assemble into compliant artifacts, and never claim to have run a command. They
    cover `rb-responsive-inventory/v1`, the manifest, and the whole tree. For UI
    targets, do not return findings until every high-risk responsive candidate
    has an individual structured disposition and file/candidate totals
    reconcile. A path list or prose claim of zero unresolved candidates is not
    evidence. State coverage, skipped areas, limitations, and counts by
    severity/confidence in the bundle summary.

11. When an explicit planning selector was supplied, freeze the completed audit
    before resolving it. Persist its raw form, normalized predicate, resolved
    IDs, and selected/deferred/rejected counts. Start a fresh planner context
    that reads the written review artifacts and relevant current code evidence;
    do not carry the inspector/writer conversation into remediation planning.

## Remediation workflow

1. Require explicit stable finding IDs or resolve `--plan-all-confirmed` against
   the frozen audit. Revalidate resolved evidence against the current tree.
   Resolved, stale, contradicted, or unselected findings are not planned. If an
   automatic policy resolves to zero IDs, report that result and stop without
   creating any conditional remediation artifact.
2. Group by dependency and shared root cause, not merely severity. Keep each task
   bounded enough for a fresh, context-free executor call; the decomposition
   ceilings in the contract digest are validated mechanically.
3. Preserve unrelated behavior and design-system authority. Every task traces to
   finding IDs, owns binary criteria and focused validation, and names regression
   boundaries.
   For responsive findings, require a falsifiable before/after check at the
   affected narrow and wide layout states, exercise the complete affected
   surface, and validate usable geometry rather than presence alone.
   The resulting execution task must satisfy the shared visual evidence
   contract: executable browser/visual proof or `human:`, durable screenshots
   at exact viewports, geometry/computed-style measurements, and a negative
   corruption criterion. `manual:` is not completion proof for rendered UI.
4. Emit valid `rb-execution/v1` and conditional `rb-operational/v1`, validate
   both, sync the manifest, and validate the tree. Use `BLOCKED` rather than
   inventing a security, product, or design decision. Audit selected-finding
   traceability through criteria, explicit executable gates, validation
   capability, and evidence. Normal phases validate operational-contract
   structure; only the post-phase RBF audit owns its clean-room result. Preserve
   exact standards and add independent hostile schema/secret regressions when
   relevant.

These resources are loaded by the standalone executable. Generated documents
must not depend on the location of this resource tree or any plugin host.
