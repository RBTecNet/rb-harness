# Artifact Conventions

## Tree

Write under `.rb/` except for the compact root `AGENTS.md` index:

```text
.rb/
  rb-manifest.json
  artifacts.tsv
  init/
  context/
  features/<slug>/
  handoffs/
  manifests/
```

All paths in documents and manifests are project-root-relative. Never escape
the project root or store secrets.

## Stable identity and provenance

- Project, requirement, contract, phase, task, decision, question, and artifact
  IDs stay stable across re-runs.
- Source manifests store path plus full SHA-256.
- Classify knowledge as `OBSERVED`, `CONFIRMED`, `INFERRED`, `UNKNOWN`, or
  `CONFLICT`.
- A developer response becomes `CONFIRMED` only after the interview policy marks
  its answer disposition `ACCEPTED`. Preserve the raw response and normalized
  decision; do not collapse partial, ambiguous, deferred, or contradicted
  responses into confirmed prose.
- Cite code/test/config paths for OBSERVED claims.
- Record superseded decisions; do not erase their history silently.

## Ownership

Generated artifacts carry this line after the title:

```text
<!-- generated-by: rb-harness; schema: rb-artifact/v1 -->
```

Default behavior:

- absent: create;
- generated: update affected sections after re-grounding;
- hand-written without marker: do not overwrite without explicit adoption;
- `.rb/handoffs`: resumable working state, never execution truth.

## Language

Match developer/project prose language. Keep IDs, manifest keys, contract
markers, and machine field labels in English so consumers remain portable.

## Execution neutrality

Documents may declare dependencies, risk, validation, and parallel safety. They
must not require a provider, model, CLI, session strategy, commit strategy,
branch strategy, agent topology, RB Ralph, or RB Memory.

`OPERATIONS.json` may declare portable executable acceptance through
`rb-operational/v1`. It describes product behavior and real consumer entrypoints,
not an orchestration implementation. Never assume that the product is web-based
or that one operating system represents every claimed platform.
