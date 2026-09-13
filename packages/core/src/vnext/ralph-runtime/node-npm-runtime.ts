import { constants, type BigIntStats } from "node:fs";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { sha256Canonical } from "./hashing.js";

export const RALPH_QUALIFIED_NODE_VERSION_V1 = "v20.19.5" as const;
export const RALPH_QUALIFIED_NPM_VERSION_V1 = "10.8.2" as const;

export class RalphNodeNpmRuntimeErrorV1 extends Error {
  readonly code = "RALPH_NODE_NPM_RUNTIME_UNQUALIFIED" as const;
  constructor(readonly cause?: unknown) {
    super("RALPH_NODE_NPM_RUNTIME_UNQUALIFIED");
    this.name = "RalphNodeNpmRuntimeErrorV1";
  }
}

export interface QualifiedNodeNpmRuntimeV1 {
  readonly nodeVersion: typeof RALPH_QUALIFIED_NODE_VERSION_V1;
  readonly npmVersion: typeof RALPH_QUALIFIED_NPM_VERSION_V1;
  readonly runtimeRoot: string;
  readonly binRoot: string;
  readonly nodeExecutablePath: string;
  readonly npmExecutablePath: string;
  readonly npmCliPath: string;
  readonly nodeIdentity: string;
  readonly npmIdentity: string;
  readonly identityDigest: string;
}

export async function inspectQualifiedNodeNpmRuntimeV1(): Promise<QualifiedNodeNpmRuntimeV1> {
  try {
    if (process.version !== RALPH_QUALIFIED_NODE_VERSION_V1) throw new Error("node version");
    const nodeExecutablePath = resolve(process.execPath);
    const nodeStats = await lstat(nodeExecutablePath, { bigint: true });
    if (!nodeStats.isFile() || nodeStats.isSymbolicLink() || await realpath(nodeExecutablePath) !== nodeExecutablePath) throw new Error("node executable");
    await access(nodeExecutablePath, constants.X_OK);
    const binRoot = dirname(nodeExecutablePath);
    const runtimeRoot = resolve(binRoot, "..");
    if (await realpath(runtimeRoot) !== runtimeRoot) throw new Error("runtime root");

    const npmExecutablePath = join(binRoot, "npm");
    const npmCliPath = resolve(runtimeRoot, "lib", "node_modules", "npm", "bin", "npm-cli.js");
    const npmStats = await lstat(npmExecutablePath, { bigint: true });
    if ((!npmStats.isFile() && !npmStats.isSymbolicLink()) || await realpath(npmExecutablePath) !== npmCliPath) throw new Error("npm executable");
    await access(npmExecutablePath, constants.X_OK);
    const cliStats = await lstat(npmCliPath, { bigint: true });
    if (!cliStats.isFile() || cliStats.isSymbolicLink()) throw new Error("npm cli");
    const npmPackagePath = resolve(runtimeRoot, "lib", "node_modules", "npm", "package.json");
    const npmPackageStats = await lstat(npmPackagePath);
    if (!npmPackageStats.isFile() || npmPackageStats.isSymbolicLink()) throw new Error("npm package");
    const npmPackage: unknown = JSON.parse(await readFile(npmPackagePath, "utf8"));
    if (!isRecord(npmPackage) || npmPackage.name !== "npm" || npmPackage.version !== RALPH_QUALIFIED_NPM_VERSION_V1) throw new Error("npm version");

    const nodeIdentity = sha256Canonical(statIdentity(nodeStats));
    const npmIdentity = sha256Canonical({ executable: statIdentity(npmStats), cli: statIdentity(cliStats), packagePath: npmPackagePath });
    const base = {
      nodeVersion: RALPH_QUALIFIED_NODE_VERSION_V1,
      npmVersion: RALPH_QUALIFIED_NPM_VERSION_V1,
      runtimeRoot,
      binRoot,
      nodeExecutablePath,
      npmExecutablePath,
      npmCliPath,
      nodeIdentity,
      npmIdentity,
    };
    return Object.freeze({ ...base, identityDigest: sha256Canonical(base) });
  } catch (error) {
    if (error instanceof RalphNodeNpmRuntimeErrorV1) throw error;
    throw new RalphNodeNpmRuntimeErrorV1(error);
  }
}

export async function revalidateQualifiedNodeNpmRuntimeV1(expected: QualifiedNodeNpmRuntimeV1): Promise<void> {
  const current = await inspectQualifiedNodeNpmRuntimeV1();
  if (current.identityDigest !== expected.identityDigest) throw new RalphNodeNpmRuntimeErrorV1();
}

function statIdentity(stats: BigIntStats): Record<string, string | number> {
  return {
    dev: stats.dev.toString(),
    ino: stats.ino.toString(),
    mode: Number(stats.mode),
    size: stats.size.toString(),
    mtimeNs: stats.mtimeNs.toString(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
