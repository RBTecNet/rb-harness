/**
 * Node.js runtime prerequisite gate shared by the developer and packaged
 * end-user installers.
 *
 * This module runs *before* the build, the npm install, and the RB Codex
 * runtime bootstrap, so it must stay parseable and executable on the very
 * Node versions it rejects. Nothing here may use syntax or APIs newer than
 * the oldest Node an operator might plausibly have on PATH -- in particular
 * `import.meta.dirname` is unavailable before Node 20.11 and is deliberately
 * not used.
 *
 * The supported range is never hard-coded: it is read from the repository's
 * `engines.node`, which is the single source of truth shared with the
 * published package metadata.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");

/**
 * Diagnostic seam that lets a test drive the gate without a second Node
 * installation. It can only turn a passing check into a failing one, never
 * the reverse, so it cannot be used to bypass the prerequisite.
 */
export const SIMULATED_NODE_VERSION_VARIABLE = "RB_HARNESS_PREFLIGHT_SIMULATED_NODE";

export function readSupportedNodeRange(root = repositoryRoot) {
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  return manifest.engines?.node;
}

export function parseRequiredMajor(range) {
  if (typeof range !== "string") return undefined;
  const atLeast = /(?:^|\|\|)\s*>=\s*v?(\d+)/.exec(range);
  if (atLeast) return Number(atLeast[1]);
  const lowerBound = /^\s*[~^]?v?(\d+)(?:\.|\s*$)/.exec(range);
  if (lowerBound) return Number(lowerBound[1]);
  return undefined;
}

export function parseRuntimeMajor(version) {
  if (typeof version !== "string") return undefined;
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
  if (!match) return undefined;
  return Number(match[1]);
}

function describeDetected(version) {
  if (typeof version !== "string") return "unknown";
  const trimmed = version.trim().replace(/^v/, "");
  return trimmed.length > 0 ? trimmed : "unknown";
}

/**
 * Fails closed: an unreadable requirement or an unrecognised runtime version
 * is reported as unsupported rather than assumed to be fine.
 */
export function evaluateNodeSupport(runtimeVersion, supportedRange) {
  const detected = describeDetected(runtimeVersion);
  const requiredMajor = parseRequiredMajor(supportedRange);
  if (requiredMajor === undefined) {
    return { supported: false, reason: "unreadable-requirement", detected, requiredMajor: undefined };
  }
  const runtimeMajor = parseRuntimeMajor(runtimeVersion);
  if (runtimeMajor === undefined) {
    return { supported: false, reason: "unreadable-runtime", detected, requiredMajor };
  }
  if (runtimeMajor < requiredMajor) {
    return { supported: false, reason: "below-minimum", detected, requiredMajor };
  }
  return { supported: true, reason: "supported", detected, requiredMajor };
}

export function formatUnsupportedNodeMessage(evaluation, recoveryCommand = "npm run install:user") {
  if (evaluation.reason === "unreadable-requirement") {
    return [
      "RB Harness cannot determine its supported Node.js version.",
      'The "engines.node" field in package.json is missing or unreadable.',
      "",
      "Restore package.json and rerun:",
      "",
      recoveryCommand,
    ].join("\n");
  }
  const detected = evaluation.reason === "unreadable-runtime"
    ? `${evaluation.detected} (unrecognised version)`
    : evaluation.detected;
  return [
    `RB Harness requires Node.js >= ${evaluation.requiredMajor}.`,
    `Detected: Node.js ${detected}.`,
    "",
    "Upgrade Node.js and rerun:",
    "",
    recoveryCommand,
  ].join("\n");
}

/**
 * Writes a plain operator-facing message and exits non-zero when the running
 * Node is unsupported. It never throws, so an unsupported runtime cannot
 * surface an internal stack trace.
 */
export function assertSupportedNodeVersion(options = {}) {
  const stderr = options.stderr ?? process.stderr;
  const exit = options.exit ?? ((code) => process.exit(code));
  const environment = options.env ?? process.env;

  let supportedRange;
  try {
    supportedRange = options.supportedRange ?? readSupportedNodeRange(options.repositoryRoot);
  } catch {
    supportedRange = undefined;
  }

  const evaluations = [evaluateNodeSupport(options.version ?? process.version, supportedRange)];
  const simulated = environment[SIMULATED_NODE_VERSION_VARIABLE];
  if (typeof simulated === "string" && simulated.length > 0) {
    evaluations.push(evaluateNodeSupport(simulated, supportedRange));
  }

  const failure = evaluations.find((evaluation) => !evaluation.supported);
  if (!failure) return evaluations[0];
  stderr.write(`${formatUnsupportedNodeMessage(failure, options.recoveryCommand)}\n`);
  exit(1);
  return failure;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assertSupportedNodeVersion();
}
