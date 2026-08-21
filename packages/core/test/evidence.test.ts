import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectRepository, writeEvidence } from "../src/evidence.js";

describe("repository evidence", () => {
  it("collects useful facts while excluding secrets and RB intent", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rb-evidence-test-"));
    await mkdir(resolve(root, "src"), { recursive: true });
    await mkdir(resolve(root, ".rb/init"), { recursive: true });
    await writeFile(
      resolve(root, "package.json"),
      `${JSON.stringify({ name: "sample", scripts: { test: "vitest run" }, dependencies: { fastify: "1.0.0" } })}\n`,
    );
    await writeFile(resolve(root, "src/index.ts"), "export const value = 1;\n");
    await writeFile(resolve(root, ".env"), "SECRET=must-not-appear\n");
    await writeFile(resolve(root, ".env.example"), "PUBLIC_NAME=\n");
    await writeFile(resolve(root, "private.pem"), "must-not-appear\n");
    await writeFile(resolve(root, ".rb/init/SPEC.md"), "must-not-be-evidence\n");

    const evidence = await inspectRepository(root);
    const serialized = JSON.stringify(evidence);

    expect(evidence.languages).toEqual([{ language: "TypeScript", files: 1 }]);
    expect(evidence.envVariableNames).toEqual(["PUBLIC_NAME"]);
    expect(serialized).not.toContain("must-not-appear");
    expect(serialized).not.toContain(".rb/init/SPEC.md");
    expect(evidence.inventory).toMatchObject({ fileCount: 3 });
  });

  it("refuses to write evidence outside the project root", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rb-evidence-safe-path-"));
    await expect(writeEvidence(root, "../outside.json")).rejects.toThrow("Path escapes project root");
  });
});
