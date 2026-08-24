#!/usr/bin/env node
/**
 * Reproducible documentation benchmark.
 *
 * It runs one real workflow against a real provider and turns that run's own
 * evidence into a versioned, credential-free report. Three rules keep the
 * report honest:
 *
 *   1. only a run created by *this* invocation may be reported, so a stale
 *      success can never be presented as a fresh one;
 *   2. Ralph-readiness is proven by the deterministic artifact contract, never
 *      inferred from a status field the generator wrote about itself;
 *   3. a metric the provider did not report stays `null` with a stated reason
 *      — it is never rendered as zero, and a run whose cost was never observed
 *      is `incomplete`, never `passed`.
 *
 * A failing benchmark still produces a report, and always exits non-zero.
 * Exit codes: 0 passed, 1 failed, 2 incomplete (a criterion is still unverified).
 *
 * Usage:
 *   node scripts/benchmark.mjs --project /path/to/cron2 \
 *     --workflow init --file prompt.md \
 *     --provider opencode --model opencode-go/deepseek-v4-pro \
 *     --label cron2-rb-harness [--observed-cost-usd 0.23] [--answers a.json]
 *
 *   node scripts/benchmark.mjs finalize \
 *     --report docs/benchmarks/<file>.json --observed-cost-usd 0.23
 */

import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const BENCHMARK_CONTRACT = "rb-harness-benchmark/v1";
export const TIME_TARGET_SECONDS = 15 * 60;
export const TIME_LIMIT_SECONDS = 20 * 60;
export const COST_TARGET_USD = 0.3;
export const COST_LIMIT_USD = 0.4;

function argument(argv, name, fallback) {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`--${name} requires a value`);
  return value;
}

function requiredArgument(argv, name) {
  const value = argument(argv, name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

/** Run directory names present right now; `[]` when none exist yet. */
async function runIds(project) {
  try {
    return (await readdir(resolve(project, ".rb-harness/runs"), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** `target` verdicts, or `unavailable` when the metric was never measured. */
export function verdict(value, target, limit) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "unavailable";
  if (value <= target) return "target";
  if (value <= limit) return "accepted";
  return "exceeded";
}

/** A cost is a finite, non-negative number or it is simply not a cost. */
export function parseObservedCost(raw) {
  if (raw === undefined || raw === null || raw === "") return { value: null, source: "not supplied by the operator" };
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`--observed-cost-usd must be a finite non-negative number; received ${JSON.stringify(raw)}`);
  }
  return { value, source: "operator observation" };
}

/** Usage totals are reported only when the provider actually measured them. */
export function usageOrUnavailable(totals) {
  if (!totals || totals.measured !== true) {
    return { measured: false, reason: "the provider reported no usage; tokens and cache are unmeasured" };
  }
  return { measured: true, ...totals };
}

/**
 * Judge a report.
 *
 * Cost is one of the acceptance criteria, so a run whose cost was never
 * observed has not met them — it has only met the ones that could be checked.
 * That state is `incomplete`, never `passed`. It becomes `passed` or `failed`
 * once the operator finalizes the same report with the observed cost, which
 * requires no provider call.
 */
export function evaluateBenchmark(report) {
  const failures = [];
  const pending = [];
  if (report.exitCode !== 0) failures.push(report.diagnostic ?? "the workflow command failed");
  if (!report.runId) failures.push("no new Harness run was created by this invocation");
  if (report.status && report.status !== "complete") failures.push(`the run ended in status ${report.status}`);
  if (report.validation && report.validation.readyForRalph !== true) {
    failures.push(`deterministic verification did not report Ralph-ready (${report.validation.status ?? "unknown"})`);
  }
  if (!report.validation) failures.push("deterministic verification did not run");
  if (report.duration.verdict === "exceeded") failures.push(`duration ${report.duration.wallSeconds}s exceeded the ${TIME_LIMIT_SECONDS}s acceptance limit`);
  if (report.cost.verdict === "exceeded") failures.push(`cost US$ ${report.cost.observedUsd} exceeded the US$ ${COST_LIMIT_USD} acceptance limit`);
  if (report.cost.verdict === "unavailable") {
    pending.push(
      `the observed cost is unverified and cost is an acceptance criterion (target US$ ${COST_TARGET_USD}, limit US$ ${COST_LIMIT_USD}). `
      + "Finalize this report with: node scripts/benchmark.mjs finalize --report <path> --observed-cost-usd <value>",
    );
  }
  const result = failures.length ? "failed" : pending.length ? "incomplete" : "passed";
  return { result, failures, pending };
}

/** Apply a judgement to a report object in place and return it. */
export function applyEvaluation(report) {
  const evaluation = evaluateBenchmark(report);
  report.result = evaluation.result;
  // `passed` is only ever true for a fully verified run.
  report.passed = evaluation.result === "passed";
  if (evaluation.failures.length) report.failures = evaluation.failures;
  else delete report.failures;
  if (evaluation.pending.length) report.pending = evaluation.pending;
  else delete report.pending;
  return evaluation;
}

/**
 * Record the observed cost on an existing report without re-running anything.
 * The provider is never contacted: the workflow already happened, and this only
 * supplies the metric the provider could not expose programmatically.
 */
export async function finalizeBenchmark(argv) {
  const path = resolve(requiredArgument(argv, "report"));
  const report = JSON.parse(await readFile(path, "utf8"));
  if (report.contract !== BENCHMARK_CONTRACT) {
    throw new Error(`${path} is not an ${BENCHMARK_CONTRACT} report`);
  }
  const cost = parseObservedCost(requiredArgument(argv, "observed-cost-usd"));
  report.cost = {
    ...report.cost,
    observedUsd: cost.value,
    source: "operator observation recorded after the run",
    verdict: verdict(cost.value, COST_TARGET_USD, COST_LIMIT_USD),
  };
  report.finalizedAt = new Date().toISOString();
  const evaluation = applyEvaluation(report);
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`\nFinalized ${path}\n`);
  if (evaluation.failures.length) {
    process.stderr.write(`\nBenchmark FAILED:\n- ${evaluation.failures.join("\n- ")}\n`);
    return 1;
  }
  if (evaluation.pending.length) {
    process.stderr.write(`\nBenchmark INCOMPLETE:\n- ${evaluation.pending.join("\n- ")}\n`);
    return 2;
  }
  process.stdout.write("\nBenchmark passed every declared threshold.\n");
  return 0;
}

async function main(argv) {
  if (argv.includes("finalize")) return finalizeBenchmark(argv);
  const project = resolve(requiredArgument(argv, "project"));
  const workflow = argument(argv, "workflow", "init");
  const label = argument(argv, "label", `${workflow}-benchmark`);
  const cost = parseObservedCost(argument(argv, "observed-cost-usd"));
  const cli = resolve(argument(argv, "cli", resolve(import.meta.dirname, "../packages/core/dist/cli.js")));
  const reportDirectory = resolve(argument(argv, "report-dir", resolve(import.meta.dirname, "../docs/benchmarks")));
  const artifactsDir = argument(argv, "output", ".rb");

  const workflowArguments = [
    cli, "--no-splash", workflow,
    "--project", project,
    "--provider", requiredArgument(argv, "provider"),
    "--model", requiredArgument(argv, "model"),
    "--output", artifactsDir,
  ];
  for (const [flag, name] of [["--file", "file"], ["--prompt", "prompt"], ["--effort", "effort"], ["--answers", "answers"], ["--credential", "credential"]]) {
    const value = argument(argv, name);
    if (value) workflowArguments.push(flag, value);
  }
  if (argument(argv, "answers")) workflowArguments.push("--non-interactive");

  const before = new Set(await runIds(project));
  const startedAt = new Date();
  let exitCode = 0;
  let diagnostic;
  try {
    await run(process.execPath, workflowArguments, { maxBuffer: 256 * 1024 * 1024 });
  } catch (error) {
    exitCode = typeof error.code === "number" ? error.code : 1;
    // Only the failure summary travels into the report: a provider transcript
    // can contain the request, the answers, and pasted secrets.
    diagnostic = String(error.message).split("\n")[0].slice(0, 500);
  }
  const wallSeconds = (Date.now() - startedAt.getTime()) / 1000;

  // Only a run this invocation created may be reported.
  const created = (await runIds(project)).filter((id) => !before.has(id));
  const runId = created.at(-1) ?? null;
  let state;
  let telemetry;
  if (runId) {
    const root = resolve(project, ".rb-harness/runs", runId);
    state = JSON.parse(await readFile(resolve(root, "state.json"), "utf8"));
    telemetry = await readFile(resolve(root, "telemetry.json"), "utf8")
      .then((source) => JSON.parse(source))
      .catch(() => undefined);
  } else if (!diagnostic) {
    diagnostic = "the workflow command reported success but created no Harness run";
    exitCode = exitCode || 1;
  }

  // Readiness is proven by the deterministic artifact contract of the same
  // build, not by the status the generator wrote about its own output.
  let validation;
  if (runId) {
    try {
      const verified = await run(process.execPath, [
        cli, "--no-splash", "artifacts", "verify",
        "--project", project,
        "--artifacts-dir", artifactsDir,
        "--deterministic-only",
        "--json",
      ], { maxBuffer: 64 * 1024 * 1024 });
      validation = JSON.parse(verified.stdout);
    } catch (error) {
      // `artifacts verify` exits non-zero on a failing tree and still prints
      // its report, which is exactly the evidence this benchmark needs.
      try {
        validation = JSON.parse(String(error.stdout ?? ""));
      } catch {
        validation = undefined;
        diagnostic ??= `deterministic verification could not run: ${String(error.message).split("\n")[0].slice(0, 300)}`;
      }
    }
  }

  const report = {
    contract: BENCHMARK_CONTRACT,
    label,
    recordedAt: startedAt.toISOString(),
    harnessVersion: JSON.parse(await readFile(resolve(import.meta.dirname, "../package.json"), "utf8")).version,
    commit: argument(argv, "commit", null),
    workflow,
    runId,
    status: state?.status ?? null,
    exitCode,
    ...(diagnostic ? { diagnostic } : {}),
    duration: {
      wallSeconds: Number(wallSeconds.toFixed(1)),
      targetSeconds: TIME_TARGET_SECONDS,
      limitSeconds: TIME_LIMIT_SECONDS,
      verdict: verdict(wallSeconds, TIME_TARGET_SECONDS, TIME_LIMIT_SECONDS),
      stages: telemetry?.stages ?? [],
    },
    provider: {
      // Provider and model are configuration, not secrets. Credential
      // selectors and key material never enter this report.
      name: state?.provider?.provider ?? null,
      model: state?.provider?.model || null,
      effort: state?.provider?.effort || null,
      calls: telemetry?.totals?.providerCalls ?? null,
    },
    usage: usageOrUnavailable(telemetry?.totals),
    cost: {
      observedUsd: cost.value,
      source: cost.source,
      targetUsd: COST_TARGET_USD,
      limitUsd: COST_LIMIT_USD,
      verdict: verdict(cost.value, COST_TARGET_USD, COST_LIMIT_USD),
    },
    validation: validation
      ? {
        contract: validation.contract,
        status: validation.status,
        readyForRalph: validation.readyForRalph,
        artifactCount: validation.deterministic?.artifactCount ?? null,
        readyPlanCount: validation.deterministic?.readyPlanCount ?? null,
        checks: validation.deterministic?.checks ?? [],
        findings: (validation.findings ?? []).map((finding) => ({
          id: finding.id,
          severity: finding.severity,
          criterion: finding.criterion,
        })),
        reportPath: validation.reportPath ?? null,
      }
      : null,
    artifacts: {
      directory: artifactsDir,
      documents: state?.bundle?.documents ?? null,
      structuralRepairs: state?.repairsUsed ?? null,
      interviewRounds: state?.interviewRound ?? null,
      answers: state?.answers?.length ?? null,
    },
  };

  const evaluation = applyEvaluation(report);

  await mkdir(reportDirectory, { recursive: true });
  const path = resolve(
    reportDirectory,
    `${startedAt.toISOString().replace(/[-:T.]/g, "").slice(0, 14)}-${label}.json`,
  );
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`\nBenchmark report written to ${path}\n`);
  if (!report.usage.measured) {
    process.stdout.write("This provider reported no usage; tokens and cache are recorded as unmeasured and no cost was invented.\n");
  }
  if (evaluation.failures.length) {
    process.stderr.write(`\nBenchmark FAILED:\n- ${evaluation.failures.join("\n- ")}\n`);
    return 1;
  }
  if (evaluation.pending.length) {
    // Not a failure and emphatically not an approval: the run met every
    // criterion that could be checked, and one still cannot.
    process.stderr.write(`\nBenchmark INCOMPLETE:\n- ${evaluation.pending.join("\n- ")}\n`);
    return 2;
  }
  process.stdout.write("\nBenchmark passed every declared threshold.\n");
  return 0;
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith("benchmark.mjs");
if (invokedDirectly) {
  main(process.argv).then(
    (code) => { process.exitCode = code; },
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
