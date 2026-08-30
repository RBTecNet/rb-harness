import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  classifyRootCliArgs,
  formatIncompleteInitDirectMode,
  missingInitDirectInputs,
} from "../src/init-routing.js";
import { dispatchRootOperation, ROOT_OPERATIONS, selectRootOperation } from "../src/root-wizard.js";
import { collectInitWizardConfiguration } from "../src/init-wizard.js";
import { useHeadlessInterviewPolicy } from "../src/vnext/init-cli.js";
import { renderInitDashboard } from "../src/harness-dashboard.js";
import { createInitRunState } from "../src/vnext/run-state.js";
import type { WizardPrompt } from "../src/harness-wizard.js";

function scripted(answers: string[]): WizardPrompt & { readonly output: string[] } {
  const queue = [...answers];
  const output: string[] = [];
  return {
    ask: async () => {
      const answer = queue.shift();
      if (answer === undefined) throw new Error("scripted input exhausted");
      return answer;
    },
    write: (text) => void output.push(text),
    output,
  };
}

describe("canonical Init CLI routing", () => {
  it("distinguishes selectors, presentation modifiers, and operational arguments", () => {
    expect(classifyRootCliArgs([], true)).toEqual({ kind: "root-wizard" });
    expect(classifyRootCliArgs(["--dashboard"], true)).toEqual({ kind: "root-wizard", dashboard: true });
    expect(classifyRootCliArgs(["--init"], true)).toEqual({ kind: "init-wizard" });
    expect(classifyRootCliArgs(["--init", "--dashboard"], true)).toEqual({ kind: "init-wizard", dashboard: true });
    expect(classifyRootCliArgs(["--init", "--project", "."], true)).toEqual({
      kind: "init-direct", argv: ["--project", "."],
    });
    expect(classifyRootCliArgs(["--init", "--stage", "project-description", "request"], true)).toEqual({
      kind: "init-direct", argv: ["--stage", "project-description", "request"],
    });
    expect(classifyRootCliArgs(["--stage", "project-description", "--init", "request"], true)).toEqual({
      kind: "init-direct", argv: ["--stage", "project-description", "request"],
    });
    expect(classifyRootCliArgs(["--init", "--help"], true)).toEqual({ kind: "init-direct", argv: ["--help"] });
    expect(classifyRootCliArgs(["init", "request"], true)).toEqual({ kind: "command" });
  });

  it("never launches a wizard without a TTY", () => {
    expect(classifyRootCliArgs([], false)).toEqual({ kind: "non-interactive-error", operation: "root" });
    expect(classifyRootCliArgs(["--init"], false)).toEqual({ kind: "non-interactive-error", operation: "init" });
    expect(classifyRootCliArgs(["--init", "--project", "."], false).kind).toBe("init-direct");
  });

  it("keeps direct configuration independent from semantic interview mode", () => {
    expect(useHeadlessInterviewPolicy(false, true)).toBe(false);
    expect(useHeadlessInterviewPolicy(true, true)).toBe(true);
    expect(useHeadlessInterviewPolicy(false, false)).toBe(true);
  });

  it("reports exact missing direct-mode inputs and points back to the wizard", () => {
    const missing = missingInitDirectInputs({ requestParts: [], requestFile: undefined });
    expect(missing).toEqual(["--profile", "request"]);
    expect(formatIncompleteInitDirectMode(missing)).toContain("rb-harness --init");
    expect(missingInitDirectInputs({ profile: "profile", requestParts: ["Build it"] })).toEqual([]);
  });

  it("lists only real operations and dispatches the selected operation", async () => {
    expect(ROOT_OPERATIONS.map((entry) => entry.key)).toEqual(["init", "ai-context", "plan", "evolve", "review"]);
    expect(await selectRootOperation(scripted(["1"]))).toBe("init");
    expect(await selectRootOperation(scripted(["ai-context"]))).toBe("ai-context");
    const runInit = vi.fn(async () => undefined);
    const runLegacy = vi.fn(async () => undefined);
    await dispatchRootOperation("init", "0.6.2", { dashboard: true }, { runInit, runLegacy });
    expect(runInit).toHaveBeenCalledWith({ dashboard: true, splash: false });
    expect(runLegacy).not.toHaveBeenCalled();
    await dispatchRootOperation("ai-context", "0.6.2", {}, { runInit, runLegacy });
    expect(runLegacy).toHaveBeenCalledWith("0.6.2", { selectedWorkflow: "ai-context", dashboard: undefined, splash: false });
  });

  it("preserves the exact request and dashboard only as presentation configuration", async () => {
    const project = await mkdtemp(resolve(tmpdir(), "rb-init-wizard-"));
    const request = "Crie um sistema de compras sem reescrever este pedido.";
    const io = scripted(["", "2", "digitar", request, ".", ""]);
    const configuration = await collectInitWizardConfiguration(io, {
      cwd: project,
      dashboard: true,
      profiles: [
        { id: "anthropic:claude-opus-5", transport: "direct-api", requestAccounting: "exact" },
        { id: "anthropic:claude-code-cli:claude-opus-5", transport: "claude-code-cli", requestAccounting: "opaque" },
      ],
    });
    expect(configuration.projectRoot).toBe(project);
    expect(configuration.profileId).toBe("anthropic:claude-code-cli:claude-opus-5");
    expect(configuration.requestParts).toEqual([request]);
    expect(configuration.dashboard).toBe(true);
    expect(configuration.headless).toBe(false);
    expect(configuration.execute).toBe(true);
    expect(io.output.join("")).toContain("rb-harness init");
  });

  it("renders dashboard from safe orchestration metadata only", () => {
    const state = createInitRunState({
      runId: "run-1",
      originalRequest: "SECRET PROJECT REQUEST",
      profileId: "anthropic:claude-code-cli:claude-opus-5",
      transport: "claude-code-cli",
      requestAccounting: "opaque",
      now: "2026-08-29T00:00:00.000Z",
    });
    const rendered = renderInitDashboard({
      stage: state.stage,
      selectedProfileId: state.selectedProfileId,
      transport: state.transport,
      requestAccounting: state.requestAccounting,
      questions: state.questions.length,
      semanticOperations: state.counters.semanticOperations,
      transportInvocations: state.counters.transportInvocations,
      correctiveRegenerations: state.counters.correctiveRegenerations,
      providerRequests: "não medido",
      publicationOccurred: state.publicationOccurred,
    }, "0.6.2");
    expect(rendered).toContain("claude-code-cli");
    expect(rendered).toContain("OPERAÇÕES SEMÂNTICAS");
    expect(rendered).not.toContain("SECRET PROJECT REQUEST");
  });
});
