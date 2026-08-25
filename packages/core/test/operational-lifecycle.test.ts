import { describe, expect, it } from "vitest";
import { generationContractDigest } from "../src/harness-contract-digest.js";
import { validateOperationalValue } from "../src/operational-contract.js";

function contract(steps: unknown[], extraScenarios: unknown[] = []) {
  return {
    contract: "rb-operational/v1",
    scenarios: [
      { id: "main", title: "A consumer exercises the product", platforms: ["linux"], steps },
      ...extraScenarios,
    ],
  };
}

/**
 * Observed failure in a real run: nine RBF attempts over five hours, every one
 * reporting `deterministic validation failed (1 command(s))` while the manager
 * reported the clean-room workflow passing. Both were right. The published
 * `OPERATIONS.json` asserted against `127.0.0.1:3000` in a step *after* the
 * process step, and the verifier stops the process in a `finally` when its own
 * step ends — so the port was closed. The executor could not fix it either:
 * generated specifications are read-only to it.
 */
describe("a scenario cannot probe a service it has already stopped", () => {
  it("rejects an assertion placed after the process step", () => {
    const result = validateOperationalValue(contract([
      { id: "start", kind: "process", command: { argv: ["npm", "start"] },
        ready: { kind: "http", url: "http://127.0.0.1:3000/", status: 200 } },
      { id: "explain", kind: "http", url: "http://127.0.0.1:3000/api/explain", status: 200 },
    ]));
    expect(result.valid).toBe(false);
    const issue = result.issues.find((entry) => entry.code === "operational.step.unreachable-service");
    expect(issue?.message).toContain("stopped when its own step ends");
    expect(issue?.message).toContain("checks array");
    expect(issue?.path).toBe("$.scenarios[0].steps[1]");
  });

  it("rejects a scenario that probes a local port without starting anything", () => {
    const result = validateOperationalValue(contract([
      { id: "generate", kind: "http", url: "http://127.0.0.1:3000/api/generate", status: 503 },
    ]));
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.message).toContain("no earlier step starts a process");
  });

  it("accepts the same assertions inside the process step's checks", () => {
    const result = validateOperationalValue(contract([
      { id: "build", kind: "command", command: { argv: ["npm", "run", "build"] }, expect: { exitCode: 0 } },
      { id: "serve", kind: "process", command: { argv: ["npm", "start"] },
        ready: { kind: "http", url: "http://127.0.0.1:${RB_VERIFY_PORT}/", status: 200 },
        checks: [
          { kind: "http", url: "http://127.0.0.1:${RB_VERIFY_PORT}/api/explain", status: 200 },
          { kind: "http", url: "http://127.0.0.1:${RB_VERIFY_PORT}/api/generate", status: 503 },
        ] },
    ]));
    expect(result.issues).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("covers every loopback spelling, and leaves remote hosts alone", () => {
    for (const host of ["127.0.0.1", "localhost", "0.0.0.0", "[::1]"]) {
      const result = validateOperationalValue(contract([
        { id: "probe", kind: "http", url: `http://${host}:8080/health`, status: 200 },
      ]));
      expect(result.valid, host).toBe(false);
    }
    const tcp = validateOperationalValue(contract([
      { id: "port", kind: "tcp", host: "127.0.0.1", port: 5432 },
    ]));
    expect(tcp.valid).toBe(false);
    // A remote dependency is not something the scenario could have started.
    const remote = validateOperationalValue(contract([
      { id: "upstream", kind: "http", url: "https://api.example.com/health", status: 200 },
    ]));
    expect(remote.issues.filter((entry) => entry.code === "operational.step.unreachable-service")).toEqual([]);
  });

  it("does not fault a file probe or a plain command", () => {
    const result = validateOperationalValue(contract([
      { id: "build", kind: "command", command: { argv: ["npm", "run", "build"] }, expect: { exitCode: 0 } },
      { id: "artifact", kind: "file", path: "dist/app.js", exists: true },
    ]));
    expect(result.issues).toEqual([]);
  });
});

describe("the digest teaches the lifecycle it enforces", () => {
  it("states that a process lives only inside its own step", () => {
    for (const workflow of ["init", "plan", "evolve"] as const) {
      const digest = generationContractDigest(workflow);
      expect(digest, workflow).toContain("A process lives only inside its own step");
      expect(digest, workflow).toContain("belongs in that step's `checks` array");
      expect(digest, workflow).toContain("RB_VERIFY_PORT");
    }
  });

  it("ships an example that its own validator accepts", () => {
    const digest = generationContractDigest("init");
    const start = digest.indexOf('{\n  "contract": "rb-operational/v1"');
    expect(start).toBeGreaterThan(-1);
    const end = digest.indexOf("\n```", start);
    // The placeholder is interpolated by the runner, not by JSON.
    const source = digest.slice(start, end).replaceAll("${RB_VERIFY_PORT}", "8080");
    const result = validateOperationalValue(JSON.parse(source));
    expect(result.issues).toEqual([]);
  });
});
