# Documentation benchmarks

`scripts/benchmark.mjs` runs one real workflow against a real provider and
writes a versioned `rb-harness-benchmark/v1` report into this directory.

**Status: the 0.4.0 benchmark has not been run.** It consumes paid provider
resources, so it is an explicit operator decision and is never triggered by a
test, by `npm run check`, or by an agent. Until it runs, no claim is made that
0.4.0 beats the baseline in `baseline-2026-08-24.md`.

## What the script guarantees

- **Only this invocation's run counts.** Existing run IDs are recorded before the
  workflow starts, and only a run created afterwards may be reported. If none
  appears, the benchmark fails and says so; an earlier success is never adopted.
- **Readiness comes from the contract.** Ralph-readiness is taken from
  `rb-harness artifacts verify --deterministic-only --json` of the same build,
  never inferred from the run's own `status` field.
- **Failure is loud.** The script exits non-zero when generation fails, when the
  run does not complete, when deterministic verification rejects the tree, or
  when a declared limit is exceeded — and it still writes the report.
- **Missing metrics stay missing.** A cost must be a finite, non-negative
  number; a provider that reports no usage is recorded as `measured: false` with
  a stated reason. Nothing absent is rendered as zero.
- **An unverified criterion is never an approval.** Cost is an acceptance
  criterion, so a run whose cost was never observed is `incomplete`, not
  `passed`. Exit codes are `0` passed, `1` failed, `2` incomplete.
- **No secrets, prompts, or answers.** The report carries provider and model
  names, stage durations, call counts, reported usage, and the verification
  verdict. It never carries a credential selector, the request text, interview
  answers, or generated content.

Its control flow is covered by `packages/core/test/benchmark.test.ts` using a
local fake CLI: those tests make no network call and cost nothing.

## The authorized `cron2` command

Run this only with explicit authorization. It calls a paid provider.

```bash
node scripts/benchmark.mjs \
  --project /home/bruno/Documentos/Projetos/testes/cron2 \
  --workflow init \
  --file prompt.md \
  --provider opencode \
  --model opencode-go/deepseek-v4-pro \
  --effort high \
  --label cron2-rb-harness-0.4.0 \
  --commit "$(git rev-parse --short HEAD)" \
  --observed-cost-usd <value read from the provider's billing view>
```

`--observed-cost-usd` is optional at run time: OpenCode exposes no programmatic
cost, so the operator reads it from the provider's own billing view. A report
without it is `incomplete` — every other criterion may have passed, but one is
still unverified and the benchmark says so instead of approving.

Record the cost afterwards on the same report. This starts no provider and
re-runs nothing; it only supplies the metric the provider could not expose:

```bash
node scripts/benchmark.mjs finalize \
  --report docs/benchmarks/<file>.json \
  --observed-cost-usd 0.23
```

Use `--answers answers.json` to run the workflow without a terminal.

## Acceptance thresholds (CA-001)

| Dimension | Target | Acceptance limit |
|---|---|---|
| Wall duration | 15 minutes | 20 minutes |
| Cost | US$ 0.30 | US$ 0.40 |
| Ralph-ready plan | published with no manual correction | — |
| Harness self-inspection | never | — |

A run that exceeds a limit is not a failure to hide: keep the report, and explain
the deviation with the measured stage durations, provider call count, and token
usage from the same file. Raising a threshold is not an explanation.

## Baseline

`baseline-2026-08-24.md` records the measured pre-refactor behavior that
motivated this work. Compare every new report against it.
