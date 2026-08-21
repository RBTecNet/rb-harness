# Review Artifact Shapes

Write the smallest sufficient set under `.rb/reviews/<review-id>/`. Keep finding
IDs stable across reruns and preserve supersession history.

- `REVIEW.md` always: target revision, depth/focus, coverage map, methodology,
  reviewed commands, runtime/static limits, summary by severity/confidence, and
  readiness for remediation selection.
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
  evidence links, and generated artifact IDs.

Only after explicit finding selection:

- `SELECTION.md`: selected/deferred/rejected finding IDs, rationale, scope,
  accepted risks, and readiness.
- `PLAN.md`: remediation DAG, root-cause grouping, regression boundaries, risks,
  rollout/rollback, and finding traceability.
- `PHASES.md`: exact 1:1 `rb-execution/v1` view. Every task covers one or more
  selected finding IDs and directly states observable criteria.
- `OPERATIONS.json`: conditional consumer-level `rb-operational/v1` acceptance.

Do not put unselected findings into an executable plan. Do not combine unrelated
critical findings into a single vague "harden the application" task.
