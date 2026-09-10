import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCodexCorrectionAcceptanceReceiptV2,
  codexCorrectionAcceptanceEvidenceRootV2,
  validateCodexCorrectionAcceptanceReceiptV2,
  writeCodexCorrectionAcceptanceReceiptV2,
  type BuildCodexCorrectionAcceptanceReceiptInputV2,
} from "../../src/vnext/ralph-runtime/operational-m5b/codex-correction-acceptance-receipt.js";

const digest = (character: string): string => `sha256:${character.repeat(64)}`;
const ACCEPTED: BuildCodexCorrectionAcceptanceReceiptInputV2 = Object.freeze({
  runId: "run-m5c",
  phaseId: "P01",
  taskId: "T001",
  rejectedAttemptId: "attempt-m5c-a1",
  correctionAttemptId: "attempt-m5c-a2",
  rejectedAttemptClosure: "AUDIT_REJECTED",
  correctionAttemptClosure: "AUDIT_ACCEPTED",
  findingId: "finding-m5c",
  findingDigest: digest("1"),
  findingFinalStatus: "RESOLVED",
  correctionContextRef: "attempts/attempt-m5c-a2/correction-context.json",
  correctionContextDigest: digest("2"),
  providerDescriptorDigest: digest("3"),
  promptDigest: digest("4"),
  threadId: "thread-m5c-fresh",
  managedRuntimeKind: "stock-codex-cli-managed",
  managedRuntimeVersion: "0.153.4-rb.1",
  managedRuntimeIdentityDigest: digest("5"),
  requestedModel: "gpt-5.6-sol",
  sandboxBackendPath: "/usr/bin/bwrap",
  permissionProfileDigest: digest("6"),
  capabilityBindingDigest: digest("7"),
  stagingRootWritable: true,
  rootSentinelManifestDigest: digest("8"),
  deltaDigest: digest("9"),
  deltaEntries: ["MODIFY package.json"],
  publicationDigest: digest("a"),
  rejectedEvidenceDigest: digest("b"),
  correctionEvidenceDigest: digest("c"),
  rejectedValidationSetDigest: digest("d"),
  correctionValidationSetDigest: digest("e"),
  validationTransition: "FAIL_TO_PASS",
  taskState: "COMPLETE",
  runState: "COMPLETE",
  runHold: "NONE",
  providerInvocationCount: 1,
  retryCount: 0,
  fallbackCount: 0,
  completedRerunProviderCallDelta: 0,
  coldReopenIdentical: true,
  controlPlaneCanariesIntact: true,
  credentialLeakage: false,
  retainedProjectRoot: "/tmp/rb-m5c-project",
  retainedRunDirectory: "/tmp/rb-m5c-project/.rb-harness/ralph/runs/run-m5c",
  retainedStagingBase: "/tmp/rb-m5c-staging",
  platform: "linux-x86_64",
  unqualifiedPlatforms: ["WSL2", "macOS arm64", "macOS x64", "linux arm64"] as const,
  observedAt: "2026-09-09T12:30:00.000Z",
});

const temporary: string[] = [];
afterEach(async () => Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("Ralph M5-C — bounded correction acceptance receipt", () => {
  it("seals only the structural reject-to-correction chain", () => {
    const receipt = buildCodexCorrectionAcceptanceReceiptV2(ACCEPTED);
    expect(receipt.receiptDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(() => validateCodexCorrectionAcceptanceReceiptV2(receipt)).not.toThrow();
    expect(JSON.stringify(receipt)).not.toMatch(/thread\.started|agent_message|reasoning|turn\.completed/);
  });

  it("refuses a false closure, call count, thread reuse, unsafe delta or platform claim", () => {
    for (const mutation of [
      { correctionAttemptClosure: "AUDIT_REJECTED" },
      { providerInvocationCount: 2 },
      { correctionAttemptId: ACCEPTED.rejectedAttemptId },
      { deltaEntries: ["MODIFY package.json", "CREATE extra.txt"] },
      { platform: "macOS arm64" },
      { credentialLeakage: true },
    ]) expect(() => buildCodexCorrectionAcceptanceReceiptV2({ ...ACCEPTED, ...mutation } as never)).toThrow(/M5C_ACCEPTANCE_RECEIPT_INVALID/);
  });

  it("detects edits, credential-shaped strings and writes outside the project", async () => {
    const receipt = buildCodexCorrectionAcceptanceReceiptV2(ACCEPTED);
    expect(() => validateCodexCorrectionAcceptanceReceiptV2({ ...receipt, threadId: "other" })).toThrow(/digest mismatch/);
    expect(() => buildCodexCorrectionAcceptanceReceiptV2({ ...ACCEPTED, threadId: "Bearer secret-value" })).toThrow(/CREDENTIAL_MATERIAL/);
    const root = await mkdtemp(resolve(tmpdir(), "rb-m5c-evidence-"));
    temporary.push(root);
    const written = await writeCodexCorrectionAcceptanceReceiptV2(receipt, root);
    expect(JSON.parse(await readFile(written.path, "utf8"))).toEqual(receipt);
    expect(codexCorrectionAcceptanceEvidenceRootV2()).toContain(".local/state/rb-harness/ralph-m5c-acceptance");
  });
});
