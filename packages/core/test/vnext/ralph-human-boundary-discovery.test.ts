import { cp, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  discoverPendingHuman,
  runProgressiveRalphBridgeV1,
  type BridgeRuntimeFactoriesV1,
} from "../../src/vnext/ralph-bridge/index.js";
import { RalphEventStoreV2 } from "../../src/vnext/ralph-runtime/operational-b1/index.js";
import { canonicalJson } from "../../src/vnext/ralph-runtime/canonical-json.js";
import {
  readWorkUnitV2,
  workUnitPathV2,
  type WorkUnitV2,
} from "../../src/vnext/ralph-runtime/operational-b3/index.js";
import {
  createValidationRunV2,
  humanValidationRequestRefV2,
  persistValidationRunV2,
  readValidationRunV2,
  validationRunIdV2,
  type ValidationRunV2,
} from "../../src/vnext/ralph-runtime/operational-d/index.js";
import { parseValidationSpec } from "../../src/vnext/ralph-runtime/operational-v2/validation.js";
import type {
  AttemptStateV2,
  RalphRuntimeStateV2,
  ValidationRunRef,
  ValidationSpecRef,
} from "../../src/vnext/ralph-runtime/operational-v2/index.js";
import { sha256Canonical } from "../../src/vnext/ralph-runtime/hashing.js";
import type { ValidationProcessInputV2, ValidationProcessResultV2, ValidationProcessSupervisorV2Like } from "../../src/vnext/ralph-runtime/operational-d/index.js";
import { ScriptedExecutor } from "../../src/vnext/ralph-runtime/operational-b4/index.js";
import { ScriptedAuditor } from "../../src/vnext/ralph-runtime/operational-e/index.js";
import {
  createReadyBridgeFixture,
} from "./fixtures/progressive-ready-bridge-fixture.js";

/**
 * These tests operate on a copied, deterministic bridge run.  The copy is
 * deliberately kept outside the preserved real E2E project and no provider
 * runtime is ever constructed by the discovery tests.
 */
describe("Ralph bridge Human pending-boundary discovery", () => {
  let base: BoundaryBase;

  beforeAll(async () => {
    const fixture = await createReadyBridgeFixture({ taskCount: 4, humanValidationTask: 3, commandAndHumanValidationTask: 3 });
    const runId = "human-boundary-discovery-base";
    const first = await runProgressiveRalphBridgeV1(fixture.root, {
      runIdFactory: () => runId,
      nonceFactory: (() => { let n = 0; return () => `boundary-nonce-${++n}`; })(),
      eventIdFactory: (() => { let n = 0; return () => `boundary-event-${++n}`; })(),
      attemptIdFactory: (() => { let n = 0; return () => `boundary-attempt-${++n}`; })(),
      runtimes: boundaryRuntimes(fixture.root, runId),
      validationProcessSupervisor: successfulValidation(),
    });
    expect(first).toMatchObject({
      status: "NEEDS_HUMAN",
      runId,
      errorCode: "RALPH_BRIDGE_HUMAN_EVIDENCE_REQUIRED",
      pendingHuman: { taskId: "T003", validationSpecId: "T003:validation:2" },
    });
    const snapshot = JSON.parse(await readFile(resolve(first.runPath, "state/current.json"), "utf8")) as { readonly state: RalphRuntimeStateV2 };
    const state = snapshot.state;
    const attempt = Object.values(state.attempts).find((candidate) => candidate.taskId === "T003" && candidate.disposition === "OPEN");
    if (!attempt) throw new Error("missing boundary attempt");
    const store = new RalphEventStoreV2({ projectRoot: workspaceRoot(fixture.root, runId), runId });
    const workUnit = await readWorkUnitV2(store, attempt.attemptId);
    if (!workUnit) throw new Error("missing boundary WorkUnit");
    base = { fixtureRoot: fixture.root, runId, state, attempt, workUnit };
    sharedBase = base;
  }, 60_000);

  afterAll(async () => {
    await Promise.all(copyRoots.map((root) => rm(root, { recursive: true, force: true })));
    if (base) await rm(base.fixtureRoot, { recursive: true, force: true });
  });

  it("A: resolves a PENDING COMMAND ref with a valid PASS artifact and returns the exact Human", async () => {
    const context = await copyBoundary();
    const discovered = await discoverPendingHuman(context.store, context.state, context.root);
    expect(discovered.request).toMatchObject({
      runId: context.state.runId,
      attemptId: context.attempt.attemptId,
      validationSpecId: "T003:validation:2",
      validationSpecDigest: context.workUnit.validationSpecRefs[1]?.digest,
    });
    expect(discovered.display.instruction).toContain("keyboard and touch flows");
  }, 30_000);

  it("B: ignores multiple completed PENDING refs with valid artifacts and finds the one Human", async () => {
    const context = await copyBoundary();
    const extraCommand = spec(context.workUnit, "COMMAND", 3);
    const extraRef = pendingRef(context, extraCommand, 3, "2026-09-10T00:00:03.000Z");
    await materialize(context, extraRef, extraCommand);
    await replaceWorkUnit(context, [...context.workUnit.validationSpecRefs, extraCommand]);
    replaceAttempt(context, [...context.attempt.validationSpecs, extraCommand], [...context.attempt.validationRuns, extraRef]);
    const discovered = await discoverPendingHuman(context.store, context.state, context.root);
    expect(discovered.display.validationSpecId).toBe("T003:validation:2");
  }, 30_000);

  it("C: resolves an earlier completed Human and selects the later unresolved Human", async () => {
    const context = await copyBoundary();
    const currentHuman = context.workUnit.validationSpecRefs.find((candidate) => candidate.kind === "HUMAN");
    if (!currentHuman) throw new Error("missing current Human spec");
    const currentHumanRef = context.attempt.validationRuns.find((candidate) => candidate.validationSpecId === currentHuman.validationSpecId);
    if (!currentHumanRef) throw new Error("missing current Human ref");
    await materialize(context, currentHumanRef, currentHuman);
    const laterHuman = spec(context.workUnit, "HUMAN", 3);
    const laterRef = pendingRef(context, laterHuman, 3, "2026-09-10T00:00:03.000Z");
    await replaceWorkUnit(context, [...context.workUnit.validationSpecRefs, laterHuman]);
    replaceAttempt(context, [...context.attempt.validationSpecs, laterHuman], [...context.attempt.validationRuns, laterRef]);
    await addProofFor(context, laterHuman.validationSpecId);
    const discovered = await discoverPendingHuman(context.store, context.state, context.root);
    expect(discovered.display.validationSpecId).toBe(laterHuman.validationSpecId);
    expect(discovered.display.humanRequestRef).toBe(humanValidationRequestRefV2(context.state.runId, context.attempt.attemptId, laterHuman.validationSpecId));
  }, 30_000);

  it("D: fails closed when a prior COMMAND PENDING ref has no result artifact", async () => {
    const context = await copyBoundary();
    const command = context.attempt.validationRuns.find((candidate) => candidate.validationSpecId === "T003:validation:1");
    if (!command) throw new Error("missing command ref");
    await unlink(join(context.store.runDirectory, "attempts", context.attempt.attemptId, `validation-run-${command.validationRunId}.json`));
    await expect(discoverPendingHuman(context.store, context.state, context.root)).rejects.toThrow("RALPH_BRIDGE_HUMAN_PENDING_BOUNDARY_AMBIGUOUS");
  }, 30_000);

  it("E: fails closed for a foreign ValidationRun artifact even when its own digest is valid", async () => {
    const context = await copyBoundary();
    const command = context.attempt.validationRuns.find((candidate) => candidate.validationSpecId === "T003:validation:1");
    const artifact = command && await readValidationRunV2(context.store, context.attempt.attemptId, command.validationRunId);
    if (!command || !artifact) throw new Error("missing command artifact");
    const { runDigest: _oldDigest, ...foreignBase } = artifact;
    const foreign = { ...foreignBase, runId: "foreign-run", runDigest: "" } as Omit<ValidationRunV2, "runDigest"> & { runDigest: string };
    const foreignWithDigest = { ...foreign, runDigest: digestWithoutRunDigest(foreign) };
    await writeFile(join(context.store.runDirectory, "attempts", context.attempt.attemptId, `validation-run-${command.validationRunId}.json`), canonicalJson(foreignWithDigest), { mode: 0o600 });
    await expect(discoverPendingHuman(context.store, context.state, context.root)).rejects.toThrow("RALPH_BRIDGE_HUMAN_PENDING_BOUNDARY_AMBIGUOUS");
  }, 30_000);

  it("F/G: requires one exact attempt.human-required proof bound to the active spec", async () => {
    const missing = await copyBoundary();
    await overrideInspectionEvents(missing, (events) => events.filter((event) => event.eventType !== "attempt.human-required"));
    await expect(discoverPendingHuman(missing.store, missing.state, missing.root)).rejects.toThrow("RALPH_BRIDGE_HUMAN_REQUEST_PROOF_MISMATCH");

    const wrong = await copyBoundary();
    await overrideInspectionEvents(wrong, (events) => events.map((event) => event.eventType === "attempt.human-required"
      ? { ...event, payload: { ...event.payload, proofRef: humanValidationRequestRefV2(wrong.state.runId, wrong.attempt.attemptId, "T003:validation:999") } }
      : event));
    await expect(discoverPendingHuman(wrong.store, wrong.state, wrong.root)).rejects.toThrow("RALPH_BRIDGE_HUMAN_REQUEST_PROOF_MISMATCH");
  }, 30_000);

  it("H: fails closed when two Human refs are genuinely unresolved", async () => {
    const context = await copyBoundary();
    const laterHuman = spec(context.workUnit, "HUMAN", 3);
    const laterRef = pendingRef(context, laterHuman, 3, "2026-09-10T00:00:03.000Z");
    await replaceWorkUnit(context, [...context.workUnit.validationSpecRefs, laterHuman]);
    replaceAttempt(context, [...context.attempt.validationSpecs, laterHuman], [...context.attempt.validationRuns, laterRef]);
    await expect(discoverPendingHuman(context.store, context.state, context.root)).rejects.toThrow("RALPH_BRIDGE_HUMAN_PENDING_BOUNDARY_AMBIGUOUS");
  }, 30_000);

  it("I: fails closed when HUMAN_REQUIRED has zero unresolved Human refs", async () => {
    const context = await copyBoundary();
    const human = context.workUnit.validationSpecRefs.find((candidate) => candidate.kind === "HUMAN");
    const humanRef = human && context.attempt.validationRuns.find((candidate) => candidate.validationSpecId === human.validationSpecId);
    if (!human || !humanRef) throw new Error("missing Human boundary");
    await materialize(context, humanRef, human);
    await expect(discoverPendingHuman(context.store, context.state, context.root)).rejects.toThrow("RALPH_BRIDGE_HUMAN_PENDING_BOUNDARY_AMBIGUOUS");
  }, 30_000);

  it("J: fails closed for a tampered ValidationRun digest/binding", async () => {
    const context = await copyBoundary();
    const command = context.attempt.validationRuns.find((candidate) => candidate.validationSpecId === "T003:validation:1");
    if (!command) throw new Error("missing command ref");
    const path = join(context.store.runDirectory, "attempts", context.attempt.attemptId, `validation-run-${command.validationRunId}.json`);
    const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    parsed.runDigest = `sha256:${"0".repeat(64)}`;
    await writeFile(path, canonicalJson(parsed), { mode: 0o600 });
    await expect(discoverPendingHuman(context.store, context.state, context.root)).rejects.toThrow("RALPH_BRIDGE_HUMAN_PENDING_BOUNDARY_AMBIGUOUS");
  }, 30_000);

  it("audit discriminator A: fails closed when ValidationRun validationSpecDigest does not match its bound spec", async () => {
    const context = await copyBoundary();
    const command = context.attempt.validationRuns.find((candidate) => candidate.validationSpecId === "T003:validation:1");
    if (!command) throw new Error("missing command ref");
    await rewriteValidationRun(context, command, (artifact) => ({
      ...artifact,
      validationSpecDigest: sha256Canonical({ discriminator: "foreign-validation-spec-digest" }),
    }));
    await expect(discoverPendingHuman(context.store, context.state, context.root)).rejects.toThrow("RALPH_BRIDGE_HUMAN_PENDING_BOUNDARY_AMBIGUOUS");
  }, 30_000);

  it("audit discriminator B: fails closed when ValidationRun kind does not match its bound spec kind", async () => {
    const context = await copyBoundary();
    const command = context.attempt.validationRuns.find((candidate) => candidate.validationSpecId === "T003:validation:1");
    if (!command) throw new Error("missing command ref");
    await rewriteValidationRun(context, command, (artifact) => ({ ...artifact, kind: "HUMAN" }));
    await expect(discoverPendingHuman(context.store, context.state, context.root)).rejects.toThrow("RALPH_BRIDGE_HUMAN_PENDING_BOUNDARY_AMBIGUOUS");
  }, 30_000);

  it("audit discriminator C: fails closed when ValidationRun validationSpecId does not match its bound spec", async () => {
    const context = await copyBoundary();
    const command = context.attempt.validationRuns.find((candidate) => candidate.validationSpecId === "T003:validation:1");
    if (!command) throw new Error("missing command ref");
    await rewriteValidationRun(context, command, (artifact) => ({ ...artifact, validationSpecId: "T003:validation:999" }));
    await expect(discoverPendingHuman(context.store, context.state, context.root)).rejects.toThrow("RALPH_BRIDGE_HUMAN_PENDING_BOUNDARY_AMBIGUOUS");
  }, 30_000);

  it("audit discriminator D: gives Human-looking instruction prose zero authority over bound kind and identity", async () => {
    const context = await copyBoundary();
    const human = context.workUnit.validationSpecRefs.find((candidate) => candidate.kind === "HUMAN");
    const humanRef = human && context.attempt.validationRuns.find((candidate) => candidate.validationSpecId === human.validationSpecId);
    if (!human || !humanRef) throw new Error("missing Human boundary");
    await materialize(context, humanRef, human);

    const command = spec(context.workUnit, "COMMAND", 3);
    const { digest: _commandDigest, ...commandDescriptor } = command;
    const humanLookingCommandDescriptor = { ...commandDescriptor, instruction: human.instruction };
    const humanLookingCommand: ValidationSpecRef = {
      ...humanLookingCommandDescriptor,
      digest: sha256Canonical(humanLookingCommandDescriptor),
    };
    const humanLookingCommandRef = pendingRef(context, humanLookingCommand, 3, "2026-09-10T00:00:03.000Z");
    await replaceWorkUnit(context, [...context.workUnit.validationSpecRefs, humanLookingCommand]);
    replaceAttempt(context, [...context.attempt.validationSpecs, humanLookingCommand], [...context.attempt.validationRuns, humanLookingCommandRef]);
    await addProofFor(context, humanLookingCommand.validationSpecId);

    await expect(discoverPendingHuman(context.store, context.state, context.root)).rejects.toThrow("RALPH_BRIDGE_HUMAN_PENDING_BOUNDARY_AMBIGUOUS");
  }, 30_000);
});

interface BoundaryBase {
  readonly fixtureRoot: string;
  readonly runId: string;
  readonly state: RalphRuntimeStateV2;
  readonly attempt: AttemptStateV2;
  readonly workUnit: WorkUnitV2;
}

interface BoundaryCopy extends BoundaryBase {
  readonly root: string;
  readonly store: RalphEventStoreV2;
}

let sharedBase!: BoundaryBase;
const copyRoots: string[] = [];

function workspaceRoot(root: string, runId: string): string {
  return resolve(root, ".rb-harness", "ralph", "bridge-runs", runId, "workspace");
}

function boundaryRuntimes(root: string, runId: string): BridgeRuntimeFactoriesV1 {
  return {
    executor: () => new ScriptedExecutor({ defaultScenario: {
      kind: "SUCCESS",
      fixtureWorkspaceAction: async ({ taskId }) => {
        const names: Record<string, string> = { T001: "first", T002: "second", T003: "third", T004: "fourth" };
        await mkdir(resolve(workspaceRoot(root, runId), "src"), { recursive: true });
        await writeFile(resolve(workspaceRoot(root, runId), "src", `${names[taskId]}.txt`), `${taskId}\n`);
      },
    } }),
    auditor: () => new ScriptedAuditor({ defaultDecision: {
      verdict: "ACCEPT",
      proposedFindings: [],
      resolvedFindingRefs: [],
      rationale: "boundary fixture accepted",
      metadata: {},
    } }),
  };
}

function successfulValidation(): ValidationProcessSupervisorV2Like {
  return {
    run: async (_input: ValidationProcessInputV2): Promise<ValidationProcessResultV2> => ({
      stdout: "fixture validation passed\n",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      exitCode: 0,
      signal: null,
      infrastructureStatus: "NONE" as const,
      timedOut: false,
      cancelled: false,
      startedAt: "2026-09-10T00:00:01.000Z",
      finishedAt: "2026-09-10T00:00:01.010Z",
    }),
  };
}

async function copyBoundary(): Promise<BoundaryCopy> {
  const root = await mkdtemp(resolve(tmpdir(), "rb-human-boundary-copy-"));
  copyRoots.push(root);
  await cp(sharedBase.fixtureRoot, root, { recursive: true });
  const state = structuredClone(sharedBase.state) as RalphRuntimeStateV2;
  const attempt = state.attempts[sharedBase.attempt.attemptId]!;
  const store = new RalphEventStoreV2({ projectRoot: workspaceRoot(root, sharedBase.runId), runId: sharedBase.runId });
  const workUnit = (await readWorkUnitV2(store, attempt.attemptId))!;
  return { ...sharedBase, root, state, attempt, store, workUnit };
}

async function replaceWorkUnit(context: BoundaryCopy, validationSpecRefs: readonly ValidationSpecRef[]): Promise<void> {
  const path = workUnitPathV2(context.store, context.attempt.attemptId);
  const current = JSON.parse(await readFile(path, "utf8")) as WorkUnitV2;
  const { workUnitDigest: _oldDigest, ...withoutDigest } = current;
  const nextBase = { ...withoutDigest, validationSpecRefs };
  const next = { ...nextBase, workUnitDigest: digestWithoutRunDigest(nextBase) };
  await writeFile(path, canonicalJson(next), { mode: 0o600 });
  (context as { workUnit: WorkUnitV2 }).workUnit = next;
}

function replaceAttempt(context: BoundaryCopy, validationSpecs: readonly ValidationSpecRef[], validationRuns: readonly ValidationRunRef[]): void {
  const attempts = context.state.attempts as Record<string, AttemptStateV2>;
  const replacement = { ...context.attempt, validationSpecs, validationRuns };
  attempts[context.attempt.attemptId] = replacement;
  (context as { attempt: AttemptStateV2 }).attempt = replacement;
}

function spec(workUnit: WorkUnitV2, kind: "COMMAND" | "HUMAN", ordinal: number): ValidationSpecRef {
  return parseValidationSpec(kind === "HUMAN" ? `human: deterministic boundary check ${ordinal}` : "`printf deterministic boundary`", {
    taskId: workUnit.taskId,
    planIdentity: workUnit.planIdentity,
    ordinal,
  });
}

function pendingRef(context: BoundaryCopy, validationSpec: ValidationSpecRef, ordinal: number, startedAt: string): ValidationRunRef {
  return {
    validationRunId: validationRunIdV2(context.state.runId, context.attempt.attemptId, validationSpec, ordinal),
    validationSpecId: validationSpec.validationSpecId,
    validationSpecDigest: validationSpec.digest,
    validationRunOrdinal: ordinal,
    startedAt,
    outcome: "PENDING",
  };
}

async function materialize(context: BoundaryCopy, ref: ValidationRunRef, validationSpec: ValidationSpecRef): Promise<ValidationRunV2> {
  const artifact = createValidationRunV2({
    runId: context.state.runId,
    phaseId: context.attempt.phaseId,
    taskId: context.attempt.taskId,
    attemptId: context.attempt.attemptId,
    validationSpecId: validationSpec.validationSpecId,
    validationSpecDigest: validationSpec.digest,
    validationRunId: ref.validationRunId,
    validationRunOrdinal: ref.validationRunOrdinal,
    kind: validationSpec.kind,
    instruction: validationSpec.instruction,
    startedAt: ref.startedAt,
    finishedAt: ref.endedAt ?? "2026-09-10T00:00:03.010Z",
    semanticStatus: validationSpec.kind === "HUMAN" ? "PASS" : validationSpec.kind === "COMMAND" ? "PASS" : "UNPROVEN",
    infrastructureStatus: "NONE",
    outcome: validationSpec.kind === "HUMAN" || validationSpec.kind === "COMMAND" ? "PASS" : "NOT_APPLICABLE",
    exitCode: validationSpec.kind === "COMMAND" ? 0 : null,
    signal: null,
    timedOut: false,
    cancelled: false,
    diagnosticRefs: [],
    diagnosticDigests: [],
    preValidationFingerprint: context.attempt.attemptBaseFingerprint,
    postValidationFingerprint: context.attempt.postExecutorFingerprint ?? context.attempt.attemptBaseFingerprint,
  });
  await persistValidationRunV2(context.store, artifact, `boundary-artifact-${validationSpec.ordinal}`);
  return artifact;
}

async function rewriteValidationRun(
  context: BoundaryCopy,
  ref: ValidationRunRef,
  transform: (artifact: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  const path = join(context.store.runDirectory, "attempts", context.attempt.attemptId, `validation-run-${ref.validationRunId}.json`);
  const artifact = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  const transformed = transform(artifact);
  const rewritten = { ...transformed, runDigest: digestWithoutRunDigest(transformed) };
  await writeFile(path, canonicalJson(rewritten), { mode: 0o600 });
}

function digestWithoutRunDigest(value: Record<string, unknown>): string {
  const { runDigest: _ignored, ...withoutDigest } = value;
  // Imported lazily through the already canonical serialized shape to keep
  // the test's artifact mutation explicit and deterministic.
  return sha256Canonical(withoutDigest);
}

async function addProofFor(context: BoundaryCopy, validationSpecId: string): Promise<void> {
  await overrideInspectionEvents(context, (events) => events.map((event) => event.eventType === "attempt.human-required"
    ? { ...event, payload: { ...event.payload, proofRef: humanValidationRequestRefV2(context.state.runId, context.attempt.attemptId, validationSpecId) } }
    : event));
}

async function overrideInspectionEvents(context: BoundaryCopy, transform: (events: readonly any[]) => readonly any[]): Promise<void> {
  const original = context.store.inspect.bind(context.store);
  const inspection = await original();
  const events = transform(inspection.events);
  (context.store as unknown as { inspect: () => Promise<unknown> }).inspect = async () => ({ ...inspection, events });
}
