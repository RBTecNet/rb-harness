# RB Harness vNext — Architecture Specification

**Status:** specification only. Nothing in this document has been implemented.
**Scope:** the first vertical slice of the `init` workflow.
**Date:** 2026-08-28
**Author context:** derived from the frozen implementation at `packages/core/src` (57 modules, 17 934 lines) and from `contracts/RB-RALPH-CONTRACT.md` (RB Ralph 0.8.11), `contracts/rb-execution-v1.md`, `contracts/rb-manifest-v1.md`.

---

## 0. Reading order

Sections 1–3 are the decision and the shape. Sections 4–11 are the contracts a
reviewer must be able to hold someone to. Sections 12–16 are how it gets built
and how the old one gets retired. Section 17 argues against this document.
Section 18 is what code review enforces forever. Section 19 is the plan.

If you read only one section, read **17 (Risks and honest counter-arguments)**
and then **18 (Architectural invariants)**.

---

## 1. Executive decision

### 1.1 The decision

Adopt the **C → B hybrid** — a single canonical semantic IR owned by Harness
Core, with the model producing *semantics* and code producing *all machine
identity and all syntax* — and add a **provider/model adaptation layer** that
isolates every model-specific request and response behaviour from Core.

The pipeline is:

```
LLM thinks.  Adapter translates.  Harness governs.  Renderer emits.  Ralph executes.
```

Concretely, for the first vertical slice:

```
Request
  → typed ambiguity resolution (fused into semantic slice 1)
  → provider adapter + model profile + response normalizer
  → CanonicalSemanticResponse (payload: unknown)
  → Core resolution (identity assignment, key resolution, canonicalization)
  → ProjectModel (the one internal truth)
  → one validation closure over the IR
  → ExecutionDocument (typed execution projection)
  → deterministic PHASES.md render
  → deterministic BRIEF.md render
  → deterministic rb-manifest.json render
  → round-trip + Ralph-contract verification on staged bytes
  → atomic publication
```

### 1.2 What is being bought

The frozen implementation's five structural defects map one-to-one onto five
structural fixes:

| Frozen defect | vNext fix | Enforcement |
| --- | --- | --- |
| Multiple independent executable authorities (`PHASES.md` and `OPERATIONS.json` authored separately, reconciled afterwards by `artifact-consistency.ts`) | Both are projections of one `ProjectModel` | `artifact-consistency.ts` is DO NOT PORT; there is nothing left to reconcile |
| Fragmented identity (a dependency stored as `PROJECT.md` / `.rb/init/PROJECT.md` / `project-main`) | Model emits `SemanticKey`; Core resolves once into a branded `TaskId` / `RequirementId` | Branded types; `resolve()` is the only constructor |
| Non-monotonic validation (staging-valid → published → `artifact-verifier` discovers a *new* rule → rollback → model repair → republish) | One validation closure over the IR; every Ralph issue code maps to an IR invariant | `RALPH_ISSUE_TO_IR_INVARIANT` exhaustiveness test (§9.4) |
| LLM-owned serialization (`document-plan/v1` + `document-part/v1` wire protocol, `harness-control-formatter.ts` calling a second model to rewrite JSON) | Model emits schema-shaped JSON only; Core renders all syntax; zero formatter calls | `NormalizationCode` is a closed enum; formatter budget is `0` |
| Document-part as the unit of model work (`maxTotalParts: 512`) | Semantic slice is the unit of model work; 2 slices for a trivial `init` | §8 |
| Mandatory artifacts not derived from the Ralph contract (`init` requires 6 model-authored documents; Ralph requires 1) | Consumer-first artifact model: `rb-manifest.json` + `PHASES.md` + one justified `BRIEF.md` | §11.1 evidence table |

### 1.3 What is deliberately *not* bought in slice 1

Stated up front so that nobody discovers it as a regression:

- **No CLI-provider transport.** Slice 1 requires a direct API credential. The
  installed `claude` / `codex` CLI path (`harness-provider.ts`) is a TEMPORARY
  BRIDGE and returns in implementation phase 4. This is a real, temporary
  capability regression against the frozen build and against the product
  constraint "credential/provider configuration infrastructure where
  reusable" — the *credential* half is preserved from day one, the *CLI
  subprocess* half is not.
- **No semantic repair.** Slice 1 fails closed. See §10.4.
- **No adaptive multi-round interview.** One round, at most three questions.
- **No `OPERATIONS.json`, `PROJECT.md`, `REQUIREMENTS.md`, `DECISIONS.md`,
  `PLAN.md`, `source-manifest.json`, `artifacts.tsv`.** See §11.
- **No non-greenfield `init`.** Slice 1 targets an empty or `.rb`-free
  directory, which is what makes "the request is the whole authority" true.

---

## 2. Target architecture

### 2.1 Layer diagram

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ CLI  ( rb-harness vnext init )                                                │
│   splash · wizard · credential resolution · run state · checkpoints · resume  │
└───────────────────────────┬───────────────────────────────────────────────────┘
                            │  RunRequest { requestText, projectRoot, profileId }
                            ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│ HARNESS CORE                            (knows nothing about any provider)    │
│                                                                               │
│  ┌────────────────┐   SemanticRequest<schema>   ┌──────────────────────────┐  │
│  │ SemanticGateway├────────────────────────────►│  ADAPTER LAYER           │  │
│  │  (stage owner) │◄────────────────────────────┤  (knows nothing about    │  │
│  └───────┬────────┘   CanonicalSemanticResponse │   PHASES.md or Ralph)    │  │
│          │            { payload: unknown, ... } │                          │  │
│          │                                      │  ProviderAdapter         │  │
│          ▼                                      │   · endpoint/protocol    │  │
│  ┌────────────────┐                             │   · auth · envelope      │  │
│  │ Interview      │  typed questions,            │   · streaming · cancel  │  │
│  │  (§7)          │  code-owned blocking gate    │   · usage extraction    │  │
│  └───────┬────────┘                             │                          │  │
│          ▼                                      │  ModelProfile            │  │
│  ┌────────────────┐                             │   · structured output    │  │
│  │ Resolver (§6.4)│  keys → branded IDs          │   · strict schema        │  │
│  └───────┬────────┘                             │   · reasoning · limits   │  │
│          ▼                                      │   · system role          │  │
│  ┌────────────────┐                             │                          │  │
│  │  ProjectModel  │  ◄── THE ONE INTERNAL TRUTH  │  ResponseNormalizer      │  │
│  └───────┬────────┘                             │   · closed enum only     │  │
│          ▼                                      └──────────────────────────┘  │
│  ┌────────────────┐                                                           │
│  │ canonicalize() │  deterministic; idempotent                                │
│  └───────┬────────┘                                                           │
│          ▼                                                                    │
│  ┌────────────────┐                                                           │
│  │ validate()     │  ONE closure · typed Findings · no other semantic gate    │
│  └───────┬────────┘                                                           │
│          ▼                                                                    │
│  ┌────────────────┐                                                           │
│  │ RENDERER       │  ProjectModel → ExecutionDocument → PHASES.md             │
│  │                │  ProjectModel → BriefDocument     → BRIEF.md              │
│  │                │  staged bytes → rb-manifest.json                          │
│  └───────┬────────┘                                                           │
│          ▼                                                                    │
│  ┌────────────────┐                                                           │
│  │ CLOSURE        │  round-trip · Ralph contract · manifest/tree · dry-run    │
│  └───────┬────────┘                                                           │
│          ▼                                                                    │
│  ┌────────────────┐                                                           │
│  │ PUBLICATION    │  single atomic rename · rollback only for FS faults       │
│  └────────────────┘                                                           │
└───────────────────────────┬───────────────────────────────────────────────────┘
                            ▼
                    .rb/rb-manifest.json
                    .rb/init/PHASES.md
                    .rb/init/BRIEF.md
                            │
                            ▼
                        RB RALPH
```

### 2.2 The two boundaries that carry the design

Everything else is detail. These two are load-bearing:

**Boundary A — the adapter never sees semantics.**
`CanonicalSemanticResponse.payload` is typed `unknown`. The adapter is handed a
JSON Schema *as data* and returns a JSON value *as data*. There is no type in
the adapter package that mentions a requirement, a task, a phase, `PHASES.md`,
`AC-`, `T001`, or `.rb`. This makes invariant 3 ("no provider-specific
behaviour in Harness Core") *and* rule 4 ("adapters must not know PHASES.md")
enforceable by import graph and by `grep`, not by discipline.

**Boundary B — machine identity is constructed, never parsed.**
`TaskId`, `PhaseId`, `AcceptanceId`, `RequirementId`, `ArtifactId`, `ProjectId`
are branded types whose only constructors live in `vnext/identity.ts` and take
an ordinal, never a string from a model. A model-authored string can never
become a `TaskId` because there is no function that would accept it.

---

## 3. Component responsibilities

| Component | Owns | Must never |
| --- | --- | --- |
| **CLI** (`vnext/cli/`) | argument parsing, splash, wizard, credential selection, run directory, lock, checkpoint/resume, dashboard, exit codes | contain semantic logic; know a provider's protocol |
| **SemanticGateway** (`vnext/gateway/`) | stage sequencing, per-call deadline, budget enforcement, telemetry, prompt assembly (100% of prompt text) | know a provider; retry a semantic failure |
| **ProviderAdapter** (`vnext/providers/<family>/`) | endpoint, auth, request envelope, streaming, structured-output mechanism, usage extraction, provider errors, cancellation | interpret the payload; author prompt text; call a second model |
| **ModelProfile** (`vnext/providers/<family>/profiles.ts`) | declared capabilities of one model + its conformance tier | be assumed from the family; be marked SUPPORTED without a conformance run |
| **ResponseNormalizer** (`vnext/providers/<family>/normalize.ts`) | deterministic representation differences, from a closed enum | invent, repair, choose, or resolve anything semantic |
| **Resolver** (`vnext/resolve.ts`) | key→ID assignment, topological ordering, path canonicalization, code-derived fields | accept a model-authored ID |
| **Validator** (`vnext/validate.ts`) | the *entire* semantic rule set, as typed findings | be bypassed by any recovery path |
| **Renderer** (`vnext/render/`) | every byte of every generated file | make a semantic decision |
| **Closure** (`vnext/closure.ts`) | round-trip, Ralph contract validation, manifest/tree validation, consumer dry-run | discover a semantic rule the Validator did not know |
| **Publisher** (`vnext/publish.ts`) | staging→live atomic swap, rollback on FS fault | run after a semantic check has been skipped |

---

## 4. Concrete TypeScript contracts

All code below is specification. Paths are proposed locations under
`packages/core/src/vnext/`.

### 4.1 Identity (`vnext/identity.ts`)

```ts
declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

/** `^[a-z0-9][a-z0-9-]*$` — matches rb-manifest/v1 `project.id`. */
export type ProjectId     = Brand<string, "ProjectId">;
/** `R-001` … */
export type RequirementId = Brand<string, "RequirementId">;
/** `P01` … (rb-execution/v1 §4.2) */
export type PhaseId       = Brand<string, "PhaseId">;
/** `T001` … (rb-execution/v1 §4.3) */
export type TaskId        = Brand<string, "TaskId">;
/** `AC-T001-01` … (rb-execution/v1 §4.4) */
export type AcceptanceId  = Brand<string, "AcceptanceId">;
/** `^[a-z0-9][a-z0-9-]*$` — matches the `rb-artifact-id` marker. */
export type ArtifactId    = Brand<string, "ArtifactId">;
/** Lower-case 64-hex. */
export type Sha256        = Brand<string, "Sha256">;
/** Project-relative, POSIX-separated, no `..`, no leading `/`. */
export type RelPath       = Brand<string, "RelPath">;

/**
 * The ONLY thing a model is ever allowed to author as an identifier.
 * `^[a-z][a-z0-9-]{1,47}$`. It has no meaning outside one run.
 */
export type SemanticKey   = Brand<string, "SemanticKey">;

// ---- the only constructors -------------------------------------------------
export function projectId(name: string): ProjectId;          // slugify
export function requirementId(ordinal: number): RequirementId; // 1 -> "R-001"
export function phaseId(ordinal: number): PhaseId;             // 1 -> "P01"
export function taskId(ordinal: number): TaskId;               // 2 -> "T002"
export function acceptanceId(task: TaskId, ordinal: number): AcceptanceId;
export function executionArtifactId(project: ProjectId): ArtifactId;  // `${p}-execution`
export function briefArtifactId(project: ProjectId): ArtifactId;      // `${p}-brief`

/** Parses a model string into a SemanticKey or fails. No other entry point. */
export function semanticKey(value: string): SemanticKey | undefined;
```

There is deliberately no `taskId(value: string)`. That absence *is* invariant 1.

### 4.2 Result and finding shapes (`vnext/result.ts`)

```ts
export type Outcome<T, E> =
  | { readonly ok: true;  readonly value: T }
  | { readonly ok: false; readonly error: E };

/**
 * How a finding may be acted upon. Slice 1 implements handlers for exactly
 * one of these classes; see §10.4.
 */
export type FindingClass =
  | "deterministic-normalizable"   // handled by canonicalize(), never reaches validate()
  | "semantic-retryable"           // slice 1: NO handler. Fails closed.
  | "user-decision-required"       // slice 1: NO handler. Fails closed.
  | "fatal";

export interface Finding {
  readonly invariant: IrInvariantId;      // e.g. "I-07"
  readonly classification: FindingClass;
  readonly message: string;               // operator-facing, deterministic text
  readonly pointer: string;               // JSON-pointer-like path into ProjectModel
  readonly offending?: readonly string[]; // exact offending tokens
}
```

### 4.3 Measured telemetry (`vnext/telemetry.ts`)

```ts
/**
 * Never report an unknown as zero. A provider that does not expose a metric
 * produces `{ measured: false, reason }`, which serializes as `"unmeasured"`.
 */
export type Measured<T> =
  | { readonly measured: true;  readonly value: T }
  | { readonly measured: false; readonly reason:
        | "unsupported-by-provider"
        | "not-reported-in-this-response"
        | "stream-incomplete" };
```

---

## 5. The canonical IR — `ProjectModel`

### 5.1 Name

**`ProjectModel`**, not `InitModel`.

Justification: naming it per-workflow invites one IR per workflow, which is the
fragmentation the design exists to remove. `plan`, `evolve`, and `review` will
populate different *subsets* of the same model, not different models. The
workflow is a field, not a type.

### 5.2 Root

```ts
// vnext/ir.ts
export const PROJECT_MODEL_VERSION = "rb-project-model/v1" as const;

export interface ProjectModel {
  readonly version:            typeof PROJECT_MODEL_VERSION;
  readonly workflow:           "init";                      // widened later
  readonly identity:           ProjectIdentity;
  readonly determinations:     readonly Determination[];
  readonly requirements:       readonly Requirement[];
  readonly executableSurface:  ExecutableSurface;
  readonly protectedPaths:     readonly ProtectedPath[];
  readonly phases:             readonly SemanticPhase[];
  readonly provenance:         Provenance;
}
```

Seven members. Every one has a named consumer in slice 1 (§5.10).

### 5.3 `ProjectIdentity`

```ts
export interface ProjectIdentity {
  readonly id:        ProjectId;   // CODE-DERIVED  (slugify(name), collision-checked)
  readonly name:      string;      // MODEL-AUTHORED
  readonly objective: string;      // MODEL-AUTHORED — one paragraph, observable outcome
}
```

| Field | Author | Consumer | Why |
| --- | --- | --- | --- |
| `id` | code | `rb-manifest.json → project.id`; `executionArtifactId()`; `briefArtifactId()` | manifest invariant `^[a-z0-9][a-z0-9-]*$`; must equal the `rb-artifact-id` marker prefix |
| `name` | model | `rb-manifest.json → project.name`; `# RB Execution Plan: <name>`; `BRIEF.md` H1 | Ralph requires a non-empty project name and a non-empty plan title |
| `objective` | model | `BRIEF.md` §Objective | the cold-agent authority Ralph's Context requirement demands (§11.1) |

Note there is **no** `requestDigest` here — it lives in `provenance`, because
its consumer is the run state and telemetry, not the model.

### 5.4 `Determination` — decisions and assumptions, unified

```ts
export type Materiality = "product" | "architecture" | "implementation" | "preference";
export type Rigidity    = "RIGID" | "FLEXIBLE";
export type DeterminationOrigin = "request" | "user-answer" | "model-default";

export interface Determination {
  readonly key:         SemanticKey;   // MODEL
  readonly statement:   string;        // MODEL — the decided thing, in one sentence
  readonly rationale:   string;        // MODEL — why
  readonly materiality: Materiality;   // MODEL
  readonly rigidity:    Rigidity;      // MODEL
  readonly origin:      DeterminationOrigin;  // CODE-DERIVED (§7.4)
}
```

**Simplification proposed and adopted:** the brief called for `decisions` and
`assumptions` as separate concepts. They carry identical fields and differ only
by provenance. Merging them into one `Determination` with a code-derived
`origin` removes a whole class of drift (a "decision" that was actually assumed)
and removes an entire IR member. `BRIEF.md` still renders two headed sections —
*Confirmed decisions* (`origin !== "model-default"`) and *Assumptions*
(`origin === "model-default"`) — so nothing is lost to a human reader.

| Field | Author | Consumer |
| --- | --- | --- |
| `key` | model | uniqueness invariant I-16; stable reference from a follow-up interview round |
| `statement`, `rationale` | model | `BRIEF.md` |
| `materiality`, `rigidity` | model | the **code-owned blocking gate** (§7.3); reported in telemetry |
| `origin` | code | `BRIEF.md` section split; audit of what the user actually confirmed |

### 5.5 `Requirement`

```ts
export type RequirementKind = "functional" | "quality" | "constraint";

export interface Requirement {
  readonly key:       SemanticKey;      // MODEL
  readonly id:        RequirementId;    // CODE-DERIVED (declaration order)
  readonly statement: string;           // MODEL — binary, observable, self-contained
  readonly kind:      RequirementKind;  // MODEL
}
```

| Field | Author | Consumer |
| --- | --- | --- |
| `key` | model | the JSON-Schema `enum` for slice 2's `covers` (§8.3) — this is what makes "a task covers a requirement that does not exist" *structurally* unrepresentable |
| `id` | code | `**Covers:** R-001, R-003` in `PHASES.md`; `BRIEF.md` requirement table |
| `statement` | model | `BRIEF.md`; the cold-agent meaning behind a `Covers:` reference |
| `kind` | model | `BRIEF.md` grouping; future `OPERATIONS.json` scenario derivation |

`kind` is the weakest field here. It is retained because the `OPERATIONS.json`
projection in implementation phase 4 selects `functional` requirements to derive
scenarios, and adding it later would be a wire-schema break. If phase 4 slips,
`kind` must be deleted.

### 5.6 `ExecutableSurface` — the field that pays for itself twice

```ts
export type EntrypointKind = "cli" | "http" | "library" | "service" | "none";

export interface Entrypoint {
  readonly key:         SemanticKey;      // MODEL
  readonly kind:        EntrypointKind;   // MODEL
  readonly invocation:  string;           // MODEL — e.g. "node bin/hello.js <name>"
  readonly description: string;           // MODEL
}

export type QualityCommandKind = "test" | "build" | "lint" | "typecheck" | "run";

export interface QualityCommand {
  readonly key:     SemanticKey;         // MODEL
  readonly kind:    QualityCommandKind;  // MODEL
  readonly command: string;              // MODEL — one non-interactive shell command
}

export interface ExecutableSurface {
  readonly entrypoints:      readonly Entrypoint[];
  readonly qualityCommands:  readonly QualityCommand[];
}
```

This is the single highest-value structural change after identity.

In the frozen build, each task authors its own `Validation:` command string as
free Markdown. Drift between what a task validates and what the project can
actually run is unrepresentable in vNext: **a task never contains a command
string.** It references a `QualityCommand` by key (§5.9), and the renderer emits
the command text. Consequences:

- one place to run the "long-running service", "masked failure", "impossible
  checker" and "disguised `manual:`" heuristics that
  `execution-contract.ts` earned from three documented incidents;
- a command that is wrong is wrong once, not once per task;
- `Entrypoint` has no *rendering* consumer in slice 1 — its slice-1 consumer is
  invariant **I-17** (a project that declares a `cli`/`http`/`service`
  entrypoint must declare at least one `run`- or `test`-kind quality command
  that exercises it). Its second consumer is the `OPERATIONS.json` projection.
  If the reviewer judges I-17 insufficient, `Entrypoint` must be cut — it is
  the most deletable member of the IR.

### 5.7 `ProtectedPath`

```ts
export interface ProtectedPath {
  readonly path:   RelPath;   // CODE-DERIVED for built-ins; MODEL for project-specific
  readonly reason: string;
  readonly source: "built-in" | "model";
}
```

Built-ins injected by code, never by the model: `.rb`, `.rb-harness`, `.git`.
The model may add project-specific ones (e.g. a vendored directory).
Consumer: invariant **I-07** (task `ownedPaths` ∩ `protectedPaths` = ∅),
evaluated by the existing `scopeTokenIntersectsProtectedPath`.

This replaces `authority-constraints.ts`, which mines protected paths out of
prose with a 30-line regular expression. In vNext a protected path is typed data
or it does not exist.

### 5.8 `SemanticPhase`

```ts
export interface SemanticPhase {
  readonly key:       SemanticKey;               // MODEL
  readonly number:    number;                    // CODE-DERIVED (1-based, after topo sort)
  readonly id:        PhaseId;                   // CODE-DERIVED
  readonly title:     string;                    // MODEL
  readonly goal:      string;                    // MODEL — one observable outcome
  readonly dependsOn: readonly SemanticKey[];    // MODEL (symbolic phase keys)
  readonly tasks:     readonly SemanticTask[];
}
```

| Field | Author | Consumer |
| --- | --- | --- |
| `key` | model | resolution target for `dependsOn` |
| `number`, `id` | code | `## Phase N: <title>` and `**Phase ID:** P0N` |
| `title`, `goal` | model | heading and `**Goal:**` |
| `dependsOn` | model | `**Depends on:**` after resolution to `PhaseId`s; topological ordering (I-04) |

`Context` is **not** a phase field. It is code-derived at render time (§10.3) —
a model has no business naming the authority documents the Harness itself
writes.

### 5.9 `SemanticTask`

```ts
export type ValidationIntent =
  | { readonly kind: "command"; readonly commandKey: SemanticKey }
  | { readonly kind: "manual";  readonly inspection: string }
  | { readonly kind: "human";   readonly evidence: string };

export interface AcceptanceSemantics {
  readonly id:        AcceptanceId;   // CODE-DERIVED
  readonly statement: string;         // MODEL — binary, observable, self-contained
}

export interface SemanticTask {
  readonly key:          SemanticKey;                  // MODEL
  readonly id:           TaskId;                       // CODE-DERIVED
  readonly title:        string;                       // MODEL
  readonly intent:       string;                       // MODEL  -> **Change:**
  readonly dependsOn:    readonly SemanticKey[];       // MODEL (symbolic task keys)
  readonly ownedPaths:   readonly RelPath[];           // MODEL  -> **Scope:**
  readonly covers:       readonly SemanticKey[];       // MODEL (requirement keys)
  readonly coversIds:    readonly RequirementId[];     // CODE-DERIVED
  readonly acceptance:   readonly AcceptanceSemantics[];
  readonly validation:   readonly ValidationIntent[];  // MODEL
  readonly evidence:     string;                       // MODEL  -> **Expected evidence:**
  readonly parallelSafe: boolean;                      // CODE-DERIVED (see below)
  readonly sequentialHint: boolean;                    // MODEL, optional-with-default-false
}
```

**`parallelSafe` is code-derived.** This is a deliberate authority transfer.
Ralph's rule is "`Parallel safe: true` only when patches can be isolated", and
patch isolation is a mechanical property of path disjointness, not an opinion:

```
parallelSafe(t) =
     !t.sequentialHint
  && ∀ u ∈ samePhase(t), u ≠ t :  disjoint(t.ownedPaths, u.ownedPaths)
  && ∀ d ∈ t.dependsOn : phaseOf(d) < phaseOf(t)
```

`sequentialHint` exists for the one thing paths cannot express — shared runtime
state (a single database, a single port). It can only make a task *less*
parallel, never more. A model that lies by omission produces a task the Harness
marks parallel-safe on correct mechanical grounds; a model that lies by
commission only slows the run down. Neither corrupts the plan.

**`evidence` is a plain string, not a typed array.** The brief listed "evidence
requirements" as a concept to consider. It was considered and reduced: Ralph
renders one prose line (`**Expected evidence:**`), and in slice 1 no other
consumer reads its structure. A typed array whose only consumer is the renderer
that flattens it back into prose is a field with no consumer. If the evidence
index integration in a later phase needs structure, it is added then.

**Visual acceptance is not modelled.** `rb-execution/v1` §15 imposes a large
sub-contract on visual acceptance criteria. Slice 1 targets a CLI; there is no
consumer. Instead, invariant **I-13** *detects* visual language in an acceptance
statement and emits a `fatal` finding. Slice 1 therefore cannot silently emit an
invalid visual criterion, and carries none of the modelling cost.

### 5.10 `Provenance`

```ts
export interface Provenance {
  readonly harnessVersion: string;    // CODE
  readonly runId:          string;    // CODE
  readonly requestSha256:  Sha256;    // CODE
  readonly profileId:      string;    // CODE — e.g. "anthropic:claude-opus-5"
  readonly generatedAt:    string;    // CODE — single run clock, ISO-8601
}
```

Consumers: `rb-manifest.json → generatedAt` (a required property of
`rb-manifest/v1`), the run state file, the telemetry report, and resume
identity. **`Provenance` is never rendered into `PHASES.md` or `BRIEF.md`** —
those files must be byte-identical for a byte-identical `ProjectModel`, which
is what makes the round-trip property test (§12.1) meaningful.

`generatedAt` is drawn once per run from an injected `RunClock`, so the
determinism tests can freeze it.

### 5.11 The consumer register — enforced, not aspirational

Rule: *every IR field must have a consumer.* A rule nobody can check decays.
The mechanism:

- `docs/vnext/ir-consumers.md` holds one row per IR field:
  `path | author | consumer(s) | invariant(s)`.
- `test/vnext/ir-consumer-register.test.ts` walks the IR type surface (via a
  generated field manifest) and fails when a field is present in the types but
  absent from the register, or present in the register with an empty consumer
  column.

This is the concrete defence against the single largest failure mode of this
design: the IR growing until it is the old document set with different
punctuation.

### 5.12 Field census

| Member | Model-authored | Code-derived | Optional | Conditional |
| --- | --- | --- | --- | --- |
| `identity` | 2 | 1 | 0 | 0 |
| `determinations[]` | 5 | 1 | 0 | 0 |
| `requirements[]` | 3 | 1 | 0 | 0 |
| `executableSurface` | 8 | 0 | 0 | 0 |
| `protectedPaths[]` | 2 | 1 | 0 | model-added entries only |
| `phases[]` | 4 | 2 | 0 | 0 |
| `phases[].tasks[]` | 8 | 4 | 0 | `sequentialHint` defaults false |
| `provenance` | 0 | 5 | 0 | 0 |

**32 model-authored fields, 15 code-derived, 0 optional.** Zero optional fields
is a design target, not an accident: strict JSON-Schema modes on several
providers require every property to be listed in `required`, and a schema whose
optionality is expressed through `null` unions is both portable and decodable.

---

## 6. Adapter / provider / profile design

### 6.1 The response boundary — answering the brief's question directly

**Yes, the boundary is necessary, and it must be `payload: unknown`.**

```
ProviderRawResponse → Adapter → CanonicalSemanticResponse → Core resolution → ProjectModel
```

The adapter returning a `ProjectModel` would be wrong for three separate
reasons, any one of which is disqualifying:

1. **Identity.** `TaskId`/`AcceptanceId`/`RequirementId` are assigned by
   ordinal after topological ordering across *all* slices. An adapter that
   sees only slice 2 cannot assign them, and an adapter that could would be
   authoring machine identity — invariant 1.
2. **Resolution.** `covers` and `dependsOn` are symbolic keys resolved against
   the *other* slice. Resolution is a cross-slice, Core-owned operation.
3. **Contamination.** The moment `ProjectModel` is importable from the adapter
   package, `if (provider === "mimo")` becomes writable inside a function that
   also knows what a phase is. `payload: unknown` makes that impossible to
   express.

### 6.2 The contracts (`vnext/providers/contract.ts`)

```ts
// ---------------------------------------------------------------- request ---
export interface JsonSchemaDocument { readonly [k: string]: unknown }  // opaque data

export interface SemanticRequest {
  /** Opaque label for logs/telemetry. The adapter must not branch on it. */
  readonly slice: string;
  /** Complete prompt text. 100% Core-authored. See §6.6. */
  readonly instructions: string;
  /** Serialized input package (request text, prior answers, prior slice). */
  readonly input: string;
  /** JSON Schema for the expected payload. Data to the adapter. */
  readonly schema: JsonSchemaDocument;
  /** Schema name; some mechanisms require one. `^[a-z][a-z0-9_]*$`. */
  readonly schemaName: string;
  readonly limits: {
    readonly maxOutputTokens: number;
    readonly deadlineMs: number;
  };
  readonly reasoning:
    | { readonly mode: "off" }
    | { readonly mode: "on"; readonly effort: string };
  readonly signal: AbortSignal;
}

// --------------------------------------------------------------- response ---
export type NormalizationCode =
  | "unwrapped-provider-envelope"
  | "stripped-code-fence"
  | "unwrapped-tool-call-arguments"
  | "mapped-documented-alias"
  | "dropped-unknown-provider-metadata"
  | "coerced-documented-scalar-to-array";

export interface NormalizationEvent {
  readonly code: NormalizationCode;
  /** Deterministic, quotes nothing semantic. e.g. "removed ```json fence". */
  readonly detail: string;
}

export interface CanonicalUsage {
  readonly inputTokens:        Measured<number>;
  readonly cachedInputTokens:  Measured<number>;
  readonly cacheWriteTokens:   Measured<number>;
  readonly outputTokens:       Measured<number>;
  readonly reasoningTokens:    Measured<number>;
  /** Underlying HTTP requests/turns the adapter actually made. */
  readonly providerRequests:   Measured<number>;
  readonly costUsd:            Measured<number>;
}

export interface TransportTelemetry {
  readonly startedAt: string;
  readonly durationMs: number;
  readonly firstOutputMs: Measured<number>;
  readonly streamed: boolean;
}

export interface CanonicalSemanticResponse {
  readonly slice: string;
  /** Schema-shaped JSON. The adapter does not, and cannot, interpret it. */
  readonly payload: unknown;
  readonly normalizations: readonly NormalizationEvent[];
  readonly usage: CanonicalUsage;
  readonly transport: TransportTelemetry;
}

// ----------------------------------------------------------------- errors ---
export type ProviderErrorKind =
  | "auth"                    // credential rejected
  | "rate-limit"              // 429 / provider quota
  | "transport"               // network, 5xx, connection reset
  | "timeout"                 // Core deadline elapsed
  | "cancelled"               // AbortSignal fired
  | "output-truncated"        // stop reason indicates the cap was hit
  | "malformed-syntax"        // not JSON after documented envelope extraction
  | "unsupported-capability"  // profile cannot serve this SemanticRequest
  | "provider-error";         // typed provider refusal / content filter

export interface ProviderResponseError {
  readonly kind: ProviderErrorKind;
  readonly message: string;
  /** Whether a *transport-level* retry could plausibly succeed. */
  readonly transportRetryable: boolean;
  /** Bounded, redacted excerpt for the run log. Never surfaced to a model. */
  readonly excerpt?: string;
  readonly usage?: CanonicalUsage;
}

// ---------------------------------------------------------------- adapter ---
export interface ProviderAdapter {
  readonly family: string;                 // "anthropic" | "openai" | ...
  readonly profiles: readonly ModelProfile[];
  request(
    profile: ModelProfile,
    credential: ResolvedCredential,
    request: SemanticRequest,
  ): Promise<Outcome<CanonicalSemanticResponse, ProviderResponseError>>;
}
```

**Who validates the payload against the schema?** Core, not the adapter.
The adapter guarantees *JSON syntax after documented envelope extraction*.
Core's `decodeSlice()` guarantees *shape*. This is the strictest possible
boundary and it means `schema-mismatch` is not a `ProviderErrorKind` — it is a
Core decode failure, reported as a `fatal` `Finding`. A shape failure and a
semantic failure are then handled by one mechanism instead of two.

### 6.3 `ModelProfile`

```ts
export type StructuredOutputMechanism =
  | "strict-json-schema"   // provider guarantees schema conformance
  | "json-schema"          // schema sent, conformance not guaranteed
  | "forced-tool-argument" // single tool + forced tool_choice; payload = arguments
  | "json-mode"            // "must be JSON", no schema
  | "none";                // free text; Core-owned fenced-JSON preamble applies

export type ConformanceTier =
  | "SUPPORTED"
  | "SUPPORTED_WITH_NORMALIZATION"
  | "UNSUPPORTED";

export interface ModelProfile {
  readonly id: string;                    // "anthropic:claude-opus-5"
  readonly family: string;
  readonly modelId: string;
  readonly label: string;

  readonly structuredOutput: StructuredOutputMechanism;
  readonly strictSchema: boolean;
  readonly toolCalling: boolean;
  readonly toolChoiceForcing: boolean;

  readonly reasoning:
    | { readonly supported: false }
    | { readonly supported: true;
        readonly defaultMode: "off" | "on";
        readonly efforts: readonly string[];
        readonly reportsReasoningTokens: boolean };

  readonly maxOutputTokens: number;
  readonly systemRole: "system" | "developer" | "top-level-system" | "none";
  readonly streaming: { readonly supported: boolean; readonly usageInStream: boolean };
  readonly usageReporting: {
    readonly inputTokens: boolean;
    readonly cachedInputTokens: boolean;
    readonly cacheWriteTokens: boolean;
    readonly outputTokens: boolean;
    readonly reasoningTokens: boolean;
    readonly costUsd: boolean;
  };

  /** Set ONLY by the conformance runner. Hand-editing it is a review failure. */
  readonly conformance: {
    readonly tier: ConformanceTier;
    readonly suiteVersion: string;
    readonly runId: string;
    readonly recordedAt: string;
    readonly normalizationsOnHappyPath: readonly NormalizationCode[];
  };
}
```

### 6.4 Response normalizer — the closed enum is the whole point

```ts
export interface ResponseNormalizer {
  /**
   * Extracts a JSON value from one provider response using only the
   * mechanisms declared by the profile plus the closed NormalizationCode set.
   */
  extract(
    profile: ModelProfile,
    raw: ProviderRawResponse,
  ): Outcome<{ json: unknown; events: NormalizationEvent[] }, ProviderResponseError>;
}
```

Hard rules, restated as review checks:

- The normalizer package must not import `vnext/ir`, `vnext/render`,
  `vnext/validate`, or anything under `vnext/closure`.
- It must not perform an HTTP request other than the one the adapter owns, and
  must not construct a `SemanticRequest`. (No second model. Ever.)
- It must not add, remove, rename, or reorder a property for any reason other
  than a documented mechanism of the declared `structuredOutput`, expressible as
  one of the six `NormalizationCode` values.
- **Growth cap:** if a profile requires more than **three** distinct
  `NormalizationCode` values on happy-path conformance cases, its tier is
  `UNSUPPORTED`, not `SUPPORTED_WITH_NORMALIZATION`. Adding a *seventh*
  `NormalizationCode` requires a new conformance fixture and an explicit
  changelog entry. This is what stops the enum from becoming the formatter
  again, one innocuous case at a time.

A model-specific *semantic* defect — a missing requirement, an unresolvable
key, a chosen architecture the request did not license — never reaches the
normalizer's vocabulary. It leaves the adapter as a valid
`CanonicalSemanticResponse` whose payload later fails Core decode or Core
validation, as a typed `Finding`.

### 6.5 Registry — no file per model

```
vnext/providers/
  contract.ts          // everything in §6.2–6.4
  registry.ts          // ADAPTERS: readonly ProviderAdapter[]
  anthropic/
    adapter.ts         // protocol, auth, streaming, cancellation, usage
    normalize.ts       // ResponseNormalizer for the anthropic-messages dialect
    profiles.ts        // ANTHROPIC_BASE + per-model overrides
  openai/              // implementation phase 4
    adapter.ts  normalize.ts  profiles.ts
```

Profiles are a table with an explicit base and explicit overrides — the base
carries *protocol* compatibility, the overrides carry *model capability*
differences:

```ts
// vnext/providers/anthropic/profiles.ts
const ANTHROPIC_BASE = {
  family: "anthropic",
  structuredOutput: "forced-tool-argument",
  strictSchema: false,
  toolCalling: true,
  toolChoiceForcing: true,
  systemRole: "top-level-system",
  streaming: { supported: true, usageInStream: true },
  usageReporting: {
    inputTokens: true, cachedInputTokens: true, cacheWriteTokens: true,
    outputTokens: true, reasoningTokens: false, costUsd: false,
  },
} as const;

export const ANTHROPIC_PROFILES: readonly ModelProfile[] = [
  profile(ANTHROPIC_BASE, {
    id: "anthropic:claude-opus-5", modelId: "claude-opus-5",
    label: "Claude Opus 5", maxOutputTokens: 32_000,
    reasoning: { supported: true, defaultMode: "off",
                 efforts: ["low", "medium", "high"], reportsReasoningTokens: false },
  }),
  profile(ANTHROPIC_BASE, {
    id: "anthropic:claude-sonnet-5", modelId: "claude-sonnet-5", /* ... */ }),
  profile(ANTHROPIC_BASE, {
    id: "anthropic:claude-haiku-4-5", modelId: "claude-haiku-4-5-20251001",
    label: "Claude Haiku 4.5", maxOutputTokens: 8_192,
    reasoning: { supported: false }, /* ... */ }),
];
```

The same shape for `OpenAIAdapter` with `CodexSol/Terra/Luna/Mini/Spark`
profiles, `MiniMaxAdapter`, `DeepSeekAdapter`, `MimoAdapter`. **Protocol
compatibility (dialect, endpoint, auth, streaming frame) lives in the adapter;
model capability (reasoning, output cap, strictness, tier) lives in the
profile.** A model in a family with `reasoning.supported: false` is not a
special case in Core — it is a different row in a table.

The frozen build already separates these correctly at the provider level
(`provider-registry.ts` `DirectProviderDefinition`, `provider-capabilities.ts`
`advertised`/`verified`). vNext keeps that distinction and pushes it down one
level, from provider to model.

### 6.6 Prompt-text ownership — closing the leak

A weak adapter boundary shows up as prompt text. If an adapter may append "you
must reply with JSON", provider semantics have leaked into the semantic layer
through a door nobody watches.

Rule: **adapters author zero prompt bytes.** Core owns a small set of
`SCHEMA_TRANSPORT_PREAMBLE` variants, selected *by declared mechanism*, never
by family or model id:

```ts
// vnext/gateway/preamble.ts  — Core-owned, frozen strings
const SCHEMA_TRANSPORT_PREAMBLE: Record<StructuredOutputMechanism, string> = {
  "strict-json-schema":   "",
  "json-schema":          "",
  "forced-tool-argument": "",
  "json-mode":            "Reply with a single JSON object and nothing else.",
  "none":                 "Reply with a single JSON object inside one ```json fence "
                        + "and nothing else.",
};
```

`SemanticRequest.instructions` is assembled by the gateway as
`corePrompt + SCHEMA_TRANSPORT_PREAMBLE[profile.structuredOutput]`. The profile
selects a Core-owned string by capability. There is no code path by which an
adapter contributes text. This is checkable: no string literal longer than N
characters may appear in `vnext/providers/**` outside `normalize.ts` error
messages, asserted by a lint test.

---

## 7. Interview model

### 7.1 The failure being fixed

In the frozen build, whether a question stops a run is decided by prose in the
prompt and by the model's own judgement, mediated by
`interview.maxRounds: 12` / `maxQuestions: 40`. That is how a question like
`cron-format` — an implementation detail with an obvious default — can stop a
run for a human answer.

### 7.2 Types

```ts
// vnext/interview.ts
export interface ProposedQuestion {
  readonly key:         SemanticKey;   // MODEL
  readonly question:    string;        // MODEL
  readonly why:         string;        // MODEL — what breaks if it is wrong
  readonly materiality: Materiality;   // MODEL
  readonly rigidity:    Rigidity;      // MODEL
  /**
   * MODEL. The defensible default, or null if there genuinely is none.
   * A question with a default can never block. This single field does more
   * work than any prose rule.
   */
  readonly proposedDefault: {
    readonly value: string;
    readonly rationale: string;
  } | null;
  readonly options: readonly { readonly key: SemanticKey; readonly label: string }[];
}

export type QuestionDisposition =
  | { readonly kind: "blocking" }
  | { readonly kind: "assumed"; readonly value: string; readonly rationale: string };
```

### 7.3 The gate is code, not prose

```ts
export function dispositionOf(q: ProposedQuestion): QuestionDisposition {
  // A defensible default always wins. Materiality cannot override it.
  if (q.proposedDefault !== null) {
    return { kind: "assumed", value: q.proposedDefault.value,
             rationale: q.proposedDefault.rationale };
  }
  // No default. Only genuinely material RIGID uncertainty may interrupt.
  const material = q.materiality === "product" || q.materiality === "architecture";
  if (q.rigidity === "RIGID" && material) return { kind: "blocking" };
  // No default, but not material: the run must still not stall.
  return { kind: "assumed", value: DEFERRED_SENTINEL,
           rationale: "recorded as an open implementation choice" };
}
```

Worked through the brief's example: `cron-format` has
`materiality: "implementation"`. Even with `proposedDefault: null` it is never
blocking. With a proposed default (`"5-field POSIX crontab"`) it is not blocking
regardless of how the model classified it. **Two independent guards, both in
code.** No prompt prose is load-bearing.

### 7.4 Round budget and origin assignment

- **At most one interview round.** At most **three** blocking questions asked
  (`interview.maxAsked = 3`); if the model marks more than three blocking, the
  three with `materiality: "product"` first, then `"architecture"`, then
  declaration order, are asked and the remainder are a `fatal` finding —
  *not* silently defaulted. A run that genuinely has more than three material
  RIGID unknowns is not a run this Harness should complete.
- Every non-blocking question becomes a `Determination` with
  `origin: "model-default"`.
- Every answered blocking question becomes a `Determination` with
  `origin: "user-answer"`.
- Everything the request states outright becomes a `Determination` with
  `origin: "request"`.

### 7.5 Non-interactive behaviour — deterministic, and it fails closed

```ts
export type InterviewMode = "interactive" | "non-interactive";
```

| Mode | Non-blocking questions | Blocking questions |
| --- | --- | --- |
| `interactive` | recorded as assumptions, printed in the summary | asked, one at a time, in declaration order |
| `non-interactive` | recorded as assumptions | **run fails with exit code 3 and diagnostic `INTERVIEW_BLOCKED`**, listing each blocking question and its `why` |

A non-interactive run never invents an answer to a material RIGID question.
Silently defaulting a product decision is worse than failing, because the
failure is visible and the default is not.

An `--answers <file>` pre-supply path resolves blocking questions by key before
the gate runs, which is what makes the acceptance test (§14) reproducible and
what makes CI usable.

---

## 8. Semantic generation protocol

### 8.1 Slices, not documents

The unit of incremental generation is a **semantic slice**: a coherent subset of
the IR with its own JSON Schema. It is never a document, never a document part,
never a Markdown region.

Two slices for `init`:

| Slice | Produces | Depends on |
| --- | --- | --- |
| `intent` | interview verdict, `identity`, `determinations`, `requirements`, `executableSurface`, model-added `protectedPaths` | the request |
| `work` | `phases[]` with `tasks[]` | resolved `intent` |

### 8.2 Why two and not one — a technical reason, not a stylistic one

One call is cheaper. Two calls buy something one call cannot:

Under a strict-schema mechanism, slice 2's schema is **generated from slice 1's
result**:

```jsonc
// work slice, task object, generated after intent resolved
"covers": {
  "type": "array", "minItems": 1,
  "items": { "enum": ["greet-named-user", "greet-default", "ship-cli-binary"] }
},
"validation": {
  "type": "array", "minItems": 1,
  "items": { "oneOf": [
    { "properties": { "kind": { "const": "command" },
                      "commandKey": { "enum": ["run-tests", "build-cli"] } } },
    { "properties": { "kind": { "const": "manual" },
                      "inspection": { "type": "string" } } },
    { "properties": { "kind": { "const": "human" },
                      "evidence": { "type": "string" } } } ] }
}
```

"A task covers a requirement that does not exist" and "a task validates with a
command the project does not declare" become **structurally unrepresentable at
the wire level**, not merely detectable at validation time. That is rule 6
("invalid states unrepresentable where practical") applied at the only boundary
where it costs nothing. It is worth one extra call.

The ambiguity verdict is **fused into slice 1** rather than being a third call:
the same reasoning that identifies what the request under-specifies also
produces the intent. A separate ambiguity call would re-derive the same analysis
and pay for it twice.

### 8.3 Wire schemas — model-authored fields only

```ts
// vnext/wire.ts — what the model actually emits. NOT the IR.

export interface IntentSliceWire {
  readonly project: {
    readonly name: string;
    readonly objective: string;
  };
  readonly openQuestions: readonly ProposedQuestion[];
  readonly determinations: readonly {
    readonly key: string; readonly statement: string; readonly rationale: string;
    readonly materiality: Materiality; readonly rigidity: Rigidity;
    /** Whether the request itself states this, or the model is defaulting. */
    readonly statedInRequest: boolean;
  }[];
  readonly requirements: readonly {
    readonly key: string; readonly statement: string; readonly kind: RequirementKind;
  }[];
  readonly executableSurface: {
    readonly entrypoints: readonly {
      readonly key: string; readonly kind: EntrypointKind;
      readonly invocation: string; readonly description: string;
    }[];
    readonly qualityCommands: readonly {
      readonly key: string; readonly kind: QualityCommandKind; readonly command: string;
    }[];
  };
  readonly protectedPaths: readonly { readonly path: string; readonly reason: string }[];
}

export interface WorkSliceWire {
  readonly phases: readonly {
    readonly key: string;
    readonly title: string;
    readonly goal: string;
    readonly dependsOn: readonly string[];
    readonly tasks: readonly {
      readonly key: string;
      readonly title: string;
      readonly intent: string;
      readonly dependsOn: readonly string[];
      readonly ownedPaths: readonly string[];
      readonly covers: readonly string[];            // enum-constrained (§8.2)
      readonly acceptance: readonly string[];         // statements only — no IDs
      readonly validation: readonly ValidationIntentWire[];
      readonly evidence: string;
      readonly sequentialHint: boolean;
    }[];
  }[];
}
```

Note what is **absent** from both wire schemas: `id`, `number`, `parallelSafe`,
`context`, `coversIds`, `artifactId`, any `T`/`P`/`AC-`/`R-` string, any path
under `.rb/`, any hash, any timestamp, any Markdown, any JSON syntax the model
must produce by hand.

### 8.4 Call arithmetic

| Scenario | Harness semantic calls | Breakdown |
| --- | --- | --- |
| **Trivial `init`, request already closed** | **2** | `intent` (0 blocking), `work` |
| `init` with one blocking round | 3 | `intent` (blocking), `intent` re-run with answers, `work` |
| Semantic defect in `work` | 2, then **fail closed** | slice 1 has no repair handler |
| Representation defect | 2, then fail closed | zero formatter calls, by construction |

Re-running `intent` with the answers appended (rather than issuing a targeted
patch call) is deliberate: it keeps the intent slice monotone — the second
result is a complete, self-consistent intent, not a partial merged with a
partial. It costs one call and removes a merge.

**Underlying provider requests** are counted separately (§13). Normal trivial
`init` is 2 semantic calls = 2 provider requests. A transport retry (typed
`transport`/`rate-limit`, `transportRetryable: true`) may add at most **one**
provider request per semantic call. A transport retry is **not** a semantic
retry: it re-sends the identical request after a typed network failure and
cannot change the semantic outcome.

---

## 9. Unified validation model

### 9.1 One closure

```ts
// vnext/validate.ts
export type IrInvariantId = `I-${number}`;

export interface ValidationOutcome {
  readonly valid: boolean;
  readonly findings: readonly Finding[];
}

export function canonicalize(model: ProjectModel): ProjectModel;   // idempotent
export function validate(model: ProjectModel): ValidationOutcome;  // pure
```

`canonicalize()` runs first and absorbs every
`deterministic-normalizable` case, so `validate()` only ever sees canonical
input. Consequently `validate()` emits only `semantic-retryable`,
`user-decision-required`, and `fatal` findings — and slice 1 fails closed on
all three (§10.4).

Canonicalization performs, and only performs: whitespace trimming and
collapsing; path normalization to POSIX with no trailing slash; deduplication
of identical `ownedPaths` / `covers` / `dependsOn` entries; stable sorting of
`ownedPaths` and `coversIds` for rendering; stable topological ordering of
phases and tasks. It never changes meaning; the round-trip property
(`canonicalize(canonicalize(m)) === canonicalize(m)`) is a property test.

### 9.2 The invariant set

| ID | Invariant | Class |
| --- | --- | --- |
| I-01 | `identity.id` matches `^[a-z0-9][a-z0-9-]*$` and is non-empty | fatal |
| I-02 | all `SemanticKey`s unique within their kind; every `covers`, `dependsOn`, `commandKey` resolves | fatal |
| I-03 | every `Requirement` is covered by ≥ 1 task | user-decision-required |
| I-04 | phase graph and task graph are acyclic | fatal |
| I-05 | every task `dependsOn` resolves to a task in the same or an earlier phase | fatal |
| I-06 | every `ownedPath` is project-relative, POSIX, no `..`, no leading `/`, no symlink escape | fatal |
| I-07 | `ownedPaths` ∩ `protectedPaths` = ∅ | fatal |
| I-08 | no `ownedPath` is inside `.rb` or `.rb-harness` (control-plane immutability) | fatal |
| I-09 | every task has ≥ 1 acceptance, ≥ 1 validation, non-empty `intent`, non-empty `evidence`, ≥ 1 `ownedPath` | fatal |
| I-10 | acceptance statements are self-contained: no bare `RF-`/`RNF-`/`R-`/`UI-`/`CT-`/`AC-` reference as the only content; no vague token (`works correctly`, `as appropriate`, `when applicable`, `etc.`) | semantic-retryable |
| I-11 | every `ValidationIntent` of kind `command` resolves to a declared `QualityCommand` | fatal |
| I-12 | every `QualityCommand.command` is non-interactive, is not a long-running service, does not mask failure (`\|\| true`, `; exit 0`), is not an impossible checker, and is not prose disguised as a command | fatal |
| I-13 | no acceptance statement carries visual semantics (`visible`, `rendered`, `layout`, `aligned`, `responsive`, `viewport`, `screen`, `animation`) — slice 1 does not model the visual sub-contract | fatal |
| I-14 | every phase has ≥ 1 task; there is ≥ 1 phase | fatal |
| I-15 | decomposition ceilings: ≤ 6 acceptance criteria per task, ≤ 8 `ownedPaths` per task, ≤ 12 tasks per phase | semantic-retryable |
| I-16 | `Determination` keys unique | fatal |
| I-17 | if any `Entrypoint.kind ∈ {cli, http, service}` then ≥ 1 `QualityCommand` of kind `run` or `test` exists | user-decision-required |
| I-18 | `identity.name`, `objective`, every phase `title`/`goal`, every task `title` are non-empty after trimming | fatal |
| I-19 | `ownedPaths` of two tasks in the same phase are either disjoint or at least one is `sequentialHint` — the plan must not claim isolation it cannot have | fatal |
| I-20 | at least one `Requirement` exists | fatal |

### 9.3 Rendering introduces no semantic invalidity

Rendering is total over valid IR. The renderer has no failure mode that is not
a programming error:

- every string that reaches Markdown is escaped/guarded by a function that
  cannot produce a line matching `PHASE_HEADING`, `TASK_HEADING`, or
  `TASK_FIELD`;
- a statement containing a newline is rejected at **I-18** (extended to forbid
  `\n`, `\r`, `\t` in any single-line-rendered field), not at render time;
- backtick handling in `ownedPaths` and `QualityCommand.command` is guarded by
  **I-06** / **I-12** forbidding backticks in those values.

If the renderer can fail on valid IR, an invariant is missing. That is a review
finding, not a bug fix.

### 9.4 No hidden final validator — the mechanism

This is the concrete implementation of rule 5 and invariant 5.

`execution-contract.ts` emits 31 distinct issue codes. vNext ships a total map:

```ts
// vnext/ralph-fidelity.ts
export const RALPH_ISSUE_TO_IR_INVARIANT: Readonly<Record<RalphIssueCode, IrInvariantId>> = {
  "document.contract":                 "I-01",  // marker is code-emitted
  "document.artifact-id":              "I-01",
  "document.title":                    "I-18",
  "document.phases.empty":             "I-14",
  "phase.id.missing":                  "I-01",
  "phase.id.invalid":                  "I-01",
  "phase.sequence":                    "I-04",
  "phase.goal.missing":                "I-18",
  "phase.depends.missing":             "I-04",
  "phase.dependency.invalid":          "I-04",
  "phase.context.empty":               "I-01",  // Context is code-derived, never empty
  "phase.tasks.empty":                 "I-14",
  "task.duplicate":                    "I-02",
  "task.sequence":                     "I-05",
  "task.field.missing":                "I-09",
  "task.dependency.invalid":           "I-05",
  "task.parallel.invalid":             "I-01",  // code-derived boolean
  "task.scope.ambiguous":              "I-06",
  "task.scope.control-plane":          "I-08",
  "task.change.control-plane":         "I-08",
  "task.acceptance.empty":             "I-09",
  "task.acceptance.id":                "I-01",  // code-assigned
  "task.acceptance.ambiguous":         "I-10",
  "task.validation.empty":             "I-09",
  "task.validation.format":            "I-11",
  "task.validation.ambiguous":         "I-12",
  "task.acceptance.visual-negative-control": "I-13",
  "task.evidence.visual-contract":     "I-13",
  "task.evidence.visual-state-pair":   "I-13",
  "task.validation.visual-manual":     "I-13",
  "task.validation.visual-unproven":   "I-13",
};
```

Two tests make this load-bearing:

1. **Exhaustiveness.** The map's key set must equal the issue-code set exported
   by `execution-contract.ts`. A new Ralph rule that has no IR invariant fails
   the build — you cannot add a final-stage rule without adding the IR
   invariant that prevents it.
2. **Non-emptiness under fuzzing.** For a corpus of mutated `ProjectModel`s,
   if the Ralph validator rejects the rendered document then `validate()` must
   have rejected the model, and the reported invariant must be the mapped one.

That pair is the difference between "we intend to have one validation closure"
and "we have one validation closure".

---

## 10. Deterministic rendering

### 10.1 `ProjectModel → ExecutionDocument`

The existing `ExecutionDocument` / `Phase` / `Task` types in
`packages/core/src/types.ts` are reused **unchanged**. They are already exactly
the parsed shape of `rb-execution/v1`, which makes them the natural round-trip
target and lets `parseExecutionMarkdown` serve as the verifier with no new
parser. The only change is that vNext *constructs* them instead of parsing them.

```ts
// vnext/render/execution.ts
export function deriveExecutionDocument(model: ProjectModel): ExecutionDocument;
export function renderPhases(document: ExecutionDocument): string;
```

### 10.2 Identity assignment algorithm

Deterministic, total, and dependent only on the IR:

1. **Phase order.** Stable Kahn topological sort of the phase graph, tie-broken
   by model declaration index. A cycle is I-04 (fatal). Ordering is deterministic
   and never depends on hash-map iteration order.
2. `phase.number = index + 1`; `phase.id = "P" + pad(number, 2)`.
3. **Task order.** Within each phase, stable Kahn topological sort of the
   phase-local task graph, tie-broken by declaration index.
4. **Task numbering.** A single global counter walks phases in order and tasks
   in phase order: `task.id = "T" + pad(counter, 3)`. This simultaneously
   satisfies Ralph's "globally unique", "numerically ascending across the whole
   document", "never restart in another phase", and "`Depends on` refers only to
   earlier task IDs" — the last because I-05 confines dependencies to the same
   or an earlier phase and the intra-phase topological sort orders the rest.
5. **Acceptance.** `AC-${task.id}-${pad(index + 1, 2)}`.
6. **Requirements.** `R-${pad(index + 1, 3)}` in `intent` declaration order.
7. **Artifact IDs.** `${identity.id}-execution` and `${identity.id}-brief`.
   Both match `^[a-z0-9][a-z0-9-]*$` because `identity.id` does.

### 10.3 Field-by-field rendering rules

| Rendered element | Source | Rule |
| --- | --- | --- |
| `# RB Execution Plan: <t>` | `identity.name` | verbatim, single line |
| `<!-- rb-execution-contract: rb-execution/v1 -->` | constant | emitted once, before phase 1 |
| `<!-- rb-artifact-id: … -->` | `executionArtifactId(id)` | emitted once, before phase 1 |
| `## Phase N: <title>` | derived number + `phase.title` | contiguous from 1 |
| `**Phase ID:**` | `phase.id` | — |
| `**Goal:**` | `phase.goal` | — |
| `**Depends on:**` (phase) | resolved `PhaseId`s, ascending, `", "`-joined | `none` when empty |
| `**Context:**` | **code-derived** | always exactly `` - `.rb/init/BRIEF.md` ``; never model-authored |
| `- [ ] TNNN — <title>` | `task.id`, `task.title` | delimiter is U+2014 EM DASH; always `[ ]` (never `[x]`) at generation |
| `**Scope:**` | `ownedPaths`, sorted, each backticked, `", "`-joined | — |
| `**Change:**` | `task.intent` | — |
| `**Covers:**` | `coversIds`, ascending, `", "`-joined | — |
| `**Depends on:**` (task) | resolved `TaskId`s, ascending, `", "`-joined | `none` when empty |
| `**Parallel safe:**` | computed boolean | `true` / `false` |
| `**Acceptance criteria:**` | one `    - AC-…: <statement>` per entry | 4-space indent |
| `**Validation:**` | one `    - …` per entry | `command` → `` `<QualityCommand.command>` ``; `manual` → `manual: <inspection>`; `human` → `human: <evidence>` |
| `**Expected evidence:**` | `task.evidence` | — |

Task field lines carry exactly two leading spaces; list items under
`Acceptance criteria` / `Validation` carry exactly four. Both match the frozen
parser's `TASK_FIELD` (`/^  - \*\*…/`) and nested-item (`/^    -\s+/`) regexes,
which is what makes the round-trip exact.

### 10.4 Recovery classification — and what slice 1 actually does

The four classes from the brief exist in the type system from day one so that
later handlers have a place to live. Slice 1 implements handlers for exactly
one:

| Class | Slice 1 behaviour |
| --- | --- |
| `deterministic-normalizable` | handled by `canonicalize()` — never reaches `validate()` |
| `semantic-retryable` | **fail closed.** Exit 4, `SEMANTIC_INVALID`, full finding list printed |
| `user-decision-required` | **fail closed.** Exit 4, findings printed as questions the operator may answer by re-running with `--answers` |
| `fatal` | **fail closed.** Exit 4 |

There is **no region splicing** and **no structural repair**. `structuralRegion`,
`spliceRegion`, and `requestStructuralRepair` have no counterpart.

When semantic regeneration is added (implementation phase 4 at the earliest),
its unit is a **semantic slice**, regenerated whole with the findings appended
to the input — never a Markdown region, never a document part. It will require
its own explicit end-to-end call ceiling before it may be merged (invariant 10).

---

## 11. Ralph integration and the artifact model

### 11.1 What slice 1 emits, and the evidence for each

```
.rb/
├── rb-manifest.json          REQUIRED — rb-manifest/v1
└── init/
    ├── PHASES.md             REQUIRED — rb-execution/v1
    └── BRIEF.md              REQUIRED — see justification below
```

| Artifact | Ralph evidence | Verdict |
| --- | --- | --- |
| `.rb/rb-manifest.json` | RB-RALPH-CONTRACT §2.1 canonical package; §3.2 invariants; "Antes de iniciar qualquer provider, o Ralph valida a árvore inteira" | **required** |
| `.rb/init/PHASES.md` | §2.1 "obrigatório para execução"; §4 grammar | **required** |
| `.rb/init/BRIEF.md` | §4.2 "`Context` deve listar ao menos um item. Os itens devem permitir que um agente iniciado sem contexto de conversa encontre a autoridade necessária."; §16 checklist "contexto suficiente para agentes frios" and "documentos de `Context` existem e não contradizem `PHASES.md`" | **required — justified** |
| `.rb/artifacts.tsv` | §2.1 "índice derivado, **não é a autoridade**"; §3.2 "quando presente" | **omitted** |
| `.rb/init/OPERATIONS.json` | §2.1 "opcional, recomendado"; §11 "Sem arquivo explícito, o gerente final deriva um cenário real a partir dos entrypoints documentados" | **omitted from slice 1** |
| `PROJECT.md`, `REQUIREMENTS.md`, `DECISIONS.md`, `PLAN.md`, `source-manifest.json` | no reference anywhere in the Ralph contract | **omitted** |

**On `BRIEF.md`.** Every phase needs a non-empty `Context` list, and Ralph's own
generator checklist requires those documents to exist and to be sufficient for a
cold agent. Pointing `Context` at `PHASES.md` itself would satisfy the parser
and defeat the requirement. `BRIEF.md` is a **projection**, not an authority: it
contains no task ID, no acceptance ID, no command to run, no phase. It contains
the objective, the decisions, the assumptions, the requirement table (`R-001 →
statement`) that makes `**Covers:** R-001` meaningful to a cold agent, the
protected paths, and the executable surface. It cannot introduce executable
authority because the renderer has no code path that emits one.

**On `OPERATIONS.json`.** Ralph explicitly derives a scenario from documented
entrypoints when the file is absent, and §16's checklist item is a quality
recommendation rather than a mechanical gate. Slice 1 omits it. Because
`ExecutableSurface` is already in the IR, adding it in implementation phase 4 is
a second deterministic projection of data that already exists — no new model
call, no new authority.

### 11.2 Manifest generation

```ts
// vnext/render/manifest.ts
export function buildManifest(
  model: ProjectModel,
  staged: readonly { path: RelPath; bytes: Buffer }[],
): ArtifactManifest;
```

Fully deterministic, zero model involvement:

- `manifestVersion: "rb-manifest/v1"`;
- `project: { id: model.identity.id, name: model.identity.name }`;
- `artifactRoot: ".rb"`;
- `generatedAt: model.provenance.generatedAt` (the single injected run clock);
- one record per staged file, in a fixed order (`init/BRIEF.md`, then
  `init/PHASES.md`), with:
  - `id`: `briefArtifactId` / `executionArtifactId`,
  - `kind`: `"project-brief"` / `"execution-plan"`,
  - `path`: `".rb/init/BRIEF.md"` / `".rb/init/PHASES.md"`,
  - `sha256`: SHA-256 of the **staged bytes**, computed after rendering, never
    predicted,
  - `status`: derived per §3.2 of the Ralph contract — `invalid` if the
    structural contract fails, `blocked` on `[NEEDS DECISION]` /
    `<!-- rb-readiness: blocked -->`, `draft` on `[DRAFT]` /
    `<!-- rb-readiness: draft -->`, else `ready`. vNext never emits a blocked or
    draft marker, so the derivation is a verification, not a branch;
  - `contract`: `"rb-execution/v1"` on the plan record only.

Byte-determinism of the *manifest* is broken only by `generatedAt`, which
`rb-manifest/v1` requires. Determinism tests freeze the clock; the artifact
files themselves carry no timestamp and are byte-identical across runs for a
byte-identical `ProjectModel`.

### 11.3 The closure, in order

```ts
// vnext/closure.ts
export interface ClosureReport { readonly ready: boolean; readonly findings: readonly Finding[] }
export async function closeOver(model: ProjectModel, staging: string): Promise<ClosureReport>;
```

1. `canonicalize(model)`
2. `validate(model)` — must be `valid`, else stop (no files written)
3. `deriveExecutionDocument(model)`
4. `renderPhases(doc)` → staging `init/PHASES.md`
5. `renderBrief(model)` → staging `init/BRIEF.md`
6. **round-trip**: `parseExecutionMarkdown(bytes)` must return a document
   structurally equal to `doc` (§12.1)
7. **Ralph contract**: `validateExecutionMarkdown(bytes)` must return zero
   issues — any issue here is a *bug*, located by `RALPH_ISSUE_TO_IR_INVARIANT`
8. `buildManifest(model, stagedBytes)` → staging `rb-manifest.json`
9. `validateManifestValue` + `validateManifestTree` over staging
10. **consumer fidelity**: the Core's own equivalent of
    `rb-ralph --plan <id> --dry-run` — resolve the plan from the manifest
    exactly as Ralph does and confirm it is selectable
    (`kind: execution-plan`, `status: ready`, `contract: rb-execution/v1`,
    record `id` equal to the `rb-artifact-id` marker)
11. **atomic publication** — single directory swap (§11.4)
12. post-publish **byte re-hash only**: confirm the published bytes hash to the
    manifest values. A mismatch here is a filesystem fault, never a semantic
    finding.

Steps 6–10 are all projections of IR invariants. **None of them may be the first
place a semantic rule appears** — that is exactly what §9.4's exhaustiveness
test enforces.

### 11.4 Publication and rollback

Reused from `harness-workspace.ts` with its semantic re-entry removed:

- render into `.rb-harness/runs/<runId>/staging/.rb/`;
- on success, move any existing `.rb` to
  `.rb-harness/runs/<runId>/previous/`, then `rename()` staging into place;
- on any filesystem error during the swap, restore `previous/` and report
  `PUBLICATION_FAULT`.

**There is no path from publication back to the model.** The frozen loop —
`publishStagedArtifacts` → `verifyArtifacts` → `rollbackPublishedArtifacts` →
`repair()` → republish, at `standalone-runner.ts:470–530` — has no counterpart.
Rollback exists for filesystem failure and interruption, and for nothing else.
An import-graph test asserts that `vnext/publish.ts` does not import
`vnext/gateway` or `vnext/providers`.

---

## 12. Round-trip properties

### 12.1 Execution document

```
∀ valid m:  parseExecutionMarkdown(renderPhases(deriveExecutionDocument(m)))
              ≡ deriveExecutionDocument(m)
```

Equality is structural over every execution-bearing field — `contract`,
`artifactId`, `title`, and for every phase `number`, `id`, `title`, `goal`,
`dependsOn`, `context`, and for every task `id`, `title`, `done`, `scope`,
`change`, `covers`, `dependsOn`, `parallelSafe`, `acceptanceCriteria`,
`validation`, `expectedEvidence`. The `line` field is excluded (it is a parse
artefact).

### 12.2 Canonicalization

```
∀ m:  canonicalize(canonicalize(m)) ≡ canonicalize(m)          // idempotent
∀ m:  validate(canonicalize(m)).findings has no "deterministic-normalizable"
```

### 12.3 Rendering determinism

```
∀ m:  renderPhases(deriveExecutionDocument(m)) is byte-identical across runs,
      processes, platforms, and Node versions
```

Guaranteed by: no `Date`, no `Math.random`, no `process.env`, no locale-sensitive
comparison (`Intl.Collator` is forbidden; sorting uses code-unit order), and no
iteration over a `Map`/`Set` whose insertion order is not itself derived from
the IR.

### 12.4 Manifest

```
∀ staged files f:  manifest.artifacts[f].sha256 === sha256(bytes on disk at f)
```

Verified twice — on staging (step 9) and after publication (step 12).

### 12.5 Identity stability

```
∀ m:  deriveExecutionDocument(m) assigns the same IDs on every run
∀ m:  the ID assignment depends only on the phase/task dependency graphs and
      declaration order — not on object key order, not on file order
```

---

## 13. Telemetry and budgets

### 13.1 Telemetry contract

```ts
// vnext/telemetry.ts
export const VNEXT_TELEMETRY_CONTRACT = "rb-harness-vnext-telemetry/v1" as const;

export type VNextStage =
  | "preflight" | "intent" | "interview" | "work"
  | "resolution" | "validation" | "rendering" | "closure" | "publication";

export interface SemanticCallRecord {
  readonly stage: VNextStage;
  readonly slice: string;
  readonly attempt: number;                       // 1-based; >1 only for transport retries
  readonly profileId: string;
  readonly startedAt: string;
  readonly durationMs: number;
  /** N underlying provider requests for THIS one Harness semantic call. */
  readonly providerRequests: Measured<number>;
  readonly inputTokens: Measured<number>;
  readonly cachedInputTokens: Measured<number>;
  readonly cacheWriteTokens: Measured<number>;
  readonly outputTokens: Measured<number>;
  readonly reasoningTokens: Measured<number>;
  readonly costUsd: Measured<number>;
  readonly firstOutputMs: Measured<number>;
  readonly normalizations: readonly NormalizationCode[];
  readonly outcome: "ok" | ProviderErrorKind;
}

export interface StageRecord {
  readonly stage: VNextStage;
  readonly durationMs: number;
}

export interface VNextTelemetryReport {
  readonly contract: typeof VNEXT_TELEMETRY_CONTRACT;
  readonly runId: string;
  readonly startedAt: string;
  readonly durationMs: number;

  /** The two numbers that must never be conflated. */
  readonly harnessSemanticCalls: number;
  readonly underlyingProviderRequests: Measured<number>;

  readonly stages: readonly StageRecord[];
  readonly calls: readonly SemanticCallRecord[];
  readonly normalizationEvents: readonly NormalizationEvent[];
  readonly transportRetries: number;
  readonly semanticRetries: number;          // MUST be 0 in slice 1
  readonly formatterCalls: number;           // MUST be 0, always
  readonly repairCalls: number;              // MUST be 0 in slice 1
  readonly interviewInterruptions: number;   // blocking questions actually asked
  readonly interviewAssumptions: number;     // questions defaulted instead
}
```

`Measured<T>` serializes as either the number or the string `"unmeasured"` with
a reason. A profile whose `usageReporting.reasoningTokens` is `false` reports
`{"measured": false, "reason": "unsupported-by-provider"}` — never `0`. A test
asserts that no `Measured` field is ever constructed with
`{ measured: true, value: 0 }` from a code path that did not read a real
provider-reported zero.

`harnessSemanticCalls` is incremented by the gateway, once per
`SemanticRequest`. `underlyingProviderRequests` is summed from adapter-reported
`CanonicalUsage.providerRequests`; if any adapter reports it unmeasured, the
total is unmeasured — the report says so rather than under-counting.

### 13.2 Budgets — slice 1

```ts
// vnext/budget.ts
export const VNEXT_BUDGET = {
  interview: {
    maxRounds: 1,
    maxBlockingAsked: 3,
  },
  semantic: {
    /** Hard ceiling on Harness semantic calls for one `vnext init` run. */
    maxCalls: 4,
    /** Typed transport failures only. Never changes a semantic outcome. */
    maxTransportRetriesPerCall: 1,
    /** Hard ceiling on underlying provider requests for one run. */
    maxProviderRequests: 6,
    maxSemanticRetries: 0,
    maxFormatterCalls: 0,
    maxRepairCalls: 0,
  },
  time: {
    perCallSeconds: 90,
    perCallFirstOutputSeconds: 45,
    totalRunSeconds: 240,
  },
  size: {
    maxRequestBytes: 64 * 1024,
    maxInputPackageBytes: 96 * 1024,
    maxOutputTokensPerCall: 16_000,
  },
} as const;
```

Enforcement is centralized: the gateway refuses to issue call number 5, and the
run aborts with `BUDGET_EXCEEDED`. There is no per-stage sub-budget that can sum
past `maxCalls` — invariant 10 in the concrete.

---

## 14. Adapter conformance suite

### 14.1 Shape

```ts
// vnext/providers/conformance/suite.ts
export const CONFORMANCE_SUITE_VERSION = "rb-adapter-conformance/v1" as const;

export type ConformanceCategory =
  | "valid-structured-response" | "nested-objects" | "arrays" | "enums"
  | "optional-fields" | "unknown-provider-metadata" | "wrapper-envelope"
  | "fenced-text" | "truncated-response" | "malformed-syntax"
  | "semantically-incomplete" | "unsupported-structured-output"
  | "reasoning-enabled" | "reasoning-disabled" | "usage-reporting"
  | "cancellation" | "timeout";

export type ConformanceExpectation =
  | { readonly kind: "payload-equals"; readonly value: unknown;
      readonly maxNormalizations: number }
  | { readonly kind: "error"; readonly errorKind: ProviderErrorKind }
  | { readonly kind: "usage"; readonly required: readonly (keyof CanonicalUsage)[] }
  | { readonly kind: "capability-refusal" };   // profile must decline up front

export interface ConformanceCase {
  readonly id: string;
  readonly category: ConformanceCategory;
  readonly mandatory: boolean;
  readonly request: SemanticRequest;          // Core-owned, adapter-agnostic
  readonly recorded: ProviderRawResponse;     // per-family recorded fixture
  readonly expect: ConformanceExpectation;
}

export interface ConformanceResult {
  readonly profileId: string;
  readonly suiteVersion: string;
  readonly runId: string;
  readonly tier: ConformanceTier;
  readonly cases: readonly { id: string; passed: boolean; normalizations: NormalizationCode[] }[];
}

export function runConformance(
  adapter: ProviderAdapter, profile: ModelProfile,
  fixtures: readonly ConformanceCase[],
): Promise<ConformanceResult>;
```

**The same canonical `SemanticRequest` fixtures are used for every adapter.**
Only the `recorded` provider response differs per family, and it is recorded
from a real call, never hand-written to make a test pass. Recording is a
one-time, explicit `npm run conformance:record -- --profile <id>` action; CI
replays recordings and never calls a provider.

### 14.2 Categories and what each proves

| Category | Mandatory | Proves |
| --- | --- | --- |
| `valid-structured-response` | yes | happy path yields the exact payload |
| `nested-objects` | yes | ≥ 3 levels survive (phases → tasks → validation) |
| `arrays` | yes | empty, single, and many-element arrays survive |
| `enums` | yes | enum-constrained fields (`covers`, `kind`) survive |
| `optional-fields` | yes | `null`-as-absent decodes identically across mechanisms |
| `unknown-provider-metadata` | yes | extra provider properties are dropped, not surfaced |
| `wrapper-envelope` | yes | the family's documented envelope unwraps to the same payload |
| `fenced-text` | conditional (`json-mode`, `none`) | a ```` ```json ```` fence is stripped |
| `truncated-response` | yes | yields `output-truncated`, never a partial payload |
| `malformed-syntax` | yes | yields `malformed-syntax`, never a repaired payload |
| `semantically-incomplete` | yes | a schema-shaped but semantically empty payload is returned **`ok`** — the adapter must **not** detect it (proving the boundary) |
| `unsupported-structured-output` | yes | a request the profile cannot serve yields `unsupported-capability` before any HTTP call |
| `reasoning-enabled` / `reasoning-disabled` | conditional | the toggle is actually honoured and reported |
| `usage-reporting` | yes | every field the profile claims is populated; every field it does not claim is `unmeasured` |
| `cancellation` | yes | `AbortSignal` yields `cancelled` promptly and leaks no socket |
| `timeout` | yes | the Core deadline yields `timeout`, not a hang |

The `semantically-incomplete` case is the sharpest test in the suite: an adapter
that "helpfully" fills in a missing requirement fails it. That is the boundary,
made executable.

### 14.3 Tier definitions

- **SUPPORTED** — every mandatory case passes, and every happy-path case
  (`valid-structured-response`, `nested-objects`, `arrays`, `enums`,
  `optional-fields`) produces `normalizations: []`. Extraction performed by the
  declared `structuredOutput` mechanism (e.g. reading `tool_use.input` under
  `forced-tool-argument`) is part of the mechanism and is not a normalization
  event.
- **SUPPORTED_WITH_NORMALIZATION** — every mandatory case passes, but ≥ 1
  happy-path case requires ≥ 1 `NormalizationEvent`, and the profile uses no
  more than **three** distinct `NormalizationCode` values across the whole
  happy path.
- **UNSUPPORTED** — any mandatory case fails, **or** passing would require a
  transformation outside the closed enum, **or** more than three distinct
  normalization codes are needed, **or** any second model call would be
  required.

**A provider/model combination is not selectable until its stored
`conformance.tier` is not `UNSUPPORTED` and its `suiteVersion` equals the
current suite version.** The gateway refuses the profile at preflight, before
credentials are read. Hand-editing a tier in `profiles.ts` is a review failure;
a test asserts that every profile's `conformance` block was produced by the
runner (it carries a `runId` that must exist in
`vnext/providers/conformance/records/`).

---

## 15. Provider reference implementation

### 15.1 Recommendation: **Claude / Anthropic** — `anthropic:claude-opus-5`

| Criterion | Anthropic | OpenAI | Verdict |
| --- | --- | --- | --- |
| Structured-output reliability | forced `tool_choice` on a single tool gives one deterministic payload shape | `response_format: json_schema, strict: true` is a stronger *guarantee* | OpenAI marginally stronger |
| API/tool contract stability | one `/v1/messages` shape, one content-block model | two live surfaces (chat completions, responses) with different structured-output stories | **Anthropic** |
| Capability introspection | few models, clearly differentiated (Opus/Sonnet/Haiku) | more models, more capability drift per model | **Anthropic** |
| Development ergonomics | `anthropic-messages` dialect, credential store, streaming and usage extraction already exist in `api-agent.ts` / `provider-registry.ts`; the operator is already authenticated | would need dialect-specific work of comparable size | **Anthropic** |
| Telemetry fit | reports `cache_read_input_tokens` and `cache_creation_input_tokens` explicitly — two *required* day-one metrics (§13.1) | reports cached tokens, no separate cache-write counter | **Anthropic** |
| Likely conformance tier | `SUPPORTED_WITH_NORMALIZATION` (`unwrapped-tool-call-arguments` on the happy path) | plausibly `SUPPORTED` | OpenAI cleaner |
| Schema-dialect constraints on the IR wire schema | none — the IR schema can be designed on its merits | strict mode constrains the schema (all properties required, `additionalProperties: false` everywhere, limited combinators), which would shape the IR around one vendor | **Anthropic** |

**Decision: Anthropic first.** Two reasons dominate.

First, the last row. Designing the wire schema against a strict-mode dialect
during the very phase when the IR is being invented risks the IR absorbing one
vendor's schema constraints as if they were design decisions. Designing it
against a permissive mechanism and *then* proving it against a strict one is the
right order.

Second, the "likely tier" row is a feature, not a defect. Anthropic landing at
`SUPPORTED_WITH_NORMALIZATION` means the reference implementation exercises the
normalizer and the tier system on day one. A reference that trivially reaches
`SUPPORTED` would leave the entire normalization boundary untested until the
second adapter.

**The second adapter must be OpenAI**, specifically because strict JSON Schema
stresses the wire schema differently. If the IR wire schema cannot be expressed
under OpenAI strict mode without distortion, that is a finding about the IR, and
it should surface in implementation phase 4, not in year two.

**This is not lock-in.** Nothing in `vnext/` outside
`vnext/providers/anthropic/` may mention Anthropic. An import-graph test and a
`grep` test for `anthropic|claude|openai|codex|mimo|minimax|deepseek`
(case-insensitive) over `vnext/**` excluding `vnext/providers/**` enforce it.

---

## 16. Migration and repository strategy

### 16.1 Boundary: a module tree, not a package

**Recommendation: `packages/core/src/vnext/`**, not a separate npm package.

Rationale: the repository ships a single standalone binary and enforces that
with `scripts/check-standalone-package.mjs` and a `check:package` gate. A second
workspace package would duplicate build, packaging, and drift-check surface for
isolation that an import rule already provides at zero cost. If vNext later
needs independent versioning, extracting a package from a clean module tree is
mechanical; merging two packages is not.

### 16.2 The import rule — one-way, and tested

```
vnext/**  MAY import from an explicit allowlist of legacy modules:
    types.ts  fs-utils.ts  hash.ts  path-policy.ts  path-ownership.ts
    execution-contract.ts  manifest.ts  operational-contract.ts
    credential-store.ts  process-tree.ts  process-containment.ts
    harness-splash.ts  version.ts

legacy modules MAY NOT import from vnext/**, with exactly one exception:
    cli-program.ts, to register the `vnext` command group.
```

Enforced by `test/vnext/import-boundary.test.ts`, which walks the import graph
and fails on any violation. This is the concrete answer to "avoid a flag that
intermixes both architectures inside the same large functions": there is no
flag, and the two architectures cannot call each other.

### 16.3 CLI surface

```
rb-harness vnext init [--request <text>|--file <path>] [--profile <id>]
                      [--answers <file>] [--non-interactive] [--dry-run]
rb-harness vnext conformance <profile-id>
rb-harness vnext profiles
```

`rb-harness init` continues to run the frozen pipeline, unchanged, throughout.

### 16.4 The exact point vNext becomes the default

`rb-harness init` routes to vNext when **all** of the following hold. Each is a
checkable fact, not a judgement:

1. The §14 acceptance scenario passes on three consecutive CI runs.
2. `anthropic:claude-opus-5` records a conformance tier other than
   `UNSUPPORTED` at the current suite version.
3. A second family (OpenAI) records a tier other than `UNSUPPORTED`.
4. CLI-transport support (implementation phase 4) ships, so that no operator
   loses the installed-CLI path they have today.
5. `OPERATIONS.json` projection ships, or an explicit product decision records
   that `init` no longer emits one.
6. `RALPH_ISSUE_TO_IR_INVARIANT` is exhaustive and the fuzz property (§9.4) is
   green.
7. The round-trip properties (§12) are green on a corpus of ≥ 200 generated
   models.

On that day: `rb-harness init` → vNext; the frozen path becomes
`rb-harness legacy init` for exactly one minor release; then §17.6's delete plan
executes.

**No big-bang replacement.** `plan`, `evolve`, `ai-context`, and `review` stay
on the frozen pipeline until each gets its own vertical slice.

---

## 17. Risks, hidden assumptions, and honest counter-arguments

This section argues against the rest of the document. It is the most important
section for a reviewer.

### 17.1 Hidden assumptions

**A1 — that a model classifies materiality and rigidity reliably.**
The blocking gate is deterministic *given* the classification, but the
classification is model-authored. The authority problem has been moved, not
removed. *Mitigation:* the `proposedDefault !== null` guard is the primary gate
and it is a much easier judgement than materiality; a misclassification costs at
most one round and three questions; `--answers` makes the whole thing
reproducible. *Residual risk:* accepted. A model that marks everything blocking
turns a non-interactive run into a hard failure — loud, not silent.

**A2 — that schema-valid means semantically correct.**
It does not. A perfectly schema-valid `ProjectModel` can describe a plan that
builds the wrong thing. vNext converts *representation* failures into *semantic*
failures — and slice 1 then fails closed on them. Against the frozen build,
which would have attempted three repairs, this is a **user-visible reliability
regression in the recovery dimension**, traded for a large gain in the
correctness dimension. That trade is the brief's explicit instruction
("Reliability is more important than recovery sophistication") and is recorded
here as a real cost, not a free win.

**A3 — that "one internal truth" is achievable while Ralph has three contracts.**
Ralph's own model keeps `PHASES.md`, `OPERATIONS.json`, and the manifest as
three artefacts. vNext unifies them *upstream*; the consumer still reads three
files. Drift is prevented only as long as all three are projections of one
model and no one is ever hand-edited. *Mitigation:* the manifest hash check
detects hand edits; nothing detects a hand edit that is re-manifested. Accepted.

**A4 — that the request is the whole authority.**
True for greenfield `init`. False for `init` on a directory with existing code,
and false for `plan`/`evolve`, where the repository is authority. Slice 1
restricts to greenfield precisely to keep A4 true. **This assumption must be
re-examined before the second workflow**, and `harness-evidence.ts` /
`harness-inventory.ts` are TEMPORARY BRIDGE rather than DO NOT PORT for exactly
that reason.

**A5 — that two slices fit in one output window.**
True for `hello <name>`. False for a real project: the `work` slice for a
30-task plan will approach or exceed a model's output cap. *This is the frozen
build's incremental-part protocol solving a real problem.* vNext's answer is
**slice-by-phase generation** — one call per semantic phase, still semantic
slices, never document parts — and it is not in slice 1. If the acceptance
scenario is passed and then the first real project immediately hits the output
cap, that is not a surprise; it is scheduled work (§19, phase 4).

### 17.2 Where this design could recreate the current complexity

| Regression path | Concrete guard specified here |
| --- | --- |
| The IR grows until it is the old document set | §5.11 consumer register + test; the census in §5.12 as a baseline |
| `NormalizationCode` grows one innocuous case at a time until it is the formatter | closed enum; three-code cap per profile (§6.4); a new code requires a fixture and a changelog entry |
| `semantic-retryable` acquires a handler, then a budget, then a loop | zero handlers in slice 1; invariant 10 forbids adding one without an explicit end-to-end ceiling |
| The interview becomes adaptive again | `maxRounds: 1` is structural — there is no loop to raise, only a second call site to add, which is reviewable |
| Slice count grows one slice at a time | §8.4's arithmetic table is part of the acceptance criterion; adding a slice moves a published number |
| `BRIEF.md` accretes sections until it is `PROJECT.md` + `REQUIREMENTS.md` + `DECISIONS.md` | it is a projection with a fixed renderer; adding a section requires adding an IR field, which requires a consumer register entry |
| Legacy modules get imported into `vnext/` for convenience until the boundary is meaningless | explicit allowlist + import-graph test (§16.2) |

### 17.3 Is the adapter boundary right?

**Too weak in one place, now closed.** Prompt text. If an adapter could append
"reply in JSON", provider semantics would leak through an unwatched door. §6.6
closes it: Core owns every prompt byte, and the profile selects a Core-owned
preamble *by mechanism*, never by identity.

**Too weak in a second place, partially closed.** Deadline and cancellation.
Core owns the deadline, but the adapter must honour `AbortSignal` and must not
throw. An adapter that ignores the signal makes `maxRunSeconds` a fiction. The
conformance `cancellation` and `timeout` cases are the only defence, and they
test the adapter's *recorded* behaviour, not a live socket. **Residual risk:
real cancellation semantics are under-tested by a replay-based suite.** A live
smoke test per family, run manually before a tier is recorded, is the honest
mitigation and is specified as part of `conformance:record`.

**Possibly too broad.** `ProviderAdapter.request` bundles protocol, streaming,
usage extraction, *and* normalization behind one method. A stricter design would
separate `transport` from `normalize` as independent injectables. §6.5 does
separate them by file (`adapter.ts` / `normalize.ts`) but not by type. This is a
deliberate simplification for slice 1; if a second family in the same dialect
(DeepSeek and MiniMax are both `openai-chat`) needs a shared transport with a
different normalizer, the split becomes necessary and is a small refactor.

### 17.4 Risk of an over-large IR

The census is 32 model-authored fields. The three most deletable:

1. **`Entrypoint`** — its only slice-1 consumer is invariant I-17. If I-17 is
   judged to be make-work, delete `Entrypoint` and add it with
   `OPERATIONS.json`.
2. **`Requirement.kind`** — no slice-1 consumer beyond `BRIEF.md` grouping.
   Retained only because its phase-4 consumer is concrete. If phase 4 slips,
   delete it.
3. **`Determination.rationale`** — read by humans in `BRIEF.md` and by nothing
   else. Defensible, but it is the field most likely to attract prose bloat.

Already cut during this design, and worth recording so they are not
re-introduced: `VisualAcceptance` (replaced by detect-and-fail I-13), typed
`EvidenceRequirement[]` (reduced to a string), and the `decisions`/`assumptions`
split (merged into `Determination`).

### 17.5 Risk of over-using structured output

Real and under-appreciated:

- **Schema-following consumes model attention.** A deep, wide schema measurably
  degrades content quality on some models. *Mitigation:* the `work` schema is at
  most four levels deep and the `intent` schema three.
- **Strict modes force all-properties-required**, which pushes a model to emit
  filler for fields it has nothing to say about. *Mitigation:* zero optional
  fields by design (§5.12); absence is expressed as an empty array or an
  explicit `null` with a documented decoder.
- **Structured output can suppress reasoning quality**, particularly where a
  model would otherwise have thought in prose first. *Mitigation:* profiles
  expose reasoning controls and the gateway may enable them per slice;
  `Determination.rationale` and `Entrypoint.description` give judgement
  somewhere to land inside the schema.
- **Enum-constrained `covers` (§8.2) is a hard constraint on a soft judgement.**
  If slice 1 under-produces requirements, slice 2 physically cannot express a
  task that covers the missing one. This is the intended behaviour — it converts
  a silent coverage gap into a visible I-03 finding — but it means the quality of
  slice 2 is bounded by slice 1. That coupling is the price of unrepresentability.

### 17.6 Migration risks

- **Two live architectures double the maintenance surface** until §16.4's switch.
  Bounded by freezing the legacy path: no new compensating fixes.
- **The frozen path keeps shipping bugs it will not fix.** Operators on
  `rb-harness init` see no improvement for the whole vNext build-out. This must
  be communicated, not discovered.
- **`cli-program.ts` is the one shared file.** Register the `vnext` group and
  touch nothing else; a merge conflict there is the only structural coupling.

### 17.7 Where the current implementation is genuinely superior

Not a formality. Six real ones:

1. **CLI-provider support.** The frozen build runs against an installed
   `claude`/`codex` CLI with no API key, using the operator's existing
   subscription. vNext slice 1 requires a direct API credential. For this
   operator specifically, that is a regression from day one until phase 4.
2. **Process containment and read confinement.** `process-containment.ts` (cgroup
   detection, creator-proven-gone) and `path-policy.ts` (a model that can read
   `.rb-harness/runs/<id>/state.json` reads its own prompt and starts documenting
   the orchestrator) encode subtle, correct safety properties that a naive vNext
   would not have thought of. Reused as-is, deliberately.
3. **The validation heuristics in `execution-contract.ts`.** The long-running
   service list, the masked-failure detector, the `node --check` against JSON
   detector, the disguised-`manual:` detector — each traceable to a documented
   incident in `docs/incidents/`. vNext must carry all of them into I-12 or it
   ships a regression with better architecture.
4. **The adaptive interview genuinely converges.** Twelve rounds is too many,
   but the design principle — an answer that opens a new material decision earns
   another round — finds late ambiguities that one round misses. vNext's
   one-round cap is a deliberate quality trade for bounded cost.
5. **Incremental part authoring solves a real output-window problem** (§17.1 A5).
6. **`provider-capabilities.ts`'s `advertised` vs `verified` distinction** is
   already the right idea; the conformance tier system is its generalization,
   not its replacement. Credit where due.

### 17.8 A simpler architecture, considered

**One semantic call instead of two.** Genuinely simpler and 50 % cheaper on the
trivial path. **Rejected** for one concrete reason: it forfeits the
enum-constrained `covers` and `commandKey` in §8.2, which is the only place in
this design where an entire class of semantic error becomes structurally
unrepresentable rather than merely detectable. One extra call is a good price.

**No `BRIEF.md`; point `Context` at `PHASES.md`.** Simpler and strictly
Ralph-parser-legal. **Rejected**: it satisfies the letter of "Context must list
at least one item" while defeating its stated purpose, and it would leave
`Covers: R-001` meaningless to a cold agent.

**No `ExecutableSurface`; let tasks author command strings.** Simpler wire
schema. **Rejected**: it re-admits command drift and scatters the incident-earned
validation heuristics across N tasks.

**Adopted simplifications** (all already folded into the design above): merging
decisions and assumptions into `Determination`; reducing evidence to a string;
replacing the visual-acceptance model with a detect-and-fail invariant; making
`parallelSafe` code-derived; making `Context` code-derived. Together these
remove one IR member, one nested type, and two model-authored fields against a
naive reading of the brief.

---

## 18. Architectural invariants

These are what code review enforces, permanently. Each names its mechanism.

| # | Invariant | Enforced by |
| --- | --- | --- |
| 1 | **No model-authored machine identity.** No `TaskId`, `PhaseId`, `AcceptanceId`, `RequirementId`, `ArtifactId`, `ProjectId`, hash, or timestamp originates from a model. | Branded types with ordinal-only constructors (§4.1); wire schemas contain no ID field (§8.3) |
| 2 | **No independently-authored executable authorities.** Every executable artefact is a projection of one `ProjectModel`. | Renderer is the only writer; `artifact-consistency.ts` is DO NOT PORT |
| 3 | **No provider-specific behaviour in Harness Core.** No `if (provider === …)` or equivalent outside `vnext/providers/<family>/`. | Import-graph test + case-insensitive `grep` for family names over `vnext/**` minus `vnext/providers/**` (§15.1) |
| 4 | **No LLM call for representation repair.** Ever. | `formatterCalls` budget is `0`; normalizer package may not construct a `SemanticRequest` (§6.4) |
| 5 | **No semantic rule exists only at final verification.** | `RALPH_ISSUE_TO_IR_INVARIANT` exhaustiveness test + fuzz property (§9.4) |
| 6 | **No document is required without a consumer.** Every generated file traces to a cited Ralph-contract requirement. | §11.1 evidence table is part of the spec; adding an artefact requires adding a row with a citation |
| 7 | **No recovery result bypasses the full deterministic closure.** Any regenerated slice re-enters at resolution and passes every step of §11.3. | Closure is a single function; there is no partial entry point |
| 8 | **No provider/model is marked supported without adapter conformance.** | Gateway refuses a profile whose `conformance.tier` is `UNSUPPORTED` or whose `suiteVersion` is stale; tier blocks carry a `runId` that must exist on disk (§14.3) |
| 9 | **No publication before semantic and Ralph validation succeed.** | Publication is step 11 of 12; `vnext/publish.ts` may not import `vnext/gateway` or `vnext/providers` (§11.4) |
| 10 | **No new call/retry budget without an explicit end-to-end call ceiling.** | All budgets live in one frozen object (§13.2); the gateway enforces `maxCalls` centrally |
| 11 | **No IR field without a registered consumer.** | `ir-consumers.md` + register test (§5.11) |
| 12 | **No normalization outside the closed `NormalizationCode` enum**, and no profile above three codes on the happy path. | Type + tier rule (§6.4, §14.3) |
| 13 | **No prompt text authored by an adapter.** | Core-owned preamble table selected by mechanism (§6.6) + string-literal lint over `vnext/providers/**` |
| 14 | **Parallel safety, `Context`, and all IDs are code-derived only.** | Absent from wire schemas; computed in `deriveExecutionDocument` (§10.2) |
| 15 | **Every rendered validation command traces to a declared `ExecutableSurface` entry.** | `ValidationIntent` carries a key, never a string (§5.9); invariant I-11 |
| 16 | **Telemetry never reports an unknown metric as a number.** | `Measured<T>` (§4.3); serializes as `"unmeasured"` with a reason |
| 17 | **Interview blocking is decided by code from typed classification, never by prose.** | `dispositionOf()` (§7.3); prompt text contains no blocking rule |
| 18 | **The vnext/legacy dependency is one-way.** | Import-boundary test with an explicit allowlist (§16.2) |
| 19 | **No fallback to a second model or profile on semantic failure.** A semantic defect is reported, not routed around. | Gateway has one profile per run; no fallback code path exists |
| 20 | **Staging is the only pre-publication write target, and publication is one atomic rename.** | `vnext/publish.ts` is the only module that writes outside `.rb-harness/runs/` |

---

## 19. Implementation phases

Four phases. Phase 1 requires **zero provider calls**, which is the single most
important scheduling property of this plan: the entire deterministic half of the
architecture is provable before any adapter exists.

### Phase 1 — Deterministic core (no provider at all)

Deliverables:
- `vnext/identity.ts`, `vnext/ir.ts`, `vnext/result.ts`
- `vnext/resolve.ts` (key resolution, topological ordering, ID assignment)
- `vnext/validate.ts` (`canonicalize` + all 20 invariants)
- `vnext/render/execution.ts`, `vnext/render/brief.ts`, `vnext/render/manifest.ts`
- `vnext/closure.ts`, `vnext/publish.ts`
- `vnext/ralph-fidelity.ts` + exhaustiveness test
- `docs/vnext/ir-consumers.md` + register test
- property tests §12.1–12.5; import-boundary test

Driven entirely by hand-written `ProjectModel` fixtures, including the
`hello <name>` fixture from §14. **Exit criterion:** the acceptance scenario's
*artifact half* passes end to end from a fixture — `contract validate`,
`tree validate`, and consumer dry-run all green — with no adapter in the repo.

### Phase 2 — Adapter layer and conformance

Deliverables:
- `vnext/providers/contract.ts`, `registry.ts`
- `vnext/providers/conformance/` (suite, canonical `SemanticRequest` fixtures,
  runner, record command)
- `vnext/providers/anthropic/` (adapter, normalizer, profiles)
- recorded fixtures for `anthropic:claude-opus-5`; a live cancellation/timeout
  smoke check as part of recording

**Exit criterion:** `rb-harness vnext conformance anthropic:claude-opus-5`
records a tier other than `UNSUPPORTED`; CI replays with zero provider calls;
the `semantically-incomplete` case passes (the adapter does *not* detect it).

### Phase 3 — Vertical slice wired end to end

Deliverables:
- `vnext/gateway/` (stage sequencing, prompt assembly, preamble table, budgets)
- `vnext/wire.ts` + `decodeSlice`
- `vnext/interview.ts` (typed questions, code-owned gate, `--answers`,
  non-interactive fail-closed)
- `vnext/telemetry.ts` + report emission
- run state, lock, checkpoint at **semantic-slice** granularity, resume
- `rb-harness vnext init` registered in `cli-program.ts`; splash, wizard,
  dashboard reused
- the §14 acceptance test in CI, replay-backed

**Exit criterion:** §14 passes, within every budget in §13.2.

### Phase 4 — Second family, CLI transport, operational projection, default switch

Deliverables:
- `vnext/providers/openai/` + conformance (stress-tests the wire schema against
  strict JSON Schema)
- CLI transport under the same `ProviderAdapter` interface, reusing
  `harness-provider.ts`'s process-tree and containment work — closing the §17.7
  capability regression
- `OPERATIONS.json` as a second deterministic projection of `ExecutableSurface`
- slice-by-phase generation for plans that exceed one output window (§17.1 A5)
- the §16.4 default switch, then the §20 delete plan

---

## 20. Reuse and delete map

### 20.1 Classification — all 57 modules in `packages/core/src`

**REUSE AS-IS — 12 modules.** Imported by `vnext/**` unchanged.

| Module | Why |
| --- | --- |
| `harness-splash.ts` | non-negotiable product constraint; zero coupling |
| `credential-store.ts` | encrypted vault, provider-agnostic; exactly the reusable half of the credential infrastructure |
| `auth-cli.ts` | `auth login/list/logout` unchanged |
| `process-tree.ts` | correct process-tree ownership; needed by CLI transport in phase 4 |
| `process-containment.ts` | cgroup detection; §17.7 item 2 |
| `path-policy.ts` | control-plane read denial; §17.7 item 2 |
| `path-ownership.ts` | `scopeTokenCoversPath` used by I-07 / I-19 |
| `fs-utils.ts` | bounded directory walking |
| `hash.ts` | SHA-256 |
| `types.ts` | `ExecutionDocument`/`Phase`/`Task`/`ArtifactRecord`/`ValidationIssue` are the round-trip target |
| `version.ts` | — |
| `operational-contract.ts` | `rb-operational/v1` validator, unchanged, for phase 4 |

**REUSE WITH SMALL ADAPTATION — 17 modules.**

| Module | Adaptation |
| --- | --- |
| `cli-program.ts` | register the `vnext` command group; touch nothing else |
| `cli.ts` | — |
| `index.ts` | export the vNext surface |
| `api-agent.ts` | **split**: HTTP/dialect/streaming/usage extraction becomes the seed of `vnext/providers/anthropic/adapter.ts`. Its agentic tool loop is DO NOT PORT (slice 1 uses no tools for semantic generation) |
| `provider-registry.ts` | endpoints/auth/dialect stay; `DirectProviderReasoning` moves into `ModelProfile` |
| `provider-capabilities.ts` | `advertised`/`verified` generalizes into `ConformanceTier` |
| `provider-cli.ts` | `provider list/test` gains conformance tiers |
| `harness-state.ts` | lock and atomic state write reused; `HarnessRunState` shape replaced by a vNext run state |
| `harness-workspace.ts` | staging, atomic publish, rollback, secret scan reused; the semantic re-entry path is removed |
| `manifest.ts` | validate/sync/hash/tree reused; `artifacts.tsv` write is skipped for vNext trees |
| `execution-contract.ts` | parser + validator become the round-trip verifier and the Ralph-fidelity oracle; its issue-code set becomes the domain of `RALPH_ISSUE_TO_IR_INVARIANT` |
| `harness-granularity.ts` | its ceilings become IR invariant I-15, evaluated on the IR rather than on Markdown |
| `harness-telemetry.ts` | `Measured<T>` replaces the `measured: boolean` + zeros pattern; stage enum replaced |
| `harness-dashboard.ts` | new stage labels; `structuralRepairs` counter removed |
| `harness-budget.ts` | replaced by `VNEXT_BUDGET` for vNext runs; legacy object retained for the frozen path |
| `harness-wizard.ts` | offers `vnext init`; product constraint preserved |
| `harness-input-package.ts` | serialization of request + answers + prior slice; document-plan concepts removed |

**TEMPORARY BRIDGE — 15 modules.** Kept running for the frozen path; needed for
a later vNext phase or workflow; not used by slice 1.

| Module | Bridge until |
| --- | --- |
| `harness-provider.ts` | phase 4 CLI transport (process spawn, log capture, containment wiring) |
| `api-stream.ts` | phase 4 (activity-line parsing for CLI adapters) |
| `provider-events.ts` | phase 4 (JSONL event reconstruction for CLI adapters) |
| `harness-evidence.ts` | the second workflow (`plan`/`ai-context`), where the repo is authority |
| `harness-inventory.ts` | same; slice 1 uses a small greenfield preflight instead |
| `evidence.ts` | same |
| `go-plan-convergence.ts` | a language-specific heuristic worth keeping; re-express as a typed `ExecutableSurface` check later |
| `headless-contract.ts` | the headless automation surface is out of scope for slice 1 |
| `headless-runner.ts` | same |
| `headless-interview-contract.ts` | same; its `rb-headless-interview/v1` typing is a useful precedent for §7 |
| `headless-interview-runner.ts` | same |
| `headless-prompt.ts` | same |
| `responsive-inventory.ts` | the `review` workflow |
| `standalone-resources.ts` | packaged prompt resources; vNext prompts are new |
| `project-package.ts` | — |

**DO NOT PORT — 13 modules.** These implement the architecture being replaced.

| Module | Why it does not survive |
| --- | --- |
| `harness-generator.ts` (1 249 lines) | orchestrates document-plan/document-part authoring and region-splicing structural repair; both concepts are gone |
| `harness-incremental-documents.ts` (727) | the `document-plan/v1` + `document-part/v1` wire protocol — LLM-owned serialization |
| `harness-documents.ts` | document bundle parsing/normalization for that protocol |
| `harness-control-formatter.ts` | the formatter LLM layer; forbidden by invariant 4 |
| `standalone-runner.ts` (715) | the publish → verify → rollback → repair → republish loop |
| `standalone-types.ts` | run-state shape built around that loop |
| `harness-interview.ts` (607) | untyped adaptive interview; replaced by §7 |
| `workflow-definition.ts` | mandatory artifacts not derived from the Ralph contract — the defect itself |
| `harness-contract-digest.ts` | teaches a model the Markdown grammar; a JSON Schema replaces it |
| `artifact-verifier.ts` (641) | the hidden final validator; its rules become IR invariants (kept only as a tool for the frozen path) |
| `artifact-consistency.ts` | reconciles independently authored `PHASES.md` and `OPERATIONS.json`; unrepresentable in vNext |
| `authority-constraints.ts` | mines protected paths and traceability out of prose; replaced by typed `ProtectedPath` |
| `api-agent-tools.ts` | confined tool surface for agentic authoring; slice 1 semantic generation uses no tools |

**Totals: 12 REUSE AS-IS · 17 REUSE WITH SMALL ADAPTATION · 15 TEMPORARY BRIDGE
· 13 DO NOT PORT = 57.**

### 20.2 Future deletion map — nothing is deleted now

Each row lists the trigger that makes deletion safe. Deletion happens only after
that trigger is observably met.

| Delete | Trigger |
| --- | --- |
| `harness-control-formatter.ts` + `formatting` budget + `repair-plan-formatter` telemetry operation | vNext is default for every workflow that used it |
| `harness-incremental-documents.ts`, `harness-documents.ts` (`document-plan/v1`, `document-part/v1`) | same |
| region-splicing structural repair inside `harness-generator.ts` (`structuralRegion`, repair passes) + `structuralRepairs` budget + `StructuralRepairTelemetryRecord` + `structural-repair` stage | same |
| document dependency projection (`PlannedDocument.dependsOn` and its canonicalization — the subject of commits `8f68e31`, `721b4cd`) | same |
| `harness-generator.ts` | all four workflows migrated |
| `standalone-runner.ts`, `standalone-types.ts` | same |
| `artifact-consistency.ts` | `OPERATIONS.json` is a projection of `ProjectModel` for every workflow |
| `artifact-verifier.ts` | every one of its criteria has a mapped IR invariant and the mapping is exhaustive |
| `authority-constraints.ts` | every workflow carries typed `ProtectedPath` |
| `workflow-definition.ts` | every workflow's artifact set is consumer-derived |
| `harness-contract-digest.ts` | no workflow hands a model a document grammar |
| `harness-interview.ts` | every workflow uses the typed interview |
| `api-agent-tools.ts` | either an evidence-gathering slice needs tools (then it is rewritten, not ported) or it does not |
| `.rb/artifacts.tsv` generation in `manifest.ts` | confirmed that no consumer in the ecosystem reads it |
| legacy `HARNESS_BUDGET` | last frozen-path command removed |

---

## 21. Vertical slice acceptance test

### 21.1 Scenario

**Fixture project:** empty directory, no `.git`, no `.rb`, no `package.json`.

**Request (verbatim):**

> Create a Node.js command-line program named `hello`. Running `hello <name>`
> prints `Hello, <name>!` to standard output and exits with code 0. Running
> `hello` with no argument prints `Hello, world!` and exits with code 0. Include
> automated tests.

**Invocation:**

```bash
rb-harness vnext init --file request.txt --profile anthropic:claude-opus-5
```

### 21.2 Expected observable outcome

| # | Assertion |
| --- | --- |
| 1 | The request is sufficiently explicit: `interviewInterruptions === 0` |
| 2 | Exactly **2** Harness semantic calls (`intent`, `work`) |
| 3 | `semanticRetries === 0`, `formatterCalls === 0`, `repairCalls === 0` |
| 4 | `validate()` returns `valid: true` with zero findings |
| 5 | Exactly three files exist: `.rb/rb-manifest.json`, `.rb/init/PHASES.md`, `.rb/init/BRIEF.md`. No `artifacts.tsv`, no `OPERATIONS.json`, no `PROJECT.md`, no `REQUIREMENTS.md`, no `DECISIONS.md`, no `PLAN.md`, no `source-manifest.json` |
| 6 | `rb-harness contract validate .rb/init/PHASES.md` → exit 0, zero issues |
| 7 | `rb-harness tree validate .` → exit 0 |
| 8 | `rb-ralph --project . --list` lists exactly one plan, id `hello-execution` |
| 9 | `rb-ralph --project . --plan hello-execution --dry-run` → **READY** |
| 10 | Round-trip: `parseExecutionMarkdown(PHASES.md) ≡ deriveExecutionDocument(model)` |
| 11 | Every task ID is `T00N`, ascending, globally unique; every acceptance ID is `AC-T00N-0M`; no such string appears in either raw provider payload |
| 12 | Re-running with the same recorded provider responses produces **byte-identical** `PHASES.md` and `BRIEF.md` |
| 13 | Every budget in §13.2 is respected; the telemetry report contains no `Measured` field fabricated as `0` |

Structural shape expected (not asserted exactly, so the test is not a
transcription check): 1–2 phases, 2–4 tasks, ≥ 3 requirements, ≥ 1 quality
command of kind `test`.

### 21.3 Budgets — hard ceilings for the proof

| Budget | Ceiling | Note |
| --- | --- | --- |
| Harness semantic calls | **4** | normal is 2; 4 allows one interview round on a *different* request without a code change |
| Underlying provider requests | **6** | at most one transport retry per semantic call |
| Wall time, per semantic call | **90 s** | |
| Wall time, first output per call | **45 s** | |
| Wall time, whole run | **240 s** | includes validation, render, closure, publication |
| Semantic retries | **0** | |
| Formatter calls | **0** | permanently, by invariant 4 |
| Model repair calls | **0** | |
| Interview rounds | **1** | |
| Blocking questions asked | **3** | |
| Output tokens per call | **16 000** | |

Runaway amplification is impossible because the ceilings multiply out to a fixed
maximum: **4 semantic calls × 1 transport retry = 6 provider requests, full
stop.** There is no nested budget, no per-stage allowance that can sum past
`maxCalls`, and no recovery path that consumes a call.

### 21.4 The worked identity example

Model emits, in the `work` slice (no IDs anywhere):

```json
{ "phases": [{
  "key": "deliver-cli", "title": "Deliver the hello CLI",
  "goal": "A user can run the program and see the greeting.", "dependsOn": [],
  "tasks": [
    { "key": "setup-project",
      "title": "Create the Node package and CLI entrypoint",
      "intent": "Add package.json with a bin entry and an executable stub.",
      "dependsOn": [], "ownedPaths": ["package.json", "bin/hello.js"],
      "covers": ["ship-cli-binary"],
      "acceptance": ["Running `node bin/hello.js` exits with code 0."],
      "validation": [{ "kind": "command", "commandKey": "run-tests" }],
      "evidence": "New package.json and bin/hello.js, plus passing test output.",
      "sequentialHint": false },
    { "key": "implement-greeting",
      "title": "Implement the greeting behaviour",
      "intent": "Print the greeting for a supplied name and for no argument.",
      "dependsOn": ["setup-project"],
      "ownedPaths": ["src/greet.js", "test/greet.test.js"],
      "covers": ["greet-named-user", "greet-default"],
      "acceptance": [
        "Running `node bin/hello.js Ada` writes exactly `Hello, Ada!` to stdout and exits 0.",
        "Running `node bin/hello.js` with no argument writes exactly `Hello, world!` to stdout and exits 0."
      ],
      "validation": [{ "kind": "command", "commandKey": "run-tests" }],
      "evidence": "src/greet.js, test/greet.test.js, and passing test output.",
      "sequentialHint": false }
  ]}]}
```

Core assigns, and the renderer emits:

```markdown
# RB Execution Plan: hello

<!-- rb-execution-contract: rb-execution/v1 -->
<!-- rb-artifact-id: hello-execution -->

## Phase 1: Deliver the hello CLI

**Phase ID:** P01
**Goal:** A user can run the program and see the greeting.
**Depends on:** none
**Context:**
- `.rb/init/BRIEF.md`

- [ ] T001 — Create the Node package and CLI entrypoint
  - **Scope:** `bin/hello.js`, `package.json`
  - **Change:** Add package.json with a bin entry and an executable stub.
  - **Covers:** R-003
  - **Depends on:** none
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T001-01: Running `node bin/hello.js` exits with code 0.
  - **Validation:**
    - `npm test`
  - **Expected evidence:** New package.json and bin/hello.js, plus passing test output.

- [ ] T002 — Implement the greeting behaviour
  - **Scope:** `src/greet.js`, `test/greet.test.js`
  - **Change:** Print the greeting for a supplied name and for no argument.
  - **Covers:** R-001, R-002
  - **Depends on:** T001
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T002-01: Running `node bin/hello.js Ada` writes exactly `Hello, Ada!` to stdout and exits 0.
    - AC-T002-02: Running `node bin/hello.js` with no argument writes exactly `Hello, world!` to stdout and exits 0.
  - **Validation:**
    - `npm test`
  - **Expected evidence:** src/greet.js, test/greet.test.js, and passing test output.
```

Traced explicitly:

- `implement-greeting` → **`T002`**, because the intra-phase topological sort
  places `setup-project` first (it is a dependency) and the global counter is at
  2. The model never wrote `T002`.
- `dependsOn: ["setup-project"]` → **`Depends on: T001`**, resolved once through
  the key table. The model never wrote `T001`.
- `acceptance[0]` → **`AC-T002-01`**, from `acceptanceId(T002, 1)`. The model
  never wrote `AC-T002-01`.
- `covers: ["greet-named-user", "greet-default"]` → **`R-001, R-002`**, resolved
  from the `intent` slice's declaration order. The model never wrote `R-001`.
- `validation: [{ kind: "command", commandKey: "run-tests" }]` → **`` `npm test` ``**,
  from `ExecutableSurface.qualityCommands`. The model never wrote a command
  string inside a task.
- `Parallel safe: false` for T002 because `T001` is in the same phase.
  `sequentialHint` was `false`; the *code* decided. The model's opinion was not
  consulted.
- `Context: .rb/init/BRIEF.md` — code-derived. The model never named a `.rb`
  path.
- `<!-- rb-artifact-id: hello-execution -->` — `executionArtifactId(projectId)`.
  The model never authored an artifact ID.

---

## 22. Open questions for the reviewer

Flagged rather than silently decided:

1. **`Entrypoint` retention** (§17.4). Keep for I-17 and phase 4, or cut now and
   re-add with `OPERATIONS.json`?
2. **`BRIEF.md` naming.** `BRIEF.md` avoids collision with the frozen build's
   `PROJECT.md` and signals "projection, not authority". If a different name is
   preferred, decide before the artifact ID (`<project>-brief`) is published.
3. **CLI-transport timing** (§17.7 item 1). Phase 4 is the plan; if losing the
   installed-CLI path even temporarily is unacceptable, phases 2 and 4 swap and
   the reference implementation becomes the `claude` CLI wrapped as a
   `ProviderAdapter` — at the cost of testing structured output through a
   subprocess.
4. **`maxBlockingAsked: 3` overflow.** Specified as a `fatal` finding (§7.4). The
   alternative — ask three, defer the rest as assumptions — is more forgiving and
   less honest. Confirm the strict reading.

---

*End of specification. Nothing described here has been implemented.*
