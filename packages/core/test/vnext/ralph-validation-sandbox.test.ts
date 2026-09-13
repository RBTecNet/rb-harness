import { createServer } from "node:http";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ValidationProcessSupervisorV2,
  bindValidationProjectionRunV1,
  createValidationProjectionV1,
  createValidationProcessPolicyV2,
  runValidationCommandV2,
} from "../../src/vnext/ralph-runtime/operational-d/index.js";
import { fingerprintWorkspace } from "../../src/vnext/ralph-runtime/fingerprint.js";
import { createWorkspaceManifestV2 } from "../../src/vnext/ralph-runtime/operational-b4/workspace-manifest.js";
import { sha256Canonical } from "../../src/vnext/ralph-runtime/hashing.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Ralph Operational-D Core-owned Linux validation sandbox", () => {
  it("isolates host files, HOME, and loopback while allowing workspace outputs and provisioned local bins", async () => {
    const fixtureRoot = await mkdtemp(resolve(tmpdir(), "rb-validation-sandbox-"));
    roots.push(fixtureRoot);
    const workspace = resolve(fixtureRoot, "workspace");
    const provisioned = resolve(fixtureRoot, "provisioned-node-modules");
    const outsideSecret = resolve(fixtureRoot, "outside-secret.txt");
    const outsideWrite = resolve(fixtureRoot, "outside-write.txt");
    await mkdir(workspace);
    await mkdir(resolve(provisioned, ".bin"), { recursive: true });
    await writeFile(outsideSecret, "fixture-secret-never-visible");
    await writeFile(outsideWrite, "original");
    const localBin = resolve(provisioned, ".bin", "local-check");
    await writeFile(localBin, "#!/bin/sh\necho LOCAL_BIN_OK\n");
    await chmod(localBin, 0o755);
    await writeFile(resolve(workspace, "package.json"), `${JSON.stringify({
      name: "qualified-nested-npm-fixture",
      version: "1.0.0",
      private: true,
      scripts: {
        clean: "node -e \"require('node:fs').writeFileSync('clean-ran.txt','CLEAN_OK\\\\n')\"",
        build: "npm --version > package-script-npm-version.txt && npm run clean && node -e \"require('node:fs').writeFileSync('build-ran.txt','BUILD_OK\\\\n')\"",
        pathcheck: "PATH=/usr/bin:/bin npm --version > manipulated-path-npm-version.txt",
      },
    }, null, 2)}\n`);
    const manifest = createWorkspaceManifestV2({
      runId: "sandbox-run", phaseId: "sandbox-phase", taskId: "sandbox-task", attemptId: "sandbox-attempt", invocationId: "sandbox-invocation",
    }, await fingerprintWorkspace(workspace));
    const spec = {
      validationSpecId: "sandbox-spec", ordinal: 1, kind: "COMMAND" as const, instruction: "sandbox",
      digest: sha256Canonical({ spec: "sandbox" }), sourceTaskId: "sandbox-task", sourcePlanIdentity: "sandbox-plan",
    };
    const projection = await createValidationProjectionV1({
      canonicalCandidateRoot: workspace,
      boundaryManifest: manifest,
      evidenceCaptureId: "sandbox-evidence",
      evidenceDigest: sha256Canonical({ evidence: "sandbox" }),
      validationSpecs: [spec],
    });
    const mountpoint = resolve(projection.authority.projectionRoot, "node_modules");
    await mkdir(mountpoint);
    const validationBinding = {
      runId: "sandbox-run", phaseId: "sandbox-phase", taskId: "sandbox-task", attemptId: "sandbox-attempt",
      validationSpecId: "sandbox-spec", validationRunId: "sandbox-validation-run",
    };
    const validationProjection = bindValidationProjectionRunV1(projection.authority, { ...validationBinding, validationSpecDigest: spec.digest });

    let requests = 0;
    const server = createServer((_request, response) => { requests += 1; response.end("host-service"); });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture server did not bind");
    try {
      const command = [
        `if cat ${shellQuote(outsideSecret)} >/dev/null 2>&1; then exit 21; fi`,
        `printf sandbox-only > ${shellQuote(outsideWrite)} 2>/dev/null || true`,
        "test \"$HOME\" = /tmp/rb-validation-home",
        "test ! -e /home/bruno",
        "test \"$(pwd)\" = /workspace",
        "test \"$(command -v node)\" = /opt/rb-validation-bin/node",
        "test \"$(command -v npm)\" = /opt/rb-validation-bin/npm",
        "npm --version > npm-version.txt",
        "sh -c 'npm --version' > nested-npm-version.txt",
        "npm run build",
        "npm run pathcheck",
        "test \"$(/usr/bin/npm --version)\" = 10.8.2",
        "if printf overwritten > /opt/rb-validation-bin/npm 2>/dev/null; then exit 26; fi",
        "if rm -f /opt/rb-validation-bin/npm 2>/dev/null; then exit 27; fi",
        "test ! -e .rb/provider-control",
        "if touch .rb/provider-control 2>/dev/null; then exit 23; fi",
        "if touch .rb-harness/provider-control 2>/dev/null; then exit 24; fi",
        "if touch .git/provider-control 2>/dev/null; then exit 25; fi",
        `node -e 'fetch("http://127.0.0.1:${address.port}/").then(() => process.exit(22), () => process.exit(0))'`,
        "mkdir -p dist",
        "local-check > dist/local-bin.txt",
      ].join(" && ");
      const result = await runValidationCommandV2({
        command,
        cwd: projection.authority.projectionRoot,
        expectedProjectRoot: projection.authority.projectionRoot,
        sandboxWritableMounts: [{ source: provisioned, destination: mountpoint }],
        validationBinding,
        validationProjection,
        supervisor: new ValidationProcessSupervisorV2({ policy: createValidationProcessPolicyV2({ timeoutMs: 5_000 }) }),
      });
      expect(result.infrastructureStatus).toBe("NONE");
      expect(result.exitCode, `${result.stderr}\n${result.stdout}`).toBe(0);
      expect(await readFile(resolve(projection.authority.projectionRoot, "dist/local-bin.txt"), "utf8")).toBe("LOCAL_BIN_OK\n");
      expect(await readFile(resolve(projection.authority.projectionRoot, "npm-version.txt"), "utf8")).toBe("10.8.2\n");
      expect(await readFile(resolve(projection.authority.projectionRoot, "nested-npm-version.txt"), "utf8")).toBe("10.8.2\n");
      expect(await readFile(resolve(projection.authority.projectionRoot, "package-script-npm-version.txt"), "utf8")).toBe("10.8.2\n");
      expect(await readFile(resolve(projection.authority.projectionRoot, "manipulated-path-npm-version.txt"), "utf8")).toBe("10.8.2\n");
      expect(await readFile(resolve(projection.authority.projectionRoot, "clean-ran.txt"), "utf8")).toBe("CLEAN_OK\n");
      expect(await readFile(resolve(projection.authority.projectionRoot, "build-ran.txt"), "utf8")).toBe("BUILD_OK\n");
      await expect(readFile(resolve(workspace, "dist/local-bin.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(resolve(workspace, "build-ran.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(outsideSecret, "utf8")).toBe("fixture-secret-never-visible");
      expect(await readFile(outsideWrite, "utf8")).toBe("original");
      expect(requests).toBe(0);

      const failingBinding = { ...validationBinding, validationRunId: "sandbox-validation-run-fail" };
      const failingAuthority = bindValidationProjectionRunV1(projection.authority, { ...failingBinding, validationSpecDigest: spec.digest });
      const semanticFailure = await runValidationCommandV2({
        command: "exit 7",
        cwd: projection.authority.projectionRoot,
        expectedProjectRoot: projection.authority.projectionRoot,
        validationBinding: failingBinding,
        validationProjection: failingAuthority,
        supervisor: new ValidationProcessSupervisorV2({ policy: createValidationProcessPolicyV2({ timeoutMs: 5_000 }) }),
      });
      expect(semanticFailure).toMatchObject({ infrastructureStatus: "NONE", exitCode: 7 });
    } finally {
      await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
      await projection.cleanup();
    }
  });

  it("preserves authoritative modes and symlinks without exposing their host targets, and rejects missing, foreign, or stale projection authority", async () => {
    const fixtureRoot = await mkdtemp(resolve(tmpdir(), "rb-validation-authority-"));
    roots.push(fixtureRoot);
    const candidate = resolve(fixtureRoot, "candidate");
    const hostSecret = resolve(fixtureRoot, "host-secret.txt");
    await mkdir(candidate);
    await writeFile(resolve(candidate, "tool.sh"), "#!/bin/sh\necho TOOL_OK\n");
    await chmod(resolve(candidate, "tool.sh"), 0o751);
    await writeFile(hostSecret, "HOST_SECRET\n");
    await symlink(hostSecret, resolve(candidate, "escape-link"));
    const binding = { runId: "authority-run", phaseId: "authority-phase", taskId: "authority-task", attemptId: "authority-attempt", invocationId: "authority-invocation" } as const;
    const manifest = createWorkspaceManifestV2(binding, await fingerprintWorkspace(candidate));
    const spec = {
      validationSpecId: "authority-spec", ordinal: 1, kind: "COMMAND" as const, instruction: "authority",
      digest: sha256Canonical({ spec: "authority" }), sourceTaskId: binding.taskId, sourcePlanIdentity: "authority-plan",
    };
    const projection = await createValidationProjectionV1({
      canonicalCandidateRoot: candidate,
      boundaryManifest: manifest,
      evidenceCaptureId: "authority-evidence",
      evidenceDigest: sha256Canonical({ evidence: "authority" }),
      validationSpecs: [spec],
    });
    const validationBinding = {
      runId: binding.runId, phaseId: binding.phaseId, taskId: binding.taskId, attemptId: binding.attemptId,
      validationSpecId: spec.validationSpecId, validationRunId: "authority-validation-run",
    };
    const runAuthority = bindValidationProjectionRunV1(projection.authority, { ...validationBinding, validationSpecDigest: spec.digest });
    expect((await stat(resolve(projection.authority.projectionRoot, "tool.sh"))).mode & 0o777).toBe(0o751);
    expect(await readlink(resolve(projection.authority.projectionRoot, "escape-link"))).toBe(hostSecret);
    expect((await stat(projection.authority.infrastructureRoot)).mode & 0o777).toBe(0o700);
    expect((await stat(projection.authority.sessionRoot)).mode & 0o777).toBe(0o700);

    const supervisor = new ValidationProcessSupervisorV2({ policy: createValidationProcessPolicyV2({ timeoutMs: 5_000 }) });
    const validInput = {
      command: "./tool.sh && if cat escape-link >/dev/null 2>&1; then exit 31; fi",
      cwd: projection.authority.projectionRoot,
      expectedProjectRoot: projection.authority.projectionRoot,
      validationBinding,
      validationProjection: runAuthority,
      supervisor,
    };
    await expect(runValidationCommandV2(validInput)).resolves.toMatchObject({ infrastructureStatus: "NONE", exitCode: 0 });
    await expect(runValidationCommandV2({ ...validInput, validationProjection: undefined })).rejects.toMatchObject({ code: "D_VALIDATION_PROJECTION_INVALID" });
    await expect(runValidationCommandV2({ ...validInput, validationProjection: { ...runAuthority } as never })).rejects.toMatchObject({ code: "D_VALIDATION_PROJECTION_INVALID" });
    const infrastructureRoot = projection.authority.infrastructureRoot;
    await projection.cleanup();
    await expect(lstat(infrastructureRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(runValidationCommandV2(validInput)).rejects.toMatchObject({ code: "D_VALIDATION_PROJECTION_INVALID" });
  });
});

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
