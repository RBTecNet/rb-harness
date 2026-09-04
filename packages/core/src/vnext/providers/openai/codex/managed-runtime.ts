import type { ProviderOutcome } from "../../contract.js";

export interface VerifiedCodexRuntime {
  readonly executable: string;
  readonly version: string;
  readonly sha256: string;
  readonly semanticModeVersion: string;
  readonly semanticRuntimeVersion: string;
  readonly identity: string;
}

export interface CodexRuntimeVerifier {
  verify(): Promise<ProviderOutcome<VerifiedCodexRuntime>>;
}

let configuredVerifier: CodexRuntimeVerifier = {
  verify: async () => ({
    ok: false,
    error: {
      kind: "unsupported-capability",
      message: "Managed RB-Codex runtime authority is unavailable; run or re-run rb-harness-install",
      transportRetryable: false,
    },
  }),
};

/** Called only by the executable composition root; provider code owns no duplicate runtime manifest. */
export function configureCodexRuntimeVerifier(verifier: CodexRuntimeVerifier): void {
  configuredVerifier = verifier;
}

export class ManagedCodexRuntimeVerifier implements CodexRuntimeVerifier {
  verify(): Promise<ProviderOutcome<VerifiedCodexRuntime>> {
    return configuredVerifier.verify();
  }
}
