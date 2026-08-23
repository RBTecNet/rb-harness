import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runHeadlessInit } from "../src/headless-runner.js";
import { validateProjectPackageValue } from "../src/index.js";

const hash = "a".repeat(64);
const fixtureAdapter = resolve(process.cwd(), "test/fixtures/headless/fake-adapter.mjs");
const bundledCli = resolve(process.cwd(), "../../plugins/rb-harness/scripts/rb-harness.cjs");

function request(): string {
  return JSON.stringify({
    contract: "rb-headless-init/v1", kind: "request", requestId: "bundle-request-1", workflow: "init", projectKind: "new",
    project: { id: "bundle-demo", name: "Bundle demo", description: "Create a new service that will evaluate responses from an existing API after launch.", metadata: {} },
    artifactSet: { id: "set-1", name: "Default", description: "", strategy: "" },
    revision: { id: "revision-1", number: 1, createdAt: "2026-01-01T00:00:00.000Z" },
    specifications: [{ id: "spec-1", title: "Spec", description: "Description", decisions: [], metadata: {}, snapshotHash: hash, resources: [] }],
    additionalInstructions: "", interviewAnswers: [],
  });
}

function runCli(input: string, outputRoot: string, workspace: string): Promise<{ exitCode: number | null; result: Record<string, unknown> }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [bundledCli, "headless", "init", "--output", outputRoot], {
      cwd: workspace,
      env: {
        PATH: process.env.PATH,
        RB_HEADLESS_ADAPTER_COMMAND: process.execPath,
        RB_HEADLESS_ADAPTER_ARGS: JSON.stringify([fixtureAdapter]),
        RB_HEADLESS_ADAPTER_ID: "fake-adapter",
        RB_HEADLESS_ADAPTER_VERSION: "1",
        RB_HEADLESS_ADAPTER_PROVIDER: "test",
        RB_HEADLESS_ADAPTER_MODEL: "fake",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (exitCode) => {
      try {
        resolveResult({ exitCode, result: JSON.parse(Buffer.concat(stdout).toString("utf8")) as Record<string, unknown> });
      } catch (error) {
        reject(new Error(`Bundle emitted invalid JSON (${Buffer.concat(stderr).toString("utf8")}): ${error instanceof Error ? error.message : String(error)}`));
      }
    });
    child.stdin.end(input, "utf8");
  });
}

function comparable(value: Record<string, unknown>): Record<string, unknown> {
  const { startedAt: _startedAt, finishedAt: _finishedAt, files, ...stable } = value;
  return { ...stable, files: (files as Array<Record<string, unknown>>).map(({ bytes: _bytes, sha256: _sha256, ...file }) => file) };
}

function projectPackage(result: Record<string, unknown>): Record<string, unknown> {
  const harness = result.harness as Record<string, unknown>;
  const adapter = result.adapter as Record<string, unknown>;
  return {
    contract: "rb-project-package/v1", status: "ready",
    project: { id: "bundle-demo", name: "Bundle demo" }, artifactSet: { id: "set-1", name: "Default" }, revision: { id: "revision-1", number: 1 },
    sources: [{ specificationId: "spec-1", snapshotSha256: hash, resources: [] }], harness,
    generation: { workflow: "init", requestSha256: result.requestHash, adapter: adapter.id, provider: adapter.provider, model: adapter.model, attempts: 1 },
    contracts: ["rb-headless-init/v1", "rb-manifest/v1", "rb-execution/v1"],
    validation: ["paths", "contract", "operations", "manifest", "tree", "secrets", "physical-inventory"].map((name) => ({ name, passed: true })),
    files: result.files, generatedAt: result.finishedAt,
  };
}

describe("headless bundle", () => {
  it("matches the source runner and exports the project-package validator", async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), "rb-headless-release-bundle-"));
    const input = request();
    const source = await runHeadlessInit({
      input, workspace, outputRoot: resolve(workspace, "source-output"),
      adapter: { command: process.execPath, args: [fixtureAdapter], id: "fake-adapter", version: "1", provider: "test", model: "fake" },
      environment: { PATH: process.env.PATH },
    });
    const bundled = await runCli(input, resolve(workspace, "bundle-output"), workspace);

    expect(source.exitCode).toBe(0);
    expect(bundled.exitCode).toBe(0);
    expect(comparable(bundled.result)).toEqual(comparable(source.result));
    expect(validateProjectPackageValue(projectPackage(source.result)).valid).toBe(true);
    expect(validateProjectPackageValue(projectPackage(bundled.result)).valid).toBe(true);
  });
});
