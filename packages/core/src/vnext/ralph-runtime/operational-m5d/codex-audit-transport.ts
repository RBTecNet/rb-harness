import { isAbsolute, resolve } from "node:path";
import { sha256Canonical } from "../hashing.js";
import {
  CODEX_FORBIDDEN_ARGV_TOKENS_V2,
  codexShellEnvironmentPolicyOverridesV2,
} from "../operational-m5b/codex-process.js";
import {
  CODEX_CLI_AUDITOR_REASONING_EFFORT_V2,
  CODEX_CLI_AUDITOR_REQUESTED_MODEL_V2,
  m5d,
} from "./contract.js";
import {
  assertCodexAuditorPermissionProfileV2,
  codexAuditorPermissionProfileOverridesV2,
  type CodexAuditorPermissionProfileV2,
} from "./codex-audit-permission-profile.js";

export interface CodexAuditorExecArgvInputV2 {
  readonly productWorkspace: string;
  readonly outputSchemaPath: string;
  readonly finalOutputPath: string;
  readonly permissionProfile: CodexAuditorPermissionProfileV2;
}

export function buildCodexAuditorExecArgvV2(input: CodexAuditorExecArgvInputV2): readonly string[] {
  for (const path of [input.productWorkspace, input.outputSchemaPath, input.finalOutputPath]) {
    if (!isAbsolute(path) || resolve(path) !== path) throw m5d("M5D_ARGV_POLICY_INVALID", "M5D_ARGV_POLICY_INVALID: paths");
  }
  assertCodexAuditorPermissionProfileV2(input.permissionProfile);
  const argv = Object.freeze([
    "exec", "--cd", input.productWorkspace,
    "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "--ephemeral",
    "--color", "never", "--model", CODEX_CLI_AUDITOR_REQUESTED_MODEL_V2,
    "-c", `model_reasoning_effort=${JSON.stringify(CODEX_CLI_AUDITOR_REASONING_EFFORT_V2)}`,
    ...codexAuditorPermissionProfileOverridesV2(input.permissionProfile).flatMap((entry) => ["-c", entry]),
    ...codexShellEnvironmentPolicyOverridesV2().flatMap((entry) => ["-c", entry]),
    "--output-schema", input.outputSchemaPath, "-o", input.finalOutputPath, "--json", "-",
  ]);
  assertCodexAuditorArgvV2(argv, input.permissionProfile);
  return argv;
}

export function assertCodexAuditorArgvV2(argv: readonly string[], profile: CodexAuditorPermissionProfileV2): void {
  assertCodexAuditorPermissionProfileV2(profile);
  if (argv[0] !== "exec" || argv.at(-1) !== "-") throw m5d("M5D_ARGV_POLICY_INVALID");
  for (const forbidden of CODEX_FORBIDDEN_ARGV_TOKENS_V2) if (argv.slice(1).includes(forbidden)) throw m5d("M5D_ARGV_POLICY_INVALID", `M5D_ARGV_POLICY_INVALID: ${forbidden}`);
  for (const required of ["--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "--ephemeral", "--json", "--output-schema", "-o"]) if (!argv.includes(required)) throw m5d("M5D_ARGV_POLICY_INVALID", `M5D_ARGV_POLICY_INVALID: ${required}`);
  const model = argv.indexOf("--model");
  if (model < 0 || argv[model + 1] !== CODEX_CLI_AUDITOR_REQUESTED_MODEL_V2) throw m5d("M5D_ARGV_POLICY_INVALID", "M5D_ARGV_POLICY_INVALID: model");
  const overrides = argv.flatMap((token, index) => token === "-c" && argv[index + 1] ? [argv[index + 1]!] : []);
  for (const expected of [...codexAuditorPermissionProfileOverridesV2(profile), ...codexShellEnvironmentPolicyOverridesV2()]) if (!overrides.includes(expected)) throw m5d("M5D_ARGV_POLICY_INVALID", "M5D_ARGV_POLICY_INVALID: sealed profile/environment");
}

export function codexAuditorArgvFactsV2(argv: readonly string[], profile: CodexAuditorPermissionProfileV2): Readonly<Record<string, string>> {
  assertCodexAuditorArgvV2(argv, profile);
  return Object.freeze({
    subcommand: "exec", role: "AUDITOR", ephemeral: "true", resume: "absent", fork: "absent",
    requestedModel: CODEX_CLI_AUDITOR_REQUESTED_MODEL_V2,
    permissionProfileName: profile.name, permissionProfileDigest: profile.profileDigest,
    outputSchema: "present", finalOutput: "present", jsonl: "true", tokenCount: String(argv.length),
  });
}

export function codexAuditorArgvDigestV2(argv: readonly string[]): string { return sha256Canonical([...argv]); }
