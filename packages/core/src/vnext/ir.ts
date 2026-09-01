import type {
  AcceptanceId,
  PhaseId,
  ProjectId,
  RelPath,
  RequirementId,
  SemanticKey,
  Sha256,
  TaskId,
} from "./identity.js";

export const INIT_PROJECT_MODEL_VERSION = "rb-init-project-model/v1" as const;

export type Materiality = "product" | "architecture" | "implementation" | "preference";
export type Rigidity = "RIGID" | "FLEXIBLE";
export type QualityCommandKind = "test" | "build" | "lint" | "typecheck" | "run";
export type RecommendationAcceptanceMode = "blank-interactive" | "non-interactive-policy";

/** Minimal Core-verified authority retained by the resolved model, not interview history. */
export interface AcceptedRecommendationProof {
  readonly value: string;
  readonly acceptanceMode: RecommendationAcceptanceMode;
}

/** Semantic provenance accepted by trusted Core resolution. Provider wire remains narrower. */
export type DeterminationSourceInput =
  | { readonly kind: "request"; readonly evidence: string }
  | { readonly kind: "user-answer"; readonly questionKey: string }
  | { readonly kind: "accepted-recommendation"; readonly questionKey: string }
  | { readonly kind: "model-default" }
  | { readonly kind: "developer" };

export type ProtectedPathSourceInput = Exclude<DeterminationSourceInput, { readonly kind: "developer" }>;

export interface SemanticDeterminationInput {
  readonly key: string;
  readonly statement: string;
  readonly rationale: string;
  readonly materiality: Materiality;
  readonly rigidity: Rigidity;
  readonly source: DeterminationSourceInput;
}

export interface SemanticRequirementInput {
  readonly key: string;
  readonly statement: string;
}

export interface SemanticQualityCommandInput {
  readonly key: string;
  readonly kind: QualityCommandKind;
  readonly command: string;
}

export type ValidationIntentInput =
  | { readonly kind: "command"; readonly commandKey: string }
  | { readonly kind: "manual"; readonly inspection: string }
  | { readonly kind: "human"; readonly evidence: string };

export interface SemanticTaskInput {
  readonly key: string;
  readonly title: string;
  readonly intent: string;
  readonly dependsOn: readonly string[];
  readonly ownedPaths: readonly string[];
  readonly covers: readonly string[];
  readonly acceptance: readonly string[];
  readonly validation: readonly ValidationIntentInput[];
  readonly expectedEvidence: string;
}

export interface SemanticPhaseInput {
  readonly key: string;
  readonly title: string;
  readonly goal: string;
  readonly dependsOn: readonly string[];
  readonly tasks: readonly SemanticTaskInput[];
}

export interface SemanticProtectedPathInput {
  readonly path: string;
  readonly reason: string;
  readonly source: ProtectedPathSourceInput;
}

/** Hand-authored semantic input. It intentionally has no machine identity. */
export interface SemanticInitProject {
  readonly workflow: "init";
  readonly project: {
    readonly name: string;
    readonly objective: string;
  };
  readonly determinations: readonly SemanticDeterminationInput[];
  readonly requirements: readonly SemanticRequirementInput[];
  readonly qualityCommands: readonly SemanticQualityCommandInput[];
  readonly protectedPaths: readonly SemanticProtectedPathInput[];
  readonly phases: readonly SemanticPhaseInput[];
}

export type DeterminationSource =
  | { readonly kind: "request"; readonly evidence: string }
  | { readonly kind: "user-answer"; readonly questionKey: SemanticKey }
  | { readonly kind: "accepted-recommendation"; readonly questionKey: SemanticKey }
  | { readonly kind: "model-default" }
  | { readonly kind: "developer" };

export interface Determination {
  readonly key: SemanticKey;
  readonly statement: string;
  readonly rationale: string;
  readonly materiality: Materiality;
  readonly rigidity: Rigidity;
  readonly source: DeterminationSource;
}

export interface Requirement {
  readonly key: SemanticKey;
  readonly id: RequirementId;
  readonly statement: string;
}

export interface QualityCommand {
  readonly key: SemanticKey;
  readonly kind: QualityCommandKind;
  readonly command: string;
}

export type ProtectedPathSource =
  | { readonly kind: "built-in" }
  | { readonly kind: "request"; readonly evidence: string }
  | { readonly kind: "user-answer"; readonly questionKey: SemanticKey }
  | { readonly kind: "accepted-recommendation"; readonly questionKey: SemanticKey };

export interface ProtectedPath {
  readonly path: RelPath;
  readonly reason: string;
  readonly source: ProtectedPathSource;
}

export type ValidationIntent =
  | { readonly kind: "command"; readonly commandKey: SemanticKey }
  | { readonly kind: "manual"; readonly inspection: string }
  | { readonly kind: "human"; readonly evidence: string };

export interface AcceptanceSemantics {
  readonly id: AcceptanceId;
  readonly statement: string;
}

export interface SemanticTask {
  readonly key: SemanticKey;
  readonly id: TaskId;
  readonly title: string;
  readonly intent: string;
  readonly dependsOn: readonly TaskId[];
  readonly ownedPaths: readonly RelPath[];
  readonly covers: readonly RequirementId[];
  readonly acceptance: readonly AcceptanceSemantics[];
  readonly validation: readonly ValidationIntent[];
  readonly expectedEvidence: string;
  readonly parallelSafe: false;
}

export interface SemanticPhase {
  readonly key: SemanticKey;
  readonly number: number;
  readonly id: PhaseId;
  readonly title: string;
  readonly goal: string;
  readonly dependsOn: readonly PhaseId[];
  readonly tasks: readonly SemanticTask[];
}

export interface ProjectIdentity {
  readonly id: ProjectId;
  readonly name: string;
  readonly objective: string;
}

export interface Provenance {
  readonly runId: string;
  readonly requestSha256: Sha256;
  readonly originalRequest: string;
  readonly answers: Readonly<Record<string, string>>;
  readonly acceptedRecommendations: Readonly<Record<string, AcceptedRecommendationProof>>;
  readonly generatedAt: string;
}

export interface ProjectCore {
  readonly identity: ProjectIdentity;
  readonly determinations: readonly Determination[];
  readonly protectedPaths: readonly ProtectedPath[];
  readonly provenance: Provenance;
}

export interface InitProjectModel {
  readonly version: typeof INIT_PROJECT_MODEL_VERSION;
  readonly workflow: "init";
  readonly core: ProjectCore;
  readonly requirements: readonly Requirement[];
  readonly qualityCommands: readonly QualityCommand[];
  readonly phases: readonly SemanticPhase[];
}

export interface ResolutionContext {
  readonly originalRequest: string;
  readonly answers?: Readonly<Record<string, string>>;
  readonly acceptedRecommendations?: Readonly<Record<string, AcceptedRecommendationProof>>;
  readonly runId: string;
  readonly generatedAt: string;
}

export interface IrConsumerRegistration {
  readonly path: string;
  readonly consumer: string;
}

type RequestDeterminationSource = Extract<DeterminationSource, { readonly kind: "request" }>;
type AnswerDeterminationSource = Extract<DeterminationSource, { readonly kind: "user-answer" }>;
type AcceptedDeterminationSource = Extract<DeterminationSource, { readonly kind: "accepted-recommendation" }>;
type DefaultDeterminationSource = Extract<DeterminationSource, { readonly kind: "model-default" }>;
type DeveloperDeterminationSource = Extract<DeterminationSource, { readonly kind: "developer" }>;
type BuiltInProtectedPathSource = Extract<ProtectedPathSource, { readonly kind: "built-in" }>;
type RequestProtectedPathSource = Extract<ProtectedPathSource, { readonly kind: "request" }>;
type AnswerProtectedPathSource = Extract<ProtectedPathSource, { readonly kind: "user-answer" }>;
type AcceptedProtectedPathSource = Extract<ProtectedPathSource, { readonly kind: "accepted-recommendation" }>;
type CommandValidationIntent = Extract<ValidationIntent, { readonly kind: "command" }>;
type ManualValidationIntent = Extract<ValidationIntent, { readonly kind: "manual" }>;
type HumanValidationIntent = Extract<ValidationIntent, { readonly kind: "human" }>;

/*
 * Each production surface has an exact keyof witness. Adding a field to an IR
 * interface or union variant therefore fails TypeScript until a present-tense
 * consumer is registered. This intentionally stays local and static.
 */
const MODEL_CONSUMERS = {
  version: { path: "version", consumer: "validate selects the supported canonical contract" },
  workflow: { path: "workflow", consumer: "validate and closeInitProject select the init workflow" },
  core: { path: "core", consumer: "the closure and renderers consume shared project semantics" },
  requirements: { path: "requirements", consumer: "coverage validation and BRIEF render the requirement set" },
  qualityCommands: { path: "qualityCommands", consumer: "validation resolves command intents and PHASES renders commands" },
  phases: { path: "phases", consumer: "validation and ExecutionDocument derivation consume ordered work" },
} satisfies Record<keyof InitProjectModel, IrConsumerRegistration>;

const CORE_CONSUMERS = {
  identity: { path: "core.identity", consumer: "artifact identity and document titles derive from project identity" },
  determinations: { path: "core.determinations", consumer: "authority validation and BRIEF consume determinations" },
  protectedPaths: { path: "core.protectedPaths", consumer: "scope validation and BRIEF consume authoritative paths" },
  provenance: { path: "core.provenance", consumer: "closure validation and manifest generation consume run provenance" },
} satisfies Record<keyof ProjectCore, IrConsumerRegistration>;

const IDENTITY_CONSUMERS = {
  id: { path: "core.identity.id", consumer: "artifact IDs derive from the code-owned project ID" },
  name: { path: "core.identity.name", consumer: "PHASES and BRIEF render the project name" },
  objective: { path: "core.identity.objective", consumer: "BRIEF renders the project objective" },
} satisfies Record<keyof ProjectIdentity, IrConsumerRegistration>;

const PROVENANCE_CONSUMERS = {
  runId: { path: "core.provenance.runId", consumer: "validate checks the deterministic run identity" },
  requestSha256: { path: "core.provenance.requestSha256", consumer: "validate binds provenance to originalRequest" },
  originalRequest: { path: "core.provenance.originalRequest", consumer: "authority validation verifies request evidence" },
  answers: { path: "core.provenance.answers", consumer: "authority validation verifies referenced user answers" },
  acceptedRecommendations: { path: "core.provenance.acceptedRecommendations", consumer: "authority validation verifies referenced accepted recommendations" },
  generatedAt: { path: "core.provenance.generatedAt", consumer: "manifest generatedAt uses the single frozen run clock" },
} satisfies Record<keyof Provenance, IrConsumerRegistration>;

const DETERMINATION_CONSUMERS = {
  key: { path: "core.determinations[].key", consumer: "validate enforces determination identity uniqueness and grammar" },
  statement: { path: "core.determinations[].statement", consumer: "BRIEF renders confirmed/default determinations" },
  rationale: { path: "core.determinations[].rationale", consumer: "BRIEF renders why the determination exists" },
  materiality: { path: "core.determinations[].materiality", consumer: "authority validation gates RIGID defaults" },
  rigidity: { path: "core.determinations[].rigidity", consumer: "authority validation and BRIEF classify defaults" },
  source: { path: "core.determinations[].source", consumer: "authority validation proves the determination source" },
} satisfies Record<keyof Determination, IrConsumerRegistration>;

const REQUEST_DETERMINATION_SOURCE_CONSUMERS = {
  kind: { path: "core.determinations[].source.kind", consumer: "authority validation selects the request proof rule" },
  evidence: { path: "core.determinations[].source.evidence", consumer: "authority validation verifies a meaningful request phrase" },
} satisfies Record<keyof RequestDeterminationSource, IrConsumerRegistration>;
const ANSWER_DETERMINATION_SOURCE_CONSUMERS = {
  kind: { path: "core.determinations[].source.kind", consumer: "authority validation selects the answer proof rule" },
  questionKey: { path: "core.determinations[].source.questionKey", consumer: "authority validation resolves persisted answer data" },
} satisfies Record<keyof AnswerDeterminationSource, IrConsumerRegistration>;
const ACCEPTED_DETERMINATION_SOURCE_CONSUMERS = {
  kind: { path: "core.determinations[].source.kind", consumer: "authority validation selects the accepted-recommendation proof rule" },
  questionKey: { path: "core.determinations[].source.questionKey", consumer: "authority validation resolves Core-verified recommendation evidence" },
} satisfies Record<keyof AcceptedDeterminationSource, IrConsumerRegistration>;
const DEFAULT_DETERMINATION_SOURCE_CONSUMERS = {
  kind: { path: "core.determinations[].source.kind", consumer: "authority validation applies model-default rigidity policy" },
} satisfies Record<keyof DefaultDeterminationSource, IrConsumerRegistration>;
const DEVELOPER_DETERMINATION_SOURCE_CONSUMERS = {
  kind: { path: "core.determinations[].source.kind", consumer: "authority validation recognizes trusted developer-owned semantic artifacts" },
} satisfies Record<keyof DeveloperDeterminationSource, IrConsumerRegistration>;

const PROTECTED_PATH_CONSUMERS = {
  path: { path: "core.protectedPaths[].path", consumer: "scope validation rejects intersections and BRIEF renders authority" },
  reason: { path: "core.protectedPaths[].reason", consumer: "BRIEF explains protected path authority" },
  source: { path: "core.protectedPaths[].source", consumer: "authority validation proves why the path is protected" },
} satisfies Record<keyof ProtectedPath, IrConsumerRegistration>;
const BUILTIN_PATH_SOURCE_CONSUMERS = {
  kind: { path: "core.protectedPaths[].source.kind", consumer: "authority validation recognizes the built-in policy" },
} satisfies Record<keyof BuiltInProtectedPathSource, IrConsumerRegistration>;
const REQUEST_PATH_SOURCE_CONSUMERS = {
  kind: { path: "core.protectedPaths[].source.kind", consumer: "authority validation selects the request proof rule" },
  evidence: { path: "core.protectedPaths[].source.evidence", consumer: "authority validation verifies a meaningful request phrase" },
} satisfies Record<keyof RequestProtectedPathSource, IrConsumerRegistration>;
const ANSWER_PATH_SOURCE_CONSUMERS = {
  kind: { path: "core.protectedPaths[].source.kind", consumer: "authority validation selects the answer proof rule" },
  questionKey: { path: "core.protectedPaths[].source.questionKey", consumer: "authority validation resolves persisted answer data" },
} satisfies Record<keyof AnswerProtectedPathSource, IrConsumerRegistration>;
const ACCEPTED_PATH_SOURCE_CONSUMERS = {
  kind: { path: "core.protectedPaths[].source.kind", consumer: "authority validation selects the accepted-recommendation proof rule" },
  questionKey: { path: "core.protectedPaths[].source.questionKey", consumer: "authority validation resolves Core-verified recommendation evidence" },
} satisfies Record<keyof AcceptedProtectedPathSource, IrConsumerRegistration>;

const REQUIREMENT_CONSUMERS = {
  key: { path: "requirements[].key", consumer: "resolution binds authored coverage keys" },
  id: { path: "requirements[].id", consumer: "coverage validation, PHASES, and BRIEF use code-owned IDs" },
  statement: { path: "requirements[].statement", consumer: "BRIEF renders requirement meaning" },
} satisfies Record<keyof Requirement, IrConsumerRegistration>;
const QUALITY_COMMAND_CONSUMERS = {
  key: { path: "qualityCommands[].key", consumer: "validation intents resolve commands by semantic key" },
  kind: { path: "qualityCommands[].kind", consumer: "BRIEF identifies quality-command purpose" },
  command: { path: "qualityCommands[].command", consumer: "command safety validation and PHASES rendering consume it" },
} satisfies Record<keyof QualityCommand, IrConsumerRegistration>;

const PHASE_CONSUMERS = {
  key: { path: "phases[].key", consumer: "resolution orders symbolic phase dependencies" },
  number: { path: "phases[].number", consumer: "identity validation and PHASES phase ordering consume it" },
  id: { path: "phases[].id", consumer: "dependencies and PHASES use code-owned phase identity" },
  title: { path: "phases[].title", consumer: "PHASES renders the phase heading" },
  goal: { path: "phases[].goal", consumer: "PHASES renders the phase goal" },
  dependsOn: { path: "phases[].dependsOn", consumer: "graph validation and PHASES render phase dependencies" },
  tasks: { path: "phases[].tasks", consumer: "validation and ExecutionDocument derivation consume ordered tasks" },
} satisfies Record<keyof SemanticPhase, IrConsumerRegistration>;
const TASK_CONSUMERS = {
  key: { path: "phases[].tasks[].key", consumer: "resolution orders symbolic task dependencies" },
  id: { path: "phases[].tasks[].id", consumer: "PHASES and acceptance IDs use global code-owned task identity" },
  title: { path: "phases[].tasks[].title", consumer: "PHASES renders task headings" },
  intent: { path: "phases[].tasks[].intent", consumer: "control-plane validation and PHASES render change intent" },
  dependsOn: { path: "phases[].tasks[].dependsOn", consumer: "graph validation and PHASES render dependencies" },
  ownedPaths: { path: "phases[].tasks[].ownedPaths", consumer: "path safety/protection validation and PHASES Scope consume it" },
  covers: { path: "phases[].tasks[].covers", consumer: "requirement coverage validation and PHASES consume it" },
  acceptance: { path: "phases[].tasks[].acceptance", consumer: "semantic validation and PHASES consume acceptance" },
  validation: { path: "phases[].tasks[].validation", consumer: "validation closure and PHASES consume validation intents" },
  expectedEvidence: { path: "phases[].tasks[].expectedEvidence", consumer: "PHASES renders expected proof" },
  parallelSafe: { path: "phases[].tasks[].parallelSafe", consumer: "validate and PHASES enforce literal false" },
} satisfies Record<keyof SemanticTask, IrConsumerRegistration>;
const ACCEPTANCE_CONSUMERS = {
  id: { path: "phases[].tasks[].acceptance[].id", consumer: "identity validation and PHASES render acceptance identity" },
  statement: { path: "phases[].tasks[].acceptance[].statement", consumer: "acceptance validation and PHASES consume semantics" },
} satisfies Record<keyof AcceptanceSemantics, IrConsumerRegistration>;
const COMMAND_VALIDATION_CONSUMERS = {
  kind: { path: "phases[].tasks[].validation[].kind", consumer: "validation and rendering select command behavior" },
  commandKey: { path: "phases[].tasks[].validation[].commandKey", consumer: "validation and rendering resolve a declared quality command" },
} satisfies Record<keyof CommandValidationIntent, IrConsumerRegistration>;
const MANUAL_VALIDATION_CONSUMERS = {
  kind: { path: "phases[].tasks[].validation[].kind", consumer: "validation and rendering select manual behavior" },
  inspection: { path: "phases[].tasks[].validation[].inspection", consumer: "ambiguity validation and PHASES render manual inspection" },
} satisfies Record<keyof ManualValidationIntent, IrConsumerRegistration>;
const HUMAN_VALIDATION_CONSUMERS = {
  kind: { path: "phases[].tasks[].validation[].kind", consumer: "validation and rendering select human behavior" },
  evidence: { path: "phases[].tasks[].validation[].evidence", consumer: "line validation and PHASES render human evidence" },
} satisfies Record<keyof HumanValidationIntent, IrConsumerRegistration>;

export const INIT_PROJECT_IR_CONSUMERS: readonly IrConsumerRegistration[] = [...new Map([
  ...Object.values(MODEL_CONSUMERS), ...Object.values(CORE_CONSUMERS), ...Object.values(IDENTITY_CONSUMERS),
  ...Object.values(PROVENANCE_CONSUMERS), ...Object.values(DETERMINATION_CONSUMERS),
  ...Object.values(REQUEST_DETERMINATION_SOURCE_CONSUMERS), ...Object.values(ANSWER_DETERMINATION_SOURCE_CONSUMERS),
  ...Object.values(ACCEPTED_DETERMINATION_SOURCE_CONSUMERS), ...Object.values(DEFAULT_DETERMINATION_SOURCE_CONSUMERS),
  ...Object.values(DEVELOPER_DETERMINATION_SOURCE_CONSUMERS), ...Object.values(PROTECTED_PATH_CONSUMERS),
  ...Object.values(BUILTIN_PATH_SOURCE_CONSUMERS), ...Object.values(REQUEST_PATH_SOURCE_CONSUMERS),
  ...Object.values(ANSWER_PATH_SOURCE_CONSUMERS), ...Object.values(ACCEPTED_PATH_SOURCE_CONSUMERS), ...Object.values(REQUIREMENT_CONSUMERS),
  ...Object.values(QUALITY_COMMAND_CONSUMERS), ...Object.values(PHASE_CONSUMERS), ...Object.values(TASK_CONSUMERS),
  ...Object.values(ACCEPTANCE_CONSUMERS), ...Object.values(COMMAND_VALIDATION_CONSUMERS),
  ...Object.values(MANUAL_VALIDATION_CONSUMERS), ...Object.values(HUMAN_VALIDATION_CONSUMERS),
].map((entry) => [entry.path, entry] as const)).values()].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);

export const INIT_PROJECT_IR_FIELDS = INIT_PROJECT_IR_CONSUMERS.map((entry) => entry.path);
