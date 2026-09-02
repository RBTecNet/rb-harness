import type { ResolvedProviderCredential } from "../contract.js";
import { OPEN_CODE_SERVICES, normalizeOpenCodeDiscovery, openCodeModelsEndpoint, type DiscoveredOpenCodeModel, type OpenCodeService } from "./catalog.js";
import { OPENCODE_EXECUTABLE, SpawnOpenCodeProcess, openCodeChildEnvironment, withOpenCodeIsolation, type OpenCodeProcess } from "./cli-adapter.js";

/** Explicit/lazy API availability discovery. It never grants compatibility or conformance. */
export async function discoverOpenCodeApiModels(
  service: OpenCodeService,
  credential: ResolvedProviderCredential,
  fetcher: typeof fetch = fetch,
): Promise<readonly DiscoveredOpenCodeModel[]> {
  const response = await fetcher(openCodeModelsEndpoint(service), {
    method: "GET",
    headers: { authorization: `Bearer ${credential.secret}`, accept: "application/json" },
  });
  if (!response.ok) throw new Error(`OpenCode ${service} model discovery failed with HTTP ${response.status}`);
  return normalizeOpenCodeDiscovery(service, await response.json());
}

/** Explicit/lazy CLI catalog discovery. No version/auth/model lookup occurs at module load. */
export async function discoverOpenCodeCliModels(input: {
  readonly provider?: string;
  readonly processClient?: OpenCodeProcess;
  readonly executable?: string;
  readonly deadlineMs?: number;
} = {}): Promise<readonly string[]> {
  const runner = input.processClient ?? new SpawnOpenCodeProcess();
  const controller = new AbortController();
  const result = await withOpenCodeIsolation((directory) => runner.run({
    executable: input.executable ?? process.env.RB_HARNESS_OPENCODE_BIN ?? OPENCODE_EXECUTABLE,
    args: ["--pure", "models", ...(input.provider ? [input.provider] : [])], stdin: "", cwd: directory,
    env: openCodeChildEnvironment(), signal: controller.signal, deadlineMs: input.deadlineMs ?? 10_000,
  }));
  if (result.exitCode !== 0 || result.timedOut || result.cancelled) throw new Error("OpenCode CLI model discovery failed");
  return [...new Set(result.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^[^\s/]+\/[^\s/]+$/.test(line)))].sort();
}

export function openCodeCredentialNamespace(service: OpenCodeService): "opencode-go" | "opencode-zen" {
  return OPEN_CODE_SERVICES[service].credentialNamespace;
}
