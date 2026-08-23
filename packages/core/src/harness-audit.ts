import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { runProvider } from "./harness-provider.js";
import { loadWorkflowResources } from "./standalone-resources.js";
import type {
  ArtifactAudit,
  ArtifactAuditFinding,
  HarnessRunState,
  InterviewAnswer,
  ProviderConfiguration,
} from "./standalone-types.js";

const BEGIN = "RB_HARNESS_ARTIFACT_AUDIT_JSON_BEGIN";
const END = "RB_HARNESS_ARTIFACT_AUDIT_JSON_END";
const FINDING_ID = /^[a-z0-9][a-z0-9.-]{2,119}$/;
const CATEGORIES = new Set<ArtifactAuditFinding["category"]>([
  "ambiguity",
  "contradiction",
  "proofability",
  "regression-coverage",
  "source-authority",
  "task-boundary",
  "traceability",
]);

function requiredString(value: unknown, label: string, max = 20_000): string {
  if (typeof value !== "string" || !value.trim() || Array.from(value).length > max) {
    throw new Error(`${label} must be a non-empty string no longer than ${max} characters`);
  }
  return value.trim();
}

function parseFinding(value: unknown): ArtifactAuditFinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("artifact audit finding must be an object");
  const finding = value as Record<string, unknown>;
  const allowed = new Set(["id", "category", "artifact", "criterion", "evidence", "requiredChange"]);
  for (const key of Object.keys(finding)) if (!allowed.has(key)) throw new Error(`unsupported artifact audit finding field: ${key}`);
  const id = requiredString(finding.id, "artifact audit finding id", 120);
  if (!FINDING_ID.test(id)) throw new Error(`artifact audit finding has invalid id: ${id}`);
  if (!CATEGORIES.has(finding.category as ArtifactAuditFinding["category"])) {
    throw new Error(`artifact audit finding ${id} has an invalid category`);
  }
  const artifact = requiredString(finding.artifact, `artifact audit finding ${id}.artifact`, 500);
  if (!artifact.startsWith(".rb/") || artifact.startsWith(".rb/runs/") || artifact.includes("\0") || artifact.split("/").includes("..")) {
    throw new Error(`artifact audit finding ${id} must name a safe generated artifact under .rb/`);
  }
  return {
    id,
    category: finding.category as ArtifactAuditFinding["category"],
    artifact,
    criterion: requiredString(finding.criterion, `artifact audit finding ${id}.criterion`, 500),
    evidence: requiredString(finding.evidence, `artifact audit finding ${id}.evidence`),
    requiredChange: requiredString(finding.requiredChange, `artifact audit finding ${id}.requiredChange`),
  };
}

export function parseArtifactAudit(output: string): ArtifactAudit {
  const complete = output.trim();
  if (!complete.startsWith(BEGIN) || !complete.endsWith(END) ||
      complete.indexOf(BEGIN, BEGIN.length) >= 0 || complete.indexOf(END) !== complete.lastIndexOf(END)) {
    throw new Error("provider output must contain exactly one artifact audit envelope and no surrounding text");
  }
  const source = complete.slice(BEGIN.length, complete.length - END.length).trim();
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw new Error("provider returned malformed artifact audit JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("artifact audit must be an object");
  const audit = value as Record<string, unknown>;
  const allowed = new Set(["contract", "status", "summary", "findings"]);
  for (const key of Object.keys(audit)) if (!allowed.has(key)) throw new Error(`unsupported artifact audit field: ${key}`);
  if (audit.contract !== "rb-harness-artifact-audit/v1") throw new Error("provider returned an unsupported artifact audit contract");
  if (!(["pass", "revise", "blocked"] as unknown[]).includes(audit.status)) throw new Error("provider returned an invalid artifact audit status");
  const findings = Array.isArray(audit.findings) ? audit.findings.map(parseFinding) : (() => { throw new Error("artifact audit findings must be an array"); })();
  if (findings.length > 40) throw new Error("provider returned more than forty artifact audit findings");
  if (new Set(findings.map((finding) => finding.id)).size !== findings.length) throw new Error("provider returned duplicate artifact audit finding IDs");
  if (audit.status === "pass" && findings.length > 0) throw new Error("passing artifact audit must not contain findings");
  if (audit.status !== "pass" && findings.length === 0) throw new Error("non-passing artifact audit must contain findings");
  return {
    contract: "rb-harness-artifact-audit/v1",
    status: audit.status as ArtifactAudit["status"],
    summary: requiredString(audit.summary, "artifact audit summary"),
    findings,
  };
}

export function artifactAuditFingerprint(audit: ArtifactAudit): string {
  const roots = audit.findings
    .map((finding) => [finding.id, finding.category, finding.artifact, finding.criterion])
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return createHash("sha256").update(JSON.stringify(roots)).digest("hex");
}

function acceptedDecisions(answers: InterviewAnswer[]): Array<{ questionId: string; decision: string | undefined }> {
  return answers
    .filter((answer) => answer.disposition === "ACCEPTED")
    .map((answer) => ({ questionId: answer.questionId, decision: answer.normalizedDecision }));
}

function auditPrompt(state: HarnessRunState, resources: string, repair?: string): string {
  return [
    "You are the independent RB Harness artifact quality auditor running in a fresh, read-only context.",
    "Read the complete generated .rb artifact tree, excluding .rb/runs. Do not write files, implement code, or trust the writer's completion claim.",
    "Audit the whole tree and return every material finding in one batch. Group examples that share one invariant into one root-cause finding; do not emit one finding per paraphrase or stop at the first failure.",
    "Judge only execution safety, internal consistency, source fidelity, proofability, traceability, and bounded task design. Do not report optional prose or style preferences.",
    "A RIGID requirement or binary criterion is invalid when deterministic code would need to infer an unbounded natural-language meaning without an exact grammar, typed field, finite authority, or an explicitly declared classifier with a versioned decision/failure contract. Examples and keyword lists are not an exhaustive grammar unless the accepted decision explicitly makes them exhaustive.",
    "Check both directions: the declared mechanism must accept valid equivalence classes and reject invalid ones. Require a finite positive/negative matrix when deterministic classification is promised.",
    "Check that one canonical source and every derived/distribution copy are named when tasks require parity. Check that tasks do not mix independently failing concerns and that every acceptance criterion has an observable owner available in that task.",
    "Use status revise only when the writer can repair the artifacts from accepted sources. Use blocked when repair needs a new material developer decision. Use pass only when no material finding remains.",
    "Finding IDs identify invariant root causes and must remain stable across a repair. requiredChange must describe the invariant to establish, not a patch for the quoted example.",
    `Return exactly ${BEGIN}, one JSON object, and ${END}. Do not use Markdown fences or surrounding prose.`,
    "The JSON shape is:",
    JSON.stringify({
      contract: "rb-harness-artifact-audit/v1",
      status: "pass | revise | blocked",
      summary: "whole-tree verdict",
      findings: [{
        id: "stable.root-cause-id",
        category: "ambiguity | contradiction | proofability | regression-coverage | source-authority | task-boundary | traceability",
        artifact: ".rb/path/file.md",
        criterion: "requirement, criterion, or section identifier",
        evidence: "precise conflicting or unsafe text and why it matters",
        requiredChange: "root invariant the writer must establish",
      }],
    }),
    repair ? `A prior response violated this protocol. Correct this error: ${repair}` : "",
    `\nWorkflow: ${state.workflow}`,
    `\nDeveloper request:\n${state.request}`,
    `\nNormalized interview checkpoint:\n${state.analysis?.summary ?? ""}`,
    `\nAccepted decisions:\n${JSON.stringify(acceptedDecisions(state.answers))}`,
    `\nExplicit assumptions:\n${JSON.stringify(state.analysis?.assumptions ?? [])}`,
    resources,
  ].filter(Boolean).join("\n");
}

export async function requestArtifactAudit(
  state: HarnessRunState,
  workspace: string,
  runRoot: string,
  pass: number,
  timeoutSeconds: number,
  firstOutputTimeoutSeconds: number,
): Promise<ArtifactAudit> {
  const resources = await loadWorkflowResources(state.workflow);
  let repair: string | undefined;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = await runProvider({
      configuration: state.provider as ProviderConfiguration,
      mode: "audit",
      projectRoot: workspace,
      prompt: auditPrompt(state, resources, repair),
      logPath: resolve(runRoot, `logs/artifact-audit-pass-${pass}-protocol-${attempt}.log`),
      timeoutSeconds,
      firstOutputTimeoutSeconds,
    });
    try {
      return parseArtifactAudit(result.stdout);
    } catch (error) {
      repair = error instanceof Error ? error.message : String(error);
      if (attempt === 2) throw new Error(`provider could not satisfy the artifact audit protocol: ${repair}`);
    }
  }
  throw new Error("unreachable artifact audit protocol state");
}
