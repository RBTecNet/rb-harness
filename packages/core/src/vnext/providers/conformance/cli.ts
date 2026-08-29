import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFORMANCE_CASES } from "./fixtures.js";
import { readConformanceRecord, writeConformanceRecord } from "./recording.js";
import { validateConformanceRecord } from "./runner.js";
import {
  recordProviderConformance,
  resolveProviderAdapter,
  resolveProviderCredential,
  resolveProviderProfile,
} from "../registry.js";

const SOURCE_RECORDS = ["src", "vnext", "providers", "conformance", "records"] as const;

/** Both source execution and the bundled dist CLI resolve one source authority. */
export function conformanceRecordsRootFromModulePath(modulePath: string): string {
  const absolute = resolve(modulePath);
  const sourceMarker = `${sep}src${sep}vnext${sep}providers${sep}conformance${sep}`;
  const sourceIndex = absolute.lastIndexOf(sourceMarker);
  if (sourceIndex >= 0) return resolve(absolute.slice(0, sourceIndex), ...SOURCE_RECORDS);
  const distMarker = `${sep}dist${sep}`;
  const distIndex = absolute.lastIndexOf(distMarker);
  if (distIndex >= 0) return resolve(absolute.slice(0, distIndex), ...SOURCE_RECORDS);
  throw new Error(`cannot locate the @rb-harness/core package root from module path: ${modulePath}`);
}

export function defaultConformanceRecordsRoot(): string {
  return conformanceRecordsRootFromModulePath(fileURLToPath(import.meta.url));
}

function printResult(result: import("./suite.js").ConformanceResult, profile: import("../contract.js").ModelProfile): void {
  process.stdout.write(`Profile: ${result.profileId}\n`);
  process.stdout.write(`Transport: ${profile.transport}\n`);
  process.stdout.write(`Suite: ${result.suiteVersion}\n`);
  process.stdout.write(`Tier: ${result.tier}\n`);
  process.stdout.write(`Assertions: ${result.cases.filter((test) => test.passed).length}/${result.cases.length} passed\n`);
  for (const test of result.cases) process.stdout.write(`${test.passed ? "PASS" : "FAIL"} ${test.id}${test.diagnostic ? ` — ${test.diagnostic}` : ""}\n`);
}

export async function runVnextConformanceCommand(options: {
  profileId: string;
  record: boolean;
  credential?: string;
  recordsRoot?: string;
}): Promise<void> {
  const profile = resolveProviderProfile(options.profileId);
  const adapter = resolveProviderAdapter(options.profileId);
  const root = options.recordsRoot ?? defaultConformanceRecordsRoot();
  if (options.record) {
    const resolved = await resolveProviderCredential(profile, options.credential);
    const live = await recordProviderConformance(profile, resolved);
    const path = await writeConformanceRecord(root, live.record);
    printResult(live.record.result, profile);
    process.stdout.write(`Provider requests: ${live.providerRequests}\nRecord: ${path}\n`);
    if (live.record.result.tier === "UNSUPPORTED") process.exitCode = 1;
    return;
  }
  const record = await readConformanceRecord(root, profile.id);
  const result = validateConformanceRecord({ adapter, profile, cases: CONFORMANCE_CASES, record });
  printResult(result, profile);
  if (result.tier === "UNSUPPORTED") process.exitCode = 1;
}
