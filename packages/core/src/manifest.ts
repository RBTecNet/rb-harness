import { access, mkdir, readFile } from "node:fs/promises";
import { basename, extname, resolve, sep } from "node:path";
import { validateExecutionMarkdown } from "./execution-contract.js";
import { atomicWrite, readJson, relativeProjectPath, safeProjectPath, walkFiles } from "./fs-utils.js";
import { sha256File, sha256Text } from "./hash.js";
import { isIsoDateTime } from "./headless-contract.js";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function schemaIssue(issues: ValidationIssue[], code: string, message: string, path: string): void {
  issues.push({ code, message, severity: "error", path });
}

function denseArray(value: unknown, issues: ValidationIssue[], path: string): value is unknown[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) {
      schemaIssue(issues, "manifest.schema.array.sparse", "Manifest arrays must not contain empty entries", `${path}[${index}]`);
      return false;
    }
  }
  return true;
}

function schemaObject(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
  issues: ValidationIssue[],
  path: string,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    schemaIssue(issues, "manifest.schema.object", "Manifest values must be objects", path);
    return undefined;
  }
  for (const key of Object.keys(value)) if (!allowed.includes(key)) schemaIssue(issues, "manifest.schema.property.unknown", `Unknown property ${key}`, `${path}.${key}`);
  for (const key of required) if (!(key in value)) schemaIssue(issues, "manifest.schema.property.required", `Missing required property ${key}`, `${path}.${key}`);
  return value;
}

export function validateManifestValue(value: unknown): ManifestValidation {
  const issues: ValidationIssue[] = [];
  const root = schemaObject(value, ["manifestVersion", "project", "artifactRoot", "generatedAt", "artifacts"], ["manifestVersion", "project", "artifactRoot", "generatedAt", "artifacts"], issues, "$");
  if (!root) return { valid: false, issues };
  if (root.manifestVersion !== MANIFEST_VERSION) schemaIssue(issues, "manifest.schema.version", "manifestVersion must be rb-manifest/v1", "$.manifestVersion");
  const project = schemaObject(root.project, ["id", "name"], ["id", "name"], issues, "$.project");
  if (project) {
    if (typeof project.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(project.id)) schemaIssue(issues, "manifest.schema.project.id", "project.id is invalid", "$.project.id");
    if (typeof project.name !== "string" || !project.name.trim()) schemaIssue(issues, "manifest.schema.project.name", "project.name is required", "$.project.name");
  }
  if (root.artifactRoot !== ".rb") schemaIssue(issues, "manifest.schema.root", "artifactRoot must be .rb", "$.artifactRoot");
  if (!isIsoDateTime(root.generatedAt)) schemaIssue(issues, "manifest.schema.generatedAt", "generatedAt must be a date-time", "$.generatedAt");
  if (!denseArray(root.artifacts, issues, "$.artifacts")) schemaIssue(issues, "manifest.schema.artifacts", "artifacts must be an array", "$.artifacts");
  else root.artifacts.forEach((value, index) => {
    const artifact = schemaObject(value, ["id", "kind", "path", "status", "sha256", "contract"], ["id", "kind", "path", "status", "sha256"], issues, `$.artifacts[${index}]`);
    if (!artifact) return;
    if (typeof artifact.id !== "string") schemaIssue(issues, "manifest.schema.artifact.id", "artifact.id must be a string", `$.artifacts[${index}].id`);
    if (typeof artifact.kind !== "string") schemaIssue(issues, "manifest.schema.artifact.kind", "artifact.kind must be a string", `$.artifacts[${index}].kind`);
    if (typeof artifact.path !== "string") schemaIssue(issues, "manifest.schema.artifact.path", "artifact.path must be a string", `$.artifacts[${index}].path`);
    if (!["draft", "ready", "blocked", "invalid"].includes(String(artifact.status))) schemaIssue(issues, "manifest.schema.artifact.status", "artifact.status is invalid", `$.artifacts[${index}].status`);
    if (typeof artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(artifact.sha256)) schemaIssue(issues, "manifest.schema.artifact.sha256", "artifact.sha256 is invalid", `$.artifacts[${index}].sha256`);
    if ("contract" in artifact && typeof artifact.contract !== "string") schemaIssue(issues, "manifest.schema.artifact.contract", "artifact.contract must be a string", `$.artifacts[${index}].contract`);
  });
  return { valid: issues.length === 0, issues, ...(issues.length === 0 ? { manifest: root as unknown as ArtifactManifest } : {}) };
}

export function slugify(value: string): string {
  return normalizedIdentifier(value).slice(0, 64) || "project";
}

function normalizedIdentifier(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function artifactDirectoryPath(root: string, artifactDirectory = ".rb"): string {
  const projectRoot = resolve(root);
  const directory = resolve(projectRoot, artifactDirectory);
  if (directory === projectRoot || !directory.startsWith(`${projectRoot}${sep}`)) {
    throw new Error(`Artifact directory must be a child of the project root: ${artifactDirectory}`);
  }
  return directory;
}

function physicalArtifactPath(root: string, logicalPath: string, artifactDirectory = ".rb"): string {
  if (!logicalPath.startsWith(".rb/")) throw new Error(`Artifact path must be under .rb/: ${logicalPath}`);
  return safeProjectPath(artifactDirectoryPath(root, artifactDirectory), logicalPath.slice(4));
}

export function manifestPath(root: string, artifactDirectory = ".rb"): string {
  return resolve(artifactDirectoryPath(root, artifactDirectory), "rb-manifest.json");
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
  const source = relativePath.replace(/^\.rb\//, "").replace(/\.[^.]+$/, "");
  const readable = normalizedIdentifier(source) || "artifact";
  if (readable.length <= 64) return readable;
  const suffix = sha256Text(relativePath).slice(0, 12);
  return `${readable.slice(0, 51).replace(/-+$/g, "")}-${suffix}`;
}

function collisionArtifactId(relativePath: string, claimed: Set<string>): string {
  const readable = normalizedIdentifier(relativePath.replace(/^\.rb\//, "").replace(/\.[^.]+$/, "")) || "artifact";
  for (const suffixLength of [12, 16, 24, 32]) {
    const suffix = sha256Text(relativePath).slice(0, suffixLength);
    const head = readable.slice(0, 63 - suffixLength).replace(/-+$/g, "") || "artifact";
    const candidate = `${head}-${suffix}`;
    if (!claimed.has(candidate)) return candidate;
  }
  throw new Error(`Unable to allocate a stable artifact ID for ${relativePath}`);
}

async function executionMetadata(path: string): Promise<{
  id?: string;
  status: ArtifactStatus;
  contract?: string;
}> {
  const source = await readFile(path, "utf8");
  const result = validateExecutionMarkdown(source);
  // Identity and contract markers remain parseable metadata even when another
  // field makes the document invalid. Dropping the ID here changed the
  // manifest to its path fallback and emitted a false artifact.id.mismatch on
  // top of the real validation error, misleading the bounded repair writer.
  if (!result.valid) return { id: result.document?.artifactId, status: "invalid", contract: result.document?.contract ?? "rb-execution/v1" };
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

export async function loadManifest(root: string, artifactDirectory = ".rb"): Promise<ArtifactManifest> {
  const path = manifestPath(root, artifactDirectory);
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
  if (!validateManifestValue(existing).valid) throw new Error("manifest_schema_invalid");
  const rbRoot = resolve(absoluteRoot, ".rb");
  // `.rb/runs` is append-only Ralph control-plane state, not a portable
  // project artifact. Indexing it makes the manifest depend on a live run and
  // can produce colliding IDs for attempt evidence.
  const files = (await walkFiles(rbRoot, 10_000, new Set(["runs"]))).filter((path) => {
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
  const explicitPaths = new Set(artifacts
    .filter((artifact) => artifact.kind === "execution-plan")
    .map((artifact) => artifact.path));
  const claimed = new Set(artifacts
    .filter((artifact) => explicitPaths.has(artifact.path))
    .map((artifact) => artifact.id));
  for (const artifact of artifacts) {
    if (explicitPaths.has(artifact.path)) continue;
    if (claimed.has(artifact.id)) artifact.id = collisionArtifactId(artifact.path, claimed);
    claimed.add(artifact.id);
  }
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

export async function validateManifestTree(
  root: string,
  options: { artifactDirectory?: string } = {},
): Promise<ManifestValidation> {
  const issues: ValidationIssue[] = [];
  const artifactDirectory = options.artifactDirectory ?? ".rb";
  let manifest: ArtifactManifest;
  try {
    manifest = await loadManifest(root, artifactDirectory);
  } catch (error) {
    addIssue(issues, "manifest.missing", error instanceof Error ? error.message : String(error));
    return { valid: false, issues };
  }
  issues.push(...validateManifestValue(manifest).issues);
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
      absolute = physicalArtifactPath(root, artifact.path, artifactDirectory);
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
            const findingsSource = await readFile(physicalArtifactPath(root, findingsArtifact.path, artifactDirectory), "utf8");
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
        if ((await readFile(physicalArtifactPath(root, path, artifactDirectory), "utf8")).includes(responsiveContract)) {
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
  options: { kind?: string; status?: ArtifactStatus; artifactDirectory?: string } = {},
): Promise<ArtifactRecord[]> {
  const validation = await validateManifestTree(root, { artifactDirectory: options.artifactDirectory });
  if (!validation.valid || !validation.manifest) {
    const details = validation.issues.map((entry) => `${entry.code}: ${entry.message}`).join("; ");
    throw new Error(`Artifact tree is invalid: ${details}`);
  }
  return validation.manifest.artifacts.filter((artifact) =>
    (!options.kind || artifact.kind === options.kind) && (!options.status || artifact.status === options.status),
  );
}
