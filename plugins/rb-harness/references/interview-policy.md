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
- Ask up to 3 follow-ups only when answers expose blocking ambiguity.
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

## Stop condition

Stop interviewing when remaining uncertainty is either FLEXIBLE or a low-risk
explicit assumption. Use `BLOCKED` only when execution would otherwise be
unsafe, contradictory, or impossible to validate.
