import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const plugin = resolve(root, "plugins/rb-harness");

async function filesUnder(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) output.push(...(await filesUnder(path)));
    else if (entry.isFile()) output.push(path);
  }
  return output;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const codex = JSON.parse(await readFile(resolve(plugin, ".codex-plugin/plugin.json"), "utf8"));
const claude = JSON.parse(await readFile(resolve(plugin, ".claude-plugin/plugin.json"), "utf8"));
assert(codex.name === "rb-harness", "Codex plugin name mismatch");
assert(claude.name === "rb-harness", "Claude plugin name mismatch");
const codexBaseVersion = codex.version.split("+", 1)[0];
const claudeBaseVersion = claude.version.split("+", 1)[0];
assert(codexBaseVersion === claudeBaseVersion, "Adapter base versions differ");

const required = [
  "commands/init.md",
  "commands/ai-context.md",
  "commands/plan.md",
  "commands/review.md",
  "commands/evolve.md",
  "skills/rb-init/SKILL.md",
  "skills/rb-ai-context/SKILL.md",
  "skills/rb-plan/SKILL.md",
  "skills/rb-review/SKILL.md",
  "skills/rb-review/references/responsive-evidence.md",
  "skills/rb-evolve/SKILL.md",
  "references/interview-policy.md",
  "references/artifact-conventions.md",
  "references/execution-template.md",
  "scripts/rb-harness.cjs",
  "scripts/rb-resolve.sh",
];

const pluginFiles = await filesUnder(plugin);
const relativeFiles = new Set(pluginFiles.map((path) => path.slice(plugin.length + 1)));
for (const path of required) assert(relativeFiles.has(path), `Missing plugin file: ${path}`);

for (const path of pluginFiles.filter((value) => /\.(?:md|json|yaml|yml)$/.test(value))) {
  const source = await readFile(path, "utf8");
  assert(!source.includes("[TODO:"), `Placeholder remains in ${path}`);
}

for (const skill of ["rb-init", "rb-ai-context", "rb-plan", "rb-review", "rb-evolve"]) {
  const source = await readFile(resolve(plugin, `skills/${skill}/SKILL.md`), "utf8");
  assert(source.startsWith(`---\nname: ${skill}\ndescription:`), `Invalid skill frontmatter: ${skill}`);
}

const responsiveReference = "skills/rb-review/references/responsive-evidence.md";
const responsiveConsumers = [
  "skills/rb-review/SKILL.md",
  "commands/review.md",
  "agents/review-inspector.md",
  "agents/review-planner.md",
];
for (const path of responsiveConsumers) {
  const source = await readFile(resolve(plugin, path), "utf8");
  assert(source.includes("responsive-evidence.md"), `Responsive evidence policy is not wired into ${path}`);
}

const responsivePolicy = await readFile(resolve(plugin, responsiveReference), "utf8");
for (const invariant of [
  "parent and child constraints",
  "below-the-fold",
  "observable geometry",
  "evidence provenance",
  "UNKNOWN",
]) {
  assert(responsivePolicy.includes(invariant), `Responsive evidence policy omits invariant: ${invariant}`);
}

const version = execFileSync("node", [resolve(plugin, "scripts/rb-harness.cjs"), "--version"], {
  encoding: "utf8",
}).trim();
assert(version === codexBaseVersion, "Bundled CLI and plugin base versions differ");

console.log(`OK: plugin adapters and bundled CLI are internally consistent (${pluginFiles.length} files).`);
