# How to Use RB Harness

RB Harness generates provider-neutral project documentation. It does not
implement application code: its output can be reviewed and then handed to any
capable coding CLI/model or consumed by RB Ralph.

## Before the first use

Install the standalone executable from the RB Harness repository:

```bash
npm install
npm run build
npm install --global --prefix "$HOME/.local" ./packages/core
export PATH="$HOME/.local/bin:$PATH"
```

Start the guided interface from the project or any other directory:

```bash
rb-harness
```

The root wizard shows the existing RB Harness operations. Selecting Init opens
the canonical Init configuration wizard; `rb-harness --init` skips the root
menu and opens that wizard directly. The Init wizard detects the current
project directory, offers the exact supported model profiles, and preserves
the request exactly as entered before the semantic interview begins.

The direct commands are:

| Workflow | Command |
|---|---|---|
| New project | `rb-harness init` |
| Existing project | `rb-harness ai-context` |
| Whole-product audit | `rb-harness review` |
| Evolve existing behavior | `rb-harness evolve` |
| Feature, fix, refactor, or migration | `rb-harness plan` |

The former Codex skills and Claude namespaced commands remain legacy adapters
for compatibility. They are not required by the executable and should not be
used for new automation.

CLI providers are `codex`, `claude`, and `opencode`. Native API providers are
`openai`, `anthropic`, `gemini`, `deepseek`, `minimax`, and `openrouter`. Use
`--provider custom --adapter /absolute/path/to/executable` for another CLI. The
custom adapter receives the prompt through stdin and model, effort, mode, and
project metadata through `RB_HARNESS_*` environment variables.
`RB_HARNESS_MODE` is `interview`, `generation`, or `repair`. All three are
read-only by contract. Interview, plan, and repair responses use declared JSON
envelopes; bounded part responses use raw document content by default, and the
orchestrator owns their checkpoint identity and materialization. Orchestrator-private
variables — resource root, dashboard, telemetry, and Ralph run variables — are
removed from the adapter environment.

Canonical Init uses conformed exact profiles rather than the legacy
`--provider/--model` pair. The current choices are
`anthropic:claude-opus-5` (direct API) and
`anthropic:claude-code-cli:claude-opus-5` (Claude subscription CLI). The two
transports never fall back to each other.

## Login and native APIs

Configure direct API access interactively; no API key needs to be placed in an
environment variable or command argument:

```bash
rb-harness --login
rb-harness auth list
rb-harness auth logout deepseek:pessoal
```

List supported providers and safe configuration status, or test one direct API
connection without starting a documentation workflow:

```bash
rb-harness provider list
rb-harness provider list --json

# Guided connection test
rb-harness provider test

rb-harness provider test --provider openrouter \
  --model vendor/model --credential trabalho --timeout 60
```

The test sends one minimal `PING` and reports the reply, latency, selected
credential ID/protocol, and provider-reported token count. It never writes
artifacts or run state. Add `--json` for the stable `rb-provider-test/v1`
result. With provider or model omitted in an interactive terminal, a wizard
lists configured APIs and credentials, asks for the remaining model, effort
and timeout values, prints the equivalent command, and confirms before making
the request. Non-interactive callers must provide both required values.

The login first asks for a provider, then shows only the protocols implemented
for it. OpenAI, Anthropic, DeepSeek, and MiniMax accept API keys; Gemini accepts
an API key or Google Application Default Credentials; OpenRouter accepts an API
key or its browser OAuth PKCE flow. OpenAI and Anthropic consumer CLI/browser
sessions are not reused by the native API adapter—the existing `codex` and
`claude` providers continue managing those sessions independently.

Secrets are encrypted at rest in the shared per-user RB vault and never placed
in process arguments, artifacts, logs, or dashboard state. Multiple labeled
credentials may coexist for one provider. The vault encryption key is a
separate private file under the same OS account; this prevents accidental
plaintext disclosure, but it is not a defense against compromise of that
account.

```bash
rb-harness review --project . --provider deepseek \
  --model deepseek-v4-pro --credential pessoal --effort high --dashboard

rb-harness plan --file change.md --provider openrouter \
  --model vendor/model --credential trabalho --dashboard
```

Native API providers require the exact provider model ID. They execute a local
tool loop governed by the Harness: interview tools are read-only; generation
can write only inside the staged `.rb` artifact tree.

## Live dashboard

Use `--dashboard` with a workflow or resume command to render pipeline stage,
provider/model, elapsed time, first-output latency, observed output bytes,
audit progress, and recent state transitions. The dashboard pauses cleanly for
interactive interview questions and never displays request text, answers,
provider output, or credentials.

```bash
rb-harness evolve --project . --file change.md \
  --provider codex --model gpt-5.6-sol --effort high --dashboard

rb-harness resume --project . --dashboard
```

The adaptive interview budget is 128 rounds across the complete run, not per
resume. Round identity and unanswered questions are persisted: after power
loss or cancellation, resume continues the active round or presents remaining
questions before making another provider call. Each fresh call also receives
the prior validated checkpoint as navigation so settled repository discovery
does not need to be repeated from scratch.
If that checkpoint is already `ready` and contains no pending answer, resume
does not open another interview round: it proceeds directly to generation.
When a writer intentionally emits `BLOCKED.md` or a blocked plan instead of a
ready output, the failure names that artifact path so an external dependency
is distinguishable from malformed generation.

For a web/service host, use the versioned headless machine instead of terminal
text. `rb-harness headless interview run --state <absolute-root>` accepts one
`interview_start` or `answer` JSON message and returns one response with ordered
events. Persist the returned `interviewId`, `cursor`, sequence, and answer
idempotency key. Re-submit the same start to recover a lost first response, or
the same answer to recover a response committed immediately before a restart.
Validate fixtures and discover the exact boundary with:

```bash
rb-harness headless interview version
rb-harness headless interview validate < fixture.json
```

Never infer recommendations from labels: each returned option has an explicit
`recommended` boolean. Only `interview_complete.acceptedAnswers` may be copied
to `rb-headless-init/v1.interviewAnswers`.
When the developer request names an RB Harness integration, the executable
automatically supplies both public headless contract documents to its
interview and writer. A hosted-service plan must therefore describe
the adaptive interview boundary separately from terminal artifact generation.

## Artifact quality gate

RB Harness uses one artifact writer, not a writer/manager loop. Product choices
and contradictions must be resolved by the adaptive interview before that writer
starts: one batch of at most five material questions, then focused rounds of at
most three until nothing material is open, and finally a closed decision
checkpoint. Declared safety ceilings — at most 12 rounds and 40 questions per
run — bound the loop, and reaching one reports `BLOCKED` with the decision that
is still open.

The writer receives that checkpoint plus a compact, code-owned output contract.
It first returns a small plan with shared IDs and a closed brief per segment,
then returns independently bounded document parts of at most 12 KiB. Each part
is checkpointed before the next call; completed parts survive interruption and
are not requested again. The Harness assembles the typed `path`/`content`
bundle, materializes it into a staging tree containing only `.rb`, derives every
mechanical field — manifest, hashes, IDs, statuses, the TSV projection — and
validates.

Publication is owned by deterministic gates: manifest hashes and identities,
workflow-required outputs, `rb-execution/v1`, plan decomposition, optional
formal contracts, explicit `BLOCKED.md` state, and the complete artifact tree.

The decomposition gate exists because RB Ralph runs one ephemeral, context-free
call per task, so a task that carries a whole feature has to be re-derived from
nothing inside a single window. Ceilings are read from what the plan itself
declares: at most 3 covered requirement IDs, 6 acceptance criteria, and 8 scope
paths per task; at most 12 tasks per phase; and a single-task phase covering
more than 2 requirements is a feature that was never decomposed. Breaking one is
a repairable structural error before publication and a blocker in
`rb-harness artifacts verify`. A RIGID requirement
cannot claim that deterministic code recognizes unlimited natural-language
meaning unless the artifacts define a finite grammar, typed authority, finite
matrix, or explicit classifier and failure contract.

When validation finds repairable structural errors, exactly one localized repair
runs. It receives the ordered, machine-generated error list and only the
affected documents, and must preserve everything else byte for byte. It cannot
reopen the interview, re-explore the repository, or re-emit the tree. A second
failure is reported with its diagnostic; there is no loop.

Interview and document-plan output have the same bounded behavior. A valid JSON
object does not need decorative marker lines. If a provider returns the right
substance in the wrong representation, the Harness preserves the raw response
and makes up to three closed formatting requests with tools disabled and no
project access. Every attempt receives the exact contract, parser defect, raw
response, and prior invalid formatting. The paid semantic analysis is never
repeated. Malformed legacy document-part envelopes use the same boundary while
new part prompts continue to request raw Markdown.

Historical runs stopped by the retired `rb-harness-artifact-audit/v1` stage
remain readable. Their audit rows are historical metadata and no longer gate any
result; no auditor is ever called again.

Use the verifier after generation and before RB Ralph when the change is large,
an authority changed after the original interview, or the package was produced
elsewhere:

```bash
rb-harness artifacts verify \
  --project . \
  --artifacts-dir .rb \
  --against docs/original-request.md
```

Verification is deterministic by contract. It starts no provider, spends no
tokens, and never repairs or republishes artifacts. It proves the manifest
schema, artifact hashes, the execution/operational/responsive contracts,
ready-plan discovery, cold phase context paths, task-reference integrity,
requirement coverage, and path portability. The report is persisted below
`.rb-harness/verifications/`, with exit `0` for safe, `2` for repairable
material findings, and `3` for a real product decision.

`--deterministic-only` remains accepted and describes the only behavior:

```bash
rb-harness artifacts verify --project . --artifacts-dir .rb \
  --deterministic-only --json
```

`--remediate` and `--from-report` were removed with the semantic manager and
fail with explicit guidance. To repair a failed package, run the workflow again;
the single bounded structural repair now happens inside generation.

Generation remains fail-closed for RB Ralph. A package is publishable only
after the strict manifest, `rb-execution/v1`, and applicable
`rb-operational/v1` validators pass and a workflow-required ready plan exists.
The materializer may normalize only lossless legacy spellings (for example,
nested HTTP probe assertions or a task repeating its enclosing phase
dependency); vague acceptance criteria and other semantic gaps remain errors.

Documentation transcripts are byte-counted and bounded: 32 MiB for generation,
16 MiB for the repair, and 8 MiB for the interview. Exceeding a role limit,
a timeout, a cancellation, a Harness failure, or host exit starts the same
idempotent teardown ladder — stop admitting work, `SIGTERM` the process group,
wait one short grace window, `SIGKILL` the survivors, and confirm quiescence
before the run lock is released. A grandchild that traps `SIGTERM` cannot be
orphaned. The run remains resumable and the failed provider log records the
precise limit diagnostic.

If the writer completed and a later manifest/contract gate failed, run the
normal `rb-harness resume <run-id> --project .` command. Durable checkpoints
separate the completed interview, the received document bundle, materialization,
validation, and publication, so a complete provider response that is already
preserved is never requested again. Long or normalization-colliding artifact
paths receive stable hash-suffixed IDs during manifest sync.

Each run also writes `telemetry.json` beside its state, recording the duration
of every documentation stage, the number of provider calls, and the token and
cache usage the provider actually reported. A provider that reports no usage is
recorded as unmeasured; no cost is ever estimated.

## Start a new project

Use a description directly:

```bash
rb-harness init \
  --profile anthropic:claude-code-cli:claude-opus-5 \
  --project . \
  "Quero criar uma plataforma de agendamento para clínicas com múltiplas unidades."
```

Or keep a longer brief in a file:

```bash
rb-harness init --file docs/project-brief.md \
  --profile anthropic:claude-code-cli:claude-opus-5 --project .
```

Run `rb-harness --init` for guided configuration. Direct mode begins when Init
operational arguments are supplied; it never falls back into the configuration
wizard. Direct mode still performs the semantic interview unless `--headless`
is selected (or no interactive answer channel exists). Blank semantic answers
accept the displayed recommendation.

Canonical Init resolves material missing decisions, validates workflow-specific
semantics, and atomically publishes the exact Ralph artifact tree.

Typical result:

```text
.rb/
  rb-manifest.json
  init/
    BRIEF.md
    PHASES.md
```

Glossary, workflows, non-functional requirements, and formal contracts are
conditional. They are not generated merely to fill a fixed template.

## Document an existing or legacy project

Run from the existing project root:

```bash
rb-harness ai-context --project . --provider codex --model gpt-5.6-sol --effort high
```

Available interview depths:

- `--quick`: asks only blocking questions and records more assumptions.
- `--balanced`: default; up to five initial questions and three material
  follow-ups.
- `--deep`: expands high-risk investigation for security, public contracts,
  migrations, regulated data, or distributed workflows.

The workflow inspects manifests, source, tests, CI, and configuration before
asking anything. It excludes secrets, generated dependencies, build outputs,
and RB intent documents from behavioral evidence. Its output includes the
portable `.rb/context/AGENTS.md` index plus conditional documents in the same
directory. A pre-existing project-root `AGENTS.md` is source evidence and is
never silently overwritten by standalone publication.

Every material claim is classified as `OBSERVED`, `CONFIRMED`, `INFERRED`,
`UNKNOWN`, or `CONFLICT` so future agents can distinguish evidence from human
knowledge and assumptions.

Developer responses pass a separate acceptance gate before becoming
`CONFIRMED`: `ACCEPTED`, `PARTIAL`, `AMBIGUOUS`, `DEFERRED`, or `CONTRADICTED`.
Material partial or ambiguous answers are asked again more narrowly; if they
remain unresolved, the documentation preserves the uncertainty instead of
choosing an interpretation. The raw response and normalized decision remain in
the source manifest for auditability.

## Audit the whole product

Use review when the goal is discovery rather than one already-scoped change:

```bash
rb-harness review --project . \
  --prompt "Audit frontend, security, tenancy, operations, and test quality." \
  --provider codex --model gpt-5.6-sol --effort high \
  --depth balanced --focus frontend security tenancy tests
```

The audit records evidence-grounded findings, reviewed journeys, runtime/static
limitations, baseline changes, and—when UI exists without sufficient authority—
a grounded design-system document under `.rb/reviews/<review-id>/`. It checks
product completeness, security and tenant isolation, frontend/backend request
behavior, loading and feedback states, responsiveness/accessibility, data and
operations, and whether tests meaningfully exercise behavior.

For UI-bearing targets, review builds a surface-by-layout-state evidence matrix.
It analyzes parent and child constraints together, traverses complete dynamic
surfaces when safe runtime tooling is available, and distinguishes current
geometry/visual proof from stale or cropped screenshots. Visibility of a few
controls or absence of page-level overflow cannot justify a broad responsive
clean result; unverified surfaces remain explicitly partial or unknown.

Balanced and deep UI reviews also produce a reconciled static inventory. Every
first-party UI source and every mechanically discoverable high-risk layout
candidate is counted as analyzed, explicitly excluded, or unresolved with its
path preserved. This prevents a successful fixed-width search or a handful of
sampled screens from standing in for parent/child topology coverage across the
rest of the product. Deep mode adds broader runtime and visual evidence; it does
not replace the balanced static inventory.

Review does not repair code. Select stable finding IDs explicitly before asking
it to generate remediation `PLAN.md`, `PHASES.md`, and optional
`OPERATIONS.json`; unselected findings never leak into the execution plan.

## Evolve existing behavior

Use evolve when the request changes an established flow or its consumers:

```bash
rb-harness evolve \
  --prompt "Vincular materiais de estoque à abertura da ordem de serviço." \
  --provider codex
```

The workflow proves AS IS behavior first, then documents TO BE, readers/writers,
impact, preservation, migration, compatibility, and a regression matrix under
`.rb/evolutions/<slug>/`. It routes by impact rather than the phrase "new
feature" and preserves existing behavior that the accepted delta does not
change. Use ordinary `rb-harness plan` for genuinely isolated new behavior or a scoped
fix that does not need this transition analysis.

## Plan a change

After `rb-harness init` or `rb-harness ai-context`, describe the change:

```bash
rb-harness plan \
  --prompt "Corrigir a duplicação de cobrança quando o gateway demora para responder." \
  --provider codex
```

Or reference a request file:

```bash
rb-harness plan @docs/requests/idempotent-charge.md --provider codex
```

The workflow detects whether the request is a feature, bug, refactor,
migration, performance change, contract change, dependency update, or debt. It
then creates:

```text
.rb/features/<slug>/
  REQUEST.md
  SPEC.md
  PLAN.md
  PHASES.md
  source-manifest.json
  contracts/            # only when a rigid public/formal contract requires it
```

`PHASES.md` is the strict execution view. It contains stable phase and task
IDs, dependencies, scope, requirement traceability, binary acceptance
criteria, validation, expected evidence, and parallel-safety metadata.

## Review and validate the handoff

The workflows run these checks automatically. They are also available for
manual inspection:

```bash
rb-harness contract validate .rb/features/<slug>/PHASES.md
rb-harness operations validate .rb/features/<slug>/OPERATIONS.json
rb-harness manifest sync .
rb-harness tree validate .
rb-harness tree resolve . --format tsv
```

Do not start implementation when readiness is `BLOCKED`. Resolve the listed
decision and rerun the appropriate workflow. `READY_WITH_ASSUMPTIONS` is safe
only when the recorded assumptions are acceptable for the project.

Execution-contract validation also rejects acceptance criteria that merely say
they satisfy an RF/RNF/UI/CT identifier or rely on undefined qualifiers such as
"appropriately" and "when possible". The criterion must state the observable
result directly.

## Execute the result

Direct execution remains provider-neutral. Give the selected model the plan
path and instruct it to use the context paths declared by each phase:

```text
Implemente o plano em .rb/features/<slug>/PHASES.md.
Respeite o contrato rb-execution/v1 e os documentos de contexto citados.
```

RB Ralph discovers the same plan without knowing its directory:

```bash
/path/to/rb-harness/plugins/rb-harness/scripts/rb-resolve.sh .
```

The resolver returns only manifest entries whose kind is `execution-plan`,
status is `ready`, contract is `rb-execution/v1`, and current SHA-256 and
document grammar are valid.

The first RB Ralph executor can safely preview that plan:

```bash
rb-ralph \
  --project . \
  --plan <artifact-id> \
  --dry-run
```

Use one built-in provider for both roles:

```bash
rb-ralph \
  --project . \
  --plan <artifact-id> \
  --provider codex
```

Claude is also available with `--provider claude`. The roles may use different
LLMs:

```bash
rb-ralph \
  --project . \
  --plan <artifact-id> \
  --agent-provider claude \
  --manager-provider codex
```

Custom providers remain supported with `--agent-cmd` and `--manager-cmd`.

By default, RB Ralph runs every backtick-delimited `Validation` command after
the agent. A failed command forces a retry even when the LLM manager returns
`COMPLETE`. Review these commands before execution because they run with the
operating-system authority of the developer invoking RB Ralph.

After every documented phase, Ralph also runs `RBF`, a runtime-only final
operational audit. It does not modify `PHASES.md`. When RB Harness can ground a
real consumer workflow it writes `OPERATIONS.json` beside the plan using
`rb-operational/v1`; Ralph executes that contract in a disposable copy and the
manager independently audits the product boundary.

This is not web-specific. A desktop application may build/package and run UI
automation or another honest platform observation; a CLI executes its public
command; a library builds a minimal consumer; a service probes its actual
protocol; a plugin installs into a disposable host. Commands are declared as
argument arrays and scenarios may target Linux, macOS, or Windows. If no
contract exists in an older project, the final agents derive a clean scenario
from the documented and implemented entrypoints.

Override discovery when needed:

```bash
rb-ralph --project . --plan <artifact-id> --provider codex \
  --operations .rb/features/<slug>/OPERATIONS.json
```

`--no-final-audit` is an explicit diagnostic opt-out. A failed operational
contract forces `RETRY` even with `--validation-mode manager` and even if the
LLM manager answers `COMPLETE`.

Independent tasks may use bounded parallel agents:

```bash
rb-ralph \
  --project . \
  --plan <artifact-id> \
  --provider codex \
  --parallel 4 \
  --isolation worktree
```

RB Ralph only parallelizes when all pending tasks are marked `Parallel safe:
true` and have no dependencies among themselves. Otherwise it automatically
falls back to a sequential phase agent.

`--isolation worktree` is required for parallel execution. It requires Git
and an initial commit, gives every task agent an independent detached worktree,
and checks all patches together before applying anything to the primary tree.
The snapshot includes current tracked changes and non-ignored untracked files;
it does not alter the current index, branch, or commit. Patches that touch the
same path are rejected even when Git could merge them; other conflicts also fail
without partially changing the primary tree.

RB Ralph uses fresh provider calls and reconstructs only the context needed for
the current phase or task. The default prompt guard rejects inputs larger than
262144 bytes. Set a smaller project-specific bound when desired:

```bash
rb-ralph \
  --project . \
  --plan <artifact-id> \
  --provider claude \
  --max-prompt-bytes 131072
```

When a bundled adapter recognizes a provider usage limit, execution waits and
repeats the same logical attempt. Configure the fallback, individual-delay cap,
and total waits per phase as needed:

```bash
rb-ralph \
  --project . \
  --plan <artifact-id> \
  --provider codex \
  --rate-limit-wait 60 \
  --max-limit-wait 3600 \
  --max-limit-waits 20
```

Accepted phases are resumable for the same plan hash. Prompts, logs, validation
evidence, patches, and append-only events are stored under `.rb/runs/`. See
[the RB Ralph repository](https://github.com/RBTecNet/rb-ralph) for all options and
[`context-and-continuity.md`](context-and-continuity.md) for the current token,
resume, and future memory boundary.

## Recommended flow

For a new project:

```text
rb-harness init -> review BRIEF.md + PHASES.md -> validate -> execute
```

For an existing project:

```text
rb-harness ai-context -> rb-harness review for discovery, rb-harness evolve for established-flow changes, or rb-harness plan for isolated work -> validate -> execute
```

Commit generated documentation only after reviewing the scope, assumptions,
unknowns, requirements, and validation commands. RB Harness never stages or
commits project files on the developer's behalf.

## Continue with another model or computer

Deploy RB Memory once and bootstrap the administrator with
`RB_MEMORY_ADMIN_USERNAME` and `RB_MEMORY_ADMIN_PASSWORD`. Anyone may create an
isolated tenant and owner account through `/signup`; administrators can manage
all tenants and attach accounts to tenants created before web accounts existed.

After signing in with username and password, create a labeled device token in
**Connect an LLM**. Put that technical credential in `RB_MEMORY_TOKEN` on the
intended MCP clients or RB Ralph machines. Multiple tokens may point to the
same tenant so each computer can be revoked independently while sharing memory.

For the easiest setup, sign in with username and password, open **Connect an LLM**,
and download the Linux/macOS or Windows installer. The installer asks for the
token locally and configures whichever supported clients are installed:
Codex, Claude Code, OpenCode, VS Code/Copilot, and Gemini CLI. It can be rerun
after token rotation or on another computer; the downloaded file itself does
not contain the credential.

Connect each client to `/mcp` and use the same repository with its existing
`.rb/rb-manifest.json`. At session start the agent reads `project.id` and calls
`rb_memory_bootstrap`. Before changing model, computer, or stopping substantial
work, it calls `rb_memory_checkpoint`.

Natural-language recall is semantic by default. On first use, ask the agent to
call `rb_memory_embedding_status`; if the project has pending records, it may
call `rb_memory_reindex` with the stable `project.id`. Subsequent
`rb_memory_recall` calls combine meaning similarity with exact terms,
importance, and recency. Operators can perform the same backfill with the
`rb-memory embeddings --backfill` CLI command.

The complete deployment, Codex, Claude Code, backup, and security instructions
are in [the RB Memory repository](https://github.com/RBTecNet/rb-ia-memory). RB Memory is
optional: losing access to it never changes the execution meaning of committed
RB Harness artifacts.
