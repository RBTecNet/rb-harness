/**
 * The Node.js prerequisite gate for `npm run install:user`.
 *
 * An operator on an unsupported Node must be told what to do in plain words
 * and must never reach the build, the npm install, or the RB Codex runtime
 * download. The end-to-end case below runs the real installer with an empty
 * PATH, so if the gate ever stopped firing the run would fail loudly instead
 * of quietly installing or downloading anything.
 */

import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertSupportedNodeVersion,
  evaluateNodeSupport,
  formatUnsupportedNodeMessage,
  parseRequiredMajor,
  parseRuntimeMajor,
  readSupportedNodeRange,
  SIMULATED_NODE_VERSION_VARIABLE,
} from "../../../scripts/node-preflight.mjs";

const repositoryRoot = resolve(process.cwd(), "../..");
const installer = resolve(repositoryRoot, "scripts/install-user.mjs");
const preflight = resolve(repositoryRoot, "scripts/node-preflight.mjs");

const UNSUPPORTED_MESSAGE = [
  "RB Harness requires Node.js >= 20.",
  "Detected: Node.js 18.19.1.",
  "",
  "Upgrade Node.js and rerun:",
  "",
  "npm run install:user",
].join("\n");

interface ScriptOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function runScript(script: string, simulatedNode?: string): Promise<ScriptOutcome> {
  // An empty PATH keeps `npm` unreachable: reaching the build step at all
  // would surface as a different failure than the one asserted below.
  const emptyPath = await mkdtemp(resolve(tmpdir(), "rb-preflight-path-"));
  const environment: NodeJS.ProcessEnv = { ...process.env, PATH: emptyPath };
  if (simulatedNode === undefined) delete environment[SIMULATED_NODE_VERSION_VARIABLE];
  else environment[SIMULATED_NODE_VERSION_VARIABLE] = simulatedNode;

  return await new Promise<ScriptOutcome>((resolvePromise, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: repositoryRoot,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => { resolvePromise({ code, stdout, stderr }); });
  });
}

describe("supported Node range authority", () => {
  it("reads the minimum from the repository engines field rather than a literal", () => {
    expect(readSupportedNodeRange(repositoryRoot)).toBe(">=20");
    expect(parseRequiredMajor(readSupportedNodeRange(repositoryRoot))).toBe(20);
  });

  it("parses the lower bound of the range forms a package manifest may carry", () => {
    expect(parseRequiredMajor(">=20")).toBe(20);
    expect(parseRequiredMajor(">= 20.11.0")).toBe(20);
    expect(parseRequiredMajor("^22.0.0")).toBe(22);
    expect(parseRequiredMajor("24.x")).toBe(24);
  });
});

describe("unsupported Node", () => {
  it("rejects Node 18.x against a >=20 contract", () => {
    const evaluation = evaluateNodeSupport("v18.19.1", ">=20");
    expect(evaluation).toEqual({
      supported: false,
      reason: "below-minimum",
      detected: "18.19.1",
      requiredMajor: 20,
    });
  });

  it("states the requirement, the detection, and the recovery command", () => {
    const message = formatUnsupportedNodeMessage(evaluateNodeSupport("v18.19.1", ">=20"));
    expect(message).toBe(UNSUPPORTED_MESSAGE);
  });

  it("reports without throwing or exposing an internal stack trace", () => {
    let written = "";
    const exitCodes: number[] = [];
    const evaluation = assertSupportedNodeVersion({
      version: "v18.19.1",
      supportedRange: ">=20",
      env: {},
      stderr: { write: (value: string) => { written += value; return true; } },
      exit: (code: number) => { exitCodes.push(code); },
    });

    expect(evaluation.supported).toBe(false);
    expect(exitCodes).toEqual([1]);
    expect(written).toBe(`${UNSUPPORTED_MESSAGE}\n`);
    expect(written).not.toMatch(/\n\s+at /);
    expect(written).not.toContain("node:internal");
  });

  it("fails the installer before the build, the install, and any runtime download", async () => {
    const outcome = await runScript(installer, "v18.19.1");

    expect(outcome.code).toBe(1);
    // Nothing reached stdout: the build banner is the installer's first write.
    expect(outcome.stdout).toBe("");
    expect(outcome.stderr).toBe(`${UNSUPPORTED_MESSAGE}\n`);
    for (const forbidden of ["[1/4]", "Building", "[2/4]", "[3/4]", "Downloading", "rb-codex"]) {
      expect(outcome.stdout + outcome.stderr).not.toContain(forbidden);
    }
    expect(outcome.stderr).not.toMatch(/\n\s+at /);
  });
});

describe("supported Node", () => {
  it("accepts the minimum and later majors", () => {
    for (const version of ["v20.0.0", "v20.19.5", "v22.11.0", "v24.3.0"]) {
      expect(evaluateNodeSupport(version, ">=20").supported).toBe(true);
    }
  });

  it("accepts a prerelease build of a supported major", () => {
    expect(evaluateNodeSupport("v22.0.0-nightly20240101", ">=20").supported).toBe(true);
  });

  it("passes the gate on the running runtime without side effects", async () => {
    expect(parseRuntimeMajor(process.version)).toBeGreaterThanOrEqual(20);
    const outcome = await runScript(preflight);
    expect(outcome.code).toBe(0);
    expect(outcome.stdout).toBe("");
    expect(outcome.stderr).toBe("");
  });

  it("cannot be talked into passing by the diagnostic seam", () => {
    // The seam may only add a failure, so it can never mask a real one.
    let written = "";
    const exitCodes: number[] = [];
    assertSupportedNodeVersion({
      version: "v18.19.1",
      supportedRange: ">=20",
      env: { [SIMULATED_NODE_VERSION_VARIABLE]: "v24.0.0" },
      stderr: { write: (value: string) => { written += value; return true; } },
      exit: (code: number) => { exitCodes.push(code); },
    });
    expect(exitCodes).toEqual([1]);
    expect(written).toBe(`${UNSUPPORTED_MESSAGE}\n`);
  });
});

describe("unparseable versions fail closed", () => {
  it("treats an unrecognised runtime version as unsupported", () => {
    for (const version of ["", "v", "banana", "20", "v20", "v20.1", "vv20.1.1", "  "]) {
      const evaluation = evaluateNodeSupport(version, ">=20");
      expect(evaluation.supported, `expected ${JSON.stringify(version)} to fail closed`).toBe(false);
      expect(evaluation.reason).toBe("unreadable-runtime");
    }
    expect(evaluateNodeSupport(undefined, ">=20").supported).toBe(false);
    expect(evaluateNodeSupport(21, ">=20").supported).toBe(false);
  });

  it("names the unrecognised runtime version in the operator message", () => {
    const message = formatUnsupportedNodeMessage(evaluateNodeSupport("banana", ">=20"));
    expect(message).toContain("Detected: Node.js banana (unrecognised version).");
    expect(message).toContain("RB Harness requires Node.js >= 20.");
  });

  it("treats an unreadable requirement as unsupported", () => {
    for (const range of [undefined, "", "latest", "*", ">=abc"]) {
      const evaluation = evaluateNodeSupport("v24.0.0", range);
      expect(evaluation.supported, `expected ${JSON.stringify(range)} to fail closed`).toBe(false);
      expect(evaluation.reason).toBe("unreadable-requirement");
    }
  });

  it("fails closed when package.json cannot be read at all", () => {
    let written = "";
    const exitCodes: number[] = [];
    assertSupportedNodeVersion({
      repositoryRoot: resolve(tmpdir(), "rb-harness-absent-repository-root"),
      env: {},
      stderr: { write: (value: string) => { written += value; return true; } },
      exit: (code: number) => { exitCodes.push(code); },
    });
    expect(exitCodes).toEqual([1]);
    expect(written).toContain("cannot determine its supported Node.js version");
    expect(written).not.toMatch(/\n\s+at /);
  });
});
