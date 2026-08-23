# Context Artifact Shapes

Keep `.rb/context/AGENTS.md` compact: verified build/lint/test commands, critical
conventions, prohibitions, setup, and links to `.rb/context/`.

Create conditional context documents:

- `project-overview.md`: purpose, actors, boundaries, and macro flows.
- `architecture.md`: layout, responsibilities, dependency direction, and
  integration points.
- `glossary.md`: implemented domain vocabulary.
- `domain-rules.md`: rules, invariants, decision tables, and evidence.
- `workflows.md`: success/failure/state flows.
- `permissions-security.md`: auth, authorization, tenancy, sensitive-data and
  trust boundaries.
- `interfaces.md`: HTTP/RPC/CLI/events/jobs and realistic payloads from tests.
- `data-model.md`: stores, entities, relationships, migrations, cache/state.
- `dependencies-integrations.md`: external ownership, clients, retries, and
  failure behavior.
- `operations.md`: runtime, deployment, observability, scheduled work, and
  documented troubleshooting.
- `OPERATIONS.json`: executable `rb-operational/v1` clean-room acceptance only
  when setup/start/use commands and observables are grounded in repository
  evidence. It complements, never replaces, `operations.md`.
- `testing-quality.md`: exact verified commands, layout, runners, enforcement.
- `known-gaps.md`: conflicts, unknowns, skipped areas, legacy accidents, and
  developer-confirmed risks.
- `source-manifest.json`: source hashes, claim-to-evidence index, and for every
  developer response its raw text, normalized decision, answer disposition,
  affected topics, and remaining uncertainty.

Every document begins with the generated marker and an `AS IS` section. Omit a
document when its subject is irrelevant; use evidence-based N/A only when a
stable tree shape materially helps consumers.
