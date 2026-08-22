# Review Artifact Shapes

Write the smallest sufficient set under `.rb/reviews/<review-id>/`. Keep finding
IDs stable across reruns and preserve supersession history.

- `REVIEW.md` always: target revision, depth/focus, coverage map, methodology,
  reviewed commands, runtime/static limits, summary by severity/confidence, and
  readiness for remediation selection. For UI-bearing targets, include a
  surface-by-layout-state responsive evidence matrix with static/runtime/visual
  disposition and explicit below-the-fold coverage or limitation. Also include
  the responsive static-inventory reconciliation: first-party UI files and
  layout candidates discovered/analyzed/excluded/unresolved, covered surface
  kinds/mechanisms, negative-control commands, and provenance for candidate
  paths. Contract-bearing UI reviews include
  `<!-- rb-responsive-inventory-contract: rb-responsive-inventory/v1 -->`.
- `RESPONSIVE_INVENTORY.json` for every UI-bearing target: the
  `rb-responsive-inventory/v1` machine-readable file/candidate reconciliation,
  individual parent-child topology evidence and dispositions, layout-state
  assessments, finding links, discovery commands, and limitations. Validate it
  with `review validate-responsive`; a path-only Markdown inventory is not a
  substitute. `RESPONSIVE_INVENTORY.md` may summarize the JSON for humans.
- `FINDINGS.md` always: one record per root cause with stable `RV-<AREA>-NNN` ID,
  title, area, severity (`CRITICAL`, `HIGH`, `MEDIUM`, `LOW`, `INFO`), confidence
  (`CONFIRMED`, `LIKELY`, `UNKNOWN`, `FALSE_POSITIVE_RISK`), affected journey,
  evidence, reproduction/inspection, expected vs actual, impact, tenant/security
  boundary, proposed validation, remediation direction, dependencies, and
  baseline disposition.
- `JOURNEYS.md` when cross-layer product flows were reviewed: actors, steps,
  trust boundaries, data transitions, UI feedback, and covered failure paths.
- `DESIGN_SYSTEM.md` for UI-bearing products when no current authoritative
  document is sufficient: observed tokens/components/patterns, canonical
  loading and feedback behavior, responsiveness/accessibility rules,
  inconsistencies, confirmed decisions, unknowns, and clearly labeled
  recommendations. Never present a proposed visual choice as observed.
- `BASELINE.json` always: review ID, target source hashes/revision, finding IDs
  with fingerprints and dispositions, accepted risks, and comparison metadata.
- `source-manifest.json` always: inspected paths/hashes, commands and outcomes,
  exclusions, raw/normalized developer answers with dispositions, finding-to-
  evidence links, generated artifact IDs, and provenance for runtime or visual
  evidence used to support responsive claims. For UI targets, include structured
  responsive inventory artifact ID/hash and runtime/visual provenance.
  Responsive totals in prose must be derived from the validated JSON rather
  than independently asserted. When planning was requested in the same review,
  also record the raw selection policy, normalized predicate, resolved stable
  IDs, and selected/deferred/rejected counts after the audit is frozen.

Only after explicit finding selection:

- `SELECTION.md`: raw selection policy, normalized predicate, resolved stable
  IDs, selected/deferred/rejected finding IDs and counts, rationale, scope,
  accepted risks, and readiness.
- `PLAN.md`: remediation DAG, root-cause grouping, regression boundaries, risks,
  rollout/rollback, and finding traceability.
- `PHASES.md`: exact 1:1 `rb-execution/v1` view. Every task covers one or more
  selected finding IDs and directly states observable criteria. Responsive
  tasks use complete-surface geometry or equivalent behavioral checks at the
  affected and representative wider layout states, not visibility or global
  overflow alone.
- `OPERATIONS.json`: conditional consumer-level `rb-operational/v1` acceptance.

Do not put unselected findings into an executable plan. Do not combine unrelated
critical findings into a single vague "harden the application" task.
`--plan-all-confirmed` selects only frozen `CONFIRMED` findings. A zero-result
policy produces no planning artifacts and must not be widened to lower
confidence findings.
