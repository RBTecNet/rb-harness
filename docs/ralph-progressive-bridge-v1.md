# Progressive READY → Ralph execution bridge V1

The public entry point is:

```text
rb-harness --ralph --project <project-root>
```

When the result is `NEEDS_HUMAN`, the operator performs the printed check and
continues the same durable run with exactly one of:

```text
rb-harness --ralph --project <project-root> --human-decision pass
rb-harness --ralph --project <project-root> --human-decision fail
```

It consumes authority; it does not create or repair it. Every invocation first
calls the production Progressive readiness inspection without accepting new
request text. The inspection reconstructs freshness from the persisted P1
original request. The bridge then validates the manifest tree and selects the
single `ready` `execution-plan` through the production selector. Any missing,
stale, invalid, or ambiguous authority fails before workspace or run creation.

## Dependency direction

`vnext/ralph-bridge` is an integration layer. It imports the public
Progressive contracts and the frozen Ralph operational stages. Progressive and
Ralph do not import the bridge, and Progressive never imports a Ralph provider.
The production factories are deliberately fixed to the qualified M5-B Codex
CLI Executor and M5-D Codex CLI Auditor. M5-C correction remains the exact
durable correction-context path already enforced by that Executor.

## Identity and genesis

Semantic execution identity is deterministic:

```text
ralph-exec-<sha256(canonical {
  schema,
  manifest project id,
  selected plan id,
  selected plan path,
  selected PHASES sha256
})>
```

The source PHASES hash and the Ralph operational projection digest are stored
separately. The projection is lossless for phase/task execution authority; its
only textual normalization removes Markdown code-span backticks from `Scope`
so the frozen owned-path tokenizer receives the canonical path tokens.

Run IDs and timestamps are fresh operational provenance and never semantic
authority. The adapter constructs the frozen `RalphRuntimeStateV2`,
`RunSnapshotV2`, existing retry policy (two task attempts, zero validation
infrastructure retries), `run.created` event, plan/task graph, managed runtime
identity, and role bindings before calling `initializeOperationalRunV2`.

## Workspace and publication

The Ralph event store's project root is the isolated worker workspace, not the
real project. Initial workspace materialization is file-by-file and excludes
`.rb/**`, `.rb-harness/**`, `.spec/init/**`, and `.git/**`. Providers receive
the current immutable work unit rather than writable copies of those inputs.

V1 uses **accepted task delta publication**. After deterministic validation
and Auditor acceptance, the host compares the task workspace baseline with the
candidate, rejects control paths, unowned paths, traversal, symlinks, and
special files, rechecks both Progressive readiness and exact plan identity,
and verifies the full host implementation baseline has not changed. Allowed
creates, updates, and deletes are explicitly staged and applied; in-process
failure rolls applied files back. No whole-tree copy is used.

Each attempt receives an immutable `host-publication.json` beside existing
Ralph attempt evidence. It is a derived host-action receipt, not a second run
state authority. A rejected receipt takes precedence when the front door
reports or reopens a run, including the case where Ralph's task acceptance was
durable but host publication was rejected.

## Resume and human evidence

The driver reopens durable Ralph state between frozen operational boundaries.
Every terminal trusted Executor observation is first persisted as a
Core-created `rb-ralph-executor-observation-receipt/v1`, followed by its
InvocationResult and then `executor.finished`. A fresh process revalidates a
nominal observation-only B3 capability and rehydrates the trusted observation
from those mutually agreeing durable facts. That capability is not an
`AuthorizedInvocationV2`, cannot dispatch, and recovery invokes or observes no
Executor process.

Human validation uses the frozen `HUMAN_REQUIRED` hold and returns
`NEEDS_HUMAN` with the exact task, validation instruction, evidence path, and
continuation commands. The user supplies only `pass` or `fail`; Core discovers
the sole pending request and constructs a nominal `OPERATOR_HUMAN` authority
bound to that exact run, phase, task, attempt, validation spec, digest, and
request ref. The immutable decision clears the existing hold and materializes
the existing Human ValidationRun. `PASS` satisfies only that validation item:
the Auditor and all normal acceptance/publication gates still run. Providers,
Auditors, and correction models cannot construct operator authority.

An existing incomplete same-plan run is never duplicated. Unsupported or
inconsistent boundaries remain `INCOMPLETE_RESUMABLE`/fail-closed with their
durable evidence path; missing observation receipts are never repaired by
redispatching the Executor.
