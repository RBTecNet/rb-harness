# RB Harness vNext — Implementation Checkpoint

**Status:** authoritative checkpoint for the next implementation conversation  
**Date:** 2026-08-28  
**Purpose:** replace the current RB Harness generation architecture with a smaller, deterministic vNext without repeating the failed incremental-patching cycle.

---

## 1. How to use this document

This file is the **continuation authority** for RB Harness vNext.

In a new conversation:

1. Attach this file.
2. Attach `RB-HARNESS-VNEXT-ARCHITECTURE-SPEC.md` if deeper architectural detail is needed.
3. State that implementation should continue from this checkpoint.
4. Do **not** reconstruct decisions from older conversations unless this checkpoint explicitly says they are still open.

If this checkpoint conflicts with the older architecture spec, **this checkpoint wins** for the decisions explicitly recorded here.

---

# 2. Current decision

We are **stopping compensating fixes on the legacy generation pipeline**.

The current Harness remains available as:

- rollback/reference implementation;
- source of useful tested infrastructure;
- regression corpus;
- evidence of previously discovered failure modes.

But we do **not** continue adding:

- new formatter exceptions;
- new document-plan aliases;
- new model repair loops;
- new validator patches to compensate for independent artifacts;
- higher retry budgets;
- more document-part orchestration.

The new architecture is built separately under a clear `vnext/` boundary.

---

# 3. Why the direction changed

The architectural reassessment identified six root causes in the current Harness:

1. **Multiple independent executable authorities**  
   Example: `PHASES.md` and `OPERATIONS.json` independently describe related execution facts and can contradict each other.

2. **Fragmented identity**  
   The same entity may be represented as path, basename, part ID, artifact ID, task ID, etc., creating translation failures.

3. **Non-monotonic validation**  
   Staging and final verification do not share one complete semantic closure. A real run reached:

   `24 → 5 → 1 → 0 findings`

   and then final verification discovered **12 new findings**.

4. **LLM-owned serialization**  
   Models were required to emit exact internal wire formats. A real MiMo failure contained complete semantics but one malformed `}` and an object/string shape mismatch. Recovery spent:

   - 1 original call;
   - 3 formatter calls;
   - 41,487 tokens;
   - ~80 seconds;

   and still failed.

5. **Document/document-part is the model work unit instead of semantic decisions**  
   Real runs produced 10–14 documents, 19–22 parts and ~30 tasks for comparatively small work.

6. **Mandatory artifacts were defined by Harness rather than the Ralph consumer contract**  
   Several mandatory artifacts were not needed by Ralph or any deterministic consumer.

These are architectural causes. Continuing to patch individual symptoms was judged likely to make the system more complex and less reliable.

---

# 4. Product direction

The target principle is:

> **LLM thinks. Adapter translates. Harness governs. Renderer emits. Ralph executes.**

Target flow:

```text
Request
   ↓
Typed ambiguity handling
   ↓
Provider Adapter + Model Profile
   ↓
Canonical Semantic Response
   ↓
Core resolution
   ↓
Workflow-specific IR
   ↓
ONE deterministic validation closure
   ↓
Deterministic renderers
   ↓
.rb artifacts
   ↓
Ralph verification
   ↓
Atomic publication
```

---

# 5. Single-source-of-truth rule

Generated files are **projections**, not independent authorities.

The Harness Core owns the authoritative internal semantic model.

The LLM does **not** directly author:

- PHASES Markdown grammar;
- task IDs (`T001`);
- phase IDs (`P01`);
- acceptance IDs (`AC-T001-01`);
- requirement machine IDs;
- artifact IDs;
- manifest IDs;
- hashes;
- timestamps;
- `.rb/...` artifact paths;
- manifest JSON syntax;
- OPERATIONS JSON syntax.

The LLM may author semantics such as:

- requirement statements;
- task intent;
- symbolic dependency keys;
- owned project paths;
- acceptance semantics;
- validation intent;
- user/product/architecture decisions;
- assumptions;
- semantic work decomposition.

TypeScript owns machine identity and rendering.

---

# 6. IR decision — IMPORTANT OVERRIDE TO THE EARLIER SPEC

Do **not** create one giant universal `ProjectModel` that gradually accumulates every workflow.

Use a shared core plus workflow-specific models.

Conceptually:

```ts
interface ProjectCore {
  identity: ProjectIdentity;
  determinations: Determination[];
  protectedPaths: ProtectedPath[];
  provenance: Provenance;
}

interface InitProjectModel {
  workflow: "init";
  core: ProjectCore;
  requirements: Requirement[];
  qualityCommands: QualityCommand[];
  phases: SemanticPhase[];
}
```

Future workflows may have:

```text
PlanProjectModel
EvolveProjectModel
ReviewProjectModel
AiContextProjectModel
```

sharing common typed primitives where appropriate.

Avoid a future universal model filled with optional fields such as:

```text
reviewFindings?
migration?
journeys?
responsiveInventory?
...
```

The IR must remain **consumer-driven**.

Rule:

> No IR field enters production unless we can answer: **who consumes this field and why?**

---

# 7. Phase 1 IR must stay small

For the **first vertical slice**, remove/defer fields that do not have immediate consumers.

### Keep

- project name;
- project objective;
- determinations;
- requirements;
- quality commands;
- protected paths;
- semantic phases;
- semantic tasks;
- symbolic dependencies;
- owned paths;
- task change intent;
- covers requirement keys;
- acceptance statements;
- validation intents;
- expected evidence;
- provenance.

### Defer from Phase 1

#### `Entrypoint`

Do not include it yet.

Reintroduce it when deterministic `OPERATIONS.json` rendering is implemented.

#### `Requirement.kind`

Do not include it yet.

Reintroduce it only when a real deterministic consumer exists.

### `Determination.rationale`

Keep it in Phase 1 because it improves `BRIEF.md` cold-agent context and provides human-readable decision reasoning.

---

# 8. Provenance cannot be model-declared authority

The model must not be trusted to declare:

> “the user explicitly said this.”

Do **not** use a model-authored boolean such as:

```ts
statedInRequest: boolean
```

as authoritative provenance.

Use verifiable provenance.

Conceptually:

```ts
type DeterminationSource =
  | {
      kind: "request";
      evidence: string;
    }
  | {
      kind: "user-answer";
      questionKey: SemanticKey;
    }
  | {
      kind: "model-default";
    };
```

For `kind: "request"` the Core must verify the evidence against the original request.

For `kind: "user-answer"` the Core must verify it against persisted interview answers.

Only Core assigns the final origin/provenance classification.

### Protected paths

A hard protected path may become authority only when it is:

- built-in;
- explicitly anchored in the request;
- explicitly confirmed by the user.

A model may **propose** a path for protection, but a model suggestion alone must not silently become immutable project authority.

Built-in protections include at minimum:

```text
.rb
.rb-harness
.git
```

---

# 9. Interview policy

Interview remains LLM-assisted because ambiguity discovery is semantic work.

But the blocking decision belongs to Core.

Use typed questions with:

```text
materiality:
- product
- architecture
- implementation
- preference

rigidity:
- RIGID
- FLEXIBLE
```

## Critical rule

A model-provided default must **not** automatically resolve a RIGID material product/architecture question.

Blocking precedence:

```ts
if (
  q.rigidity === "RIGID" &&
  (q.materiality === "product" ||
   q.materiality === "architecture")
) {
  return BLOCKING;
}

if (q.proposedDefault !== null) {
  return ASSUMED_DEFAULT;
}
```

Principle:

> A default may resolve FLEXIBLE uncertainty.  
> A default may recommend a RIGID decision, but it cannot decide it.

Implementation/preference questions should normally become explicit assumptions rather than blocking execution.

### First-slice interview ceiling

- max interview rounds: **1**
- max blocking questions asked: **3**
- more than 3 genuine blocking questions: **fail closed**
- no hidden adaptive loop

For non-interactive execution:

- non-blocking questions become recorded assumptions;
- unresolved blocking questions cause `INTERVIEW_BLOCKED`;
- do not invent product/architecture decisions.

---

# 10. Parallel safety — Phase 1 decision

Do **not** try to prove parallel safety from path disjointness in the first slice.

For Phase 1:

```text
Parallel safe: false
```

for every rendered task.

Reason:

Disjoint file paths do not prove absence of shared runtime state such as:

- database;
- port;
- external service;
- migration state;
- generated resource;
- shared build state.

Correct sequential execution is preferable to optimistic parallelism.

A future version may derive parallel safety after the IR contains enough typed shared-resource information to prove isolation.

---

# 11. Adapter architecture

Initial target families eventually include:

- Anthropic / Claude;
- OpenAI / Codex;
- MiMo;
- MiniMax;
- DeepSeek.

Not all must be implemented immediately.

## Responsibilities

### Provider Adapter

Owns protocol concerns only:

- endpoint;
- authentication;
- request envelope;
- streaming;
- cancellation;
- structured-output mechanism;
- provider errors;
- usage extraction.

### Model Profile

Owns model-specific capabilities:

- structured output mode;
- JSON Schema support;
- strict schema support;
- reasoning/thinking;
- supported effort values;
- output limits;
- system/developer role behavior;
- usage reporting;
- conformance result.

### Core Wire Decoder

Owns the RB Harness semantic wire contract.

Important boundary:

> **Provider adapter normalizes provider protocol. Core decoder normalizes the Harness wire format.**

Adapters must not understand:

- requirement semantics;
- phases;
- tasks;
- `PHASES.md`;
- Ralph;
- `T001`;
- `AC-T001-01`;
- `.rb/...`.

---

# 12. Adapter normalization boundary

Narrow the adapter normalizer to protocol/envelope transformations.

Allowed examples:

- unwrap provider envelope;
- unwrap forced tool-call arguments;
- strip a documented transport fence;
- remove provider-only metadata.

Avoid semantic-payload transformations such as:

- mapping `requirementsList` to `requirements`;
- changing semantic field names;
- converting semantic scalar fields to arrays;
- model-specific semantic aliases.

If the Harness wire contract itself needs aliases/version migration, Core handles it identically for every provider.

No formatter LLM exists in vNext.

No adapter may call a second model to repair output.

---

# 13. Adapter conformance is per model profile

Conformance must be recorded for the exact:

```text
provider family + model profile
```

Not just the family.

Examples:

```text
Anthropic
├── Opus profile + recordings
├── Sonnet profile + recordings
└── Haiku profile + recordings

OpenAI
├── Sol profile + recordings
├── Terra profile + recordings
├── Luna profile + recordings
├── Mini profile + recordings
└── Spark profile + recordings
```

Transport tests may share family fixtures, but **support status belongs to the model profile**.

A model is not advertised as supported until that exact profile passes the current conformance suite.

Same provider does not imply same capabilities or same response behavior.

---

# 14. Reference provider

Use **Anthropic / Claude** as the first direct-API reference family.

Initial reference model proposed by the architecture spec:

```text
anthropic:claude-opus-5
```

Reasons:

- existing Anthropic Messages dialect and credential infrastructure;
- useful cache-read/cache-write telemetry;
- exercises the adapter normalization/conformance layer instead of trivially bypassing it;
- does not force the initial IR design around OpenAI strict-schema limitations.

The **second provider family must be OpenAI** to stress the same semantic wire contract under stricter JSON Schema behavior.

This is a reference implementation only.

Harness Core must contain no Claude-specific logic.

---

# 15. Semantic generation protocol

The unit of model work is a **semantic slice**, never a document or Markdown part.

First `init` vertical slice uses two normal semantic calls:

```text
Call 1 — intent
  project semantics
  determinations
  questions
  requirements
  quality commands
  proposed protected paths

Call 2 — work
  phases
  tasks
  symbolic dependencies
  owned paths
  coverage keys
  acceptance semantics
  validation intents
  evidence
```

The work schema is generated after intent resolution so Core can constrain:

- `covers` to actual requirement keys;
- validation command references to actual declared quality-command keys.

This makes several invalid states unrepresentable at the provider boundary.

### Normal call count

```text
2 Harness semantic calls
```

No formatter calls.

No document-plan calls.

No document-part calls.

No model repair calls.

---

# 16. Global call budgets

Do not recreate multiplicative nested ceilings.

For the first vertical slice:

```text
max Harness semantic calls:          4
normal semantic calls:               2

max transport retries per call:      1
max transport retries per RUN:       2

max underlying provider requests:    6

max semantic retries:                0
max formatter calls:                 0
max model repair calls:              0

max interview rounds:                1
max blocking questions asked:        3
```

Important correction:

Four semantic calls with one retry each could theoretically make eight provider requests.

Therefore the **global six-request limit is authoritative**, with at most two transport retries across the whole run.

No stage-specific allowance may bypass the global ceilings.

Unknown telemetry is reported as:

```text
unmeasured
```

never fabricated as zero.

---

# 17. Phase 1 artifact set

The first vertical slice emits exactly:

```text
.rb/
├── rb-manifest.json
└── init/
    ├── PHASES.md
    └── BRIEF.md
```

### `PHASES.md`

The executable Ralph plan.

Fully rendered by TypeScript from the IR.

### `BRIEF.md`

Keep this name.

Purpose:

- satisfy Ralph's non-empty `Context` requirement;
- provide sufficient cold-agent semantic authority;
- give meaning to requirement references and decisions.

It is a **non-executable projection**.

It must not independently define:

- task IDs;
- acceptance IDs;
- commands;
- phases;
- executable ownership.

Every phase's `Context` is code-derived and points to:

```text
.rb/init/BRIEF.md
```

### `rb-manifest.json`

Fully code-generated from staged artifact bytes.

No model involvement.

### Explicitly absent in Phase 1

```text
artifacts.tsv
OPERATIONS.json
PROJECT.md
REQUIREMENTS.md
DECISIONS.md
PLAN.md
source-manifest.json
GLOSSARY.md
WORKFLOWS.md
ARCHITECTURE.md
NON_FUNCTIONAL.md
contracts/*
```

Do not add them just because legacy Harness generated them.

---

# 18. Validation architecture

There is one semantic validation closure over the workflow-specific IR.

No separate concepts of:

```text
local valid
staging valid
final valid
```

Rendering is deterministic.

After rendering, contract/round-trip checks verify that the renderer correctly represented already-valid semantics.

Final Ralph verification must never be the first place a semantic rule appears.

Architecture:

```text
semantic response
   ↓
Core decode
   ↓
resolution
   ↓
canonicalization
   ↓
ONE IR validator
   ↓
render
   ↓
round-trip contract verification
   ↓
manifest/tree verification
   ↓
Ralph consumer verification
   ↓
publish
```

If rendered output fails a semantic Ralph rule that the IR validator allowed, that is a **bug in the invariant mapping**, not a new repair opportunity.

No model repair loop exists in Phase 1.

---

# 19. Phase 1 deterministic safety decisions

Keep/reuse proven invariants from the legacy system where applicable, including:

- protected control-plane paths;
- project-relative path validation;
- backward-only dependency semantics;
- task and phase uniqueness;
- acceptance criteria validity;
- non-interactive validation commands;
- no masked failure commands;
- no long-running service validation;
- no impossible checker misuse;
- execution contract grammar;
- manifest/hash correctness.

However:

> enforce these on the typed IR wherever possible, not by mining generated prose.

Visual-contract semantics are outside the first CLI vertical slice.

If visual acceptance appears, fail closed rather than introducing the full visual model now.

---

# 20. Publication architecture

Render only into staging.

Lifecycle:

```text
IR valid
   ↓
render staging
   ↓
round-trip verify
   ↓
Ralph contract/tree verify
   ↓
atomic publication
   ↓
post-publication byte/hash verification only
```

There must be no:

```text
publish
→ discover semantic issue
→ rollback
→ model repair
→ republish
```

cycle.

Rollback remains for:

- filesystem failure;
- interrupted publication.

Not semantic convergence.

---

# 21. Legacy coexistence

Build vNext under:

```text
packages/core/src/vnext/
```

Do not intermix the new architecture into the old large functions.

Legacy remains:

```text
rb-harness init
```

during development.

Experimental entry point:

```text
rb-harness vnext init
```

The dependency boundary must be one-way:

```text
vnext may import an explicit allowlist of healthy legacy utilities
legacy must not import vnext
except cli-program.ts registering the command group
```

Protect this with an import-boundary test.

Do not delete legacy code during Phase 1.

---

# 22. Useful legacy code to preserve

Reassess before copying, but the architecture review considered these healthy/reusable concepts:

- splash/capybara;
- credential store;
- process tree;
- process containment;
- path safety;
- filesystem helpers;
- hashing;
- `ExecutionDocument` typed shape;
- execution-contract parser/validator as a fidelity oracle;
- manifest validation primitives;
- atomic staging/publication;
- lock/run-state/checkpoint ideas;
- telemetry concepts;
- provider capability distinction between advertised and verified.

Do not preserve modules just because they exist.

---

# 23. Legacy architecture NOT to port

Do not port:

- document-plan protocol;
- document-part protocol;
- document-by-document authorship;
- dependency projection between generated documents;
- LLM control formatter;
- model structural repair;
- region splicing repair;
- post-publication semantic repair cycle;
- artifact-consistency logic needed only because independently-authored executable files disagree;
- prose-mined protected-path authority;
- mandatory artifact table not derived from consumer needs;
- legacy contract digest teaching the model PHASES Markdown syntax.

---

# 24. Phase 1 implementation objective

**Phase 1 uses zero providers.**

This is intentional.

Implement and prove:

```text
hand-written InitProjectModel fixture
        ↓
resolve symbolic keys
        ↓
assign code-owned IDs
        ↓
canonicalize
        ↓
validate
        ↓
derive ExecutionDocument
        ↓
render PHASES.md
        ↓
render BRIEF.md
        ↓
render rb-manifest.json
        ↓
parse/render round-trip
        ↓
Ralph-compatible deterministic verification
        ↓
staging
        ↓
atomic publication in test fixture
```

There must not yet be:

- provider adapter implementation;
- semantic gateway;
- real LLM;
- formatter;
- model repair;
- `OPERATIONS.json`;
- CLI-provider transport.

---

# 25. Phase 1 acceptance fixture

Use a trivial greenfield CLI request equivalent to:

> Create a Node.js CLI named `hello`. Running `hello <name>` prints `Hello, <name>!`; running without a name prints `Hello, world!`; include automated tests.

The hand-written semantic fixture should result in approximately:

```text
1–2 phases
2–4 tasks
≥3 requirements
≥1 test quality command
```

Expected files:

```text
.rb/rb-manifest.json
.rb/init/PHASES.md
.rb/init/BRIEF.md
```

Expected deterministic properties:

- Ralph execution contract validates;
- manifest validates;
- exactly one READY execution plan exists;
- cold-agent Context points to BRIEF;
- no model-authored machine IDs exist in semantic fixture;
- task IDs are deterministic;
- acceptance IDs are deterministic;
- dependencies resolve symbolically and deterministically;
- all tasks render `Parallel safe: false` in Phase 1;
- repeated rendering of identical IR produces byte-identical `PHASES.md` and `BRIEF.md`;
- manifest hashes match exact staged bytes.

---

# 26. Implementation roles

Recommended workflow:

```text
Opus
  → architecture / independent review

Codex
  → implementation

ChatGPT
  → scope control / review synthesis / next-step prompts
```

Reason:

Use different models for architecture, implementation and review to reduce correlated design/implementation errors.

Do not let the same model silently redesign its own implementation while executing.

---

# 27. Git / safety rules

Use a separate vNext branch.

Suggested:

```text
feat/vnext-deterministic-core
```

Before implementation:

- preserve a local frozen legacy reference;
- do not rewrite rescue/history commits;
- keep rollback easy;
- do not push unless explicitly decided later.

Pre-existing unrelated worktree changes such as:

```text
package.json
AGENTS.md
```

must be preserved and excluded unless the user explicitly changes that instruction.

`AGENTS.md` is intentional user tooling/context-status configuration.

Do not delete or rewrite it.

---

# 28. Product constraints

Non-negotiable:

- splash untouched;
- capybara untouched.

Future planned simplifications, **not part of Phase 1**:

- remove RB Memory integration;
- remove Claude Code plugin-style integration;
- remove Codex plugin-style integration;
- standalone CLI becomes the product surface.

These removals must not be mixed into deterministic-core implementation.

---

# 29. Reference provider roadmap

After deterministic Phase 1 succeeds:

### Phase 2

Implement provider/adaptation/conformance layer with:

```text
Anthropic / Claude Opus
```

as reference.

No Core provider-specific logic.

### Next adapter

OpenAI / Codex.

Purpose:

stress the same semantic wire schema against a different and stricter structured-output environment.

### Later

```text
MiMo
MiniMax
DeepSeek
```

Each provider/model profile must pass conformance before it is marked supported.

---

# 30. Architectural invariants for future reviews

1. **No model-authored machine identity.**
2. **No independently-authored executable authorities.**
3. **No provider-specific behavior in Harness Core.**
4. **No LLM call for representation repair.**
5. **No semantic rule exists only at final verification.**
6. **No document is required without a consumer.**
7. **No recovery result bypasses the full deterministic closure.**
8. **No provider/model is supported without per-profile conformance.**
9. **No publication before semantic and Ralph validation succeed.**
10. **No nested call/retry budget may exceed the global run ceiling.**
11. **No IR field exists without an identified consumer.**
12. **Adapter normalization is protocol-only.**
13. **Adapters author no semantic prompt policy.**
14. **Parallel safety is conservative until isolation is provable.**
15. **Telemetry reports unknown metrics as `unmeasured`, never fake zero.**
16. **Interview blocking is decided in Core from typed policy.**
17. **A model default never overrides a RIGID material product/architecture decision.**
18. **Legacy and vNext dependency flow is one-way.**
19. **No fallback to a second model/profile on semantic failure.**
20. **Semantic output is produced as slices, never document parts.**
21. **The IR is workflow-specific over a shared core, not one universal optional-field model.**
22. **Hard user authority requires verifiable provenance.**

---

# 31. Immediate next step

Do **not** ask for another broad architecture report.

The architecture is sufficiently decided for the first implementation milestone.

Next action:

> Ask Codex to implement **Phase 1 — deterministic core only**, from this checkpoint and the full vNext architecture spec.

Implementation must be constrained to:

```text
identity
shared/project core types
InitProjectModel
resolution
canonicalization
validation
ExecutionDocument derivation
PHASES renderer
BRIEF renderer
manifest renderer
round-trip/Ralph fidelity
staging/publication fixture
tests
```

No provider code.

No adapter code.

No interview runtime yet.

No provider calls.

No legacy deletion.

---

# 32. Success condition for the next conversation

The next conversation should consider Phase 1 successful only when:

```text
fixture IR
   ↓
deterministic core
   ↓
exact 3-artifact .rb tree
   ↓
round-trip green
   ↓
manifest/hash green
   ↓
Ralph-compatible READY
```

with:

```text
0 provider calls
0 formatter calls
0 repair calls
0 provider-specific branches
```

Once that is proven, move to adapter/conformance work.

---

## Final reminder

The goal is **not** to reproduce the legacy Harness with cleaner TypeScript.

The goal is to remove the architectural conditions that made the legacy Harness require:

- formatters;
- replans for identity;
- document-part orchestration;
- cross-document reconciliation;
- model structural repair;
- escalating call budgets.

If a vNext implementation starts recreating those mechanisms under new names, stop and reassess before continuing.

And, obviously:

> **Do not touch the capybara.**
