/**
 * Documented operational budget for the documentation core.
 *
 * Every number here is a product decision, not a tuning knob. Raising a
 * ceiling to make a fixture pass is not a fix: the state machine must stay
 * finite, so a run that cannot fit must fail with a resumable checkpoint and
 * an explicit diagnostic instead of silently buying more provider work.
 */

export const HARNESS_BUDGET = {
  /** Finite interview: one initial batch plus at most one focused follow-up. */
  interview: {
    /** Total analysis rounds; round 1 is the batch, round 2 is the follow-up. */
    maxRounds: 2,
    /** Questions accepted in the first round. */
    firstRoundQuestions: 5,
    /** Questions accepted in the single follow-up round. */
    followUpQuestions: 3,
    /** Protocol repair attempts per round before the run fails. */
    protocolAttempts: 2,
  },
  /** One authoritative authoring call plus at most one localized repair. */
  generation: {
    authoringCalls: 1,
    structuralRepairs: 1,
    protocolAttempts: 2,
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
    /** Hard ceiling on the serialized input package handed to the provider. */
    maxPackageBytes: 64 * 1024,
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
  /** Documents accepted from one authoring call. */
  documents: {
    maxDocuments: 120,
    maxDocumentBytes: 512 * 1024,
    maxBundleBytes: 8 * 1024 * 1024,
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
    maxInterviewPromptBytes: 192 * 1024,
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
