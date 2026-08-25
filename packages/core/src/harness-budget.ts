/**
 * Documented operational budget for the documentation core.
 *
 * Every number here is a product decision, not a tuning knob. Raising a
 * ceiling to make a fixture pass is not a fix: the state machine must stay
 * finite, so a run that cannot fit must fail with a resumable checkpoint and
 * an explicit diagnostic instead of silently buying more provider work.
 */

export const HARNESS_BUDGET = {
  /**
   * Adaptive interview.
   *
   * The interview ends when the analysis converges, not when a fixed number of
   * rounds elapses: an answer that opens a new material decision earns another
   * focused round. `maxRounds` and `maxQuestions` are safety ceilings that keep
   * the state machine finite, not the intended stopping point. Reaching either
   * one is a reportable failure to converge, never a silent acceptance.
   */
  interview: {
    /** Safety ceiling on adaptive analysis rounds in one run. */
    maxRounds: 12,
    /** Questions accepted in the opening batch. */
    firstRoundQuestions: 5,
    /** Questions accepted in each adaptive follow-up round. */
    followUpQuestions: 3,
    /** Safety ceiling on questions asked across the whole run. */
    maxQuestions: 40,
  },
  /** Incremental authoring plus at most one localized structural repair. */
  generation: {
    structuralRepairs: 1,
  },
  /**
   * Task decomposition ceilings for a generated `rb-execution/v1` plan.
   *
   * RB Ralph runs one ephemeral, context-free call per task. A task that
   * carries a whole feature therefore has to be re-derived from nothing inside
   * a single window, which is exactly where an executor forgets earlier
   * requirements or invents them. These ceilings are deterministic and
   * observable in the document itself; they never judge prose quality.
   */
  decomposition: {
    /** Requirement IDs one task may carry in `Covers`. */
    maxCoveredRequirements: 3,
    /** Acceptance criteria one task may declare. */
    maxAcceptanceCriteria: 6,
    /** Scope path tokens one task may declare. */
    maxScopePaths: 8,
    /** Tasks one phase may declare before it stops being one observable outcome. */
    maxTasksPerPhase: 12,
    /** Requirement IDs a single-task phase may carry before it is a whole feature. */
    maxSingleTaskPhaseRequirements: 2,
  },
  /** Representation-only recovery after one semantic response. */
  formatting: {
    /** Fresh, closed formatter calls after the raw response fails its parser. */
    maxAttempts: 3,
    maxRawBytes: 384 * 1024,
    maxPriorBytes: 64 * 1024,
    maxContractBytes: 32 * 1024,
  },
  /** Deterministic project inventory handed to the model before call one. */
  inventory: {
    maxFiles: 400,
    maxDirectories: 120,
    maxDepth: 6,
    /** Per-directory sample retained when a directory exceeds the file budget. */
    directorySample: 12,
    /** Largest file the summarizer will open for a headline/summary. */
    maxSummarizedFileBytes: 128 * 1024,
    /**
     * Hard ceiling on the serialized input package handed to the provider.
     *
     * Accepted decisions are authority and are never trimmed, so this ceiling
     * has to hold every decision a converging interview can accept — up to
     * `interview.maxQuestions` of them — alongside the request and the reduced
     * inventory. A package that still does not fit fails loudly.
     */
    maxPackageBytes: 128 * 1024,
  },
  /**
   * Read-only evidence projection handed to a provider. Larger than the
   * summarized inventory because a provider reads real files, but still a
   * declared ceiling — never the whole repository.
   */
  evidence: {
    maxFiles: 5_000,
    maxBytes: 64 * 1024 * 1024,
    maxFileBytes: 2 * 1024 * 1024,
    maxDepth: 12,
  },
  /** Confined documentation tool surface (RF-011). */
  tools: {
    maxCalls: 40,
    maxOutputBytes: 32 * 1024,
    accumulatedOutputBytes: 512 * 1024,
    maxReadLines: 400,
    maxListedFiles: 500,
    maxSearchMatches: 100,
    /** Consecutive identical calls tolerated before the runtime refuses them. */
    repeatCallLimit: 3,
  },
  /**
   * Governance of a provider's output stream. A controlled adapter is held to
   * the event ceilings; an opaque one is held to the progress window, which is
   * the only honest limit when there is nothing to count.
   */
  stream: {
    maxTurnEvents: 120,
    /** Window in which output must carry something new, or the run ends. */
    noProgressMilliseconds: 10 * 60 * 1000,
    /** Distinct line fingerprints retained while judging progress. */
    progressFingerprints: 4_096,
  },
  /** Provider transcript ceilings measured in UTF-8 bytes. */
  provider: {
    interviewOutputBytes: 8 * 1024 * 1024,
    generationOutputBytes: 32 * 1024 * 1024,
    repairOutputBytes: 16 * 1024 * 1024,
  },
  /** Documents assembled from independently bounded authoring parts. */
  documents: {
    maxDocuments: 120,
    maxDocumentBytes: 512 * 1024,
    maxBundleBytes: 8 * 1024 * 1024,
    /** The plan is intentionally small enough for conservative CLI/model output windows. */
    maxPlanBytes: 20 * 1024,
    /** A plan is an index, not documentation prose. */
    maxPlannedDocuments: 48,
    maxPlannedParts: 128,
    /** One provider response never carries more document body than this. */
    maxPartBytes: 12 * 1024,
    /**
     * Ceiling on the JSON envelope that transports one part.
     *
     * JSON escaping inflates the authored bytes — a segment dense in quotes or
     * newlines grows measurably — so the transport ceiling is derived from
     * `maxPartBytes` rather than borrowed from the plan's, which describes a
     * different document entirely.
     */
    maxPartEnvelopeBytes: 32 * 1024,
    maxPartsPerDocument: 64,
    maxTotalParts: 512,
  },
  /** Process-tree ownership ladder (RF-008). */
  process: {
    /** Window between SIGTERM to the tree and the SIGKILL escalation. */
    graceMilliseconds: 5_000,
    /** Poll cadence while confirming the tree is quiescent. */
    quiescencePollMilliseconds: 25,
    /** Upper bound on the post-SIGKILL quiescence wait before reporting it. */
    quiescenceTimeoutMilliseconds: 15_000,
    /**
     * Cadence for sampling the live process tree. Descendant identity must be
     * captured while the run is alive; a survivor that reparents to init after
     * the leader exits is invisible to a post-mortem walk.
     */
    treeSampleMilliseconds: 100,
  },
  /** Bounded prompt sections; snapshot tests assert these ceilings. */
  prompt: {
    maxContractDigestBytes: 12 * 1024,
    /**
     * The interview prompt carries the whole input package plus the round
     * state, prior checkpoint, and pending answers. It keeps roughly the same
     * headroom over `inventory.maxPackageBytes` that it had before the
     * interview became adaptive, so a converging run cannot fail on its own
     * accepted decisions.
     */
    maxInterviewPromptBytes: 320 * 1024,
    maxGenerationPromptBytes: 512 * 1024,
    maxRepairPromptBytes: 512 * 1024,
    /**
     * Largest developer request the Harness carries. The request is authority
     * and is never truncated, so an oversized one fails the preflight.
     */
    maxRequestBytes: 256 * 1024,
    /** Bound on each authority-bearing section of the input package. */
    maxDecisionBytes: 64 * 1024,
    maxHighlightBytes: 48 * 1024,
    maxCheckpointBytes: 48 * 1024,
  },
} as const;

/** Questions accepted in one interview round. */
export function interviewQuestionBudget(round: number): number {
  return round <= 1
    ? HARNESS_BUDGET.interview.firstRoundQuestions
    : HARNESS_BUDGET.interview.followUpQuestions;
}
