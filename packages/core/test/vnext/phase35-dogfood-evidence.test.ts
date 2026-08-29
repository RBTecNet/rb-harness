import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateExecutionMarkdown } from "../../src/execution-contract.js";
import { loadManifest, validateManifestTree, validateManifestValue } from "../../src/manifest.js";
import { selectReadyExecutionPlan } from "../../src/vnext/ralph-fidelity.js";
import {
  containsCodeOwnedMachineIdentity,
  modelFacingRecoveryContext,
  modelFacingRecoveryFindings,
} from "../../src/vnext/recovery-findings.js";

const EVIDENCE_ROOT = fileURLToPath(new URL("./dogfood-evidence/cron-facility/", import.meta.url));
const LITERAL_FAILURE_ROOT = fileURLToPath(new URL("./dogfood-evidence/cron-facility-literal-request/", import.meta.url));
const PRECISE_FINDINGS_FAILURE_ROOT = fileURLToPath(new URL("./dogfood-evidence/cron-facility-literal-request-precise-findings/", import.meta.url));
const RULE_LEDGER_SUCCESS_ROOT = fileURLToPath(new URL("./dogfood-evidence/cron-facility-literal-request-rule-ledger-success/", import.meta.url));

async function files(root: string, relative = ""): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(resolve(root, relative), { withFileTypes: true })) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await files(root, path));
    else result.push(path);
  }
  return result.sort();
}

describe("installed CLI cron_facility dogfood evidence", () => {
  it("revalidates the persisted artifact bytes and headless recommendation evidence offline", async () => {
    const summary = JSON.parse(await readFile(resolve(EVIDENCE_ROOT, "dogfood-summary.json"), "utf8")) as any;
    expect(summary).toMatchObject({
      sourceProject: "cron_facility",
      selectedProfileId: "anthropic:claude-code-cli:claude-opus-5",
      transport: "claude-code-cli",
      requestAccounting: "opaque",
      terminalState: "published",
      ralph: { status: "READY" },
    });
    expect(summary.questions).toHaveLength(3);
    expect(summary.questions.every((question: any) => question.acceptanceMode === "non-interactive-policy"
      && question.selectedValue === question.recommendedValue)).toBe(true);
    expect(await files(resolve(EVIDENCE_ROOT, ".rb"))).toEqual(["init/BRIEF.md", "init/PHASES.md", "rb-manifest.json"]);

    const manifest = await loadManifest(EVIDENCE_ROOT);
    expect(validateManifestValue(manifest)).toMatchObject({ valid: true, issues: [] });
    expect(await validateManifestTree(EVIDENCE_ROOT)).toMatchObject({ valid: true, issues: [] });
    const phases = await readFile(resolve(EVIDENCE_ROOT, ".rb/init/PHASES.md"), "utf8");
    const validation = validateExecutionMarkdown(phases);
    expect(validation).toMatchObject({ valid: true, issues: [] });
    expect(selectReadyExecutionPlan(manifest, phases).status).toBe("ready");
    const tasks = validation.document!.phases.flatMap((phase) => phase.tasks);
    expect(tasks).toHaveLength(8);
    expect(tasks.every((task) => task.scope.trim() && task.change.trim()
      && task.acceptanceCriteria.length && task.validation.length && task.expectedEvidence.trim())).toBe(true);
  });

  it("is secret-safe, home-path-free, and never imported by production", async () => {
    for (const root of [EVIDENCE_ROOT, LITERAL_FAILURE_ROOT, PRECISE_FINDINGS_FAILURE_ROOT, RULE_LEDGER_SUCCESS_ROOT]) {
      for (const path of await files(root)) {
        const source = await readFile(resolve(root, path), "utf8");
        expect(source, path).not.toMatch(/(?:sk-ant-|x-api-key|authorization\s*:|oauth[_ -]?token|provider-vault-key|provider-credentials\.json|\/home\/[^\s"']+)/i);
      }
    }
    const sourceRoot = fileURLToPath(new URL("../../src/", import.meta.url));
    for (const path of await files(sourceRoot)) {
      if (!path.endsWith(".ts")) continue;
      expect(await readFile(resolve(sourceRoot, path), "utf8"), path).not.toContain("dogfood-evidence/cron-facility");
    }
  });

  it("preserves the exact literal-request bounded failure and complete attempt history", async () => {
    const evidence = JSON.parse(await readFile(resolve(LITERAL_FAILURE_ROOT, "run-evidence.json"), "utf8")) as any;
    expect(evidence.originalRequest).toBe("Crie um projeto web em nodejs e typescript para facilitar o uso de contrab no linux, a interface deverá ser divida em 2 abras onde a primeira aba deverá conter um campo para o usuario digitar uma linha cron existente e o sistema devolver o que aquela linha faz, e a segunda aba deveremos ter uma caixa de texto para o usuario digitar um prompt solicitando a um modelo de ia que informe a linha do cron para o agendamento da forma que foi solicitado por ele, o prompt deve retornar a linha inteira e a explicação de cada campo da linha cron, o modelo de ia deverá ser configurado por arquivos de variaves .env onde as variaveis deverão ser: AI_BASE_URL,AI_API_KEY,AI_MODEL,AI_TIMEOUT_MS,AI_TEMPERATURE,AI_MAX_OUTPUT_TOKENS");
    expect(evidence).toMatchObject({
      selectedProfileId: "anthropic:claude-code-cli:claude-opus-5",
      requestAccounting: "opaque",
      terminalState: "failed",
      failureKind: "semantic-invalid-after-recovery",
      publicationOccurred: false,
      counters: {
        semanticOperations: 4,
        transportInvocations: 4,
        correctiveRegenerations: 2,
        correctiveBySlice: { intent: 1, work: 1 },
      },
      remediationObservation: { machineIdentityKeyFailureRecurred: false },
    });
    expect(evidence.questions).toHaveLength(3);
    expect(evidence.questions.every((question: any) => question.acceptanceMode === "non-interactive-policy"
      && question.selectedValue === question.recommendedValue)).toBe(true);
    expect(evidence.attempts.map((attempt: any) => [attempt.slice, attempt.corrective, attempt.status])).toEqual([
      ["intent", false, "semantic-invalid"],
      ["intent", true, "accepted"],
      ["work", false, "semantic-invalid"],
      ["work", true, "semantic-invalid"],
    ]);
    expect(evidence.artifactTree).toEqual([]);
  });

  it("preserves the precise-finding rerun and re-derives sanitized rule identity without rewriting historical guidance", async () => {
    const evidence = JSON.parse(await readFile(resolve(PRECISE_FINDINGS_FAILURE_ROOT, "run-evidence.json"), "utf8")) as any;
    expect(evidence).toMatchObject({
      runId: "vnext-6a27e7ed-7c1c-4147-94e3-47a4ec24d17a",
      selectedProfileId: "anthropic:claude-code-cli:claude-opus-5",
      requestAccounting: "opaque",
      terminalState: "failed",
      publicationOccurred: false,
      counters: {
        semanticOperations: 4,
        transportInvocations: 4,
        transportRetries: 0,
        correctiveRegenerations: 2,
        correctiveBySlice: { intent: 1, work: 1 },
      },
      remediationObservation: {
        aggregateTaskCompletenessFindingRecurred: false,
        machineIdentityKeyFailureRecurred: false,
        taskStructureSchemaWasActive: true,
      },
    });
    expect(evidence.questions).toHaveLength(3);
    expect(evidence.questions.every((question: any) => question.acceptanceMode === "non-interactive-policy"
      && question.selectedValue === question.recommendedValue)).toBe(true);
    expect(evidence.attempts.map((attempt: any) => [attempt.slice, attempt.corrective, attempt.status])).toEqual([
      ["intent", false, "semantic-invalid"],
      ["intent", true, "accepted"],
      ["work", false, "semantic-invalid"],
      ["work", true, "semantic-invalid"],
    ]);
    for (const attempt of evidence.attempts.filter((entry: any) => entry.status === "semantic-invalid")) {
      const currentProjection = modelFacingRecoveryFindings(attempt.findings);
      expect(attempt.modelFacingFindings.map((finding: any) => ({ code: finding.code, pointer: finding.pointer })))
        .toEqual(currentProjection.map((finding) => ({ code: finding.code, pointer: finding.pointer })));
      expect(attempt.modelFacingFindings.every((finding: any) => typeof finding.message === "string" && finding.message.length > 0)).toBe(true);
      expect(containsCodeOwnedMachineIdentity(JSON.stringify(attempt.modelFacingFindings))).toBe(false);
    }
    expect(evidence.attempts[2].modelFacingFindingsUsedForCorrection).toBe(true);
    expect(evidence.attempts[3]).toMatchObject({
      modelFacingFindingsUsedForCorrection: false,
      findings: [{ pointer: "/phases/3/tasks/0/acceptance/3" }],
    });
    expect(evidence.artifactTree).toEqual([]);
  });

  it("revalidates the exact literal-request rule-ledger success and recovery context offline", async () => {
    const summary = JSON.parse(await readFile(resolve(RULE_LEDGER_SUCCESS_ROOT, "dogfood-summary.json"), "utf8")) as any;
    expect(summary).toMatchObject({
      runId: "vnext-8729f300-03ac-467c-b7bc-1b7727114c09",
      selectedProfileId: "anthropic:claude-code-cli:claude-opus-5",
      requestAccounting: "opaque",
      terminalState: "published",
      publicationOccurred: true,
      semanticResult: { requirements: 9, phases: 3, tasks: 6 },
      counters: {
        semanticOperations: 4,
        transportInvocations: 4,
        transportRetries: 0,
        correctiveRegenerations: 2,
        correctiveBySlice: { intent: 1, work: 1 },
      },
      ralph: { status: "READY", executionContractIssues: 0, readyExecutionPlans: 1, artifactHashesMatch: true },
    });
    expect(summary.questions).toHaveLength(3);
    expect(summary.questions.every((question: any) => question.acceptanceMode === "non-interactive-policy"
      && question.selectedValue === question.recommendedValue)).toBe(true);
    expect(summary.attempts.map((attempt: any) => [attempt.slice, attempt.corrective, attempt.status])).toEqual([
      ["intent", false, "semantic-invalid"],
      ["intent", true, "accepted"],
      ["work", false, "semantic-invalid"],
      ["work", true, "accepted"],
    ]);
    for (const attempt of summary.attempts.filter((entry: any) => entry.recovery)) {
      const current = modelFacingRecoveryContext(attempt.findings);
      expect(attempt.recovery.violatedRules.map((entry: any) => entry.rule))
        .toEqual(current.violatedRules.map((entry) => entry.rule));
      expect(attempt.recovery.specificPreviousFindings.map((finding: any) => ({
        code: finding.code,
        pointer: finding.pointer,
        rule: finding.rule,
      }))).toEqual(current.specificPreviousFindings.map((finding) => ({
        code: finding.code,
        pointer: finding.pointer,
        rule: finding.rule,
      })));
      expect(containsCodeOwnedMachineIdentity(JSON.stringify(attempt.recovery))).toBe(false);
    }
    expect(summary.attempts[2].recovery.violatedRules.map((entry: any) => entry.rule)).toEqual([
      "acceptance-no-visual-only",
      "validation-command-executable",
    ]);
    expect(summary.attempts[2].recovery.specificPreviousFindings).toHaveLength(4);
    expect(await files(resolve(RULE_LEDGER_SUCCESS_ROOT, ".rb"))).toEqual(["init/BRIEF.md", "init/PHASES.md", "rb-manifest.json"]);

    const manifest = await loadManifest(RULE_LEDGER_SUCCESS_ROOT);
    expect(validateManifestValue(manifest)).toMatchObject({ valid: true, issues: [] });
    expect(await validateManifestTree(RULE_LEDGER_SUCCESS_ROOT)).toMatchObject({ valid: true, issues: [] });
    const phases = await readFile(resolve(RULE_LEDGER_SUCCESS_ROOT, ".rb/init/PHASES.md"), "utf8");
    const validation = validateExecutionMarkdown(phases);
    expect(validation).toMatchObject({ valid: true, issues: [] });
    expect(selectReadyExecutionPlan(manifest, phases).status).toBe("ready");
    expect(validation.document!.phases).toHaveLength(3);
    expect(validation.document!.phases.flatMap((phase) => phase.tasks)).toHaveLength(6);
  });
});
