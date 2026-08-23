import { lstat, readdir, readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { loadManifest, validateManifestTree } from "./manifest.js";
import type { ProjectInventory } from "./standalone-types.js";

async function pathIsDirectory(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

async function ralphRuns(projectRoot: string): Promise<Array<{ id: string; status: string }>> {
  const root = resolve(projectRoot, ".rb/runs");
  if (!(await pathIsDirectory(root))) return [];
  const runs: Array<{ id: string; status: string }> = [];
  for (const entry of (await readdir(root, { withFileTypes: true })).filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const directory = resolve(root, entry.name);
    let status = "incomplete";
    try {
      const events = await readFile(resolve(directory, "events.tsv"), "utf8");
      if (/\tcompleted(?:\t|$)/m.test(events) || /\tphase_complete(?:\t|$)/m.test(events)) status = "progress-recorded";
      if (/\tblocked(?:\t|$)/m.test(events)) status = "blocked";
    } catch {
      // Older or interrupted runs may not have an events file.
    }
    if (await pathIsDirectory(resolve(directory, ".lock"))) status = "locked";
    runs.push({ id: entry.name, status });
  }
  return runs.slice(-20);
}

function compact(value: string, limit = 280): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1).trimEnd()}…`;
}

function artifactSummary(source: string): { title?: string; summary?: string } {
  const title = source.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const withoutFrontMatter = source.replace(/^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/, "");
  const paragraphs = withoutFrontMatter
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/^#{1,6}\s+.*$/gm, "").trim())
    .filter((paragraph) => paragraph && !/^(?:```|\||[-*]\s|\d+[.)]\s)/.test(paragraph));
  const summary = paragraphs[0] ? compact(paragraphs[0]) : undefined;
  return { ...(title ? { title: compact(title, 120) } : {}), ...(summary ? { summary } : {}) };
}

async function highlightArtifact(
  projectRoot: string,
  artifactDirectory: string,
  artifact: { id: string; kind: string; status: string; path: string },
): Promise<ProjectInventory["artifactHighlights"][number]> {
  const base = resolve(projectRoot, artifactDirectory);
  const logicalRelative = artifact.path === ".rb" ? "" : artifact.path.replace(/^\.rb\//, "");
  const target = resolve(base, logicalRelative);
  const result = { id: artifact.id, kind: artifact.kind, status: artifact.status, path: artifact.path };
  if (target !== base && !target.startsWith(`${base}${sep}`)) return result;
  try {
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 512 * 1024) return result;
    return { ...result, ...artifactSummary(await readFile(target, "utf8")) };
  } catch {
    return result;
  }
}

export async function inspectProjectInventory(projectRoot: string, artifactDirectory: string): Promise<ProjectInventory> {
  const inventory: ProjectInventory = {
    projectRoot,
    artifactDirectory,
    manifestFound: false,
    manifestValid: false,
    artifacts: 0,
    byKind: {},
    byStatus: {},
    readyPlans: [],
    artifactHighlights: [],
    ralphRuns: await ralphRuns(projectRoot),
    issues: [],
  };
  try {
    const manifest = await loadManifest(projectRoot, artifactDirectory);
    inventory.manifestFound = true;
    inventory.projectId = manifest.project.id;
    inventory.projectName = manifest.project.name;
    inventory.generatedAt = manifest.generatedAt;
    inventory.artifacts = manifest.artifacts.length;
    for (const artifact of manifest.artifacts) {
      inventory.byKind[artifact.kind] = (inventory.byKind[artifact.kind] ?? 0) + 1;
      inventory.byStatus[artifact.status] = (inventory.byStatus[artifact.status] ?? 0) + 1;
      if (artifact.kind === "execution-plan" && artifact.status === "ready") {
        inventory.readyPlans.push({ id: artifact.id, path: artifact.path });
      }
    }
    const candidates = manifest.artifacts
      .filter((artifact) => artifact.kind !== "source-manifest" && artifact.kind !== "evidence")
      .slice(-24);
    inventory.artifactHighlights = await Promise.all(
      candidates.map((artifact) => highlightArtifact(projectRoot, artifactDirectory, artifact)),
    );
    const validation = await validateManifestTree(projectRoot, { artifactDirectory });
    inventory.manifestValid = validation.valid;
    inventory.issues = validation.issues.map(({ code, message }) => ({ code, message }));
  } catch (error) {
    inventory.issues.push({ code: "manifest.missing", message: error instanceof Error ? error.message : String(error) });
  }
  return inventory;
}

export function formatProjectInventory(inventory: ProjectInventory): string {
  if (!inventory.manifestFound) {
    return [
      `Projeto: ${inventory.projectRoot}`,
      `Artefatos: nenhum manifest encontrado em ${inventory.artifactDirectory}`,
      `Execuções Ralph encontradas: ${inventory.ralphRuns.length}`,
    ].join("\n");
  }
  const kinds = Object.entries(inventory.byKind).sort().map(([kind, count]) => `${kind}=${count}`).join(", ") || "none";
  const statuses = Object.entries(inventory.byStatus).sort().map(([status, count]) => `${status}=${count}`).join(", ") || "none";
  return [
    `Projeto: ${inventory.projectName} (${inventory.projectId})`,
    `Manifest: ${inventory.manifestValid ? "válido" : "inválido"} · ${inventory.artifacts} artefatos`,
    `Tipos: ${kinds}`,
    `Estados: ${statuses}`,
    `Planos prontos para Ralph: ${inventory.readyPlans.length}`,
    ...(inventory.artifactHighlights.length
      ? ["Resumo do conjunto atual:", ...inventory.artifactHighlights.slice(-8).map((artifact) =>
        `  - ${artifact.title || artifact.id} [${artifact.kind}/${artifact.status}]${artifact.summary ? ` — ${artifact.summary}` : ""}`)]
      : []),
    `Execuções Ralph encontradas: ${inventory.ralphRuns.length}`,
    ...(inventory.issues.length ? [`Pendências determinísticas: ${inventory.issues.length}`] : []),
  ].join("\n");
}
