import type { InitProjectModel } from "../ir.js";

function determinationLines(model: InitProjectModel, assumed: boolean): string[] {
  const selected = model.core.determinations.filter((entry) => (entry.source.kind === "model-default") === assumed);
  return selected.length
    ? selected.map((entry) => `- ${entry.statement} — ${entry.rationale}`)
    : ["- None."];
}

export function renderBrief(model: InitProjectModel): string {
  const qualityKinds = [...new Set(model.qualityCommands.map((entry) => entry.kind))].sort();
  return `${[
    `# Project Brief: ${model.core.identity.name}`,
    "",
    "## Objective",
    "",
    model.core.identity.objective,
    "",
    "## Confirmed determinations",
    "",
    ...determinationLines(model, false),
    "",
    "## Assumptions and defaults",
    "",
    ...determinationLines(model, true),
    "",
    "## Requirements",
    "",
    ...model.requirements.map((entry) => `- ${entry.id} — ${entry.statement}`),
    "",
    "## Protected paths",
    "",
    ...model.core.protectedPaths.map((entry) => `- \`${entry.path}\` — ${entry.reason}`),
    "",
    "## Quality context",
    "",
    ...(qualityKinds.length ? qualityKinds.map((kind) => `- ${kind}`) : ["- None declared."]),
  ].join("\n")}\n`;
}

