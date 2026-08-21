# RB Harness Architecture

## Components

| Component | Responsibility |
|---|---|
| Core CLI | Deterministic parsing, validation, hashing, evidence, and discovery |
| Codex adapter | Skills for `/init`, `/ai-context`, and `/plan` workflows |
| Claude adapter | Commands and agents implementing the same workflows |
| Contract | Provider-neutral `PHASES.md` grammar and artifact manifest |
| RB Ralph | Optional Bash executor with manager review, deterministic gates, bounded provider waits, and isolated task parallelism |
| RB Memory | Optional provider-neutral MCP, API, web, and SQLite continuity service; not an execution dependency |

## Artifact tree

```text
.rb/
  rb-manifest.json       canonical machine-readable discovery document
  artifacts.tsv          generated Bash-compatible discovery projection
  init/                  greenfield project intent and initial execution plan
  context/               AS IS evidence and implemented-code documentation
  features/<slug>/       scoped requests, specs, plans, and execution plans
  handoffs/              resumable interview state and temporary handoffs
  manifests/             source hashes and auxiliary provenance
  runs/                  Ralph prompts, logs, phase snapshots, patches, and append-only run events
```

RB Ralph resolves execution inputs from `rb-manifest.json`. It does not scan
for a preferred filename or assume that initial and feature plans share a
directory. `artifacts.tsv` provides the same ready execution-plan entries in a
format consumable by a pure Bash loop.

## Authority

| Concern | Authority |
|---|---|
| Intended behavior | Versioned `.rb/init` and `.rb/features` documents |
| Implemented behavior | Code, tests, manifests, CI, and `.rb/context` evidence |
| Execution discovery | `.rb/rb-manifest.json` |
| Execution grammar | `rb-execution/v1` |
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

## Execution layers

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
  tree only after all sibling patches pass integration checks.
- A manager decision is necessary but insufficient when deterministic
  validation fails.

See [the context and continuity policy](context-and-continuity.md) for prompt
bounds, resume identity, and the RB Memory authority boundary.
