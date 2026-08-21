import { describe, expect, it } from "vitest";
import { validateOperationalValue } from "../src/operational-contract.js";

describe("rb-operational/v1", () => {
  it("accepts stack-neutral command and process scenarios", () => {
    const result = validateOperationalValue({
      contract: "rb-operational/v1",
      cleanRoom: { exclude: ["build"] },
      environment: { inherit: [], set: { APP_ENV: "verify" } },
      scenarios: [{
        id: "consumer",
        title: "Exercise the product boundary",
        platforms: ["linux", "darwin", "win32"],
        steps: [
          { id: "build", kind: "command", command: { argv: ["tool", "build"] }, expect: { exitCode: 0 } },
          {
            id: "run",
            kind: "process",
            command: { argv: ["tool", "start"] },
            ready: { kind: "stdout", includes: "ready" },
            checks: [{ kind: "tcp", host: "127.0.0.1", port: "${RB_VERIFY_PORT}" }],
          },
        ],
      }],
    });
    expect(result).toMatchObject({ valid: true, issues: [] });
  });

  it("rejects shell strings, unknown properties, fake kinds, and duplicate IDs", () => {
    const result = validateOperationalValue({
      contract: "rb-operational/v1",
      surprise: true,
      scenarios: [{
        id: "duplicate",
        title: "Broken",
        steps: [
          { id: "same", kind: "command", command: "npm test" },
          { id: "same", kind: "manual" },
        ],
      }, { id: "duplicate", title: "Again", steps: [] }],
    });
    expect(result.valid).toBe(false);
    expect(result.issues.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      "operational.property.unknown",
      "operational.command",
      "operational.step.kind",
      "operational.step.id.duplicate",
      "operational.scenario.id.duplicate",
    ]));
  });
});
