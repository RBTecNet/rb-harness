import { delimiter, normalize, resolve } from "node:path";

function comparablePath(path) {
  const normalized = normalize(resolve(path));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function pathContainsDirectory(pathValue, directory, separator = delimiter) {
  if (typeof pathValue !== "string" || typeof directory !== "string") return false;
  const expected = comparablePath(directory);
  return pathValue
    .split(separator)
    .filter((entry) => entry.length > 0)
    .some((entry) => comparablePath(entry) === expected);
}

export function pathGuidance(pathValue, binDirectory) {
  if (pathContainsDirectory(pathValue, binDirectory)) return undefined;
  return [
    "RB Harness was installed successfully, but:",
    `  ${binDirectory}`,
    "is not currently in PATH.",
    "",
    "For this shell:",
    '  export PATH="$HOME/.local/bin:$PATH"',
    "",
    "Add that line to your shell profile or start a new login session if your system already configures ~/.local/bin there.",
    "",
    "Then run:",
    "  rb-harness --version",
  ].join("\n");
}

export function canonicalPublicInstallCommand(metadata) {
  if (typeof metadata?.name !== "string" || typeof metadata?.version !== "string") {
    throw new Error("RB Harness package metadata is missing its name or version");
  }
  return `npx --yes --no-audit --no-update-notifier --package ${metadata.name}@${metadata.version} rb-harness-install`;
}
