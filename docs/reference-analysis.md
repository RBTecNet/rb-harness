# Reference Analysis: bc-harness and ralph.sh

## What the examples established

The examples contain several sound boundaries retained by RB Harness:

- Commands are thin workflow routers and specialized agents own document
  content.
- Implemented reality (`ai-context`) is distinct from intended behavior
  (`init` and `plan`).
- Planning ends at documentation and does not silently implement code.
- Generated-file ownership, source hashing, reruns, and mechanical validation
  are first-class concerns.
- Execution phases need fresh context, external validation, and resumable
  state rather than trusting an LLM's completion claim.

## Constraints removed from the documentation producer

The reference `bc-harness` describes itself as stack-agnostic, but parts of its
init chain always request user stories and a database schema. RB Harness uses
conditional capability discovery: it emits database, API, UI, authentication,
messaging, deployment, or formal-contract sections only when required.

The reference `ai-context` writes a fixed ten-file tree and has a small gap
interview. RB Harness keeps a compact index, emits conditional subject files,
classifies claims by evidence, presents discoveries before questions, and asks
only decisions whose answers materially affect the result.

The reference `plan` has valuable RIGID/FLEXIBLE separation and clarification,
but couples the final handoff to one script path. RB Harness preserves the
separation and traceability while keeping every generated document neutral to
provider, CLI, commit strategy, agent topology, and executor.

## Ralph compatibility problem

The reference Ralph discovers a default phases filename, splits Markdown with
shell regular expressions, and supports two engines directly. This creates
three coupled contracts: directory convention, Markdown shape, and executor
behavior. A valid-looking document can be truncated or interpreted differently
when a heading or checkbox deviates from the script's assumptions.

RB Harness replaces that implicit coupling with two explicit versioned
contracts:

1. `rb-manifest/v1` discovers artifacts by ID, kind, status, contract, path,
   and SHA-256. Directory layout is not inferred.
2. `rb-execution/v1` defines the exact phase/task grammar, dependencies,
   acceptance criteria, validation, evidence, and parallel-safety fields.

The bundled Bash resolver emits only plans whose entire tree, hash, readiness,
and execution grammar validate. A future RB Ralph can therefore focus on run
management, provider adapters, parallel scheduling, retries, verification, and
context budgets instead of parsing undocumented producer conventions.

## Deliberate current boundary

RB Harness now owns the standalone documentation executable, deterministic
core, versioned contracts, and compatibility adapters. RB Ralph and RB Memory
are implemented in separate repositories and remain optional consumers. The
Harness neither executes application plans nor makes generated documentation
depend on hosted memory, a plugin host, a provider, or a particular model.
