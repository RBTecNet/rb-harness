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

RB Harness keeps generation responsibilities separated:

1. The executable inventories existing compatible artifacts and Ralph evidence.
2. A read-only provider invocation returns a strict interview contract.
3. The executable accepts, rejects, or follows up on answers one question at a
   time and persists the normalized checkpoint.
4. A fresh provider invocation receives that checkpoint and writes only in an
   isolated project copy.
5. Manifest synchronization and workflow-specific deterministic gates validate
   the staged tree.
6. A fresh read-only artifact auditor inspects the whole tree, returns one
   structured batch grouped by invariant, and rejects ambiguous RIGID rules,
   mechanism/requirement mismatches, contradictions, missing authority,
   untraceable criteria, or over-broad tasks.
7. A rejected draft receives the complete audit as a bounded repair handoff.
   Canonical finding fingerprints stop an unchanged root-cause loop, and three
   unsuccessful passes block publication.
8. Only a structurally valid, independently audited tree is published
   atomically; a failed generation never replaces the current artifact tree.

Provider supervision applies role-specific UTF-8 byte limits (128 MiB for the
agentic writer, 32 MiB for interview and audit) and remembers descendant PIDs
before termination. It signals both the provider process group and descendants
that created nested sessions, then escalates to `SIGKILL`; output overflow and
timeouts therefore cannot leave sandboxed tools orphaned.

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
headless contract documents are added to the interview, writer, and auditor
contexts. They remain external authorities rather than prose reconstructed by
the generated project documentation.

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
- Artifact readiness requires an independent fresh-context audit; the writer's
  completion statement is never sufficient.
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

See [the context and continuity policy](context-and-continuity.md) for prompt
bounds, resume identity, and the RB Memory authority boundary.
