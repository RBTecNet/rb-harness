import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  NpmDependencyProvisionerV1,
  RalphNpmDependencyOperationErrorV1,
  HostNpmProvisioningProcessRunnerV1,
  deriveWorkspaceDelta,
  inspectNpmAuthorityV1,
  snapshotRalphWorkspace,
  type NpmDependencyProvisioningSessionV1,
  type NpmProvisioningProcessInputV1,
  type NpmProvisioningProcessRunnerV1,
} from "../../src/vnext/ralph-bridge/index.js";
import { fingerprintWorkspace } from "../../src/vnext/ralph-runtime/fingerprint.js";
import { deriveCodexWorkspaceDeltaEntriesV2 } from "../../src/vnext/ralph-runtime/operational-m5b/codex-delta.js";
import { inspectQualifiedNodeNpmRuntimeV1 } from "../../src/vnext/ralph-runtime/node-npm-runtime.js";
import { sha256Canonical } from "../../src/vnext/ralph-runtime/hashing.js";
import {
  bindValidationProjectionRunV1,
  createValidationProcessPolicyV2,
  createValidationProjectionV1,
  type ValidationProcessInputV2,
} from "../../src/vnext/ralph-runtime/operational-d/index.js";
import type { ValidationSpecRef } from "../../src/vnext/ralph-runtime/operational-v2/index.js";
import { createWorkspaceManifestV2 } from "../../src/vnext/ralph-runtime/operational-b4/workspace-manifest.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Ralph bridge Core-owned npm dependency provisioning", () => {
  it("provisions a locked npm project before validation and exposes installed local binaries only ephemerally", async () => {
    const root = await npmProject();
    const baselineFingerprint = await fingerprintWorkspace(root, { scopePaths: ["**"], coversPaths: ["**"] });
    const baselinePublication = await snapshotRalphWorkspace(root, ["**"]);
    const calls: NpmProvisioningProcessInputV1[] = [];
    let lifecycleExecuted = false;
    const provisioner = new NpmDependencyProvisionerV1({
      processRunner: fakeInstaller(calls, () => { lifecycleExecuted = true; }),
    });

    const session = await provisioner.prepare({ workspaceRoot: root, validationSpecs: commandSpecs(), residueAuthority: residueAuthority() });
    expect(session.disposition).toBe("PROVISIONED");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.executable).toBe(calls[0]?.runtime.nodeExecutablePath);
    expect(calls[0]?.argv[0]).toBe(calls[0]?.runtime.npmCliPath);
    expect(calls[0]?.runtime).toMatchObject({ nodeVersion: "v20.19.5", npmVersion: "10.8.2" });
    expect(calls[0]?.argv.slice(1, 5)).toEqual(["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
    expect(calls[0]?.argv).not.toContain("install");
    expect(calls[0]?.argv).toContain("https://registry.npmjs.org/");
    expect(Object.keys(calls[0]?.env ?? {})).not.toEqual(expect.arrayContaining(["NPM_TOKEN", "NODE_AUTH_TOKEN", "CODEX_HOME", "OPENAI_API_KEY"]));
    expect(Object.keys(calls[0] ?? {}).sort()).toEqual(["argv", "cwd", "env", "executable", "killGraceMs", "maxOutputBytes", "runtime", "timeoutMs"]);
    expect(lifecycleExecuted).toBe(false);

    const validation = await runProvisionedValidation(session, root);
    expect(validation.infrastructureStatus).toBe("NONE");
    expect(validation.exitCode, `${validation.stderr}\n${validation.stdout}`).toBe(0);
    expect(validation.stdout).toContain("LOCAL_BINARY_FOUND");
    await expect(readFile(resolve(root, "node_modules/.bin/local-check"))).rejects.toMatchObject({ code: "ENOENT" });
    await session.cleanup();

    const finalFingerprint = await fingerprintWorkspace(root, { scopePaths: ["**"], coversPaths: ["**"] });
    const finalPublication = await snapshotRalphWorkspace(root, ["**"]);
    expect(finalFingerprint.fingerprintDigest).toBe(baselineFingerprint.fingerprintDigest);
    expect(deriveWorkspaceDelta(baselinePublication, finalPublication)).toEqual([]);
  }, 30_000);

  it("fails closed on provisioning failure and never runs install or lifecycle scripts", async () => {
    const root = await npmProject();
    let validationCalls = 0;
    const provisioner = new NpmDependencyProvisionerV1({
      processRunner: {
        run: async (input) => {
          expect(input.argv.slice(1, 5)).toEqual(["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
          expect(input.argv).not.toContain("install");
          return { exitCode: 1, signal: null, timedOut: false, supervisionFailed: false };
        },
      },
      validationSupervisor: { run: async () => { validationCalls += 1; throw new Error("must not validate"); } },
    });
    await expect(provisioner.prepare({ workspaceRoot: root, validationSpecs: commandSpecs(), residueAuthority: residueAuthority() }))
      .rejects.toMatchObject({ code: "RALPH_BRIDGE_NPM_PROVISIONING_FAILED" });
    expect(validationCalls).toBe(0);
    await expect(readFile(resolve(root, "node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses npm ci with lifecycle scripts disabled in the real host-owned process boundary", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rb-ralph-npm-ignore-scripts-"));
    roots.push(root);
    const home = resolve(root, "home");
    const cache = resolve(root, "cache");
    const packageRoot = resolve(root, "package");
    await mkdir(home);
    await mkdir(cache);
    await mkdir(packageRoot);
    await writeFile(resolve(packageRoot, "package.json"), `${JSON.stringify({
      name: "ignore-scripts-fixture",
      version: "1.0.0",
      private: true,
      scripts: { preinstall: "node -e \"require('node:fs').writeFileSync('lifecycle-ran', 'unsafe')\"" },
    })}\n`);
    await writeFile(resolve(packageRoot, "package-lock.json"), `${JSON.stringify({
      name: "ignore-scripts-fixture",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: { "": { name: "ignore-scripts-fixture", version: "1.0.0" } },
    })}\n`);
    const runtime = await inspectQualifiedNodeNpmRuntimeV1();
    const userConfig = resolve(root, "empty-user-npmrc");
    const globalConfig = resolve(root, "empty-global-npmrc");
    await writeFile(userConfig, "");
    await writeFile(globalConfig, "");
    const result = await new HostNpmProvisioningProcessRunnerV1().run({
      executable: runtime.nodeExecutablePath,
      runtime,
      argv: [runtime.npmCliPath, "ci", "--ignore-scripts", "--no-audit", "--no-fund", "--cache", cache, "--userconfig", userConfig, "--globalconfig", globalConfig, "--registry", "https://registry.npmjs.org/"],
      cwd: packageRoot,
      env: {
        HOME: home,
        CI: "1",
        NPM_CONFIG_AUDIT: "false",
        NPM_CONFIG_CACHE: cache,
        NPM_CONFIG_COLOR: "false",
        NPM_CONFIG_FUND: "false",
        NPM_CONFIG_GLOBALCONFIG: globalConfig,
        NPM_CONFIG_IGNORE_SCRIPTS: "true",
        NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
        NPM_CONFIG_UPDATE_NOTIFIER: "false",
        NPM_CONFIG_USERCONFIG: userConfig,
        PATH: `${runtime.binRoot}:/usr/bin:/bin`,
        TMPDIR: root,
      },
      timeoutMs: 30_000,
      killGraceMs: 1_000,
      maxOutputBytes: 16_384,
    });
    expect(result).toMatchObject({ exitCode: 0, signal: null, timedOut: false, supervisionFailed: false });
    await expect(readFile(resolve(packageRoot, "lifecycle-ran"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it.each([
    ["missing lock", async (root: string) => rm(resolve(root, "package-lock.json")), "RALPH_BRIDGE_NPM_AUTHORITY_MISSING"],
    ["workspace npm config", async (root: string) => writeFile(resolve(root, ".npmrc"), "registry=https://attacker.invalid\n"), "RALPH_BRIDGE_NPM_AUTHORITY_UNSUPPORTED"],
    ["inconsistent lock", async (root: string) => {
      const lock = JSON.parse(await readFile(resolve(root, "package-lock.json"), "utf8"));
      lock.packages[""].devDependencies["local-check"] = "2.0.0";
      await writeFile(resolve(root, "package-lock.json"), `${JSON.stringify(lock)}\n`);
    }, "RALPH_BRIDGE_NPM_AUTHORITY_INCONSISTENT"],
    ["non-registry resolution", async (root: string) => {
      const lock = JSON.parse(await readFile(resolve(root, "package-lock.json"), "utf8"));
      lock.packages["node_modules/local-check"].resolved = "https://attacker.invalid/local-check.tgz";
      await writeFile(resolve(root, "package-lock.json"), `${JSON.stringify(lock)}\n`);
    }, "RALPH_BRIDGE_NPM_AUTHORITY_UNSUPPORTED"],
    ["non-registry nested specifier", async (root: string) => {
      const lock = JSON.parse(await readFile(resolve(root, "package-lock.json"), "utf8"));
      lock.packages["node_modules/local-check"].dependencies = { payload: "https://attacker.invalid/payload.tgz" };
      await writeFile(resolve(root, "package-lock.json"), `${JSON.stringify(lock)}\n`);
    }, "RALPH_BRIDGE_NPM_AUTHORITY_UNSUPPORTED"],
  ])("rejects unsupported dependency authority: %s", async (_label, mutate, code) => {
    const root = await npmProject();
    await mutate(root);
    await expect(inspectNpmAuthorityV1(root, commandSpecs())).rejects.toMatchObject({ code });
  });

  it("accepts only lockfile v3 and rejects a malicious legacy v2 dependency table", async () => {
    const root = await npmProject();
    const lock = JSON.parse(await readFile(resolve(root, "package-lock.json"), "utf8"));
    lock.lockfileVersion = 2;
    lock.dependencies = { "local-check": { version: "1.0.0", resolved: "https://evil.example/payload.tgz", integrity: "sha512-YWJj" } };
    await writeFile(resolve(root, "package-lock.json"), `${JSON.stringify(lock)}\n`);
    await expect(inspectNpmAuthorityV1(root, commandSpecs())).rejects.toMatchObject({ code: "RALPH_BRIDGE_NPM_AUTHORITY_UNSUPPORTED" });
  });

  it("binds packageManager authority to the qualified canonical npm 10.8.2 runtime", async () => {
    const root = await npmProject();
    const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
    manifest.packageManager = "npm@10.8.1";
    await writeFile(resolve(root, "package.json"), `${JSON.stringify(manifest)}\n`);
    await expect(inspectNpmAuthorityV1(root, commandSpecs())).rejects.toMatchObject({ code: "RALPH_BRIDGE_NPM_AUTHORITY_UNSUPPORTED" });
  });

  it.each(["__proto__", "constructor", "prototype", "Bad Name", "@scope/"])("rejects every malformed dependency key without prototype-map elision: %s", async (name) => {
    const root = await npmProject();
    const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
    const lock = JSON.parse(await readFile(resolve(root, "package-lock.json"), "utf8"));
    manifest.devDependencies = JSON.parse(`{${JSON.stringify(name)}:"1.0.0"}`);
    lock.packages[""].devDependencies = JSON.parse(`{${JSON.stringify(name)}:"1.0.0"}`);
    await writeFile(resolve(root, "package.json"), `${JSON.stringify(manifest)}\n`);
    await writeFile(resolve(root, "package-lock.json"), `${JSON.stringify(lock)}\n`);
    await expect(inspectNpmAuthorityV1(root, commandSpecs())).rejects.toMatchObject({ code: "RALPH_BRIDGE_NPM_AUTHORITY_INVALID" });
  });

  it.each(["npx tsc", "pnpm test", "yarn test", "bun test", "npm install", "npm exec tsc"])("fails closed for unsupported dependency execution command: %s", async (instruction) => {
    const root = await npmProject();
    await expect(inspectNpmAuthorityV1(root, [{ ...commandSpecs()[0]!, instruction }])).rejects.toMatchObject({ code: "RALPH_BRIDGE_NPM_AUTHORITY_UNSUPPORTED" });
  });

  it.each([".cache", ".vite"])("removes tool-created node_modules/%s as Core-owned ephemeral infrastructure", async (cacheName) => {
    const root = await npmProject();
    const provisioner = new NpmDependencyProvisionerV1({
      processRunner: fakeInstaller([], () => undefined),
      validationSupervisor: { run: async (input) => {
        await mkdir(resolve(input.cwd, "node_modules", cacheName), { recursive: true });
        await writeFile(resolve(input.cwd, "node_modules", cacheName, "cache.bin"), "cache");
        return processResult(0);
      } },
    });
    const session = await provisioner.prepare({ workspaceRoot: root, validationSpecs: commandSpecs(), residueAuthority: residueAuthority() });
    await expect(runProvisionedValidation(session, root, { command: "npm test" })).resolves.toMatchObject({ exitCode: 0 });
    await expect(lstat(resolve(root, "node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
    await session.cleanup();
  });

  it.each([
    ["semantic failure", async () => processResult(1)],
    ["infrastructure timeout", async () => processResult(null, "TIMEOUT")],
  ] as const)("cleans the Core overlay after %s", async (_label, delegateRun) => {
    const root = await npmProject();
    const provisioner = new NpmDependencyProvisionerV1({ processRunner: fakeInstaller([], () => undefined), validationSupervisor: { run: delegateRun } });
    const session = await provisioner.prepare({ workspaceRoot: root, validationSpecs: commandSpecs(), residueAuthority: residueAuthority() });
    await runProvisionedValidation(session, root, { command: "npm test" });
    await expect(lstat(resolve(root, "node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
    await session.cleanup();
  });

  it("cleans the Core overlay after a real sandbox timeout", async () => {
    const root = await npmProject();
    const provisioner = new NpmDependencyProvisionerV1({ processRunner: fakeInstaller([], () => undefined) });
    const session = await provisioner.prepare({ workspaceRoot: root, validationSpecs: commandSpecs(), residueAuthority: residueAuthority() });
    const result = await runProvisionedValidation(session, root, {
      command: "sleep 1",
      policy: createValidationProcessPolicyV2({ timeoutMs: 30, killGraceMs: 20 }),
    });
    expect(result).toMatchObject({ infrastructureStatus: "TIMEOUT", timedOut: true });
    await expect(lstat(resolve(root, "node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
    await session.cleanup();
  });

  it("cleans after an exception and preserves a primary exception when cleanup also fails", async () => {
    const first = await npmProject();
    const primary = Object.assign(new Error("primary"), { code: "D_VALIDATION_PRIMARY_FAILURE" });
    const normal = new NpmDependencyProvisionerV1({ processRunner: fakeInstaller([], () => undefined), validationSupervisor: { run: async () => { throw primary; } } });
    const normalSession = await normal.prepare({ workspaceRoot: first, validationSpecs: commandSpecs(), residueAuthority: residueAuthority() });
    await expect(runProvisionedValidation(normalSession, first, { command: "npm test" })).rejects.toBe(primary);
    await expect(lstat(resolve(first, "node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
    await normalSession.cleanup();

    const second = await npmProject();
    const hostile = new NpmDependencyProvisionerV1({ processRunner: fakeInstaller([], () => undefined), validationSupervisor: { run: async (input) => {
      await rm(resolve(input.cwd, "node_modules"), { recursive: true, force: true });
      throw primary;
    } } });
    const hostileSession = await hostile.prepare({ workspaceRoot: second, validationSpecs: commandSpecs(), residueAuthority: residueAuthority() });
    const failure = await runProvisionedValidation(hostileSession, second, { command: "npm test" }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RalphNpmDependencyOperationErrorV1);
    expect(failure).toMatchObject({ code: "D_VALIDATION_PRIMARY_FAILURE", cleanupCode: "RALPH_BRIDGE_NPM_CLEANUP_FAILED" });
    await expect(hostileSession.cleanup()).rejects.toMatchObject({ code: "RALPH_BRIDGE_NPM_CLEANUP_FAILED" });
  });

  it("preserves semantic validation failure and reports cleanup failure as secondary", async () => {
    const root = await npmProject();
    const provisioner = new NpmDependencyProvisionerV1({ processRunner: fakeInstaller([], () => undefined), validationSupervisor: { run: async (input) => {
      await rm(resolve(input.cwd, "node_modules"), { recursive: true, force: true });
      return processResult(1);
    } } });
    const session = await provisioner.prepare({ workspaceRoot: root, validationSpecs: commandSpecs(), residueAuthority: residueAuthority() });
    const result = await runProvisionedValidation(session, root, { command: "npm test" });
    expect(result).toMatchObject({ exitCode: 1, infrastructureStatus: "NONE" });
    expect(result.stderr).not.toContain("RALPH_BRIDGE_NPM_CLEANUP_FAILED");
    expect(result).toMatchObject({ infrastructureDiagnostic: "RALPH_BRIDGE_NPM_CLEANUP_FAILED" });
    await expect(session.cleanup()).rejects.toMatchObject({ code: "RALPH_BRIDGE_NPM_CLEANUP_FAILED" });
  });

  it("rejects even a forged stale marker in the candidate because Core markers live only outside product authority", async () => {
    const root = await npmProject();
    const binding = validationBinding();
    const base = { schema: "rb-harness-core-npm-overlay/v1", ...binding };
    await mkdir(resolve(root, "node_modules/.vite"), { recursive: true });
    await writeFile(resolve(root, "node_modules/.rb-harness-core-npm-overlay-v1.json"), `${JSON.stringify({ ...base, markerDigest: sha256Canonical(base) })}\n`);
    await writeFile(resolve(root, "node_modules/.vite/residue"), "cache");
    const provisioner = new NpmDependencyProvisionerV1({ processRunner: fakeInstaller([], () => undefined) });
    await expect(provisioner.prepare({
      workspaceRoot: root,
      validationSpecs: commandSpecs(),
      residueAuthority: residueAuthority([{ validationSpecId: binding.validationSpecId, validationRunId: binding.validationRunId }]),
    })).rejects.toMatchObject({ code: "RALPH_BRIDGE_NPM_WORKSPACE_UNSAFE" });
    expect(await readFile(resolve(root, "node_modules/.vite/residue"), "utf8")).toBe("cache");
  });

  it("does not silently remove node_modules introduced by the Executor", async () => {
    const root = await npmProject();
    await mkdir(resolve(root, "node_modules/executor-owned"), { recursive: true });
    await writeFile(resolve(root, "node_modules/executor-owned/proof"), "provider mutation");
    const provisioner = new NpmDependencyProvisionerV1({ processRunner: fakeInstaller([], () => undefined) });
    await expect(provisioner.prepare({ workspaceRoot: root, validationSpecs: commandSpecs(), residueAuthority: residueAuthority() }))
      .rejects.toMatchObject({ code: "RALPH_BRIDGE_NPM_WORKSPACE_UNSAFE" });
    expect(await readFile(resolve(root, "node_modules/executor-owned/proof"), "utf8")).toBe("provider mutation");
  });

  it("ignores host infrastructure but fails closed if package infrastructure reaches a workspace publication candidate", async () => {
    const root = await npmProject();
    await mkdir(resolve(root, "node_modules/pkg"), { recursive: true });
    await mkdir(resolve(root, ".npm/cache"), { recursive: true });
    await writeFile(resolve(root, "node_modules/pkg/index.js"), "generated dependency\n");
    await writeFile(resolve(root, ".npm/cache/item"), "cache\n");
    await expect(snapshotRalphWorkspace(root, ["**"])).rejects.toMatchObject({ code: "RALPH_BRIDGE_PACKAGE_INFRASTRUCTURE_FORBIDDEN" });
  });

  it.each(["node_modules/pkg/index.js", ".npm/cache/item"])("rejects provider package infrastructure before its isolated delta can be published: %s", (path) => {
    expect(() => deriveCodexWorkspaceDeltaEntriesV2({
      stagingWorkspace: "/tmp/not-observed-by-derivation",
      baseline: [],
      final: [{ path, kind: "file", mode: 0o644, size: 1, contentHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }],
      scope: "**",
      covers: "**",
    })).toThrow(/M5B_DELTA_PATH_FORBIDDEN/);
  });
});

async function npmProject(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "rb-ralph-npm-provisioning-"));
  roots.push(root);
  const packageJson = {
    name: "fixture-project",
    version: "1.0.0",
    private: true,
    scripts: {
      preinstall: "node -e \"require('node:fs').writeFileSync('lifecycle-ran', 'unsafe')\"",
      typecheck: "local-check",
    },
    devDependencies: { "local-check": "1.0.0" },
  };
  const packageLock = {
    name: "fixture-project",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: "fixture-project", version: "1.0.0", devDependencies: { "local-check": "1.0.0" } },
      "node_modules/local-check": {
        version: "1.0.0",
        resolved: "https://registry.npmjs.org/local-check/-/local-check-1.0.0.tgz",
        integrity: "sha512-YWJj",
      },
    },
  };
  await writeFile(resolve(root, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
  await writeFile(resolve(root, "package-lock.json"), `${JSON.stringify(packageLock, null, 2)}\n`);
  return root;
}

function commandSpecs(): readonly ValidationSpecRef[] {
  return [{
    validationSpecId: "T001:validation:1",
    ordinal: 1,
    kind: "COMMAND",
    instruction: "npm run typecheck",
    digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    sourceTaskId: "T001",
    sourcePlanIdentity: "plan",
  }];
}

function residueAuthority(pendingValidationRuns: readonly { validationSpecId: string; validationRunId: string }[] = []) {
  return {
    runId: "run-fixture",
    phaseId: "phase-fixture",
    taskId: "T001",
    attemptId: "attempt-fixture",
    validationSpecIds: ["T001:validation:1"],
    pendingValidationRuns,
  } as const;
}

function validationBinding() {
  return {
    runId: "run-fixture",
    phaseId: "phase-fixture",
    taskId: "T001",
    attemptId: "attempt-fixture",
    validationSpecId: "T001:validation:1",
    validationRunId: "validation-run-fixture",
  } as const;
}

let projectionOrdinal = 0;

async function runProvisionedValidation(
  session: NpmDependencyProvisioningSessionV1,
  candidateRoot: string,
  overrides: Partial<Pick<ValidationProcessInputV2, "command" | "policy" | "signal">> = { command: "npm run typecheck" },
) {
  const ordinal = ++projectionOrdinal;
  const command = overrides.command ?? "npm run typecheck";
  const baseSpec = commandSpecs()[0]!;
  const spec = { ...baseSpec, instruction: command, digest: sha256Canonical({ command, ordinal }) };
  const binding = validationBinding();
  const manifest = createWorkspaceManifestV2({
    runId: binding.runId,
    phaseId: binding.phaseId,
    taskId: binding.taskId,
    attemptId: binding.attemptId,
    invocationId: `npm-projection-invocation-${ordinal}`,
  }, await fingerprintWorkspace(candidateRoot));
  const projection = await createValidationProjectionV1({
    canonicalCandidateRoot: candidateRoot,
    boundaryManifest: manifest,
    evidenceCaptureId: `npm-projection-evidence-${ordinal}`,
    evidenceDigest: sha256Canonical({ evidence: ordinal }),
    validationSpecs: [spec],
  });
  try {
    return await session.validationSupervisor.run({
      ...overrides,
      command,
      cwd: projection.authority.projectionRoot,
      expectedProjectRoot: projection.authority.projectionRoot,
      validationBinding: binding,
      validationProjection: bindValidationProjectionRunV1(projection.authority, { ...binding, validationSpecDigest: spec.digest }),
    });
  } finally { await projection.cleanup(); }
}

function fakeInstaller(calls: NpmProvisioningProcessInputV1[], onLifecycle: () => void): NpmProvisioningProcessRunnerV1 {
  return {
    run: async (input) => {
      calls.push(input);
      if (!input.argv.includes("--ignore-scripts")) onLifecycle();
      const bin = resolve(input.cwd, "node_modules/.bin");
      await mkdir(bin, { recursive: true });
      const executable = resolve(bin, "local-check");
      await writeFile(executable, "#!/bin/sh\necho LOCAL_BINARY_FOUND\n");
      await chmod(executable, 0o755);
      return { exitCode: 0, signal: null, timedOut: false, supervisionFailed: false };
    },
  };
}

function processResult(exitCode: number | null, infrastructureStatus: "NONE" | "TIMEOUT" = "NONE") {
  return {
    stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false,
    exitCode, signal: null, infrastructureStatus,
    timedOut: infrastructureStatus === "TIMEOUT", cancelled: false,
    startedAt: "2026-09-12T00:00:00.000Z", finishedAt: "2026-09-12T00:00:01.000Z",
  } as const;
}
