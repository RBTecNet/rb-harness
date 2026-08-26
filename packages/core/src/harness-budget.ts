/**
 * Documented operational budget for the documentation core.
 *
 * Every number here is a product decision, not a tuning knob. Raising a
 * ceiling to make a fixture pass is not a fix: the state machine must stay
 * finite, so a run that cannot fit must fail with a resumable checkpoint and
 * an explicit diagnostic instead of silently buying more provider work.
 */

/**
 * Largest authored segment one provider response may carry.
 *
 * An operator can raise it for a model with a wider output window; it is never
 * lowered below the default, because a smaller ceiling would reject work the
 * shipped contract text tells the writer it may produce.
 */
function partByteCeiling(): number {
  const declared = Number(process.env.RB_HARNESS_MAX_PART_BYTES);
  const fallback = 48 * 1024;
  if (!Number.isFinite(declared) || declared <= 0) return fallback;
  return Math.max(fallback, Math.floor(declared));
}

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
  /** Incremental authoring plus a small bounded structural-convergence loop. */
  generation: {
    /**
     * Independent localized repairs allowed while deterministic findings keep
     * changing. Three passes let the writer fix a primary contract defect and
     * the cross-document consequences it exposed without turning recovery into
     * an unbounded provider loop.
     */
    structuralRepairs: 3,
    /**
     * Replans of the document plan after a substance defect.
     *
     * The formatter may only change representation, so a plan that names a
     * forbidden path cannot be repaired by it — three paid attempts would each
     * fail the same way. One replan, told exactly what was rejected, is both
     * cheaper and the only thing that can actually fix it.
     */
    planReplans: 1,
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
    /**
     * Acceptance criteria one task may declare.
     *
     * A proxy for how much work the task carries, unlike `Covers`, which
     * records traceability: a one-file task can legitimately prove many
     * requirements, so its count says nothing about size.
     */
    maxAcceptanceCriteria: 6,
    /** Scope path tokens one task may declare. */
    maxScopePaths: 8,
    /** Tasks one phase may declare before it stops being one observable outcome. */
    maxTasksPerPhase: 12,
    /**
     * Criteria that make a lone area-scoped task "the whole feature".
     *
     * Below this, a single task scoped to a directory is just a small phase —
     * the contract's own minimal example is exactly that — so the undecomposed
     * gate needs this third signal before it stops a run.
     */
    undecomposedFeatureCriteria: 4,
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
    maxDocumentBytes: Math.max(512 * 1024, partByteCeiling() * 16),
    maxBundleBytes: 8 * 1024 * 1024,
    /** The plan is intentionally small enough for conservative CLI/model output windows. */
    maxPlanBytes: 20 * 1024,
    /** A plan is an index, not documentation prose. */
    maxPlannedDocuments: 48,
    maxPlannedParts: 128,
    /**
     * Document body one provider response carries.
     *
     * Raised from 12 KiB after real runs kept failing on it: an observed
     * `PHASES.md` segment came back at 12941 bytes, and a later one at 15420
     * even after the writer was asked to shorten it. A single phase carrying
     * five tasks with scope, criteria, validation, and expected evidence simply
     * does not fit in 12 KiB, so the ceiling was rejecting correct work.
     *
     * It is raised rather than removed. A part must still fit the provider's
     * own output window; without a ceiling an oversized segment comes back
     * silently truncated, and a document assembled from a cut-off part fails
     * later and less legibly than one rejected here. 48 KiB is roughly 12k
     * output tokens — comfortable for current models and still an honest bound.
     * `RB_HARNESS_MAX_PART_BYTES` raises it further for a model that can do
     * more, without waiting on a release.
     */
    maxPartBytes: partByteCeiling(),
    /**
     * Ceiling on the JSON envelope that transports one part.
     *
     * JSON escaping inflates the authored bytes — a segment dense in quotes or
     * newlines grows measurably — so the transport ceiling is derived from
     * `maxPartBytes` rather than borrowed from the plan's, which describes a
     * different document entirely.
     */
    maxPartEnvelopeBytes: partByteCeiling() * 3,
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
    /**
     * The code-owned output contract handed to every authoring call.
     *
     * Raised from 12 KiB as the contract absorbed rules that each came from an
     * observed failure — process lifecycle in `OPERATIONS.json`, one part per
     * phase, `Parallel safe` as a decision, and validations that cannot pass.
     * It is a cacheable prefix measured in kilobytes against prompts measured
     * in hundreds, so the headroom costs nothing and losing a rule would cost a
     * run.
     */
    maxContractDigestBytes: 16 * 1024,
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
