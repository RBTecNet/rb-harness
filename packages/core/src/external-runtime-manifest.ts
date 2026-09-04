export interface ManagedRuntimePlatform {
  readonly nodePlatform: NodeJS.Platform;
  readonly nodeArchitecture: string;
  readonly asset: string;
  readonly expectedSize: number;
  readonly sha256: string;
  readonly downloadUrl: string;
}

export interface ManagedExternalRuntime {
  readonly id: string;
  readonly version: string;
  readonly semanticModeVersion: string;
  readonly sourceFreezeCommit: string;
  readonly upstreamVersion: string;
  readonly upstreamCommit: string;
  readonly releaseRepository: string;
  readonly releaseTag: string;
  readonly installedFilename: string;
  readonly expectedIdentity: string;
  readonly platforms: Readonly<Record<string, ManagedRuntimePlatform>>;
}

export const RB_CODEX_RUNTIME: ManagedExternalRuntime = Object.freeze({
  id: "rb-codex",
  version: "0.151.0-rb.1",
  semanticModeVersion: "v1",
  sourceFreezeCommit: "0f4d33b4dd0eb7677663803e445ea5bcad64fe12",
  upstreamVersion: "0.151.0",
  upstreamCommit: "78c290807ce710180111df227df3b7a4fe845452",
  releaseRepository: "RBTecNet/rb-codex",
  releaseTag: "rb-codex-v0.151.0-rb.1",
  installedFilename: "rb-codex",
  expectedIdentity:
    "rb-codex 0.151.0-rb.1 (upstream 78c290807ce710180111df227df3b7a4fe845452; semantic-mode v1)",
  platforms: Object.freeze({
    "linux-x86_64": Object.freeze({
      nodePlatform: "linux",
      nodeArchitecture: "x64",
      asset: "rb-codex-linux-x86_64",
      expectedSize: 266_752_616,
      sha256: "b68d7cc25105d38cca12977164e45710ae4576a18f898269b563e743e100493d",
      downloadUrl:
        "https://github.com/RBTecNet/rb-codex/releases/download/rb-codex-v0.151.0-rb.1/rb-codex-linux-x86_64",
    }),
  }),
});

export function managedRuntimePlatformKey(
  runtime: ManagedExternalRuntime,
  platform: NodeJS.Platform | string,
  architecture: string,
): string | undefined {
  return Object.entries(runtime.platforms).find(
    ([, candidate]) => candidate.nodePlatform === platform && candidate.nodeArchitecture === architecture,
  )?.[0];
}
