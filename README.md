# RB Harness

RB Harness is a provider-neutral documentation harness for new and existing
software projects. It turns project evidence and short developer interviews
into grounded context, specifications, plans, and execution documents that can
be handed directly to an LLM or consumed by RB Ralph.

The repository contains:

- `packages/core/` — deterministic TypeScript CLI for contracts, manifests,
  source hashes, staleness, and repository evidence.
- `plugins/rb-harness/` — Codex skills and Claude Code commands/agents.
- `contracts/` — versioned execution and artifact-tree contracts.
- `tests/fixtures/` — shared valid and invalid contract examples.

Start with the [usage tutorial](docs/how-to-use.md).

The harness is framework- and language-agnostic. Laravel, Node.js, Python,
mobile, CLI, data, infrastructure, and mixed repositories use the same
artifact and execution contracts; project-specific capabilities are documented
only when evidence or the developer requires them.

## Workflows

The conceptual workflows are `init`, `ai-context`, and `plan`. Host adapters
expose them using their native command conventions:

| Workflow | Codex skill | Claude Code command | Result |
|---|---|---|---|
| New project | `$rb-init <text or @file>` | `/rb-harness:init <text or @file>` | Project intent and initial plan under `.rb/init/` |
| Existing project | `$rb-ai-context [path]` | `/rb-harness:ai-context [path]` | Evidence-grounded AS IS context under `.rb/context/` |
| Scoped change | `$rb-plan <text or @file>` | `/rb-harness:plan <text or @file>` | Request, spec, plan, and execution view under `.rb/features/<slug>/` |

`init` and `plan` accept free text, `@path`, `--file path`, or an existing bare
file path. `ai-context` inspects the repository before interviewing. Balanced
mode asks at most five questions in its first batch and up to three material
follow-ups; quick and deep modes change the risk threshold without turning the
workflow into a generic questionnaire.

Each workflow generates documentation only. The resulting documents can be
sent directly to any capable coding CLI/model or selected by RB Ralph; neither
path is embedded into the documentation.

## Development

```sh
npm install
npm run build
npm run check
```

After the build, the distributable CLI is bundled at
`plugins/rb-harness/scripts/rb-harness.cjs`.

## Deterministic CLI

```sh
node plugins/rb-harness/scripts/rb-harness.cjs contract validate <PHASES.md>
node plugins/rb-harness/scripts/rb-harness.cjs contract inspect <PHASES.md> --format tsv
node plugins/rb-harness/scripts/rb-harness.cjs contract extract <PHASES.md> --phase P01
node plugins/rb-harness/scripts/rb-harness.cjs project init . --name "My Project"
node plugins/rb-harness/scripts/rb-harness.cjs manifest sync .
node plugins/rb-harness/scripts/rb-harness.cjs tree validate .
node plugins/rb-harness/scripts/rb-harness.cjs tree resolve . --format tsv
node plugins/rb-harness/scripts/rb-harness.cjs inspect .
```

`tree resolve --format tsv` reads `.rb/rb-manifest.json` and emits a stable,
Bash-friendly list of ready execution plans. RB Ralph can consume that output
without inferring the artifact layout.

## RB Ralph discovery contract

`.rb/rb-manifest.json` is authoritative. `.rb/artifacts.tsv` is its generated
shell projection with this stable header:

```text
id  kind  status  contract  path  sha256
```

The fields are tab-separated. The bundled resolver validates the complete
manifest, the current file hashes, the declared readiness, and every execution
document before emitting any ready plan:

```bash
while IFS=$'\t' read -r id kind status contract path sha256; do
  case "$id" in
    \#*|id) continue ;;
  esac

  # Give "$path" to the selected executor only when the supported contract
  # and expected SHA-256 have been accepted by the run manager.
done < <(plugins/rb-harness/scripts/rb-resolve.sh .)
```

RB Ralph therefore does not need to know whether a plan came from `init` or a
feature directory. It consumes only entries with kind `execution-plan`, status
`ready`, and contract `rb-execution/v1`. Unknown contract versions, stale
hashes, invalid task grammar, unsafe paths, and readiness mismatches fail
closed before an LLM is started.

With [RB Ralph](https://github.com/RBTecNet/rb-ralph) installed, preview the
first execution schedule without invoking a provider:

```bash
rb-ralph --project /path/to/project --list
rb-ralph --project /path/to/project --plan <artifact-id> --dry-run
```

The execution loop includes Codex and Claude adapters, supports different
providers for implementation and management, and runs deterministic validation
commands before accepting manager approval. Independent parallel-safe tasks can
use bounded concurrent agents; optional Git worktrees isolate their changes and
fail closed when patches conflict. Provider-limit waits do not consume logical
attempts, prompts have a configurable byte guard, and accepted phases resume
only for the unchanged plan hash. Unsafe or interdependent work falls back to a
sequential phase agent. Custom executable adapters remain available through the
same stdin contract. A default runtime-only `RBF` phase then performs
consumer-level clean-room acceptance. An optional `rb-operational/v1`
`OPERATIONS.json` makes that proof deterministic across desktop, CLI, library,
service, web, plugin, package, job, and other product forms without coupling
the documentation to Ralph. See
[the RB Ralph guide](https://github.com/RBTecNet/rb-ralph) and
[the adapter contract](contracts/rb-provider-adapter-v1.md).

See [the architecture](docs/architecture.md),
[the context and continuity policy](docs/context-and-continuity.md),
[the reference analysis](docs/reference-analysis.md),
[the manifest contract](contracts/rb-manifest-v1.md), and
[the execution contract](contracts/rb-execution-v1.md), and
[the operational contract](contracts/rb-operational-v1.md) for the complete rules.

## Product boundaries

- RB Harness writes documentation, not application code.
- Generated documents never require a specific LLM or executor.
- `PHASES.md` conforms to `rb-execution/v1` regardless of how it is executed.
- `OPERATIONS.json` conforms to `rb-operational/v1` and remains usable by a
  person, CI, or direct LLM execution without RB Ralph.
- RB Ralph is an optional, separate consumer of the manifest and execution
  contract.
- [RB Memory](https://github.com/RBTecNet/rb-ia-memory) is optional; repository
  artifacts remain portable and complete without it.
