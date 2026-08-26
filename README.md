# RB Harness

[English](README.md) · [Português do Brasil](README.pt-BR.md)

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

RB Harness 0.5.17 is an executable rather than a workflow that must run inside
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
# Both print 0.5.17
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
bounded local tool loop with exactly three documentation capabilities: list
relevant files, search text, and read a limited line range inside the target
project. There is no shell, no test execution, no Git write, no subagent, and no
application-code write. The call count, the accumulated tool output, and
repeated identical calls are all bounded, and the tool catalog never changes
between steps so the provider's prefix cache keeps hitting. Direct providers require an explicit provider model ID. An effort value a
provider declares it does not accept fails before the request is built, never at
the provider's expense; see *Reasoning is an explicit, declared mode* below.

### Live Harness dashboard

Add `--dashboard` to a workflow or resume command. The dashboard uses the same
terminal design language as Ralph while showing the documentation state machine:
inventory, gap analysis, waiting for a human answer, evidence discovery, package
generation, materialization, validation, structural repair, and publication. It
also reports real telemetry — provider calls, confined tool reads, requests, and
input/cached/cache-creation/output tokens when the provider reports them. A
provider that reports no usage is shown as unmeasured; no cost is ever invented,
and repeated bytes are never presented as progress. It never includes the
request, interview answers, provider output, or credentials. During an
interactive question the panel yields the terminal and resumes after the answer.

```bash
rb-harness evolve --project . --file change.md \
  --provider codex --model gpt-5.6-sol --effort high --dashboard

rb-harness resume --project . --dashboard
```

The Harness has no execution profiles. Its command remains short; reusable
profiles belong only to RB Ralph, whose operational command has many more
controls.

### The documentation state machine

Before the first provider call the Harness builds a deterministic, bounded input
package: the request and its hash, the workflow, a summarized inventory of the
target project, the existing RB artifacts, the decisions already accepted, and a
compact code-owned contract digest. Version control, dependencies, build and
coverage output, live Harness state, credentials, and temporary files are
excluded, and no path into the RB Harness source, `dist`, tests, or installation
ever reaches the model. Everything else must be fetched through the confined
documentation tools, inside the target project.

The interview is adaptive and it converges rather than expiring. An opening
batch of at most five material questions is followed by as many focused rounds
of at most three as convergence needs: an answer that opens a new material
decision earns another round, and the interview ends only when no material
ambiguity is left. `--questions one-by-one` controls only local presentation and
never costs an extra provider call; `--questions batch` announces the whole
round before answering it. Every answer is classified `ACCEPTED`, `PARTIAL`,
`AMBIGUOUS`, `DEFERRED`, or `CONTRADICTED`. Facts discovered in the project
never become questions, a FLEXIBLE choice becomes an explicit assumption instead
of a blocker, and a decision the developer already settled is never re-asked.

Two declared safety ceilings keep the state machine finite — at most 12 rounds
and 40 questions in one run. They are not the intended stopping point: reaching
either one is a failure to converge and produces `BLOCKED` naming the decision
that is still open, never a silent acceptance.

Only *form* is repaired automatically: a malformed question ID, an inferable
question type, an empty option list. A disposition that is missing, unknown, or
misspelled is a semantic defect, never an acceptance — the answer is carried as
unresolved, the provider gets the bounded formatter retries the flow allows,
and if it persists the answer earns a focused follow-up or
blocks the run. `ACCEPTED` requires an explicit disposition and a single
normalized decision; the raw answer stands in for that decision only under an
explicit `ACCEPTED`. Questions above the round budget are never dropped either:
they are carried into the next round as declared open decisions in
`unresolved`, and their existence prevents a `ready` result. Only at the safety
ceiling, where there is no next round, do they become deferred and block.

If a provider reaches substantive conclusions but does not satisfy an interview,
document-plan, or legacy document-part envelope, the Harness preserves that raw
semantic response and starts a provider-neutral formatter. The formatter runs
without tools or project access, receives the exact contract and deterministic
parser defect, and may retry at most three times. Every retry sees the immutable
raw response and the preceding invalid formatting attempt. It may change only
representation; the strict parser remains the acceptance authority. The costly
discovery or authoring call is never repeated merely to repair serialization,
and completed raw responses are recovered from private logs after interruption.

Then one documentation-writer role receives the closed decision checkpoint.
It first returns a compact document plan with shared IDs and a closed brief for
each part. The Harness requests each part independently, caps its content at
12 KiB, checkpoints it immediately, assembles the typed `path`/`content`
bundle, materializes the files, derives every mechanical field — manifest,
hashes, IDs, statuses, the TSV projection — and validates. There is no
documentation manager, no semantic auditor, and no second opinion.

An `rb-execution/v1` plan is also validated for decomposition, not only for
grammar. RB Ralph runs one ephemeral, context-free call per task, so a task
carrying a whole feature has to be re-derived from nothing inside a single
window. Ceilings are read from what the document itself declares — a task
declares at most 6 acceptance criteria and 8 scope paths, and a phase holds at
most 12 tasks. A lone task is refused only when three signals coincide: it is
the phase's only task, its whole scope names areas rather than files, and it
proves 4 or more criteria — any two of those describe a perfectly good small
phase. `Covers` is deliberately not a ceiling: it records traceability, so a
one-file quality-gate task may legitimately prove many requirements, and gating
on the count only taught the writer to list fewer. A plan that breaks
one is a repairable structural error before publication and a blocker in
`rb-harness artifacts verify`, never a surprise discovered by a stalled
executor.

Only the plan call may explore evidence. Every part starts with fresh context,
has no direct-API tool catalog, and runs from an empty temporary directory for
every adapter. A crash, timeout, truncation, or power loss therefore resumes at
the first missing part instead of repurchasing completed output. `.rb` is still
published only after the complete assembled tree passes validation. Legacy
adapters that return one complete `rb-harness-documents/v1` bundle remain
compatible, and the Harness never automatically repeats the same truncated
request. Part calls return raw document content by default: path and ID already
belong to the validated checkpoint, so a redundant JSON envelope adds no write
authority. Correct legacy part envelopes remain accepted for compatibility.

If deterministic validation finds repairable structural errors, up to three
localized correction passes may run. Each receives the ordered, machine-generated error list and
only the affected documents, and must preserve everything else byte for byte. It
cannot reopen the interview, re-explore the repository, or re-emit the tree. A
non-convergent third correction is reported with its diagnostic. Apart from
that bounded correction edge and the counted interview rounds, the state graph
is acyclic, and no stage can restart itself.

Generated `.rb` artifacts are immutable control-plane authority for execution:
PHASES task scopes cannot own them. After atomic publication, executable-plan
workflows automatically run the deterministic equivalents of `contract
validate`, tree validation, and `artifacts verify`. A rejected publication is
quarantined, the prior revision is restored, and a localized correction is
attempted within the same finite budget; completion is recorded only after all
closing gates are green.

Providers are read-only in every documentation role. Codex runs with
`--sandbox read-only`, Claude with `--permission-mode plan`, OpenCode with edit,
shell, task, and external-directory permissions denied. Provider transcripts are
bounded as UTF-8 bytes — 32 MiB for generation, 16 MiB for the repair, 8 MiB for
the interview.

For OpenCode, `--effort none` maps to the CLI-documented `minimal` variant.
Passing a literal `--variant none` allowed a silent fallback to the model's
default; one measured run spent 32k reasoning tokens and emitted no answer.

A provider never runs in the project itself. It runs in a bounded, read-only
*evidence projection*: the target project's files that the inventory policy
admits, mirrored at their real relative paths and nothing else. There is no
`.rb-harness`, no `.git`, no dependency or build tree, no credential file, and
no run directory in it. It is built in its own private temporary root — never
under `.rb-harness/runs/<id>/`, which would place the run's `state.json` one
directory above the provider — its files and directories are sealed read-only
after population, and it is removed when the run ends. The real project's
absolute path is never handed to the provider: the input package names the
project by basename and `RB_HARNESS_PROJECT_ROOT` points at the projection.
The bundled direct-API tools apply the same policy by path, so naming a
forbidden directory explicitly is refused rather than merely hidden.

**This is not an OS sandbox, and the Harness does not describe it as one.** Only
the bundled direct-API runtime confines *reads*, because its tools enforce the
path policy in process. Codex's `--sandbox read-only` and Claude's
`--permission-mode plan` block writes while leaving the filesystem readable, so
those adapters are declared as not read-confined and the log says so on every
run. The projection removes the control plane from every relative path and
withholds the project's location; it does not stop a CLI that goes looking with
an absolute path.

### What each adapter can actually be held to

The bundled direct-API runtime is the only adapter the Harness controls end to
end: it owns the tool catalog, counts every call, and reports the usage the
provider returned. An external CLI runs its own agent loop, so the Harness
states plainly what it can and cannot account for:

| Adapter | Internal control | Turn/tool budget | Usage metrics | Read confinement | stdout transport |
|---|---|---|---|---|---|
| direct APIs | enforced locally | enforced | reported when the provider returns `usage` | enforced in process | final text (streamed internally) |
| `opencode` | consumed via `run --format json` | enforced | tokens/cache/cost measured when its terminal event reports them | none | JSONL events |
| `codex` | `exec --json` advertised, not consumed | not claimed | unmeasured | none | final text |
| `claude` | `--output-format stream-json` advertised, not consumed | not claimed | unmeasured | none | final text |
| `custom` | none declared | not claimed | unmeasured | none | final text |

### Direct APIs stream internally

A direct API provider runs through the bundled runtime, which now requests an
incremental response and consumes it as it arrives — SSE chat completions for
the OpenAI-compatible dialect, the event stream for Anthropic Messages. Text,
reasoning, tool-call names, and fragmented tool-call arguments are reassembled
in the runtime; arguments are parsed only once the response is complete.

That changes observability, not the result. **The subprocess's stdout still
carries exactly one thing: the model's complete final answer, byte for byte.**
No fragment of the document envelope is ever written to stdout. While the call
is in flight the runtime reports real remote activity on a separate stderr
channel as content-free markers — a kind such as `content-delta`, never a token,
a reasoning trace, a tool argument, or a secret.

This is why `--first-output-timeout` is meaningful again:

- **`--first-output-timeout`** (default 300 s) measures the time until the
  provider *really starts answering* — the first remote event. A non-streaming
  runtime was silent until the whole loop finished, so this deadline used to kill
  legitimate, already-paid generations.
- **`--timeout`** (default 3600 s) remains the total wall limit for the call.

There is deliberately no local heartbeat. A timer the Harness fires itself would
prove only that the Harness is alive, and would quietly turn the first-output
deadline into a second wall timeout. Progress is renewed only by a new remote
event; an SSE keep-alive comment is consumed and renews nothing. The terminal
output stays compact — *"provider respondeu após 3s; recebendo stream..."*, then
*"provider ativo há 15s; 42 eventos remotos recebidos"* — and never prints tokens
or partial documents. The run log records `remote_events` and
`first_remote_event_ms` and no stream content.

Streaming support is declared per provider in the registry, never inferred from
a provider id at a call site. A provider that cannot serve its dialect's
streaming protocol fails with an explicit diagnostic; the runtime never retries
the same request without streaming, because that could pay for one answer twice.
On timeout, `SIGINT`, or `SIGTERM` the fetch and the stream reader are aborted,
no further tool runs, no partial answer is published, and usage the provider
never delivered stays unknown rather than being recorded as zero.

### Reasoning is an explicit, declared mode

Reasoning is billed as output. A model that reasons and never answers still
spends the whole allowance, and that is exactly what happened: a real generation
consumed 65.536 output tokens producing 2.280 reasoning deltas, zero content
deltas, and no document at all. The stream was healthy and the parser was
correct — the Harness had simply forced `thinking: { type: "enabled" }` on every
DeepSeek request, so a run that named no `--effort` inherited the provider's own
high-intensity default without ever asking for it.

Whether a provider reasons is now a capability declared in the provider
registry, next to its streaming and authentication capabilities and independent
of both. The runtime reads that declaration; there is no `provider === "..."`
test at any call site, and adding a provider does not touch the request path.
Only DeepSeek declares it today; every other provider keeps exactly the request
it sent before.

For a provider that declares the toggle:

| `--effort` | Sent | Meaning |
| --- | --- | --- |
| *(omitted)* | `thinking: { type: "disabled" }` | The safe default: direct generation, no reasoning. |
| `none` | `thinking: { type: "disabled" }` | The same, stated explicitly. No `reasoning_effort` is sent — the toggle owns the shutdown, and an intensity of "none" would be a second, contradictory statement of the same decision. |
| `low` | `thinking: { type: "enabled" }` + `reasoning_effort: low` | Reasoning on, at its lowest intensity. |
| `medium`, `high`, `xhigh`, `max` | `thinking: { type: "enabled" }` + the intensity | Deliberate and progressively more expensive. |
| anything else | *nothing* | Refused before any connection is opened. |

```bash
# Direct generation, no reasoning — the default for DeepSeek.
rb-harness init --project . --file docs/prd.md \
  --provider deepseek --credential ds_oficial \
  --model deepseek-v4-flash --effort none --output .rb

# Reasoning enabled at its lowest intensity.
rb-harness init --project . --file docs/prd.md \
  --provider deepseek --credential ds_oficial \
  --model deepseek-v4-flash --effort low --output .rb
```

An effort the provider does not accept fails before the request is built. The
message names the provider, the value received, and the accepted values, and
states that no request was started — it is never corrected silently, promoted to
a higher intensity, or retried at a price.

When a response does end with its output limit exhausted and no final answer,
the diagnostic says so precisely instead of reporting a generic stop:

```text
provider exhausted its output limit using reasoning without producing a final
response (finish_reason=length; reasoning events=2280; content events=0;
usage input=9501 output=65536 total=75037; no partial response was published)
```

Token figures appear only when the provider reported them; otherwise the message
says `usage not reported by the provider` rather than printing a zero. Reasoning
and content are counted apart in the run log (`reasoning_events`,
`content_events`, `reasoning_bytes`, `content_bytes`) and in the usage record, so
a call that spent everything on reasoning is legible as such. Those counters hold
sizes and counts only: no reasoning text, no artifact fragment, no tool argument,
no credential, and no prompt is ever stored, and the stderr markers stay
content-free. A response that ends by limit, truncation, cancellation, HTTP
error, or without a final message publishes nothing — no partial stdout, no
partial `.rb`, no reasoning promoted to an answer, and no automatic second paid
call to finish it.

Control and transport are separate columns because they are separate facts. A
direct API provider runs through the bundled runtime, which owns the tool
catalog, counts every call, reports the provider's real usage, and confines
reads — it is genuinely controlled. What that runtime writes to stdout is
nonetheless one thing: the model's final answer, envelope included. Only
`opencode`, whose JSONL event stream the Harness actually consumes, has its
final answer reconstructed from events; every other adapter's stdout is handed
to the envelope parser byte for byte. Each provider log records
`stdout_transport=final-text` or `stdout_transport=jsonl-events` so the
distinction is visible per run.

Every declaration was read from the `--help` of a locally installed version, not
guessed. An adapter whose event stream the Harness does not consume is governed
by conservative limits only — wall timeout, first-output timeout, output volume,
and a progress window in which output must carry something *new*, since a
stalled agent can repeat itself indefinitely. Such a run is labelled unmeasured
on that axis; it is never described as respecting the direct runtime's budget. A
line that opens as a structured event and fails to parse is a protocol failure,
reported explicitly rather than ignored — including a stream truncated at EOF,
whose trailing partial event is surfaced when the stream closes rather than
being dropped.

For OpenCode the Harness follows the real schema of the installed 1.18.21 build:
events are `{ type, properties }`, and a tool part is re-emitted as its state
moves `pending → running → completed`. Counting those events would report one
invocation three times, so invocations are counted by the provider's own
`callID`, and a `step-start` part counts as a model turn.

Every provider run ends by settling its process tree — including the runs that
succeed, since a leader exiting with code zero says nothing about what it
detached. Polling alone cannot do this: a leader can `setsid()` a descendant
into a fresh session and exit within milliseconds, after which nothing links the
descendant back to the run and no process-group signal can reach it.

Where the platform offers **structural containment**, the Harness uses it and
can prove the tree is gone. On Linux with a writable cgroup v2 subtree, the
child joins a per-run cgroup before it can fork; membership is inherited across
`fork` and `setsid`, stays enumerable after the leader dies, and
`cgroup.kill` removes every member atomically.

Where it does not, the Harness says so instead of claiming a guarantee. It still
runs the idempotent ladder — stop admitting work, `SIGTERM` the process group,
wait one short grace window, `SIGKILL` the survivors — but reports the teardown
as unverified, and the provider log records
`tree_containment_structural=false` and `tree_quiescence_verified=false`. On
Windows the mechanism is `taskkill /T`, which walks the parent chain: it is
**not** a Job Object and is declared as best-effort for exactly that reason. A
remembered descendant is only re-signalled while it still belongs to the process
group it was seen in, so a recycled PID is never signalled.

Declared byte budgets are enforced before any provider process is created. The
request is authority and is never truncated: a request above its budget fails
the preflight with the observed size, the limit, and a safe way forward, and the
same holds for the input package, the accepted decisions, and each prompt. Only
non-authority detail — inventory samples, existing-artifact summaries — is
reduced, and the reduction is declared to the model.

Every run writes `telemetry.json` next to its state, and the final report prints
the duration of each stage and the number of provider calls. Cache figures come
only from what a provider measured: an adapter that reports no usage is recorded
as unmeasured, never as a zero-token or zero-cost run. The Harness guarantees a
byte-identical prompt prefix across the rounds of one run — contract, resources,
and input package before any round-specific state — but it makes no claim about
cache reuse across processes or sessions unless the provider reports it.

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

A provider response that reached the run log is authoritative evidence: the log
records the exact bytes the provider wrote. If an envelope was valid when it was
written, it stays recoverable on resume even when the run that produced it
failed afterwards.

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

The completed and active round numbers are durable, so resume continues at the
correct round without overwriting prior logs. A prior validated checkpoint is
supplied as navigation to each fresh interview call, reducing repeated
repository discovery while keeping code and tests as source authority. If input
is interrupted partway through a question batch, resume presents the unanswered
questions before starting another provider call.

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
that receives the complete prompt on stdin, runs with the target project as its
working directory, and reads `RB_HARNESS_MODE`, `RB_HARNESS_PROJECT_ROOT`,
`RB_HARNESS_PROVIDER`, `RB_HARNESS_MODEL`, and `RB_HARNESS_EFFORT` from the
environment. `RB_HARNESS_MODE` is `interview`, `generation`, or `repair`; all
three are read-only. Interview, plan, and repair responses use their declared
JSON envelopes; bounded document-part responses use raw content by default.
Orchestrator-private variables — the resource root, dashboard, telemetry, and
Ralph run variables — are removed from the adapter environment, so an adapter is
never told where the Harness installation lives:

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

Generation uses one writer and no manager loop. A separate operator-invoked
verification command re-proves a published tree before RB Ralph consumes it:

```bash
rb-harness artifacts verify \
  --project . \
  --artifacts-dir .rb \
  --against docs/original-request.md \
  --dashboard
```

Verification is deterministic by contract. It starts no provider, spends no
tokens, and never edits or republishes artifacts. It proves the manifest schema,
artifact hashes, the execution and operational contracts, responsive-inventory
contracts, ready-plan discovery, cold phase context paths, task-reference
integrity, requirement coverage, and path portability. An incompatible tree can
never be announced as Ralph-ready.

`--against` is optional when the matching completed Harness run remains in
`.rb-harness/runs`, and recommended for imported or regenerated packages.
Reports use the `rb-harness-artifact-verification/v1` contract and are stored
with mode `0600` under `.rb-harness/verifications/` unless `--report` selects
another path. Every report contains SHA-256 fingerprints of the complete
physical artifact tree (excluding live `.rb/runs` state) and its original
request/interview authority. Exit `0` means Ralph-ready (possibly with minor
warnings), `2` means material repairable findings, `3` means a real unresolved
developer decision, and `1` means the verifier itself failed.

### Removed with the semantic manager

The LLM documentation manager, the independent semantic auditor, and the
audit-driven remediation cycle were removed in 0.4.0. They repeated reading and
writing without guaranteeing monotonic progress: a full re-emission could
produce a fresh set of findings, which is non-convergence, not quality.

The options that existed only to drive them fail with explicit guidance rather
than being silently reinterpreted:

- `--remediate` and `--from-report` — re-run the workflow instead; a single
  bounded structural repair now happens inside generation.
- `--answers` and `--non-interactive` on `artifacts verify` — deterministic
  verification asks nothing.

`--deterministic-only` remains accepted and now describes the only behavior.
`--provider`, `--model`, `--effort`, `--credential`, `--adapter`, `--timeout`,
and `--first-output-timeout` are still accepted on `artifacts verify` so existing
scripts keep parsing; they are recorded for provenance and start no provider.

Version 0.4.0 replaces the general agent orchestration with a documentation
core. The measured problem was cost and time, not model quality: on the `cron2`
trial the same prompt and model that produced useful documentation in about ten
minutes and US$ 0.20 elsewhere ran for more than thirty-one minutes and past
US$ 1.84 here without publishing anything.

- the input package is deterministic and bounded, and never names the Harness
  source, `dist`, tests, or installation;
- the mechanical output formats are a compact, versioned, code-owned digest
  instead of four reference documents copied into every prompt;
- the interview is adaptive: one batch of at most five questions plus focused
  rounds of at most three until it converges, bounded by declared safety
  ceilings that report a failure to converge as BLOCKED;
- one writer role returns a compact plan followed by independently bounded,
  checkpointed document parts that the Harness assembles and materializes;
  up to three localized structural correction passes may follow;
- the LLM manager, the semantic auditor, and audit-driven remediation are gone;
- providers are read-only in every documentation role and their whole process
  tree is torn down and confirmed quiescent on cancellation, timeout, overflow,
  failure, or host exit;
- the dashboard, the log, and `telemetry.json` report documentation stages,
  provider calls, and real token/cache usage — never invented cost;
- checkpoints separate interview, document plan, every accepted part, assembled
  bundle, materialization, validation, and publication, so a resume never pays
  twice for completed work.

The public CLI, the wizard, the dashboard, the splash, and the capybara are
unchanged.

Version 0.5.1 closes a provider-format failure without weakening the contracts:
prose-only interview conclusions receive one tool-free conversion, raw valid
JSON is preserved without a paid retry, and the full evidence-discovery request
is never repeated merely because marker lines were omitted.

Version 0.5.2 makes document-part output raw content by default, so Markdown is
never forced through a JSON string. Correct legacy envelopes remain compatible;
literal control characters inside their content string are normalized without
changing path or part identity. A successful paid part found in its provider log
is checkpointed on resume before any new provider process is started.

Version 0.5.3 keeps the Ralph boundary strict while preventing the exact
contract defects observed in the Cron2 trial. The writer receives the precise
phase-versus-task dependency grammar, the current HTTP probe assertion shape,
and an explicit prohibition on vague acceptance phrases such as `when
applicable`. Before validation, code performs only lossless canonicalization:
legacy nested HTTP assertions are moved to their exact `rb-operational/v1`
fields and a task's redundant reference to its enclosing phase dependency is
removed. Invalid plans retain their declared artifact ID in the manifest, so a
real content error cannot create a false `artifact.id.mismatch`. The single
repair plan is closed and tool-free; every validator and the requirement for a
ready `rb-execution/v1` plan remain unchanged.

Version 0.5.4 introduced successful plan-log recovery. Version 0.5.5 removes
the provider-specific `prefix` parser exception and replaces it with the single
formatting boundary described above. The same rule now covers interview
responses, document plans, and malformed legacy part envelopes for direct APIs,
CLI adapters, and custom adapters: one semantic response, then zero to three
closed formatting attempts. Unknown authority fields still fail the strict
contract; the formatter cannot grant them meaning.

Version 0.5.6 removes a contradictory retired instruction that still told every
workflow to emit the complete document bundle during the compact planning call.
The plan is now explicitly an index with bounded summaries, coordination,
document purposes, and part briefs; shared facts live once in the coordination
ledger instead of being repeated in every part. Greenfield `init` planning also
uses the complete request already present in its authority package and does not
buy a second tool turn to reread that same source file.

Version 0.5.7 keeps the document plan bounded as a whole while removing
arbitrary byte ceilings from individual prose fields. Models are no longer
asked to count UTF-8 bytes in a part purpose, and a semantically valid compact
plan is never sent through three paid formatter attempts merely because one
brief crossed such an advisory threshold. Paths, IDs, schema, document/part
counts, total plan size, part body size, and final Ralph validators remain
strict.

Version 0.5.8 changes two behaviors that a consumer can observe:

- the interview converges instead of expiring. It was a fixed batch plus one
  follow-up, so an answer that opened a new material decision earned no round
  at all and the run ended BLOCKED with the decision still open. It now runs
  focused rounds until nothing material remains, carries a round's surplus
  questions into the next one instead of deferring them, never re-asks a
  settled decision, and reports reaching either declared safety ceiling — 12
  rounds, 40 questions — as a failure to converge rather than an acceptance;
- a generated `rb-execution/v1` plan is validated for decomposition, not only
  for grammar. Because RB Ralph runs one ephemeral, context-free call per task,
  ceilings read from the document's own declarations reject a task that carries
  a whole feature, as a repairable structural error before publication and a
  blocker in `rb-harness artifacts verify`.

The interview's own accepted decisions also fit its budgets now: the decision
count ceiling follows the run-wide question ceiling, and the input package and
interview prompt budgets grew with it, so a fully converged interview can never
fail on the answers the developer already gave.

Two failures observed against real providers are fixed with them:

- the output contract promised a root `AGENTS.md` for ai-context while the
  parser rejected every path outside `.rb/`, so a model that obeyed the contract
  was rejected and then sent three times to a formatter that may only change
  representation and could never fix a path. The contract now states the one
  location `rb-manifest/v1` can actually index, `.rb/context/AGENTS.md`, a
  forbidden path is classified as a substance defect rather than a formatting
  one, and such a defect earns a single counted replan carrying the exact
  rejection instead of three attempts that can only fail the same way;
- a structural repair replaces each document it plans in full, but the repair
  contract asked for a "localized" change, so a repair that emitted only the
  corrected fragment deleted the document's title, contract markers, and every
  phase. The validators then reported four symptoms of one cause. The contract
  now states that a replanned document is rewritten in full, and a repair that
  drops a title or contract marker its original declared is rejected by name
  instead of through the grammar errors it produces;
- a published `OPERATIONS.json` could assert against a service the scenario had
  already stopped. The verifier starts a `process` step, waits for `ready`, runs
  that step's own `checks`, then stops it in a `finally`, so a sibling
  `http`/`tcp` step placed after it meets a closed port — and a scenario that
  probes a local address without starting a process never had a server at all.
  Both shapes pass every structural rule and can never pass execution, and the
  executor cannot repair them because generated specifications are read-only to
  it. One observed run spent nine attempts and five hours there before the
  circuit breaker paused it. The contract is now rejected before publication,
  the digest states the lifecycle and the example models it, and `${RB_VERIFY_PORT}`
  replaces hard-coded ports;
- a declared validation that cannot pass. Two shapes came from one real plan
  that `contract validate` had approved: `npm start` as the validation for the
  task that makes `npm start` work — a service never exits, so the runner waits
  out the validation timeout and repeats the phase — and a manager inspection
  wrapped in backticks, which the runner tries to execute as a program that does
  not exist. Both are now rejected before publication, naming the line and the
  form the entry should have taken;
- a checker aimed at a format it cannot parse. The same run proved the
  operational contract with `node --check .rb/init/OPERATIONS.json`, and
  `node --check` parses JavaScript: it exits non-zero for a valid JSON file
  and cannot tell one from a broken one. It is now rejected with the right
  command named;
- `Parallel safe` is now a decision the contract asks the writer to make, with
  the criteria for `true` spelled out. A phase runs concurrently only when every
  pending task declares `true`, so a plan that marked all 25 tasks `false` — as
  an observed one did — serialized work that had disjoint scopes.
- a part writer that wrapped its whole answer in a Markdown code fence had those
  backticks published inside the file. One observed run wrote a valid
  `OPERATIONS.json` body between ```` ```json ```` and ```` ``` ````, which
  failed the operational contract and forced the structural repair that then
  truncated `PHASES.md` — one habitual formatting slip taking down the tree. A
  fence that encloses an entire document is now removed before publication,
  under CommonMark rules narrow enough that a document legitimately containing
  fenced code blocks is never touched.

The readiness pass that followed added, without changing that public surface:

- structural process-tree containment through cgroup v2 where the platform
  offers it, and an explicit "not verified" report where it does not — including
  Windows, where `taskkill /T` is never presented as a Job Object;
- a benchmark that only reports a run this invocation created, proves
  Ralph-readiness through the deterministic artifact contract, exits non-zero on
  any failure, writes a report even when it fails, and stays `incomplete`
  — never `passed` — until the observed cost is recorded by a finalization step
  that starts no provider;
- per-adapter capability declarations read from the installed CLIs, with real
  event accounting where a CLI's stream is consumed and conservative
  time/volume/progress limits everywhere else;
- an unclassified or unknown interview disposition that can never become an
  acceptance, and surplus questions that become declared deferred decisions;
- one shared path policy that keeps `.rb-harness`, `.git`, `.rb/runs`,
  credentials, traversal, and symlink escapes out of every tool, plus a bounded
  read-only evidence projection in its own temporary root, with read confinement
  declared honestly per adapter rather than implied;
- declared byte budgets enforced before a provider is created, with the request
  treated as authority and never truncated;
- an invariant prompt prefix that is actually invariant, and cache claims
  limited to what a provider measures.

`docs/benchmarks/` holds the baseline, the reproducible harness, and the exact
command for the authorized `cron2` run. **That run has not been executed**: the
0.4.0 numbers are pending, and no claim of beating the baseline is made until an
operator runs it.

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

`npm run check` builds, typechecks, packs and runs the real npm archive through
an installed `bin/rb-harness` symlink, executes the test suite, and validates the
Bash resolver and the legacy plugin adapters.

To measure a real workflow against a real provider and record a versioned,
credential-free report, use the benchmark harness:

```sh
node scripts/benchmark.mjs --project /path/to/project \
  --workflow init --file prompt.md \
  --provider opencode --model opencode-go/deepseek-v4-pro \
  --label cron2-rb-harness --observed-cost-usd 0.23
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
rb-harness artifacts verify --project . --artifacts-dir .rb --against request.md
rb-harness artifacts verify --project . --artifacts-dir .rb --json
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
