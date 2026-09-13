import { spawn, type ChildProcess } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { ValidationSpecRef } from "../ralph-runtime/operational-v2/index.js";
import {
  ValidationProcessSupervisorV2,
  type ValidationProcessBindingV2,
  type ValidationProcessInputV2,
  type ValidationProcessResultV2,
  type ValidationProcessSupervisorV2Like,
} from "../ralph-runtime/operational-d/process-supervisor.js";
import { canonicalJson } from "../ralph-runtime/canonical-json.js";
import { sha256Canonical } from "../ralph-runtime/hashing.js";
import {
  inspectQualifiedNodeNpmRuntimeV1,
  revalidateQualifiedNodeNpmRuntimeV1,
  RALPH_QUALIFIED_NPM_VERSION_V1,
  type QualifiedNodeNpmRuntimeV1,
} from "../ralph-runtime/node-npm-runtime.js";
import { WORKSPACE_PACKAGE_INFRASTRUCTURE_ROOTS_V1 } from "../ralph-runtime/package-infrastructure.js";
import {
  assertValidationProjectionRunAuthorityV1,
  type ValidationProjectionRunAuthorityV1,
} from "../ralph-runtime/operational-d/validation-projection.js";

export const NPM_DEPENDENCY_PROVISIONING_ERROR_CODES_V1 = [
  "RALPH_BRIDGE_NPM_AUTHORITY_MISSING",
  "RALPH_BRIDGE_NPM_AUTHORITY_INVALID",
  "RALPH_BRIDGE_NPM_AUTHORITY_INCONSISTENT",
  "RALPH_BRIDGE_NPM_AUTHORITY_UNSUPPORTED",
  "RALPH_BRIDGE_NPM_RUNTIME_UNQUALIFIED",
  "RALPH_BRIDGE_NPM_WORKSPACE_UNSAFE",
  "RALPH_BRIDGE_NPM_PROVISIONING_FAILED",
  "RALPH_BRIDGE_NPM_PROVISIONING_TIMEOUT",
  "RALPH_BRIDGE_NPM_EPHEMERAL_MOUNT_FAILED",
  "RALPH_BRIDGE_NPM_CLEANUP_FAILED",
] as const;
export type NpmDependencyProvisioningErrorCodeV1 = typeof NPM_DEPENDENCY_PROVISIONING_ERROR_CODES_V1[number];

export class RalphNpmDependencyProvisioningErrorV1 extends Error {
  constructor(readonly code: NpmDependencyProvisioningErrorCodeV1, readonly cause?: unknown) {
    super(code);
    this.name = "RalphNpmDependencyProvisioningErrorV1";
  }
}

/** Retains the operation's classification while surfacing cleanup as secondary. */
export class RalphNpmDependencyOperationErrorV1 extends Error {
  readonly cleanupCode = "RALPH_BRIDGE_NPM_CLEANUP_FAILED" as const;
  constructor(readonly code: string, readonly primary: unknown, readonly cleanup: unknown) {
    super(code, { cause: new AggregateError([primary, cleanup], code) });
    this.name = "RalphNpmDependencyOperationErrorV1";
  }
}

export interface NpmProvisioningProcessInputV1 {
  readonly executable: string;
  readonly runtime: QualifiedNodeNpmRuntimeV1;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly timeoutMs: number;
  readonly killGraceMs: number;
  readonly maxOutputBytes: number;
}

export interface NpmProvisioningProcessResultV1 {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly supervisionFailed: boolean;
}

export interface NpmProvisioningProcessRunnerV1 {
  readonly run: (input: NpmProvisioningProcessInputV1) => Promise<NpmProvisioningProcessResultV1>;
}

export interface NpmDependencyResidueAuthorityV1 {
  readonly runId: string;
  readonly phaseId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly validationSpecIds: readonly string[];
  readonly pendingValidationRuns: readonly Pick<ValidationProcessBindingV2, "validationSpecId" | "validationRunId">[];
}

export interface NpmDependencyProvisioningSessionV1 {
  readonly manager: "npm";
  readonly disposition: "PROVISIONED" | "NOT_REQUIRED";
  readonly validationSupervisor: ValidationProcessSupervisorV2Like;
  readonly cleanup: () => Promise<void>;
}

export interface NpmDependencyProvisionerV1Like {
  readonly prepare: (input: {
    readonly workspaceRoot: string;
    readonly validationSpecs: readonly ValidationSpecRef[];
    readonly residueAuthority: NpmDependencyResidueAuthorityV1;
  }) => Promise<NpmDependencyProvisioningSessionV1>;
}

export interface NpmDependencyProvisionerV1Options {
  readonly processRunner?: NpmProvisioningProcessRunnerV1;
  readonly validationSupervisor?: ValidationProcessSupervisorV2Like;
  readonly timeoutMs?: number;
  readonly killGraceMs?: number;
  readonly maxOutputBytes?: number;
  readonly temporaryRoot?: string;
}

const NPM_REGISTRY = "https://registry.npmjs.org/";
const NPM_FIXED_ARGV_PREFIX = Object.freeze(["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
const DEPENDENCY_FIELDS = Object.freeze(["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const);
const OVERLAY_MARKER = ".rb-harness-core-npm-overlay-v1.json";
const OVERLAY_SCHEMA = "rb-harness-core-npm-overlay/v1" as const;

export class NpmDependencyProvisionerV1 implements NpmDependencyProvisionerV1Like {
  private readonly options: NpmDependencyProvisionerV1Options;

  constructor(options: NpmDependencyProvisionerV1Options = {}) {
    this.options = { ...options };
  }

  async prepare(input: {
    readonly workspaceRoot: string;
    readonly validationSpecs: readonly ValidationSpecRef[];
    readonly residueAuthority: NpmDependencyResidueAuthorityV1;
  }): Promise<NpmDependencyProvisioningSessionV1> {
    const workspaceRoot = await verifyWorkspaceRoot(input.workspaceRoot);
    validateResidueAuthority(input.residueAuthority, input.validationSpecs);
    await recoverOrRejectWorkspaceInfrastructure(workspaceRoot, input.residueAuthority);
    const authority = await inspectNpmAuthorityV1(workspaceRoot, input.validationSpecs);
    const delegate = this.options.validationSupervisor ?? new ValidationProcessSupervisorV2();
    if (authority.disposition === "NOT_REQUIRED") {
      return Object.freeze({ manager: "npm", disposition: "NOT_REQUIRED", validationSupervisor: delegate, cleanup: async () => undefined });
    }

    let runtime: QualifiedNodeNpmRuntimeV1;
    try { runtime = await inspectQualifiedNodeNpmRuntimeV1(); }
    catch (error) { throw new RalphNpmDependencyProvisioningErrorV1("RALPH_BRIDGE_NPM_RUNTIME_UNQUALIFIED", error); }
    const timeoutMs = boundedInteger(this.options.timeoutMs ?? 300_000, 1, 300_000, "RALPH_BRIDGE_NPM_AUTHORITY_INVALID");
    const killGraceMs = boundedInteger(this.options.killGraceMs ?? 1_000, 1, 10_000, "RALPH_BRIDGE_NPM_AUTHORITY_INVALID");
    const maxOutputBytes = boundedInteger(this.options.maxOutputBytes ?? 16_384, 1, 1_048_576, "RALPH_BRIDGE_NPM_AUTHORITY_INVALID");
    const temporaryBase = await verifyTemporaryBase(this.options.temporaryRoot ?? tmpdir());
    const infrastructureRoot = await mkdtemp(join(temporaryBase, "rb-harness-core-npm-"));
    const temporaryRoot = join(infrastructureRoot, "session");
    const packageRoot = join(temporaryRoot, "package");
    const cacheRoot = join(temporaryRoot, "cache");
    const homeRoot = join(temporaryRoot, "home");
    const userConfig = join(temporaryRoot, "empty-user-npmrc");
    const globalConfig = join(temporaryRoot, "empty-global-npmrc");
    const markerRoot = join(temporaryRoot, "validation-authority");
    try {
      await chmod(infrastructureRoot, 0o700);
      await mkdir(temporaryRoot, { mode: 0o700 });
      await mkdir(packageRoot, { recursive: true, mode: 0o700 });
      await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
      await mkdir(homeRoot, { recursive: true, mode: 0o700 });
      await mkdir(markerRoot, { recursive: true, mode: 0o700 });
      await writeFile(join(packageRoot, "package.json"), authority.packageBytes, { flag: "wx", mode: 0o600 });
      await writeFile(join(packageRoot, "package-lock.json"), authority.lockBytes, { flag: "wx", mode: 0o600 });
      await writeFile(userConfig, "", { flag: "wx", mode: 0o600 });
      await writeFile(globalConfig, "", { flag: "wx", mode: 0o600 });

      const argv = Object.freeze([
        ...NPM_FIXED_ARGV_PREFIX,
        "--cache", cacheRoot,
        "--userconfig", userConfig,
        "--globalconfig", globalConfig,
        "--registry", NPM_REGISTRY,
      ]);
      const processResult = await (this.options.processRunner ?? new HostNpmProvisioningProcessRunnerV1()).run({
        executable: runtime.nodeExecutablePath,
        runtime,
        argv: Object.freeze([runtime.npmCliPath, ...argv]),
        cwd: packageRoot,
        env: npmEnvironment(temporaryRoot, homeRoot, cacheRoot, userConfig, globalConfig, runtime),
        timeoutMs,
        killGraceMs,
        maxOutputBytes,
      });
      if (processResult.timedOut) throw new RalphNpmDependencyProvisioningErrorV1("RALPH_BRIDGE_NPM_PROVISIONING_TIMEOUT");
      if (processResult.supervisionFailed || processResult.exitCode !== 0 || processResult.signal !== null) throw new RalphNpmDependencyProvisioningErrorV1("RALPH_BRIDGE_NPM_PROVISIONING_FAILED");
      const nodeModulesRoot = join(packageRoot, "node_modules");
      const installed = await lstat(nodeModulesRoot).catch(() => undefined);
      if (!installed?.isDirectory() || installed.isSymbolicLink() || await realpath(nodeModulesRoot) !== nodeModulesRoot) throw new RalphNpmDependencyProvisioningErrorV1("RALPH_BRIDGE_NPM_PROVISIONING_FAILED");
      return createProvisionedSession(workspaceRoot, nodeModulesRoot, infrastructureRoot, temporaryRoot, temporaryBase, markerRoot, delegate, input.residueAuthority);
    } catch (error) {
      await removeCoreNpmInfrastructure(infrastructureRoot, temporaryRoot, temporaryBase).catch(() => undefined);
      if (error instanceof RalphNpmDependencyProvisioningErrorV1) throw error;
      throw new RalphNpmDependencyProvisioningErrorV1("RALPH_BRIDGE_NPM_PROVISIONING_FAILED", error);
    }
  }
}

export class HostNpmProvisioningProcessRunnerV1 implements NpmProvisioningProcessRunnerV1 {
  async run(input: NpmProvisioningProcessInputV1): Promise<NpmProvisioningProcessResultV1> {
    await revalidateQualifiedNodeNpmRuntimeV1(input.runtime).catch((error) => { throw new RalphNpmDependencyProvisioningErrorV1("RALPH_BRIDGE_NPM_RUNTIME_UNQUALIFIED", error); });
    if (input.executable !== input.runtime.nodeExecutablePath || input.argv[0] !== input.runtime.npmCliPath || input.runtime.npmVersion !== RALPH_QUALIFIED_NPM_VERSION_V1
      || canonicalJson(input.argv.slice(1, 5)) !== canonicalJson(NPM_FIXED_ARGV_PREFIX)
      || !hasExactCoreNpmOptions(input.argv, input.cwd)
      || !hasExactCoreNpmEnvironment(input)) {
      throw new RalphNpmDependencyProvisioningErrorV1("RALPH_BRIDGE_NPM_AUTHORITY_INVALID");
    }
    await revalidateQualifiedNodeNpmRuntimeV1(input.runtime).catch((error) => { throw new RalphNpmDependencyProvisioningErrorV1("RALPH_BRIDGE_NPM_RUNTIME_UNQUALIFIED", error); });
    let child: ChildProcess;
    try {
      child = spawn(input.executable, [...input.argv], { cwd: input.cwd, env: { ...input.env }, detached: true, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (error) { throw new RalphNpmDependencyProvisioningErrorV1("RALPH_BRIDGE_NPM_PROVISIONING_FAILED", error); }
    drainBounded(child.stdout, input.maxOutputBytes);
    drainBounded(child.stderr, input.maxOutputBytes);
    let timedOut = false;
    let supervisionFailed = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child, "SIGTERM");
      killTimer = setTimeout(() => terminateProcessTree(child, "SIGKILL"), input.killGraceMs);
      killTimer.unref?.();
    }, input.timeoutMs);
    timer.unref?.();
    return await new Promise<NpmProvisioningProcessResultV1>((resolveResult) => {
      let settled = false;
      const finish = (result: NpmProvisioningProcessResultV1) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        resolveResult(Object.freeze(result));
      };
      child.once("error", () => { supervisionFailed = true; });
      child.once("close", (exitCode, signal) => {
        const pid = child.pid;
        if (pid && processGroupAlive(pid)) { supervisionFailed = true; terminateProcessTree(child, "SIGKILL"); }
        finish({ exitCode, signal, timedOut, supervisionFailed });
      });
    });
  }
}

type NpmAuthorityInspectionV1 =
  | { readonly disposition: "NOT_REQUIRED" }
  | { readonly disposition: "REQUIRED"; readonly packageBytes: Buffer; readonly lockBytes: Buffer };

export async function inspectNpmAuthorityV1(workspaceRoot: string, validationSpecs: readonly ValidationSpecRef[]): Promise<NpmAuthorityInspectionV1> {
  assertSupportedDependencyCommands(validationSpecs);
  const packageBytes = await readRegularBounded(join(workspaceRoot, "package.json"), 1_048_576);
  const lockBytes = await readRegularBounded(join(workspaceRoot, "package-lock.json"), 16 * 1_048_576);
  const hasNpmValidation = validationSpecs.some((spec) => spec.kind === "COMMAND" && hasCommandToken(spec.instruction, "npm"));
  if (!packageBytes && !lockBytes) {
    if (hasNpmValidation) throw new RalphNpmDependencyProvisioningErrorV1("RALPH_BRIDGE_NPM_AUTHORITY_MISSING");
    return { disposition: "NOT_REQUIRED" };
  }
  if (!packageBytes || !lockBytes) throw new RalphNpmDependencyProvisioningErrorV1("RALPH_BRIDGE_NPM_AUTHORITY_MISSING");
  for (const unsupported of [".npmrc", "npm-shrinkwrap.json"]) {
    if (await pathExists(join(workspaceRoot, unsupported))) throw new RalphNpmDependencyProvisioningErrorV1("RALPH_BRIDGE_NPM_AUTHORITY_UNSUPPORTED");
  }
  const packageJson = parseJsonRecord(packageBytes, "RALPH_BRIDGE_NPM_AUTHORITY_INVALID");
  const packageLock = parseJsonRecord(lockBytes, "RALPH_BRIDGE_NPM_AUTHORITY_INVALID");
  const dependencyCount = validateNpmAuthority(packageJson, packageLock);
  return dependencyCount === 0 || !validationSpecs.some((spec) => spec.kind === "COMMAND")
    ? { disposition: "NOT_REQUIRED" }
    : { disposition: "REQUIRED", packageBytes, lockBytes };
}

function validateNpmAuthority(packageJson: Record<string, unknown>, packageLock: Record<string, unknown>): number {
  if (packageJson.workspaces !== undefined) throw new RalphNpmDependencyProvisioningErrorV1("RALPH_BRIDGE_NPM_AUTHORITY_UNSUPPORTED");
  if (packageJson.packageManager !== undefined && packageJson.packageManager !== `npm@${RALPH_QUALIFIED_NPM_VERSION_V1}`) throw new RalphNpmDependencyProvisioningErrorV1("RALPH_BRIDGE_NPM_AUTHORITY_UNSUPPORTED");
  if (packageLock.lockfileVersion !== 3) throw new RalphNpmDependencyProvisioningErrorV1("RALPH_BRIDGE_NPM_AUTHORITY_UNSUPPORTED");
  if (packageLock.dependencies !== undefined) throw new RalphNpmDependencyProvisioningErrorV1("RALPH_BRIDGE_NPM_AUTHORITY_UNSUPPORTED");
  if (!isRecord(packageLock.packages) || !isRecord(packageLock.packages[""])) throw new RalphNpmDependencyProvisioningErrorV1("RALPH_BRIDGE_NPM_AUTHORITY_INVALID");
  const lockRoot = packageLock.packages[""] as Record<string, unknown>;
  for (const field of ["name", "version"] as const) {
    if (packageJson[field] !== undefined && (typeof packageJson[field] !== "string" || packageJson[field] !== packageLock[field] || packageJson[field] !== lockRoot[field])) {
      throw new RalphNpmDependencyProvisioningErrorV1("RALPH_BRIDGE_NPM_AUTHORITY_INCONSISTENT");
    }
  }
  let dependencyCount = 0;
  const directNames = new Set<string>();
  for (const field of DEPENDENCY_FIELDS) {
    const manifestDependencies = dependencyMap(packageJson[field]);
    const lockedDependencies = dependencyMap(lockRoot[field]);
    if (canonicalJson([...manifestDependencies]) !== canonicalJson([...lockedDependencies])) throw new RalphNpmDependencyProvisioningErrorV1("RALPH_BRIDGE_NPM_AUTHORITY_INCONSISTENT");
    for (const [name, specifier] of manifestDependencies) {
      assertRegistrySpecifier(specifier);
      directNames.add(name);
      dependencyCount += 1;
    }
  }
  for (const [path, rawEntry] of Object.entries(packageLock.packages)) {
    if (path === "") continue;
    if (!isSafeLockPackagePath(path) || !isRecord(rawEntry) || rawEntry.link === true || rawEntry.inBundle === true) throw new RalphNpmDependencyProvisioningErrorV1("RALPH_BRIDGE_NPM_AUTHORITY_UNSUPPORTED");
    if (typeof rawEntry.version !== "string" || rawEntry.version.length === 0 || rawEntry.version.length > 256) throw new RalphNpmDependencyProvisioningErrorV1("RALPH_BRIDGE_NPM_AUTHORITY_INVALID");
    if (typeof rawEntry.resolved !== "string" || !isTrustedRegistryUrl(rawEntry.resolved)) throw new RalphNpmDependencyProvisioningErrorV1("RALPH_BRIDGE_NPM_AUTHORITY_UNSUPPORTED");
    if (typeof rawEntry.integrity !== "string" || !/^sha(?:1|256|384|512)-[A-Za-z0-9+/=]+$/.test(rawEntry.integrity)) throw new RalphNpmDependencyProvisioningErrorV1("RALPH_BRIDGE_NPM_AUTHORITY_INVALID");
    for (const field of DEPENDENCY_FIELDS) {
      for (const [, specifier] of dependencyMap(rawEntry[field])) assertRegistrySpecifier(specifier);
    }
  }
  for (const name of directNames) if (!isRecord(packageLock.packages[`node_modules/${name}`])) throw new RalphNpmDependencyProvisioningErrorV1("RALPH_BRIDGE_NPM_AUTHORITY_INCONSISTENT");
  return dependencyCount;
}

function createProvisionedSession(
  workspaceRoot: string,
  nodeModulesRoot: string,
  infrastructureRoot: string,
  temporaryRoot: string,
  temporaryBase: string,
  markerRoot: string,
  delegate: ValidationProcessSupervisorV2Like,
  authority: NpmDependencyResidueAuthorityV1,
): NpmDependencyProvisioningSessionV1 {
  let disposed = false;
  let active: { readonly binding: ValidationProcessBindingV2; readonly projection: ValidationProjectionRunAuthorityV1 } | undefined;
  const validationSupervisor: ValidationProcessSupervisorV2Like = Object.freeze({
    run: async (input: ValidationProcessInputV2): Promise<ValidationProcessResultV2> => {
      if (disposed || input.sandboxWritableMounts?.length) throw new RalphNpmDependencyProvisioningErrorV1("RALPH_BRIDGE_NPM_EPHEMERAL_MOUNT_FAILED");
      const binding = requireAuthorizedValidationBinding(input.validationBinding, authority);
      let projection: ValidationProjectionRunAuthorityV1;
      try {
        projection = await assertValidationProjectionRunAuthorityV1({ authority: input.validationProjection, cwd: input.cwd, binding });
        if (projection.canonicalCandidateRoot !== workspaceRoot) throw new Error("foreign candidate");
        await createCoreOverlayMountpoint(projection, binding, markerRoot);
        active = { binding, projection };
      }
      catch (error) {
        if (error instanceof RalphNpmDependencyProvisioningErrorV1) throw error;
        throw new RalphNpmDependencyProvisioningErrorV1("RALPH_BRIDGE_NPM_EPHEMERAL_MOUNT_FAILED", error);
      }
      let result: ValidationProcessResultV2 | undefined;
      let failure: unknown;
      try { result = await delegate.run({ ...input, sandboxWritableMounts: Object.freeze([{ source: nodeModulesRoot, destination: join(projection.projectionRoot, "node_modules") }]) }); }
      catch (error) { failure = error; }
      let cleanupFailure: unknown;
      try { await removeCoreOverlayMountpoint(projection, binding, markerRoot); }
      catch (error) { cleanupFailure = error; }
      if (!cleanupFailure) active = undefined;
      if (failure && cleanupFailure) throw new RalphNpmDependencyOperationErrorV1(errorCode(failure), failure, cleanupFailure);
      if (failure) throw failure;
      if (cleanupFailure) {
        return Object.freeze({
          ...result!,
          infrastructureDiagnostic: "RALPH_BRIDGE_NPM_CLEANUP_FAILED",
        });
      }
      return result!;
    },
  });
  return Object.freeze({
    manager: "npm" as const,
    disposition: "PROVISIONED" as const,
    validationSupervisor,
    cleanup: async () => {
      if (disposed) return;
      let cleanupFailure: unknown;
      if (active) cleanupFailure = new RalphNpmDependencyProvisioningErrorV1("RALPH_BRIDGE_NPM_CLEANUP_FAILED");
      active = undefined;
      disposed = true;
      try { await removeCoreNpmInfrastructure(infrastructureRoot, temporaryRoot, temporaryBase); }
      catch (error) { cleanupFailure ??= new RalphNpmDependencyProvisioningErrorV1("RALPH_BRIDGE_NPM_CLEANUP_FAILED", error); }
      if (cleanupFailure) throw cleanupFailure;
    },
  });
}

interface CoreOverlayMarkerV1 extends ValidationProcessBindingV2 {
  readonly schema: typeof OVERLAY_SCHEMA;
  readonly canonicalCandidateRoot: string;
  readonly projectionRoot: string;
  readonly projectionAuthorityDigest: string;
  readonly markerDigest: string;
}

async function createCoreOverlayMountpoint(projection: ValidationProjectionRunAuthorityV1, binding: ValidationProcessBindingV2, markerRoot: string): Promise<void> {
  await assertCoreOwnedDirectory(markerRoot);
  const mountPath = join(projection.projectionRoot, "node_modules");
  if (await pathExists(mountPath)) throw new RalphNpmDependencyProvisioningErrorV1("RALPH_BRIDGE_NPM_EPHEMERAL_MOUNT_FAILED");
  await mkdir(mountPath, { mode: 0o700 });
  try {
    const base = {
      schema: OVERLAY_SCHEMA,
      ...binding,
      canonicalCandidateRoot: projection.canonicalCandidateRoot,
      projectionRoot: projection.projectionRoot,
      projectionAuthorityDigest: projection.runAuthorityDigest,
    };
    // This proof is an integrity checksum, while authenticity comes from the
    // 0700 Core-owned markerRoot. Neither the provider nor /workspace has a
    // namespace path to this file.
    const marker: CoreOverlayMarkerV1 = { ...base, markerDigest: sha256Canonical(base) };
    await writeFile(join(markerRoot, OVERLAY_MARKER), `${canonicalJson(marker)}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    await rm(mountPath, { recursive: true, force: true }).catch(() => undefined);
    throw new RalphNpmDependencyProvisioningErrorV1("RALPH_BRIDGE_NPM_EPHEMERAL_MOUNT_FAILED", error);
  }
}

async function removeCoreOverlayMountpoint(projection: ValidationProjectionRunAuthorityV1, expected: ValidationProcessBindingV2, markerRoot: string): Promise<void> {
  await assertCoreOwnedDirectory(markerRoot);
  const mountPath = join(projection.projectionRoot, "node_modules");
  const stats = await lstat(mountPath).catch(() => undefined);
  if (!stats) throw new RalphNpmDependencyProvisioningErrorV1("RALPH_BRIDGE_NPM_CLEANUP_FAILED");
  if (!stats.isDirectory() || stats.isSymbolicLink() || await realpath(mountPath) !== mountPath) {
    throw new RalphNpmDependencyProvisioningErrorV1("RALPH_BRIDGE_NPM_CLEANUP_FAILED");
  }
  const marker = await readOverlayMarker(markerRoot);
  if (!marker || !sameBinding(marker, expected) || marker.canonicalCandidateRoot !== projection.canonicalCandidateRoot
    || marker.projectionRoot !== projection.projectionRoot || marker.projectionAuthorityDigest !== projection.runAuthorityDigest) {
    throw new RalphNpmDependencyProvisioningErrorV1("RALPH_BRIDGE_NPM_CLEANUP_FAILED");
  }
  await rm(mountPath, { recursive: true, force: true }).catch((error) => { throw new RalphNpmDependencyProvisioningErrorV1("RALPH_BRIDGE_NPM_CLEANUP_FAILED", error); });
  const markerPath = join(markerRoot, OVERLAY_MARKER);
  const markerStats = await lstat(markerPath);
  if (!markerStats.isFile() || markerStats.isSymbolicLink()) throw new RalphNpmDependencyProvisioningErrorV1("RALPH_BRIDGE_NPM_CLEANUP_FAILED");
  await rm(markerPath, { force: false });
}

async function recoverOrRejectWorkspaceInfrastructure(workspaceRoot: string, authority: NpmDependencyResidueAuthorityV1): Promise<void> {
  void authority;
  for (const root of WORKSPACE_PACKAGE_INFRASTRUCTURE_ROOTS_V1) {
    const path = join(workspaceRoot, root);
    if (!await pathExists(path)) continue;
    throw new RalphNpmDependencyProvisioningErrorV1("RALPH_BRIDGE_NPM_WORKSPACE_UNSAFE");
  }
}

async function readOverlayMarker(markerRoot: string): Promise<CoreOverlayMarkerV1 | undefined> {
  const stats = await lstat(markerRoot).catch(() => undefined);
  if (!stats?.isDirectory() || stats.isSymbolicLink() || await realpath(markerRoot).catch(() => undefined) !== markerRoot) return undefined;
  const bytes = await readRegularBounded(join(markerRoot, OVERLAY_MARKER), 16_384).catch(() => undefined);
  if (!bytes) return undefined;
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!isRecord(value) || value.schema !== OVERLAY_SCHEMA || typeof value.markerDigest !== "string"
      || canonicalJson(Object.keys(value).sort()) !== canonicalJson(["attemptId", "canonicalCandidateRoot", "markerDigest", "phaseId", "projectionAuthorityDigest", "projectionRoot", "runId", "schema", "taskId", "validationRunId", "validationSpecId"])) return undefined;
    const { markerDigest, ...base } = value;
    if (sha256Canonical(base) !== markerDigest || !isValidationBinding(base) || typeof base.canonicalCandidateRoot !== "string"
      || typeof base.projectionRoot !== "string" || typeof base.projectionAuthorityDigest !== "string") return undefined;
    return Object.freeze({ ...base, schema: OVERLAY_SCHEMA, markerDigest }) as CoreOverlayMarkerV1;
  } catch { return undefined; }
}

function requireAuthorizedValidationBinding(value: ValidationProcessBindingV2 | undefined, authority: NpmDependencyResidueAuthorityV1): ValidationProcessBindingV2 {
  if (!value || !isValidationBinding(value) || value.runId !== authority.runId || value.phaseId !== authority.phaseId
    || value.taskId !== authority.taskId || value.attemptId !== authority.attemptId || !authority.validationSpecIds.includes(value.validationSpecId)) {
    throw new RalphNpmDependencyProvisioningErrorV1("RALPH_BRIDGE_NPM_EPHEMERAL_MOUNT_FAILED");
  }
  return Object.freeze({ ...value });
}

function validateResidueAuthority(value: NpmDependencyResidueAuthorityV1, specs: readonly ValidationSpecRef[]): void {
  if (!value || ![value.runId, value.phaseId, value.taskId, value.attemptId].every(isSafeIdentity)
    || !Array.isArray(value.validationSpecIds) || !Array.isArray(value.pendingValidationRuns)
    || canonicalJson([...value.validationSpecIds].sort()) !== canonicalJson(specs.map((spec) => spec.validationSpecId).sort())) {
    throw new RalphNpmDependencyProvisioningErrorV1("RALPH_BRIDGE_NPM_AUTHORITY_INVALID");
  }
  for (const id of value.validationSpecIds) if (!isSafeIdentity(id)) throw new RalphNpmDependencyProvisioningErrorV1("RALPH_BRIDGE_NPM_AUTHORITY_INVALID");
  for (const pending of value.pendingValidationRuns) if (!isSafeIdentity(pending.validationSpecId) || !isSafeIdentity(pending.validationRunId) || !value.validationSpecIds.includes(pending.validationSpecId)) throw new RalphNpmDependencyProvisioningErrorV1("RALPH_BRIDGE_NPM_AUTHORITY_INVALID");
}

function isValidationBinding(value: unknown): value is ValidationProcessBindingV2 {
  return isRecord(value) && [value.runId, value.phaseId, value.taskId, value.attemptId, value.validationSpecId, value.validationRunId].every(isSafeIdentity);
}

function sameBinding(left: ValidationProcessBindingV2, right: ValidationProcessBindingV2): boolean {
  return left.runId === right.runId && left.phaseId === right.phaseId && left.taskId === right.taskId && left.attemptId === right.attemptId
    && left.validationSpecId === right.validationSpecId && left.validationRunId === right.validationRunId;
}

async function verifyWorkspaceRoot(input: string): Promise<string> {
  const root = resolve(input);
  if (root !== input || root.includes("\0")) throw new RalphNpmDependencyProvisioningErrorV1("RALPH_BRIDGE_NPM_WORKSPACE_UNSAFE");
  const stats = await lstat(root).catch(() => undefined);
  if (!stats?.isDirectory() || stats.isSymbolicLink() || await realpath(root) !== root) throw new RalphNpmDependencyProvisioningErrorV1("RALPH_BRIDGE_NPM_WORKSPACE_UNSAFE");
  return root;
}

async function readRegularBounded(path: string, maxBytes: number): Promise<Buffer | undefined> {
  const stats = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw new RalphNpmDependencyProvisioningErrorV1("RALPH_BRIDGE_NPM_AUTHORITY_INVALID", error);
  });
  if (!stats) return undefined;
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size < 2 || stats.size > maxBytes) throw new RalphNpmDependencyProvisioningErrorV1("RALPH_BRIDGE_NPM_AUTHORITY_INVALID");
  return readFile(path);
}

function parseJsonRecord(bytes: Buffer, code: NpmDependencyProvisioningErrorCodeV1): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!isRecord(value)) throw new Error("record required");
    return value;
  } catch (error) { throw new RalphNpmDependencyProvisioningErrorV1(code, error); }
}

function dependencyMap(value: unknown): ReadonlyMap<string, string> {
  if (value === undefined) return new Map();
  if (!isRecord(value)) throw new RalphNpmDependencyProvisioningErrorV1("RALPH_BRIDGE_NPM_AUTHORITY_INVALID");
  const result = new Map<string, string>();
  for (const [key, item] of Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) {
    assertPackageName(key);
    if (typeof item !== "string" || item.length === 0 || item.length > 256) throw new RalphNpmDependencyProvisioningErrorV1("RALPH_BRIDGE_NPM_AUTHORITY_INVALID");
    result.set(key, item);
  }
  return result;
}

function assertPackageName(name: string): void {
  if (["__proto__", "constructor", "prototype"].includes(name) || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name) || name.length > 214) throw new RalphNpmDependencyProvisioningErrorV1("RALPH_BRIDGE_NPM_AUTHORITY_INVALID");
}

function assertRegistrySpecifier(value: string): void {
  if (!/^[A-Za-z0-9*<>=~^|.,+\-\s]+$/.test(value) || value.includes("..")) throw new RalphNpmDependencyProvisioningErrorV1("RALPH_BRIDGE_NPM_AUTHORITY_UNSUPPORTED");
}

function isSafeLockPackagePath(path: string): boolean {
  if (!path.startsWith("node_modules/") || path.includes("\\") || path.includes("\0") || path.split("/").includes("..")) return false;
  if (path.split("/").some((part) => part.length === 0 || part === "." || ["__proto__", "constructor", "prototype"].includes(part))) return false;
  const packageName = "(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*";
  return new RegExp(`^node_modules/${packageName}(?:/node_modules/${packageName})*$`).test(path);
}

function isTrustedRegistryUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === "https://registry.npmjs.org" && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

function assertSupportedDependencyCommands(specs: readonly ValidationSpecRef[]): void {
  for (const spec of specs) {
    if (spec.kind !== "COMMAND") continue;
    for (const tool of ["npx", "pnpm", "yarn", "bun"] as const) if (hasCommandToken(spec.instruction, tool)) throw new RalphNpmDependencyProvisioningErrorV1("RALPH_BRIDGE_NPM_AUTHORITY_UNSUPPORTED");
    for (const match of spec.instruction.matchAll(/(?:^|[\s;&|()])npm(?=\s|$)/g)) {
      const suffix = spec.instruction.slice((match.index ?? 0) + match[0].length);
      const verb = /^\s*([A-Za-z-]+)/.exec(suffix)?.[1];
      if (!verb || !["run", "run-script", "test", "start"].includes(verb)) throw new RalphNpmDependencyProvisioningErrorV1("RALPH_BRIDGE_NPM_AUTHORITY_UNSUPPORTED");
    }
  }
}

function hasCommandToken(command: string, token: string): boolean {
  return new RegExp(`(?:^|[\\s;&|()])${token}(?=\\s|$)`).test(command);
}

function npmEnvironment(temporaryRoot: string, homeRoot: string, cacheRoot: string, userConfig: string, globalConfig: string, runtime: QualifiedNodeNpmRuntimeV1): Readonly<NodeJS.ProcessEnv> {
  return Object.freeze({
    HOME: homeRoot,
    CI: "1",
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_CACHE: cacheRoot,
    NPM_CONFIG_COLOR: "false",
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_GLOBALCONFIG: globalConfig,
    NPM_CONFIG_IGNORE_SCRIPTS: "true",
    NPM_CONFIG_REGISTRY: NPM_REGISTRY,
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    NPM_CONFIG_USERCONFIG: userConfig,
    PATH: `${runtime.binRoot}:/usr/bin:/bin`,
    TMPDIR: temporaryRoot,
  });
}

function hasExactCoreNpmOptions(argv: readonly string[], cwd: string): boolean {
  if (argv.length !== 13 || argv[5] !== "--cache" || argv[7] !== "--userconfig" || argv[9] !== "--globalconfig" || argv[11] !== "--registry" || argv[12] !== NPM_REGISTRY) return false;
  const root = resolve(cwd, "..");
  return resolve(argv[6] ?? "") === resolve(root, "cache") && resolve(argv[8] ?? "") === resolve(root, "empty-user-npmrc") && resolve(argv[10] ?? "") === resolve(root, "empty-global-npmrc");
}

function hasExactCoreNpmEnvironment(input: NpmProvisioningProcessInputV1): boolean {
  const root = resolve(input.cwd, "..");
  const expected: NodeJS.ProcessEnv = {
    HOME: resolve(root, "home"),
    CI: "1",
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_CACHE: resolve(root, "cache"),
    NPM_CONFIG_COLOR: "false",
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_GLOBALCONFIG: resolve(root, "empty-global-npmrc"),
    NPM_CONFIG_IGNORE_SCRIPTS: "true",
    NPM_CONFIG_REGISTRY: NPM_REGISTRY,
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    NPM_CONFIG_USERCONFIG: resolve(root, "empty-user-npmrc"),
    PATH: `${input.runtime.binRoot}:/usr/bin:/bin`,
    TMPDIR: root,
  };
  return canonicalJson(input.env) === canonicalJson(expected);
}

function drainBounded(stream: NodeJS.ReadableStream | null, maxBytes: number): void {
  if (!stream) return;
  let seen = 0;
  stream.on("data", (chunk: Buffer | string) => { seen = Math.min(maxBytes, seen + Buffer.byteLength(chunk)); });
}

function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); }
  catch { try { child.kill(signal); } catch { /* already terminated */ } }
}

function processGroupAlive(pid: number): boolean {
  if (process.platform === "win32") return false;
  try { process.kill(-pid, 0); return true; }
  catch (error) { return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function boundedInteger(value: number, minimum: number, maximum: number, code: NpmDependencyProvisioningErrorCodeV1): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new RalphNpmDependencyProvisioningErrorV1(code);
  return value;
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "RALPH_VALIDATION_OPERATION_FAILED";
}

function isSafeIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !value.includes("\0");
}

async function verifyTemporaryBase(input: string): Promise<string> {
  const base = await realpath(resolve(input));
  const stats = await lstat(base);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new RalphNpmDependencyProvisioningErrorV1("RALPH_BRIDGE_NPM_AUTHORITY_INVALID");
  return base;
}

async function removeCoreNpmInfrastructure(infrastructureRoot: string, sessionRoot: string, temporaryBase: string): Promise<void> {
  try {
    if (dirname(infrastructureRoot) !== temporaryBase || dirname(sessionRoot) !== infrastructureRoot || !isDescendant(infrastructureRoot, sessionRoot)) throw new Error("structure");
    await assertCoreOwnedDirectory(infrastructureRoot);
    await assertCoreOwnedDirectory(sessionRoot);
    // Validation receives only node_modules as a bind under synthetic
    // /workspace. The qualified npm installer ran with lifecycle scripts
    // disabled. Consequently no untrusted process can replace the 0700
    // session or its 0700 parent during this checked removal.
    await rm(sessionRoot, { recursive: true, force: false });
    const remaining = await lstat(infrastructureRoot);
    if (!remaining.isDirectory() || remaining.isSymbolicLink() || await realpath(infrastructureRoot) !== infrastructureRoot) throw new Error("infrastructure");
    await rm(infrastructureRoot, { recursive: true, force: false });
  } catch (error) {
    throw new RalphNpmDependencyProvisioningErrorV1("RALPH_BRIDGE_NPM_CLEANUP_FAILED", error);
  }
}

async function assertCoreOwnedDirectory(path: string): Promise<void> {
  const stats = await lstat(path);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!stats.isDirectory() || stats.isSymbolicLink() || await realpath(path) !== path || (stats.mode & 0o077) !== 0 || (uid !== undefined && stats.uid !== uid)) throw new Error("ownership");
}

function isDescendant(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value.length > 0 && value !== ".." && !value.startsWith(`..${sep}`);
}

async function pathExists(path: string): Promise<boolean> {
  return lstat(path).then(() => true).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
