import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { artifactVerificationExitCode, verifyArtifacts } from "../src/artifact-verifier.js";
import { initializeProject, syncManifest } from "../src/manifest.js";

const fakeProvider = resolve(process.cwd(), "test/fixtures/standalone/fake-provider.mjs");

function phases(): string {
  return `# RB Execution Plan: verification fixture

<!-- rb-execution-contract: rb-execution/v1 -->
<!-- rb-artifact-id: verification-fixture-execution -->

## Phase 1: Build the fixture

**Phase ID:** P01
**Goal:** Implement the documented fixture safely.
**Depends on:** none
**Context:**
- \`.rb/features/verification/REQUEST.md\`

- [ ] T001 — Implement the fixture
  - **Scope:** \`src/fixture.ts\`, \`test/fixture.test.ts\`
  - **Change:** Implement the exact requested fixture behavior.
  - **Covers:** RF-001
  - **Depends on:** none
  - **Parallel safe:** false
  - **Acceptance criteria:**
    - AC-T001-01: The fixture returns the documented value.
  - **Validation:**
    - \`npm test -- test/fixture.test.ts\`
  - **Expected evidence:** Focused test exits zero.
`;
}

async function project(request: string): Promise<{ root: string; authority: string }> {
  const root = await mkdtemp(resolve(tmpdir(), "rb-artifact-verify-"));
  await initializeProject(root, "Verification fixture", "verification-fixture");
  await mkdir(resolve(root, ".rb/features/verification"), { recursive: true });
  await writeFile(resolve(root, ".rb/features/verification/REQUEST.md"), request, "utf8");
  await writeFile(resolve(root, ".rb/features/verification/PHASES.md"), phases(), "utf8");
  const authority = resolve(root, "original-request.md");
  await writeFile(authority, "Implement RF-001 through one bounded task.\n", "utf8");
  await syncManifest(root);
  return { root, authority };
}

describe("artifact verifier", () => {
  it("finds orphan task references after the normal tree validator passes", async () => {
    const fixture = await project("# Request\n\nRF-001 is implemented by T001. Synchronization is verified by T020.\n");
    const report = await verifyArtifacts({
      projectRoot: fixture.root,
      artifactDirectory: ".rb",
      againstFile: fixture.authority,
      provider: { provider: "custom", model: "fixture", effort: "high", command: fakeProvider },
      deterministicOnly: true,
      timeoutSeconds: 30,
      firstOutputTimeoutSeconds: 5,
    });
    expect(report.deterministic.passed).toBe(false);
    expect(report.readyForRalph).toBe(false);
    expect(report.findings.find((finding) => finding.id.startsWith("traceability.undefined-task"))?.evidence).toContain("T020");
    expect(artifactVerificationExitCode(report)).toBe(2);
  });

  it("runs one read-only semantic audit after deterministic gates pass", async () => {
    const fixture = await project("# Request\n\nRF-001 is implemented and verified by T001.\n");
    await chmod(fakeProvider, 0o755);
    const report = await verifyArtifacts({
      projectRoot: fixture.root,
      artifactDirectory: ".rb",
      againstFile: fixture.authority,
      provider: { provider: "custom", model: "fixture", effort: "high", command: fakeProvider },
      deterministicOnly: false,
      timeoutSeconds: 30,
      firstOutputTimeoutSeconds: 5,
    });
    expect(report.status).toBe("pass");
    expect(report.readyForRalph).toBe(true);
    expect(report.semantic).toMatchObject({ executed: true, status: "pass", provider: "custom", model: "fixture" });
    expect(JSON.parse(await readFile(report.reportPath, "utf8"))).toMatchObject({
      contract: "rb-harness-artifact-verification/v1",
      readyForRalph: true,
    });
    expect(artifactVerificationExitCode(report)).toBe(0);
  });

  it("does not spend a provider call when artifact integrity is already broken", async () => {
    const fixture = await project("# Request\n\nRF-001 is implemented and verified by T001.\n");
    await writeFile(resolve(fixture.root, ".rb/features/verification/REQUEST.md"), "stale after manifest sync\n", "utf8");
    const providerModes = resolve(fixture.root, "provider-modes.log");
    process.env.RB_HARNESS_TEST_PROVIDER_MODE_FILE = providerModes;
    try {
      const report = await verifyArtifacts({
        projectRoot: fixture.root,
        artifactDirectory: ".rb",
        againstFile: fixture.authority,
        provider: { provider: "custom", model: "fixture", effort: "high", command: fakeProvider },
        deterministicOnly: false,
        timeoutSeconds: 30,
        firstOutputTimeoutSeconds: 5,
      });
      expect(report.status).toBe("fail");
      expect(report.semantic.executed).toBe(false);
      expect(report.findings.some((finding) => finding.criterion === "artifact.stale")).toBe(true);
      await expect(readFile(providerModes, "utf8")).rejects.toThrow();
    } finally {
      delete process.env.RB_HARNESS_TEST_PROVIDER_MODE_FILE;
    }
  });
});
