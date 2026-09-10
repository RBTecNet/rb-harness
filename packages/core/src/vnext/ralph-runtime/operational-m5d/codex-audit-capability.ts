import { createServer } from "node:net";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sha256, sha256Canonical } from "../hashing.js";
import {
  codexParentEnvironmentV2,
  codexRuntimeReadRootV2,
  codexShellEnvironmentPolicyOverridesV2,
  resolveCodexHomeV2,
  runCodexProcessV2,
} from "../operational-m5b/codex-process.js";
import {
  CODEX_CLI_AUDITOR_EXECUTABLE_PATH_V2,
  m5d,
} from "./contract.js";
import {
  buildCodexAuditorPermissionProfileV2,
  codexAuditorPermissionPolicyShapeDigestV2,
  codexAuditorPermissionProfileOverridesV2,
  type CodexAuditorPermissionProfileV2,
} from "./codex-audit-permission-profile.js";

export const CODEX_AUDITOR_CAPABILITY_PROBE_SCHEMA_V2 = "rb-ralph-codex-auditor-capability-probe/v1" as const;
export type CodexAuditorCapabilityStateV2 = "PROVEN" | "UNPROVEN";

export interface CodexAuditorCapabilityProbeV2 {
  readonly schema: typeof CODEX_AUDITOR_CAPABILITY_PROBE_SCHEMA_V2;
  readonly productSourceRead: CodexAuditorCapabilityStateV2;
  readonly productWriteDenied: CodexAuditorCapabilityStateV2;
  readonly productDeleteDenied: CodexAuditorCapabilityStateV2;
  readonly productRenameDenied: CodexAuditorCapabilityStateV2;
  readonly credentialOpenCloseDenied: CodexAuditorCapabilityStateV2;
  readonly rbHarnessReadWriteDenied: CodexAuditorCapabilityStateV2;
  readonly rbReadWriteDenied: CodexAuditorCapabilityStateV2;
  readonly gitReadWriteDenied: CodexAuditorCapabilityStateV2;
  readonly networkDenied: CodexAuditorCapabilityStateV2;
  readonly codexHomeEnvironmentAbsent: CodexAuditorCapabilityStateV2;
  readonly workspaceImmutable: CodexAuditorCapabilityStateV2;
  readonly permissionProfileDigest: string;
  readonly permissionPolicyShapeDigest: string;
  readonly probeExitCode: number | null;
  readonly matrixDigest: string;
  readonly observedAt: string;
  readonly reportDigest: string;
}

const PROBE_SOURCE = "src/status.js";
const PROBE_CONTENT = 'module.exports = "ready";\n';

function probeScript(port: number): string {
  return `#!/bin/sh
W="$1"
A="$2"
if [ "$(cat "$W/${PROBE_SOURCE}" 2>/dev/null)" = 'module.exports = "ready";' ]; then echo 'RBM5D PRODUCT_READ=ALLOW'; else echo 'RBM5D PRODUCT_READ=DENY'; fi
if ( echo changed >> "$W/${PROBE_SOURCE}" ) 2>/dev/null; then echo 'RBM5D PRODUCT_WRITE=ALLOW'; else echo 'RBM5D PRODUCT_WRITE=DENY'; fi
if ( rm -f "$W/${PROBE_SOURCE}" ) 2>/dev/null; then echo 'RBM5D PRODUCT_DELETE=ALLOW'; else echo 'RBM5D PRODUCT_DELETE=DENY'; fi
if ( mv "$W/${PROBE_SOURCE}" "$W/src/renamed.js" ) 2>/dev/null; then echo 'RBM5D PRODUCT_RENAME=ALLOW'; else echo 'RBM5D PRODUCT_RENAME=DENY'; fi
if ( exec 9< "$A" ) 2>/dev/null; then exec 9<&-; echo 'RBM5D AUTH_OPEN_CLOSE=OPEN'; else echo 'RBM5D AUTH_OPEN_CLOSE=DENY'; fi
for R in .rb-harness .rb .git; do
  K=$(printf '%s' "$R" | tr '.-' '__' | tr '[:lower:]' '[:upper:]')
  if ( exec 8< "$W/$R/probe.txt" ) 2>/dev/null; then exec 8<&-; echo "RBM5D \${K}_READ=ALLOW"; else echo "RBM5D \${K}_READ=DENY"; fi
  if ( echo changed > "$W/$R/probe.txt" ) 2>/dev/null; then echo "RBM5D \${K}_WRITE=ALLOW"; else echo "RBM5D \${K}_WRITE=DENY"; fi
done
if /bin/bash -c 'exec 3<>/dev/tcp/127.0.0.1/${port}' 2>/dev/null; then echo 'RBM5D NETWORK=ALLOW'; else echo 'RBM5D NETWORK=DENY'; fi
if [ -n "\${CODEX_HOME}" ]; then echo 'RBM5D CODEX_HOME_VISIBLE=YES'; else echo 'RBM5D CODEX_HOME_VISIBLE=NO'; fi
echo 'RBM5D DONE=1'
`;
}

export async function probeCodexAuditorPhysicalCapabilityV2(input: {
  readonly deadlineMs: number;
  readonly codexHome?: string;
  readonly executablePath?: string;
}): Promise<CodexAuditorCapabilityProbeV2> {
  const codexHome = input.codexHome ?? resolveCodexHomeV2();
  const executablePath = input.executablePath ?? CODEX_CLI_AUDITOR_EXECUTABLE_PATH_V2;
  const workspace = await mkdtemp(resolve(tmpdir(), "rb-ralph-m5d-capability-"));
  const server = createServer((socket) => socket.end());
  await new Promise<void>((resolveListen, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolveListen()); });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw m5d("M5D_CAPABILITY_UNPROVEN", "M5D_CAPABILITY_UNPROVEN: network positive control");
    await mkdir(join(workspace, "src"), { recursive: true, mode: 0o700 });
    await writeFile(join(workspace, PROBE_SOURCE), PROBE_CONTENT, { mode: 0o600 });
    for (const root of [".rb-harness", ".rb", ".git"]) {
      await mkdir(join(workspace, root), { recursive: true, mode: 0o700 });
      await writeFile(join(workspace, root, "probe.txt"), `${root} control\n`, { mode: 0o600 });
    }
    const before = await hostProbeDigest(workspace);
    const script = join(workspace, "capability-probe.sh");
    await writeFile(script, probeScript(address.port), { mode: 0o700 });
    await chmod(script, 0o700);
    const profile = buildCodexAuditorPermissionProfileV2({ productWorkspace: workspace, codexHome, codexRuntimeReadRoot: codexRuntimeReadRootV2(executablePath) });
    const run = await runCodexProcessV2({
      executablePath,
      argv: [
        "sandbox", "--permission-profile", profile.name, "--cd", workspace,
        ...codexAuditorPermissionProfileOverridesV2(profile).flatMap((entry) => ["-c", entry]),
        ...codexShellEnvironmentPolicyOverridesV2().flatMap((entry) => ["-c", entry]),
        "--", "/bin/sh", script, workspace, join(codexHome, "auth.json"),
      ],
      cwd: workspace,
      environment: codexParentEnvironmentV2(codexHome),
      stdin: "",
      deadlineMs: input.deadlineMs,
    });
    const after = await hostProbeDigest(workspace);
    const markers = readMarkers(run.stdout);
    const done = markers.get("DONE") === "1" && run.exitCode === 0 && run.signal === null && !run.timedOut && run.settlement.quiescent;
    const state = (condition: boolean): CodexAuditorCapabilityStateV2 => condition && done ? "PROVEN" : "UNPROVEN";
    const control = (name: string) => state(markers.get(`${name}_READ`) === "DENY" && markers.get(`${name}_WRITE`) === "DENY");
    const matrix = {
      productRead: markers.get("PRODUCT_READ"), productWrite: markers.get("PRODUCT_WRITE"),
      productDelete: markers.get("PRODUCT_DELETE"), productRename: markers.get("PRODUCT_RENAME"),
      auth: markers.get("AUTH_OPEN_CLOSE"), rbHarnessRead: markers.get("_RB_HARNESS_READ"),
      rbHarnessWrite: markers.get("_RB_HARNESS_WRITE"), rbRead: markers.get("_RB_READ"), rbWrite: markers.get("_RB_WRITE"),
      gitRead: markers.get("_GIT_READ"), gitWrite: markers.get("_GIT_WRITE"), network: markers.get("NETWORK"),
      codexHomeVisible: markers.get("CODEX_HOME_VISIBLE"), before, after,
    };
    const base = {
      schema: CODEX_AUDITOR_CAPABILITY_PROBE_SCHEMA_V2,
      productSourceRead: state(markers.get("PRODUCT_READ") === "ALLOW"),
      productWriteDenied: state(markers.get("PRODUCT_WRITE") === "DENY"),
      productDeleteDenied: state(markers.get("PRODUCT_DELETE") === "DENY"),
      productRenameDenied: state(markers.get("PRODUCT_RENAME") === "DENY"),
      credentialOpenCloseDenied: state(markers.get("AUTH_OPEN_CLOSE") === "DENY"),
      rbHarnessReadWriteDenied: control("_RB_HARNESS"),
      rbReadWriteDenied: control("_RB"),
      gitReadWriteDenied: control("_GIT"),
      networkDenied: state(markers.get("NETWORK") === "DENY"),
      codexHomeEnvironmentAbsent: state(markers.get("CODEX_HOME_VISIBLE") === "NO"),
      workspaceImmutable: state(before === after),
      permissionProfileDigest: profile.profileDigest,
      permissionPolicyShapeDigest: codexAuditorPermissionPolicyShapeDigestV2(profile),
      probeExitCode: run.exitCode,
      matrixDigest: sha256Canonical(matrix),
      observedAt: new Date().toISOString(),
    };
    const report = Object.freeze({ ...base, reportDigest: sha256Canonical(base) });
    assertCodexAuditorPhysicalCapabilityV2(report);
    return report;
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(workspace, { recursive: true, force: true });
  }
}

export function assertCodexAuditorPhysicalCapabilityV2(report: CodexAuditorCapabilityProbeV2, profile?: CodexAuditorPermissionProfileV2): void {
  const required: (keyof CodexAuditorCapabilityProbeV2)[] = [
    "productSourceRead", "productWriteDenied", "productDeleteDenied", "productRenameDenied", "credentialOpenCloseDenied",
    "rbHarnessReadWriteDenied", "rbReadWriteDenied", "gitReadWriteDenied", "networkDenied", "codexHomeEnvironmentAbsent", "workspaceImmutable",
  ];
  if (required.some((key) => report[key] !== "PROVEN")) throw m5d(report.credentialOpenCloseDenied !== "PROVEN" ? "M5D_CREDENTIAL_BOUNDARY_UNSAFE" : "M5D_CAPABILITY_UNPROVEN");
  const { reportDigest: _digest, ...base } = report;
  if (sha256Canonical(base) !== report.reportDigest) throw m5d("M5D_CAPABILITY_UNPROVEN", "M5D_CAPABILITY_UNPROVEN: report digest");
  if (profile && codexAuditorPermissionPolicyShapeDigestV2(profile) !== report.permissionPolicyShapeDigest) throw m5d("M5D_CAPABILITY_UNPROVEN", "M5D_CAPABILITY_UNPROVEN: profile shape");
}

/** Stable path-independent capability identity suitable for restart binding. */
export function codexAuditorCapabilityFactsDigestV2(report: CodexAuditorCapabilityProbeV2): string {
  assertCodexAuditorPhysicalCapabilityV2(report);
  return sha256Canonical({
    schema: report.schema,
    productSourceRead: report.productSourceRead,
    productWriteDenied: report.productWriteDenied,
    productDeleteDenied: report.productDeleteDenied,
    productRenameDenied: report.productRenameDenied,
    credentialOpenCloseDenied: report.credentialOpenCloseDenied,
    rbHarnessReadWriteDenied: report.rbHarnessReadWriteDenied,
    rbReadWriteDenied: report.rbReadWriteDenied,
    gitReadWriteDenied: report.gitReadWriteDenied,
    networkDenied: report.networkDenied,
    codexHomeEnvironmentAbsent: report.codexHomeEnvironmentAbsent,
    workspaceImmutable: report.workspaceImmutable,
    permissionPolicyShapeDigest: report.permissionPolicyShapeDigest,
    matrixDigest: report.matrixDigest,
  });
}

function readMarkers(stdout: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const match = line.match(/^RBM5D ([A-Z0-9_]+)=([A-Z0-9_]+)$/);
    if (match?.[1] && match[2]) result.set(match[1], match[2]);
  }
  return result;
}

async function hostProbeDigest(workspace: string): Promise<string> {
  const paths = [PROBE_SOURCE, ".rb-harness/probe.txt", ".rb/probe.txt", ".git/probe.txt"];
  const entries = await Promise.all(paths.map(async (path) => ({ path, digest: sha256(await readFile(join(workspace, path)).catch(() => Buffer.from("ABSENT"))) })));
  return sha256Canonical(entries);
}
