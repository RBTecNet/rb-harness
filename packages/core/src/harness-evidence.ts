/**
 * The read-only evidence projection handed to a provider (CR-005).
 *
 * A CLI provider runs with a real working directory, so the only way to keep it
 * away from the Harness control plane is to give it a directory that does not
 * contain one. The projection mirrors the target project's relative paths for
 * the files the inventory policy admits, and nothing else: no `.rb-harness`,
 * no `.git`, no dependency or build trees, no credentials, no run directory,
 * and no Harness installation.
 *
 * It is a bounded projection, not the old full-project snapshot: the file and
 * byte ceilings are documented constants, and truncation is declared to the
 * model through the input package rather than hidden.
 */

import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { relative, resolve, sep } from "node:path";
import { HARNESS_BUDGET } from "./harness-budget.js";
import { OMITTED_DIRECTORIES, isVisibleProjectPath } from "./path-policy.js";

export interface EvidenceProjection {
  /** Directory the provider runs in. */
  root: string;
  files: number;
  bytes: number;
  /** Whether the inventory budget cut the projection short. */
  truncated: boolean;
}

export interface EvidenceProjectionOptions {
  projectRoot: string;
  /** Project-relative artifact directory, mirrored so existing docs are visible. */
  artifactDirectory: string;
  /**
   * Where to build it. Defaults to a fresh private directory under the OS
   * temporary root, deliberately outside the Harness run directory.
   */
  destination?: string;
}

/**
 * Build (or rebuild) the projection. Symlinks are never followed and never
 * recreated: a link is the simplest way back into an excluded area.
 */
export async function prepareEvidenceProjection(
  options: EvidenceProjectionOptions,
): Promise<EvidenceProjection> {
  const source = resolve(options.projectRoot);
  // An independent private root: nothing of the Harness lives beside it, so
  // `..` leads to an OS temporary directory rather than to run state.
  const root = options.destination
    ? resolve(options.destination)
    : await mkdtemp(resolve(tmpdir(), "rb-harness-evidence-"));
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true, mode: 0o700 });

  let files = 0;
  let bytes = 0;
  let truncated = false;

  async function visit(directory: string, depth: number): Promise<void> {
    if (files >= HARNESS_BUDGET.evidence.maxFiles || bytes >= HARNESS_BUDGET.evidence.maxBytes) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isSymbolicLink()) continue;
      const absolute = resolve(directory, entry.name);
      const relativePath = relative(source, absolute).split(sep).join("/");
      if (!isVisibleProjectPath(relativePath)) continue;
      if (entry.isDirectory()) {
        if (OMITTED_DIRECTORIES.has(entry.name)) continue;
        if (depth >= HARNESS_BUDGET.evidence.maxDepth) {
          truncated = true;
          continue;
        }
        await visit(absolute, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      let info;
      try {
        info = await lstat(absolute);
      } catch {
        continue;
      }
      if (info.size > HARNESS_BUDGET.evidence.maxFileBytes) {
        truncated = true;
        continue;
      }
      if (files + 1 > HARNESS_BUDGET.evidence.maxFiles || bytes + info.size > HARNESS_BUDGET.evidence.maxBytes) {
        truncated = true;
        return;
      }
      const target = resolve(root, relativePath);
      await mkdir(resolve(target, ".."), { recursive: true, mode: 0o700 });
      await copyFile(absolute, target);
      files += 1;
      bytes += info.size;
    }
  }

  await visit(source, 0);
  await sealReadOnly(root);
  return { root, files, bytes, truncated };
}

/**
 * Make the projection read-only depth-first: files lose write permission, then
 * directories, so a directory is never sealed before its contents are written.
 */
async function sealReadOnly(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) await sealReadOnly(absolute);
    else if (entry.isFile()) await chmod(absolute, 0o444).catch(() => undefined);
  }
  // 0555: traversable and listable, but no entry can be created or removed.
  await chmod(directory, 0o555).catch(() => undefined);
}

/**
 * Remove a projection. The read-only seal has to be lifted first: unlinking an
 * entry needs write permission on its parent directory.
 */
export async function discardEvidenceProjection(root: string): Promise<void> {
  async function unseal(directory: string): Promise<void> {
    await chmod(directory, 0o700).catch(() => undefined);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) await unseal(resolve(directory, entry.name));
    }
  }
  await unseal(root);
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
}
