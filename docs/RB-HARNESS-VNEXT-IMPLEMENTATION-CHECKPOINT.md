# RB Harness vNext — Implementation Checkpoint

**Status:** authoritative continuation checkpoint for Phase 3
**Date:** 2026-08-29
**Purpose:** connect the proven deterministic Core and independently conformed provider transports into a useful semantic `vnext init` vertical slice without repeating the failed incremental-patching cycle.

---

## 1. How to use this document

This file is the **continuation authority** for RB Harness vNext.

In a new conversation:

1. Attach this file.
2. Attach `RB-HARNESS-VNEXT-ARCHITECTURE-SPEC.md` if deeper architectural detail is needed.
3. State that implementation should continue from this checkpoint.
4. Do **not** reconstruct decisions from older conversations unless this checkpoint explicitly says they are still open.

If this checkpoint conflicts with the older architecture spec, **this checkpoint wins**. In particular, the interview, provenance, semantic-recovery, request-accounting, transport-identity and roadmap decisions recorded here explicitly supersede older proposals.

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

The bounded whole-slice semantic recovery authorized later in this checkpoint is not a legacy formatter/model-repair loop and does not reopen that architecture.

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

RB Harness exists to transform even an incomplete, vague or poorly specified user request into a sufficiently complete MVP specification that can be deterministically rendered into `.rb` artifacts and executed end-to-end by Ralph.

The user is not required to arrive with a perfect prompt, complete architectural knowledge or zero ambiguity. The Harness owns the burden of discovering material gaps, explaining consequential choices, recommending conventional answers and reaching a usable minimum viable semantic closure.

The target principle is:

> **LLM thinks. Adapter translates. Harness governs. Renderer emits. Ralph executes.**

Target flow:

```text
Request
   ↓
Semantic understanding
   ↓
Typed ambiguity discovery and resolution
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

The product success criterion is:

```text
user request
   ↓
semantic understanding
   ↓
ambiguity resolution / interview
   ↓
reasonable controlled recovery when needed
   ↓
valid workflow-specific IR
   ↓
deterministic render
   ↓
Ralph-compatible .rb artifacts
   ↓
Ralph executes the plan end-to-end
```

The Harness must not require the user to understand software architecture merely to request an MVP. Questions should be limited to decisions that materially change what is being built; implementation trivia should normally receive an explained recommendation rather than becoming unnecessary interrogation.

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

Phase 3 orchestration and evidence concepts do not automatically become `InitProjectModel` fields. In particular, keep these outside the workflow IR unless an actual deterministic IR consumer is identified:

```text
InterviewQuestion[]
recommendation presentation state
interactive/headless response state
run budget counters
provider invocation state
raw wire responses
decode attempts
semantic recovery findings
recovery attempt history
```

`InitProjectModel` represents resolved project semantics, not the history of how those semantics were obtained. A resolved determination may reference verifiable provenance such as `questionKey` without embedding the complete interview or orchestration state into the IR.

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
      kind: "accepted-recommendation";
      questionKey: SemanticKey;
    }
  | {
      kind: "model-default";
    };
```

For `kind: "request"` the Core must verify the evidence against the original request.

For `kind: "user-answer"` the Core must verify it against persisted interview answers.

For `kind: "accepted-recommendation"` the Core must verify all of the following against persisted interview state:

```text
the question existed
the recommended answer was presented or prepared for policy presentation
the interactive response was blank, or the run was explicitly non-interactive
the selected value equals that exact recommendation
the acceptance mode is recorded
```

Persist enough state to distinguish:

```text
explicit user answer
blank interactive acceptance
non-interactive policy acceptance
silent model assumption
```

Do not rewrite an accepted recommendation as `user-answer`: the user did not type that value. Do not rewrite it as `model-default`: the recommendation became authoritative through a defined interaction policy. It is a distinct, verifiable authority class.

Only Core assigns the final origin/provenance classification.

### Protected paths

A hard protected path may become authority only when it is:

- built-in;
- explicitly anchored in the request;
- explicitly confirmed by the user;
- established by a presented and accepted recommendation whose provenance Core verifies.

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

The model discovers ambiguity and recommends semantically useful answers. Core owns question identity, persisted state, selection authority, provenance and the decision that enough semantic authority exists to continue.

Every user-facing question must contain exactly one concrete recommended answer. Conceptually:

```ts
interface InterviewQuestion {
  key: SemanticKey;
  question: string;
  materiality: "product" | "architecture" | "implementation" | "preference";
  rigidity: "RIGID" | "FLEXIBLE";
  recommendedAnswer: {
    value: string;
    rationale: string;
  };
  alternatives?: readonly string[];
}
```

The Harness never asks a question without also offering the option it recommends. The model is responsible for recommendation quality; Core decides how a selected recommendation becomes authority.

## Answer selection

```text
non-blank user answer
→ select the explicit answer
→ provenance: user-answer

blank interactive answer
→ select the recommendation that was shown
→ provenance: accepted-recommendation

no interactive answer channel
→ generate and persist the question and recommendation that would have been shown
→ select it under non-interactive policy
→ provenance: accepted-recommendation with non-interactive acceptance state
```

A blank answer is not unresolved ambiguity. Do not repeat the same question, fail the run or silently substitute a different value. This applies to both `RIGID` and `FLEXIBLE` questions.

## RIGID decisions

The old rule that a model recommendation can never resolve a `RIGID` product/architecture decision is superseded by a distinction between silent and presented recommendations.

A **silent model default** that was never presented remains model-owned. It cannot silently become hard user authority for a `RIGID` material decision.

A **presented recommendation** that the user accepts by submitting blank is resolved under the Harness interaction contract:

```text
RIGID product/architecture question
+ recommendation shown
+ blank response
→ RESOLVED
→ accepted-recommendation provenance
```

The model still cannot claim that the user explicitly said something they did not say.

## Semantic sufficiency

Interview termination is based on whether the Harness has enough authority to construct a coherent MVP, not on a raw question count. Minimum viable semantic closure means:

```text
project objective is understood
material product behavior is defined
material architecture decisions required for planning are resolved
requirements are sufficiently concrete
remaining ambiguity can safely become explicit assumptions/defaults
no unresolved contradiction prevents executable decomposition
```

An underspecified initial request is not a failure condition. The ordinary flow is:

```text
underspecified request
→ identify material ambiguities
→ ask focused questions with recommendations
→ accept explicit answers or presented recommendations
→ persist determinations and provenance
→ continue toward minimum viable semantic closure
```

The implementation may batch questions and retain a finite operational ceiling to prevent runaway loops. The checkpoint intentionally does not freeze an arbitrary round count. If a ceiling is reached, remaining resolvable questions first adopt their already-presented recommendations. Exhaustion is not, by itself, `INTERVIEW_BLOCKED`.

`INTERVIEW_BLOCKED` is exceptional. It is permitted only when no safe or meaningful decision can be established through the approved recommendation policy, an unresolved contradiction prevents executable decomposition, or the user explicitly prevents resolution. Ordinary product/architecture ambiguity and lack of initial detail are not blocking conditions.

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

- provider family and transport identity;
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

- exact provider transport;
- structured output mode;
- JSON Schema support;
- strict schema support;
- reasoning/thinking;
- supported effort values;
- output limits;
- system/developer role behavior;
- usage reporting;
- request-accounting mode (`exact` or `opaque`);
- external-runtime version constraints where applicable;
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

# 13. Adapter conformance is per transport and exact model profile

Conformance and support must be recorded for the exact identity:

```text
provider family
+ transport
+ exact model profile
+ conformance suite version
+ exact runtime version where the transport is an external executable
```

Not just the provider family or model name. A conformance result earned by one transport can never authorize another transport, even when both use the same provider family and model.

Examples:

```text
anthropic / direct-api / claude-opus-5
→ SUPPORTED

anthropic / claude-code-cli / claude-opus-5
→ SUPPORTED
```

Transport tests may share provider-neutral suite fixtures, but **support status belongs to the exact transport/profile identity and its integrity-bound record**.

A profile is not advertised as supported until that exact identity passes the current conformance suite. Stale suite or executable-runtime evidence fails closed.

Same provider does not imply same capabilities or same response behavior.

---

# 14. Reference provider

The first direct-API reference family is **Anthropic / Claude**.

The proven reference profile is:

```text
family:             anthropic
transport:          direct-api
profile:            anthropic:claude-opus-5
model:              claude-opus-5
requestAccounting:  exact
tier:               SUPPORTED
```

Reasons:

- existing Anthropic Messages dialect and credential infrastructure;
- useful cache-read/cache-write telemetry;
- exercises the adapter normalization/conformance layer instead of trivially bypassing it;
- does not force the initial IR design around OpenAI strict-schema limitations.

The independently proven subscription transport is:

```text
family:             anthropic
transport:          claude-code-cli
profile:            anthropic:claude-code-cli:claude-opus-5
model:              claude-opus-5
requestAccounting:  opaque
tier:               SUPPORTED
runtime gating:     exact recorded Claude Code version
```

Opaque accounting is a supported capability mode, not degraded conformance. It means the Harness can count and bound its own CLI process invocation but does not fabricate visibility into provider-internal work.

Additional provider families, including OpenAI, remain future separately approved work rather than Phase 3 scope.

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

intent: 1
work:   1
```

No formatter calls.

No document-plan calls.

No document-part calls.

No representation or document repair calls.

## Controlled semantic recovery

The old `max semantic retries: 0` policy is superseded. A bounded whole-slice corrective regeneration is allowed when Core decoding or semantic validation rejects a generated slice:

```text
semantic slice generation
        ↓
Core decode / semantic validation fails
        ↓
deterministic findings
        ↓
regenerate the COMPLETE SAME semantic slice using:
  original authoritative inputs
  resolved interview decisions
  deterministic validation findings
        ↓
full decode / resolution / canonicalization / validation again
```

This is semantic recovery, not formatter repair. It must regenerate the complete same slice. It must not patch an individual field, fix JSON with another model, patch Markdown, splice document regions or invoke another model/profile.

The model continues to produce semantics. Core continues to validate semantics. TypeScript continues to serialize artifacts.

---

# 16. Global call budgets

Do not recreate multiplicative nested ceilings.

For the initial Phase 3 vertical slice:

```text
normal intent generation:                 1
normal work generation:                   1
normal semantic operations:               2

max corrective regeneration per slice:    1
max corrective regenerations per run:     2
max semantic operations per run:          4

max Harness transport retries per call:   1
max Harness transport retries per run:    2
max Harness transport invocations/run:    6

max formatter calls:                      0
max representation/document repair calls: 0
max cross-profile fallback calls:         0
```

Non-normative worked example of the ceiling:

```text
worst allowed Phase 3 run:

4 semantic operations
  2 normal
  2 corrective

+ at most 2 Harness transport retries across the run

= maximum 6 Harness transport invocations
```

The per-call transport retry allowance does not multiply independently across all four semantic operations. The per-run ceiling of two Harness transport retries remains authoritative.

The exact numeric recovery ceiling is authoritative unless implementation discovers a compelling technical reason to change it. Such a reason must be reported for approval rather than silently increasing the budget.

The universal budget covers what the Harness controls:

```text
semantic operations
transport invocations
Harness transport retries
semantic corrective regenerations
formatter calls
repair calls
fallback calls
deadlines
```

It does **not** require universal visibility into transport-internal provider work.

```ts
type RequestAccounting = "exact" | "opaque";
```

For `exact` transports, `providerRequests` may be reported as measured when the provider transaction exposes it. The direct Anthropic API profile is `exact` and normally reports one measured provider request per adapter invocation.

For `opaque` transports, `providerRequests` remains `unmeasured`. The Claude Code CLI profile is `opaque`: one `adapter.request()` owns exactly one Harness-started CLI process, while undocumented provider-internal structured-output work remains transport-owned.

Do not infer provider requests from process count, `num_turns`, assistant-message count or token arithmetic. Opaque accounting does not weaken deadlines or cancellation:

```text
one adapter request
→ one Harness-owned transport invocation
→ bounded by the Core-supplied deadline / cancellation
→ no adapter retry
→ no second model/profile
```

Provider-internal retries are not Harness recovery. Harness corrective regeneration is a separate, explicit semantic operation initiated only after Core returns deterministic findings.

No stage-specific allowance may bypass the Harness-controlled global ceilings, and no adapter may hide its own Harness retry loop.

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
semantic response or whole-slice corrective regeneration
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

Every regenerated slice re-enters this full deterministic closure. A recovery result has no privileged validation, rendering or publication path. Where applicable it must pass Core decode, resolution, canonicalization, IR validation, `ExecutionDocument` derivation, deterministic rendering, round-trip fidelity, Ralph verification and manifest/tree verification.

If rendered output fails a semantic Ralph rule that the IR validator allowed, that is a **bug in the invariant mapping**, not a new repair opportunity.

Controlled semantic recovery happens before accepted IR/render publication and responds only to deterministic Core findings. Final Ralph failure is not a model-repair opportunity.

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

# 24. Phase 1 completed implementation objective

**Phase 1 used zero providers.**

This was intentional and is now proven.

The completed milestone proved:

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

That milestone intentionally contained no:

- provider adapter implementation;
- semantic gateway;
- real LLM;
- formatter;
- model repair;
- `OPERATIONS.json`;
- CLI-provider transport.

---

# 25. Phase 1 completed acceptance fixture

The completed deterministic fixture used a trivial greenfield CLI request equivalent to:

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

Future planned simplifications, **not part of Phase 3**:

- remove RB Memory integration;
- remove Claude Code plugin-style integration;
- remove Codex plugin-style integration;
- standalone CLI becomes the product surface.

These removals must not be mixed into the Phase 3 semantic vertical slice.

Removing legacy Claude Code plugin-style integration does not mean removing the independently supported standalone `claude-code-cli` provider transport.

---

# 29. Completed milestones and provider roadmap

## Phase 1 — COMPLETE / PASS

The deterministic Core is proven:

```text
fixture semantic IR
→ code-owned identity
→ canonicalization
→ one semantic validation closure
→ deterministic PHASES + BRIEF + manifest
→ round-trip and Ralph READY
→ atomic publication
```

The approved properties include workflow-specific IR, literal `parallelSafe: false` for the current init slice, exact three-artifact output, BRIEF as non-executable context, manifest hashes from exact staged bytes and post-publication hash-only verification.

## Phase 2 — COMPLETE / PASS

The reference direct-API adapter is independently conformant:

```text
family:             anthropic
transport:          direct-api
profile:            anthropic:claude-opus-5
model:              claude-opus-5
requestAccounting:  exact
tier:               SUPPORTED
```

It preserves the semantic-blind provider boundary, protocol-only normalization, exact request accounting and source-controlled exact-profile conformance evidence.

## Phase 2B — COMPLETE / PASS

The subscription CLI adapter is independently conformant:

```text
family:             anthropic
transport:          claude-code-cli
profile:            anthropic:claude-code-cli:claude-opus-5
model:              claude-opus-5
requestAccounting:  opaque
tier:               SUPPORTED
```

Opaque accounting is a first-class supported capability mode. The Harness proves and budgets one owned CLI invocation per adapter request, enforces deadline/cancellation, and reports underlying provider requests as unmeasured.

Direct API and Claude Code CLI conformance are independent. Neither transport inherits the other's support result or falls back to it.

## Future providers

Not part of Phase 3 without separate approval:

```text
OpenAI
MiMo
MiniMax
DeepSeek
```

Every future provider/transport/model identity must pass conformance before it is marked supported.

---

# 30. Architectural invariants for future reviews

1. **No model-authored machine identity.**
2. **No independently-authored executable authorities.**
3. **No provider-specific behavior in Harness Core.**
4. **No LLM call for representation repair.**
5. **No semantic rule exists only at final verification.**
6. **No document is required without a consumer.**
7. **No recovery result bypasses the full deterministic closure.**
8. **No provider/transport/model identity is supported without exact-profile conformance.**
9. **No publication before semantic and Ralph validation succeed.**
10. **No nested Harness call/retry budget may exceed the Harness-controlled global run ceiling.**
11. **No IR field exists without an identified consumer.**
12. **Adapter normalization is protocol-only.**
13. **Adapters author no semantic prompt policy.**
14. **Parallel safety is conservative until isolation is provable.**
15. **Telemetry reports unknown metrics as `unmeasured`, never fake zero.**
16. **Interview blocking is decided in Core from typed policy.**
17. **An underspecified initial request is not itself a terminal failure.**
18. **Legacy and vNext dependency flow is one-way.**
19. **No fallback to a second model/profile on semantic failure.**
20. **Semantic output is produced as slices, never document parts.**
21. **The IR is workflow-specific over a shared core, not one universal optional-field model.**
22. **Hard user authority requires verifiable provenance.**
23. **Every interview question has one concrete recommended answer.**
24. **Blank interview input accepts the presented recommendation.**
25. **Accepted-recommendation provenance is distinct from explicit user answer and silent model default.**
26. **A presented, uncontested recommendation may resolve a `RIGID` product/architecture decision.**
27. **A silent model default may not become hard user authority for a `RIGID` material decision.**
28. **Interview termination is based on semantic sufficiency, not raw question count.**
29. **Controlled recovery regenerates one complete semantic slice and is globally bounded.**
30. **Formatter, representation repair, document repair and region splicing remain forbidden.**
31. **Provider support identity includes transport and applicable suite/runtime constraints.**
32. **Supported transports may use exact or opaque request accounting.**
33. **The Harness budgets what it initiates; opaque provider-internal work remains unmeasured.**
34. **One adapter request owns one Harness transport invocation; adapters contain no hidden Harness retry.**
35. **The ultimate init success condition is Ralph-executable `.rb` artifacts.**
36. **The user need not understand software architecture merely to request an MVP.**
37. **Run state is orchestration/evidence state, never an independent semantic authority.**
38. **Interview, provider, budget and recovery history stays outside workflow IR unless a deterministic consumer requires it.**

---

# 31. Immediate next step

Do **not** ask for another broad architecture report.

The architecture is sufficiently decided for the first real semantic vertical slice.

Next action:

> Ask Codex to implement **Phase 3 — semantic `vnext init` vertical slice**, using this checkpoint as authority and the older architecture spec only as non-conflicting background.

Phase 3 is the first time the approved provider layer and deterministic Core are connected:

```text
vnext init request
        ↓
supported provider/profile selection
        ↓
intent semantic generation
        ↓
typed ambiguity discovery
        ↓
interview with recommended answers
        ↓
explicit answers and blank/recommendation acceptance
        ↓
resolved determinations with verifiable provenance
        ↓
work semantic generation
        ↓
bounded whole-slice recovery if needed
        ↓
existing deterministic Phase 1 Core
        ↓
exact 3-artifact tree
        ↓
Ralph READY
        ↓
atomic publication
```

## Phase 3 implementation scope

- Semantic Gateway/orchestration;
- Core-owned semantic wire decoder;
- intent wire schema;
- work wire schema generated after intent resolution;
- typed interview questions and selection policy;
- recommended-answer presentation and handling;
- accepted-recommendation provenance and persisted verification state;
- interactive interview runtime;
- headless recommendation acceptance behavior;
- semantic sufficiency policy;
- bounded whole-slice corrective regeneration;
- Harness-controlled semantic/transport invocation budget;
- supported transport/profile selection without fallback;
- experimental `rb-harness vnext init` CLI wiring;
- run state required for interview and recovery continuity;
- end-to-end hello-style and intentionally underspecified request fixtures.

## Phase 3 run-state authority boundary

Phase 3 run state is orchestration/evidence state. It is not an independent semantic authority and must not become a second source of project truth.

The authoritative semantic project state remains:

```text
verified request/interview authority
        ↓
workflow-specific IR
```

Run state may preserve the evidence needed to reconstruct or verify that authority, including interview continuity, presented recommendations, explicit answers, acceptance modes, attempt state, budget state and recovery continuity. It must not independently define:

```text
requirements
tasks
phases
acceptance criteria
ownership
execution ordering
commands
```

Do not recreate legacy checkpoint/document graphs under a `run state` name.

## Phase 3 non-goals

Do not implement without separate approval:

```text
formatter LLM
representation repair model
document-plan protocol
document-part protocol
region splicing
post-publication semantic repair
automatic provider/profile fallback
OPERATIONS.json
legacy deletion
RB Memory removal
plugin removals
OpenAI adapter
MiMo adapter
MiniMax adapter
DeepSeek adapter
parallelSafe inference
```

Do not broaden Phase 3 into the entire provider or workflow roadmap.

## Required scenario A — interactive underspecified MVP

Use an intentionally incomplete request equivalent to:

> Build me a simple inventory system.

Expected behavior:

```text
request received
→ Harness identifies missing material MVP decisions
→ every generated question includes one recommended answer
→ user explicitly answers some questions
→ user leaves some answers blank
→ blank answers adopt the recommendations
→ determinations and provenance become complete
→ intent resolves
→ work generates
→ deterministic .rb artifacts render
→ Ralph reports READY
```

The exact fixture domain may change if a smaller fixture proves the same behavior, but it must intentionally omit material information. The test must prove that Harness adds semantic value rather than merely reformatting a complete specification.

## Required scenario B — headless underspecified MVP

Use the same intentionally incomplete request, or an equivalent:

> Build me a simple inventory system.

Expected behavior:

```text
underspecified request
        ↓
intent generation discovers material ambiguity
        ↓
questions generated
        ↓
every question contains exactly one recommendation
        ↓
questions and recommendations persisted
        ↓
no interactive answer channel exists
        ↓
recommendations selected through non-interactive policy
        ↓
accepted-recommendation provenance
with non-interactive acceptance mode
        ↓
semantic sufficiency reached
        ↓
work schema constrained from resolved intent
        ↓
work generation
        ↓
existing deterministic Core
        ↓
exact three-artifact tree
        ↓
round-trip / manifest / Ralph green
        ↓
Ralph READY
```

This is a required product-level Phase 3 end-to-end test. It must prove that headless execution does not skip question generation, silently invent unrecorded decisions, require interactive input or return `INTERVIEW_BLOCKED` for ordinary ambiguity.

Persisted evidence must distinguish non-interactive recommendation acceptance from an explicit user answer, blank interactive acceptance and a silent model default. The question and its exact recommendation must exist in persisted state before non-interactive policy accepts it.

## Required scenario C — controlled semantic recovery

Prove both bounded outcomes:

```text
provider-valid structured response
→ Core semantic validation failure
→ deterministic findings
→ one complete same-slice corrective regeneration
→ full deterministic closure
→ success
```

and:

```text
first semantic attempt invalid
→ one complete corrective attempt invalid
→ bounded terminal failure
```

There is no formatter, document patch, partial-field patch, third hidden attempt or fallback profile.

In addition to the product-level recovery scenario, deterministic unit/orchestration tests must independently prove both recovery ceilings:

```text
intent:
  initial attempt
  + at most 1 corrective regeneration

work:
  initial attempt
  + at most 1 corrective regeneration
```

and globally:

```text
intent correction + work correction
→ 2 corrective regenerations total
→ permitted

second correction of intent
→ forbidden

second correction of work
→ forbidden

third corrective regeneration anywhere in the run
→ forbidden
```

These budget proofs may use deterministic or fake-provider orchestration fixtures. Separate paid/provider-backed end-to-end calls for intent and work are not required.

---

# 32. Success condition for the next conversation

Phase 3 is successful only when complete requests and all three required scenario families—interactive underspecified MVP, headless underspecified MVP and controlled semantic recovery—can reach the applicable deterministic closure and produce the required bounded outcome through an explicitly supported provider/transport/profile.

```text
request
   ↓
supported transport/profile
   ↓
semantic intent
   ↓
semantically sufficient persisted decisions
   ↓
semantic work
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
every question carrying a recommendation
blank and headless acceptance carrying accepted-recommendation provenance
headless questions/recommendations persisted before policy acceptance
bounded whole-slice semantic recovery
per-slice and per-run recovery ceilings independently enforced
Harness-controlled transport invocation accounting
opaque provider requests remaining unmeasured
0 formatter calls
0 representation/document repair calls
0 provider/profile fallback calls
0 provider-specific branches in Core
no recovery path bypassing deterministic closure
```

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
