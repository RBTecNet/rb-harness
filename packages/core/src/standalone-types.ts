export const STANDALONE_STATE_CONTRACT = "rb-harness-run/v1" as const;

export type HarnessWorkflow = "init" | "ai-context" | "plan" | "evolve" | "review";
export type RunStatus =
  | "inventory"
  | "interview"
  | "interview-failed"
  | "blocked"
  | "generating"
  | "generation-failed"
  | "materializing"
  | "validating"
  | "repairing"
  /** Historical only: the removed semantic manager stage, kept resumable. */
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
  /** Superficial protocol deviations the program repaired instead of failing. */
  normalizations?: string[];
  /**
   * Semantic protocol violations — an answer left unclassified or given an
   * unsupported disposition. These are never repaired into an acceptance; they
   * earn one focused follow-up or block the run.
   */
  semanticDefects?: string[];
  /** Questions that exceeded the round budget and became deferred decisions. */
  overflowQuestions?: number;
}

export interface ArtifactAuditFinding {
  id: string;
  severity?: "blocker" | "major" | "minor";
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
  decision?: {
    question: string;
    reason: string;
    options: string[];
  };
}

export interface ArtifactAuditRecord extends ArtifactAudit {
  pass: number;
  fingerprint: string;
  auditedAt: string;
}

export interface GenerationCheckpoint {
  contract: "rb-harness-generation-checkpoint/v1";
  pass: number;
  providerCompletedAt: string;
}

/**
 * Durable boundaries between paid and unpaid work (RF-012). A complete
 * provider response that is already preserved is never requested again.
 */
export interface RunCheckpoints {
  /** The interview reached a ready checkpoint with no pending answer. */
  interviewCompletedAt?: string;
  /** A complete document bundle was received and persisted to bundle.json. */
  bundleReceivedAt?: string;
  /** Documents were materialized into the staging tree. */
  materializedAt?: string;
  /** Deterministic validation of the staged tree passed. */
  validatedAt?: string;
  /** The staged tree was atomically published. */
  publishedAt?: string;
}

export interface BundleCheckpoint {
  contract: "rb-harness-documents/v1";
  documents: number;
  sha256: string;
  receivedAt: string;
  repaired: boolean;
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
  /** Historical only: records written by the removed semantic manager. */
  artifactAudits?: ArtifactAuditRecord[];
  generationCheckpoint?: GenerationCheckpoint;
  checkpoints?: RunCheckpoints;
  bundle?: BundleCheckpoint;
  /** Structural repairs already spent; the budget is exactly one. */
  repairsUsed?: number;
  telemetry?: unknown;
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
