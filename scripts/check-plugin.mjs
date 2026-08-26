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
  "skills/rb-review/references/responsive-evidence.md",
  "scripts/rb-harness.cjs",
  "scripts/rb-resolve.sh",
  "contracts/RB-RALPH-CONTRACT.md",
  "contracts/rb-headless-init-v1.md",
  "contracts/rb-headless-interview-v1.md",
];

const pluginFiles = await filesUnder(plugin);
const relativeFiles = new Set(pluginFiles.map((path) => path.slice(plugin.length + 1)));
for (const path of required) assert(relativeFiles.has(path), `Missing plugin file: ${path}`);
for (const path of [
  "contracts/rb-responsive-inventory-v1.md",
  "contracts/rb-responsive-inventory-v1.schema.json",
  "contracts/rb-headless-interview-v1.md",
  "contracts/rb-headless-interview-v1.schema.json",
]) {
  await readFile(resolve(root, path), "utf8");
}

for (const path of pluginFiles.filter((value) => /\.(?:md|json|yaml|yml)$/.test(value))) {
  const source = await readFile(path, "utf8");
  assert(!source.includes("[TODO:"), `Placeholder remains in ${path}`);
}

const rootRalphContract = await readFile(resolve(root, "contracts/RB-RALPH-CONTRACT.md"), "utf8");
const pluginRalphContract = await readFile(resolve(plugin, "contracts/RB-RALPH-CONTRACT.md"), "utf8");
const normalizedRalphContract = rootRalphContract.replace(/\s+/g, " ");
assert(pluginRalphContract === rootRalphContract, "Packaged RB Ralph contract differs from the root contract");
assert(
  rootRalphContract.includes("RB_RALPH_DECISION: <COMPLETE|RETRY|BLOCKED>"),
  "RB Ralph manager protocol does not distinguish the decision placeholder from a literal value",
);
assert(
  !rootRalphContract.includes("RB_RALPH_DECISION: COMPLETE | RETRY | BLOCKED"),
  "RB Ralph manager protocol still publishes the ambiguous decision example",
);
assert(
  rootRalphContract.includes("`COMPLETE  ` normaliza para `COMPLETE`"),
  "RB Ralph manager protocol does not specify trailing-horizontal-whitespace normalization",
);
for (const invariant of [
  "protocolo de texto plano, não Markdown",
  "IDs de task sintética como `RBT-FINAL`",
  "`COMPLETE extra` continua inválido",
  "Feedback e resultados transitórios de uma chamada anterior são substituídos",
  "nenhum evento pode citar feedback ou log já superado",
]) {
  assert(normalizedRalphContract.includes(invariant), `RB Ralph manager protocol omits invariant: ${invariant}`);
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
  "agents/review-writer.md",
  "agents/review-planner.md",
];
for (const path of responsiveConsumers) {
  const source = await readFile(resolve(plugin, path), "utf8");
  assert(source.includes("responsive-evidence.md"), `Responsive evidence policy is not wired into ${path}`);
}

const responsivePolicy = await readFile(resolve(plugin, responsiveReference), "utf8");
const normalizedResponsivePolicy = responsivePolicy.replace(/\s+/g, " ");
for (const invariant of [
  "parent and child constraints",
  "below-the-fold",
  "observable geometry",
  "evidence provenance",
  "all first-party UI source files",
  "high-risk topology",
  "negative-control queries",
  "discovered equals analyzed plus excluded plus unresolved",
  "UNKNOWN",
]) {
  assert(
    normalizedResponsivePolicy.includes(invariant),
    `Responsive evidence policy omits invariant: ${invariant}`,
  );
}

const visualEvidenceConsumers = [
  "references/execution-template.md",
  "references/operational-template.md",
  "skills/rb-init/SKILL.md",
  "skills/rb-plan/SKILL.md",
  "skills/rb-evolve/SKILL.md",
  "skills/rb-review/SKILL.md",
  "agents/project-documenter.md",
  "agents/planner.md",
  "agents/evolve-planner.md",
  "agents/review-planner.md",
];
for (const path of visualEvidenceConsumers) {
  const source = (await readFile(resolve(plugin, path), "utf8")).replace(/\s+/g, " ");
  for (const invariant of ["human:", "negative", "screenshot"]) {
    assert(source.toLowerCase().includes(invariant), `Visual evidence policy omits ${invariant} in ${path}`);
  }
  assert(/geometry|geometria|bounding[- ]box/i.test(source), `Visual evidence policy omits geometry in ${path}`);
}
const executionContract = await readFile(resolve(plugin, "contracts/rb-execution-v1.md"), "utf8");
for (const invariant of ["visual acceptance", "exact numeric viewport", "geometry/computed-style", "fake DOMs"]) {
  assert(executionContract.includes(invariant), `Execution contract omits visual invariant: ${invariant}`);
}

const reviewCommand = await readFile(resolve(plugin, "commands/review.md"), "utf8");
const reviewSkill = await readFile(resolve(plugin, "skills/rb-review/SKILL.md"), "utf8");
const reviewPlanner = await readFile(resolve(plugin, "agents/review-planner.md"), "utf8");
const normalizedReviewCommand = reviewCommand.replace(/\s+/g, " ");
const normalizedReviewPlanner = reviewPlanner.replace(/\s+/g, " ");
for (const [name, source] of [
  ["review command", reviewCommand],
  ["review skill", reviewSkill],
]) {
  assert(source.includes("--plan-all-confirmed"), `${name} omits --plan-all-confirmed`);
  for (const confidence of ["CONFIRMED", "LIKELY", "UNKNOWN", "FALSE_POSITIVE_RISK"]) {
    assert(source.includes(confidence), `${name} omits ${confidence} selection semantics`);
  }
}
assert(normalizedReviewCommand.includes("fresh context"), "Review command does not require a fresh planner context");
assert(normalizedReviewPlanner.includes("Do not rely on the audit conversation"), "Planner may inherit accumulated audit context");
assert(normalizedReviewPlanner.includes("normalized predicate"), "Planner does not persist normalized selection policy");

const version = execFileSync("node", [resolve(plugin, "scripts/rb-harness.cjs"), "--version"], {
  encoding: "utf8",
}).trim();
assert(version === codexBaseVersion, "Bundled CLI and plugin base versions differ");

console.log(`OK: plugin adapters and bundled CLI are internally consistent (${pluginFiles.length} files).`);
