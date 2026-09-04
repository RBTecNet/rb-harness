import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalPublicInstallCommand,
  pathContainsDirectory,
  pathGuidance,
} from "../scripts/installer-ux.mjs";

describe("packaged installer PATH UX", () => {
  const home = join(tmpdir(), "rb-installer-user");
  const bin = join(home, ".local", "bin");

  it("does not warn when the installed bin is already a PATH entry", () => {
    const path = [join(tmpdir(), "first"), bin, join(tmpdir(), "last")].join(delimiter);
    expect(pathContainsDirectory(path, bin)).toBe(true);
    expect(pathGuidance(path, bin)).toBeUndefined();
  });

  it("prints actionable guidance without claiming to modify PATH", () => {
    const guidance = pathGuidance(join(tmpdir(), "other-bin"), bin);
    expect(guidance).toContain(`${bin}\nis not currently in PATH.`);
    expect(guidance).toContain('export PATH="$HOME/.local/bin:$PATH"');
    expect(guidance).toContain("Then run:\n  rb-harness --version");
    expect(guidance).not.toMatch(/modified|updated|changed your PATH/i);
  });

  it("matches complete PATH entries rather than substrings", () => {
    expect(pathContainsDirectory(`${bin}-other`, bin)).toBe(false);
    expect(pathContainsDirectory(`${bin}${delimiter}${bin}-other`, bin)).toBe(true);
  });

  it("does not edit shell startup files while producing guidance", async () => {
    const fixtureHome = await mkdtemp(join(tmpdir(), "rb-installer-profiles-"));
    const profiles = [".bashrc", ".zshrc", ".profile"];
    for (const profile of profiles) await writeFile(join(fixtureHome, profile), `unchanged:${profile}\n`, "utf8");
    const before = await Promise.all(profiles.map((profile) => readFile(join(fixtureHome, profile), "utf8")));

    expect(pathGuidance("/usr/bin", join(fixtureHome, ".local", "bin"))).toBeDefined();

    const after = await Promise.all(profiles.map((profile) => readFile(join(fixtureHome, profile), "utf8")));
    expect(after).toEqual(before);
  });

  it("derives the public recovery command from package metadata", () => {
    expect(canonicalPublicInstallCommand({ name: "@rb-harness/core", version: "1.0.7" })).toBe(
      "npx --yes --no-audit --no-update-notifier --package @rb-harness/core@1.0.7 rb-harness-install",
    );
  });
});
