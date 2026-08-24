/**
 * CR-002 · the benchmark script must be trustworthy without ever being run
 * against a paid provider.
 *
 * Every case below uses a local fake CLI. No network, no authentication, no
 * cost. The real `cron2` benchmark is an operator decision and is never
 * triggered from a test.
 */

import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const script = resolve(process.cwd(), "../../scripts/benchmark.mjs");
const fakeCli = resolve(process.cwd(), "test/fixtures/benchmark/fake-cli.mjs");

interface BenchmarkOutcome {
  code: number;
  report: Record<string, unknown>;
  reportDirectory: string;
  reportFiles: string[];
  stderr: string;
}

async function benchmark(
  mode: string,
  extra: string[] = [],
): Promise<BenchmarkOutcome> {
  const project = await mkdtemp(resolve(tmpdir(), "rb-benchmark-"));
  const reportDirectory = resolve(project, "reports");
  await chmod(fakeCli, 0o755);
  const argv = [
    script,
    "--project", project,
    "--workflow", "plan",
    "--provider", "opencode",
    "--model", "opencode-go/deepseek-v4-pro",
    "--prompt", "Plan a bounded change.",
    "--cli", fakeCli,
    "--report-dir", reportDirectory,
    "--label", "fixture",
    ...extra,
  ];
  let code = 0;
  let stdout = "";
  let stderr = "";
  try {
    const result = await run(process.execPath, argv, {
      env: { ...process.env, RB_BENCH_MODE: mode },
      maxBuffer: 32 * 1024 * 1024,
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    code = failure.code ?? 1;
    stdout = failure.stdout ?? "";
    stderr = failure.stderr ?? "";
  }
  const reportFiles = await readdir(reportDirectory).catch(() => []);
  const report = reportFiles.length
    ? JSON.parse(await readFile(resolve(reportDirectory, reportFiles[0]!), "utf8")) as Record<string, unknown>
    : JSON.parse(stdout.slice(stdout.indexOf("{"), stdout.lastIndexOf("}") + 1)) as Record<string, unknown>;
  return { code, report, reportDirectory, reportFiles, stderr };
}

describe("CR-002 · benchmark reliability", () => {
  it("passes and records evidence for a complete, verified run", async () => {
    const outcome = await benchmark("complete", ["--observed-cost-usd", "0.22", "--commit", "abc1234"]);
    expect(outcome.code).toBe(0);
    expect(outcome.report).toMatchObject({
      contract: "rb-harness-benchmark/v1",
      result: "passed",
      passed: true,
      commit: "abc1234",
      status: "complete",
    });
    expect(outcome.report.runId).toMatch(/^plan-fixture-/);
    expect((outcome.report.validation as Record<string, unknown>).readyForRalph).toBe(true);
    expect((outcome.report.cost as Record<string, unknown>).verdict).toBe("target");
    expect(outcome.reportFiles).toHaveLength(1);
  }, 30_000);

  it("fails when generation fails and still writes a report", async () => {
    const outcome = await benchmark("generation-fail");
    expect(outcome.code).not.toBe(0);
    expect(outcome.report.passed).toBe(false);
    expect(outcome.report.runId).toBeNull();
    expect(outcome.reportFiles).toHaveLength(1);
    expect(String(outcome.report.diagnostic)).toContain("Command failed");
    expect(outcome.stderr).toContain("Benchmark FAILED");
  }, 30_000);

  it("refuses to reuse an older run when this invocation creates none", async () => {
    const project = await mkdtemp(resolve(tmpdir(), "rb-benchmark-stale-"));
    const previous = resolve(project, ".rb-harness/runs/plan-earlier-success");
    await mkdir(previous, { recursive: true });
    await writeFile(resolve(previous, "state.json"), `${JSON.stringify({
      contract: "rb-harness-run/v1",
      id: "plan-earlier-success",
      status: "complete",
      artifactDirectory: ".rb",
      provider: { provider: "opencode", model: "opencode-go/deepseek-v4-pro" },
      answers: [],
    })}\n`, "utf8");
    const reportDirectory = resolve(project, "reports");
    await chmod(fakeCli, 0o755);
    let code = 0;
    let stdout = "";
    try {
      stdout = (await run(process.execPath, [
        script,
        "--project", project,
        "--workflow", "plan",
        "--provider", "opencode",
        "--model", "opencode-go/deepseek-v4-pro",
        "--prompt", "Plan a bounded change.",
        "--cli", fakeCli,
        "--report-dir", reportDirectory,
      ], { env: { ...process.env, RB_BENCH_MODE: "no-run" }, maxBuffer: 32 * 1024 * 1024 })).stdout;
    } catch (error) {
      const failure = error as { code?: number; stdout?: string };
      code = failure.code ?? 1;
      stdout = failure.stdout ?? "";
    }
    expect(code).not.toBe(0);
    const report = JSON.parse(await readFile(
      resolve(reportDirectory, (await readdir(reportDirectory))[0]!),
      "utf8",
    )) as Record<string, unknown>;
    // The earlier successful run must not be adopted as this run's result.
    expect(report.runId).toBeNull();
    expect(report.passed).toBe(false);
    expect(String(JSON.stringify(report.failures))).toContain("no new Harness run");
    expect(JSON.stringify(report)).not.toContain("plan-earlier-success");
  }, 30_000);

  it("fails when the run did not complete", async () => {
    const outcome = await benchmark("incomplete");
    expect(outcome.code).not.toBe(0);
    expect(JSON.stringify(outcome.report.failures)).toContain("generation-failed");
  }, 30_000);

  it("fails when deterministic verification rejects the tree", async () => {
    const outcome = await benchmark("invalid-tree");
    expect(outcome.code).not.toBe(0);
    expect((outcome.report.validation as Record<string, unknown>).readyForRalph).toBe(false);
    expect(JSON.stringify(outcome.report.failures)).toContain("not report Ralph-ready");
    // Readiness comes from the contract, never from the run's own status.
    expect(outcome.report.status).toBe("complete");
  }, 30_000);

  it("fails when the run exceeds the acceptance limits", async () => {
    const outcome = await benchmark("complete", ["--observed-cost-usd", "1.84"]);
    expect(outcome.code).not.toBe(0);
    expect((outcome.report.cost as Record<string, unknown>).verdict).toBe("exceeded");
    expect(JSON.stringify(outcome.report.failures)).toContain("exceeded the US$ 0.4");
  }, 30_000);

  it("rejects a cost that is not a finite non-negative number", async () => {
    for (const value of ["abc", "-1", "NaN", "Infinity"]) {
      await expect(benchmark("complete", ["--observed-cost-usd", value]))
        .rejects.toThrow();
    }
  }, 30_000);

  it("records a missing metric as unavailable instead of zero", async () => {
    const outcome = await benchmark("complete");
    const usage = outcome.report.usage as Record<string, unknown>;
    const cost = outcome.report.cost as Record<string, unknown>;
    // `complete` reports measured:false in its telemetry fixture.
    expect(usage.measured).toBe(false);
    expect(usage.reason).toContain("unmeasured");
    expect(usage.totalTokens).toBeUndefined();
    expect(cost.observedUsd).toBeNull();
    expect(cost.verdict).toBe("unavailable");
    expect(cost.source).toContain("not supplied");
  }, 30_000);

  it("never approves a run whose cost was never observed", async () => {
    const outcome = await benchmark("complete");
    // Everything checkable passed, but cost is an acceptance criterion and is
    // still unverified: that is incomplete, not approved.
    expect(outcome.report.result).toBe("incomplete");
    expect(outcome.report.passed).toBe(false);
    expect(outcome.report.failures).toBeUndefined();
    expect(String(JSON.stringify(outcome.report.pending))).toContain("cost is an acceptance criterion");
    expect(outcome.code).toBe(2);
    expect(outcome.stderr).toContain("Benchmark INCOMPLETE");
  }, 30_000);

  it("finalizes the same report with the observed cost and no provider call", async () => {
    const outcome = await benchmark("complete");
    expect(outcome.report.result).toBe("incomplete");
    const reportPath = resolve(outcome.reportDirectory, outcome.reportFiles[0]!);
    const modes = resolve(outcome.reportDirectory, "..", "provider-modes.log");

    const finalized = await run(process.execPath, [
      script, "finalize", "--report", reportPath, "--observed-cost-usd", "0.24",
    ], { env: { ...process.env, RB_HARNESS_TEST_PROVIDER_MODE_FILE: modes }, maxBuffer: 32 * 1024 * 1024 });
    expect(finalized.stdout).toContain("Finalized");

    const updated = JSON.parse(await readFile(reportPath, "utf8")) as Record<string, unknown>;
    // The same file, same run ID, now approved.
    expect(updated.runId).toBe(outcome.report.runId);
    expect(updated.result).toBe("passed");
    expect(updated.passed).toBe(true);
    expect(updated.pending).toBeUndefined();
    expect(updated.finalizedAt).toBeTruthy();
    expect((updated.cost as Record<string, unknown>).observedUsd).toBe(0.24);
    expect((updated.cost as Record<string, unknown>).source).toContain("after the run");
    // No provider was started by the finalization.
    await expect(readFile(modes, "utf8")).rejects.toThrow();
    expect(await readdir(outcome.reportDirectory)).toHaveLength(1);
  }, 30_000);

  it("finalizing with an over-limit cost fails instead of approving", async () => {
    const outcome = await benchmark("complete");
    const reportPath = resolve(outcome.reportDirectory, outcome.reportFiles[0]!);
    await expect(run(process.execPath, [
      script, "finalize", "--report", reportPath, "--observed-cost-usd", "1.84",
    ])).rejects.toThrow();
    const updated = JSON.parse(await readFile(reportPath, "utf8")) as Record<string, unknown>;
    expect(updated.result).toBe("failed");
    expect(updated.passed).toBe(false);
    expect(String(JSON.stringify(updated.failures))).toContain("exceeded the US$ 0.4");
  }, 30_000);

  it("refuses to finalize a file that is not a benchmark report", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "rb-benchmark-alien-"));
    const alien = resolve(directory, "report.json");
    await writeFile(alien, '{"contract":"something-else/v1"}\n', "utf8");
    await expect(run(process.execPath, [
      script, "finalize", "--report", alien, "--observed-cost-usd", "0.2",
    ])).rejects.toThrow();
  }, 30_000);

  it("never writes credentials, prompts, or answers into the report", async () => {
    const outcome = await benchmark("complete", [
      "--credential", "deepseek:producao-secreta",
      "--observed-cost-usd", "0.2",
    ]);
    const serialized = JSON.stringify(outcome.report);
    expect(serialized).not.toContain("producao-secreta");
    expect(serialized).not.toContain("Plan a bounded change.");
    expect(serialized).not.toContain("--credential");
  }, 30_000);
});
