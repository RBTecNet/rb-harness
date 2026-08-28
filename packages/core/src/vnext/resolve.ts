import { sha256Text } from "../hash.js";
import {
  acceptanceId,
  phaseId,
  projectId,
  requirementId,
  semanticKey,
  taskId,
  type RelPath,
  type SemanticKey,
  type Sha256,
} from "./identity.js";
import {
  INIT_PROJECT_MODEL_VERSION,
  type DeterminationSource,
  type InitProjectModel,
  type ProtectedPath,
  type ProtectedPathSource,
  type ResolutionContext,
  type SemanticInitProject,
  type SemanticPhaseInput,
  type SemanticTaskInput,
  type ValidationIntent,
} from "./ir.js";
import type { Finding, IrInvariantId, Outcome } from "./result.js";
import { canonicalEvidenceText, requestEvidenceIsVerified, userAnswerIsVerified } from "./provenance.js";

function finding(
  invariant: IrInvariantId,
  message: string,
  pointer: string,
  offending?: readonly string[],
): Finding {
  return { invariant, classification: "fatal", message, pointer, ...(offending ? { offending } : {}) };
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableTopological<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
  dependenciesOf: (value: T) => readonly string[],
): readonly T[] | undefined {
  const indexes = new Map(values.map((value, index) => [keyOf(value), index]));
  const remaining = new Set(values.map(keyOf));
  const emitted = new Set<string>();
  const result: T[] = [];
  while (remaining.size > 0) {
    const ready = values
      .filter((value) => remaining.has(keyOf(value)))
      .filter((value) => dependenciesOf(value).every((dependency) => emitted.has(dependency)))
      .sort((left, right) => (indexes.get(keyOf(left)) ?? 0) - (indexes.get(keyOf(right)) ?? 0));
    if (ready.length === 0) return undefined;
    for (const value of ready) {
      const key = keyOf(value);
      remaining.delete(key);
      emitted.add(key);
      result.push(value);
    }
  }
  return result;
}

function verifiedSource(
  source: { readonly kind: "request"; readonly evidence: string }
    | { readonly kind: "user-answer"; readonly questionKey: string }
    | { readonly kind: "model-default" },
  context: ResolutionContext,
  pointer: string,
  findings: Finding[],
): DeterminationSource | undefined {
  if (source.kind === "model-default") return source;
  if (source.kind === "request") {
    const evidence = canonicalEvidenceText(source.evidence);
    if (!requestEvidenceIsVerified(context.originalRequest, evidence)) {
      findings.push(finding("I-17", "Request provenance evidence is not a meaningful exact phrase in the original request", pointer, [source.evidence]));
      return undefined;
    }
    return { kind: "request", evidence };
  }
  const key = semanticKey(source.questionKey);
  if (!key || !userAnswerIsVerified(context.answers ?? {}, source.questionKey)) {
    findings.push(finding("I-17", "User-answer provenance does not resolve to supplied answer data", pointer, [source.questionKey]));
    return undefined;
  }
  return { kind: "user-answer", questionKey: key };
}

function parsedKeys(
  values: readonly string[],
  pointer: string,
  findings: Finding[],
): readonly SemanticKey[] {
  return values.flatMap((value, index) => {
    const key = semanticKey(value);
    if (!key) findings.push(finding("I-02", `Invalid semantic key: ${value}`, `${pointer}/${index}`, [value]));
    return key ? [key] : [];
  });
}

function duplicateKeys(values: readonly string[], pointer: string, invariant: IrInvariantId, findings: Finding[]): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) findings.push(finding(invariant, `Duplicate semantic key: ${value}`, `${pointer}/${index}`, [value]));
    seen.add(value);
  }
}

function resolveValidation(
  input: SemanticTaskInput["validation"][number],
  pointer: string,
  findings: Finding[],
): ValidationIntent | undefined {
  if (input.kind === "command") {
    const commandKey = semanticKey(input.commandKey);
    if (!commandKey) {
      findings.push(finding("I-11", `Invalid quality-command key: ${input.commandKey}`, pointer, [input.commandKey]));
      return undefined;
    }
    return { kind: "command", commandKey };
  }
  return input.kind === "manual"
    ? { kind: "manual", inspection: input.inspection }
    : { kind: "human", evidence: input.evidence };
}

export function resolveInitProject(
  input: SemanticInitProject,
  context: ResolutionContext,
): Outcome<InitProjectModel> {
  const findings: Finding[] = [];
  duplicateKeys(input.determinations.map((entry) => entry.key), "/determinations", "I-16", findings);
  duplicateKeys(input.requirements.map((entry) => entry.key), "/requirements", "I-02", findings);
  duplicateKeys(input.qualityCommands.map((entry) => entry.key), "/qualityCommands", "I-02", findings);
  duplicateKeys(input.phases.map((entry) => entry.key), "/phases", "I-02", findings);
  duplicateKeys(input.phases.flatMap((phase) => phase.tasks.map((task) => task.key)), "/phases/tasks", "I-02", findings);

  const determinationKeys = parsedKeys(input.determinations.map((entry) => entry.key), "/determinations", findings);
  const requirementKeys = parsedKeys(input.requirements.map((entry) => entry.key), "/requirements", findings);
  const qualityCommandKeys = parsedKeys(input.qualityCommands.map((entry) => entry.key), "/qualityCommands", findings);
  const phaseKeys = parsedKeys(input.phases.map((entry) => entry.key), "/phases", findings);
  const flatInputTasks = input.phases.flatMap((phase) => phase.tasks);
  const taskKeys = parsedKeys(flatInputTasks.map((entry) => entry.key), "/phases/tasks", findings);
  if (findings.length > 0) return { ok: false, findings };

  const requirementKeySet = new Set<string>(requirementKeys);
  const commandKeySet = new Set<string>(qualityCommandKeys);
  const phaseKeySet = new Set<string>(phaseKeys);
  const taskKeySet = new Set<string>(taskKeys);

  for (const [phaseIndex, phase] of input.phases.entries()) {
    for (const [dependencyIndex, dependency] of phase.dependsOn.entries()) {
      if (!phaseKeySet.has(dependency)) findings.push(finding("I-02", `Unknown phase dependency: ${dependency}`, `/phases/${phaseIndex}/dependsOn/${dependencyIndex}`, [dependency]));
    }
    for (const [taskIndex, task] of phase.tasks.entries()) {
      for (const [dependencyIndex, dependency] of task.dependsOn.entries()) {
        if (!taskKeySet.has(dependency)) findings.push(finding("I-02", `Unknown task dependency: ${dependency}`, `/phases/${phaseIndex}/tasks/${taskIndex}/dependsOn/${dependencyIndex}`, [dependency]));
      }
      for (const [coverIndex, cover] of task.covers.entries()) {
        if (!requirementKeySet.has(cover)) findings.push(finding("I-02", `Unknown requirement coverage key: ${cover}`, `/phases/${phaseIndex}/tasks/${taskIndex}/covers/${coverIndex}`, [cover]));
      }
      for (const [validationIndex, validation] of task.validation.entries()) {
        if (validation.kind === "command" && !commandKeySet.has(validation.commandKey)) {
          findings.push(finding("I-11", `Unknown quality-command key: ${validation.commandKey}`, `/phases/${phaseIndex}/tasks/${taskIndex}/validation/${validationIndex}`, [validation.commandKey]));
        }
      }
    }
  }
  if (findings.length > 0) return { ok: false, findings };

  const orderedPhases = stableTopological(input.phases, (phase) => phase.key, (phase) => phase.dependsOn);
  if (!orderedPhases) return { ok: false, findings: [finding("I-04", "Phase dependency graph contains a cycle", "/phases")] };
  const orderedPhaseIndex = new Map(orderedPhases.map((phase, index) => [phase.key, index]));
  const taskPhase = new Map<string, string>();
  for (const phase of input.phases) for (const task of phase.tasks) taskPhase.set(task.key, phase.key);

  const orderedTasksByPhase = new Map<string, readonly SemanticTaskInput[]>();
  for (const phase of orderedPhases) {
    const currentPhase = orderedPhaseIndex.get(phase.key) ?? 0;
    for (const task of phase.tasks) {
      for (const dependency of task.dependsOn) {
        const dependencyPhaseKey = taskPhase.get(dependency)!;
        const dependencyPhase = orderedPhaseIndex.get(dependencyPhaseKey) ?? 0;
        if (dependencyPhase > currentPhase) {
          findings.push(finding("I-05", `Task ${task.key} depends on task ${dependency} in a later phase`, `/phases/${phase.key}/tasks/${task.key}/dependsOn`, [dependency]));
        }
      }
    }
    const orderedTasks = stableTopological(
      phase.tasks,
      (task) => task.key,
      (task) => task.dependsOn.filter((dependency) => taskPhase.get(dependency) === phase.key),
    );
    if (!orderedTasks) findings.push(finding("I-04", `Task dependency graph contains a cycle in phase ${phase.key}`, `/phases/${phase.key}/tasks`));
    else orderedTasksByPhase.set(phase.key, orderedTasks);
  }
  if (findings.length > 0) return { ok: false, findings };

  const phaseIds = new Map<string, ReturnType<typeof phaseId>>();
  const taskIds = new Map<string, ReturnType<typeof taskId>>();
  let globalTaskOrdinal = 0;
  orderedPhases.forEach((phase, index) => {
    phaseIds.set(phase.key, phaseId(index + 1));
    for (const task of orderedTasksByPhase.get(phase.key) ?? []) {
      globalTaskOrdinal += 1;
      taskIds.set(task.key, taskId(globalTaskOrdinal));
    }
  });
  const requirementIds = new Map(input.requirements.map((requirement, index) => [requirement.key, requirementId(index + 1)]));

  const determinations = input.determinations.flatMap((entry, index) => {
    const source = verifiedSource(entry.source, context, `/determinations/${index}/source`, findings);
    if (!source) return [];
    return [{
      key: determinationKeys[index]!,
      statement: entry.statement,
      rationale: entry.rationale,
      materiality: entry.materiality,
      rigidity: entry.rigidity,
      source,
    }];
  });

  const protectedPaths: ProtectedPath[] = [
    { path: ".rb" as RelPath, reason: "RB artifact control plane", source: { kind: "built-in" } as const },
    { path: ".rb-harness" as RelPath, reason: "RB Harness orchestration state", source: { kind: "built-in" } as const },
    { path: ".git" as RelPath, reason: "Version-control internals", source: { kind: "built-in" } as const },
  ];
  for (const [index, entry] of input.protectedPaths.entries()) {
    const source = verifiedSource(entry.source, context, `/protectedPaths/${index}/source`, findings);
    if (!source || source.kind === "model-default") {
      if (source?.kind === "model-default") findings.push(finding("I-17", "A model default cannot create an authoritative protected path", `/protectedPaths/${index}/source`));
      continue;
    }
    const protectedSource: ProtectedPathSource = source.kind === "request"
      ? source
      : { kind: "user-answer", questionKey: source.questionKey };
    protectedPaths.push({ path: entry.path as RelPath, reason: entry.reason, source: protectedSource });
  }
  if (findings.length > 0) return { ok: false, findings };

  const answers = Object.fromEntries(Object.entries(context.answers ?? {}).sort(([left], [right]) => codeUnitCompare(left, right)));
  const model: InitProjectModel = {
    version: INIT_PROJECT_MODEL_VERSION,
    workflow: "init",
    core: {
      identity: { id: projectId(input.project.name), name: input.project.name, objective: input.project.objective },
      determinations,
      protectedPaths,
      provenance: {
        runId: context.runId,
        requestSha256: sha256Text(context.originalRequest) as Sha256,
        originalRequest: context.originalRequest,
        answers,
        generatedAt: context.generatedAt,
      },
    },
    requirements: input.requirements.map((entry, index) => ({
      key: requirementKeys[index]!,
      id: requirementIds.get(entry.key)!,
      statement: entry.statement,
    })),
    qualityCommands: input.qualityCommands.map((entry, index) => ({
      key: qualityCommandKeys[index]!,
      kind: entry.kind,
      command: entry.command,
    })),
    phases: orderedPhases.map((phase: SemanticPhaseInput, phaseIndex) => ({
      key: semanticKey(phase.key)!,
      number: phaseIndex + 1,
      id: phaseIds.get(phase.key)!,
      title: phase.title,
      goal: phase.goal,
      dependsOn: phase.dependsOn.map((dependency) => phaseIds.get(dependency)!),
      tasks: (orderedTasksByPhase.get(phase.key) ?? []).map((task) => {
        const id = taskIds.get(task.key)!;
        return {
          key: semanticKey(task.key)!,
          id,
          title: task.title,
          intent: task.intent,
          dependsOn: task.dependsOn.map((dependency) => taskIds.get(dependency)!),
          ownedPaths: task.ownedPaths.map((path) => path as RelPath),
          covers: task.covers.map((cover) => requirementIds.get(cover)!),
          acceptance: task.acceptance.map((statement, index) => ({ id: acceptanceId(id, index + 1), statement })),
          validation: task.validation.flatMap((validation, index) => {
            const resolved = resolveValidation(validation, `/phases/${phase.key}/tasks/${task.key}/validation/${index}`, findings);
            return resolved ? [resolved] : [];
          }),
          expectedEvidence: task.expectedEvidence,
          parallelSafe: false as const,
        };
      }),
    })),
  };
  return findings.length > 0 ? { ok: false, findings } : { ok: true, value: model };
}
