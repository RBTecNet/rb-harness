# RB Headless Interview Contract v1

<!-- generated-by: rb-harness; schema: rb-artifact/v1 -->

`rb-headless-interview/v1` exposes the Harness-owned adaptive interview without exposing its prompt or requiring a terminal transcript parser. It is a companion to `rb-headless-init/v1`: it decides and normalizes material requirements; the final `interview_complete.acceptedAnswers` can be copied losslessly into `rb-headless-init/v1.interviewAnswers`.

## Discovery and deterministic validation

```bash
rb-harness headless interview version
rb-harness headless interview validate < message.json
```

Unknown major contracts are rejected. Every request and response is one complete UTF-8 JSON document. JSON Schema and the runtime validator reject unknown properties, open enums, invalid IDs/hashes, oversized values, and trailing or malformed JSON.

## Invocation

```bash
rb-harness headless interview run \
  --state /absolute/durable/interview-state \
  --timeout 3600 \
  --first-output-timeout 300 < request.json
```

The state root is Harness-owned operational state, mode `0700`, with atomic session files mode `0600`. It must not equal the adapter workspace. The worker persists `requestId`, `interviewId`, `cursor`, active sequence and its own job/lease state. Provider prompts and rules remain inside the Harness.

The configured adapter receives the Harness prompt through stdin and must return the strict `rb-harness-interview/v1` provider envelope through stdout. It receives `RB_HEADLESS_MODE=interview`, request/interview IDs, public adapter labels, safe base environment and only operator-allowlisted variables. It never receives the state path. The Harness rejects adapter writes outside the state root, state mutation, protocol violations, and secret-sentinel output.

## Message machine

Each CLI invocation consumes one request and emits one `kind=response`. `events` preserves logical message ordering without requiring NDJSON or a long-lived process.

### Start or resume

`kind=interview_start` carries `requestId`, `captureHash`, the validated `rb-headless-init/v1` request projection and a nullable `cursor`.

- New `requestId`: validates init scope/attachments, creates the durable session and emits `question` or `interview_complete`.
- Existing identical request with `cursor=null`: idempotently recovers a response when the caller lost the first response.
- Existing request with the last cursor: resumes the exact active question or terminal completion without invoking the provider again.
- Different capture/init projection or stale non-null cursor: fails closed.

### Question

A `question` event contains a stable `questionId`, monotonic `sequence`, header, reason, question, closed type, options, `allowsFreeText`, optional `answerFor`, and `draftSchemaHash`. Options have stable IDs and an explicit boolean `recommended`; consumers never infer recommendation by parsing labels.

### Answer

`kind=answer` carries `requestId`, `interviewId`, active `sequence`, `questionId`, provisional answer, `idempotencyKey`, and the latest cursor. The Harness validates that the answer targets the one active question. Retrying the same idempotency key with the same canonical request returns the byte-equivalent cached response; reusing it with different data fails.

The response emits `answer_result` followed by either the next `question`, `interview_complete`, or `interview_failed`:

- `accepted` alone carries `normalizedDecision`;
- `partial`, `ambiguous`, and `contradicted` carry `remainingUncertainty` and a new focused `followUpQuestionId`;
- `deferred` is explicit and never becomes a fabricated decision.

An ambiguous or contradicted answer therefore cannot produce `interview_complete` in the same response.

### Complete

`interview_complete` contains only accepted answers in the exact `{questionId, question, answer, disposition:"accepted"}` shape accepted by `rb-headless-init/v1`, plus `transcriptHash`. Partial, ambiguous, contradicted, pending and deferred answers are not smuggled into generation authority.

## Durability, concurrency, and recovery

The cursor hashes the semantic session state: capture/init identity, adaptive round, sequence, analysis, answers and active question. It excludes response cache and timestamps that do not change authority. State writes are atomic. A per-session lock records the owner PID; a dead-PID lock is removed automatically, while a live owner returns retryable `session_locked`.

If power or process loss occurs during provider analysis, the previously committed question/cursor remains authoritative and the answer can be retried. If state was committed but the response was lost, the same idempotency key returns the stored response. The caller may cancel the process tree; no partial provider response advances the session.

The adaptive provider ceiling is 128 rounds and the wire sequence ceiling is 1,000,000. The final accepted-answer limit is 100 because that is the published `rb-headless-init/v1` bound.

## Exit codes

| Code | Meaning | Retry |
|---:|---|---|
| 0 | active question or valid completion | no transport retry |
| 2 | invalid request, stale cursor, mismatched answer/session, attachment/state corruption | no |
| 3 | adapter/state configuration incompatible or material interview block | after repair/decision |
| 70 | adapter/protocol/workspace/secret failure or wall timeout | according to attempt budget |
| 75 | live session lock, provider unavailable, or first-output timeout | yes |

`response.status` is `active|complete|invalid|failed`; non-success responses contain only stable diagnostic codes and an `interview_failed` event. Physical paths, prompts, raw provider diagnostics, credentials and secret values are never emitted.

## Compatibility

`rb-headless-init/v1` is unchanged. This contract is a separate boundary because adding provisional answers and resumable questions to init would silently expand its semantics. Additive fields require a documented compatible revision; changed message meaning requires a new major contract.
