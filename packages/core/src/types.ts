export type IssueSeverity = "error" | "warning";

export interface ValidationIssue {
  code: string;
  message: string;
  severity: IssueSeverity;
  line?: number;
  path?: string;
}

export interface Task {
  id: string;
  title: string;
  done: boolean;
  scope: string;
  change: string;
  covers: string;
  dependsOn: string[];
  parallelSafe: boolean;
  acceptanceCriteria: string[];
  validation: string[];
  expectedEvidence: string;
  line: number;
}

export interface Phase {
  number: number;
  id: string;
  title: string;
  goal: string;
  dependsOn: string[];
  context: string[];
  tasks: Task[];
  line: number;
}

export interface ExecutionDocument {
  contract: "rb-execution/v1";
  artifactId: string;
  title: string;
  phases: Phase[];
}

export interface ExecutionValidation {
  valid: boolean;
  issues: ValidationIssue[];
  document?: ExecutionDocument;
}

export type ArtifactStatus = "draft" | "ready" | "blocked" | "invalid";

export interface ArtifactRecord {
  id: string;
  kind: string;
  path: string;
  status: ArtifactStatus;
  sha256: string;
  contract?: string;
}

export interface ArtifactManifest {
  manifestVersion: "rb-manifest/v1";
  project: {
    id: string;
    name: string;
  };
  artifactRoot: ".rb";
  generatedAt: string;
  artifacts: ArtifactRecord[];
}

export interface ManifestValidation {
  valid: boolean;
  issues: ValidationIssue[];
  manifest?: ArtifactManifest;
}

export type ResponsiveDepth = "quick" | "balanced" | "deep";
export type ResponsiveFileDisposition = "ANALYZED" | "EXCLUDED" | "UNKNOWN";
export type ResponsiveCandidateDisposition =
  | "CONFIRMED_DEFECT"
  | "LIKELY_DEFECT"
  | "ANALYZED_SAFE"
  | "FALSE_POSITIVE_RISK"
  | "EXCLUDED"
  | "UNKNOWN";

export interface ResponsiveSourceRef {
  path: string;
  line: number;
  role: string;
}

export interface ResponsiveLayoutState {
  name: string;
  parentConstraint: string;
  childRequirement: string;
  relationship: string;
  assessment: "COMPATIBLE" | "INCOMPATIBLE" | "UNKNOWN";
}

export interface ResponsiveCandidate {
  id: string;
  path: string;
  mechanism: string;
  disposition: ResponsiveCandidateDisposition;
  sourceRefs: ResponsiveSourceRef[];
  invariantsChecked: string[];
  layoutStates?: ResponsiveLayoutState[];
  rationale: string;
  findingIds?: string[];
  limitations?: string[];
}

interface ResponsiveAccounting<T> {
  discovered: number;
  analyzed: number;
  excluded: number;
  unresolved: number;
  entries: T[];
}

interface ResponsiveInventoryBase {
  contract: "rb-responsive-inventory/v1";
  reviewId: string;
  depth: ResponsiveDepth;
  targetRevision: string;
}

export type ResponsiveInventoryDocument = ResponsiveInventoryBase & (
  | {
    applicability: "NOT_APPLICABLE";
    reason: string;
  }
  | {
    applicability: "APPLICABLE";
    mechanisms: string[];
    commands: Array<{ command: string; purpose: string; limitations: string[] }>;
    uiFiles: ResponsiveAccounting<{
      path: string;
      disposition: ResponsiveFileDisposition;
      candidateIds: string[];
      reason?: string;
    }>;
    layoutCandidates: ResponsiveAccounting<ResponsiveCandidate>;
    limitations?: string[];
  }
);

export interface ResponsiveInventoryValidation {
  valid: boolean;
  issues: ValidationIssue[];
  document?: ResponsiveInventoryDocument;
}
