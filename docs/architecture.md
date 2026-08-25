# RB Harness Architecture

## Components

| Component | Responsibility |
|---|---|
| Standalone executable | Wizard, provider invocation, adaptive interview, isolated generation, publication, deterministic parsing, validation, hashing, evidence, and discovery |
| Workflow resources | Provider-neutral generation rules and artifact shapes loaded by the executable |
| Codex adapter | Legacy skills exposing the same workflows during migration |
| Claude adapter | Legacy commands exposing the same workflows during migration |
| Contract | Provider-neutral execution, manifest, headless init, and durable headless interview boundaries |
| RB Ralph | Optional Bash executor with manager review, deterministic gates, bounded provider waits, and isolated task parallelism |
| RB Memory | Optional provider-neutral MCP, API, web, and SQLite continuity service; not an execution dependency |

## Artifact tree

```text
.rb-harness/
  runs/<run-id>/         private Harness state, provider logs, isolated workspace, and preserved prior revision

.rb/
  rb-manifest.json       canonical machine-readable discovery document
  artifacts.tsv          generated Bash-compatible discovery projection
  init/                  greenfield project intent and initial execution plan
  context/               AS IS evidence and implemented-code documentation
  features/<slug>/       scoped requests, specs, plans, and execution plans
  reviews/<review-id>/   whole-product findings, baselines, design authority, and selected remediation
  evolutions/<slug>/     AS IS/TO BE delta, impact, preservation, migration, regression, and execution
  handoffs/              resumable interview state and temporary handoffs
  manifests/             source hashes and auxiliary provenance
  runs/                  Ralph prompts, logs, phase snapshots, patches, and append-only run events
```

The Harness provider writes only inside a private isolated workspace. The
executable validates the generated manifest and contracts before atomically
publishing `.rb` or the project-relative directory selected with `--output`.
Existing compatible documents are copied into the workspace as context, and
the replaced revision remains under `.rb-harness/runs/<run-id>/`.

RB Ralph resolves execution inputs from `rb-manifest.json`. It does not scan
for a preferred filename or assume that initial and feature plans share a
directory. `artifacts.tsv` provides the same ready execution-plan entries in a
format consumable by a pure Bash loop.

## Authority

| Concern | Authority |
|---|---|
| Intended behavior | Versioned `.rb/init`, `.rb/features`, and `.rb/evolutions` documents |
| Implemented behavior | Code, tests, manifests, CI, and `.rb/context` evidence |
| Review findings | Current evidence plus `.rb/reviews` provenance and baseline |
| Execution discovery | `.rb/rb-manifest.json` |
| Execution grammar | `rb-execution/v1` |
| Harness generation state | `.rb-harness/runs/<run-id>/state.json` |
| Hosted adaptive interview | `rb-headless-interview/v1` plus its cursor-hashed durable state root |
| Active run state | `.rb/runs/<artifact-id>-<plan-sha12>/` |
| Cross-session memory | Optional `rb-memory/v1` service, keyed by tenant plus manifest `project.id` |

## Memory layers

RB Memory is separate from generated documentation and from the Ralph loop. A
remote deployment exposes one authenticated Streamable HTTP MCP endpoint to
multiple models and computers. Local stdio is available for development, while
the web manager and JSON API operate on the same storage contract.

The first retrieval implementation combines SQLite full-text relevance,
importance, and recency. Memory records retain source, confidence, evidence,
scope, lifecycle history, and a content hash. Replacing knowledge supersedes a
record instead of deleting history; project export/import is idempotent and
fails closed on identity or hash conflicts.

The stable namespace is `(tenant, .rb/rb-manifest.json project.id)`, never a
checkout path. Consequently, a clone on another computer using a token for the
same tenant connects to the same project memory, while another tenant may use
the same project ID without seeing or overwriting it. The deployment
administrator creates tenants and revocable credentials through `/admin`.

## Harness generation layers

RB Harness is a documentation state machine, not a general agent loop. Its
stages are separated and finite:

1. The executable builds a deterministic, bounded input package: request and
   hash, workflow, a summarized inventory of the target project, existing RB
   artifacts, accepted decisions, and a compact code-owned output contract.
   Version control, dependencies, build and coverage output, live Harness
   state, credentials, and temporary files are excluded, and no path into the
   Harness source, `dist`, tests, or installation is ever shipped.
2. A read-only provider invocation returns a strict interview contract: one
   batch of at most five material questions. Valid raw JSON is accepted without
   marker lines. An invalid control response is preserved and handed to a
   closed, tool-free formatter for at most three attempts. The formatter sees
   the exact contract, deterministic parser defect, immutable raw response, and
   prior invalid formatting; discovery is never repeated solely to repair form.
3. The executable presents them locally one at a time, persists the answers,
   and runs focused follow-up rounds of at most three questions until the
   analysis converges: an answer that opens a new material decision earns
   another round, and a decision already settled is never re-asked. Two
   declared safety ceilings — at most 12 rounds and 40 questions per run — keep
   the loop finite. Reaching one is a failure to converge and produces
   `BLOCKED` naming the open decision, never a silent acceptance.
4. One writer role receives the closed checkpoint. A first invocation returns
   a compact index while running in the bounded evidence projection. Shared
   authority and IDs occur once in its coordination ledger; short part briefs
   do not repeat documentation content. Greenfield `init` skips discovery tools
   because the complete request is already in the authority package. Independent
   invocations then return document parts capped at 12 KiB from closed briefs,
   without re-exploration. Every accepted part is checkpointed. The same
   bounded formatter can serialize a malformed legacy part envelope without
   repeating part authorship. The
   orchestrator assembles the typed `path`/`content` bundle and materializes it
   into a staging tree holding only `.rb`.
5. Manifest synchronization and workflow-specific deterministic gates validate
   the staged tree. Manifest, hashes, IDs, statuses, and the TSV projection are
   derived by code, never asked of the model. Every ready `rb-execution/v1`
   plan additionally passes the decomposition gate: because RB Ralph runs one
   ephemeral, context-free call per task, ceilings read from the document's own
   declarations reject a task that carries a whole feature.
6. Repairable structural errors allow exactly one localized repair, which
   receives the ordered error list and only the affected documents and must
   preserve everything else byte for byte. Its plan runs in a closed,
   tool-free workspace so it cannot rediscover the repository or invent a
   blocker for staged files. A second failure is reported.
7. Only a tree accepted by every deterministic workflow, manifest, execution,
   operational, and tree validator is published atomically. A failed or
   explicitly blocked generation never replaces the current artifact tree.

Apart from the counted interview rounds and the single structural repair — both
bounded by declared ceilings — the state graph is acyclic and no stage can
restart itself. There is deliberately no LLM manager and no semantic auditor: material
product ambiguity belongs to the interview, artifact correctness belongs to
bounded incremental authoring plus deterministic contracts, and semantic implementation review
remains the responsibility of RB Ralph after code exists.

Materialization may canonicalize only representations that are provably
equivalent under the current contracts: legacy nested HTTP probe assertions
become the top-level `rb-operational/v1` fields, and a task dependency that
merely repeats its enclosing phase dependency is removed. Semantic ambiguity
is never canonicalized. The strict `rb-execution/v1`, `rb-operational/v1`, and
manifest validators still decide readiness.

Provider supervision applies role-specific UTF-8 byte limits (32 MiB for
generation, 16 MiB for the repair, 8 MiB for the interview) and owns the whole
process tree. *Every* run settles, including the successful ones, because a
leader exiting with code zero proves nothing about what it detached.

Containment is structural where the platform allows it. On Linux with a writable
cgroup v2 subtree the child joins a per-run cgroup before it can fork;
membership survives `fork` and `setsid`, remains enumerable after the leader
dies, and `cgroup.kill` removes every member atomically. That is what makes
quiescence provable rather than assumed — a descendant placed in a new session
milliseconds before the leader exits is invisible to any sampler and unreachable
by any process-group signal.

Where structural containment is unavailable, the ladder still runs — stop
admitting work, `SIGTERM` the process group, wait one bounded grace window,
`SIGKILL` the survivors — but the outcome is reported as *unverified* rather
than quiescent, and the provider log records the containment kind and both
flags. Windows uses `taskkill /T`, which walks the parent chain and is declared
as best-effort; it is not a Job Object and is never described as one. A
remembered descendant is re-signalled only while it still belongs to the process
group it was observed in, which keeps a recycled PID out of the ladder.
Cancellation, `SIGTERM`, timeout, output overflow, a Harness failure, and host
exit enter the same path.

Adapter control is declared, not assumed. The bundled direct-API runtime owns its
loop and enforces the tool budget locally. An external CLI is held to its own
declared capability: OpenCode's `run --format json` stream is consumed and
counted, while Codex's `exec --json` and Claude's `--output-format stream-json`
are advertised by the installed versions but not consumed, so no turn, tool, or
cost control is claimed for them. Any adapter the Harness cannot account for is
governed by conservative limits — wall timeout, first-output timeout, output
volume, and a progress window that only genuinely new output renews — and is
reported as unmeasured on that axis.

Declared byte budgets are preflight gates: the request, the input package, the
accepted decisions, and each prompt are checked before a provider process can be
created. The request is authority and is never truncated; only non-authority
detail is reduced, and every reduction is declared to the model.

Manifest synchronization derives collision-safe IDs from logical artifact
paths. It preserves short readable IDs, adds a deterministic path-hash suffix
before truncating long IDs, and hashes a later candidate when two normalized
short paths still collide. Explicit execution-plan IDs remain authoritative
and are never silently rewritten.

Durable checkpoints separate the completed interview, the received document
bundle, materialization, validation, and publication. A complete provider
response that is already persisted is never requested again, so a validation or
publication failure resumes without paying for the writer twice. Historical
audit-stage run states remain readable; their audit records are non-gating
metadata. Every run also writes `telemetry.json` with per-stage durations,
provider call counts, and the token and cache usage the provider reported —
unmeasured when the provider reports none, and never an estimated cost.

The provider-specific Codex, Claude, OpenCode, or custom adapter is an
invocation detail. It is not recorded as an execution dependency in generated
project documentation.

Hosted applications do not reproduce this controller. They call the separate
`rb-headless-interview/v1` state machine, persist only its public IDs/cursor and
render its typed events. The Harness keeps the prompt, acceptance policy,
normalization, focused follow-up logic, adapter isolation, and final conversion
to `rb-headless-init/v1` answers. The init contract remains terminal generation;
the interview contract never publishes artifacts.
When a developer request explicitly integrates RB Harness, both public
headless contract documents are added to the interview and writer contexts.
They remain external authorities rather than prose reconstructed by the
generated project documentation.

## Ralph execution layers

RB Ralph keeps responsibilities separated:

1. The resolver validates the manifest, source hash, readiness, paths, and
   `rb-execution/v1` grammar without invoking a model.
2. The scheduler selects the next pending phase and decides conservatively
   between one phase agent and bounded independent task agents.
3. In `worktree` mode, concurrent agents start from one immutable Git snapshot;
   their patches pass through an integration worktree before the primary tree.
4. Reviewed validation commands execute deterministically in the primary tree.
5. A fresh technical-manager invocation inspects repository state and evidence
   but cannot override a failed deterministic validation.
6. Append-only events make accepted phases resumable only for the unchanged
   plan hash.
7. When RB Memory is configured, Ralph retrieves a bounded advisory context
   before execution and writes a structured checkpoint after each accepted
   phase through the same MCP endpoint used by interactive LLM clients.

Provider rate limits are availability events rather than failed implementation
attempts. Waits are capped and counted separately. Other provider errors remain
ordinary failed attempts so authentication or malformed-output failures cannot
turn into an unbounded wait loop.

## Invariants

- Documentation generation is provider-neutral.
- Existing plugin-generated artifact trees remain readable without the plugin
  host, and relocated physical artifact roots preserve logical `.rb/...` paths.
- A provider cannot publish an unvalidated artifact tree directly.
- Artifact readiness is decided by deterministic contracts, not by a second
  model; the writer's completion statement is never sufficient, and neither is a
  run's own `status` field.
- A provider never reads Harness control state: one shared path policy governs
  listing, reading, searching, and link resolution, and CLI providers see only a
  bounded read-only evidence projection built in its own temporary root.
- Read confinement is claimed only where it is enforced. The bundled runtime
  enforces it in process; an external CLI is declared as not read-confined
  rather than described as isolated by the projection.
- Quiescence is claimed only where containment is structural; otherwise the
  teardown is reported as unverified.
- Ambiguity never becomes an accepted decision: a missing or unsupported
  interview disposition is a semantic defect, not a shortcut to `ACCEPTED`.
- Every stage budget is finite, documented as a constant, and covered by tests;
  raising a ceiling to make a fixture pass is not a fix.
- A deterministic implementation requirement must name a finite
  machine-checkable authority instead of delegating open-ended language
  interpretation to examples or keyword growth.
- Harness run logs and state are private runtime evidence under `.rb-harness/`;
  generated portable documentation remains under the selected artifact root.
- Only `PHASES.md` is constrained by the execution grammar; rich documents may
  use structures appropriate to their subject.
- Every execution task traces to requirements and carries binary acceptance
  criteria.
- Facts are classified as observed, confirmed, inferred, unknown, or conflict.
- Critical unknowns block readiness; low-risk assumptions stay explicit.
- All machine paths are project-root-relative and may not escape the project.
- Provider sessions are disposable; durable context lives in reviewed artifacts
  and run evidence.
- An isolated parallel patch may not change `.rb/` and may reach the primary
  tree only after all sibling patches pass integration checks. Parallel tasks
  may not modify the same path even when Git could merge both edits cleanly.
- A manager decision is necessary but insufficient when deterministic
  validation fails.
- A documentation provider is read-only and reaches only the target project.
- Cancellation, timeout, and failure leave no live provider descendant.

See [the context and continuity policy](context-and-continuity.md) for prompt
bounds, resume identity, and the RB Memory authority boundary.
