import { sha256Text } from "../../hash.js";
import { semanticKey, type SemanticKey } from "../identity.js";
import type { ResolutionContext, SemanticInitProject } from "../ir.js";
import type { Finding } from "../result.js";
import { resolveInitProject } from "../resolve.js";
import { canonicalize, validate } from "../validate.js";
import {
  deriveImplementationSubjects,
  validateProjectPhases,
  type ProjectPhases,
  type ProjectPhasesUpstreamProjection,
} from "./project-phases-ir.js";

function determinationKey(sourceKey: SemanticKey): SemanticKey {
  const value = `determination-${sha256Text(`p1-determination\u0000${sourceKey}`).slice(0, 32)}`;
  const parsed = semanticKey(value);
  if (!parsed) throw new Error(`PROJECT_PHASES_DETERMINATION_KEY_INVALID: ${value}`);
  return parsed;
}

/** Pure, provider-free compile from fresh Progressive authority into the one canonical semantic model. */
export function compileProjectPhasesToSemanticInitProject(
  upstream: ProjectPhasesUpstreamProjection,
  projectPhases: ProjectPhases,
): SemanticInitProject {
  const stageValidation = validateProjectPhases(projectPhases, upstream);
  if (!stageValidation.ok) {
    throw new Error(`PROJECT_PHASES_INVALID: ${stageValidation.findings.map((entry) => `${entry.pointer}: ${entry.message}`).join("; ")}`);
  }
  const subjects = deriveImplementationSubjects(upstream);
  const determinationKeys = new Set<string>();
  const determinations = upstream.projectDescription.determinations.map((entry) => {
    const key = determinationKey(entry.key);
    if (determinationKeys.has(key)) throw new Error(`PROJECT_PHASES_DETERMINATION_KEY_COLLISION: ${key}`);
    determinationKeys.add(key);
    return {
      key,
      statement: entry.statement,
      rationale: entry.rationale,
      materiality: entry.materiality,
      rigidity: entry.rigidity,
      source: { kind: "developer" as const },
    };
  });
  return {
    workflow: "init",
    project: {
      name: upstream.projectDescription.project.name,
      objective: upstream.projectDescription.project.objective,
    },
    determinations,
    requirements: subjects.map((subject) => ({ key: subject.key, statement: subject.requirement })),
    qualityCommands: upstream.projectDescription.qualityCommands.map((command) => ({ ...command })),
    protectedPaths: [],
    phases: projectPhases.phases.map((phase) => ({
      key: phase.key,
      title: phase.title,
      goal: phase.goal,
      dependsOn: [],
      tasks: phase.tasks.map((task) => ({
        key: task.key,
        title: task.title,
        intent: task.intent,
        dependsOn: task.dependsOn,
        ownedPaths: task.ownedPaths,
        covers: task.coverageKeys,
        acceptance: task.acceptance,
        validation: task.validation,
        expectedEvidence: task.expectedEvidence,
      })),
    })),
  };
}

export type ProjectPhasesCanonicalCompilation =
  | { readonly ok: true; readonly semantic: SemanticInitProject; readonly model: ReturnType<typeof canonicalize> }
  | { readonly ok: false; readonly findings: readonly Finding[] };

/** Resolve + canonicalize + validate is the final candidate gate before approval or publication. */
export function validateCompiledProjectPhases(
  upstream: ProjectPhasesUpstreamProjection,
  projectPhases: ProjectPhases,
  context: ResolutionContext,
): ProjectPhasesCanonicalCompilation {
  const semantic = compileProjectPhasesToSemanticInitProject(upstream, projectPhases);
  const resolved = resolveInitProject(semantic, context);
  if (!resolved.ok) return { ok: false, findings: resolved.findings };
  const model = canonicalize(resolved.value);
  const validation = validate(model);
  return validation.valid ? { ok: true, semantic, model } : { ok: false, findings: validation.findings };
}
