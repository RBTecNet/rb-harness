import { defaultConformanceRecordsRoot } from "../../conformance/cli.js";
import { CLAUDE_CODE_TRANSPORT_PROFILE_ID } from "./runtime-model.js";
import { verifyClaudeCodeRuntimeCompatibility } from "./runtime-compatibility.js";

export async function runClaudeCodeRuntimeConformanceCommand(options: {
  readonly transportProfileId: string;
  readonly requestedModel: string;
  readonly recordsRoot?: string;
  readonly compatibilityRoot?: string;
}): Promise<void> {
  if (options.transportProfileId !== CLAUDE_CODE_TRANSPORT_PROFILE_ID) {
    throw new Error(`--verify-runtime-model requires ${CLAUDE_CODE_TRANSPORT_PROFILE_ID}`);
  }
  const verified = await verifyClaudeCodeRuntimeCompatibility({
    requestedModel: options.requestedModel,
    recordsRoot: options.recordsRoot ?? defaultConformanceRecordsRoot(),
    ...(options.compatibilityRoot ? { storeRoot: options.compatibilityRoot } : {}),
  });
  const result = verified.evidence.conformanceRecord.result;
  process.stdout.write(`Profile: ${result.profileId}\n`);
  process.stdout.write("Transport: claude-code-cli\n");
  process.stdout.write(`Transport version: ${verified.evidence.transportVersion}\n`);
  process.stdout.write(`Requested model: ${verified.evidence.requestedModel}\n`);
  process.stdout.write(`Resolved model: ${verified.evidence.resolvedModel}\n`);
  process.stdout.write(`Suite: ${result.suiteVersion}\n`);
  process.stdout.write(`Tier: ${result.tier}\n`);
  process.stdout.write(`Assertions: ${result.cases.filter((test) => test.passed).length}/${result.cases.length} passed\n`);
  process.stdout.write(`Transport invocations: ${verified.transportInvocations}\n`);
  process.stdout.write(`Compatibility evidence: ${verified.path}\n`);
}
