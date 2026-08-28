import type { ArtifactManifest, ArtifactRecord } from "../../types.js";
import { sha256Text } from "../../hash.js";
import { briefArtifactId, executionArtifactId } from "../identity.js";
import type { InitProjectModel } from "../ir.js";

export interface StagedArtifactBytes {
  readonly path: ".rb/init/BRIEF.md" | ".rb/init/PHASES.md";
  readonly bytes: Buffer;
}

export function buildManifest(
  model: InitProjectModel,
  staged: readonly StagedArtifactBytes[],
): ArtifactManifest {
  const byPath = new Map(staged.map((entry) => [entry.path, entry.bytes]));
  const brief = byPath.get(".rb/init/BRIEF.md");
  const phases = byPath.get(".rb/init/PHASES.md");
  if (!brief || !phases || staged.length !== 2 || byPath.size !== 2) {
    throw new Error("vNext manifest requires exact staged bytes for BRIEF.md and PHASES.md");
  }
  const artifacts: ArtifactRecord[] = [
    {
      id: briefArtifactId(model.core.identity.id),
      kind: "project-brief",
      path: ".rb/init/BRIEF.md",
      status: "ready",
      sha256: sha256Text(brief),
    },
    {
      id: executionArtifactId(model.core.identity.id),
      kind: "execution-plan",
      path: ".rb/init/PHASES.md",
      status: "ready",
      sha256: sha256Text(phases),
      contract: "rb-execution/v1",
    },
  ];
  return {
    manifestVersion: "rb-manifest/v1",
    project: { id: model.core.identity.id, name: model.core.identity.name },
    artifactRoot: ".rb",
    generatedAt: model.core.provenance.generatedAt,
    artifacts,
  };
}

export function renderManifest(manifest: ArtifactManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

