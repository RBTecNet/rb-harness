import type { ExecutionDocument } from "../../types.js";
import { executionArtifactId } from "../identity.js";
import type { InitProjectModel, ValidationIntent } from "../ir.js";

function renderValidation(intent: ValidationIntent, commands: ReadonlyMap<string, string>): string {
  if (intent.kind === "command") {
    const command = commands.get(intent.commandKey);
    if (command === undefined) throw new Error(`Invariant I-11 violated: unresolved quality command ${intent.commandKey}`);
    return `\`${command}\``;
  }
  if (intent.kind === "manual") return `manual: ${intent.inspection}`;
  return `human: ${intent.evidence}`;
}

export function deriveExecutionDocument(model: InitProjectModel): ExecutionDocument {
  const commands = new Map(model.qualityCommands.map((entry) => [entry.key as string, entry.command]));
  return {
    contract: "rb-execution/v1",
    artifactId: executionArtifactId(model.core.identity.id),
    title: model.core.identity.name,
    phases: model.phases.map((phase) => ({
      number: phase.number,
      id: phase.id,
      title: phase.title,
      goal: phase.goal,
      dependsOn: [...phase.dependsOn],
      context: ["`.rb/init/BRIEF.md`"],
      tasks: phase.tasks.map((task) => ({
        id: task.id,
        title: task.title,
        done: false,
        scope: task.ownedPaths.map((path) => `\`${path}\``).join(", "),
        change: task.intent,
        covers: task.covers.join(", "),
        dependsOn: [...task.dependsOn],
        parallelSafe: false,
        acceptanceCriteria: task.acceptance.map((entry) => `${entry.id}: ${entry.statement}`),
        validation: task.validation.map((entry) => renderValidation(entry, commands)),
        expectedEvidence: task.expectedEvidence,
        line: 0,
      })),
      line: 0,
    })),
  };
}

function listOrNone(values: readonly string[]): string {
  return values.length ? values.join(", ") : "none";
}

export function renderPhases(document: ExecutionDocument): string {
  const lines = [
    `# RB Execution Plan: ${document.title}`,
    "",
    `<!-- rb-execution-contract: ${document.contract} -->`,
    `<!-- rb-artifact-id: ${document.artifactId} -->`,
  ];
  for (const phase of document.phases) {
    lines.push(
      "",
      `## Phase ${phase.number}: ${phase.title}`,
      "",
      `**Phase ID:** ${phase.id}`,
      `**Goal:** ${phase.goal}`,
      `**Depends on:** ${listOrNone(phase.dependsOn)}`,
      "**Context:**",
      ...phase.context.map((path) => `- ${path}`),
    );
    for (const task of phase.tasks) {
      lines.push(
        "",
        `- [${task.done ? "x" : " "}] ${task.id} — ${task.title}`,
        `  - **Scope:** ${task.scope}`,
        `  - **Change:** ${task.change}`,
        `  - **Covers:** ${task.covers}`,
        `  - **Depends on:** ${listOrNone(task.dependsOn)}`,
        "  - **Parallel safe:** false",
        "  - **Acceptance criteria:**",
        ...task.acceptanceCriteria.map((criterion) => `    - ${criterion}`),
        "  - **Validation:**",
        ...task.validation.map((validation) => `    - ${validation}`),
        `  - **Expected evidence:** ${task.expectedEvidence}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}
