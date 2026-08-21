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
