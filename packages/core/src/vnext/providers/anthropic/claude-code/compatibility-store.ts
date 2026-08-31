import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import type { ConformanceTier, RuntimeModelSelectorKind } from "../../contract.js";
import {
  assertConformanceRecordSanitized,
  verifyRecordIntegrity,
  type ConformanceRecord,
} from "../../conformance/recording.js";
import { sha256Canonical } from "./runtime-model.js";

export const CLAUDE_CODE_COMPATIBILITY_EVIDENCE_CONTRACT = "rb-claude-code-runtime-compatibility/v1" as const;

export interface ClaudeCodeCapabilityEnvelope {
  readonly structuredOutput: "claude-code-json-schema";
  readonly reasoningEfforts: readonly ["low"];
  readonly maxOutputTokens: number;
  readonly testedCapabilities: readonly string[];
}

export interface ClaudeCodeRuntimeCompatibilityEvidenceBody {
  readonly format: typeof CLAUDE_CODE_COMPATIBILITY_EVIDENCE_CONTRACT;
  readonly producer: "rb-harness-runtime-compatibility";
  readonly evidenceId: string;
  readonly providerFamily: "anthropic";
  readonly transportProfileId: "anthropic:claude-code-cli";
  readonly transport: "claude-code-cli";
  readonly transportVersion: string;
  readonly invocationPolicySha256: string;
  readonly requestedModel: string;
  readonly selectorKind: RuntimeModelSelectorKind;
  readonly resolvedModel: string;
  readonly requestAccounting: "opaque";
  readonly conformanceContractVersion: string;
  readonly capabilityEnvelope: ClaudeCodeCapabilityEnvelope;
  readonly conformanceTier: ConformanceTier;
  readonly conformanceDigest: string;
  readonly observedModelIdentities: readonly string[];
  readonly verifiedAt: string;
  readonly conformanceRecord: ConformanceRecord;
}

export interface ClaudeCodeRuntimeCompatibilityEvidence extends ClaudeCodeRuntimeCompatibilityEvidenceBody {
  readonly integritySha256: string;
}

export interface ClaudeCodeCompatibilityInvalidationBody {
  readonly format: "rb-claude-code-runtime-compatibility-stale/v1";
  readonly evidenceId: string;
  readonly evidenceSha256: string;
  readonly observedModelIdentities: readonly string[];
  readonly invalidatedAt: string;
}

export interface ClaudeCodeCompatibilityInvalidation extends ClaudeCodeCompatibilityInvalidationBody {
  readonly integritySha256: string;
}

export function defaultProviderCompatibilityRoot(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  userHome = homedir(),
): string {
  const stateRoot = environment.XDG_STATE_HOME?.trim()
    ? resolve(environment.XDG_STATE_HOME)
    : platform === "win32" && environment.LOCALAPPDATA?.trim()
      ? resolve(environment.LOCALAPPDATA)
      : resolve(userHome, ".local", "state");
  return resolve(stateRoot, "rb-harness", "provider-compatibility");
}

export function compatibilityEvidenceId(input: {
  readonly providerFamily: string;
  readonly transportProfileId: string;
  readonly transportVersion: string;
  readonly invocationPolicySha256: string;
  readonly requestedModel: string;
  readonly resolvedModel: string;
  readonly conformanceContractVersion: string;
  readonly capabilityEnvelope: ClaudeCodeCapabilityEnvelope;
}): string {
  return sha256Canonical(input);
}

export function sealClaudeCodeCompatibilityEvidence(
  body: ClaudeCodeRuntimeCompatibilityEvidenceBody,
): ClaudeCodeRuntimeCompatibilityEvidence {
  return { ...body, integritySha256: sha256Canonical(body) };
}

export function verifyClaudeCodeCompatibilityEvidenceIntegrity(
  evidence: ClaudeCodeRuntimeCompatibilityEvidence,
): boolean {
  const { integritySha256: _integrity, ...body } = evidence;
  return sha256Canonical(body) === evidence.integritySha256;
}

function evidencePath(root: string, evidenceId: string): string {
  if (!/^[a-f0-9]{64}$/.test(evidenceId)) throw new Error("invalid compatibility evidence ID");
  return resolve(root, `${evidenceId}.json`);
}

function invalidationPath(root: string, evidenceId: string): string {
  if (!/^[a-f0-9]{64}$/.test(evidenceId)) throw new Error("invalid compatibility evidence ID");
  return resolve(root, `${evidenceId}.stale.json`);
}

function assertEvidenceSafe(evidence: ClaudeCodeRuntimeCompatibilityEvidence): void {
  assertConformanceRecordSanitized(evidence.conformanceRecord);
  if (!verifyRecordIntegrity(evidence.conformanceRecord)) throw new Error("runtime compatibility conformance integrity mismatch");
  if (/\bsk-[A-Za-z0-9_-]{12,}\b/i.test(JSON.stringify(evidence))) {
    throw new Error("runtime compatibility evidence contains credential material");
  }
}

export async function writeClaudeCodeCompatibilityEvidence(
  root: string,
  evidence: ClaudeCodeRuntimeCompatibilityEvidence,
): Promise<string> {
  if (!verifyClaudeCodeCompatibilityEvidenceIntegrity(evidence)) throw new Error("runtime compatibility evidence integrity mismatch");
  assertEvidenceSafe(evidence);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const destination = evidencePath(root, evidence.evidenceId);
  const temporary = resolve(dirname(destination), `.${evidence.evidenceId}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, destination);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  return destination;
}

export async function readClaudeCodeCompatibilityEvidence(
  root: string,
  evidenceId: string,
): Promise<ClaudeCodeRuntimeCompatibilityEvidence> {
  const path = evidencePath(root, evidenceId);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`invalid runtime compatibility evidence file: ${path}`);
  const evidence = JSON.parse(await readFile(path, "utf8")) as ClaudeCodeRuntimeCompatibilityEvidence;
  if (evidence.format !== CLAUDE_CODE_COMPATIBILITY_EVIDENCE_CONTRACT || evidence.producer !== "rb-harness-runtime-compatibility") {
    throw new Error(`invalid runtime compatibility evidence format: ${path}`);
  }
  if (evidence.evidenceId !== evidenceId || !verifyClaudeCodeCompatibilityEvidenceIntegrity(evidence)) {
    throw new Error(`runtime compatibility evidence integrity mismatch: ${path}`);
  }
  assertEvidenceSafe(evidence);
  return evidence;
}

export async function listClaudeCodeCompatibilityEvidence(
  root: string,
): Promise<readonly ClaudeCodeRuntimeCompatibilityEvidence[]> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const evidence: ClaudeCodeRuntimeCompatibilityEvidence[] = [];
  for (const name of names.filter((entry) => /^[a-f0-9]{64}\.json$/.test(entry)).sort()) {
    try {
      evidence.push(await readClaudeCodeCompatibilityEvidence(root, name.slice(0, -5)));
    } catch {
      // Corrupt evidence is ignored and can never grant support.
    }
  }
  return evidence;
}

export async function invalidateClaudeCodeCompatibilityEvidence(input: {
  readonly root: string;
  readonly evidenceId: string;
  readonly evidenceSha256: string;
  readonly observedModelIdentities: readonly string[];
  readonly now?: Date;
}): Promise<void> {
  const body: ClaudeCodeCompatibilityInvalidationBody = {
    format: "rb-claude-code-runtime-compatibility-stale/v1",
    evidenceId: input.evidenceId,
    evidenceSha256: input.evidenceSha256,
    observedModelIdentities: [...new Set(input.observedModelIdentities)].sort(),
    invalidatedAt: (input.now ?? new Date()).toISOString(),
  };
  const marker: ClaudeCodeCompatibilityInvalidation = { ...body, integritySha256: sha256Canonical(body) };
  await mkdir(input.root, { recursive: true, mode: 0o700 });
  await writeFile(invalidationPath(input.root, input.evidenceId), `${JSON.stringify(marker, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function claudeCodeCompatibilityEvidenceIsInvalidated(
  root: string,
  evidence: ClaudeCodeRuntimeCompatibilityEvidence,
): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(invalidationPath(root, evidence.evidenceId), "utf8")) as ClaudeCodeCompatibilityInvalidation;
    const { integritySha256: _integrity, ...body } = parsed;
    return parsed.format === "rb-claude-code-runtime-compatibility-stale/v1"
      && parsed.evidenceId === evidence.evidenceId
      && parsed.evidenceSha256 === evidence.integritySha256
      && sha256Canonical(body) === parsed.integritySha256;
  } catch {
    return false;
  }
}

export function compatibilityEvidenceFilePath(root: string, evidenceId: string): string {
  return evidencePath(root, evidenceId);
}
