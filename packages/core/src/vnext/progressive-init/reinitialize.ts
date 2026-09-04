import { purgeProgressiveInitArtifacts } from "./purge.js";

/**
 * The sole destructive lifecycle gate. It is called only after the final
 * execution confirmation and starts the fresh execution immediately after a
 * fully verified Core-owned purge.
 */
export async function startProgressiveInitAfterConfirmation<T>(
  options: { readonly projectRoot: string; readonly reinitialize: boolean },
  startFreshExecution: () => Promise<T>,
): Promise<T> {
  if (options.reinitialize) await purgeProgressiveInitArtifacts(options.projectRoot);
  return startFreshExecution();
}
