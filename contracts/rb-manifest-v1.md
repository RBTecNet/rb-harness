# RB Artifact Manifest v1

`.rb/rb-manifest.json` is the canonical map of generated artifacts. It removes
directory-layout inference from RB Ralph and other consumers.

Required properties:

- `manifestVersion`: `rb-manifest/v1`.
- `project.id`: stable lower-case identifier.
- `project.name`: display name.
- `artifactRoot`: always `.rb` in v1.
- `artifacts`: records with stable ID, kind, relative path, SHA-256, status,
  and optional execution contract.

Execution documents use kind `execution-plan`. RB Ralph selects entries whose
status is `ready` and contract is `rb-execution/v1`.

The v1 artifact root may contain `init`, `context`, `features`, `reviews`,
`evolutions`, `handoffs`, and `manifests`. Review/evolution rich documents use
descriptive kinds such as `review-findings`, `design-system`,
`review-baseline`, `evolution-document`, and `regression-specification`;
executable PHASES and OPERATIONS retain their contract kinds regardless of
which workflow produced them.

`artifacts.tsv` is regenerated from the JSON manifest. Its columns are:

```text
id  kind  status  contract  path  sha256
```

Fields are tab-delimited. IDs and paths may not contain tabs or newlines.
The first metadata line is `# rb-artifacts-index: rb-manifest/v1`; consumers
must reject an unsupported version before executing a plan.
