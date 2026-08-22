import { access, mkdir, readFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { validateExecutionMarkdown } from "./execution-contract.js";
import { atomicWrite, readJson, relativeProjectPath, safeProjectPath, walkFiles } from "./fs-utils.js";
import { sha256File } from "./hash.js";
import { validateOperationalJson } from "./operational-contract.js";
import { candidateFindings, validateResponsiveInventoryJson } from "./responsive-inventory.js";
import type {
  ArtifactManifest,
  ArtifactRecord,
  ArtifactStatus,
  ManifestValidation,
  ValidationIssue,
} from "./types.js";

const MANIFEST_VERSION = "rb-manifest/v1" as const;

export function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "project";
}

export function manifestPath(root: string): string {
  return resolve(root, ".rb", "rb-manifest.json");
}

function artifactKind(relativePath: string): string {
  const name = basename(relativePath).toUpperCase();
  if (name === "PHASES.MD") return "execution-plan";
  if (name === "OPERATIONS.JSON") return "operational-verification";
  if (name === "PLAN.MD") return "implementation-plan";
  if (["SPEC.MD", "REQUIREMENTS.MD"].includes(name)) return "specification";
  if (["REQUEST.MD", "CHANGE_REQUEST.MD"].includes(name)) return "request";
  if (relativePath.startsWith(".rb/context/")) return name === "EVIDENCE.JSON" ? "evidence" : "context-document";
  if (relativePath.startsWith(".rb/init/")) return "project-document";
  if (relativePath.startsWith(".rb/features/")) return "feature-document";
  if (relativePath.startsWith(".rb/reviews/")) {
    if (name === "FINDINGS.MD") return "review-findings";
    if (name === "DESIGN_SYSTEM.MD") return "design-system";
    if (name === "BASELINE.JSON") return "review-baseline";
    if (name === "RESPONSIVE_INVENTORY.JSON") return "responsive-inventory";
    return "review-document";
  }
  if (relativePath.startsWith(".rb/evolutions/")) {
    if (name === "REGRESSION_MATRIX.MD") return "regression-specification";
    return "evolution-document";
  }
  if (relativePath.startsWith(".rb/manifests/")) return "provenance";
  return "artifact";
}

async function operationalMetadata(path: string): Promise<{
  status: ArtifactStatus;
  contract: string;
}> {
  const result = validateOperationalJson(await readFile(path, "utf8"));
  return { status: result.valid ? "ready" : "invalid", contract: "rb-operational/v1" };
}

async function responsiveMetadata(path: string): Promise<{
  status: ArtifactStatus;
  contract: string;
}> {
  const result = validateResponsiveInventoryJson(await readFile(path, "utf8"));
  return { status: result.valid ? "ready" : "invalid", contract: "rb-responsive-inventory/v1" };
}

function pathArtifactId(relativePath: string): string {
  return slugify(relativePath.replace(/^\.rb\//, "").replace(/\.[^.]+$/, ""));
}

async function executionMetadata(path: string): Promise<{
  id?: string;
  status: ArtifactStatus;
  contract?: string;
}> {
  const source = await readFile(path, "utf8");
  const result = validateExecutionMarkdown(source);
  if (!result.valid) return { status: "invalid", contract: "rb-execution/v1" };
  if (/\[NEEDS DECISION\]|<!--\s*rb-readiness:\s*blocked\s*-->/.test(source)) {
    return { id: result.document?.artifactId, status: "blocked", contract: result.document?.contract };
  }
  if (/\[DRAFT\]|<!--\s*rb-readiness:\s*draft\s*-->/.test(source)) {
    return { id: result.document?.artifactId, status: "draft", contract: result.document?.contract };
  }
  return { id: result.document?.artifactId, status: "ready", contract: result.document?.contract };
}

export async function initializeProject(
  root: string,
  name: string,
  id = slugify(name),
): Promise<ArtifactManifest> {
  const absoluteRoot = resolve(root);
  for (const directory of ["init", "context", "features", "reviews", "evolutions", "handoffs", "manifests"]) {
    await mkdir(resolve(absoluteRoot, ".rb", directory), { recursive: true });
  }
  try {
    const current = await loadManifest(absoluteRoot);
    if (current.project.id !== id || current.project.name !== name) {
      throw new Error(
        `Project already initialized as ${current.project.id} (${current.project.name}); refusing to replace identity`,
      );
    }
    return current;
  } catch (error) {
    if (error instanceof Error && !error.message.includes("not found")) throw error;
  }
  const manifest: ArtifactManifest = {
    manifestVersion: MANIFEST_VERSION,
    project: { id, name },
    artifactRoot: ".rb",
    generatedAt: new Date().toISOString(),
    artifacts: [],
  };
  await writeManifest(absoluteRoot, manifest);
  return manifest;
}

export async function loadManifest(root: string): Promise<ArtifactManifest> {
  const path = manifestPath(root);
  try {
    await access(path);
  } catch {
    throw new Error(`RB manifest not found: ${relativeProjectPath(root, path)}; run project init first`);
  }
  return readJson<ArtifactManifest>(path);
}

export function manifestTsv(manifest: ArtifactManifest): string {
  const metadata = [
    `# rb-artifacts-index: ${manifest.manifestVersion}`,
    "# generated-from: .rb/rb-manifest.json",
  ];
  const header = "id\tkind\tstatus\tcontract\tpath\tsha256";
  const rows = manifest.artifacts.map((artifact) =>
    [artifact.id, artifact.kind, artifact.status, artifact.contract ?? "", artifact.path, artifact.sha256].join("\t"),
  );
  return `${[...metadata, header, ...rows].join("\n")}\n`;
}

export async function writeManifest(root: string, manifest: ArtifactManifest): Promise<void> {
  const rbRoot = resolve(root, ".rb");
  await atomicWrite(resolve(rbRoot, "rb-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await atomicWrite(resolve(rbRoot, "artifacts.tsv"), manifestTsv(manifest));
}

export async function syncManifest(root: string): Promise<ArtifactManifest> {
  const absoluteRoot = resolve(root);
  const existing = await loadManifest(absoluteRoot);
  const rbRoot = resolve(absoluteRoot, ".rb");
  const files = (await walkFiles(rbRoot)).filter((path) => {
    const name = basename(path);
    return name !== "rb-manifest.json" && name !== "artifacts.tsv" && !name.includes(".tmp-");
  });
  const artifacts: ArtifactRecord[] = [];
  for (const path of files) {
    const relativePath = relativeProjectPath(absoluteRoot, path);
    const kind = artifactKind(relativePath);
    const extension = extname(path).toLowerCase();
    if (![".md", ".json", ".yaml", ".yml", ".proto"].includes(extension)) continue;
    let id = pathArtifactId(relativePath);
    let status: ArtifactStatus = "ready";
    let contract: string | undefined;
    if (kind === "execution-plan") {
      const metadata = await executionMetadata(path);
      id = metadata.id ?? id;
      status = metadata.status;
      contract = metadata.contract;
    } else if (kind === "operational-verification") {
      const metadata = await operationalMetadata(path);
      status = metadata.status;
      contract = metadata.contract;
    } else if (kind === "responsive-inventory") {
      const metadata = await responsiveMetadata(path);
      status = metadata.status;
      contract = metadata.contract;
    }
    artifacts.push({
      id,
      kind,
      path: relativePath,
      status,
      sha256: await sha256File(path),
      ...(contract ? { contract } : {}),
    });
  }
  artifacts.sort((left, right) => left.path.localeCompare(right.path));
  const manifest: ArtifactManifest = {
    ...existing,
    generatedAt: new Date().toISOString(),
    artifacts,
  };
  await writeManifest(absoluteRoot, manifest);
  return manifest;
}

function addIssue(
  issues: ValidationIssue[],
  code: string,
  message: string,
  path?: string,
): void {
  issues.push({ code, message, severity: "error", ...(path ? { path } : {}) });
}

export async function validateManifestTree(root: string): Promise<ManifestValidation> {
  const issues: ValidationIssue[] = [];
  let manifest: ArtifactManifest;
  try {
    manifest = await loadManifest(root);
  } catch (error) {
    addIssue(issues, "manifest.missing", error instanceof Error ? error.message : String(error));
    return { valid: false, issues };
  }
  if (manifest.manifestVersion !== MANIFEST_VERSION) {
    addIssue(issues, "manifest.version", `Unsupported manifest version: ${String(manifest.manifestVersion)}`);
  }
  if (manifest.artifactRoot !== ".rb") addIssue(issues, "manifest.root", "artifactRoot must be .rb");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(manifest.project?.id ?? "")) {
    addIssue(issues, "manifest.project.id", "project.id is invalid");
  }
  if (!manifest.project?.name?.trim()) addIssue(issues, "manifest.project.name", "project.name is required");
  if (!Array.isArray(manifest.artifacts)) {
    addIssue(issues, "manifest.artifacts", "artifacts must be an array");
    return { valid: false, issues, manifest };
  }

  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const artifact of manifest.artifacts) {
    if (!artifact || typeof artifact !== "object") {
      addIssue(issues, "artifact.record", "Artifact records must be objects");
      continue;
    }
    if (typeof artifact.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(artifact.id)) {
      addIssue(issues, "artifact.id.invalid", "Artifact ID must be a stable lower-case identifier");
    }
    if (typeof artifact.kind !== "string" || !artifact.kind.trim()) {
      addIssue(issues, "artifact.kind.invalid", "Artifact kind is required", artifact.path);
    }
    if (!["draft", "ready", "blocked", "invalid"].includes(artifact.status)) {
      addIssue(issues, "artifact.status.invalid", `Unsupported artifact status: ${String(artifact.status)}`, artifact.path);
    }
    if (typeof artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(artifact.sha256)) {
      addIssue(issues, "artifact.sha256.invalid", "Artifact SHA-256 must contain 64 lower-case hex characters", artifact.path);
    }
    if (ids.has(artifact.id)) addIssue(issues, "artifact.id.duplicate", `Duplicate artifact ID ${artifact.id}`);
    if (paths.has(artifact.path)) addIssue(issues, "artifact.path.duplicate", `Duplicate artifact path ${artifact.path}`);
    ids.add(artifact.id);
    paths.add(artifact.path);
    let absolute: string;
    try {
      absolute = safeProjectPath(root, artifact.path);
    } catch (error) {
      addIssue(issues, "artifact.path.unsafe", error instanceof Error ? error.message : String(error), artifact.path);
      continue;
    }
    if (!artifact.path.startsWith(".rb/")) {
      addIssue(issues, "artifact.path.root", "Artifact path must be under .rb/", artifact.path);
      continue;
    }
    try {
      const actualHash = await sha256File(absolute);
      if (actualHash !== artifact.sha256) {
        addIssue(issues, "artifact.stale", "Artifact hash differs from manifest", artifact.path);
      }
      if (artifact.kind === "execution-plan") {
        const result = validateExecutionMarkdown(await readFile(absolute, "utf8"));
        const metadata = await executionMetadata(absolute);
        for (const contractIssue of result.issues) {
          issues.push({ ...contractIssue, path: artifact.path });
        }
        if (artifact.status !== metadata.status) {
          addIssue(
            issues,
            "artifact.status.mismatch",
            `Manifest status ${artifact.status} differs from document status ${metadata.status}`,
            artifact.path,
          );
        }
        if (artifact.contract !== "rb-execution/v1") {
          addIssue(issues, "artifact.contract", "Execution plan contract must be rb-execution/v1", artifact.path);
        }
        if (artifact.id !== result.document?.artifactId) {
          addIssue(issues, "artifact.id.mismatch", "Manifest ID differs from rb-artifact-id", artifact.path);
        }
      } else if (artifact.kind === "operational-verification") {
        const operational = validateOperationalJson(await readFile(absolute, "utf8"));
        const metadata = { status: operational.valid ? "ready" as const : "invalid" as const, contract: "rb-operational/v1" };
        for (const operationalIssue of operational.issues) issues.push({ ...operationalIssue, path: artifact.path });
        if (artifact.status !== metadata.status) {
          addIssue(issues, "artifact.status.mismatch", `Manifest status ${artifact.status} differs from document status ${metadata.status}`, artifact.path);
        }
        if (artifact.contract !== "rb-operational/v1") {
          addIssue(issues, "artifact.contract", "Operational verification contract must be rb-operational/v1", artifact.path);
        }
      } else if (artifact.kind === "responsive-inventory") {
        const responsive = validateResponsiveInventoryJson(await readFile(absolute, "utf8"));
        const metadata = {
          status: responsive.valid ? "ready" as const : "invalid" as const,
          contract: "rb-responsive-inventory/v1",
        };
        for (const responsiveIssue of responsive.issues) issues.push({ ...responsiveIssue, path: artifact.path });
        if (artifact.status !== metadata.status) {
          addIssue(issues, "artifact.status.mismatch", `Manifest status ${artifact.status} differs from document status ${metadata.status}`, artifact.path);
        }
        if (artifact.contract !== metadata.contract) {
          addIssue(issues, "artifact.contract", "Responsive inventory contract must be rb-responsive-inventory/v1", artifact.path);
        }
        if (responsive.document) {
          const reviewDirectory = artifact.path.slice(0, artifact.path.lastIndexOf("/"));
          if (responsive.document.reviewId !== basename(reviewDirectory)) {
            addIssue(issues, "responsive.reviewId.mismatch", "reviewId must match the containing review directory", artifact.path);
          }
          const findingsArtifact = manifest.artifacts.find((entry) =>
            entry.path === `${reviewDirectory}/FINDINGS.md` && entry.kind === "review-findings",
          );
          if (responsive.document.applicability === "APPLICABLE" && !findingsArtifact) {
            addIssue(issues, "responsive.findings.missing", "Applicable responsive evidence requires FINDINGS.md", artifact.path);
          } else if (findingsArtifact) {
            const findingsSource = await readFile(safeProjectPath(root, findingsArtifact.path), "utf8");
            for (const { candidate, findingId } of candidateFindings(responsive.document)) {
              if (!new RegExp(`(?:^|[^A-Z0-9-])${findingId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^A-Z0-9-])`, "m").test(findingsSource)) {
                addIssue(
                  issues,
                  "responsive.finding.unresolved",
                  `Candidate ${candidate.id} references missing finding ${findingId}`,
                  artifact.path,
                );
              }
            }
          }
        }
      }
    } catch {
      addIssue(issues, "artifact.missing", "Artifact file does not exist", artifact.path);
    }
  }

  const artifactPaths = new Set(manifest.artifacts.map((entry) => entry.path));
  const responsiveContract = "rb-responsive-inventory/v1";
  const reviewDirectories = new Set(
    manifest.artifacts
      .map((entry) => entry.path.match(/^(\.rb\/reviews\/[^/]+)\//)?.[1])
      .filter((entry): entry is string => Boolean(entry)),
  );
  for (const reviewDirectory of reviewDirectories) {
    const declarationPaths = [
      `${reviewDirectory}/REVIEW.md`,
      `${reviewDirectory}/source-manifest.json`,
    ].filter((path) => artifactPaths.has(path));
    let declarationPath: string | undefined;
    for (const path of declarationPaths) {
      try {
        if ((await readFile(safeProjectPath(root, path), "utf8")).includes(responsiveContract)) {
          declarationPath = path;
          break;
        }
      } catch {
        // Missing/stale declaration artifacts are reported by the artifact loop.
      }
    }
    if (declarationPath && !artifactPaths.has(`${reviewDirectory}/RESPONSIVE_INVENTORY.json`)) {
      addIssue(
        issues,
        "responsive.inventory.companion",
        `Reviews declaring ${responsiveContract} require a machine-validatable RESPONSIVE_INVENTORY.json`,
        declarationPath,
      );
    }
  }

  return { valid: issues.length === 0, issues, manifest };
}

export async function resolveArtifacts(
  root: string,
  options: { kind?: string; status?: ArtifactStatus } = {},
): Promise<ArtifactRecord[]> {
  const validation = await validateManifestTree(root);
  if (!validation.valid || !validation.manifest) {
    const details = validation.issues.map((entry) => `${entry.code}: ${entry.message}`).join("; ");
    throw new Error(`Artifact tree is invalid: ${details}`);
  }
  return validation.manifest.artifacts.filter((artifact) =>
    (!options.kind || artifact.kind === options.kind) && (!options.status || artifact.status === options.status),
  );
}
