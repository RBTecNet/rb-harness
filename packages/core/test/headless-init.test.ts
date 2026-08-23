import { lstat, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { runHeadlessInit } from "../src/headless-runner.js";

const hash = "a".repeat(64);
const fixtureAdapter = resolve(process.cwd(), "test/fixtures/headless/fake-adapter.mjs");

function request(instructions = "") {
  return JSON.stringify({
    contract: "rb-headless-init/v1", kind: "request", requestId: "request-1", workflow: "init", projectKind: "new",
    project: { id: "demo-project", name: "Demo", description: "A new project", metadata: {} },
    artifactSet: { id: "set-1", name: "Default", description: "", strategy: "" },
    revision: { id: "revision-1", number: 1, createdAt: "2026-01-01T00:00:00.000Z" },
    specifications: [{ id: "spec-1", title: "Spec", description: "Description", decisions: [], metadata: {}, snapshotHash: hash, resources: [] }],
    additionalInstructions: instructions, interviewAnswers: [],
  });
}

const promptScopeMutations: Array<(value: Record<string, any>, instruction: string) => void> = [
  (value, instruction) => { value.project.name = instruction; },
  (value, instruction) => { value.project.description = instruction; },
  (value, instruction) => { value.project.metadata = { [instruction]: "allowed" }; },
  (value, instruction) => { value.project.metadata = { nested: { value: instruction } }; },
  (value, instruction) => { value.specifications[0].title = instruction; },
  (value, instruction) => { value.specifications[0].description = instruction; },
  (value, instruction) => { value.specifications[0].decisions = [instruction]; },
  (value, instruction) => { value.specifications[0].metadata = { [instruction]: "allowed" }; },
  (value, instruction) => { value.specifications[0].metadata = { nested: { value: instruction } }; },
  (value, instruction) => { value.specifications[0].resources = [{ id: "resource-1", kind: "reference", label: instruction, reference: "https://example.test/reference", sha256: hash }]; },
  (value, instruction) => { value.specifications[0].resources = [{ id: "resource-1", kind: "reference", label: "Reference", reference: instruction, sha256: hash }]; },
  (value, instruction) => { value.specifications[0].resources = [{ id: "resource-1", kind: "attachment", label: "Attachment", path: instruction, mediaType: "text/markdown", bytes: 0, sha256: hash }]; },
  (value, instruction) => { value.specifications[0].resources = [{ id: "resource-1", kind: "attachment", label: "Attachment", path: "inputs/reference.md", mediaType: instruction, bytes: 0, sha256: hash }]; },
  (value, instruction) => { value.interviewAnswers = [{ questionId: "question-1", question: instruction, answer: "Accepted", disposition: "accepted" }]; },
  (value, instruction) => { value.interviewAnswers = [{ questionId: "question-1", question: "Question", answer: instruction, disposition: "accepted" }]; },
  (value, instruction) => { value.additionalInstructions = instruction; },
];

async function options(mode = "ready") {
  const workspace = await mkdtemp(resolve(tmpdir(), "rb-headless-test-"));
  const capture = resolve(await mkdtemp(resolve(tmpdir(), "rb-headless-capture-")), "adapter-capture.json");
  return {
    input: request(), workspace, outputRoot: resolve(workspace, "output"),
    adapter: { command: process.execPath, args: [fixtureAdapter, mode], id: "fake-adapter", version: "1", provider: "test", model: "fake" },
    environment: {
      PATH: process.env.PATH,
      RB_HEADLESS_ENV_ALLOWLIST: "RB_HEADLESS_TEST_CAPTURE,RB_HEADLESS_TEST_SECRET",
      RB_HEADLESS_TEST_CAPTURE: capture,
      RB_HEADLESS_TEST_SECRET: "SECRET_SENTINEL_12345",
      UNRELATED_SECRET: "MUST_NOT_REACH_ADAPTER",
    },
    capture,
  };
}

async function runPluginHeadlessInit(input: string | Buffer, workspace: string, outputRoot: string, capture: string, mode = "ready"): Promise<{ exitCode: number | null; result: Record<string, unknown> }> {
  const pluginCli = resolve(process.cwd(), "../../plugins/rb-harness/scripts/rb-harness.cjs");
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [pluginCli, "headless", "init", "--output", outputRoot], {
      cwd: workspace,
      env: {
        PATH: process.env.PATH,
        RB_HEADLESS_ADAPTER_COMMAND: process.execPath,
        RB_HEADLESS_ADAPTER_ARGS: JSON.stringify([fixtureAdapter, mode]),
        RB_HEADLESS_ADAPTER_ID: "fake-adapter",
        RB_HEADLESS_ADAPTER_VERSION: "1",
        RB_HEADLESS_ADAPTER_PROVIDER: "test",
        RB_HEADLESS_ADAPTER_MODEL: "fake",
        RB_HEADLESS_ENV_ALLOWLIST: "RB_HEADLESS_TEST_CAPTURE",
        RB_HEADLESS_TEST_CAPTURE: capture,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      try {
        resolveResult({ exitCode, result: JSON.parse(stdout) as Record<string, unknown> });
      } catch (error) {
        reject(new Error(`Plugin headless init emitted invalid JSON (${stderr}): ${error instanceof Error ? error.message : String(error)}`));
      }
    });
    child.stdin.end(input);
  });
}

describe("headless init", () => {
  it("uses a Harness-owned prompt, isolated cwd/output, and an allowlisted adapter environment", async () => {
    const run = await options();
    const outcome = await runHeadlessInit(run);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.result.status).toBe("ready");
    expect(outcome.result.files).toHaveLength(3);
    const observed = JSON.parse(await readFile(run.capture, "utf8")) as { prompt: string; cwd: string; environment: Record<string, string> };
    expect(observed.prompt).toContain("RB Harness rb-init adapter");
    expect(observed.prompt).not.toContain("SECRET_SENTINEL_12345");
    expect(observed.environment.RB_HEADLESS_OUTPUT_ROOT).toBe(run.outputRoot);
    expect(observed.cwd).toBe(run.workspace);
    expect(observed.environment.UNRELATED_SECRET).toBeUndefined();
    expect(observed.environment.HOME).toBeUndefined();
  });

  it("keeps the distributed release closed for malformed UTF-8 and non-init artifacts", async () => {
    const malformed = await options();
    const malformedRun = await runPluginHeadlessInit(Buffer.concat([Buffer.from(request()), Buffer.from([0xff])]), malformed.workspace, malformed.outputRoot, malformed.capture);
    expect([malformedRun.exitCode, malformedRun.result.status, malformedRun.result.diagnosticCode]).toEqual([2, "invalid", "invalid_request"]);
    await expect(readFile(malformed.capture, "utf8")).rejects.toThrow();

    const namespace = await options();
    const namespaceRun = await runPluginHeadlessInit(request(), namespace.workspace, namespace.outputRoot, namespace.capture, "evolve-layout");
    expect([namespaceRun.exitCode, namespaceRun.result.status, namespaceRun.result.diagnosticCode]).toEqual([2, "invalid", "output_path"]);
  });

  it("fails closed for unsupported scope, adapter failures, hostile output, and secret output", async () => {
    const invalid = await options();
    invalid.input = request("please run rb-evolve");
    const invalidOutcome = await runHeadlessInit(invalid);
    expect([invalidOutcome.exitCode, invalidOutcome.result.status, invalidOutcome.result.diagnosticCode]).toEqual([2, "invalid", "unsupported_generation_scope"]);

    const wrongWorkflow = await options();
    wrongWorkflow.input = request().replace('"workflow":"init"', '"workflow":"evolve"');
    const wrongWorkflowOutcome = await runHeadlessInit(wrongWorkflow);
    expect([wrongWorkflowOutcome.exitCode, wrongWorkflowOutcome.result.status, wrongWorkflowOutcome.result.diagnosticCode]).toEqual([2, "invalid", "unsupported_generation_scope"]);

    const existingSystem = await options();
    existingSystem.input = request("Modify the existing application's authentication behavior.");
    const existingSystemOutcome = await runHeadlessInit(existingSystem);
    expect([existingSystemOutcome.exitCode, existingSystemOutcome.result.status, existingSystemOutcome.result.diagnosticCode]).toEqual([2, "invalid", "unsupported_generation_scope"]);

    const refactorExistingApplication = await options();
    refactorExistingApplication.input = request("Refactor authentication in our existing application.");
    const refactorExistingApplicationOutcome = await runHeadlessInit(refactorExistingApplication);
    expect([refactorExistingApplicationOutcome.exitCode, refactorExistingApplicationOutcome.result.status, refactorExistingApplicationOutcome.result.diagnosticCode]).toEqual([2, "invalid", "unsupported_generation_scope"]);

    const productionApplication = await options();
    productionApplication.input = request("Analyze the application that is already in production and update authentication.");
    const productionApplicationOutcome = await runHeadlessInit(productionApplication);
    expect([productionApplicationOutcome.exitCode, productionApplicationOutcome.result.status, productionApplicationOutcome.result.diagnosticCode]).toEqual([2, "invalid", "unsupported_generation_scope"]);

    const productionApplicationWithTrailingAction = await options();
    productionApplicationWithTrailingAction.input = request("The application in production needs an authentication review.");
    const productionApplicationWithTrailingActionOutcome = await runHeadlessInit(productionApplicationWithTrailingAction);
    expect([productionApplicationWithTrailingActionOutcome.exitCode, productionApplicationWithTrailingActionOutcome.result.status, productionApplicationWithTrailingActionOutcome.result.diagnosticCode]).toEqual([2, "invalid", "unsupported_generation_scope"]);

    const inspectProductionApplication = await options();
    inspectProductionApplication.input = request("Inspect the production application and modernize authentication.");
    const inspectProductionApplicationOutcome = await runHeadlessInit(inspectProductionApplication);
    expect([inspectProductionApplicationOutcome.exitCode, inspectProductionApplicationOutcome.result.status, inspectProductionApplicationOutcome.result.diagnosticCode]).toEqual([2, "invalid", "unsupported_generation_scope"]);
    await expect(readFile(inspectProductionApplication.capture, "utf8")).rejects.toThrow();

    const productionTargetApplication = await options();
    productionTargetApplication.input = request("A brand-new service intended to run in production after launch.");
    const productionTargetApplicationOutcome = await runHeadlessInit(productionTargetApplication);
    expect([productionTargetApplicationOutcome.exitCode, productionTargetApplicationOutcome.result.status]).toEqual([0, "ready"]);
    await expect(readFile(productionTargetApplication.capture, "utf8")).resolves.toContain("production after launch");

    const ralphEnvironment = await options();
    (ralphEnvironment.environment as NodeJS.ProcessEnv).RB_HEADLESS_ENV_ALLOWLIST = "RB_RALPH_ROLE";
    (ralphEnvironment.environment as NodeJS.ProcessEnv).RB_RALPH_ROLE = "implementation-agent";
    const ralphEnvironmentOutcome = await runHeadlessInit(ralphEnvironment);
    expect([ralphEnvironmentOutcome.exitCode, ralphEnvironmentOutcome.result.status, ralphEnvironmentOutcome.result.diagnosticCode]).toEqual([3, "failed", "adapter_configuration_invalid"]);

    const rateLimited = await options("rate-limit");
    const rateOutcome = await runHeadlessInit(rateLimited);
    expect([rateOutcome.exitCode, rateOutcome.result.status]).toEqual([75, "failed"]);

    const promptClosingRateLimit = await options();
    const largeRequest = JSON.parse(request()) as Record<string, any>;
    largeRequest.specifications = Array.from({ length: 50 }, (_, index) => ({
      ...largeRequest.specifications[0], id: `large-spec-${index}`, description: "x".repeat(100_000),
    }));
    promptClosingRateLimit.input = JSON.stringify(largeRequest);
    promptClosingRateLimit.adapter.args = ["-e", "process.exit(75)"];
    const promptClosingRateOutcome = await runHeadlessInit(promptClosingRateLimit);
    expect([promptClosingRateOutcome.exitCode, promptClosingRateOutcome.result.status, promptClosingRateOutcome.result.diagnosticCode]).toEqual([75, "failed", "adapter_unavailable"]);

    const secretAdapterMetadata = await options("rate-limit");
    const secretAdapterProvider = "SECRET_SENTINEL_LABEL_24680";
    secretAdapterMetadata.adapter.provider = secretAdapterProvider;
    (secretAdapterMetadata.environment as NodeJS.ProcessEnv).RB_HEADLESS_TEST_SECRET = secretAdapterProvider;
    const secretAdapterMetadataOutcome = await runHeadlessInit(secretAdapterMetadata);
    expect([secretAdapterMetadataOutcome.exitCode, secretAdapterMetadataOutcome.result.status, secretAdapterMetadataOutcome.result.diagnosticCode]).toEqual([75, "failed", "adapter_unavailable"]);
    expect(JSON.stringify(secretAdapterMetadataOutcome.result)).not.toContain(secretAdapterProvider);

    const failed = await options("failure");
    const failedOutcome = await runHeadlessInit(failed);
    expect([failedOutcome.exitCode, failedOutcome.result.status]).toEqual([70, "failed"]);

    const secretFailure = await options("secret-failure");
    const secretFailureOutcome = await runHeadlessInit(secretFailure);
    expect([secretFailureOutcome.exitCode, secretFailureOutcome.result.status]).toEqual([70, "failed"]);
    expect(JSON.stringify(secretFailureOutcome.result)).not.toContain("SECRET_SENTINEL_12345");

    const hostile = await options("hostile");
    const hostileOutcome = await runHeadlessInit(hostile);
    expect([hostileOutcome.exitCode, hostileOutcome.result.status]).toEqual([2, "invalid"]);

    const secret = await options("secret");
    const secretOutcome = await runHeadlessInit(secret);
    expect([secretOutcome.exitCode, secretOutcome.result.status]).toEqual([2, "invalid"]);
    expect(JSON.stringify(secretOutcome.result)).not.toContain("SECRET_SENTINEL_12345");

    const secretPath = await options("secret-path");
    const secretPathOutcome = await runHeadlessInit(secretPath);
    expect([secretPathOutcome.exitCode, secretPathOutcome.result.status, secretPathOutcome.result.diagnosticCode]).toEqual([2, "invalid", "secret_detected"]);
    expect(JSON.stringify(secretPathOutcome.result)).not.toContain("SECRET_SENTINEL_12345");

    const deep = await options("deep");
    const deepOutcome = await runHeadlessInit(deep);
    expect([deepOutcome.exitCode, deepOutcome.result.status]).toEqual([2, "invalid"]);

    const unsafePath = await options("unsafe-path");
    const unsafePathOutcome = await runHeadlessInit(unsafePath);
    expect([unsafePathOutcome.exitCode, unsafePathOutcome.result.status, unsafePathOutcome.result.diagnosticCode]).toEqual([2, "invalid", "output_path"]);

    const invalidManifest = await options("manifest-extra");
    const invalidManifestOutcome = await runHeadlessInit(invalidManifest);
    expect([invalidManifestOutcome.exitCode, invalidManifestOutcome.result.status, invalidManifestOutcome.result.diagnosticCode]).toEqual([2, "invalid", "manifest_schema_invalid"]);

    for (const mode of ["manifest-date-only", "manifest-impossible-date"]) {
      const invalidDateManifest = await options(mode);
      const invalidDateManifestOutcome = await runHeadlessInit(invalidDateManifest);
      expect([invalidDateManifestOutcome.exitCode, invalidDateManifestOutcome.result.status, invalidDateManifestOutcome.result.diagnosticCode]).toEqual([2, "invalid", "manifest_schema_invalid"]);
      const rejectedManifest = JSON.parse(await readFile(resolve(invalidDateManifest.outputRoot, ".rb", "rb-manifest.json"), "utf8"));
      expect(rejectedManifest.generatedAt).toBe(mode === "manifest-date-only" ? "2026-01-01" : "2026-02-31T00:00:00.000Z");
    }

    const workspaceWrite = await options("workspace-write");
    const workspaceWriteOutcome = await runHeadlessInit(workspaceWrite);
    expect([workspaceWriteOutcome.exitCode, workspaceWriteOutcome.result.status, workspaceWriteOutcome.result.diagnosticCode]).toEqual([2, "invalid", "workspace_modified"]);

    const outputSymlink = await options("output-symlink");
    const outputSymlinkOutcome = await runHeadlessInit(outputSymlink);
    expect([outputSymlinkOutcome.exitCode, outputSymlinkOutcome.result.status, outputSymlinkOutcome.result.diagnosticCode]).toEqual([2, "invalid", "output_not_isolated"]);
    expect((await lstat(outputSymlink.outputRoot)).isSymbolicLink()).toBe(true);

    const missingAttachment = await options();
    const missingAttachmentPath = "SECRET_SENTINEL_MANAGER_67890/missing.md";
    const attachmentRequest = JSON.parse(request()) as Record<string, any>;
    attachmentRequest.specifications[0].resources = [{ id: "attachment-1", kind: "attachment", label: "Missing", path: missingAttachmentPath, mediaType: "text/markdown", bytes: 0, sha256: hash }];
    missingAttachment.input = JSON.stringify(attachmentRequest);
    const missingAttachmentOutcome = await runHeadlessInit(missingAttachment);
    expect([missingAttachmentOutcome.exitCode, missingAttachmentOutcome.result.status, missingAttachmentOutcome.result.diagnosticCode]).toEqual([2, "invalid", "attachment_invalid"]);
    expect(JSON.stringify(missingAttachmentOutcome.result)).not.toContain(missingAttachmentPath);
  });

  it("rejects scope hidden in every prompt-bearing field before the source adapter executes", async () => {
    for (const instruction of [
      "Inspect the production application and modernize authentication.",
      "Evaluate the production software and harden its authentication boundary.",
      "Evaluate the software serving customers and harden its authentication boundary.",
      "The project requires a non-invasive evaluation, posture analysis, and security hardening for the production software.",
      "Conduct a safeguards review for the application currently in production.",
      "For the upcoming engagement, orient yourself around the deployed codebase before proposing remediation.",
      "Evaluate the deployed service and harden its authentication boundary.",
      "Assess the live API before proposing a remediation.",
    ]) {
      for (const apply of promptScopeMutations) {
        const run = await options();
        const input = JSON.parse(request()) as Record<string, any>;
        apply(input, instruction);
        run.input = JSON.stringify(input);
        const outcome = await runHeadlessInit(run);
        expect([outcome.exitCode, outcome.result.status, outcome.result.diagnosticCode]).toEqual([2, "invalid", "unsupported_generation_scope"]);
        await expect(readFile(run.capture, "utf8")).rejects.toThrow();
      }
    }
  });

  it("rejects prompt-bearing instructions before the distributed adapter executes", async () => {
    for (const instruction of [
      "Inspect the production application and modernize authentication.",
      "Evaluate the production software and harden its authentication boundary.",
      "Evaluate the software serving customers and harden its authentication boundary.",
      "The project requires a non-invasive evaluation, posture analysis, and security hardening for the production software.",
      "Conduct a safeguards review for the application currently in production.",
      "For the upcoming engagement, orient yourself around the deployed codebase before proposing remediation.",
      "Evaluate the deployed service and harden its authentication boundary.",
      "Assess the live API before proposing a remediation.",
    ]) {
      for (const apply of promptScopeMutations) {
        const run = await options();
        const input = JSON.parse(request()) as Record<string, any>;
        apply(input, instruction);
        const outcome = await runPluginHeadlessInit(JSON.stringify(input), run.workspace, run.outputRoot, run.capture);
        expect([outcome.exitCode, outcome.result.status, outcome.result.diagnosticCode]).toEqual([2, "invalid", "unsupported_generation_scope"]);
        await expect(readFile(run.capture, "utf8")).rejects.toThrow();
      }
    }
  }, 20_000);
});
