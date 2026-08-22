# How to Use RB Harness

RB Harness generates provider-neutral project documentation. It does not
implement application code: its output can be reviewed and then handed to any
capable coding CLI/model or consumed by RB Ralph.

## Before the first use

The plugin source lives at `plugins/rb-harness/`. Build and validate the
bundled deterministic CLI once from the RB Harness repository:

```bash
npm install
npm run check
```

The current repository is ready for local plugin registration but does not yet
publish an installer or marketplace package. After the plugin is enabled in the
chosen host, open that host in the root of the project to be documented.

Codex exposes the workflows as skills. Claude Code exposes the same workflows
as namespaced slash commands:

| Workflow | Codex | Claude Code |
|---|---|---|
| New project | `$rb-init` | `/rb-harness:init` |
| Existing project | `$rb-ai-context` | `/rb-harness:ai-context` |
| Whole-product audit | `$rb-review` | `/rb-harness:review` |
| Evolve existing behavior | `$rb-evolve` | `/rb-harness:evolve` |
| Feature, fix, refactor, or migration | `$rb-plan` | `/rb-harness:plan` |

## Start a new project

Use a description directly:

```text
$rb-init Quero criar uma plataforma de agendamento para clínicas com múltiplas unidades.
```

Or keep a longer brief in a file:

```text
$rb-init @docs/project-brief.md
```

`--file docs/project-brief.md` and an existing bare file path are also valid.
RB Harness inspects any useful non-secret material already present, asks only
material missing decisions, confirms a normalized summary, and writes the
initial documentation under `.rb/init/`.

Typical result:

```text
.rb/
  rb-manifest.json
  artifacts.tsv
  init/
    PROJECT.md
    REQUIREMENTS.md
    DECISIONS.md
    ARCHITECTURE.md
    PLAN.md
    PHASES.md
    source-manifest.json
```

Glossary, workflows, non-functional requirements, and formal contracts are
conditional. They are not generated merely to fill a fixed template.

## Document an existing or legacy project

Run from the existing project root:

```text
$rb-ai-context . --balanced
```

Available interview depths:

- `--quick`: asks only blocking questions and records more assumptions.
- `--balanced`: default; up to five initial questions and three material
  follow-ups.
- `--deep`: expands high-risk investigation for security, public contracts,
  migrations, regulated data, or distributed workflows.

The workflow inspects manifests, source, tests, CI, and configuration before
asking anything. It excludes secrets, generated dependencies, build outputs,
and RB intent documents from behavioral evidence. Its output is `AGENTS.md`
plus conditional documents under `.rb/context/`.

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

```text
$rb-review . --balanced --focus frontend,security,tenancy,tests
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

```text
$rb-evolve Vincular materiais de estoque à abertura da ordem de serviço.
```

The workflow proves AS IS behavior first, then documents TO BE, readers/writers,
impact, preservation, migration, compatibility, and a regression matrix under
`.rb/evolutions/<slug>/`. It routes by impact rather than the phrase "new
feature" and preserves existing behavior that the accepted delta does not
change. Use ordinary `rb-plan` for genuinely isolated new behavior or a scoped
fix that does not need this transition analysis.

## Plan a change

After `rb-init` or `rb-ai-context`, describe the change:

```text
$rb-plan Corrigir a duplicação de cobrança quando o gateway demora para responder.
```

Or reference a request file:

```text
$rb-plan @docs/requests/idempotent-charge.md
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
RB_CLI="/path/to/rb-harness/plugins/rb-harness/scripts/rb-harness.cjs"

node "$RB_CLI" contract validate .rb/features/<slug>/PHASES.md
node "$RB_CLI" operations validate .rb/features/<slug>/OPERATIONS.json
node "$RB_CLI" manifest sync .
node "$RB_CLI" tree validate .
node "$RB_CLI" tree resolve . --format tsv
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
rb-init -> review PHASES.md + OPERATIONS.json -> validate -> execute
```

For an existing project:

```text
rb-ai-context -> rb-review for discovery, rb-evolve for established-flow changes, or rb-plan for isolated work -> validate -> execute
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
