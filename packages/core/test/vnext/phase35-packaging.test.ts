import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWorkflowResourceRoot } from "../../src/standalone-resources.js";
import { conformanceRecordsRootFromModulePath } from "../../src/vnext/providers/conformance/cli.js";

describe("Phase 3.5 installed runtime paths", () => {
  it("resolves bundled conformance records beside dist without source cwd assumptions", () => {
    const launcher = resolve("/opt/rb-prefix/lib/node_modules/@rb-harness/core/dist/cli.js");
    expect(conformanceRecordsRootFromModulePath(launcher))
      .toBe(resolve("/opt/rb-prefix/lib/node_modules/@rb-harness/core/dist/records"));
  });

  it("resolves installed workflow resources from the real bin target outside its cwd", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "rb-vnext-packaged-resources-"));
    const packageRoot = resolve(root, "node_modules/@rb-harness/core");
    const launcher = resolve(packageRoot, "dist/cli.js");
    const resourceRoot = resolve(packageRoot, "dist/resources");
    await mkdir(resolve(resourceRoot, "references"), { recursive: true });
    await writeFile(resolve(resourceRoot, "references/interview-policy.md"), "fixture\n");
    expect(await resolveWorkflowResourceRoot({ launcherPath: launcher, workingDirectory: resolve(root, "unrelated-cwd") }))
      .toBe(resourceRoot);
  });
});
