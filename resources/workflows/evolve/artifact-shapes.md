# Evolution Artifact Shapes

Write under `.rb/evolutions/<slug>/` with stable IDs and source hashes.

- `CHANGE_REQUEST.md` always: source request, objective, trigger, actors, scope,
  non-goals, accepted answers, assumptions, and readiness.
- `AS_IS.md` always: current end-to-end behavior with claim classifications and
  path-level evidence, including accidental legacy and conflicts.
- `TO_BE.md` always: explicit delta, RIGID observable requirements, FLEXIBLE
  choices, examples, failures, permissions, and acceptance criteria.
- `IMPACT.md` always: affected UI/domain/data/contracts/integrations/jobs/tests/
  operations; reader-writer-reactor map; direct/indirect consumers; tenancy and
  security boundaries; source freshness.
- `PRESERVATION.md` always: matrix of `CHANGE`, `PRESERVE`, `DEPRECATE`, and
  `UNKNOWN`, with old behavior and compatibility promises that constrain tasks.
- `MIGRATION.md` only when data, contracts, consumers, or rollout transition:
  old records, backfill, coexistence, feature flags when justified, deployment
  ordering, rollback, observability, and failure recovery.
- `REGRESSION_MATRIX.md` always: old and new success/failure scenarios, actor and
  tenant boundaries, concurrency/idempotency cases, evidence source, expected
  observable, and owning validation/task.
- `PLAN.md` and valid `PHASES.md` when readiness permits execution.
- `OPERATIONS.json` when consumer-level evolution and at least one critical
  preserved path can be honestly exercised through `rb-operational/v1`.
- `contracts/` only for RIGID public or async boundary changes.
- `source-manifest.json` always: request/source paths and hashes, context
  freshness, raw/normalized answers with dispositions, claim provenance,
  requirement-impact-preservation-regression-task links, and artifact IDs.

Every RIGID TO BE requirement maps to impact and regression entries and at least
one task. Every preserved behavior affected by task scope owns a regression
entry. Unknown material behavior blocks the affected task rather than being
silently redefined.
