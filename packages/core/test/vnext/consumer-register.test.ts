import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { INIT_PROJECT_IR_CONSUMERS, INIT_PROJECT_IR_FIELDS } from "../../src/vnext/ir.js";

describe("vNext IR consumer register", () => {
  it("registers every production field with a non-empty current consumer", async () => {
    const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
    const source = await readFile(resolve(repositoryRoot, "docs/vnext/ir-consumers.md"), "utf8");
    const rows = source.split("\n")
      .map((line) => line.match(/^\| ([^|]+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \|$/))
      .filter((match): match is RegExpMatchArray => Boolean(match))
      .filter((match) => match[1] !== "path" && match[1] !== "---");
    const registered = rows.map((match) => match[1]!.trim()).sort();
    expect(registered).toEqual([...INIT_PROJECT_IR_FIELDS].sort());
    expect(rows.every((match) => Boolean(match[3]?.trim()))).toBe(true);
    expect(INIT_PROJECT_IR_CONSUMERS.every((entry) => entry.path.trim() && entry.consumer.trim())).toBe(true);
  });
});
