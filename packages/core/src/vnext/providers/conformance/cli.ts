import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readConformanceRecord, writeConformanceRecord } from "./recording.js";
import { validateConformanceRecord } from "./runner.js";
import {
  recordProviderConformance,
  resolveProviderAdapter,
  resolveProviderAuth,
  resolveProviderConformanceCases,
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
  if (distIndex >= 0) return resolve(absolute.slice(0, distIndex), "dist", "records");
  throw new Error(`cannot locate the @rb-harness/core package root from module path: ${modulePath}`);
}

export function defaultConformanceRecordsRoot(): string {
  return conformanceRecordsRootFromModulePath(fileURLToPath(import.meta.url));
}

function printResult(result: import("./suite.js").ConformanceResult, profile: import("../contract.js").ModelProfile, transportVersion?: string): void {
  process.stdout.write(`Profile: ${result.profileId}\n`);
  process.stdout.write(`Transport: ${profile.transport}\n`);
  if (transportVersion) process.stdout.write(`Transport version: ${transportVersion}\n`);
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
  const cases = resolveProviderConformanceCases(options.profileId);
  const root = options.recordsRoot ?? defaultConformanceRecordsRoot();
  if (profile.transport !== "direct-api" && options.credential) {
    throw new Error(`--credential is not accepted for ambient-session profile ${profile.id}`);
  }
  if (options.record) {
    const auth = await resolveProviderAuth(profile, options.credential);
    const live = await recordProviderConformance(profile, auth);
    const path = await writeConformanceRecord(root, live.record);
    printResult(live.record.result, profile, live.record.transportVersion);
    process.stdout.write(`Transport invocations: ${live.transportInvocations}\n`);
    process.stdout.write(`Provider requests: ${live.providerRequests.measured ? live.providerRequests.value : `unmeasured (${live.providerRequests.reason})`}\nRecord: ${path}\n`);
    if (live.record.result.tier === "UNSUPPORTED") process.exitCode = 1;
    return;
  }
  const record = await readConformanceRecord(root, profile.id);
  const result = validateConformanceRecord({ adapter, profile, cases, record });
  printResult(result, profile, record.transportVersion);
  if (result.tier === "UNSUPPORTED") process.exitCode = 1;
}
