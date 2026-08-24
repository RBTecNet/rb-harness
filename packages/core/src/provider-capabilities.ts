/**
 * What each provider adapter can actually be held to (CR-003).
 *
 * The bundled direct-API runtime is the only adapter the Harness controls end
 * to end: it owns the tool catalog, counts every call, and reports the usage
 * the provider returned. An external CLI runs its own agent loop, so claiming
 * the same budget for it would be a fiction.
 *
 * Every entry below was derived from the `--help` of a locally installed
 * version — never from a guess. `advertised` means the installed CLI documents
 * the mechanism; `verified` means the Harness has parsed that mechanism's real
 * output. An advertised-but-unverified mechanism is not used to claim control:
 * the adapter is governed by the conservative limits instead, and telemetry
 * records the axis as unmeasured.
 */

import type { ProviderId } from "./provider-registry.js";

export interface AdapterCapability {
  /** The installed CLI documents this mechanism. */
  advertised: boolean;
  /** The Harness parses this mechanism's real output. */
  verified: boolean;
  /** The exact flag or channel, when there is one. */
  mechanism?: string;
}

export interface ProviderCapabilities {
  id: ProviderId | "custom";
  /** A machine-readable event stream the Harness can account for. */
  structuredEvents: AdapterCapability;
  /** Reliable turn accounting derived from that stream. */
  turnAccounting: AdapterCapability;
  /** Reliable tool-call accounting derived from that stream. */
  toolAccounting: AdapterCapability;
  /** The adapter stops its own work when asked, before the signal ladder. */
  cooperativeCancellation: AdapterCapability;
  /** Token or cost usage the adapter reports programmatically. */
  usageMetrics: AdapterCapability;
  /**
   * Whether the adapter's *reads* are confined to the directory it is given.
   * A read-only sandbox is not read confinement: it stops writes while leaving
   * the whole filesystem readable. Only the bundled runtime, whose tools
   * enforce the path policy in process, actually confines reads.
   */
  readConfinement: AdapterCapability;
  /** Version whose help output these declarations were read from. */
  inspectedVersion?: string;
  notes: string;
}

const NONE: AdapterCapability = { advertised: false, verified: false };

/**
 * `codex exec --json` prints JSONL events and `--output-last-message` writes
 * the final message, but the event schema has not been parsed by the Harness,
 * so codex is governed as an opaque adapter.
 */
const CODEX: ProviderCapabilities = {
  id: "codex",
  structuredEvents: { advertised: true, verified: false, mechanism: "codex exec --json" },
  turnAccounting: { advertised: true, verified: false, mechanism: "codex exec --json" },
  toolAccounting: { advertised: true, verified: false, mechanism: "codex exec --json" },
  cooperativeCancellation: NONE,
  usageMetrics: NONE,
  readConfinement: NONE,
  inspectedVersion: "codex-cli 0.149.1",
  notes: "Runs its own agent loop under --sandbox read-only, which blocks writes but leaves the filesystem readable. The JSONL event schema is not parsed by the Harness, so turn and tool counts are not claimed.",
};

/**
 * Claude Code advertises `--output-format stream-json` and `--max-budget-usd`.
 * Neither has been exercised by the Harness, so it is governed as opaque.
 */
const CLAUDE: ProviderCapabilities = {
  id: "claude",
  structuredEvents: { advertised: true, verified: false, mechanism: "claude --output-format stream-json" },
  turnAccounting: { advertised: true, verified: false, mechanism: "claude --output-format stream-json" },
  toolAccounting: { advertised: true, verified: false, mechanism: "claude --output-format stream-json" },
  cooperativeCancellation: NONE,
  usageMetrics: { advertised: true, verified: false, mechanism: "claude --max-budget-usd" },
  readConfinement: NONE,
  inspectedVersion: "2.1.241 (Claude Code)",
  notes: "Runs its own agent loop under --permission-mode plan, which blocks edits but leaves the filesystem readable. The stream-json schema is not parsed by the Harness, so turn, tool, and cost control are not claimed.",
};

/**
 * OpenCode advertises `run --format json` as "raw JSON events". The Harness
 * consumes that stream, so its event accounting is real; the field names of
 * individual events are provider-owned and are read structurally rather than
 * assumed.
 */
const OPENCODE: ProviderCapabilities = {
  id: "opencode",
  structuredEvents: { advertised: true, verified: true, mechanism: "opencode run --format json" },
  turnAccounting: { advertised: true, verified: true, mechanism: "opencode run --format json" },
  toolAccounting: { advertised: true, verified: true, mechanism: "opencode run --format json" },
  cooperativeCancellation: NONE,
  usageMetrics: NONE,
  readConfinement: NONE,
  inspectedVersion: "1.18.21",
  notes: "Emits JSON events the Harness counts against the documentation turn and tool budget. Token usage is not reported by the CLI and stays unmeasured.",
};

const DIRECT: ProviderCapabilities = {
  id: "openai",
  structuredEvents: { advertised: true, verified: true, mechanism: "bundled direct-API runtime" },
  turnAccounting: { advertised: true, verified: true, mechanism: "bundled direct-API runtime" },
  toolAccounting: { advertised: true, verified: true, mechanism: "bundled direct-API runtime" },
  cooperativeCancellation: { advertised: true, verified: true, mechanism: "bundled direct-API runtime" },
  usageMetrics: { advertised: true, verified: true, mechanism: "provider usage field" },
  readConfinement: { advertised: true, verified: true, mechanism: "in-process path policy" },
  notes: "The Harness owns the loop: the tool catalog, the call budget, the reported usage, and every path the model may read are enforced locally.",
};

const CUSTOM: ProviderCapabilities = {
  id: "custom",
  structuredEvents: NONE,
  turnAccounting: NONE,
  toolAccounting: NONE,
  cooperativeCancellation: NONE,
  usageMetrics: NONE,
  readConfinement: NONE,
  notes: "A custom adapter declares nothing; it is governed entirely by the conservative time, output, and progress limits.",
};

const DIRECT_PROVIDERS = new Set<string>(["openai", "anthropic", "gemini", "deepseek", "minimax", "openrouter"]);

export function providerCapabilities(provider: ProviderId): ProviderCapabilities {
  if (provider === "codex") return CODEX;
  if (provider === "claude") return CLAUDE;
  if (provider === "opencode") return OPENCODE;
  if (DIRECT_PROVIDERS.has(provider)) return { ...DIRECT, id: provider };
  return CUSTOM;
}

/**
 * Whether the Harness may account for this adapter's turns and tools. Only a
 * verified mechanism counts; an advertised one is a documentation note.
 */
export function isControlledAdapter(provider: ProviderId): boolean {
  const capabilities = providerCapabilities(provider);
  return capabilities.structuredEvents.verified && capabilities.toolAccounting.verified;
}

/** One-line honest summary for the log, the dashboard, and the report. */
export function describeAdapterControl(provider: ProviderId): string {
  const capabilities = providerCapabilities(provider);
  if (isControlledAdapter(provider)) {
    return `orçamento documental aplicado via ${capabilities.structuredEvents.mechanism}`;
  }
  const advertised = capabilities.structuredEvents.advertised;
  return advertised
    ? `não medido neste eixo: ${capabilities.structuredEvents.mechanism} é anunciado mas não é consumido pelo Harness; limites conservadores em vigor`
    : "não medido neste eixo: o adapter não expõe eventos estruturados; limites conservadores em vigor";
}

/**
 * Whether this adapter's reads are actually confined to the directory it runs
 * in. Only the bundled runtime is; every external CLI can read the filesystem,
 * and the Harness says so instead of describing the evidence projection as
 * isolation it does not provide.
 */
export function confinesReads(provider: ProviderId): boolean {
  return providerCapabilities(provider).readConfinement.verified;
}

/** One honest sentence about what the evidence projection does and does not do. */
export function describeReadConfinement(provider: ProviderId): string {
  if (confinesReads(provider)) {
    return "leituras confinadas ao projeto pela política de caminhos aplicada em processo";
  }
  return "sem confinamento de leitura no nível do SO: a projeção de evidências remove o estado de controle de todo caminho relativo "
    + "e não entrega o caminho absoluto do projeto real, mas este adapter não é sandbox de leitura";
}
