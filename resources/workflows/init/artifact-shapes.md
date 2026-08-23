# Init Artifact Shapes

Create the smallest sufficient set under `.rb/init/`:

- `PROJECT.md` always: objective, audience, value, scope, non-goals,
  constraints, success measures, readiness.
- `GLOSSARY.md` when the domain has specialized terms.
- `REQUIREMENTS.md` always: RIGID requirements with stable RF/RNF/UI/CT IDs and
  binary acceptance criteria; FLEXIBLE decisions separately.
- `WORKFLOWS.md` when actors, states, or failures require sequencing.
- `ARCHITECTURE.md` when architecture choices are confirmed or constrained;
  distinguish confirmed decisions from proposals.
- `DECISIONS.md` always: confirmed decisions, alternatives, rationale,
  consequences, and supersession.
- `NON_FUNCTIONAL.md` only for relevant measurable quality constraints.
- `PLAN.md` and valid `PHASES.md` always when readiness permits execution.
- `OPERATIONS.json` when at least one honest consumer-level scenario can be
  derived from confirmed product/platform decisions; use `rb-operational/v1`.
- `contracts/` only for public/async/formal interfaces required by RIGID.
- `source-manifest.json` always: input paths, hashes, generated artifact IDs,
  and for each response its raw text, normalized decision, answer disposition,
  affected topics, and remaining uncertainty.

Capability discovery is conditional. Do not create database, API, UI, auth,
queue, mobile, CLI, or infrastructure sections without evidence or confirmed
need. Ensure every requirement appears in at least one plan task and every task
traces back to a requirement.
