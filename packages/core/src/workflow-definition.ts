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
      { name: "PROJECT.md", required: true, owner: MODEL, description: "intent, capabilities, constraints, and knowledge classification" },
      { name: "PHASES.md", required: true, owner: MODEL, description: "ready rb-execution/v1 initial plan" },
      { name: "OPERATIONS.json", required: false, owner: MODEL, description: "rb-operational/v1 consumer acceptance when it can be grounded" },
    ],
  },
  "ai-context": {
    workflow: "ai-context",
    root: ".rb/context",
    dynamicRoot: false,
    readyArtifact: "AGENTS.md",
    readyKind: "context-document",
    artifacts: [
      { name: "AGENTS.md", required: true, owner: MODEL, description: "compact index of the AS IS context set" },
      { name: "*.md", required: false, owner: MODEL, description: "conditional evidence-grounded context documents" },
      { name: "OPERATIONS.json", required: false, owner: MODEL, description: "grounded rb-operational/v1 acceptance" },
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
      { name: "FINDINGS.md", required: true, owner: MODEL, description: "evidence-grounded findings with stable IDs" },
      { name: "BASELINE.json", required: true, owner: MODEL, description: "audit coverage, limits, and comparison baseline" },
      { name: "JOURNEYS.md", required: false, owner: MODEL, description: "conditional cross-layer journey evidence" },
      { name: "DESIGN_SYSTEM.md", required: false, owner: MODEL, description: "conditional observed UI-system authority" },
      { name: "RESPONSIVE_INVENTORY.json", required: false, owner: MODEL, description: "conditional machine-readable responsive evidence" },
      { name: "SELECTION.md", required: false, owner: MODEL, description: "explicit remediation finding selection" },
      { name: "PLAN.md", required: false, owner: MODEL, description: "conditional remediation decomposition" },
      { name: "PHASES.md", required: false, owner: MODEL, description: "remediation plan only after explicit finding selection" },
      { name: "OPERATIONS.json", required: false, owner: MODEL, description: "conditional remediation acceptance" },
    ],
  },
};

export const CODE_OWNED_WORKFLOW_INFORMATION = [
  ".rb/rb-manifest.json",
  ".rb/artifacts.tsv",
  "artifact IDs and kinds",
  "SHA-256 hashes",
  "generatedAt and derived statuses",
  "mandatory authoring dependencies and publication state",
] as const;

function dynamicPrefix(definition: WorkflowDefinition): string {
  return definition.root.slice(0, definition.root.indexOf("<"));
}

export function workflowScopeFromPaths(workflow: HarnessWorkflow, paths: readonly string[]): string | undefined {
  const definition = WORKFLOW_DEFINITIONS[workflow];
  if (!definition.dynamicRoot) return definition.root;
  const prefix = dynamicPrefix(definition);
  const roots = new Set(paths.flatMap((path) => {
    if (!path.startsWith(prefix)) return [];
    const rest = path.slice(prefix.length);
    const segment = rest.split("/")[0];
    return segment ? [`${prefix}${segment}`] : [];
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
): ArtifactRecord[] {
  const definition = WORKFLOW_DEFINITIONS[workflow];
  return artifacts.filter((artifact) => {
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
    "All listed artifacts are model-authored.",
    "",
    ...definition.artifacts.map((artifact) =>
      `- \`${artifact.name}\` — ${artifact.required ? "required" : "conditional"}.`),
    "",
    `Readiness artifact: \`${definition.readyArtifact}\` (${definition.readyKind}${definition.readyContract ? `, ${definition.readyContract}` : ""}).`,
    "",
    "Code-owned information (never model-authored):",
    ...CODE_OWNED_WORKFLOW_INFORMATION.map((entry) => `- code-owned: ${entry.startsWith(".rb/") ? `\`${entry}\`` : entry}`),
  ];
  return lines.join("\n");
}

export function artifactName(path: string): string {
  return basename(path).toUpperCase();
}
