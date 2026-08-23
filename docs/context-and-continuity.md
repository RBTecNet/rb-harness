# Context, Token, and Continuity Policy

RB Harness and RB Ralph treat repository artifacts as the durable source of
truth. A provider conversation is disposable: changing from Codex to Claude,
OpenCode, or another adapter must not change the meaning of a plan or erase
accepted run history.

## Context layers

Context is disclosed progressively instead of copying the entire repository
into every prompt:

| Invocation | Required prompt content | Read on demand from the repository |
|---|---|---|
| Harness interview controller | Request, existing artifact inventory, prior normalized answers, workflow resources | Implemented project evidence and existing artifacts |
| Harness artifact writer | Accepted decisions, explicit assumptions, current artifact summary, workflow resources | Isolated project copy and compatible existing artifact tree |
| Harness artifact auditor | Request, accepted decisions, assumptions, workflow resources | Complete staged artifact tree, excluding runtime runs |
| Sequential implementation agent | Current validated phase | Declared context paths, code, tests, and prior validation evidence |
| Parallel implementation agent | Its task and enclosing phase metadata | Only the files needed for that task |
| Technical manager | Current phase and evidence paths | Actual diff, agent logs, validation log, and declared context |
| Retry | Current work item, prior manager reason, and prior validation-log path | Existing attempt evidence and current working tree |

Provider adapters use fresh, non-persistent invocations. This prevents an old
chat history from silently outranking the current specification. It also means
that every decision needed for implementation must exist in reviewed `.rb/`
artifacts, project evidence, or the current run logs.

Harness generation state lives separately at `.rb-harness/runs/<run-id>/`.
It records the request hash, selected provider/model/effort, raw answers,
accepted normalized decisions, validation state, artifact-audit batches and
their canonical fingerprints, private provider logs, and any prior artifact
revision replaced by successful publication. `rb-harness resume`
can restart an interrupted interview or generation without relying on a hidden
provider session. This state is not part of the portable artifact contract.

## Deterministic guards

RB Ralph currently enforces these bounds before trusting an LLM result:

- manifest SHA-256, readiness, path, and execution-contract validation before
  any provider call;
- task-scoped prompts for safe parallel work;
- `--max-prompt-bytes` before provider invocation;
- bounded phase attempts and bounded provider-limit waits;
- exact manager decision protocol;
- deterministic validation commands that can override an optimistic manager;
- append-only events tied to the selected plan hash;
- optional task worktrees and atomic patch integration for concurrent agents.

The prompt bound measures UTF-8 bytes, not model tokens. Tokenizers and billing
units differ by provider, so RB Ralph does not claim a cross-provider token
number that it cannot verify. Provider adapters may expose stronger native
bounds; the bundled Claude adapter supports maximum turns and a USD budget.

## Resume semantics

Run state lives at:

```text
.rb/runs/<artifact-id>-<plan-sha12>/
  events.tsv
  phases/
  prompts/
  logs/
  patches/
```

A completed phase is reused only for the same artifact ID and plan hash. If the
documentation changes, its hash changes and RB Ralph creates a separate run
identity instead of importing a possibly obsolete completion claim.

Rate-limit waits do not increment the logical attempt. Each wait is still
recorded, capped per delay, and bounded per phase. A stopped process can be run
again and recover accepted phases from `events.tsv`; it does not yet persist a
future wake-up job or resume a partially completed provider invocation.

## Long-term memory boundary

RB Memory is an optional MCP, API, and web application. Its role is to retrieve
and manage durable decisions, discoveries, checkpoints, and historical
summaries across projects and providers. It does not become an undeclared
authority over the repository.

Hosted data is partitioned by tenant. A person or team can have several
independently revocable tokens, but every such token resolves to exactly one
tenant. Project identity inside the service is the tenant plus the manifest
`project.id`; the tenant boundary is enforced before web, API, or MCP actions.

Every stored memory preserves:

- project and scope identity;
- source actor and creation/update time;
- confidence, lifecycle, importance, and supersession state;
- links to repository evidence or the decision that established the memory;
- an explicit distinction between memory kind and confidence;
- a bounded MCP content budget plus retrieval relevance signals.

Semantic retrieval is a derived layer. A local multilingual embedding model
encodes queries and memory passages; SQLite retains vectors with model identity
and content hash. Ranking blends semantic similarity with BM25, importance,
and recency after tenant/project filters. Vector data is omitted from portable
exports and can always be regenerated from canonical memory content.

Conflicting or stale memory remains visible evidence for review, not a silent
instruction. A project remains executable without the memory service because
its current contracts and decisions stay in versioned `.rb/` files.

## Not implemented yet

- provider-neutral token usage accounting;
- semantic summarization or automatic context compaction;
- durable scheduling across machine or process restarts;
- entity-link retrieval and optional cross-encoder reranking;
- named human accounts, project-level ACLs, per-token permissions, and OAuth;
- automatic extraction of candidate memories from arbitrary provider chats.

These are separate layers so they can be added without changing
`rb-execution/v1` or making generated documentation depend on RB Ralph.
