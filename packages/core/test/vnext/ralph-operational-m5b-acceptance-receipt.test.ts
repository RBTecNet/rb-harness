import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson } from "../../src/vnext/ralph-runtime/canonical-json.js";
import {
  M5B_RETENTION_NOTICE_V2,
  RALPH_M5B_ACCEPTANCE_RECEIPT_SCHEMA_V2,
  buildCodexAcceptanceReceiptV2,
  codexAcceptanceEvidenceRootV2,
  validateCodexAcceptanceReceiptV2,
  writeCodexAcceptanceReceiptV2,
  type BuildCodexAcceptanceReceiptInputV2,
} from "../../src/vnext/ralph-runtime/operational-m5b/codex-acceptance-receipt.js";

/**
 * Ralph M5-B — the acceptance receipt.
 *
 * The defect this closes: the previous real acceptance could not be
 * reconstructed independently, because its evidence lived only in disposable
 * `/tmp` artifacts that were deleted on PASS.  A receipt makes the accepted
 * run reconstructible WITHOUT ever becoming a transcript — structural facts
 * only, bounded, credential-scanned and digest-sealed.
 */
const digest = (character: string): string => `sha256:${character.repeat(64)}`;

const ACCEPTED: BuildCodexAcceptanceReceiptInputV2 = Object.freeze({
  runId: "run-m5b-root",
  phaseId: "P01",
  taskId: "T001",
  attemptId: "attempt-m5b-root",
  invocationId: "invocation-m5b-root",
  managedRuntimeKind: "stock-codex-cli-managed",
  managedRuntimeVersion: "0.153.4-rb.1",
  managedRuntimeIdentityDigest: digest("1"),
  permissionProfileName: "ralph_m5b",
  permissionProfileDigest: digest("2"),
  permissionPolicyShapeDigest: digest("3"),
  capabilityRecordDigest: digest("4"),
  capabilityBindingDigest: digest("5"),
  sandboxBackendPath: "/usr/bin/bwrap",
  legacySandboxMode: "NONE",
  requestedModel: "gpt-5.6-sol",
  observedModelState: "UNAVAILABLE",
  observedModel: null,
  threadId: "thread-abc",
  scopeToken: "package.json",
  stagingRootWritable: true,
  writeRootPlanDigest: digest("6"),
  rootSentinelManifestDigest: digest("7"),
  sentinelPostCheck: "INTACT",
  projectionManifestDigest: digest("8"),
  promptDigest: digest("9"),
  actualExitCode: 0,
  actualSignal: null,
  terminalKind: "TURN_COMPLETED",
  terminalStatus: "SUCCEEDED",
  termination: "NORMAL",
  processState: "ABSENT",
  processTreeState: "QUIESCENT",
  settlementQuiescent: true,
  deltaDigest: digest("a"),
  deltaEntries: ["CREATE package.json"],
  publicationDigest: digest("b"),
  publicationAppliedCount: 1,
  canonicalPreFingerprint: digest("c"),
  canonicalPostFingerprint: digest("d"),
  canonicalPreControlPlaneFingerprint: digest("e"),
  canonicalPostControlPlaneFingerprint: digest("e"),
  controlPlaneCanariesIntact: true,
  evidenceDigest: digest("f"),
  validationSetDigest: digest("0"),
  auditResultDigest: digest("1"),
  attemptClosure: "AUDIT_ACCEPTED",
  taskState: "COMPLETE",
  runState: "COMPLETE",
  providerInvocationCount: 1,
  retryCount: 0,
  fallbackCount: 0,
  coldReopenIdentical: true,
  completedRerunProviderCallDelta: 0,
  retainedProjectRoot: "/tmp/rb-ralph-m5b-project-abc",
  retainedRunDirectory: "/tmp/rb-ralph-m5b-project-abc/.rb-harness/ralph/runs/run-m5b-root",
  observedAt: "2026-09-09T00:00:00.000Z",
});

const temporaries: string[] = [];
afterEach(async () => {
  await Promise.all(temporaries.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Ralph M5-B — acceptance receipt schema", () => {
  it("seals an internally consistent receipt", () => {
    const receipt = buildCodexAcceptanceReceiptV2(ACCEPTED);
    expect(receipt.schema).toBe(RALPH_M5B_ACCEPTANCE_RECEIPT_SCHEMA_V2);
    expect(receipt.credentialScan).toBe("CLEAN");
    expect(receipt.retentionNotice).toBe(M5B_RETENTION_NOTICE_V2);
    expect(receipt.receiptDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(() => validateCodexAcceptanceReceiptV2(receipt)).not.toThrow();
  });

  it("detects any later edit through the seal", () => {
    const receipt = buildCodexAcceptanceReceiptV2(ACCEPTED);
    expect(() => validateCodexAcceptanceReceiptV2({ ...receipt, threadId: "thread-other" })).toThrow(/digest mismatch/);
    expect(() => validateCodexAcceptanceReceiptV2({ ...receipt, extra: 1 })).toThrow(/unknown fields extra/);
    const { threadId: _dropped, ...missing } = receipt;
    expect(() => validateCodexAcceptanceReceiptV2(missing)).toThrow(/missing fields threadId/);
  });

  it("refuses a receipt claiming more completion than the durable Run supports", () => {
    // This is the whole point of sealing a receipt: it must not be able to
    // narrate a success the Run never reached.
    expect(() => buildCodexAcceptanceReceiptV2({ ...ACCEPTED, attemptClosure: "AUDIT_REJECTED" })).toThrow(/accepted Attempt closure/);
    expect(() => buildCodexAcceptanceReceiptV2({ ...ACCEPTED, terminalStatus: "FAILED" })).toThrow(/clean provider terminal/);
    expect(() => buildCodexAcceptanceReceiptV2({ ...ACCEPTED, actualExitCode: 1 })).toThrow(/clean provider terminal/);
    expect(() => buildCodexAcceptanceReceiptV2({ ...ACCEPTED, publicationDigest: null })).toThrow(/published delta/);
    expect(() => buildCodexAcceptanceReceiptV2({ ...ACCEPTED, sentinelPostCheck: "VIOLATED" })).toThrow(/intact control plane/);
    expect(() => buildCodexAcceptanceReceiptV2({ ...ACCEPTED, controlPlaneCanariesIntact: false })).toThrow(/intact control plane/);
  });

  it("refuses a receipt that implies more than one model-bearing call", () => {
    expect(() => buildCodexAcceptanceReceiptV2({ ...ACCEPTED, providerInvocationCount: 2 })).toThrow(/exactly one provider invocation/);
    expect(() => buildCodexAcceptanceReceiptV2({ ...ACCEPTED, retryCount: 1 })).toThrow(/exactly one provider invocation/);
    expect(() => buildCodexAcceptanceReceiptV2({ ...ACCEPTED, fallbackCount: 1 })).toThrow(/exactly one provider invocation/);
    expect(() => buildCodexAcceptanceReceiptV2({ ...ACCEPTED, completedRerunProviderCallDelta: 1 })).toThrow(/no provider call/);
  });

  it("refuses a receipt that claims an observed model surface", () => {
    // Stock ephemeral `codex exec` publishes none; claiming one would be
    // claiming an observation nobody made.
    expect(() => buildCodexAcceptanceReceiptV2({ ...ACCEPTED, observedModelState: "REPORTED" })).toThrow(/M5B_PROVIDER_MODEL_SURFACE_UNEXPECTED/);
    expect(() => buildCodexAcceptanceReceiptV2({ ...ACCEPTED, observedModel: "gpt-5.6-sol" })).toThrow(/M5B_PROVIDER_MODEL_SURFACE_UNEXPECTED/);
  });

  it("refuses a root-scope receipt with no sentinel authority", () => {
    expect(() => buildCodexAcceptanceReceiptV2({ ...ACCEPTED, rootSentinelManifestDigest: "" })).toThrow(/M5B_SENTINEL_MANIFEST_INVALID/);
  });

  it("refuses credential-shaped material anywhere in the receipt", () => {
    for (const poison of [
      "Bearer sk-abcdefghijklmnop",
      "api_key=abcdefghijklmnop",
      "sk-abcdefghijklmnopqrstuvwx",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.x",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
    ]) {
      expect(() => buildCodexAcceptanceReceiptV2({ ...ACCEPTED, threadId: poison }), poison).toThrow(/M5B_PROVIDER_CREDENTIAL_MATERIAL/);
      expect(() => buildCodexAcceptanceReceiptV2({ ...ACCEPTED, deltaEntries: [poison] }), poison).toThrow(/M5B_PROVIDER_CREDENTIAL_MATERIAL/);
    }
  });

  it("stays bounded and carries no transcript surface at all", () => {
    const receipt = buildCodexAcceptanceReceiptV2(ACCEPTED);
    const serialized = canonicalJson(receipt);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThan(64 * 1024);
    // No raw JSONL, reasoning, transcript, command output or source content.
    expect(serialized).not.toMatch(/thread\.started|item\.completed|turn\.completed|agent_message|reasoning/);
    expect(() => buildCodexAcceptanceReceiptV2({ ...ACCEPTED, threadId: "t".repeat(513) })).toThrow(/field bound/);
  });

  it("writes the sealed receipt outside any canonical repository", async () => {
    const evidenceRoot = await mkdtemp(resolve(tmpdir(), "rb-ralph-m5b-evidence-"));
    temporaries.push(evidenceRoot);
    const receipt = buildCodexAcceptanceReceiptV2(ACCEPTED);
    const written = await writeCodexAcceptanceReceiptV2(receipt, evidenceRoot);
    expect(written.path).toContain(ACCEPTED.runId);
    expect(written.receiptDigest).toBe(receipt.receiptDigest);
    const reread = JSON.parse(await readFile(written.path, "utf8")) as unknown;
    expect(() => validateCodexAcceptanceReceiptV2(reread)).not.toThrow();
    // The default evidence root is a local state directory, never a project.
    expect(codexAcceptanceEvidenceRootV2()).toContain(".local/state/rb-harness");
  });
});
