import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { atomicWrite, relativeProjectPath, safeProjectPath, walkFiles } from "./fs-utils.js";
import { sha256File } from "./hash.js";

const MANIFEST_NAMES = new Set([
  "package.json",
  "composer.json",
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
  "Gemfile",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Makefile",
]);

const CONFIG_PATTERNS = [
  /(?:^|\/)\.github\/workflows\/.+\.ya?ml$/,
  /(?:^|\/)\.gitlab-ci\.ya?ml$/,
  /(?:^|\/)(?:Dockerfile|compose\.ya?ml|docker-compose\.ya?ml)$/,
  /(?:^|\/)(?:tsconfig|eslint|prettier|vitest|jest|phpunit|phpstan|ruff|pytest)[^/]*\.(?:json|js|cjs|mjs|ts|xml|neon|toml|ini)$/,
];

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".php": "PHP",
  ".py": "Python",
  ".go": "Go",
  ".rs": "Rust",
  ".java": "Java",
  ".kt": "Kotlin",
  ".rb": "Ruby",
  ".cs": "C#",
  ".swift": "Swift",
  ".dart": "Dart",
  ".ex": "Elixir",
  ".exs": "Elixir",
};

function gitValue(root: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

async function packageEvidence(path: string): Promise<Record<string, unknown>> {
  try {
    const payload = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    return {
      name: payload.name,
      version: payload.version,
      engines: payload.engines,
      scripts: payload.scripts,
      dependencies: payload.dependencies,
      devDependencies: payload.devDependencies,
    };
  } catch {
    return { parseError: true };
  }
}

export async function inspectRepository(root: string): Promise<Record<string, unknown>> {
  const absoluteRoot = resolve(root);
  const discoveredFiles = await walkFiles(absoluteRoot, 20_000);
  const files = discoveredFiles.filter((path) => {
    const name = basename(path);
    if (name === ".env" || (/^\.env\./.test(name) && !/^\.env\.(?:example|dist)$/i.test(name))) return false;
    if (/^(?:id_(?:rsa|dsa|ecdsa|ed25519)|credentials)(?:\..+)?$/i.test(name)) return false;
    return !/\.(?:pem|key|p12|pfx)$/i.test(name);
  });
  const relativeFiles = files.map((path) => relativeProjectPath(absoluteRoot, path));
  const manifests: Array<Record<string, unknown>> = [];
  const configs: string[] = [];
  const docs: string[] = [];
  const languageCounts = new Map<string, number>();
  const envVars = new Set<string>();

  for (let index = 0; index < files.length; index += 1) {
    const path = files[index] as string;
    const relativePath = relativeFiles[index] as string;
    const name = basename(path);
    if (MANIFEST_NAMES.has(name)) {
      manifests.push({
        path: relativePath,
        sha256: await sha256File(path),
        ...(name === "package.json" ? { facts: await packageEvidence(path) } : {}),
      });
    }
    if (CONFIG_PATTERNS.some((pattern) => pattern.test(relativePath))) configs.push(relativePath);
    if (/^(?:README|CONTRIBUTING|ARCHITECTURE|AGENTS|CLAUDE)(?:\.[^/]+)?$/i.test(name)) docs.push(relativePath);
    const language = LANGUAGE_BY_EXTENSION[extname(name).toLowerCase()];
    if (language) languageCounts.set(language, (languageCounts.get(language) ?? 0) + 1);
    if (/\.env\.(?:example|dist)$/i.test(name)) {
      const source = await readFile(path, "utf8");
      source.split(/\r?\n/).forEach((line) => {
        const match = line.match(/^([A-Z][A-Z0-9_]*)=/);
        if (match?.[1]) envVars.add(match[1]);
      });
    }
  }

  const gitHead = gitValue(absoluteRoot, ["rev-parse", "HEAD"]);
  const gitBranch = gitValue(absoluteRoot, ["branch", "--show-current"]);
  const dirty = gitValue(absoluteRoot, ["status", "--porcelain"]);

  return {
    evidenceVersion: "rb-evidence/v1",
    generatedAt: new Date().toISOString(),
    target: absoluteRoot,
    limitations: [
      "Static repository evidence only; business intent requires confirmation.",
      discoveredFiles.length >= 20_000 ? "File scan reached the 20000-file safety limit." : undefined,
    ].filter(Boolean),
    git: gitHead ? { head: gitHead, branch: gitBranch || null, dirty: Boolean(dirty) } : { present: false },
    inventory: {
      fileCount: files.length,
      topLevel: [...new Set(relativeFiles.map((path) => path.split("/")[0]))].sort(),
    },
    languages: [...languageCounts.entries()]
      .map(([language, files]) => ({ language, files }))
      .sort((left, right) => right.files - left.files),
    manifests,
    configs: configs.sort(),
    documentation: docs.sort(),
    envVariableNames: [...envVars].sort(),
    evidencePolicy: {
      classifications: ["OBSERVED", "CONFIRMED", "INFERRED", "UNKNOWN", "CONFLICT"],
      excluded: [".env", "credentials", "ignored dependency/build directories"],
    },
  };
}

export async function writeEvidence(root: string, output = ".rb/context/evidence.json"): Promise<string> {
  const target = safeProjectPath(root, output);
  const evidence = await inspectRepository(root);
  await atomicWrite(target, `${JSON.stringify(evidence, null, 2)}\n`);
  return target;
}
