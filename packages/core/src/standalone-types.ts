export const STANDALONE_STATE_CONTRACT = "rb-harness-run/v1" as const;

export type HarnessWorkflow = "init" | "ai-context" | "plan" | "evolve" | "review";
export type RunStatus =
  | "interview"
  | "interview-failed"
  | "blocked"
  | "generating"
  | "generation-failed"
  | "validating"
  | "auditing"
  | "publishing"
  | "complete";

export interface ProviderConfiguration {
  provider: import("./provider-registry.js").ProviderId;
  model: string;
  effort: string;
  command?: string;
  credential?: string;
}

export interface InterviewQuestion {
  id: string;
  question: string;
  why: string;
  type: "text" | "single-choice" | "confirm";
  options: string[];
  recommendation?: string;
  evidence?: string;
  answerFor?: string;
}

export type AnswerDisposition = "PENDING" | "ACCEPTED" | "PARTIAL" | "AMBIGUOUS" | "DEFERRED" | "CONTRADICTED";

export interface InterviewAnswer {
  questionId: string;
  question: string;
  rawAnswer: string;
  disposition: AnswerDisposition;
  normalizedDecision?: string;
  remainingUncertainty?: string;
  answeredAt: string;
}

export interface AnswerReview {
  questionId: string;
  disposition: Exclude<AnswerDisposition, "PENDING">;
  normalizedDecision?: string;
  remainingUncertainty?: string;
}

export interface InterviewAnalysis {
  contract: "rb-harness-interview/v1";
  status: "ready" | "needs_input" | "blocked";
  summary: string;
  discoveries: string[];
  assumptions: string[];
  unresolved: string[];
  answerReviews: AnswerReview[];
  questions: InterviewQuestion[];
}

export interface ArtifactAuditFinding {
  id: string;
  category:
    | "ambiguity"
    | "contradiction"
    | "proofability"
    | "regression-coverage"
    | "source-authority"
    | "task-boundary"
    | "traceability";
  artifact: string;
  criterion: string;
  evidence: string;
  requiredChange: string;
}

export interface ArtifactAudit {
  contract: "rb-harness-artifact-audit/v1";
  status: "pass" | "revise" | "blocked";
  summary: string;
  findings: ArtifactAuditFinding[];
}

export interface ArtifactAuditRecord extends ArtifactAudit {
  pass: number;
  fingerprint: string;
  auditedAt: string;
}

export interface ProjectInventory {
  projectRoot: string;
  artifactDirectory: string;
  manifestFound: boolean;
  manifestValid: boolean;
  projectId?: string;
  projectName?: string;
  generatedAt?: string;
  artifacts: number;
  byKind: Record<string, number>;
  byStatus: Record<string, number>;
  readyPlans: Array<{ id: string; path: string }>;
  artifactHighlights: Array<{
    id: string;
    kind: string;
    status: string;
    path: string;
    title?: string;
    summary?: string;
  }>;
  ralphRuns: Array<{ id: string; status: string }>;
  issues: Array<{ code: string; message: string }>;
}

export interface HarnessRunState {
  contract: typeof STANDALONE_STATE_CONTRACT;
  id: string;
  workflow: HarnessWorkflow;
  status: RunStatus;
  projectRoot: string;
  artifactDirectory: string;
  request: string;
  requestSource?: string;
  requestHash: string;
  provider: ProviderConfiguration;
  answers: InterviewAnswer[];
  interviewRound?: number;
  activeInterviewRound?: number;
  analysis?: InterviewAnalysis;
  artifactAudits?: ArtifactAuditRecord[];
  inventory: ProjectInventory;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
  previousArtifacts?: string;
  diagnostic?: string;
}

export interface StandaloneRunOptions {
  workflow: HarnessWorkflow;
  projectRoot: string;
  artifactDirectory: string;
  request: string;
  requestSource?: string;
  provider: ProviderConfiguration;
  answersFile?: string;
  questionMode: "one-by-one" | "batch";
  nonInteractive: boolean;
  timeoutSeconds: number;
  firstOutputTimeoutSeconds: number;
  resumeId?: string;
}
