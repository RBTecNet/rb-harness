# RB Ralph Operational Contract V2

Status: versioned contract for review

Contract identity: `rb-ralph-operational/v2`

Event schema: `rb-ralph-event/v2`

State schema: `rb-ralph-runtime-state/v2`

This document is normative for the Operational Core described by the
identities above. It extends the frozen Ralph Runtime Foundation V1 beside
that contract; it does not rewrite, migrate, or reinterpret Foundation V1.

## 1. Purpose and scope

This contract defines the Core-owned operational boundary for a Ralph Run:

```text
ACTIVE Run
  -> Core Scheduler
  -> eligible Task
  -> OPEN Attempt
  -> Executor boundary
  -> workspace capture
  -> immutable evidence
  -> Core-owned deterministic validation
  -> AWAITING_AUDIT
```

The contract covers scheduling, Attempt lifecycle, invocation admission,
recovery ambiguity, workspace evidence, validation boundaries, leases, and
the hand-off to a future Auditor.

It does not implement or authorize a real provider, Auditor, Dashboard, CLI,
publication workflow, or parallel worktree execution.

`rb-ralph-operational/v2` is the internal Ralph Runtime operational contract.
It is not `rb-operational/v1`, which is the separate Harness operational
acceptance contract and may declare structured `argv` commands.

## 2. Compatibility

Foundation V1 remains immutable, readable, and replayable.

Operational Runs are born as V2 Runs with all three identities recorded in
their immutable Run Snapshot:

```text
eventSchema         = rb-ralph-event/v2
stateSchema         = rb-ralph-runtime-state/v2
operationalContract = rb-ralph-operational/v2
```

A Run has exactly one authoritative event ledger. A Run never mixes event
schema versions. A V1 ledger is never mutated to become V2, and an existing
V1 Run is not upgraded in place. An operational execution that needs V2 must
create a new V2 Run.

The V2 reader may provide a deliberate compatibility view of a V1 Run, but
must use the V1 replay semantics. It must not infer that a legacy open Attempt
is safe to reexecute when V1 did not persist the operational stage facts.

The Foundation package version remains independent of these Run schema
identities. This contract does not change the package version.

## 3. Authority model

The Core owns semantic authority for:

- Run, Phase, Task, and Attempt transitions;
- event ordering and hash-chain validity;
- Scheduler selection;
- dependency and budget decisions;
- lease admission;
- workspace and control-plane fingerprints;
- changed-path and EvidenceCapture facts;
- ValidationRun results;
- recovery classification and holds.

The plan is authoritative for Phase and Task identity, dependencies, order,
Scope, Covers, acceptance criteria, validation declarations, and
`parallelSafe`.

### Scope/Covers pointer

The interpretation of Scope and Covers follows the validated
`rb-execution/v1` contract and the canonical semantics already used by the
Harness.

Scope is not automatically an absolute filesystem sandbox, and Covers is not
a write allowlist. `.rb/**` and runtime-owned paths remain hard boundaries
independent of Scope/Covers. Scope/Covers evaluation is recorded in Evidence
and impact assessment.

Executor output is an observation and diagnostic claim. It is never authority
for workspace state, validation truth, Task completion, or Run completion.

The Dashboard has zero semantic authority. A provider has zero semantic
transition authority. The future Auditor decides audit outcome through
Core-committed facts; it does not mutate state directly.

The Core reducer is the sole semantic transition authority.

## 4. Event schema identity

Every V2 Run Snapshot records `rb-ralph-event/v2` as its expected event schema.
Every event envelope must declare and match that identity. The first event is
also checked against the Run Snapshot, but the first event alone is not the
source of schema identity: an empty Run and a mismatched runtime must fail
closed.

V2 is an explicit evolution of the event contract. Foundation event meanings
remain available through V2-compatible event definitions, while operational
facts use the V2 vocabulary in the same ledger, sequence, and hash chain.

An event with V1 identity in a V2 Run, or an event with V2 identity in a V1
Run, is rejected. A V1 validator is not silently taught to accept V2 events.

Payloads are closed and canonical. Raw stdout, stderr, patches, secrets, and
unbounded provider output do not belong directly in the event payload; events
carry typed claims, bounded metadata, artifact references, and digests.

## 5. State schema identity

Operational Runs persist `rb-ralph-runtime-state/v2`. The V2 state contains
the explicit Attempt disposition and stage required for deterministic resume,
along with operational artifact references and recovery metadata.

Foundation V1 state remains readable using V1 replay and reducer rules. V1
state is not rewritten to resemble V2 state. A V2 compatibility inspector may
mark a V1 open Attempt as legacy/unknown and require reconciliation; it may
not assume that the Executor was never called.

State snapshots are recoverable projections of the authoritative V2 ledger.
They are not an additional semantic stream.

## 6. AttemptDisposition

The V2 Attempt disposition is a closed enum:

```text
OPEN
CLOSED
```

`OPEN` means that recovery or a future Core action is still required. `CLOSED`
means that no further lifecycle action may be applied to that Attempt.

Closure is represented by `disposition = CLOSED` plus a closed V2
`closureReason`. The last operational stage remains available for diagnosis;
`CLOSED` is not an AttemptStage.

## 7. AttemptStage

The V2 Attempt stage is a closed enum:

```text
ADMITTED
EXECUTOR_DISPATCH_AUTHORIZED
EXECUTOR_RUNNING
POST_EXECUTOR_CAPTURE
EVIDENCE_CAPTURING
VALIDATING
AWAITING_HUMAN
AWAITING_AUDIT
AUDITING
RECONCILING
```

Stage meanings:

- `ADMITTED`: Attempt identity exists and `attempt.started` is committed;
  Executor dispatch has not been authorized.
- `EXECUTOR_DISPATCH_AUTHORIZED`: Core committed authorization with a stable
  invocation identity; process spawn is not yet proven.
- `EXECUTOR_RUNNING`: Executor start was observed and committed.
- `POST_EXECUTOR_CAPTURE`: Executor termination is committed; capture has not
  started.
- `EVIDENCE_CAPTURING`: Core is capturing the physical workspace state.
- `VALIDATING`: one or more declared command validations are running or
  pending.
- `AWAITING_HUMAN`: a human requirement is unresolved.
- `AWAITING_AUDIT`: immutable audit inputs are complete and waiting for the
  future Auditor.
- `AUDITING`: the Auditor has actually started.
- `RECONCILING`: Core cannot safely determine the next action without
  reconciliation.

Stage is persisted through V2 event facts and replayed by the Core reducer;
it is not a UI label inferred from logs.

## 8. AWAITING_AUDIT semantics

The official pre-Auditor boundary is:

```text
Attempt:
  disposition = OPEN
  stage       = AWAITING_AUDIT

Task:
  disposition      = READY
  activity         = IDLE
  owner            = NONE
  hold             = NONE
  currentAttemptId = attemptId
```

`AWAITING_AUDIT` is not Auditor activity. It does not create a Finding and it
does not mark the Task complete. The Scheduler still observes the OPEN
Attempt globally and dispatches no other Task in Sequential V1.

Only a committed `audit.started` fact changes the Attempt to `AUDITING` and
the Task activity/owner to `AUDITING`/`AUDITOR`. This keeps future Dashboard
projections truthful: it may display an audit-wait state, but it may not
claim that the Auditor is active before that event.

## 9. Sequential Scheduler invariant

Operational V1 is sequential only:

```text
number of OPEN Attempts in a Run must be 0 or 1
```

Any OPEN Attempt prevents dispatch of another Task, including an Attempt in
`AWAITING_AUDIT` while its Task is `READY` and `IDLE`.

The Scheduler is deterministic and Core-owned. It evaluates, in order:

1. Run resumability and terminality;
2. global RunHold;
3. global OPEN Attempt barrier;
4. eligible Phases and satisfied Phase dependencies;
5. plan order;
6. Task disposition and hold;
7. satisfied Task dependencies;
8. checkpoint, control-plane, and workspace validity;
9. Attempt retry budget and other declared budgets.

`parallelSafe: true` does not require parallel dispatch in V1. The runtime
executes safely and deterministically one Task at a time. `parallelSafe: false`
remains a hard plan restriction and cannot be ignored by a future parallel
implementation.

## 10. Operational event V2 vocabulary

The V2 ledger contains the Foundation event vocabulary expressed under the V2
envelope plus these operational facts:

```text
executor.dispatch-authorized
executor.started
executor.finished
evidence.capture-started
evidence.captured
validation.started
validation.completed
attempt.human-required
attempt.audit-ready
attempt.reconciliation-required
audit.started
attempt.closed
```

There is no `executor.failed` event. Executor failure is represented by
`executor.finished` and its typed termination classification. There is no
`scheduler.task-selected` authority event, no UI event, and no
`phase.started`/`phase.completed` authority event.

Required transition semantics:

| Event | State consequence |
|---|---|
| `attempt.started` | creates OPEN Attempt at `ADMITTED` |
| `executor.dispatch-authorized` | enters `EXECUTOR_DISPATCH_AUTHORIZED` |
| `executor.started` | enters `EXECUTOR_RUNNING` |
| `executor.finished` | enters `POST_EXECUTOR_CAPTURE` |
| `evidence.capture-started` | enters `EVIDENCE_CAPTURING` |
| `evidence.captured` | seals EvidenceCapture |
| `validation.started` | enters or remains `VALIDATING` |
| `validation.completed` | records one ValidationRun result |
| `attempt.human-required` | enters `AWAITING_HUMAN` and sets human hold |
| `attempt.audit-ready` | enters `AWAITING_AUDIT` and applies the idle Task boundary |
| `audit.started` | enters `AUDITING` and assigns Task activity/owner to Auditor |
| `attempt.reconciliation-required` | enters `RECONCILING` and sets reconciliation hold |
| `attempt.closed` | closes the Attempt using a V2 closure reason |

`attempt.audit-ready` must bind at least:

- envelope `runId`, `phaseId`, `taskId`, and `attemptId`;
- `evidenceSetId` and `evidenceDigest`;
- `validationSetDigest`;
- `postExecutorFingerprint`;
- `criterionSetDigest`;
- `auditability` classification;
- deterministic validation summary;
- `auditPackageDigest`.

### Hold authority and atomic transitions

For a condition originating inside an Attempt, the Attempt-specific event is
the single authoritative event for that transition. The V2 reducer applies
all correlated Attempt, Run, and Task effects atomically.

`attempt.human-required` atomically produces:

```text
Attempt.stage = AWAITING_HUMAN
Run.hold       = HUMAN_REQUIRED
```

and the corresponding Task hold/state projection required by this boundary.
It does not require a second `run.hold-set` event.

`attempt.reconciliation-required` atomically produces:

```text
Attempt.stage = RECONCILING
Run.hold       = RECONCILIATION_REQUIRED
```

and the corresponding Task hold/state projection required by this boundary.
It does not require a second `run.hold-set` event.

`run.hold-set` remains valid for global hold causes that have no
Attempt-specific event responsible for the same transition. The Core must not
depend on an ordering such as an Attempt event followed by a possibly missing
`run.hold-set`, or the reverse. One semantic cause has one authoritative event
and one atomic reduction.

`run.hold-cleared` is Core-owned and may clear a Hold only after the condition
that caused it has been resolved or proven resolved according to this
contract. Clearing `HUMAN_REQUIRED` does not imply validation PASS, Attempt
closure, or Task completion. The Attempt resumes from its persisted lifecycle
without reexecuting the Executor by default. Clearing
`RECONCILIATION_REQUIRED` requires explicit, proven reconciliation; the
reconciliation algorithm is outside this contract.

## 11. EventType × entity.kind matrix

V2 validates the following matrix strictly:

| Event type | `entity.kind` |
|---|---|
| `run.created`, `run.started`, `run.hold-set`, `run.hold-cleared`, `run.completed`, `run.failed` | `run` |
| `task.state-changed` | `task` |
| `attempt.started`, `attempt.closed` | `attempt` |
| `executor.*` | `attempt` |
| `evidence.*` | `attempt` |
| `validation.*` | `attempt` |
| `attempt.human-required`, `attempt.audit-ready`, `attempt.reconciliation-required` | `attempt` |
| `audit.started` | `attempt` |
| `finding.state-changed` | `finding` |
| `workspace.checkpointed`, `workspace.drift-detected` | `workspace` |

The `eventType × entity.kind` cross-check is mandatory in V2 from the first
implementation slice. The normative matrix above is enforced by the V2
schema/reducer, and any mismatch fails closed. This requirement is not
deferred by the Foundation V1 follow-up list; only retrofitting the same
cross-check into the frozen V1 schema remains outside V2 scope.

For an Attempt event, `entity.id` must equal `attemptId`, and its Task and
Phase relation must match the persisted Attempt. Validation and evidence
identities remain typed payload references because they are artifacts owned by
the Attempt, not new event entity kinds.

## 12. Executor dispatch authorization

Before calling any Executor, Core must verify:

- Run is active and resumable;
- RunHold is `NONE`;
- Scheduler eligibility is true;
- all Phase and Task dependencies are satisfied;
- retry budget allows the Attempt;
- expected control-plane fingerprint is unchanged;
- current product fingerprint is valid;
- accepted checkpoint and Attempt base fingerprint agree;
- no foreign or incomplete active Attempt exists;
- ledger, snapshot, artifact storage, and lease state are valid.

The ordering is:

```text
validated state
  -> exclusive Run lease
  -> re-read/revalidate state and fingerprints
  -> attempt.started committed
  -> executor.dispatch-authorized committed
  -> Executor may be called
```

No executable dispatch path may exist before the exclusive Run lease is
enforced.

`invocationId` is Core-owned, stable for the invocation attempt, and persisted
in `executor.dispatch-authorized`. Provider idempotency capability may be
recorded but cannot replace Core recovery rules.

## 13. Crash ambiguity and reconciliation rules

Filesystem event commits and OS/provider invocation are not one transaction.

After `executor.dispatch-authorized` is committed, a crash before
`executor.started` leaves an invocation ambiguity. Core must inspect the lease,
supervisor/process identity, invocation identity, workspace fingerprint, and
provider capability when available.

Core may continue only if it can prove that the invocation did not occur, can
reattach to a known live invocation, or can prove a known terminal outcome.

If it cannot prove which case applies:

```text
Attempt.stage = RECONCILING
RunHold       = RECONCILIATION_REQUIRED
```

Blind Executor retry is prohibited. A scripted test Executor may provide an
explicit deterministic invocation guarantee; that guarantee is test fixture
behavior and is not a provider assumption.

After known Executor termination, Core never calls the Executor again merely
because Evidence or Validation has not completed.

## 14. Resume matrix by Attempt state

| Attempt state | Resume result |
|---|---|
| `ADMITTED` | `READY_TO_RESUME`; revalidate admission and authorize dispatch |
| `EXECUTOR_DISPATCH_AUTHORIZED` | `RECONCILIATION_REQUIRED`, unless non-invocation is proven |
| `EXECUTOR_RUNNING` | reattach/monitor if known alive; ambiguity is reconciliation |
| `POST_EXECUTOR_CAPTURE` | continue capture only after quiescence and stable workspace are proven |
| `EVIDENCE_CAPTURING` | resume idempotent capture; incomplete or inconsistent capture requires reconciliation |
| `VALIDATING` | resume pending validations only; preserve committed ValidationRuns and never rerun Executor |
| `AWAITING_HUMAN` | `HUMAN_REQUIRED`; wait for Core-owned human resolution |
| `AWAITING_AUDIT` | `READY_TO_RESUME`; next operation is future Auditor start |
| `AUDITING` | future Auditor recovery or reconciliation; never blind-retry the Auditor |
| `RECONCILING` | `RECONCILIATION_REQUIRED` |

Run terminality, global holds, control-plane violations, fingerprint mismatch,
and storage-integrity failure override optimistic stage continuation.

An Attempt with `AttemptDisposition = CLOSED` is terminal and not dispatchable.
`CLOSED` is not an AttemptStage and does not constitute a stage from which the
resume matrix re-enters the lifecycle.
## 15. Attempt closure reasons

The V2 closure reason enum is closed:

```text
AUDIT_ACCEPTED
AUDIT_REJECTED
EXECUTOR_UNAVAILABLE
EXECUTOR_PROCESS_FAILURE
EXECUTOR_TIMED_OUT
EXECUTOR_CANCELLED
EXECUTOR_PROTOCOL_FAILURE
VALIDATION_INFRASTRUCTURE_EXHAUSTED
CONTROL_PLANE_VIOLATION
RECONCILIATION_REQUIRED
CANCELLED_AT_BOUNDARY
BUDGET_EXHAUSTED
```

`VALIDATION_SEMANTIC_FAILURE` is deliberately not a normal closure reason.
It remains an Attempt hard-negative and proceeds to `AWAITING_AUDIT` when
physical evidence is valid.

`EXECUTOR_PROCESS_FAILURE` and `EXECUTOR_TIMED_OUT` are used for outcomes that
are not sufficiently auditable. A non-zero exit or timeout with quiescence,
stable workspace, intact control plane, and capturable evidence may instead
remain OPEN and become audit-ready with a negative/partial Executor result.

`CONTROL_PLANE_VIOLATION` never authorizes normal Auditor review. It sets
reconciliation hold and does not silently restore `.rb/**`.

## 16. Executor auditability taxonomy

Executor termination and auditability are independent dimensions:

```text
AUDITABLE
NOT_AUDITABLE
RECONCILIATION_REQUIRED
```

`AUDITABLE` means that sufficient physical evidence exists for future review;
it does not mean that the Task succeeded.

| Condition | Auditability |
|---|---|
| exit zero, quiescent process tree, stable workspace, intact control plane | `AUDITABLE` |
| non-zero exit with stable workspace and complete capture | `AUDITABLE` hard-negative |
| timeout with confirmed quiescence and stable workspace | `AUDITABLE` partial |
| malformed typed result but independently verifiable workspace and termination | `AUDITABLE` partial; claims rejected |
| provider unavailable before real invocation | `NOT_AUDITABLE` |
| cancellation before useful execution/evidence | `NOT_AUDITABLE` |
| process or descendant state ambiguous | `RECONCILIATION_REQUIRED` |
| control-plane mutation | `RECONCILIATION_REQUIRED` |
| post-executor fingerprint cannot be safely captured | `RECONCILIATION_REQUIRED` |

## 17. Validation kinds

The real `rb-execution/v1` task contract declares validation as one of:

```text
COMMAND
MANUAL
HUMAN
```

These kinds are distinct from `rb-operational/v1` command instructions.

### ValidationSpec

`ValidationSpec` is a Core-owned descriptor derived from a validated
`rb-execution/v1` validation declaration in the read-only plan.

It contains, conceptually:

- `validationSpecId`;
- declared ordinal/order;
- `kind`: `COMMAND`, `MANUAL`, or `HUMAN`;
- the original normalized declarative instruction;
- identity/digest;
- source Task and plan identity.

For `COMMAND`, the exact authorized command text is preserved. For `MANUAL`,
the manual instruction is preserved and is not transformed into a command. For
`HUMAN`, the human instruction is preserved and is not transformed into a
command.

ValidationSpec is derived from the plan and is read-only from the perspective
of Executor/provider code. The Executor or provider does not create or alter
it. No `argv` is invented for a `rb-execution/v1` command declaration.

### COMMAND

Core-owned deterministic validation executed by `ValidationRunner` according
to the plan declaration.

### MANUAL

Not executed by the command runner. It remains a requirement that is not
semantically proven for the future Auditor. It is never auto-PASS or
auto-`NOT_APPLICABLE`.

### HUMAN

Requires human intervention and human evidence. It sets `RunHold =
HUMAN_REQUIRED` and `AttemptStage = AWAITING_HUMAN`. It cannot produce an
automatic PASS.

## 18. Validation semantic failure

A command validation that returns a semantic negative is a hard-negative.

When safe, Core executes the remaining applicable command validations and
preserves the complete ValidationSet. If workspace and control-plane capture
are valid, Core emits `attempt.audit-ready` with an auditable negative or
partial summary.

The Attempt remains OPEN. The future Auditor receives the complete Evidence,
ValidationSet, and hard-negative. No optimistic Executor claim can override
the deterministic failure, and Auditor cannot turn that failure into PASS.

## 19. Validation infrastructure failure

Infrastructure failure is not semantic validation failure. Examples include
runner unavailable, spawn failure, capture failure, timeout of the runner, or
runner cancellation.

Core may retry the Validation in the same Attempt using a new ValidationRun,
provided that the workspace still equals `postExecutorFingerprint` and the
control plane is unchanged.

If the validation-infrastructure retry budget is exhausted:

```text
Attempt.disposition = CLOSED
closureReason       = VALIDATION_INFRASTRUCTURE_EXHAUSTED
Task.hold           = RETRY_BUDGET_EXHAUSTED
```

This outcome is not hidden as a test failure and does not invoke the Executor
again.

## 20. Validation retry identity

A Validation retry preserves:

- `runId`;
- `phaseId`;
- `taskId`;
- `attemptId`;
- EvidenceCapture identity and digest;
- `postExecutorFingerprint`;
- ValidationSpec identity and digest.

Each retry creates a new:

- `validationRunId`;
- `validationRunOrdinal`;
- start/end timestamps;
- diagnostic references;
- outcome.

Validation retry does not create a new Executor Attempt and does not consume
the Executor Attempt budget.

Validation cache is deferred. If introduced later, its key must include:

```text
validatorSpecDigest
+ workspaceFingerprint
+ relevantScopeInputDigest
+ runtimeIdentity
```

## 21. Command execution policy

`rb-execution/v1` declares `command` as text. The text is preserved exactly,
validated, digest-linked, and is not naively tokenized.

The effective shell/runtime is selected by an explicit Run policy and recorded
in the immutable runtime/environment descriptor. There is no unrecorded
implicit shell selection.

Defaults and constraints:

- CWD defaults to the Run workspace root.
- `rb-execution/v1` does not gain the `cwd`/`argv` fields from
  `rb-operational/v1`.
- stdin is closed by default.
- environment inheritance is allowlisted and minimal.
- raw secrets never enter snapshots, events, or diagnostics.
- timeout is finite and comes from the captured Run policy.
- process groups and descendants are supervised.
- network and external tools are denied unless explicitly granted by
  capability policy.
- long-running services and watchers remain invalid.

When a separate contract supplies structured `argv`, that `argv` is executed
directly. `rb-operational/v1` is not converted into this text-command model.

## 22. Run lease contract

The exclusive Run lease is stored conceptually under:

```text
.rb-harness/ralph/runs/<run-id>/locks/
```

The lease artifact contains at least:

```text
leaseSchema
leaseId
runId
ownerProcessIdentity
hostIdentity
runtimeIdentity
acquiredAt
heartbeat
renewedAt
```

Acquisition uses exclusive creation and restricted permissions. A lease is
operational exclusion, not semantic state. It is not an event, does not enter
the workspace product fingerprint, and cannot invent or override state.

No executable Executor dispatch path exists before a valid exclusive lease is
held.

## 23. Lease recovery rules

Resume ordering is:

1. validate ledger and snapshot;
2. replay state;
3. validate fingerprints and artifact storage;
4. acquire or recover the exclusive lease;
5. reread and revalidate state and fingerprints;
6. allow scheduling or dispatch.

Committed events remain committed if the lease is lost. Lease loss prevents
new dispatch and leads to a safe pause or reconciliation decision.

A stale lease may be removed only when Core proves that the holder is no
longer valid, including process-start identity and descendant-process state
when available. PID absence alone does not prove a stale lease because of PID
reuse.

If holder validity or descendant ownership is ambiguous, Core must use
`RECONCILIATION_REQUIRED` or `HUMAN_REQUIRED`. It must never start a second
Scheduler or Executor in the same Run.

## 24. Control-plane and Git position

`.rb/**` remains control-plane content protected by the Foundation
fingerprint. A mutation is fail-closed, is not a normal validation failure,
and never becomes audit-ready.

`.git/**` remains outside the Foundation workspace fingerprint contract. This
contract does not add `.git/**` to that fingerprint.

Future Executor policy must deny implicit branch changes, publication commits,
pushes, and silent Git control-plane mutations. A future VCS guard may observe
HEAD, branch, and index for diagnostics or admission protection, but it is not
a competing semantic authority.

There is no silent `.rb/**` auto-restore.

## 25. EvidenceCapture

`EvidenceCapture` is Core-owned, content-addressed where practical, sealed
immediately after post-Executor workspace capture, and immutable.

It binds:

- `runId`, `phaseId`, `taskId`, `attemptId`;
- `attemptBaseFingerprint`;
- `postExecutorFingerprint`;
- authoritative changed-path manifest;
- before/after file hashes and metadata;
- optional diff/patch diagnostic references;
- Scope/Covers assessment;
- control-plane assessment;
- ExecutorResult reference and digest;
- command/result diagnostic references;
- creation timestamp;
- EvidenceCapture digest.

Executor-reported changed paths are observations only. Core derives changed
paths from independent before/after workspace snapshots and fingerprints.

The physical workspace and Core-captured fingerprints remain the authority.
EvidenceCapture is the immutable proof package supplied to future Auditor
logic, not a replacement for the workspace.

## 26. ValidationSet

`ValidationSet` is a separate immutable artifact. It contains the ordered
ValidationSpec identities and references to the committed ValidationRuns,
including semantic failures, infrastructure outcomes, manual requirements,
and human requirements.

It is sealed when applicable validations have completed or when a Core-owned
terminal validation-infrastructure outcome prevents completion. A later retry
creates a new ValidationRun and a new sealed ValidationSet version/reference;
it does not mutate an already sealed artifact.

The EvidenceCapture digest and `postExecutorFingerprint` remain stable across
Validation retries.

## 27. AuditPackage

`AuditPackage` is a third immutable artifact. It references:

- EvidenceCapture ID and digest;
- ValidationSet ID and digest;
- plan and context references;
- acceptance/criterion set digest;
- post-Executor fingerprint;
- auditability classification;
- deterministic validation summary;
- package creation timestamp and digest.

`attempt.audit-ready` is legal only when the AuditPackage is complete and
verifiable. It references the package without rewriting EvidenceCapture or
ValidationSet.

No Finding is created merely by constructing an AuditPackage.

## 28. DiagnosticsPolicy

Every operational Run has a digest-linked `DiagnosticsPolicy` descriptor that
defines at least:

- bounded stdout/stderr limits;
- total output limit;
- truncation marker semantics;
- retention policy;
- redaction boundary;
- safe metadata allowlist;
- artifact/reference policy.

Unlimited diagnostics capture is never an implicit default. Raw secrets are
redacted before persistence and are not part of semantic state.

## 29. EnvironmentPolicy

Every operational Run has a digest-linked `EnvironmentPolicy` descriptor
that defines at least:

- inherited environment allowlist;
- injected variable rules;
- secret references without raw secret values;
- CWD policy;
- stdin policy;
- network and tool capabilities;
- runtime identity.

Concrete policy values may be supplied by a later Wizard/runtime policy, but
the effective descriptor must be bound to the Run before dispatch.

## 30. V1/V2 compatibility matrix

| Concern | Foundation V1 | Operational V2 |
|---|---|---|
| Event identity | `rb-ralph-event/v1` | `rb-ralph-event/v2` |
| State identity | `rb-ralph-runtime-state/v1` | `rb-ralph-runtime-state/v2` |
| Run creation | Foundation Run | Born directly as V2 |
| Ledger | One immutable ledger | One immutable ledger |
| Replay | Supported and unchanged | Supports operational facts |
| Mixed event versions | Not applicable | Rejected |
| V1 ledger mutation | Forbidden | Forbidden |
| In-place V1 to V2 upgrade | Not supported | Not supported |
| Attempt operational stage | Not available in V1 | Explicit and replayable |
| Executor/Evidence/Validation facts | Not represented | Represented in V2 |
| Package version | Unchanged | Unchanged |

V1 consumers continue to read V1 Runs. V2 consumers must preserve V1 replay
compatibility without silently upgrading V1 artifacts.

## 31. Hard invariants

The following are normative:

- A Run has exactly one authoritative event ledger.
- A Run never mixes event schema versions.
- V1 ledgers are never mutated to become V2.
- Operational Runs are born as V2.
- The Core reducer is the sole semantic transition authority.
- The Scheduler is Core-owned.
- Sequential V1 permits at most one OPEN Attempt globally.
- Any OPEN Attempt prevents dispatch of another Task.
- `AWAITING_AUDIT` is not Auditor activity.
- `AWAITING_AUDIT` keeps Task `READY / IDLE / NONE / NONE`.
- Only `audit.started` changes activity/owner to `AUDITING / AUDITOR`.
- Executor is callable only after durable `attempt.started` and
  `executor.dispatch-authorized`.
- Ambiguous Executor invocation is never blindly retried.
- Provider claims are not workspace authority.
- Control-plane mutation never becomes audit-ready.
- Validation semantic failure is a hard-negative but remains audit-ready when
  physical evidence is valid.
- Validation infrastructure failure is not semantic failure.
- Validation retry stays in the same Attempt.
- HUMAN validation cannot auto-pass.
- MANUAL validation cannot auto-pass.
- EvidenceCapture is immutable.
- ValidationSet is immutable.
- AuditPackage is immutable.
- Run lease is operational exclusion, not semantic authority.
- Lease ownership never overrides event/state authority.
- PID absence alone does not prove a stale lease.
- Dashboard owns zero semantics.
- Provider owns zero semantic transitions.

## 32. Foundation V1 deferred follow-ups — outside V2 implementation scope

The following items remain deferred only for the frozen Foundation V1. They do
not defer, weaken, or replace the mandatory V2
`eventType × entity.kind` cross-check defined in Section 11.

The following are outside this contract's first implementation:

- real provider adapters;
- real Auditor and Finding creation flow;
- Dashboard and CLI `--ralph`;
- parallel execution and worktrees;
- provider sandbox implementation;
- full ProcessSupervisor integration for external provider processes;
- validation cache;
- automatic correction loop and no-progress circuit breaker;
- publication commits, branch management, and push;
- silent control-plane restoration;
- Foundation V1 eventType × entity.kind retrofitting;
- Foundation V1 resume diagnostic-code preservation;
- Foundation V1 quarantine rename;
- Foundation V1 glob documentation;
- Foundation V1 fsync portability.

## 33. Approved implementation order

The implementation order is intentionally not a semantic requirement of the
runtime, but the following order is approved for the first implementation:

### Slice 0 — canonical contract publication

Publish this versioned contract document.

### Slice A — Core state and scheduling

- event schema V2;
- state schema V2;
- reducer V2;
- Attempt lifecycle;
- sequential Scheduler;
- no Executor invocation.

### Slice B — lease and invocation boundary

- exclusive Run lease;
- admission transaction;
- `executor.dispatch-authorized`;
- scripted Executor boundary;
- Executor invocation lifecycle.

No executable dispatch path is allowed before the lease is enforced.

### Slice C — workspace evidence

- before/after fingerprints;
- authoritative changed-path derivation;
- EvidenceCapture;
- control-plane assessment.

### Slice D — deterministic validation and audit boundary

- ValidationRunner;
- ValidationRun;
- ValidationSet;
- AuditPackage;
- `attempt.audit-ready`;
- `AWAITING_AUDIT` boundary.

A ProcessSupervisor for real external provider processes may be implemented in
a later operational/provider slice.

## Historical governance note

Foundation V1 was frozen at commit
`d1632eaf63b3d79e5f27d5a5641e539a4c5d54dd`.

This Operational V2 contract depends semantically on that frozen Foundation.
There is no implicit migration from Foundation V1 to Operational V2.

The Foundation V1 amendment is not reconstructed or modified by this
document.
