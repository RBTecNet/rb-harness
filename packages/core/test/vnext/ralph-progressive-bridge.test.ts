import { appendFile, mkdir, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertRalphRootCliArgs, harnessCommandSurface } from "../../src/cli-program.js";
import { parseExecutionMarkdown } from "../../src/execution-contract.js";
import { assertExactProgressivePlanBinding } from "../../src/vnext/ralph-bridge/plan-authority.js";
import {
  createIsolatedRalphWorkspace,
  genesisFor,
  initializeBridgeRunV1,
  inspectHostPublicationOutcome,
  inspectRalphBridgeStatusV1,
  listBridgeRunDescriptors,
  loadProgressiveExecutionAuthority,
  publishAcceptedTaskDelta,
  runProgressiveRalphBridgeV1,
  snapshotHostImplementation,
  snapshotRalphWorkspace,
  assertExactReady,
  selectExactReadyExecutionPlan,
  type BridgeRuntimeFactoriesV1,
} from "../../src/vnext/ralph-bridge/index.js";
import { RalphEventStoreV2 } from "../../src/vnext/ralph-runtime/operational-b1/index.js";
import { sha256Canonical } from "../../src/vnext/ralph-runtime/hashing.js";
import { readExecutorObservationReceiptV2, ScriptedExecutor, type ScriptedWorkspaceActionV2 } from "../../src/vnext/ralph-runtime/operational-b4/index.js";
import {
  createHumanValidationRequestV2,
  createOperatorHumanValidationAuthorityV2,
  obtainTrustedHumanValidationDecisionV2,
  persistTrustedHumanValidationDecisionV2,
  readHumanValidationDecisionV2,
  readValidationRunV2,
  type ValidationProcessInputV2,
  type ValidationProcessResultV2,
  type ValidationProcessSupervisorV2Like,
} from "../../src/vnext/ralph-runtime/operational-d/index.js";
import { ScriptedAuditor, type ScriptedAuditorDecisionV2 } from "../../src/vnext/ralph-runtime/operational-e/index.js";
import type { AuditPackageV2 } from "../../src/vnext/ralph-runtime/operational-d/index.js";
import {
  BRIDGE_FIXTURE_REQUEST,
  createReadyBridgeFixture,
  loadReadyBridgeFixtureProjectPhases,
} from "./fixtures/progressive-ready-bridge-fixture.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Progressive READY -> Ralph execution bridge V1", () => {
  it("projects exact READY authority into deterministic genesis and normalizes only Scope presentation punctuation", async () => {
    const fixture = await ready({ taskCount: 2 });
    const first = await loadProgressiveExecutionAuthority(fixture.root);
    const second = await loadProgressiveExecutionAuthority(fixture.root);
    expect(first.semanticExecutionIdentity).toBe(second.semanticExecutionIdentity);
    expect(first.operationalPlanDigest).toBe(second.operationalPlanDigest);
    expect(first.originalRequest).toBe(BRIDGE_FIXTURE_REQUEST);
    expect(first.readiness).toMatchObject({ ready: true, closureStatus: "fresh", reasons: [] });
    expect(first.manifest.artifacts.filter((artifact) => artifact.kind === "execution-plan" && artifact.status === "ready")).toEqual([first.selectedPlan]);
    expect(first.operationalPlan.phases[0]?.tasks.every((task) => !task.scope.includes("`"))).toBe(true);
    expect(first.ownedPathsByTask).toEqual({ T001: ["src/first.txt"], T002: ["src/second.txt"] });

    const host = await snapshotHostImplementation(fixture.root, Object.values(first.ownedPathsByTask).flat());
    const workspace = resolve(fixture.root, ".rb-harness/ralph/bridge-runs/genesis-only/workspace");
    await createIsolatedRalphWorkspace(fixture.root, workspace, host);
    const initialized = await initializeBridgeRunV1({ authority: first, workspaceRoot: workspace, hostBaseline: host, runId: "genesis-only", ...ids("genesis") });
    expect(initialized.snapshot.projectIdentity).toMatchObject({
      semanticExecutionIdentity: first.semanticExecutionIdentity,
      planPath: first.selectedPlan.path,
      planSourceSha256: first.selectedPlan.sha256,
      hostBaselineDigest: host.digest,
    });
    expect(initialized.snapshot.readyPlanIdentity).toBe(first.selectedPlan.id);
    expect(initialized.snapshot.readyPlanHash).toBe(first.operationalPlanDigest);
    expect(initialized.retryPolicy).toMatchObject({ maxTaskAttemptsPerTask: 2, validationInfrastructureRetryLimit: 0 });
    expect(initialized.genesisState.taskIds).toEqual(["T001", "T002"]);
    expect(initialized.genesisState.tasks.T002?.dependsOn).toEqual(["T001"]);
    expect(initialized.descriptor.publicationSemantic).toBe("ACCEPTED_TASK_DELTA");
  }, 30_000);

  it("consumes the canonical P4 execution projection when declarations use non-canonical ordering", async () => {
    const fixture = await ready({ taskCount: 4, nonCanonicalDeclarationOrder: true });
    const projectPhases = await loadReadyBridgeFixtureProjectPhases(fixture.root);
    const rawTasks = projectPhases.phases.flatMap((phase) => phase.tasks);
    const rawFirst = rawTasks.find((task) => task.key === "write-first")!;
    const rawFourth = rawTasks.find((task) => task.key === "write-fourth")!;
    expect(rawFirst.ownedPaths).not.toEqual([...rawFirst.ownedPaths].sort());
    expect(rawFirst.coverageKeys).not.toEqual([...rawFirst.coverageKeys].sort());
    expect(rawFourth.dependsOn).not.toEqual([...rawFourth.dependsOn].sort());

    const authority = await loadProgressiveExecutionAuthority(fixture.root);
    const tasks = authority.operationalPlan.phases.flatMap((phase) => phase.tasks);
    expect(tasks.map((task) => task.id)).toEqual(["T001", "T002", "T003", "T004"]);
    expect(tasks.find((task) => task.id === "T001")?.scope).toBe("src/alpha.txt, src/first.txt, src/zeta.txt");
    expect(authority.ownedPathsByTask.T001).toEqual(["src/alpha.txt", "src/first.txt", "src/zeta.txt"]);
    expect(tasks.find((task) => task.id === "T004")?.dependsOn).toEqual(["T001", "T002", "T003"]);
    const covers = tasks.find((task) => task.id === "T001")?.covers.split(", ") ?? [];
    expect(covers.length).toBeGreaterThan(1);
    expect(covers).toEqual([...covers].sort());
  }, 30_000);

  it("retains exact fail-closed Progressive binding for semantic PHASES tampering", async () => {
    const fixture = await ready({ taskCount: 4, nonCanonicalDeclarationOrder: true });
    const authority = await loadProgressiveExecutionAuthority(fixture.root);
    const canonical = parseExecutionMarkdown(authority.selectedPlanSource);
    const tamperedSource = authority.selectedPlanSource.replace(
      "Create the first deterministic implementation file for the approved task workflow.",
      "Create the first altered deterministic implementation file for the approved task workflow.",
    );
    expect(tamperedSource).not.toBe(authority.selectedPlanSource);
    const tampered = parseExecutionMarkdown(tamperedSource);
    expect(() => assertExactProgressivePlanBinding(tampered, canonical))
      .toThrow("RALPH_BRIDGE_PLAN_PROGRESSIVE_BINDING_MISMATCH");
  }, 30_000);

  it("executes dependencies in plan order, audits exact work units, commits durably, and publishes accepted task deltas", async () => {
    const fixture = await ready({ taskCount: 2 });
    const trace: string[] = [];
    const validationCommands: string[] = [];
    const workUnits: Array<{ taskId: string; scope: string; covers: string; acceptance: readonly string[] }> = [];
    const result = await runProgressiveRalphBridgeV1(fixture.root, {
      ...ids("success"),
      runtimes: runtimes({
        action: async (context) => {
          trace.push(`executor:${context.taskId}`);
          if (context.taskId === "T002") expect(await readFile(resolve(workspaceFromContext(fixture.root, "success"), "src/first.txt"), "utf8")).toBe("first\n");
          await writeImplementation(workspaceFromContext(fixture.root, "success"), context.taskId, context.correctionContext ? "corrected\n" : undefined);
        },
        onWorkUnit: (workUnit) => workUnits.push({ taskId: workUnit.taskId, scope: workUnit.scope, covers: workUnit.covers, acceptance: workUnit.acceptanceCriteria }),
        decide: (auditPackage) => {
          trace.push(`auditor:${auditPackage.taskId}`);
          return accept();
        },
      }),
      validationProcessSupervisor: successfulValidation(validationCommands),
    });
    expect(result.errorCode, JSON.stringify(result)).toBeUndefined();
    expect(result).toMatchObject({ status: "COMPLETE", completedTaskCount: 2, remainingTaskCount: 0, publicationOccurred: true });
    expect(trace).toEqual(["executor:T001", "auditor:T001", "executor:T002", "auditor:T002"]);
    expect(validationCommands).toEqual(["test -f src/first.txt", "test -f src/first.txt"]);
    expect(workUnits.map((entry) => entry.scope)).toEqual(["src/first.txt", "src/second.txt"]);
    expect(workUnits.every((entry) => entry.covers.length > 0 && entry.acceptance.length > 0)).toBe(true);
    expect(await readFile(resolve(fixture.root, "src/first.txt"), "utf8")).toBe("first\n");
    expect(await readFile(resolve(fixture.root, "src/second.txt"), "utf8")).toBe("second\n");
    await expect(readFile(resolve(workspaceFromContext(fixture.root, "success"), ".rb/init/PHASES.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(resolve(workspaceFromContext(fixture.root, "success"), ".spec/init/project-phases.md"))).rejects.toMatchObject({ code: "ENOENT" });

    const store = new RalphEventStoreV2({ projectRoot: workspaceFromContext(fixture.root, "success"), runId: "success" });
    const inspection = await store.inspect();
    expect(inspection.events.filter((event) => event.eventType === "attempt.started").map((event) => event.taskId)).toEqual(["T001", "T002"]);
    expect(inspection.events.filter((event) => event.eventType === "audit.started")).toHaveLength(2);
    expect(inspection.events.at(-1)?.eventType).toBe("run.completed");
    const publication = await inspectHostPublicationOutcome(result.runPath);
    expect(publication).toMatchObject({ publicationOccurred: true });
    expect(publication.rejected).toBeUndefined();
    expect((await inspectRalphBridgeStatusV1(fixture.root))).toMatchObject({ state: "terminal", latestRunId: "success", latestStatus: "COMPLETE" });
  }, 30_000);

  it("rejects stale Progressive authority before workspace, run, or runtime invocation", async () => {
    const fixture = await ready({ taskCount: 1 });
    await appendFile(resolve(fixture.root, ".spec/init/user-stories.md"), "\ninvalid stale edit\n");
    let runtimeCalls = 0;
    const result = await runProgressiveRalphBridgeV1(fixture.root, {
      ...ids("stale-entry"),
      runtimes: countingRuntimes(() => { runtimeCalls += 1; }),
      validationProcessSupervisor: successfulValidation(),
    });
    expect(result).toMatchObject({ status: "FAILED", runId: "none", publicationOccurred: false });
    expect(result.errorCode).toBe("RALPH_BRIDGE_PROGRESSIVE_NOT_READY");
    expect(runtimeCalls).toBe(0);
    await expect(readdir(resolve(fixture.root, ".rb-harness/ralph/bridge-runs"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("requires fresh closure and no readiness reasons even when ready is claimed", () => {
    expect(() => assertExactReady({ ready: true, closureStatus: "stale", reasons: [], stages: [] })).toThrow("RALPH_BRIDGE_PROGRESSIVE_NOT_READY");
    expect(() => assertExactReady({ ready: true, closureStatus: "fresh", reasons: ["contradiction"], stages: [] })).toThrow("RALPH_BRIDGE_PROGRESSIVE_NOT_READY");
  });

  it("never picks the first plan when READY selection is ambiguous", async () => {
    const fixture = await ready({ taskCount: 1 });
    const authority = await loadProgressiveExecutionAuthority(fixture.root);
    const manifest = structuredClone(authority.manifest);
    manifest.artifacts.push({ ...authority.selectedPlan, id: "second-ready-plan" });
    expect(() => selectExactReadyExecutionPlan(manifest, authority.selectedPlanSource)).toThrow("RALPH_BRIDGE_PLAN_AMBIGUOUS");
  }, 30_000);

  it.each([
    ["invalid manifest", (manifest: any) => { manifest.untrusted = true; }],
    ["multiple READY plans", (manifest: any) => { manifest.artifacts.push({ ...manifest.artifacts.find((entry: any) => entry.kind === "execution-plan"), id: "ambiguous-ready-plan" }); }],
  ])("fails closed before run initialization for %s", async (_label, mutate) => {
    const fixture = await ready({ taskCount: 1 });
    const manifestPath = resolve(fixture.root, ".rb/rb-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    mutate(manifest);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    let runtimeCalls = 0;
    const result = await runProgressiveRalphBridgeV1(fixture.root, {
      ...ids("bad-manifest"),
      runtimes: countingRuntimes(() => { runtimeCalls += 1; }),
    });
    expect(result).toMatchObject({ status: "FAILED", runId: "none", publicationOccurred: false });
    expect(runtimeCalls).toBe(0);
    await expect(readdir(resolve(fixture.root, ".rb-harness/ralph/bridge-runs"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("retains accepted evidence but refuses publication when readiness becomes stale", async () => {
    const fixture = await ready({ taskCount: 1 });
    const phasesPath = resolve(fixture.root, ".spec/init/project-phases.md");
    const phasesBefore = await readFile(phasesPath);
    const result = await runProgressiveRalphBridgeV1(fixture.root, {
      ...ids("stale-publication"),
      runtimes: runtimes({ action: async (context) => writeImplementation(workspaceFromContext(fixture.root, "stale-publication"), context.taskId), decide: accept }),
      validationProcessSupervisor: successfulValidation(),
      beforePublication: async () => appendFile(phasesPath, "\nsemantic authority changed\n"),
    });
    expect(result).toMatchObject({ status: "FAILED", publicationOccurred: false });
    expect(result.errorCode).toBe("RALPH_BRIDGE_PROGRESSIVE_NOT_READY");
    await expect(readFile(resolve(fixture.root, "src/first.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await inspectHostPublicationOutcome(result.runPath)).rejected?.reason).toBe("RALPH_BRIDGE_PROGRESSIVE_NOT_READY");
    const evidenceSources = await Promise.all((await readdir(resolve(result.runPath, "attempts"))).map((attempt) =>
      readFile(resolve(result.runPath, "attempts", attempt, "evidence-capture.json"), "utf8").catch(() => "")));
    expect(evidenceSources.join("\n")).toContain("rb-ralph-evidence");

    await writeFile(phasesPath, phasesBefore);
    let repeatedRuntimeCalls = 0;
    const repeated = await runProgressiveRalphBridgeV1(fixture.root, { ...ids("must-not-run"), runtimes: countingRuntimes(() => { repeatedRuntimeCalls += 1; }) });
    expect(repeated.status).toBe("FAILED");
    expect(repeated.runId).toBe("stale-publication");
    expect(repeated.publicationOccurred).toBe(false);
    expect(repeatedRuntimeCalls).toBe(0);
  }, 30_000);

  it("prevents provider-authored control paths from reaching the real project", async () => {
    const fixture = await ready({ taskCount: 1 });
    const controlPath = resolve(fixture.root, ".spec/init/project-phases.md");
    const before = await readFile(controlPath);
    let audits = 0;
    const workspace = workspaceFromContext(fixture.root, "control-write");
    const result = await runProgressiveRalphBridgeV1(fixture.root, {
      ...ids("control-write"),
      runtimes: runtimes({
        action: async (context) => {
          await writeImplementation(workspace, context.taskId);
          await mkdir(resolve(workspace, ".spec/init"), { recursive: true });
          await writeFile(resolve(workspace, ".spec/init/project-phases.md"), "provider mutation\n");
        },
        decide: () => { audits += 1; return accept(); },
      }),
      validationProcessSupervisor: successfulValidation(),
    });
    expect(["FAILED", "BLOCKED"]).toContain(result.status);
    expect(result.publicationOccurred).toBe(false);
    expect(result.errorCode).toBe("RALPH_BRIDGE_CONTROL_PATH_WRITE");
    expect(audits).toBe(1);
    expect(await readFile(controlPath)).toEqual(before);
    await expect(readFile(resolve(fixture.root, "src/first.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("rejects an unowned implementation path at both Executor and host publication boundaries", async () => {
    const fixture = await ready({ taskCount: 1 });
    const workspace = workspaceFromContext(fixture.root, "unowned-write");
    const result = await runProgressiveRalphBridgeV1(fixture.root, {
      ...ids("unowned-write"),
      runtimes: runtimes({
        action: async (context) => {
          await writeImplementation(workspace, context.taskId);
          await writeFile(resolve(workspace, "src/second.txt"), "unowned\n");
        },
        decide: accept,
      }),
      validationProcessSupervisor: successfulValidation(),
    });
    expect(["FAILED", "BLOCKED"]).toContain(result.status);
    expect(result.publicationOccurred).toBe(false);
    expect(result.errorCode).toBe("RALPH_BRIDGE_UNOWNED_PATH_WRITE");
    await expect(readFile(resolve(fixture.root, "src/first.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(resolve(fixture.root, "src/second.txt"))).rejects.toMatchObject({ code: "ENOENT" });

    const authority = await loadProgressiveExecutionAuthority(fixture.root);
    const directBaseline = await snapshotHostImplementation(fixture.root, ["src/first.txt", "src/second.txt"]);
    const directWorkspace = resolve(fixture.root, ".rb-harness/ralph/bridge-runs/publication-unit/workspace");
    await createIsolatedRalphWorkspace(fixture.root, directWorkspace, directBaseline);
    const directWorkspaceBaseline = await snapshotRalphWorkspace(directWorkspace, ["src/first.txt", "src/second.txt"]);
    await mkdir(resolve(directWorkspace, "src"), { recursive: true });
    await writeFile(resolve(directWorkspace, "src/first.txt"), "authorized\n");
    await writeFile(resolve(directWorkspace, "src/second.txt"), "unowned\n");
    await expect(publishAcceptedTaskDelta({
      projectRoot: fixture.root,
      workspaceRoot: directWorkspace,
      runDirectory: resolve(directWorkspace, ".rb-harness/ralph/runs/publication-unit"),
      runId: "publication-unit",
      planId: authority.selectedPlan.id,
      taskId: "T001",
      attemptId: "publication-unit-attempt",
      taskOwnedPaths: ["src/first.txt"],
      allOwnedPaths: ["src/first.txt", "src/second.txt"],
      expectedHostBaseline: directBaseline,
      workspaceBaseline: directWorkspaceBaseline,
      revalidateReadiness: async () => authority.readinessDigest,
    })).rejects.toMatchObject({ code: "RALPH_BRIDGE_UNOWNED_PATH_WRITE" });
    await expect(readFile(resolve(fixture.root, "src/first.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("durably records terminal Executor failure without audit or publication", async () => {
    const fixture = await ready({ taskCount: 1 });
    let audits = 0;
    const result = await runProgressiveRalphBridgeV1(fixture.root, {
      ...ids("executor-failed"),
      runtimes: {
        executor: () => new ScriptedExecutor({ defaultScenario: { kind: "PROTOCOL_FAILURE_BEFORE_START", exitCode: 7 } }),
        auditor: () => { audits += 1; return new ScriptedAuditor({ defaultDecision: accept() }); },
      },
      validationProcessSupervisor: successfulValidation(),
    });
    expect(result.status).toBe("FAILED");
    expect(result.publicationOccurred).toBe(false);
    expect(audits).toBe(0);
    const store = new RalphEventStoreV2({ projectRoot: workspaceFromContext(fixture.root, "executor-failed"), runId: "executor-failed" });
    const events = (await store.inspect()).events;
    expect(events.some((event) => event.eventType === "attempt.closed" && event.payload.closureReason === "EXECUTOR_PROTOCOL_FAILURE")).toBe(true);
    expect(events.some((event) => event.eventType === "executor.finished")).toBe(false);
    expect(events.some((event) => event.eventType === "audit.started")).toBe(false);
    expect(events.some((event) => event.eventType === "run.failed")).toBe(true);
  }, 30_000);

  it("uses the frozen finding/correction lifecycle and publishes only the accepted correction", async () => {
    const fixture = await ready({ taskCount: 1 });
    const workspace = workspaceFromContext(fixture.root, "correction");
    const correctionFindingIds: string[][] = [];
    let executorCalls = 0;
    let auditorCalls = 0;
    const result = await runProgressiveRalphBridgeV1(fixture.root, {
      ...ids("correction"),
      runtimes: runtimes({
        action: async (context) => {
          executorCalls += 1;
          if (context.correctionContext) correctionFindingIds.push([...context.correctionContext.findingIds]);
          await writeImplementation(workspace, context.taskId, context.correctionContext ? "corrected\n" : "defective\n");
        },
        decide: (auditPackage) => {
          auditorCalls += 1;
          return auditPackage.openFindingRefs.length === 0
            ? {
              verdict: "REJECT",
              proposedFindings: [{ criterionId: "criterion-first", structuredFindingKey: "F1", severity: "BLOCKER", scope: ["src/first.txt"], expectation: "content is corrected", observed: "content is defective", remediationHint: "correct the file" }],
              resolvedFindingRefs: [], rationale: "correction required", metadata: {},
            }
            : { verdict: "ACCEPT", proposedFindings: [], resolvedFindingRefs: auditPackage.openFindingRefs.map((finding) => finding.findingId), rationale: "corrected", metadata: {} };
        },
      }),
      validationProcessSupervisor: successfulValidation(),
    });
    expect(result.errorCode, JSON.stringify(result)).toBeUndefined();
    expect(result).toMatchObject({ status: "COMPLETE", publicationOccurred: true });
    expect(executorCalls).toBe(2);
    expect(auditorCalls).toBe(2);
    expect(correctionFindingIds).toHaveLength(1);
    expect(correctionFindingIds[0]).toHaveLength(1);
    expect(await readFile(resolve(fixture.root, "src/first.txt"), "utf8")).toBe("corrected\n");
    const store = new RalphEventStoreV2({ projectRoot: workspace, runId: "correction" });
    const events = (await store.inspect()).events;
    expect(events.filter((event) => event.eventType === "attempt.started")).toHaveLength(2);
    expect(events.filter((event) => event.eventType === "finding.state-changed").map((event) => (event.payload as any).finding.status)).toEqual(["OPEN", "CANDIDATE_RESOLVED", "RESOLVED"]);
    const correctionSources = await Promise.all((await readdir(resolve(result.runPath, "attempts"))).map((attempt) =>
      readFile(resolve(result.runPath, "attempts", attempt, "correction-context.json"), "utf8").catch(() => "")));
    expect(correctionSources.some(Boolean)).toBe(true);
    expect(correctionSources.join("\n")).toContain(correctionFindingIds[0]![0]!);
  }, 30_000);

  it("stops at the frozen two-attempt correction budget with durable FAILED authority", async () => {
    const fixture = await ready({ taskCount: 1 });
    let executorCalls = 0;
    let auditorCalls = 0;
    const result = await runProgressiveRalphBridgeV1(fixture.root, {
      ...ids("budget"),
      runtimes: runtimes({
        action: async (context) => {
          executorCalls += 1;
          await writeImplementation(workspaceFromContext(fixture.root, "budget"), context.taskId, "still rejected\n");
        },
        decide: () => {
          auditorCalls += 1;
          return {
            verdict: "REJECT",
            proposedFindings: [{ criterionId: "criterion-first", structuredFindingKey: "F1", severity: "BLOCKER", scope: ["src/first.txt"], expectation: "content is accepted", observed: "content remains rejected", remediationHint: "correct the file" }],
            resolvedFindingRefs: [], rationale: "still rejected", metadata: {},
          };
        },
      }),
      validationProcessSupervisor: successfulValidation(),
    });
    expect(result).toMatchObject({ status: "FAILED", publicationOccurred: false, errorCode: "RALPH_BRIDGE_BUDGET_EXHAUSTED" });
    expect(executorCalls).toBe(2);
    expect(auditorCalls).toBe(2);
    await expect(readFile(resolve(fixture.root, "src/first.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    const events = (await new RalphEventStoreV2({ projectRoot: workspaceFromContext(fixture.root, "budget"), runId: "budget" }).inspect()).events;
    expect(events.filter((event) => event.eventType === "attempt.started")).toHaveLength(2);
    expect(events.at(-1)?.eventType).toBe("run.failed");
  }, 30_000);

  it("returns NEEDS_HUMAN without inventing evidence, auditing, or publishing", async () => {
    const fixture = await ready({ taskCount: 1, humanValidation: true });
    let audits = 0;
    const result = await runProgressiveRalphBridgeV1(fixture.root, {
      ...ids("human"),
      runtimes: runtimes({
        action: async (context) => writeImplementation(workspaceFromContext(fixture.root, "human"), context.taskId),
        decide: () => { audits += 1; return accept(); },
      }),
      validationProcessSupervisor: successfulValidation(),
    });
    expect(result).toMatchObject({ status: "NEEDS_HUMAN", publicationOccurred: false, errorCode: "RALPH_BRIDGE_HUMAN_EVIDENCE_REQUIRED" });
    expect(audits).toBe(0);
    await expect(readFile(resolve(fixture.root, "src/first.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    const state = JSON.parse(await readFile(resolve(result.runPath, "state/current.json"), "utf8")) as { readonly state: { readonly hold: string } };
    expect(state.state.hold).toBe("HUMAN_REQUIRED");
  }, 30_000);

  it("resolves a completed COMMAND artifact behind the ValidationSet barrier before discovering the Human boundary", async () => {
    const fixture = await ready({ taskCount: 4, humanValidationTask: 3, commandAndHumanValidationTask: 3 });
    const firstExecutors: string[] = [];
    const firstAuditors: string[] = [];
    const first = await runProgressiveRalphBridgeV1(fixture.root, {
      ...ids("human-command-barrier"),
      runtimes: runtimes({
        action: async (context) => {
          firstExecutors.push(context.taskId);
          await writeImplementation(workspaceFromContext(fixture.root, "human-command-barrier"), context.taskId);
        },
        decide: (auditPackage) => {
          firstAuditors.push(auditPackage.taskId);
          return accept();
        },
      }),
      validationProcessSupervisor: successfulValidation(),
    });
    expect(first).toMatchObject({
      status: "NEEDS_HUMAN",
      runId: "human-command-barrier",
      completedTaskCount: 2,
      remainingTaskCount: 2,
      errorCode: "RALPH_BRIDGE_HUMAN_EVIDENCE_REQUIRED",
      pendingHuman: { taskId: "T003", validationSpecId: "T003:validation:2" },
    });
    expect(firstExecutors).toEqual(["T001", "T002", "T003"]);
    expect(firstAuditors).toEqual(["T001", "T002"]);
    const firstStore = new RalphEventStoreV2({ projectRoot: workspaceFromContext(fixture.root, "human-command-barrier"), runId: first.runId });
    const firstBoundary = JSON.parse(await readFile(resolve(first.runPath, "state/current.json"), "utf8")) as { readonly state: any };
    const heldT003 = Object.values(firstBoundary.state.attempts as Record<string, any>).find((attempt: any) => attempt.taskId === "T003" && attempt.disposition === "OPEN") as any;
    expect(firstBoundary.state).toMatchObject({ hold: "HUMAN_REQUIRED" });
    expect(heldT003).toMatchObject({ stage: "AWAITING_HUMAN", disposition: "OPEN" });
    expect(heldT003.validationRuns).toEqual(expect.arrayContaining([
      expect.objectContaining({ validationSpecId: "T003:validation:1", outcome: "PENDING" }),
      expect.objectContaining({ validationSpecId: "T003:validation:2", outcome: "PENDING" }),
    ]));
    expect(await readValidationRunV2(firstStore, heldT003.attemptId, heldT003.validationRuns.find((run: any) => run.validationSpecId === "T003:validation:1").validationRunId)).toMatchObject({ kind: "COMMAND", outcome: "PASS", exitCode: 0 });
    expect((await firstStore.inspect()).events.filter((event) => event.eventType === "validation.completed" && event.taskId === "T003")).toHaveLength(0);

    const before = JSON.parse(await readFile(resolve(first.runPath, "state/current.json"), "utf8")) as { readonly state: any; readonly stateHash: string; readonly lastSequence: number };
    const beforeEvents = await new RalphEventStoreV2({ projectRoot: workspaceFromContext(fixture.root, "human-command-barrier"), runId: first.runId }).inspect();
    let coldExecutorCalls = 0;
    let coldAuditorCalls = 0;
    const cold = await runProgressiveRalphBridgeV1(fixture.root, {
      runtimes: {
        executor: () => { coldExecutorCalls += 1; return new ScriptedExecutor(); },
        auditor: () => { coldAuditorCalls += 1; return new ScriptedAuditor({ defaultDecision: accept() }); },
      },
      validationProcessSupervisor: successfulValidation(),
    });
    expect(cold).toMatchObject({
      status: "NEEDS_HUMAN",
      runId: first.runId,
      errorCode: "RALPH_BRIDGE_HUMAN_EVIDENCE_REQUIRED",
      pendingHuman: { taskId: "T003", validationSpecId: "T003:validation:2" },
    });
    expect(coldExecutorCalls).toBe(0);
    expect(coldAuditorCalls).toBe(0);
    const after = JSON.parse(await readFile(resolve(first.runPath, "state/current.json"), "utf8")) as { readonly state: any; readonly stateHash: string; readonly lastSequence: number };
    const afterEvents = await new RalphEventStoreV2({ projectRoot: workspaceFromContext(fixture.root, "human-command-barrier"), runId: first.runId }).inspect();
    expect(after.stateHash).toBe(before.stateHash);
    expect(after.lastSequence).toBe(before.lastSequence);
    expect(after.state).toEqual(before.state);
    expect(afterEvents.events).toHaveLength(beforeEvents.events.length);

    const continuationExecutors: string[] = [];
    const continuationAudits: string[] = [];
    const continued = await runProgressiveRalphBridgeV1(fixture.root, {
      runtimes: {
        executor: ({ authorizedInvocation }) => {
          continuationExecutors.push(authorizedInvocation.workUnit.taskId);
          return new ScriptedExecutor({ defaultScenario: {
            kind: "SUCCESS",
            fixtureWorkspaceAction: async (context) => {
              await writeImplementation(workspaceFromContext(fixture.root, "human-command-barrier"), context.taskId);
            },
          } });
        },
        auditor: () => new ScriptedAuditor({ decide: (auditPackage) => { continuationAudits.push(auditPackage.taskId); return accept(); } }),
      },
      validationProcessSupervisor: successfulValidation(),
    }, { humanDecision: "PASS" });
    expect(continued).toMatchObject({ status: "COMPLETE", runId: first.runId, completedTaskCount: 4, remainingTaskCount: 0 });
    expect(continuationExecutors).toEqual(["T004"]);
    expect(continuationAudits).toEqual(["T003", "T004"]);
    const store = new RalphEventStoreV2({ projectRoot: workspaceFromContext(fixture.root, "human-command-barrier"), runId: first.runId });
    const continuedState = JSON.parse(await readFile(resolve(continued.runPath, "state/current.json"), "utf8")) as { readonly state: any };
    expect(continuedState.state.attempts[heldT003.attemptId]).toMatchObject({ disposition: "CLOSED", closureReason: "AUDIT_ACCEPTED", taskId: "T003" });
    expect(continuedState.state.attempts[heldT003.attemptId].validationRuns).toEqual(expect.arrayContaining([
      expect.objectContaining({ validationSpecId: "T003:validation:1", outcome: "PASS" }),
      expect.objectContaining({ validationSpecId: "T003:validation:2", outcome: "PASS" }),
    ]));
    const events = (await store.inspect()).events;
    expect(events.filter((event) => event.eventType === "validation.completed" && event.taskId === "T003")).toHaveLength(2);
    expect(events.filter((event) => event.eventType === "audit.started" && event.taskId === "T003")).toHaveLength(1);
    expect(events.filter((event) => event.eventType === "attempt.human-required" && event.taskId === "T003")).toHaveLength(1);
  }, 60_000);

  it("continues the same durable run across processes with exact-bound OPERATOR_HUMAN PASS and still audits", async () => {
    const fixture = await ready({ taskCount: 4, humanValidationTask: 3 });
    const firstTrace: string[] = [];
    const first = await runProgressiveRalphBridgeV1(fixture.root, {
      ...ids("human-cross-process"),
      runtimes: runtimes({
        action: async (context) => {
          firstTrace.push(`executor:${context.taskId}`);
          await writeImplementation(workspaceFromContext(fixture.root, "human-cross-process"), context.taskId);
        },
        decide: (auditPackage) => { firstTrace.push(`auditor:${auditPackage.taskId}`); return accept(); },
      }),
      validationProcessSupervisor: successfulValidation(),
    });
    expect(first).toMatchObject({ status: "NEEDS_HUMAN", runId: "human-cross-process", completedTaskCount: 2, remainingTaskCount: 2 });
    expect(first.pendingHuman).toMatchObject({ taskId: "T003", taskTitle: "Write third implementation slice" });
    expect(first.pendingHuman?.instruction).toContain("keyboard and touch flows");
    expect(first.pendingHuman?.continuationPass).toContain("--human-decision pass");
    expect(first.pendingHuman?.continuationFail).toContain("--human-decision fail");
    expect(firstTrace).toEqual(["executor:T001", "auditor:T001", "executor:T002", "auditor:T002", "executor:T003"]);
    await expect(readFile(resolve(fixture.root, "src/third.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(resolve(fixture.root, "src/fourth.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await listBridgeRunDescriptors(fixture.root)).toHaveLength(1);
    expect(await inspectRalphBridgeStatusV1(fixture.root)).toMatchObject({ latestStatus: "NEEDS_HUMAN", pendingHuman: { taskId: "T003" } });

    const durableBefore = JSON.parse(await readFile(resolve(first.runPath, "state/current.json"), "utf8")) as { readonly state: any };
    const heldAttempt = Object.values(durableBefore.state.attempts as Record<string, any>).find((attempt: any) => attempt.taskId === "T003" && attempt.disposition === "OPEN") as any;
    const heldStore = new RalphEventStoreV2({ projectRoot: workspaceFromContext(fixture.root, "human-cross-process"), runId: first.runId });
    expect(await readExecutorObservationReceiptV2(heldStore, heldAttempt.attemptId)).toMatchObject({ attemptId: heldAttempt.attemptId, invocationId: heldAttempt.invocation.invocationId });
    expect(await readHumanValidationDecisionV2(heldStore, heldAttempt.attemptId, first.pendingHuman?.validationSpecId)).toBeUndefined();

    const continuationExecutors: string[] = [];
    const continuationExecutorFactories: string[] = [];
    const continuationAudits: string[] = [];
    const second = await runProgressiveRalphBridgeV1(fixture.root, {
      ...ids("human-continuation"),
      runtimes: {
        executor: ({ authorizedInvocation }) => {
          continuationExecutorFactories.push(authorizedInvocation.workUnit.taskId);
          return new ScriptedExecutor({ defaultScenario: {
            kind: "SUCCESS",
            fixtureWorkspaceAction: async (context) => {
              continuationExecutors.push(context.taskId);
              await writeImplementation(workspaceFromContext(fixture.root, "human-cross-process"), context.taskId);
            },
          } });
        },
        auditor: () => new ScriptedAuditor({ decide: (auditPackage) => { continuationAudits.push(auditPackage.taskId); return accept(); } }),
      },
      validationProcessSupervisor: successfulValidation(),
    }, { humanDecision: "PASS" });
    expect(second.errorCode, JSON.stringify(second)).toBeUndefined();
    expect(second).toMatchObject({ status: "COMPLETE", runId: first.runId, completedTaskCount: 4, remainingTaskCount: 0 });
    expect(await listBridgeRunDescriptors(fixture.root)).toHaveLength(1);
    expect(continuationExecutorFactories).toEqual(["T004"]);
    expect(continuationExecutors).toEqual(["T004"]);
    expect(continuationAudits).toEqual(["T003", "T004"]);
    const decision = await readHumanValidationDecisionV2(heldStore, heldAttempt.attemptId, first.pendingHuman?.validationSpecId);
    expect(decision).toMatchObject({ decision: "PASS", authority: { kind: "OPERATOR_HUMAN", authorityId: "rb-harness-cli-operator" }, humanRequestRef: first.pendingHuman?.humanRequestRef });
    const after = JSON.parse(await readFile(resolve(second.runPath, "state/current.json"), "utf8")) as { readonly state: any };
    const completedHeld = after.state.attempts[heldAttempt.attemptId];
    const completedHumanRef = completedHeld.validationRuns.find((run: any) => run.validationSpecId === first.pendingHuman?.validationSpecId && run.outcome === "PASS");
    expect(completedHumanRef).toBeDefined();
    expect(await readValidationRunV2(heldStore, heldAttempt.attemptId, completedHumanRef.validationRunId)).toMatchObject({ kind: "HUMAN", outcome: "PASS", diagnosticDigests: [decision?.decisionDigest] });
    expect((await heldStore.inspect()).events.filter((event) => event.eventType === "audit.started" && event.taskId === "T003")).toHaveLength(1);
    expect(await readFile(resolve(fixture.root, "src/third.txt"), "utf8")).toBe("third\n");
    expect(await readFile(resolve(fixture.root, "src/fourth.txt"), "utf8")).toBe("fourth\n");
    expect(await inspectRalphBridgeStatusV1(fixture.root)).toMatchObject({ latestStatus: "COMPLETE" });
  }, 60_000);

  it("persists exact-bound OPERATOR_HUMAN FAIL on the same run without accepted publication", async () => {
    const fixture = await ready({ taskCount: 1, humanValidation: true });
    const first = await runProgressiveRalphBridgeV1(fixture.root, {
      ...ids("human-fail"),
      runtimes: runtimes({ action: async (context) => writeImplementation(workspaceFromContext(fixture.root, "human-fail"), context.taskId), decide: accept }),
      validationProcessSupervisor: successfulValidation(),
    });
    expect(first.status).toBe("NEEDS_HUMAN");
    const firstSnapshot = JSON.parse(await readFile(resolve(first.runPath, "state/current.json"), "utf8")) as { readonly state: any };
    const heldBefore = Object.values(firstSnapshot.state.attempts as Record<string, any>).find((attempt: any) => attempt.disposition === "OPEN") as any;
    const continuationInvocationIds: string[] = [];
    let audits = 0;
    const second = await runProgressiveRalphBridgeV1(fixture.root, {
      ...ids("human-fail-continuation"),
      runtimes: {
        executor: ({ authorizedInvocation }) => {
          continuationInvocationIds.push(authorizedInvocation.descriptor.invocationId);
          return new ScriptedExecutor({ defaultScenario: { kind: "SUCCESS" } });
        },
        auditor: () => { audits += 1; return new ScriptedAuditor({ defaultDecision: accept() }); },
      },
      validationProcessSupervisor: successfulValidation(),
    }, { humanDecision: "FAIL" });
    expect(second.runId).toBe(first.runId);
    expect(second.status, JSON.stringify(second)).toBe("NEEDS_HUMAN");
    expect(second.publicationOccurred).toBe(false);
    expect(continuationInvocationIds).toHaveLength(1);
    expect(continuationInvocationIds).not.toContain(heldBefore.invocation.invocationId);
    expect(audits).toBe(1);
    const snapshot = JSON.parse(await readFile(resolve(second.runPath, "state/current.json"), "utf8")) as { readonly state: any };
    const store = new RalphEventStoreV2({ projectRoot: workspaceFromContext(fixture.root, "human-fail"), runId: first.runId });
    expect(Object.values(snapshot.state.attempts as Record<string, any>).filter((attempt: any) => attempt.disposition === "OPEN")).toHaveLength(1);
    expect(await readHumanValidationDecisionV2(store, heldBefore.attemptId, first.pendingHuman?.validationSpecId)).toMatchObject({ decision: "FAIL", authority: { kind: "OPERATOR_HUMAN" } });
    await expect(readFile(resolve(fixture.root, "src/first.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 45_000);

  it("resumes after a decision-only crash and rejects a conflicting immutable operator choice", async () => {
    const fixture = await ready({ taskCount: 1, humanValidation: true });
    const first = await runProgressiveRalphBridgeV1(fixture.root, {
      ...ids("human-decision-crash"),
      runtimes: runtimes({ action: async (context) => writeImplementation(workspaceFromContext(fixture.root, "human-decision-crash"), context.taskId), decide: accept }),
      validationProcessSupervisor: successfulValidation(),
    });
    expect(first.status).toBe("NEEDS_HUMAN");
    const state = JSON.parse(await readFile(resolve(first.runPath, "state/current.json"), "utf8")) as { readonly state: any };
    const attempt = Object.values(state.state.attempts as Record<string, any>).find((entry: any) => entry.disposition === "OPEN") as any;
    const spec = attempt.validationSpecs.find((entry: any) => entry.validationSpecId === first.pendingHuman?.validationSpecId);
    const request = createHumanValidationRequestV2({
      runId: first.runId,
      phaseId: attempt.phaseId,
      taskId: attempt.taskId,
      attemptId: attempt.attemptId,
      validationSpecId: spec.validationSpecId,
      validationSpecDigest: spec.digest,
    });
    const store = new RalphEventStoreV2({ projectRoot: workspaceFromContext(fixture.root, "human-decision-crash"), runId: first.runId });
    const trusted = await obtainTrustedHumanValidationDecisionV2(createOperatorHumanValidationAuthorityV2({
      authorityId: "operator-crash-boundary",
      request,
      decision: "PASS",
      decidedAt: "2026-09-11T12:00:00.000Z",
    }), request);
    await persistTrustedHumanValidationDecisionV2(store, trusted, "human-decision-crash-artifact");

    let runtimeCalls = 0;
    const conflict = await runProgressiveRalphBridgeV1(fixture.root, { runtimes: countingRuntimes(() => { runtimeCalls += 1; }) }, { humanDecision: "FAIL" });
    expect(conflict).toMatchObject({ status: "FAILED", runId: first.runId, errorCode: "RALPH_BRIDGE_HUMAN_DECISION_IMMUTABLE_CONFLICT" });
    expect(runtimeCalls).toBe(0);
    expect((await readHumanValidationDecisionV2(store, request.attemptId, request.validationSpecId))?.decision).toBe("PASS");

    let audits = 0;
    const resumed = await runProgressiveRalphBridgeV1(fixture.root, {
      runtimes: {
        executor: () => { runtimeCalls += 1; return new ScriptedExecutor({ defaultScenario: { kind: "SUCCESS" } }); },
        auditor: () => { audits += 1; return new ScriptedAuditor({ defaultDecision: accept() }); },
      },
      validationProcessSupervisor: successfulValidation(),
    });
    expect(resumed).toMatchObject({ status: "COMPLETE", runId: first.runId });
    expect(runtimeCalls).toBe(0);
    expect(audits).toBe(1);
    expect((await store.inspect()).events.filter((event) => event.eventType === "attempt.human-required")).toHaveLength(1);
    expect((await store.inspect()).events.filter((event) => event.eventType === "run.hold-cleared")).toHaveLength(1);
  }, 45_000);

  it("resumes an accepted Human task after a post-audit crash without repeating Executor or Auditor", async () => {
    const fixture = await ready({ taskCount: 1, humanValidation: true });
    const first = await runProgressiveRalphBridgeV1(fixture.root, {
      ...ids("human-post-audit-crash"),
      runtimes: runtimes({ action: async (context) => writeImplementation(workspaceFromContext(fixture.root, "human-post-audit-crash"), context.taskId), decide: accept }),
      validationProcessSupervisor: successfulValidation(),
    });
    expect(first.status).toBe("NEEDS_HUMAN");
    let passExecutorFactories = 0;
    let passAuditors = 0;
    const interrupted = await runProgressiveRalphBridgeV1(fixture.root, {
      stopAfterAcceptedTask: true,
      runtimes: {
        executor: () => { passExecutorFactories += 1; return new ScriptedExecutor(); },
        auditor: () => { passAuditors += 1; return new ScriptedAuditor({ defaultDecision: accept() }); },
      },
      validationProcessSupervisor: successfulValidation(),
    }, { humanDecision: "PASS" });
    expect(interrupted).toMatchObject({
      status: "INCOMPLETE_RESUMABLE",
      runId: first.runId,
      publicationOccurred: false,
      errorCode: "RALPH_BRIDGE_INTERRUPTED_AFTER_AUDIT",
    });
    expect(passExecutorFactories).toBe(0);
    expect(passAuditors).toBe(1);
    await expect(readFile(resolve(fixture.root, "src/first.txt"))).rejects.toMatchObject({ code: "ENOENT" });

    let resumedRuntimeFactories = 0;
    const complete = await runProgressiveRalphBridgeV1(fixture.root, {
      runtimes: countingRuntimes(() => { resumedRuntimeFactories += 1; }),
      validationProcessSupervisor: successfulValidation(),
    });
    expect(complete).toMatchObject({ status: "COMPLETE", runId: first.runId, publicationOccurred: true });
    expect(resumedRuntimeFactories).toBe(0);
    expect(await listBridgeRunDescriptors(fixture.root)).toHaveLength(1);
    expect(await readFile(resolve(fixture.root, "src/first.txt"), "utf8")).toBe("first\n");
  }, 45_000);

  it("resumes after Human validation.completed but before audit without repeating Executor or the Human prompt", async () => {
    const fixture = await ready({ taskCount: 1, humanValidation: true });
    const first = await runProgressiveRalphBridgeV1(fixture.root, {
      ...ids("human-pre-audit-crash"),
      runtimes: runtimes({ action: async (context) => writeImplementation(workspaceFromContext(fixture.root, "human-pre-audit-crash"), context.taskId), decide: accept }),
      validationProcessSupervisor: successfulValidation(),
    });
    expect(first.status).toBe("NEEDS_HUMAN");
    let executorFactories = 0;
    const interrupted = await runProgressiveRalphBridgeV1(fixture.root, {
      runtimes: {
        executor: () => { executorFactories += 1; return new ScriptedExecutor(); },
        auditor: () => { throw new Error("SIMULATED_CRASH_BEFORE_AUDIT"); },
      },
      validationProcessSupervisor: successfulValidation(),
    }, { humanDecision: "PASS" });
    expect(interrupted).toMatchObject({ status: "INCOMPLETE_RESUMABLE", runId: first.runId, errorCode: "SIMULATED_CRASH_BEFORE_AUDIT" });
    expect(executorFactories).toBe(0);
    const store = new RalphEventStoreV2({ projectRoot: workspaceFromContext(fixture.root, "human-pre-audit-crash"), runId: first.runId });
    const interruptedEvents = (await store.inspect()).events;
    expect(interruptedEvents.filter((event) => event.eventType === "validation.completed")).toHaveLength(1);
    expect(interruptedEvents.filter((event) => event.eventType === "audit.started")).toHaveLength(0);

    let resumedAuditors = 0;
    const complete = await runProgressiveRalphBridgeV1(fixture.root, {
      runtimes: {
        executor: () => { executorFactories += 1; return new ScriptedExecutor(); },
        auditor: () => { resumedAuditors += 1; return new ScriptedAuditor({ defaultDecision: accept() }); },
      },
      validationProcessSupervisor: successfulValidation(),
    });
    expect(complete).toMatchObject({ status: "COMPLETE", runId: first.runId, publicationOccurred: true });
    expect(executorFactories).toBe(0);
    expect(resumedAuditors).toBe(1);
    const completedEvents = (await store.inspect()).events;
    expect(completedEvents.filter((event) => event.eventType === "attempt.human-required")).toHaveLength(1);
    expect(completedEvents.filter((event) => event.eventType === "validation.completed")).toHaveLength(1);
    expect(completedEvents.filter((event) => event.eventType === "audit.started")).toHaveLength(1);
  }, 45_000);

  it("rejects a Human continuation before persistence when Progressive authority becomes stale", async () => {
    const fixture = await ready({ taskCount: 1, humanValidation: true });
    const first = await runProgressiveRalphBridgeV1(fixture.root, {
      ...ids("human-stale"),
      runtimes: runtimes({ action: async (context) => writeImplementation(workspaceFromContext(fixture.root, "human-stale"), context.taskId), decide: accept }),
      validationProcessSupervisor: successfulValidation(),
    });
    expect(first.status).toBe("NEEDS_HUMAN");
    await appendFile(resolve(fixture.root, ".spec/init/user-stories.md"), "\nstale before operator decision\n");
    let runtimeCalls = 0;
    const second = await runProgressiveRalphBridgeV1(fixture.root, { runtimes: countingRuntimes(() => { runtimeCalls += 1; }) }, { humanDecision: "PASS" });
    expect(second).toMatchObject({ status: "FAILED", runId: "none", publicationOccurred: false, errorCode: "RALPH_BRIDGE_PROGRESSIVE_NOT_READY" });
    expect(runtimeCalls).toBe(0);
    const state = JSON.parse(await readFile(resolve(first.runPath, "state/current.json"), "utf8")) as { readonly state: any };
    const attempt = Object.values(state.state.attempts as Record<string, any>)[0] as any;
    const store = new RalphEventStoreV2({ projectRoot: workspaceFromContext(fixture.root, "human-stale"), runId: first.runId });
    expect(await readHumanValidationDecisionV2(store, attempt.attemptId, first.pendingHuman?.validationSpecId)).toBeUndefined();
  }, 45_000);

  it("never redispatches a held Executor when its durable observation receipt is missing", async () => {
    const fixture = await ready({ taskCount: 1, humanValidation: true });
    const first = await runProgressiveRalphBridgeV1(fixture.root, {
      ...ids("human-missing-observation"),
      runtimes: runtimes({ action: async (context) => writeImplementation(workspaceFromContext(fixture.root, "human-missing-observation"), context.taskId), decide: accept }),
      validationProcessSupervisor: successfulValidation(),
    });
    expect(first.status).toBe("NEEDS_HUMAN");
    const snapshot = JSON.parse(await readFile(resolve(first.runPath, "state/current.json"), "utf8")) as { readonly state: any };
    const held = Object.values(snapshot.state.attempts as Record<string, any>).find((attempt: any) => attempt.disposition === "OPEN") as any;
    await unlink(resolve(first.runPath, "attempts", held.attemptId, "executor-observation-receipt.json"));
    let runtimeCalls = 0;
    const second = await runProgressiveRalphBridgeV1(fixture.root, {
      runtimes: countingRuntimes(() => { runtimeCalls += 1; }),
      validationProcessSupervisor: successfulValidation(),
    }, { humanDecision: "PASS" });
    expect(second).toMatchObject({
      status: "INCOMPLETE_RESUMABLE",
      runId: first.runId,
      publicationOccurred: false,
      errorCode: "B4_OBSERVATION_RECEIPT_REQUIRED",
    });
    expect(runtimeCalls).toBe(0);
    const store = new RalphEventStoreV2({ projectRoot: workspaceFromContext(fixture.root, "human-missing-observation"), runId: first.runId });
    expect(await readHumanValidationDecisionV2(store, held.attemptId, first.pendingHuman?.validationSpecId)).toBeUndefined();
    await expect(readFile(resolve(fixture.root, "src/first.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("fails closed for missing, non-Human, terminal, and changed-plan continuation states", async () => {
    const missing = await ready({ taskCount: 1 });
    let calls = 0;
    const noRun = await runProgressiveRalphBridgeV1(missing.root, { runtimes: countingRuntimes(() => { calls += 1; }) }, { humanDecision: "PASS" });
    expect(noRun).toMatchObject({ status: "FAILED", runId: "none", errorCode: "RALPH_BRIDGE_HUMAN_CONTINUATION_RUN_REQUIRED" });
    expect(calls).toBe(0);

    const nonHuman = await ready({ taskCount: 1 });
    const initialized = await runProgressiveRalphBridgeV1(nonHuman.root, { ...ids("non-human-continuation"), stopAfterInitialization: true });
    const notAwaiting = await runProgressiveRalphBridgeV1(nonHuman.root, { runtimes: countingRuntimes(() => { calls += 1; }) }, { humanDecision: "PASS" });
    expect(notAwaiting).toMatchObject({ status: "FAILED", runId: initialized.runId, errorCode: "RALPH_BRIDGE_HUMAN_PENDING_BOUNDARY_AMBIGUOUS" });
    expect(calls).toBe(0);

    const terminal = await ready({ taskCount: 1 });
    const complete = await runProgressiveRalphBridgeV1(terminal.root, {
      ...ids("terminal-human"),
      runtimes: runtimes({ action: async (context) => writeImplementation(workspaceFromContext(terminal.root, "terminal-human"), context.taskId), decide: accept }),
      validationProcessSupervisor: successfulValidation(),
    });
    expect(complete.status).toBe("COMPLETE");
    const afterComplete = await runProgressiveRalphBridgeV1(terminal.root, {}, { humanDecision: "PASS" });
    expect(afterComplete).toMatchObject({ status: "FAILED", runId: complete.runId, errorCode: "RALPH_BRIDGE_HUMAN_CONTINUATION_TERMINAL_RUN" });

    const changed = await ready({ taskCount: 1, humanValidation: true });
    const held = await runProgressiveRalphBridgeV1(changed.root, {
      ...ids("changed-plan-human"),
      runtimes: runtimes({ action: async (context) => writeImplementation(workspaceFromContext(changed.root, "changed-plan-human"), context.taskId), decide: accept }),
      validationProcessSupervisor: successfulValidation(),
    });
    const descriptorPath = resolve(changed.root, ".rb-harness/ralph/bridge-runs/changed-plan-human/bridge-run.json");
    const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
    descriptor.plan.sha256 = "f".repeat(64);
    const { descriptorDigest: _oldDigest, ...descriptorBase } = descriptor;
    descriptor.descriptorDigest = sha256Canonical(descriptorBase);
    await writeFile(descriptorPath, JSON.stringify(descriptor));
    const changedResult = await runProgressiveRalphBridgeV1(changed.root, { runtimes: countingRuntimes(() => { calls += 1; }) }, { humanDecision: "PASS" });
    expect(changedResult).toMatchObject({ status: "BLOCKED", runId: held.runId, errorCode: "RALPH_BRIDGE_EXISTING_RUN_AUTHORITY_MISMATCH" });
    expect(calls).toBe(0);
  }, 90_000);

  it("fails closed when a developer concurrently updates the same existing owned file", async () => {
    const fixture = await ready({ taskCount: 1 });
    await writeFile(resolve(fixture.root, "src/first.txt"), "existing baseline\n");
    const external = "developer concurrent edit\n";
    const result = await runProgressiveRalphBridgeV1(fixture.root, {
      ...ids("concurrent"),
      runtimes: runtimes({ action: async (context) => writeImplementation(workspaceFromContext(fixture.root, "concurrent"), context.taskId), decide: accept }),
      validationProcessSupervisor: successfulValidation(),
      beforePublication: async () => writeFile(resolve(fixture.root, "src/first.txt"), external),
    });
    expect(result).toMatchObject({ status: "FAILED", publicationOccurred: false, errorCode: "RALPH_BRIDGE_PROJECT_CONCURRENT_MODIFICATION" });
    expect(await readFile(resolve(fixture.root, "src/first.txt"), "utf8")).toBe(external);
    expect((await inspectHostPublicationOutcome(result.runPath)).rejected?.reason).toBe("RALPH_BRIDGE_PROJECT_CONCURRENT_MODIFICATION");
  }, 30_000);

  it("detects an initialized incomplete same-plan run and refuses a duplicate restart", async () => {
    const fixture = await ready({ taskCount: 1 });
    const first = await runProgressiveRalphBridgeV1(fixture.root, { ...ids("crash"), stopAfterInitialization: true });
    expect(first).toMatchObject({ status: "INCOMPLETE_RESUMABLE", runId: "crash", publicationOccurred: false });
    let runtimeCalls = 0;
    const second = await runProgressiveRalphBridgeV1(fixture.root, {
      ...ids("duplicate"),
      runtimes: countingRuntimes(() => { runtimeCalls += 1; }),
    });
    expect(second).toMatchObject({ status: "INCOMPLETE_RESUMABLE", runId: "crash", errorCode: "RALPH_BRIDGE_EXISTING_INCOMPLETE_RUN" });
    expect(runtimeCalls).toBe(0);
    expect(await readdir(resolve(fixture.root, ".rb-harness/ralph/bridge-runs"))).toEqual(["crash"]);
  }, 30_000);

  it("rejects symlink workspace tricks before bounded publication", async () => {
    const fixture = await ready({ taskCount: 1 });
    const authority = await loadProgressiveExecutionAuthority(fixture.root);
    const host = await snapshotHostImplementation(fixture.root, ["src/first.txt"]);
    const workspace = resolve(fixture.root, ".rb-harness/ralph/bridge-runs/symlink/workspace");
    await createIsolatedRalphWorkspace(fixture.root, workspace, host);
    await mkdir(resolve(workspace, "src"), { recursive: true });
    await symlink(resolve(fixture.root, "README.md"), resolve(workspace, "src/first.txt"));
    await expect(snapshotRalphWorkspace(workspace, Object.values(authority.ownedPathsByTask).flat())).rejects.toMatchObject({ code: "RALPH_BRIDGE_SYMLINK_UNSAFE" });
  }, 30_000);

  it("exposes the exact top-level --ralph UX and status metadata without a dashboard redesign", async () => {
    expect(harnessCommandSurface()["rb-harness"]).toEqual(expect.arrayContaining(["--ralph", "--human-decision"]));
    expect(harnessCommandSurface()["rb-harness"]).not.toEqual(expect.arrayContaining(["--project", "--json"]));
    expect(() => assertRalphRootCliArgs(["--ralph", "--project", "/tmp/project", "--json"])).not.toThrow();
    expect(() => assertRalphRootCliArgs(["--ralph", "--project", "/tmp/project", "--human-decision", "pass"])).not.toThrow();
    expect(() => assertRalphRootCliArgs(["--ralph", "--project", "/tmp/project", "--human-decision", "fail"])).not.toThrow();
    expect(() => assertRalphRootCliArgs(["--ralph", "--project", "/tmp/project", "--human-decision", "PASS"])).toThrow("RALPH_CLI_HUMAN_DECISION_INVALID");
    expect(() => assertRalphRootCliArgs(["--ralph", "--project", "/tmp/project", "--human-decision", "maybe"])).toThrow("RALPH_CLI_HUMAN_DECISION_INVALID");
    expect(() => assertRalphRootCliArgs(["--ralph", "--project", "/tmp/project", "--human-decision"])).toThrow("RALPH_CLI_HUMAN_DECISION_INVALID");
    expect(() => assertRalphRootCliArgs(["--ralph"])).toThrow("RALPH_CLI_PROJECT_REQUIRED");
    expect(() => assertRalphRootCliArgs(["--ralph", "status"])).toThrow("RALPH_CLI_MODE_CONFLICT");
    expect(() => assertRalphRootCliArgs(["--ralph", "--init"])).toThrow("RALPH_CLI_MODE_CONFLICT");
    const fixture = await ready({ taskCount: 1 });
    expect(await inspectRalphBridgeStatusV1(fixture.root)).toEqual({ state: "no run" });
    const authority = await loadProgressiveExecutionAuthority(fixture.root);
    expect(authority.selectedPlan.id).toContain("execution");
  }, 30_000);
});

async function ready(options: Parameters<typeof createReadyBridgeFixture>[0]) {
  const fixture = await createReadyBridgeFixture(options);
  roots.push(fixture.root);
  return fixture;
}

function ids(runId: string) {
  let ordinal = 0;
  return {
    runIdFactory: () => runId,
    nonceFactory: () => `nonce-${runId}-${++ordinal}`,
    eventIdFactory: () => `event-${runId}-${++ordinal}`,
    attemptIdFactory: () => `attempt-${runId}-${++ordinal}`,
  };
}

function workspaceFromContext(root: string, runId: string): string {
  return resolve(root, ".rb-harness/ralph/bridge-runs", runId, "workspace");
}

async function writeImplementation(workspace: string, taskId: string, content?: string): Promise<void> {
  await mkdir(resolve(workspace, "src"), { recursive: true });
  const names: Record<string, string> = { T001: "first", T002: "second", T003: "third", T004: "fourth" };
  const name = names[taskId];
  if (!name) throw new Error(`unexpected task ${taskId}`);
  await writeFile(resolve(workspace, `src/${name}.txt`), content ?? `${name}\n`);
}

function runtimes(options: {
  readonly action: ScriptedWorkspaceActionV2;
  readonly decide: (auditPackage: AuditPackageV2) => ScriptedAuditorDecisionV2;
  readonly onWorkUnit?: (workUnit: Parameters<BridgeRuntimeFactoriesV1["executor"]>[0]["authorizedInvocation"]["workUnit"]) => void;
}): BridgeRuntimeFactoriesV1 {
  return {
    executor: ({ authorizedInvocation }) => {
      options.onWorkUnit?.(authorizedInvocation.workUnit);
      return new ScriptedExecutor({ defaultScenario: { kind: "SUCCESS", fixtureWorkspaceAction: options.action } });
    },
    auditor: () => new ScriptedAuditor({ decide: options.decide }),
  };
}

function countingRuntimes(onCall: () => void): BridgeRuntimeFactoriesV1 {
  return {
    executor: () => { onCall(); return new ScriptedExecutor({ defaultScenario: { kind: "SUCCESS" } }); },
    auditor: () => { onCall(); return new ScriptedAuditor({ defaultDecision: accept() }); },
  };
}

function accept(): ScriptedAuditorDecisionV2 {
  return { verdict: "ACCEPT", proposedFindings: [], resolvedFindingRefs: [], rationale: "fixture accepted", metadata: {} };
}

function successfulValidation(commands: string[] = []): ValidationProcessSupervisorV2Like {
  return {
    run: async (input: ValidationProcessInputV2): Promise<ValidationProcessResultV2> => {
      commands.push(input.command);
      return {
        stdout: "fixture validation passed\n",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        exitCode: 0,
        signal: null,
        infrastructureStatus: "NONE",
        timedOut: false,
        cancelled: false,
        startedAt: "2026-09-10T00:00:01.000Z",
        finishedAt: "2026-09-10T00:00:01.010Z",
      };
    },
  };
}
