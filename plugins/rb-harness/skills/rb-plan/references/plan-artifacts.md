# Plan Artifact Shapes

## Request-specific clarification

- Feature: actor, trigger, result, boundaries, failure states, permissions,
  compatibility.
- Bug: observed vs expected, reproduction evidence, environment, impact,
  regression boundaries.
- Refactor: motivation, invariant behavior, permitted scope, compatibility.
- Migration: source/target, coexistence, data strategy, rollout, rollback.
- Performance: workload, baseline, measurement method, target, regressions.
- Contract: consumers, compatibility window, errors, versioning, rollout.

## Artifacts

Under `.rb/features/<slug>/` create:

- `REQUEST.md`: normalized source, type, objective, current/expected behavior,
  scope, non-goals, answers, assumptions, readiness.
- `SPEC.md`: RIGID/FLEXIBLE separation, verified literals, requirements,
  contracts, edge cases, binary acceptance summary.
- `PLAN.md`: AS IS/TO BE affected slice, atomic tasks, dependencies, conflict
  surfaces, risks, rollout, rollback, open questions, assumptions.
- `PHASES.md`: exact 1:1 execution view using `rb-execution/v1`.
- `OPERATIONS.json`: `rb-operational/v1` consumer-level acceptance when it can
  be grounded in observed commands or confirmed TO BE decisions. It is not a
  phase and must remain usable by direct execution without RB Ralph.
- `contracts/`: OpenAPI/AsyncAPI/proto/schema only when RIGID requires it.
- `source-manifest.json`: source paths and hashes, architecture/context refs,
  request answers, generated artifact IDs.

Every RIGID requirement maps to at least one task. Every task maps to one or
more requirements, declares affected scope, and owns a focused validation.
Tasks touching the same files or tight shared interface are not parallel-safe.
