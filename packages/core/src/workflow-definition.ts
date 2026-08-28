import { basename } from "node:path/posix";
import type { ArtifactRecord } from "./types.js";
import type { HarnessWorkflow } from "./standalone-types.js";

export type WorkflowArtifactOwner = "model" | "code";

export interface WorkflowArtifactDefinition {
  name: string;
  required: boolean;
  owner: WorkflowArtifactOwner;
  description: string;
}

export interface WorkflowDefinition {
  workflow: HarnessWorkflow;
  root: string;
  dynamicRoot: boolean;
  artifacts: readonly WorkflowArtifactDefinition[];
  readyArtifact: string;
  readyKind: string;
  readyContract?: string;
}

const MODEL = "model" as const;

/**
 * Canonical workflow shape. Runtime completeness, readiness, prompt rendering,
 * and packaged resource drift tests all consume this table.
 */
export const WORKFLOW_DEFINITIONS: Readonly<Record<HarnessWorkflow, WorkflowDefinition>> = {
  init: {
    workflow: "init",
    root: ".rb/init",
    dynamicRoot: false,
    readyArtifact: "PHASES.md",
    readyKind: "execution-plan",
    readyContract: "rb-execution/v1",
    artifacts: [
      { name: "PROJECT.md", required: true, owner: MODEL, description: "objective, users, scope, non-goals, constraints, and success" },
      { name: "REQUIREMENTS.md", required: true, owner: MODEL, description: "RIGID RF/RNF/UI/CT binary criteria; FLEXIBLE decisions separate" },
      { name: "DECISIONS.md", required: true, owner: MODEL, description: "confirmed choices, rationale, consequences, and supersession" },
      { name: "PLAN.md", required: true, owner: MODEL, description: "architecture-aware decomposition, dependencies, risks, validation" },
      { name: "PHASES.md", required: true, owner: MODEL, description: "ready rb-execution/v1 plan derived from the richer artifacts" },
      { name: "source-manifest.json", required: true, owner: MODEL, description: "source hashes, answer provenance, and artifact links" },
      { name: "GLOSSARY.md", required: false, owner: MODEL, description: "domain terms when needed" },
      { name: "WORKFLOWS.md", required: false, owner: MODEL, description: "actor/state success and failure flows when needed" },
      { name: "ARCHITECTURE.md", required: false, owner: MODEL, description: "confirmed architecture, separated from proposals" },
      { name: "NON_FUNCTIONAL.md", required: false, owner: MODEL, description: "measurable quality constraints" },
      { name: "OPERATIONS.json", required: false, owner: MODEL, description: "grounded rb-operational/v1 consumer acceptance" },
      { name: "contracts/*", required: false, owner: MODEL, description: "formal contracts required by a RIGID boundary" },
    ],
  },
  "ai-context": {
    workflow: "ai-context",
    root: ".rb/context",
    dynamicRoot: false,
    readyArtifact: "AGENTS.md",
    readyKind: "context-document",
    artifacts: [
      { name: "AGENTS.md", required: true, owner: MODEL, description: "compact AS IS index of verified commands, conventions, prohibitions, setup, and context links" },
      { name: "source-manifest.json", required: true, owner: MODEL, description: "source hashes, claim-to-evidence links, and raw/normalized answer provenance" },
      { name: "project-overview.md", required: false, owner: MODEL, description: "purpose, actors, boundaries, and macro flows" },
      { name: "architecture.md", required: false, owner: MODEL, description: "implemented layout, responsibilities, dependency direction, and integrations" },
      { name: "glossary.md", required: false, owner: MODEL, description: "implemented domain vocabulary" },
      { name: "domain-rules.md", required: false, owner: MODEL, description: "rules, invariants, decision tables, and evidence" },
      { name: "workflows.md", required: false, owner: MODEL, description: "implemented success, failure, and state flows" },
      { name: "permissions-security.md", required: false, owner: MODEL, description: "authentication, authorization, tenancy, sensitive-data, and trust boundaries" },
      { name: "interfaces.md", required: false, owner: MODEL, description: "HTTP, RPC, CLI, events, jobs, and evidenced payloads" },
      { name: "data-model.md", required: false, owner: MODEL, description: "stores, entities, relationships, migrations, caches, and state" },
      { name: "dependencies-integrations.md", required: false, owner: MODEL, description: "external ownership, clients, retries, and failure behavior" },
      { name: "operations.md", required: false, owner: MODEL, description: "runtime, deployment, observability, schedules, and troubleshooting" },
      { name: "testing-quality.md", required: false, owner: MODEL, description: "verified quality commands, test layout, runners, and enforcement" },
      { name: "known-gaps.md", required: false, owner: MODEL, description: "conflicts, unknowns, skipped areas, legacy accidents, and confirmed risks" },
      { name: "OPERATIONS.json", required: false, owner: MODEL, description: "grounded rb-operational/v1 acceptance when repository evidence supports it" },
    ],
  },
  plan: {
    workflow: "plan",
    root: ".rb/features/<slug>",
    dynamicRoot: true,
    readyArtifact: "PHASES.md",
    readyKind: "execution-plan",
    readyContract: "rb-execution/v1",
    artifacts: [
      { name: "REQUEST.md", required: true, owner: MODEL, description: "normalized developer request and accepted boundaries" },
      { name: "SPEC.md", required: true, owner: MODEL, description: "RIGID/FLEXIBLE requirements and binary criteria" },
      { name: "PLAN.md", required: true, owner: MODEL, description: "architecture-aware decomposition and risks" },
      { name: "PHASES.md", required: true, owner: MODEL, description: "ready rb-execution/v1 plan" },
      { name: "source-manifest.json", required: true, owner: MODEL, description: "source paths/hashes, context references, answer provenance, and artifact links" },
      { name: "OPERATIONS.json", required: false, owner: MODEL, description: "rb-operational/v1 acceptance when consumer-observable" },
      { name: "contracts/*", required: false, owner: MODEL, description: "formal contracts only when a RIGID boundary requires them" },
    ],
  },
  evolve: {
    workflow: "evolve",
    root: ".rb/evolutions/<slug>",
    dynamicRoot: true,
    readyArtifact: "PHASES.md",
    readyKind: "execution-plan",
    readyContract: "rb-execution/v1",
    artifacts: [
      { name: "CHANGE_REQUEST.md", required: true, owner: MODEL, description: "normalized change authority, scope, non-goals, and accepted decisions" },
      { name: "AS_IS.md", required: true, owner: MODEL, description: "evidence-grounded current behavior" },
      { name: "TO_BE.md", required: true, owner: MODEL, description: "authoritative delta with stable CHANGE/RF IDs" },
      { name: "IMPACT.md", required: true, owner: MODEL, description: "readers, writers, reactors, and affected boundaries" },
      { name: "PRESERVATION.md", required: true, owner: MODEL, description: "stable PRESERVE obligations and protected paths" },
      { name: "REGRESSION_MATRIX.md", required: true, owner: MODEL, description: "change and preservation proof ownership" },
      { name: "PLAN.md", required: true, owner: MODEL, description: "bounded evolution decomposition" },
      { name: "PHASES.md", required: true, owner: MODEL, description: "ready rb-execution/v1 plan" },
      { name: "source-manifest.json", required: true, owner: MODEL, description: "source hashes, freshness, answer provenance, claims, traceability, and artifact links" },
      { name: "MIGRATION.md", required: false, owner: MODEL, description: "transition and rollback only when required" },
      { name: "OPERATIONS.json", required: false, owner: MODEL, description: "rb-operational/v1 change and preserved-path acceptance" },
      { name: "contracts/*", required: false, owner: MODEL, description: "formal contracts only for RIGID public boundaries" },
    ],
  },
  review: {
    workflow: "review",
    root: ".rb/reviews/<review-id>",
    dynamicRoot: true,
    readyArtifact: "FINDINGS.md",
    readyKind: "review-findings",
    artifacts: [
      { name: "REVIEW.md", required: true, owner: MODEL, description: "target revision, scope, methodology, coverage, limits, summary, and remediation readiness" },
      { name: "FINDINGS.md", required: true, owner: MODEL, description: "evidence-grounded findings with stable IDs" },
      { name: "BASELINE.json", required: true, owner: MODEL, description: "audit coverage, limits, and comparison baseline" },
      { name: "source-manifest.json", required: true, owner: MODEL, description: "inspected paths/hashes, commands, exclusions, answer and finding evidence provenance" },
      { name: "JOURNEYS.md", required: false, owner: MODEL, description: "conditional cross-layer journey evidence" },
      { name: "DESIGN_SYSTEM.md", required: false, owner: MODEL, description: "conditional observed UI-system authority" },
      { name: "RESPONSIVE_INVENTORY.json", required: false, owner: MODEL, description: "conditional machine-readable responsive evidence" },
      { name: "RESPONSIVE_INVENTORY.md", required: false, owner: MODEL, description: "optional human summary derived from the validated responsive JSON" },
      { name: "SELECTION.md", required: false, owner: MODEL, description: "explicit remediation finding selection" },
      { name: "PLAN.md", required: false, owner: MODEL, description: "conditional remediation decomposition" },
      { name: "PHASES.md", required: false, owner: MODEL, description: "remediation plan only after explicit finding selection" },
      { name: "OPERATIONS.json", required: false, owner: MODEL, description: "conditional remediation acceptance" },
    ],
  },
};

export const CODE_OWNED_WORKFLOW_INFORMATION = [
  ".rb/rb-manifest.json and .rb/artifacts.tsv",
  "manifest SHA-256 hashes, kinds, generatedAt, and derived statuses",
  "path-derived manifest identities where no authored contract marker supplies identity",
  "mandatory authoring dependencies and publication state",
] as const;

function dynamicPrefix(definition: WorkflowDefinition): string {
  return definition.root.slice(0, definition.root.indexOf("<"));
}

export function workflowScopeFromPaths(
  workflow: HarnessWorkflow,
  paths: readonly string[],
  strict = true,
): string | undefined {
  const definition = WORKFLOW_DEFINITIONS[workflow];
  if (!paths.length) return undefined;
  if (!definition.dynamicRoot) {
    if (!strict) return paths.some((path) => path.startsWith(`${definition.root}/`)) ? definition.root : undefined;
    return paths.every((path) => path.startsWith(`${definition.root}/`)) ? definition.root : undefined;
  }
  const prefix = dynamicPrefix(definition);
  if (strict && paths.some((path) => !path.startsWith(prefix))) return undefined;
  const relevant = paths.filter((path) => path.startsWith(prefix));
  if (!relevant.length) return undefined;
  const roots = new Set(relevant.flatMap((path) => {
    const rest = path.slice(prefix.length);
    const [segment, ...artifactPath] = rest.split("/");
    return segment && artifactPath.some(Boolean) ? [`${prefix}${segment}`] : [];
  }));
  return roots.size === 1 ? [...roots][0] : undefined;
}

export function workflowArtifactPath(scope: string, name: string): string {
  return `${scope}/${name}`;
}

export function requiredWorkflowArtifactPaths(workflow: HarnessWorkflow, scope: string): string[] {
  return WORKFLOW_DEFINITIONS[workflow].artifacts
    .filter((artifact) => artifact.required)
    .map((artifact) => workflowArtifactPath(scope, artifact.name));
}

export function applicableWorkflowArtifacts(
  workflow: HarnessWorkflow,
  scope: string,
  artifacts: readonly ArtifactRecord[],
  authoredPaths?: ReadonlySet<string>,
): ArtifactRecord[] {
  const definition = WORKFLOW_DEFINITIONS[workflow];
  return artifacts.filter((artifact) => {
    if (authoredPaths && !authoredPaths.has(artifact.path)) return false;
    if (artifact.path === scope || !artifact.path.startsWith(`${scope}/`)) return false;
    if (!definition.dynamicRoot) return true;
    return artifact.path.slice(scope.length + 1).length > 0;
  });
}

export function readyWorkflowArtifact(
  workflow: HarnessWorkflow,
  scope: string,
  artifacts: readonly ArtifactRecord[],
): ArtifactRecord | undefined {
  const definition = WORKFLOW_DEFINITIONS[workflow];
  const expectedPath = workflowArtifactPath(scope, definition.readyArtifact);
  return artifacts.find((artifact) => artifact.path === expectedPath
    && artifact.kind === definition.readyKind
    && artifact.status === "ready"
    && (!definition.readyContract || artifact.contract === definition.readyContract));
}

export function renderWorkflowArtifactAuthority(workflow: HarnessWorkflow): string {
  const definition = WORKFLOW_DEFINITIONS[workflow];
  const lines = [
    "## Required output set (canonical machine authority)",
    "",
    `Workflow root: \`${definition.root}/\`.`,
    "Artifacts are model-authored.",
    "",
    ...definition.artifacts.map((artifact) =>
      `- \`${artifact.name}\` — ${artifact.required ? "required" : "conditional"}; ${artifact.description}.`),
    "",
    `Readiness artifact: \`${definition.readyArtifact}\` (${definition.readyKind}${definition.readyContract ? `, ${definition.readyContract}` : ""}).`,
    "",
    "Code-owned (never model-authored):",
    ...CODE_OWNED_WORKFLOW_INFORMATION.map((entry) => `- ${entry}`),
    "",
    "Model-authored: required `rb-artifact-id` in `PHASES.md`; code parses this execution identity.",
    "- `.rb/` is read-only to implementation tasks: Context may read it; Scope and Change may not own it.",
  ];
  return lines.join("\n");
}

export function artifactName(path: string): string {
  return basename(path).toUpperCase();
}
