# RB Harness

RB Harness is a provider-neutral documentation harness for new and existing
software projects. It turns project evidence and short developer interviews
into grounded context, whole-product reviews, safe existing-feature evolutions,
specifications, plans, and execution documents that can be handed directly to
an LLM or consumed by RB Ralph.

The repository contains:

- `packages/core/` — standalone Node/TypeScript executable, provider adapters,
  interview controller, resumable generation, contracts, manifests, source
  hashes, staleness, and repository evidence.
- `resources/` — provider-neutral workflow instructions owned by the executable.
- `plugins/rb-harness/` — legacy Codex/Claude compatibility adapters; the
  standalone executable does not depend on a plugin host.
- `contracts/` — versioned execution and artifact-tree contracts.
- `tests/fixtures/` — shared valid and invalid contract examples.

Start with the [usage tutorial](docs/how-to-use.md).

The harness is framework- and language-agnostic. Laravel, Node.js, Python,
mobile, CLI, data, infrastructure, and mixed repositories use the same
artifact and execution contracts; project-specific capabilities are documented
only when evidence or the developer requires them.

## Standalone installation

RB Harness 0.3.11 is an executable rather than a workflow that must run inside
Codex or Claude. Node.js 20 or newer is required. From the repository:

```bash
npm install
npm run build
npm install --global --prefix "$HOME/.local" ./packages/core
export PATH="$HOME/.local/bin:$PATH"
```

The installed package carries every workflow resource with it; it does not
need the repository checkout or either legacy plugin at runtime. The release
check packs the actual npm archive and executes a complete workflow through
the same symbolic `bin/rb-harness` launcher created by a user installation.

The last export belongs in `~/.bashrc`, `~/.zshrc`, or the startup file used by
the current shell. Verify the exact installed build with:

```bash
rb-harness --version
rb-harness --ver
# Both print 0.3.11
```

Run without arguments to start the wizard:

```bash
rb-harness
```

The responsive capybara splash uses the Ralph layout engine to center its
wordmark, mascot, and labels horizontally and vertically. It selects a compact
composition for small terminals and never pollutes CI or redirected logs:

```bash
rb-harness --splash
rb-harness --no-splash plan --file change.md --provider codex
RB_HARNESS_SPLASH=0 rb-harness review --project . --provider claude
```

Direct commands accept prompt text, `@file`, a bare existing file, `--file`, or
`--prompt`, plus provider-neutral model and effort selection:

```bash
rb-harness init --file project-brief.md \
  --provider codex --model gpt-5.6-sol --effort high

rb-harness plan --project /path/to/project --file change.md \
  --provider claude --model opus --effort high --output .spec

rb-harness review --project . \
  --provider opencode --model opencode/mimo-v2.5-free --effort high \
  --depth balanced --focus frontend accessibility
```

### Native API login and shared credential vault

The existing `codex`, `claude`, and `opencode` CLI providers remain unchanged.
RB Harness also includes a local tool-using runtime for direct `openai`,
`anthropic`, `gemini`, `deepseek`, `minimax`, and `openrouter` API calls. Start
the credential wizard from either RB executable:

```bash
rb-harness --login
# The same shared store is available through:
rb-ralph --login

rb-harness auth list
rb-harness auth logout deepseek:pessoal
```

Inspect the complete provider registry without exposing secrets, or verify one
saved API credential/model with a single bounded `PING`/`PONG` request. Neither
command starts a Harness workflow, creates run state, or writes artifacts:

```bash
rb-harness provider list
rb-harness provider list --json

# Interactive: choose a configured provider/credential, model, effort and timeout
rb-harness provider test

# Non-interactive equivalent
rb-harness provider test \
  --provider deepseek --model deepseek-v4-pro \
  --credential pessoal --timeout 60
```

`provider list` distinguishes external CLI login, per-command custom adapters,
configured native APIs, and native APIs without credentials. Its JSON contract
is `rb-provider-list/v1`. `provider test --json` emits
`rb-provider-test/v1`, including provider/model, credential ID, protocol,
latency, bounded reply text, PONG recognition, and token usage when reported.
Only safe credential metadata is returned, including which entry is the
provider default; keys and OAuth tokens remain in the vault.
When `provider test` is called without both `--provider` and `--model` in a
terminal, its wizard lists only configured direct APIs, chooses among saved
credentials without revealing their secrets, asks for model, optional effort
and timeout, prints the equivalent command, and asks before sending the probe.
Outside an interactive terminal, provider and model remain mandatory. The
wizard is intentionally unavailable with an incomplete `--json` command so
machine output always remains valid JSON.
`--credential` accepts the displayed full ID, the original label, or its
normalized slug (for example, all of `deepseek:deepseek-api-oficial`,
`DeepSeek Api Oficial`, and `deepseek-api-oficial`).

The wizard first lists providers and then only the authentication protocols
implemented for that provider. API-key input is hidden. OpenRouter OAuth uses
Authorization Code with PKCE, a random localhost callback, and a browser link.
Gemini OAuth uses Google Application Default Credentials, requires `gcloud`
and a desktop OAuth client JSON, and opens Google's login flow. Direct OpenAI
and Anthropic end-user browser OAuth is not advertised: their documented API
authentication is API key or workload identity, not a reusable “Sign in with
ChatGPT/Claude” grant for third-party CLI calls. Codex CLI and Claude Code keep
managing their own logins independently.

Secrets are never accepted in command arguments, required environment
variables, profiles, provider logs, generated artifacts, or dashboard state.
Credential metadata and AES-256-GCM ciphertext live in the shared per-user RB
configuration directory with `0700`/`0600` permissions; the local vault key is
stored separately with `0600`. This protects against accidental plaintext
disclosure but is not an OS-account boundary: a process already running as the
same user can access both files. Use a dedicated OS account or external secret
manager when that threat matters.

Multiple labeled credentials can coexist. The provider default is used when
there is only one/default entry; `--credential` selects another without
revealing its secret:

```bash
rb-harness review --project . --provider deepseek \
  --model deepseek-v4-pro --effort high --credential pessoal --dashboard

rb-harness plan --file change.md --provider openrouter \
  --model anthropic/claude-sonnet-4.6 --credential testes
```

Direct APIs are models, not filesystem agents. The bundled runtime supplies a
bounded local tool loop. Interview calls are read-only. Generation runs inside
the existing isolated snapshot and can write only `.rb/`; manifest sync,
deterministic validation, and atomic publication remain owned by the Harness.
Direct providers require an explicit provider
model ID, and unsupported effort values fail at the provider instead of being
silently discarded.

### Live Harness dashboard

Add `--dashboard` to a workflow or resume command. The dashboard uses the same
terminal design language as Ralph while keeping Harness-specific stages:
interview, one artifact generation, contract validation, and atomic
publication. It shows the active role, model, elapsed time, first-output
latency, observed bytes, recent events, and terminal diagnostic. It never
includes the request, interview answers, provider output, or credentials.
During an interactive question the panel yields the terminal and resumes after
the answer.

```bash
rb-harness evolve --project . --file change.md \
  --provider codex --model gpt-5.6-sol --effort high --dashboard

rb-harness resume --project . --dashboard
```

The Harness has no execution profiles. Its command remains short; reusable
profiles belong only to RB Ralph, whose operational command has many more
controls.

The selected model returns a structured gap analysis. The executable queues
any question batch and presents one question at a time, classifies every answer
as `ACCEPTED`, `PARTIAL`, `AMBIGUOUS`, `DEFERRED`, or `CONTRADICTED`, and
requires focused follow-up for material ambiguity before generation. Use
`--questions batch` only to announce the whole round before answering it.

Generation is not trusted on self-declaration, but the Harness does not use a
second LLM as a documentation manager. The interview must resolve material
product ambiguity before generation; then one fresh writer produces the whole
tree. Manifest, workflow, execution, operational, and tree validators are the
publication gates. A RIGID rule still cannot ask deterministic code to infer
unlimited natural-language meaning unless the documentation names an exact
grammar, typed authority, finite matrix, or explicit classifier and failure
contract. If the writer emits `BLOCKED.md`, a blocked plan, stale hashes, an
invalid contract, or no ready output for the selected workflow, publication
fails with the exact deterministic diagnostic instead of starting a repair
loop.

Historical runs that stopped in the removed audit stage remain resumable. A
complete staged workspace is revalidated and published without another
provider call; old audit records remain historical metadata and no longer gate
the result.

Every generation uses an isolated source copy and a staging `.rb` tree. The
writer cannot publish directly. RB Harness synchronizes and validates the
manifest and contracts, then atomically swaps the selected `--output` tree.
Provider output is bounded by role: generation allows up to 128 MiB because
agentic CLIs may emit repository inspection and tool evidence, while interview
remains capped at 32 MiB. Limits are measured as UTF-8 bytes. Timeout
or output overflow terminates the complete descendant tree, including nested
sandbox sessions, before the resumable failure is recorded.

Automatic manifest IDs remain readable for ordinary paths. Long paths receive
a deterministic SHA-256 suffix before the 64-character boundary, and any
remaining normalization collision receives the same stable fallback. Manifest
sync therefore cannot silently assign one ID to two different artifacts.

The previous artifact tree remains under `.rb-harness/runs/<run-id>/` and a
power-loss interruption is resumed with:

```bash
rb-harness status --project . --output .rb
rb-harness resume --project .
rb-harness resume <run-id> --project .
```

When a writer has already completed but deterministic manifest or contract
validation fails, the private workspace remains checkpointed. Resume
revalidates that exact staged tree and proceeds to publication without paying
for a second writer call. The workspace is regenerated only when no complete
checkpoint can be proven.

On resume, the Harness also first revalidates any successful interview provider response that
was already written to the private run log. If the current protocol accepts
it and it still matches the pending-answer state, the response is reused
without spending another provider call.
When the durable interview checkpoint is already `ready` and has no pending
answer, resume skips interview analysis entirely and continues directly from
artifact generation. A writer-declared `BLOCKED.md` or blocked plan is also
reported by its artifact path instead of being collapsed into a generic
missing-output error.
Requests that integrate RB Harness itself receive the public
`rb-headless-init/v1` and `rb-headless-interview/v1` authorities in the
interview and writer contexts. Hosted products therefore
cannot silently document generation while omitting the adaptive question and
answer boundary.
Interview adapters may omit `options` for `text` and `confirm` questions; the
Harness normalizes the field to an empty list. Only `single-choice` questions
may carry two to six choices, preventing protocol repair from inventing a
choice for an intentionally free-form follow-up.

Adaptive interviews have a 128-round run-wide safety ceiling (up to 1,024
distinct questions at the per-round contract limit). The completed and active
round numbers are durable, so resume continues at the correct round without
overwriting prior logs. A prior validated checkpoint is supplied as navigation
to each fresh interview call, reducing repeated repository discovery while
keeping code and tests as source authority. If input is interrupted partway
through a question batch, resume presents the unanswered questions before
starting another provider call.

Services such as RB Memory can use the same adaptive acceptance gate without
scraping the interactive terminal or copying Harness prompts. The separate
`rb-headless-interview/v1` boundary exposes durable JSON messages, one active
question, explicit recommended-option flags, focused rejection, cursor-based
resume, and idempotent answer submission:

```bash
rb-harness headless interview version
rb-harness headless interview validate < message.json
rb-harness headless interview run \
  --state /srv/rb-memory/interviews \
  --timeout 3600 --first-output-timeout 300 < message.json
```

An `interview_start` request carries a validated `rb-headless-init/v1` request
projection and a capture hash. An `answer` carries the active sequence,
question ID, cursor, and idempotency key. `interview_complete.acceptedAnswers`
is already in the exact shape accepted by `headless init`; ambiguous, partial,
contradicted, deferred, or pending answers cannot enter generation authority.
State writes are atomic, dead-PID locks recover automatically, and repeating a
committed answer returns its stored response after power loss. See
`contracts/rb-headless-interview-v1.md` for the complete machine and exit codes.

For automation, provide answers without opening a terminal:

```bash
rb-harness plan --file change.md --provider codex --non-interactive \
  --answers interview-answers.json
```

The JSON object is keyed by the stable question IDs printed by a prior blocked
non-interactive run. Missing material answers fail instead of hanging or being
invented.

Codex, Claude, and OpenCode are built in. A custom adapter is an executable
that receives the complete prompt on stdin, runs with the isolated project as
its working directory, and reads `RB_HARNESS_MODE`, `RB_HARNESS_PROJECT_ROOT`,
`RB_HARNESS_PROVIDER`, `RB_HARNESS_MODEL`, and `RB_HARNESS_EFFORT` from the
environment. New standalone runs use `RB_HARNESS_MODE=interview` and
`RB_HARNESS_MODE=generation`; only generation may write the isolated workspace.
The legacy `audit` mode remains parser-compatible for historical run state but
is never invoked by the current workflow:

```bash
rb-harness plan --file change.md --provider custom \
  --adapter /absolute/path/to/adapter --model local-model --effort high
```

The default first-output deadline is 300 seconds and the wall deadline is one
hour. While an interactive provider is quiet, the Harness emits a heartbeat so
"thinking" is distinguishable from a dead process. Override those guards with
`--first-output-timeout` and `--timeout`; zero disables the corresponding
deadline.

## Legacy plugin compatibility

Existing plugin-generated `.rb` trees, manifests, contracts, IDs, logical
paths, and relocated physical artifact directories remain supported. The
deterministic `contract`, `operations`, `project`, `manifest`, `tree`, and
`inspect` commands are unchanged. `headless init` also retains its versioned
Memory integration contract. The adaptive service boundary is additive as
`headless interview`; it does not widen or reinterpret `rb-headless-init/v1`.

The old Codex skills and Claude commands remain temporarily available as a
transition adapter, but new work should use `rb-harness` directly. To install
the legacy Claude adapter during migration:

Register the repository root as a local marketplace and install the plugin:

```bash
claude plugin marketplace add /absolute/path/to/rb-harness --scope user
claude plugin install rb-harness@rb-harness-local --scope user
```

The marketplace source must be the repository root containing
`.claude-plugin/marketplace.json`, not the nested `plugins/rb-harness` directory.

## Workflows

The workflows are `init`, `ai-context`, `review`, `evolve`, and `plan`. The
standalone executable is authoritative; legacy host adapters expose equivalent
commands during the compatibility window:

| Workflow | Standalone | Legacy Codex/Claude | Result |
|---|---|---|---|
| New project | `rb-harness init` | `$rb-init` / `/rb-harness:init` | Project intent and initial plan under `.rb/init/` |
| Existing project | `rb-harness ai-context` | `$rb-ai-context` / `/rb-harness:ai-context` | Evidence-grounded AS IS context under `.rb/context/` |
| Whole-product audit | `rb-harness review` | `$rb-review` / `/rb-harness:review` | Grounded findings and optional selected remediation under `.rb/reviews/<id>/` |
| Existing behavior evolution | `rb-harness evolve` | `$rb-evolve` / `/rb-harness:evolve` | AS IS/TO BE delta, impact, preservation, regression, and execution under `.rb/evolutions/<slug>/` |
| Scoped change | `rb-harness plan` | `$rb-plan` / `/rb-harness:plan` | Request, spec, plan, and execution view under `.rb/features/<slug>/` |

`init` and `plan` accept free text, `@path`, `--file path`, or an existing bare
file path. `ai-context` inspects the repository before interviewing. Balanced
mode asks at most five questions in its first batch and up to three material
follow-ups; quick and deep modes change the risk threshold without turning the
workflow into a generic questionnaire.

Each workflow generates documentation only. The resulting documents can be
sent directly to any capable coding CLI/model or selected by RB Ralph; neither
path is embedded into the documentation.

## Review and generated-plan quality gates

Version 0.1.1 strengthens generation and deterministic validation around the
failure modes found in cross-model execution trials:

- every RIGID requirement and cross-cutting rule must trace through task,
  binary criterion, validation, and expected evidence;
- promised quality gates are explicit commands, while `manual:` is limited to
  manager-observable inspection and `human:` pauses for truly external proof;
- standards, protocols, grammars, and dialects require an exact authority and
  machine-checkable positive/negative matrix rather than "where valid" prose;
- public schema and secret-bearing boundaries gain independent hostile cases
  and exact configured-value sentinel checks when relevant;
- documented configuration, runtime loading, public entrypoint, and
  `OPERATIONS.json` are audited as one interface across materially different
  modes; and
- normal phases may validate an operational contract's structure, but only the
  post-phase `RBF` audit owns its clean-room result. A plan that makes an earlier
  task depend on that future result is rejected.

These rules are project-, stack-, architecture-, provider-, and model-neutral.
Concrete applications used during testing remain regression fixtures, never
production special cases.

Version 0.1.2 strengthens UI review evidence without assuming a framework or
platform. Responsive claims now require parent/child layout analysis across
material layout states, complete-surface and below-the-fold coverage when safe
runtime inspection is available, and calibrated UNKNOWN/partial results when
runtime, visual, or computed-geometry evidence is missing. Selected responsive
remediation must preserve a falsifiable failing case and validate usable
geometry at affected and representative wider states.

Version 0.1.3 makes balanced responsive discovery mechanically accountable.
Reviewers must inventory all first-party UI sources, discover the target's own
layout vocabulary, inspect every high-risk topology candidate or preserve it as
UNKNOWN, and reconcile discovered counts against analyzed, excluded, and
unresolved counts before artifact writing. Deep mode builds on that static
denominator instead of replacing it with selected runtime samples.

Version 0.1.4 makes that accounting machine-verifiable. UI reviews emit an
`rb-responsive-inventory/v1` JSON artifact with one disposed record per
high-risk parent/child candidate, active layout-state evidence, and finding
traceability. The CLI rejects self-reported totals backed only by path lists,
including inventories that claim every candidate was analyzed without
individual dispositions.

Version 0.1.5 preserves legacy review trees while keeping the structured gate
strict for new reviews: only reviews that declare `rb-responsive-inventory/v1`
are required to carry its JSON artifact. Reviews can also audit and plan in one
invocation with the explicit `--plan-all-confirmed` policy. The finding set is
frozen first, only `CONFIRMED` IDs are selected, and a fresh planner context
reads the generated artifacts instead of inheriting the audit conversation.

For example:

```text
rb-harness review --project /path/to/project \
  --provider codex --depth balanced --plan-all-confirmed
```

This produces remediation documents only when at least one confirmed finding
survives revalidation. It never implements the plan or authorizes destructive
execution steps.

## Development

```sh
npm install
npm run build
npm run check
```

After the build, the standalone executable is
`packages/core/dist/cli.js`. The build also refreshes the legacy compatibility
bundle at `plugins/rb-harness/scripts/rb-harness.cjs`.

## Deterministic CLI

```sh
rb-harness contract validate <PHASES.md>
rb-harness contract inspect <PHASES.md> --format tsv
rb-harness contract extract <PHASES.md> --phase P01
rb-harness review validate-responsive <RESPONSIVE_INVENTORY.json>
rb-harness project init . --name "My Project"
rb-harness manifest sync .
rb-harness tree validate .
rb-harness tree resolve . --format tsv
# Validate a physically relocated RB artifact tree without rewriting its logical paths
rb-harness tree validate . --artifacts-dir .spec
rb-harness tree resolve . --artifacts-dir .spec --format tsv
rb-harness inspect .
```

`tree resolve --format tsv` reads `.rb/rb-manifest.json` by default and emits a
stable, Bash-friendly list of ready execution plans. `--artifacts-dir` changes
only the physical root: manifest paths remain logical `.rb/...` contract paths,
so relocating a package does not mutate its identity or hashes. RB Ralph can
consume that output without inferring the artifact layout. Manifest-less
compatibility importers and the `--fragments-dir` alias live in RB Ralph.

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
use a configurable bounded number of concurrent agents; Git worktree isolation
is required for parallel execution, and overlapping or conflicting task patches
fail closed before the primary tree changes. Provider-limit waits do not consume logical
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
