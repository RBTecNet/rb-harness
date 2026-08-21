# Adaptive Interview Policy

## Ask decision rule

Ask only when all are true:

1. Repository evidence and supplied sources cannot answer safely.
2. At least 2 plausible answers exist.
3. The choice affects observable behavior, scope, contracts, security, data, or
   architecture.
4. A wrong assumption creates meaningful rework or risk.

Do not ask about discoverable commands, dependencies, paths, conventions, or
low-impact implementation details. Record a safe low-risk assumption instead.

## Balanced mode

Balanced is the default:

- Present discoveries and the gap summary first.
- Ask up to 5 related questions in round 1.
- Ask up to 3 focused follow-ups when answers leave material ambiguity. A
  follow-up is warranted even when generation could continue, if choosing the
  wrong interpretation could change behavior, scope, contracts, security,
  data, architecture, compatibility, or operational acceptance.
- If more material decisions remain, summarize them and offer to save/resume.
- Accept `use recommendations`, `not sure`, `defer`, and free-form corrections.
- Persist answers under `.rb/handoffs/` before another round.

Quick mode asks only blockers and records more assumptions. Deep mode may ask
additional risk questions for security, regulated data, migrations, public
contracts, or distributed workflows. Never silently downgrade a critical gap.

## Question shape

Each question contains:

- evidence already found;
- the missing decision;
- why it matters;
- 2–4 concrete options when appropriate;
- a recommended option with evidence;
- consequences of the alternatives.

Batch related questions. Never drip generic questions one at a time. Do not ask
the developer to retell facts already present in sources.

## Answer acceptance gate

Classify every material response before using it as a decision:

- `ACCEPTED`: the response or an explicitly approved normalized checkpoint has
  one material interpretation and answers the decision that was asked.
- `PARTIAL`: it resolves part of the decision but leaves a material boundary,
  actor, trigger, outcome, failure case, or exception open.
- `AMBIGUOUS`: at least 2 materially different interpretations remain.
- `DEFERRED`: the developer said they do not know, do not care yet, or want to
  decide later.
- `CONTRADICTED`: it conflicts with supplied evidence, another accepted answer,
  or itself.

Only `ACCEPTED` responses may become `CONFIRMED` knowledge. `PARTIAL` and
`AMBIGUOUS` require a narrower follow-up while the unresolved part remains
material. State the interpretations or missing boundary, then ask for a choice,
rule, concrete example, or counterexample. Do not silently choose the most
convenient reading.

An explicit `use recommendations` accepts the recommendations that were shown.
`not sure` and `defer` remain `DEFERRED`; they never confirm a recommendation by
implication. A bare approval such as `yes` is sufficient only when it refers to
a checkpoint that already states the material decision precisely.

Do not add precision the response did not supply: no invented quantifiers,
numbers, defaults, actors, platforms, failure behavior, compatibility promises,
or exceptions. Terms such as `appropriate`, `supported`, `normal`, `fast`,
`secure`, `as needed`, `when possible`, and `etc.` may appear as descriptive
prose, but cannot define RIGID behavior, a domain rule, or acceptance criteria
without an observable meaning or explicit boundary.

When the repository contradicts a response, preserve both as `CONFLICT` and ask
whether the response describes current behavior, intended behavior, or an
exception. A vague response never overrides observed behavior in an existing
project.

Persist the raw response, normalized decision, disposition, affected topics,
and any remaining uncertainty in the handoff and source manifest. This keeps a
later writer from receiving ambiguous prose labeled only as "confirmed
answers".

## Pre-write ambiguity audit

Before writing or delegating artifacts, audit every material normalized claim:

1. Trace it to repository evidence, an `ACCEPTED` response, or an explicit
   low-risk assumption.
2. Check that actor/subject, trigger or condition, outcome, and relevant
   boundary or failure behavior have a single interpretation.
3. Check that the normalization is no stronger or more precise than its source.
4. Move unresolved alternatives to questions, assumptions, `UNKNOWN`, or
   `CONFLICT`; never hide them inside fluent prose.

For existing projects, favor preservation: document uncertainty and the
implemented behavior rather than guessing a rule that could make a later plan
break working behavior. For executable plans, no unresolved material ambiguity
may enter a RIGID requirement, binary criterion, task change, or operational
scenario.

## Stop condition

Stop interviewing when remaining uncertainty is either FLEXIBLE or a low-risk
explicit assumption. If a material answer remains unresolved after focused
follow-up, record it as `UNKNOWN`, `CONFLICT`, or an open decision. Use `BLOCKED`
when execution would otherwise be unsafe, contradictory, behaviorally
ambiguous, or impossible to validate; otherwise keep the unresolved item out of
RIGID claims and report the reduced readiness explicitly.
