export declare const SIMULATED_NODE_VERSION_VARIABLE: "RB_HARNESS_PREFLIGHT_SIMULATED_NODE";

export type NodeSupportReason =
  | "supported"
  | "below-minimum"
  | "unreadable-runtime"
  | "unreadable-requirement";

export interface NodeSupportEvaluation {
  readonly supported: boolean;
  readonly reason: NodeSupportReason;
  readonly detected: string;
  readonly requiredMajor: number | undefined;
}

export interface AssertSupportedNodeOptions {
  readonly version?: string;
  readonly supportedRange?: string;
  readonly repositoryRoot?: string;
  readonly recoveryCommand?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stderr?: { write(value: string): unknown };
  readonly exit?: (code: number) => void;
}

export declare function readSupportedNodeRange(root?: string): string | undefined;
export declare function parseRequiredMajor(range: unknown): number | undefined;
export declare function parseRuntimeMajor(version: unknown): number | undefined;
export declare function evaluateNodeSupport(
  runtimeVersion: unknown,
  supportedRange: unknown,
): NodeSupportEvaluation;
export declare function formatUnsupportedNodeMessage(
  evaluation: NodeSupportEvaluation,
  recoveryCommand?: string,
): string;
export declare function assertSupportedNodeVersion(
  options?: AssertSupportedNodeOptions,
): NodeSupportEvaluation;
