import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

export const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".rb",
  ".idea",
  ".vscode",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  "target",
]);

export function toPosix(path: string): string {
  return path.split(sep).join("/");
}

export function relativeProjectPath(root: string, path: string): string {
  return toPosix(relative(resolve(root), resolve(path)));
}

export function safeProjectPath(root: string, relativePath: string): string {
  if (!relativePath || relativePath.includes("\0") || relativePath.includes("\t") || relativePath.includes("\n")) {
    throw new Error(`Unsafe project path: ${JSON.stringify(relativePath)}`);
  }
  const absoluteRoot = resolve(root);
  const absolute = resolve(absoluteRoot, relativePath);
  if (absolute !== absoluteRoot && !absolute.startsWith(`${absoluteRoot}${sep}`)) {
    throw new Error(`Path escapes project root: ${relativePath}`);
  }
  return absolute;
}

export async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, path);
}

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function walkFiles(root: string, maxFiles = 10_000): Promise<string[]> {
  const output: string[] = [];
  async function visit(directory: string): Promise<void> {
    if (output.length >= maxFiles) return;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (output.length >= maxFiles) break;
      if (entry.isSymbolicLink()) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) await visit(path);
      } else if (entry.isFile()) {
        output.push(path);
      }
    }
  }
  await visit(resolve(root));
  return output;
}
