import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { validateManifestTree, validateManifestValue } from "../../manifest.js";
import type { ArtifactManifest } from "../../types.js";
import { closeInitProject, SemanticClosureError, type ClosureResult } from "../closure.js";
import { renderBrief } from "../render/brief.js";
import { deriveExecutionDocument, renderPhases } from "../render/execution.js";
import { buildManifest } from "../render/manifest.js";
import { selectReadyExecutionPlan } from "../ralph-fidelity.js";
import {
  validateCompiledProjectPhases,
} from "./project-phases-compiler.js";
import type { ProjectPhases, ProjectPhasesUpstreamProjection } from "./project-phases-ir.js";

export type ProjectPhasesClosureState =
  | { readonly status: "fresh"; readonly brief: string; readonly phases: string }
  | { readonly status: "stale"; readonly reasons: readonly string[]; readonly brief: string; readonly phases: string };

function resolvedModel(
  upstream: ProjectPhasesUpstreamProjection,
  projectPhases: ProjectPhases,
  runId: string,
  generatedAt: string,
) {
  const compiled = validateCompiledProjectPhases(upstream, projectPhases, {
    originalRequest: upstream.projectDescription.originalRequest,
    runId,
    generatedAt,
  });
  if (!compiled.ok) throw new SemanticClosureError(compiled.findings);
  return compiled.model;
}

async function rbFiles(root: string, relative = ""): Promise<readonly string[]> {
  const directory = resolve(root, ".rb", relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await rbFiles(root, path));
    else files.push(path);
  }
  return files.sort();
}

/** Recompiles current semantic authority and proves the derived tree without predicting operational provenance. */
export async function inspectProjectPhasesClosure(
  root: string,
  upstream: ProjectPhasesUpstreamProjection,
  projectPhases: ProjectPhases,
): Promise<ProjectPhasesClosureState> {
  const model = resolvedModel(upstream, projectPhases, "closure-check", "2000-01-01T00:00:00.000Z");
  const brief = renderBrief(model);
  const phases = renderPhases(deriveExecutionDocument(model));
  const reasons: string[] = [];
  let briefBytes: Buffer;
  let phasesBytes: Buffer;
  let manifestBytes: Buffer;
  try {
    [briefBytes, phasesBytes, manifestBytes] = await Promise.all([
      readFile(resolve(root, ".rb", "init", "BRIEF.md")),
      readFile(resolve(root, ".rb", "init", "PHASES.md")),
      readFile(resolve(root, ".rb", "rb-manifest.json")),
    ]);
  } catch {
    return { status: "stale", reasons: ["canonical .rb closure is missing"], brief, phases };
  }
  if (!briefBytes.equals(Buffer.from(brief))) reasons.push("BRIEF.md bytes differ from current semantic authority");
  if (!phasesBytes.equals(Buffer.from(phases))) reasons.push("PHASES.md bytes differ from current semantic authority");
  let manifest: ArtifactManifest | undefined;
  try {
    const parsed: unknown = JSON.parse(manifestBytes.toString("utf8"));
    const validation = validateManifestValue(parsed);
    if (!validation.valid || !validation.manifest) reasons.push("rb-manifest.json is intrinsically invalid");
    else manifest = validation.manifest;
  } catch {
    reasons.push("rb-manifest.json is not valid JSON");
  }
  if (manifest) {
    const expected = buildManifest(model, [
      { path: ".rb/init/BRIEF.md", bytes: Buffer.from(brief) },
      { path: ".rb/init/PHASES.md", bytes: Buffer.from(phases) },
    ]);
    if (JSON.stringify(manifest.project) !== JSON.stringify(expected.project)
      || manifest.manifestVersion !== expected.manifestVersion
      || manifest.artifactRoot !== expected.artifactRoot
      || JSON.stringify(manifest.artifacts) !== JSON.stringify(expected.artifacts)) {
      reasons.push("manifest identity or artifact records differ from current BRIEF/PHASES bytes");
    }
    try {
      selectReadyExecutionPlan(manifest, phasesBytes.toString("utf8"));
    } catch {
      reasons.push("manifest does not select exactly one Ralph READY execution plan");
    }
  }
  try {
    const tree = await validateManifestTree(root);
    if (!tree.valid) reasons.push("manifest/tree validation failed");
  } catch {
    reasons.push("manifest/tree validation failed");
  }
  try {
    const files = await rbFiles(root);
    if (JSON.stringify(files) !== JSON.stringify(["init/BRIEF.md", "init/PHASES.md", "rb-manifest.json"])) {
      reasons.push(".rb does not contain exactly the canonical three-file closure");
    }
  } catch {
    reasons.push("canonical .rb tree cannot be inspected");
  }
  return reasons.length ? { status: "stale", reasons, brief, phases } : { status: "fresh", brief, phases };
}

export interface ProjectPhasesPublicationResult {
  readonly runId: string;
  readonly generatedAt: string;
  readonly closure: ClosureResult;
}

/** Deterministic semantic compilation plus canonical publication; runtime provenance is fresh per attempt. */
export async function publishProjectPhasesClosure(
  root: string,
  upstream: ProjectPhasesUpstreamProjection,
  projectPhases: ProjectPhases,
  runtime: { readonly runId?: string; readonly generatedAt?: string } = {},
): Promise<ProjectPhasesPublicationResult> {
  const runId = runtime.runId ?? `progressive-${randomUUID()}`;
  const generatedAt = runtime.generatedAt ?? new Date().toISOString();
  const model = resolvedModel(upstream, projectPhases, runId, generatedAt);
  const closure = await closeInitProject(model, root);
  const verification = await inspectProjectPhasesClosure(root, upstream, projectPhases);
  if (verification.status !== "fresh") throw new Error(`PROJECT_PHASES_CLOSURE_VERIFICATION_FAILED: ${verification.reasons.join("; ")}`);
  return { runId, generatedAt, closure };
}
