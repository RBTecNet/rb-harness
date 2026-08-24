import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";
import { walkFiles } from "./fs-utils.js";
import { sha256File } from "./hash.js";
import { requestArtifactAudit } from "./harness-audit.js";
import { inspectProjectInventory } from "./harness-inventory.js";
import { listRunStates } from "./harness-state.js";
import { loadManifest, validateManifestTree } from "./manifest.js";
import { runStandaloneWorkflow } from "./standalone-runner.js";
import type { ArtifactAuditFinding, HarnessRunState, HarnessWorkflow, ProviderConfiguration } from "./standalone-types.js";
import type { ArtifactManifest, ArtifactRecord, ExecutionDocument, ValidationIssue } from "./types.js";
import { validateExecutionMarkdown } from "./execution-contract.js";

export type ArtifactVerificationSeverity = "blocker" | "major" | "minor";
export type ArtifactVerificationStatus = "pass" | "warning" | "fail" | "blocked";

export interface ArtifactVerificationFinding {
  id: string;
  severity: ArtifactVerificationSeverity;
  source: "deterministic" | "semantic";
  category: string;
  artifact: string;
  criterion: string;
  evidence: string;
  requiredChange: string;
}

export interface ArtifactVerificationReport {
  contract: "rb-harness-artifact-verification/v1";
  status: ArtifactVerificationStatus;
  readyForRalph: boolean;
  artifactDirectory: string;
  artifactFingerprint: string;
  authorityFingerprint: string;
  authority: {
    source: "against-file" | "harness-run" | "artifact-tree-only";
    path?: string;
    harnessRunId?: string;
  };
  deterministic: {
    passed: boolean;
    checks: string[];
    artifactCount: number;
    readyPlanCount: number;
  };
  semantic: {
    executed: boolean;
    provider?: string;
    model?: string;
    status?: "pass" | "revise" | "blocked";
    summary?: string;
    decision?: {
      question: string;
      reason: string;
      options: string[];
    };
  };
  findings: ArtifactVerificationFinding[];
  reportPath: string;
  verifiedAt: string;
}

export interface VerifyArtifactsOptions {
  projectRoot: string;
  artifactDirectory: string;
  againstFile?: string;
  authorityRunId?: string;
  provider: ProviderConfiguration;
  deterministicOnly: boolean;
  timeoutSeconds: number;
  firstOutputTimeoutSeconds: number;
  reportPath?: string;
}

export interface RemediateArtifactsOptions extends VerifyArtifactsOptions {
  fromReportPath?: string;
  answersFile?: string;
  questionMode: "one-by-one" | "batch";
  nonInteractive: boolean;
}

export interface ArtifactRemediationResult {
  contract: "rb-harness-artifact-remediation/v1";
  remediated: boolean;
  readyForRalph: boolean;
  initialReport: ArtifactVerificationReport;
  finalReport: ArtifactVerificationReport;
  remediationRun?: {
    id: string;
    previousArtifacts?: string;
  };
}

function logicalPhysicalPath(projectRoot: string, artifactDirectory: string, logicalPath: string): string {
  if (!logicalPath.startsWith(".rb/") || logicalPath.includes("\0") || logicalPath.split("/").includes("..")) {
    throw new Error(`unsafe logical artifact path: ${logicalPath}`);
  }
  const root = resolve(projectRoot, artifactDirectory);
  const target = resolve(root, logicalPath.slice(4));
  if (target === root || !target.startsWith(`${root}${sep}`)) throw new Error(`artifact path escapes ${artifactDirectory}: ${logicalPath}`);
  return target;
}

function deterministicFinding(issue: ValidationIssue): ArtifactVerificationFinding {
  const identity = createHash("sha256").update(`${issue.path ?? "manifest"}\0${issue.line ?? 0}\0${issue.message}`).digest("hex").slice(0, 10);
  return {
    id: `deterministic.${issue.code}.${identity}`.toLowerCase().replace(/[^a-z0-9.-]+/g, "-"),
    severity: "blocker",
    source: "deterministic",
    category: "integrity",
    artifact: issue.path?.startsWith(".rb/") ? issue.path : ".rb/rb-manifest.json",
    criterion: issue.code,
    evidence: issue.message,
    requiredChange: "Repair the deterministic artifact contract and rerun verification before invoking a provider or RB Ralph.",
  };
}

function planDirectory(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
}

function textArtifact(artifact: ArtifactRecord): boolean {
  return [".md", ".json", ".yaml", ".yml", ".proto"].includes(extname(artifact.path).toLowerCase());
}

async function readArtifact(
  projectRoot: string,
  artifactDirectory: string,
  artifact: ArtifactRecord,
): Promise<string> {
  const source = await readFile(logicalPhysicalPath(projectRoot, artifactDirectory, artifact.path));
  if (source.byteLength > 2 * 1024 * 1024) throw new Error(`artifact exceeds the 2 MiB verification read limit: ${artifact.path}`);
  return source.toString("utf8");
}

async function undefinedTaskFindings(
  projectRoot: string,
  artifactDirectory: string,
  manifest: ArtifactManifest,
): Promise<ArtifactVerificationFinding[]> {
  const findings: ArtifactVerificationFinding[] = [];
  const plans = manifest.artifacts.filter((artifact) => artifact.kind === "execution-plan");
  for (const plan of plans) {
    const source = await readArtifact(projectRoot, artifactDirectory, plan);
    const validation = validateExecutionMarkdown(source);
    if (!validation.document) continue;
    const directory = planDirectory(plan.path);
    const siblings = manifest.artifacts.filter((artifact) =>
      textArtifact(artifact) && (artifact.path === directory || artifact.path.startsWith(`${directory}/`)));
    const corpus = (await Promise.all(siblings.map((artifact) => readArtifact(projectRoot, artifactDirectory, artifact)))).join("\n");
    const defined = new Set(validation.document.phases.flatMap((phase) => phase.tasks.map((task) => task.id)));
    const referenced = new Set(corpus.match(/\bT\d{3}\b/g) ?? []);
    const missing = [...referenced].filter((id) => !defined.has(id)).sort();
    if (missing.length) {
      findings.push({
        id: `traceability.undefined-task.${plan.id}`,
        severity: "major",
        source: "deterministic",
        category: "traceability",
        artifact: plan.path,
        criterion: "task-reference-integrity",
        evidence: `Artifacts in ${directory} reference task IDs that this execution plan does not define: ${missing.join(", ")}.`,
        requiredChange: "Point every task reference to a task defined by the execution plan, or add the missing bounded task and its traceability.",
      });
    }
  }
  return findings;
}

function missingContextFindings(manifest: ArtifactManifest, plans: Array<{ artifact: ArtifactRecord; document: ExecutionDocument }>): ArtifactVerificationFinding[] {
  const indexed = new Set(manifest.artifacts.map((artifact) => artifact.path));
  const findings: ArtifactVerificationFinding[] = [];
  for (const { artifact, document } of plans) {
    const missing = new Set<string>();
    for (const phase of document.phases) {
      for (const entry of phase.context) {
        const path = entry.match(/`([^`]+)`/)?.[1];
        if (path?.startsWith(".rb/") && !indexed.has(path)) missing.add(path);
      }
    }
    if (missing.size) {
      findings.push({
        id: `traceability.missing-context.${artifact.id}`,
        severity: "blocker",
        source: "deterministic",
        category: "traceability",
        artifact: artifact.path,
        criterion: "cold-phase-context",
        evidence: `Phase context references artifacts absent from the manifest: ${[...missing].sort().join(", ")}.`,
        requiredChange: "Index every load-bearing phase context artifact or remove the invalid reference before Ralph starts cold.",
      });
    }
  }
  return findings;
}

async function deterministicVerification(
  projectRoot: string,
  artifactDirectory: string,
): Promise<{
  manifest?: ArtifactManifest;
  findings: ArtifactVerificationFinding[];
  artifactCount: number;
  readyPlanCount: number;
}> {
  const tree = await validateManifestTree(projectRoot, { artifactDirectory });
  const findings = tree.issues.map(deterministicFinding);
  if (!tree.manifest || !tree.valid) {
    return { manifest: tree.manifest, findings, artifactCount: tree.manifest?.artifacts.length ?? 0, readyPlanCount: 0 };
  }
  const manifest = await loadManifest(projectRoot, artifactDirectory);
  const planArtifacts = manifest.artifacts.filter((artifact) => artifact.kind === "execution-plan");
  const readyPlans = planArtifacts.filter((artifact) => artifact.status === "ready" && artifact.contract === "rb-execution/v1");
  if (!readyPlans.length) {
    findings.push({
      id: "readiness.ready-plan-missing",
      severity: "blocker",
      source: "deterministic",
      category: "readiness",
      artifact: ".rb/rb-manifest.json",
      criterion: "ralph-ready-plan",
      evidence: "The manifest contains no ready rb-execution/v1 execution plan.",
      requiredChange: "Publish at least one contract-valid ready execution plan before running RB Ralph.",
    });
  }
  const parsedPlans: Array<{ artifact: ArtifactRecord; document: ExecutionDocument }> = [];
  for (const artifact of planArtifacts) {
    const validation = validateExecutionMarkdown(await readArtifact(projectRoot, artifactDirectory, artifact));
    if (validation.document) parsedPlans.push({ artifact, document: validation.document });
    if (artifact.status !== "ready") {
      findings.push({
        id: `readiness.execution-plan.${artifact.id}`,
        severity: "blocker",
        source: "deterministic",
        category: "readiness",
        artifact: artifact.path,
        criterion: "execution-plan-readiness",
        evidence: `Execution plan is ${artifact.status}, not ready.`,
        requiredChange: "Resolve or remove the unready execution plan so discovery cannot expose contradictory readiness.",
      });
    }
  }
  findings.push(...missingContextFindings(manifest, parsedPlans));
  findings.push(...await undefinedTaskFindings(projectRoot, artifactDirectory, manifest));
  return {
    manifest,
    findings,
    artifactCount: manifest.artifacts.length,
    readyPlanCount: readyPlans.length,
  };
}

function inferWorkflow(manifest: ArtifactManifest | undefined): HarnessWorkflow {
  const paths = manifest?.artifacts.map((artifact) => artifact.path) ?? [];
  if (paths.some((path) => path.startsWith(".rb/evolutions/"))) return "evolve";
  if (paths.some((path) => path.startsWith(".rb/reviews/"))) return "review";
  if (paths.some((path) => path.startsWith(".rb/context/"))) return "ai-context";
  if (paths.some((path) => path.startsWith(".rb/init/"))) return "init";
  return "plan";
}

async function authorityState(
  options: VerifyArtifactsOptions,
  manifest: ArtifactManifest | undefined,
): Promise<{ state: HarnessRunState; authority: ArtifactVerificationReport["authority"]; missing: boolean }> {
  const generatedAt = manifest ? Date.parse(manifest.generatedAt) : Number.NaN;
  const completedRuns = (await listRunStates(options.projectRoot))
    .filter((state) => state.status === "complete" && state.artifactDirectory === options.artifactDirectory);
  const runs = completedRuns
    .filter((state) => {
      if (!state.publishedAt) return false;
      const publishedAt = Date.parse(state.publishedAt);
      return Number.isFinite(generatedAt)
        && Number.isFinite(publishedAt)
        && publishedAt >= generatedAt
        && publishedAt - generatedAt <= 5 * 60 * 1000;
    })
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  const existing = options.authorityRunId
    ? completedRuns.find((state) => state.id === options.authorityRunId)
    : runs.at(-1);
  let request: string | undefined;
  let path: string | undefined;
  if (options.againstFile) {
    path = resolve(options.projectRoot, options.againstFile);
    const source = await readFile(path);
    if (source.byteLength > 2 * 1024 * 1024) throw new Error("--against file must not exceed 2 MiB");
    request = source.toString("utf8").trim();
    if (!request) throw new Error("--against file must not be empty");
  }
  if (existing) {
    return {
      state: {
        ...existing,
        request: request ?? existing.request,
        ...(path ? { requestSource: path } : {}),
        provider: options.provider,
      },
      authority: {
        source: options.againstFile ? "against-file" : "harness-run",
        ...(path ? { path } : {}),
        harnessRunId: existing.id,
      },
      missing: false,
    };
  }
  const now = new Date().toISOString();
  const inventory = await inspectProjectInventory(options.projectRoot, options.artifactDirectory);
  return {
    state: {
      contract: "rb-harness-run/v1",
      id: `verify-${createHash("sha256").update(`${options.projectRoot}\0${options.artifactDirectory}`).digest("hex").slice(0, 12)}`,
      workflow: inferWorkflow(manifest),
      status: "complete",
      projectRoot: options.projectRoot,
      artifactDirectory: options.artifactDirectory,
      request: request ?? "Verify the generated artifact tree against its own declared canonical request, specification, and source authorities.",
      ...(path ? { requestSource: path } : {}),
      requestHash: createHash("sha256").update(request ?? "artifact-tree-only").digest("hex"),
      provider: options.provider,
      answers: [],
      inventory,
      createdAt: now,
      updatedAt: now,
    },
    authority: path ? { source: "against-file", path } : { source: "artifact-tree-only" },
    missing: !path,
  };
}

function semanticFinding(finding: ArtifactAuditFinding, blocked: boolean): ArtifactVerificationFinding {
  return {
    id: finding.id,
    severity: blocked ? "blocker" : finding.severity ?? "major",
    source: "semantic",
    category: finding.category,
    artifact: finding.artifact,
    criterion: finding.criterion,
    evidence: finding.evidence,
    requiredChange: finding.requiredChange,
  };
}

function reportStatus(findings: ArtifactVerificationFinding[], semanticBlocked: boolean): ArtifactVerificationStatus {
  if (semanticBlocked) return "blocked";
  if (findings.some((finding) => finding.severity === "blocker" || finding.severity === "major")) return "fail";
  if (findings.length) return "warning";
  return "pass";
}

function defaultReportPath(projectRoot: string, artifactDirectory: string): string {
  const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const suffix = createHash("sha256").update(artifactDirectory).digest("hex").slice(0, 8);
  return resolve(projectRoot, ".rb-harness/verifications", `${timestamp}-${suffix}-${randomBytes(2).toString("hex")}`, "report.json");
}

async function artifactTreeFingerprint(projectRoot: string, artifactDirectory: string): Promise<string> {
  const root = resolve(projectRoot, artifactDirectory);
  const digest = createHash("sha256");
  let files: string[];
  try {
    files = await walkFiles(root, 10_000, new Set(["runs"]));
  } catch {
    return digest.update("artifact-root-missing").digest("hex");
  }
  for (const path of files.sort((left, right) => left.localeCompare(right))) {
    digest.update(relative(root, path).split(sep).join("/"));
    digest.update("\0");
    digest.update(await sha256File(path));
    digest.update("\0");
  }
  return digest.digest("hex");
}

function storedVerificationReport(value: unknown, path: string): ArtifactVerificationReport | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const report = value as Partial<ArtifactVerificationReport>;
  if (report.contract !== "rb-harness-artifact-verification/v1"
      || typeof report.artifactDirectory !== "string"
      || !/^[a-f0-9]{64}$/.test(report.artifactFingerprint ?? "")
      || !/^[a-f0-9]{64}$/.test(report.authorityFingerprint ?? "")
      || typeof report.readyForRalph !== "boolean"
      || !Array.isArray(report.findings)
      || typeof report.verifiedAt !== "string") return undefined;
  return { ...report, reportPath: path } as ArtifactVerificationReport;
}

async function loadRemediationReport(
  options: RemediateArtifactsOptions,
  artifactFingerprint: string,
  authorityFingerprint: string,
): Promise<ArtifactVerificationReport> {
  const reports = await remediationReports(options);
  const matching = reports
    .filter((report) => report.artifactDirectory === options.artifactDirectory
      && report.artifactFingerprint === artifactFingerprint
      && report.authorityFingerprint === authorityFingerprint)
    .sort((left, right) => left.verifiedAt.localeCompare(right.verifiedAt));
  const selected = matching.at(-1);
  if (selected) return selected;
  const explicit = options.fromReportPath ? resolve(options.projectRoot, options.fromReportPath) : undefined;
  const qualifier = explicit ? `The selected report is missing, invalid, or stale: ${explicit}.` : "No compatible verification report was found.";
  throw new Error(`${qualifier} Run rb-harness artifacts verify without --remediate against the current artifact tree first.`);
}

async function remediationReports(
  options: RemediateArtifactsOptions,
): Promise<ArtifactVerificationReport[]> {
  const projectRoot = resolve(options.projectRoot);
  const explicit = options.fromReportPath ? resolve(projectRoot, options.fromReportPath) : undefined;
  const candidates = explicit
    ? [explicit]
    : (await walkFiles(resolve(projectRoot, ".rb-harness/verifications"), 10_000).catch(() => []))
      .filter((path) => basename(path) === "report.json");
  const reports: ArtifactVerificationReport[] = [];
  for (const path of candidates) {
    try {
      const parsed = storedVerificationReport(JSON.parse(await readFile(path, "utf8")), path);
      if (parsed) reports.push(parsed);
    } catch { /* malformed or concurrently incomplete reports are ignored */ }
  }
  return reports;
}

function sourceAuthorityFingerprint(state: HarnessRunState): string {
  return createHash("sha256").update(JSON.stringify({
    workflow: state.workflow,
    request: state.request,
    summary: state.analysis?.summary ?? "",
    assumptions: state.analysis?.assumptions ?? [],
    acceptedDecisions: state.answers
      .filter((answer) => answer.disposition === "ACCEPTED")
      .map((answer) => ({
        questionId: answer.questionId,
        decision: answer.normalizedDecision,
        sourceAnswer: answer.rawAnswer,
      })),
  })).digest("hex");
}

function remediationRequest(state: HarnessRunState, report: ArtifactVerificationReport): string {
  const acceptedDecisions = state.answers
    .filter((answer) => answer.disposition === "ACCEPTED")
    .map((answer) => ({
      questionId: answer.questionId,
      decision: answer.normalizedDecision,
      sourceAnswer: answer.rawAnswer,
    }));
  const findings = report.findings.map((finding) => ({
    id: finding.id,
    severity: finding.severity,
    category: finding.category,
    artifact: finding.artifact,
    criterion: finding.criterion,
    evidence: finding.evidence,
    requiredChange: finding.requiredChange,
  }));
  return [
    "RB Harness bounded artifact remediation request.",
    "This request authorizes exactly one complete documentation re-emission after the adaptive interview reaches a valid checkpoint.",
    "Repair every reported invariant at its root while preserving unaffected behavior, compatible artifacts, and confirmed manual edits.",
    "Do not implement application code. Do not add a documentation manager, repeat generation, or weaken an acceptance criterion merely to obtain a passing verdict.",
    "Ask the developer only when the accepted authorities leave two or more incompatible product-observable outcomes. Technical design, contract closure, task decomposition, traceability, and proof ownership are writer responsibilities.",
    "The post-remediation verifier runs once. Any remaining finding is reported without another automatic repair cycle.",
    `\nOriginal developer request:\n${state.request}`,
    `\nPrior normalized interview checkpoint:\n${state.analysis?.summary ?? "none"}`,
    `\nPrior accepted decisions:\n${JSON.stringify(acceptedDecisions)}`,
    `\nPrior explicit assumptions:\n${JSON.stringify(state.analysis?.assumptions ?? [])}`,
    `\nExhaustive verification summary:\n${report.semantic.summary ?? "Deterministic verification did not reach the semantic audit."}`,
    `\nFindings to remediate:\n${JSON.stringify(findings)}`,
  ].join("\n");
}

export function artifactVerificationExitCode(report: ArtifactVerificationReport): number {
  if (report.status === "blocked") return 3;
  if (report.status === "fail") return 2;
  return 0;
}

export async function verifyArtifacts(options: VerifyArtifactsOptions): Promise<ArtifactVerificationReport> {
  const projectRoot = resolve(options.projectRoot);
  const artifactFingerprint = await artifactTreeFingerprint(projectRoot, options.artifactDirectory);
  const deterministic = await deterministicVerification(projectRoot, options.artifactDirectory);
  const findings = [...deterministic.findings];
  const checks = ["manifest-schema", "artifact-hashes", "execution-contracts", "operational-contracts", "ready-plan-discovery", "cold-context-paths", "task-reference-integrity"];
  let semantic: ArtifactVerificationReport["semantic"] = { executed: false };
  let semanticBlocked = false;
  const authority = await authorityState({ ...options, projectRoot }, deterministic.manifest);
  const authorityFingerprint = sourceAuthorityFingerprint(authority.state);
  if (authority.missing) {
    findings.push({
      id: "source-authority.original-request-unavailable",
      severity: "major",
      source: "deterministic",
      category: "source-authority",
      artifact: ".rb/rb-manifest.json",
      criterion: "request-fidelity",
      evidence: "No matching completed Harness run or explicit --against request file was available; source fidelity cannot be proven.",
      requiredChange: "Provide --against <request-file> or preserve the originating Harness run state.",
    });
  }
  const mechanicalBlocker = findings.some((finding) => finding.source === "deterministic" && finding.severity === "blocker");
  const reportPath = options.reportPath ? resolve(projectRoot, options.reportPath) : defaultReportPath(projectRoot, options.artifactDirectory);
  const runRoot = dirname(reportPath);
  if (!options.deterministicOnly && !mechanicalBlocker) {
    await mkdir(runRoot, { recursive: true, mode: 0o700 });
    const audit = await requestArtifactAudit(
      authority.state,
      projectRoot,
      runRoot,
      1,
      options.timeoutSeconds,
      options.firstOutputTimeoutSeconds,
      options.artifactDirectory,
    );
    semanticBlocked = audit.status === "blocked";
    findings.push(...audit.findings.map((finding) => semanticFinding(finding, semanticBlocked)));
    semantic = {
      executed: true,
      provider: options.provider.provider,
      model: options.provider.model || "provider-default",
      status: audit.status,
      summary: audit.summary,
      ...(audit.decision ? { decision: audit.decision } : {}),
    };
  }
  const status = reportStatus(findings, semanticBlocked);
  const report: ArtifactVerificationReport = {
    contract: "rb-harness-artifact-verification/v1",
    status,
    readyForRalph: status === "pass" || status === "warning",
    artifactDirectory: options.artifactDirectory,
    artifactFingerprint,
    authorityFingerprint,
    authority: authority.authority,
    deterministic: {
      passed: !findings.some((finding) =>
        finding.source === "deterministic" && (finding.severity === "blocker" || finding.severity === "major")),
      checks,
      artifactCount: deterministic.artifactCount,
      readyPlanCount: deterministic.readyPlanCount,
    },
    semantic,
    findings,
    reportPath,
    verifiedAt: new Date().toISOString(),
  };
  await mkdir(runRoot, { recursive: true, mode: 0o700 });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return report;
}

export async function verifyAndRemediateArtifacts(
  options: RemediateArtifactsOptions,
): Promise<ArtifactRemediationResult> {
  if (options.deterministicOnly) {
    throw new Error("--remediate requires the semantic verifier; remove --deterministic-only");
  }
  const projectRoot = resolve(options.projectRoot);
  const artifactFingerprint = await artifactTreeFingerprint(projectRoot, options.artifactDirectory);
  const tree = await validateManifestTree(projectRoot, { artifactDirectory: options.artifactDirectory });
  const storedReports = await remediationReports({ ...options, projectRoot });
  if (options.fromReportPath && !storedReports.length) {
    throw new Error(
      `The selected report is missing, invalid, or stale: ${resolve(projectRoot, options.fromReportPath)}. Run rb-harness artifacts verify without --remediate against the current artifact tree first.`,
    );
  }
  const artifactReport = storedReports
    .filter((report) => report.artifactDirectory === options.artifactDirectory
      && report.artifactFingerprint === artifactFingerprint)
    .sort((left, right) => left.verifiedAt.localeCompare(right.verifiedAt))
    .at(-1);
  const authorityReport = artifactReport ?? (options.fromReportPath ? storedReports.at(-1) : undefined);
  const inheritedAgainstFile = !options.againstFile && authorityReport?.authority.source === "against-file"
    ? authorityReport.authority.path
    : undefined;
  const inheritedAuthorityRunId = !options.againstFile && !inheritedAgainstFile
    ? authorityReport?.authority.harnessRunId
    : undefined;
  const effectiveOptions: RemediateArtifactsOptions = {
    ...options,
    projectRoot,
    againstFile: options.againstFile ?? inheritedAgainstFile,
    authorityRunId: options.authorityRunId ?? inheritedAuthorityRunId,
  };
  const authority = await authorityState(effectiveOptions, tree.manifest);
  if (authority.missing) {
    throw new Error("artifact remediation requires the original request authority; provide --against <request-file>");
  }
  const authorityFingerprint = sourceAuthorityFingerprint(authority.state);
  const initialReport = await loadRemediationReport(
    effectiveOptions,
    artifactFingerprint,
    authorityFingerprint,
  );
  if (initialReport.readyForRalph) {
    return {
      contract: "rb-harness-artifact-remediation/v1",
      remediated: false,
      readyForRalph: true,
      initialReport,
      finalReport: initialReport,
    };
  }
  process.stdout.write(
    `[rb-harness] verificação inicial reprovou ${initialReport.findings.length} causa(s); iniciando uma remediação limitada e preservando a revisão atual.\n`,
  );
  const remediationRun = await runStandaloneWorkflow({
    workflow: authority.state.workflow,
    projectRoot,
    artifactDirectory: options.artifactDirectory,
    request: remediationRequest(authority.state, initialReport),
    requestSource: authority.state.requestSource,
    provider: options.provider,
    answersFile: options.answersFile,
    questionMode: options.questionMode,
    nonInteractive: options.nonInteractive,
    timeoutSeconds: options.timeoutSeconds,
    firstOutputTimeoutSeconds: options.firstOutputTimeoutSeconds,
  });
  process.stdout.write("[rb-harness] reemissão concluída; executando a única verificação pós-remediação.\n");
  const finalReport = await verifyArtifacts({
    ...effectiveOptions,
    reportPath: options.reportPath,
  });
  return {
    contract: "rb-harness-artifact-remediation/v1",
    remediated: true,
    readyForRalph: finalReport.readyForRalph,
    initialReport,
    finalReport,
    remediationRun: {
      id: remediationRun.id,
      ...(remediationRun.previousArtifacts ? { previousArtifacts: remediationRun.previousArtifacts } : {}),
    },
  };
}

export function formatArtifactVerification(report: ArtifactVerificationReport): string {
  const counts = { blocker: 0, major: 0, minor: 0 };
  for (const finding of report.findings) counts[finding.severity] += 1;
  return [
    `Artifact verification: ${report.status.toUpperCase()} · Ralph ${report.readyForRalph ? "READY" : "NOT READY"}`,
    `Deterministic: ${report.deterministic.passed ? "PASS" : "FAIL"} · ${report.deterministic.artifactCount} artifacts · ${report.deterministic.readyPlanCount} ready plan(s)`,
    `Semantic: ${report.semantic.executed ? `${report.semantic.status?.toUpperCase()} via ${report.semantic.provider}/${report.semantic.model}` : "not executed"}`,
    `Findings: blocker=${counts.blocker}, major=${counts.major}, minor=${counts.minor}`,
    ...report.findings.map((finding) => `  ${finding.severity.toUpperCase()} ${finding.id} [${finding.artifact}] — ${finding.evidence}`),
    ...(report.semantic.decision
      ? [
        `Decision required: ${report.semantic.decision.question}`,
        `Reason: ${report.semantic.decision.reason}`,
        ...report.semantic.decision.options.map((option, index) => `  ${index + 1}) ${option}`),
      ]
      : []),
    `Report: ${report.reportPath}`,
  ].join("\n");
}

export function formatArtifactRemediation(result: ArtifactRemediationResult): string {
  const initialCounts = { blocker: 0, major: 0, minor: 0 };
  for (const finding of result.initialReport.findings) initialCounts[finding.severity] += 1;
  return [
    `Bounded remediation: ${result.remediated ? "EXECUTED" : "NOT NEEDED"}`,
    `Initial: ${result.initialReport.status.toUpperCase()} · blocker=${initialCounts.blocker}, major=${initialCounts.major}, minor=${initialCounts.minor}`,
    `Initial report: ${result.initialReport.reportPath}`,
    ...(result.remediationRun ? [`Remediation run: ${result.remediationRun.id}`] : []),
    ...(result.remediationRun?.previousArtifacts ? [`Previous artifacts: ${result.remediationRun.previousArtifacts}`] : []),
    "",
    formatArtifactVerification(result.finalReport),
  ].join("\n");
}
