import { access, mkdir, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export interface PublicationResult {
  readonly publishedRoot: string;
  readonly previousRoot?: string;
}

/** Publish a fully closed staged `.rb` tree. Rollback is only for filesystem faults. */
export async function publishStagedRb(
  projectRoot: string,
  stagedRbRoot: string,
  previousRoot: string,
): Promise<PublicationResult> {
  const liveRoot = resolve(projectRoot, ".rb");
  await mkdir(dirname(previousRoot), { recursive: true });
  const hadLive = await exists(liveRoot);
  if (hadLive) {
    if (await exists(previousRoot)) throw new Error(`Publication backup already exists: ${previousRoot}`);
    await rename(liveRoot, previousRoot);
  }
  try {
    await rename(stagedRbRoot, liveRoot);
  } catch (error) {
    if (hadLive && await exists(previousRoot) && !await exists(liveRoot)) await rename(previousRoot, liveRoot);
    throw new Error(`PUBLICATION_FAULT: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { publishedRoot: liveRoot, ...(hadLive ? { previousRoot } : {}) };
}

