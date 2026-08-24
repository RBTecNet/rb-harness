#!/usr/bin/env node
/**
 * A stand-in for the installed `rb-harness` executable, used to prove the
 * benchmark script's control flow without a paid provider call. Behaviour is
 * selected by RB_BENCH_MODE:
 *
 *   complete        — creates a fresh run and verifies Ralph-ready
 *   generation-fail — exits non-zero and creates no run
 *   no-run          — exits zero but creates no run
 *   incomplete      — creates a run left in generation-failed
 *   invalid-tree    — creates a complete run whose verification fails
 *   slow            — a complete run whose recorded duration exceeds the limit
 */
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const argv = process.argv.slice(2);
const mode = process.env.RB_BENCH_MODE ?? "complete";
const option = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const project = resolve(option("--project") ?? ".");
const verifying = argv.includes("verify");

if (verifying) {
  const ready = mode !== "invalid-tree";
  process.stdout.write(`${JSON.stringify({
    contract: "rb-harness-artifact-verification/v1",
    status: ready ? "pass" : "fail",
    readyForRalph: ready,
    deterministic: {
      passed: ready,
      checks: ["manifest-schema", "artifact-hashes", "execution-contracts"],
      artifactCount: ready ? 4 : 2,
      readyPlanCount: ready ? 1 : 0,
    },
    findings: ready ? [] : [{ id: "readiness.ready-plan-missing", severity: "blocker", criterion: "ralph-ready-plan" }],
    reportPath: resolve(project, ".rb-harness/verifications/fixture/report.json"),
  }, null, 2)}\n`);
  process.exit(ready ? 0 : 2);
}

if (mode === "generation-fail") {
  process.stderr.write("ERROR: provider could not satisfy the document bundle protocol\n");
  process.exit(1);
}
if (mode === "no-run") {
  process.stdout.write("nothing happened\n");
  process.exit(0);
}

const runsRoot = resolve(project, ".rb-harness/runs");
await mkdir(runsRoot, { recursive: true });
const existing = await readdir(runsRoot).catch(() => []);
const id = `plan-fixture-${String(existing.length + 1).padStart(3, "0")}`;
const root = resolve(runsRoot, id);
await mkdir(root, { recursive: true });
await writeFile(resolve(root, "state.json"), `${JSON.stringify({
  contract: "rb-harness-run/v1",
  id,
  workflow: option("--workflow") ?? "plan",
  status: mode === "incomplete" ? "generation-failed" : "complete",
  artifactDirectory: option("--output") ?? ".rb",
  provider: { provider: option("--provider"), model: option("--model"), effort: "high" },
  answers: [],
  interviewRound: 1,
  repairsUsed: 0,
  bundle: { contract: "rb-harness-documents/v1", documents: 4 },
}, null, 2)}\n`, "utf8");
await writeFile(resolve(root, "telemetry.json"), `${JSON.stringify({
  contract: "rb-harness-telemetry/v1",
  durationMilliseconds: mode === "slow" ? 25 * 60 * 1000 : 120_000,
  stages: [{ stage: "generation", durationMilliseconds: 90_000, entries: 1 }],
  providerCalls: [],
  totals: {
    measured: mode !== "complete",
    providerCalls: 2,
    requests: 3,
    inputTokens: 1000,
    cachedInputTokens: 800,
    cacheCreationInputTokens: 0,
    outputTokens: 200,
    totalTokens: 1200,
    toolCalls: 4,
  },
}, null, 2)}\n`, "utf8");
process.stdout.write(`published ${id}\n`);
