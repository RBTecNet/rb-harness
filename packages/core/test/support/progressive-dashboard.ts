import type {
  CanonicalSemanticResponse,
  ModelProfile,
  ProviderAdapter,
  ProviderOutcome,
  ResolvedProviderAuth,
  SemanticRequest,
} from "../../src/vnext/providers/contract.js";
import type { ProgressiveStageSnapshot } from "../../src/vnext/progressive-init/coordinator.js";
import { PROGRESSIVE_INIT_STAGES, type ProgressiveInitStage } from "../../src/vnext/progressive-init/stages.js";
import type {
  ProgressiveKey,
  ProgressiveTerminal,
  ProgressiveTerminalCapabilities,
  ProgressiveTerminalInput,
  ProgressiveTerminalOutput,
} from "../../src/vnext/progressive-init/dashboard/terminal.js";

/** A fakeable Dashboard terminal: no escape sequences, no process ownership. */
export interface FakeProgressiveTerminal extends ProgressiveTerminal {
  readonly frames: string[];
  readonly closes: () => number;
  press(...keys: readonly ProgressiveKey[]): void;
  resize(width: number, height: number): void;
  last(): string;
}

export function fakeProgressiveTerminal(
  capabilities: Partial<ProgressiveTerminalCapabilities> = {},
): FakeProgressiveTerminal {
  let current: ProgressiveTerminalCapabilities = {
    width: capabilities.width ?? 100,
    height: capabilities.height ?? 34,
    color: capabilities.color ?? false,
    unicode: capabilities.unicode ?? true,
  };
  const frames: string[] = [];
  const keyListeners: ((key: ProgressiveKey) => void)[] = [];
  const resizeListeners: (() => void)[] = [];
  let closes = 0;
  let closed = false;
  return {
    interactive: true,
    frames,
    closes: () => closes,
    capabilities: () => current,
    frame: (content) => void frames.push(content),
    onKey: (listener) => void keyListeners.push(listener),
    onResize: (listener) => void resizeListeners.push(listener),
    close: () => {
      if (closed) return;
      closed = true;
      closes += 1;
      keyListeners.length = 0;
      resizeListeners.length = 0;
    },
    press: (...keys) => {
      for (const key of keys) for (const listener of [...keyListeners]) listener(key);
    },
    resize: (width, height) => {
      current = { ...current, width, height };
      for (const listener of [...resizeListeners]) listener();
    },
    last: () => frames[frames.length - 1] ?? "",
  };
}

export const character = (value: string): ProgressiveKey => ({ name: "character", value });
export const key = (name: ProgressiveKey["name"]): ProgressiveKey => ({ name });

/** Stream doubles for `createProgressiveTerminal` restoration proofs. */
export function fakeStreams(options: { readonly isTTY?: boolean } = {}) {
  const tty = options.isTTY !== false;
  const written: string[] = [];
  const dataListeners: ((chunk: string | Buffer) => void)[] = [];
  const resizeListeners: (() => void)[] = [];
  const rawModes: boolean[] = [];
  let paused = false;
  const input: ProgressiveTerminalInput = {
    isTTY: tty,
    setRawMode: (mode) => void rawModes.push(mode),
    resume: () => { paused = false; },
    pause: () => { paused = true; },
    setEncoding: () => undefined,
    on: (_event, listener) => void dataListeners.push(listener),
    off: (_event, listener) => {
      const index = dataListeners.indexOf(listener);
      if (index >= 0) dataListeners.splice(index, 1);
    },
  };
  const output: ProgressiveTerminalOutput = {
    isTTY: tty,
    columns: 100,
    rows: 34,
    write: (value) => void written.push(value),
    on: (_event, listener) => void resizeListeners.push(listener),
    off: (_event, listener) => {
      const index = resizeListeners.indexOf(listener);
      if (index >= 0) resizeListeners.splice(index, 1);
    },
  };
  return {
    input,
    output,
    written,
    rawModes,
    dataListeners,
    resizeListeners,
    isPaused: () => paused,
    send: (chunk: string) => { for (const listener of [...dataListeners]) listener(chunk); },
    emitResize: () => { for (const listener of [...resizeListeners]) listener(); },
  };
}

export function stageSnapshots(
  completed: ReadonlySet<ProgressiveInitStage>,
  closureFresh = false,
): ProgressiveStageSnapshot[] {
  return PROGRESSIVE_INIT_STAGES.map((stage) => ({
    stage,
    status: completed.has(stage) ? "complete-fresh" : "incomplete",
    ...(stage === "project-phases" && completed.has(stage)
      ? { closureStatus: closureFresh ? "fresh" as const : "stale" as const }
      : {}),
  }));
}

export const PROGRESSIVE_FIXTURE_REQUEST =
  "Build a stateless TypeScript CLI that accepts one name and prints exactly one greeting. Include deterministic tests.";

function usage() {
  const absent = { measured: false as const, reason: "unsupported-by-provider" as const };
  return {
    inputTokens: absent, cachedInputTokens: absent, cacheWriteTokens: absent,
    outputTokens: absent, reasoningTokens: absent, providerRequests: absent, costUsd: absent,
  };
}

/**
 * Deterministic replacement for a real provider. It exercises the frozen
 * Progressive slices end to end without consuming any live provider capacity.
 */
export class ProgressiveFixtureAdapter implements ProviderAdapter {
  readonly family = "deepseek";
  readonly transport = "direct-api" as const;
  readonly profiles: readonly ModelProfile[];
  readonly requests: SemanticRequest[] = [];

  /**
   * `openQuestion` adds one Core-owned open-ended interview question to P1.
   * `failAtSlice` makes the fixture provider fail one slice, so a fail-closed
   * run can be exercised without a live provider.
   */
  constructor(
    profile: ModelProfile,
    private readonly openQuestion = false,
    private readonly failAtSlice?: string,
  ) { this.profiles = [profile]; }
  checkCapabilities(): ProviderOutcome<true> { return { ok: true, value: true }; }
  replay(): ProviderOutcome<CanonicalSemanticResponse> { throw new Error("replay is unused in this fixture"); }

  async request(
    _profile: ModelProfile,
    _auth: ResolvedProviderAuth,
    request: SemanticRequest,
  ): Promise<ProviderOutcome<CanonicalSemanticResponse>> {
    this.requests.push(request);
    if (request.slice === this.failAtSlice) {
      return { ok: false, error: { kind: "provider-error", message: "fixture provider failure", transportRetryable: false } };
    }
    const input = JSON.parse(request.input) as Record<string, any>;
    let payload: unknown;
    if (request.slice === "project-description") {
      payload = {
        contract: "rb-project-description/v1", stage: "project-description", originalRequest: PROGRESSIVE_FIXTURE_REQUEST,
        project: { key: "greeting-cli", name: "Greeting CLI", objective: "Print exactly one greeting for one supplied name." },
        actors: [{ key: "cli-user", name: "CLI user", responsibility: "Supplies a name and reads the greeting." }],
        capabilities: [{ key: "print-greeting", statement: "Accept one name and print exactly one greeting." }],
        workflows: [{ key: "greet-user", statement: "A CLI user supplies a name and receives one greeting.", actorKeys: ["cli-user"], capabilityKeys: ["print-greeting"] }],
        constraints: [], determinations: [], qualityCommands: [{ key: "tests", kind: "test", command: "npm test" }],
        questions: this.openQuestion && !input.recovery
          ? [{
            key: "greeting-output-format",
            question: "Which exact greeting text must the CLI print for a supplied name?",
            materiality: "product",
            rigidity: "RIGID",
            recommendedAnswer: {
              value: "Hello, <name>!",
              rationale: "The request fixes one greeting per name but not its literal wording.",
            },
            alternatives: ["Hi <name>", "Greetings, <name>"],
          }]
          : [],
      };
    } else if (request.slice === "user-stories-questions") {
      payload = { contract: "rb-user-stories-questions/v1", stage: "user-stories", participationRecommendations: [], questions: [] };
    } else if (request.slice === "user-stories") {
      payload = {
        contract: "rb-user-stories/v1", stage: "user-stories", projectKey: "greeting-cli",
        stories: [{
          key: "print-greeting", workflowKey: "greet-user", capabilityKeys: ["print-greeting"],
          actorKey: "cli-user", operatorActorKey: "cli-user", intent: "Supply one name",
          outcome: "Receive exactly one greeting containing that name",
          acceptance: ["Running the CLI with one name prints exactly one greeting containing that name."],
        }],
      };
    } else if (request.slice === "database-schema-persistence-questions") {
      payload = {
        contract: "rb-database-schema-persistence-questions/v1", stage: "database-schema",
        recommendations: input.storyPersistenceSubjects.map((subject: any) => ({
          subjectKey: subject.key, recommendedOptionKey: "not-persisted",
          question: `Should ${subject.storyKey} persist data?`,
          rationale: "The approved workflow completes within one process invocation.",
        })),
      };
    } else if (request.slice === "project-phases") {
      payload = {
        phases: [{
          key: "implementation", title: "Implement the greeting CLI", goal: "Deliver the approved stateless greeting workflow.",
          tasks: [{
            key: "implement-greeting", title: "Implement and test greeting output",
            intent: "Implement the CLI argument contract, greeting output, and deterministic tests.", dependsOn: [],
            ownedPaths: ["src/cli.ts", "test/cli.test.ts"],
            coverageKeys: input.implementationSubjects.map((subject: any) => subject.key),
            acceptance: ["Running the CLI with one name prints exactly one greeting containing that name."],
            validation: [{ kind: "command", commandKey: "tests" }],
            expectedEvidence: "Passing deterministic test output for the accepted greeting and argument contract.",
          }],
        }],
      };
    } else {
      throw new Error(`unexpected fixture slice: ${request.slice}`);
    }
    return {
      ok: true,
      value: {
        slice: request.slice, payload, normalizations: [], usage: usage(),
        transport: {
          startedAt: "2026-09-04T00:00:00.000Z", completedAt: "2026-09-04T00:00:00.001Z",
          firstOutputMs: { measured: false, reason: "unsupported-by-provider" },
          httpStatus: { measured: false, reason: "unsupported-by-provider" },
          requestId: { measured: false, reason: "unsupported-by-provider" },
          stopReason: { measured: false, reason: "unsupported-by-provider" },
        },
      },
    };
  }
}

export const PROGRESSIVE_FIXTURE_AUTH: ResolvedProviderAuth = {
  kind: "credential",
  credential: { id: "fixture", secret: "fixture-only", attributes: {} },
};

export function supportedFixtureProfile(declared: ModelProfile): ModelProfile {
  return {
    ...declared,
    conformance: {
      tier: "SUPPORTED", suiteVersion: "fixture/v1", runId: "fixture",
      recordedAt: "2026-09-04T00:00:00.000Z", normalizationsOnHappyPath: [], verifiedRecord: true,
    },
  };
}
