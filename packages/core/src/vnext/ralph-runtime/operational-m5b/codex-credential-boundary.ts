import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { sha256Canonical } from "../hashing.js";
import {
  CODEX_CLI_NATIVE_EXECUTABLE_PATH_V2,
  type CodexCredentialBoundaryStateV2,
} from "./contract.js";
import { RalphM5BError } from "./contract-errors.js";
import {
  CODEX_PROJECTION_EXCLUDED_ROOTS_V2,
  CODEX_SENTINEL_MODE_V2,
  captureCodexSentinelPreimageV2,
  codexSentinelIdentityDigestV2,
  verifyCodexRootSentinelsV2,
  type CodexSentinelEntryV2,
} from "./codex-projection.js";
import {
  codexParentEnvironmentV2,
  codexRuntimeReadRootV2,
  codexShellEnvironmentPolicyOverridesV2,
  resolveCodexHomeV2,
  runCodexProcessV2,
} from "./codex-process.js";
import {
  buildCodexPermissionProfileV2,
  codexPermissionPolicyShapeDigestV2,
  codexPermissionProfileGrantsRootWriteV2,
  codexPermissionProfileOverridesV2,
  type CodexPermissionProfileV2,
} from "./codex-permission-profile.js";

/**
 * Ralph M5-B — the physical capability probe.
 *
 * The questions are narrow and every one of them is answered WITHOUT a model,
 * using the non-model `codex sandbox` engine under the exact permission
 * semantics the real `codex exec` dispatch will use:
 *
 *   - can the provider write the staging product root?
 *   - can it OPEN `<CODEX_HOME>/auth.json`?
 *   - can it write `.rb-harness`, `.rb` or `.git` inside the projection?
 *   - can it reach the network?
 *   - does its command environment carry CODEX_HOME?
 *
 * The credential check opens the file handle and closes it immediately.  It
 * never reads a byte, never hashes contents, never prints them and never
 * stats them; only the open/deny outcome is reported.
 */
export { CODEX_CREDENTIAL_BOUNDARY_STATES_V2, type CodexCredentialBoundaryStateV2 } from "./contract.js";

export const CODEX_CAPABILITY_PROBE_SCHEMA_V2 = "rb-ralph-codex-capability-probe/v1" as const;

export const CODEX_CAPABILITY_STATES_V2 = ["PROVEN", "UNPROVEN"] as const;
export type CodexCapabilityStateV2 = typeof CODEX_CAPABILITY_STATES_V2[number];

/** The product directory the probe projection grants write access to. */
const PROBE_PRODUCT_ROOT = "src";

/**
 * Marker protocol.  Each check prints exactly one line; the host also
 * verifies the resulting filesystem state, and the two must agree or the
 * whole probe is UNPROVEN.
 */
const PROBE_SCRIPT = `#!/bin/sh
if ( echo probe > "$1/${PROBE_PRODUCT_ROOT}/product-write.txt" ) 2>/dev/null; then echo "RBM5B PRODUCT_WRITE=ALLOW"; else echo "RBM5B PRODUCT_WRITE=DENY"; fi
if ( exec 9< "$2" ) 2>/dev/null; then echo "RBM5B AUTH_OPEN=OPEN"; else echo "RBM5B AUTH_OPEN=DENY"; fi
if ( mkdir -p "$1/.rb-harness" && echo x > "$1/.rb-harness/forbidden.txt" ) 2>/dev/null; then echo "RBM5B RB_HARNESS_WRITE=ALLOW"; else echo "RBM5B RB_HARNESS_WRITE=DENY"; fi
if ( mkdir -p "$1/.rb" && echo x > "$1/.rb/forbidden.txt" ) 2>/dev/null; then echo "RBM5B RB_WRITE=ALLOW"; else echo "RBM5B RB_WRITE=DENY"; fi
if ( mkdir -p "$1/.git" && echo x > "$1/.git/forbidden.txt" ) 2>/dev/null; then echo "RBM5B GIT_WRITE=ALLOW"; else echo "RBM5B GIT_WRITE=DENY"; fi
if ( echo x > "$1/staging-root-write.txt" ) 2>/dev/null; then echo "RBM5B STAGING_ROOT_WRITE=ALLOW"; else echo "RBM5B STAGING_ROOT_WRITE=DENY"; fi
if ( exec 3<>/dev/tcp/127.0.0.1/9 ) 2>/dev/null; then echo "RBM5B NETWORK=ALLOW"; else echo "RBM5B NETWORK=DENY"; fi
if [ -n "\${CODEX_HOME}" ]; then echo "RBM5B CODEX_HOME_VISIBLE=YES"; else echo "RBM5B CODEX_HOME_VISIBLE=NO"; fi
echo "RBM5B DONE=1"
`;

/**
 * The ROOT-SCOPE attack matrix, exercised with NO model whatsoever.
 *
 * Every denial is paired with a positive control on a product path using the
 * SAME tool, so a `DENY` can never be an artefact of a missing binary inside
 * the sandbox: `PC_*=ALLOW` proves `mkdir`, `mv`, `cp`, `ln` and `rm` all run,
 * and only then does `S<n>_*=DENY` mean the policy refused.
 */
function rootProbeScriptV2(sentinelRoots: readonly string[]): string {
  const lines = [
    "#!/bin/sh",
    "W=\"$1\"",
    "A=\"$2\"",
    // Positive controls: the tools themselves work on product paths.
    'if ( mkdir -p "$W/pc-dir" ) 2>/dev/null; then echo "RBM5B PC_MKDIR=ALLOW"; else echo "RBM5B PC_MKDIR=DENY"; fi',
    'if ( mv "$W/pc-dir" "$W/pc-moved" ) 2>/dev/null; then echo "RBM5B PC_MV=ALLOW"; else echo "RBM5B PC_MV=DENY"; fi',
    'if ( mkdir -p "$W/pc-replace-source" "$W/pc-replace-target" && mv -T "$W/pc-replace-source" "$W/pc-replace-target" ) 2>/dev/null; then echo "RBM5B PC_MV_T=ALLOW"; else echo "RBM5B PC_MV_T=DENY"; fi',
    'if ( cp "$W/README.md" "$W/pc-moved/copy.txt" ) 2>/dev/null; then echo "RBM5B PC_CP=ALLOW"; else echo "RBM5B PC_CP=DENY"; fi',
    'if ( ln -s "$W/README.md" "$W/pc-link" ) 2>/dev/null; then echo "RBM5B PC_LN=ALLOW"; else echo "RBM5B PC_LN=DENY"; fi',
    'if ( rm -rf "$W/pc-moved" ) 2>/dev/null; then echo "RBM5B PC_RM=ALLOW"; else echo "RBM5B PC_RM=DENY"; fi',
    // The root-level product surface the MAJOR is about.
    'if ( printf \'{"name":"probe"}\' > "$W/package.json" ) 2>/dev/null; then echo "RBM5B ROOT_PACKAGE_JSON=ALLOW"; else echo "RBM5B ROOT_PACKAGE_JSON=DENY"; fi',
    'if ( echo probe > "$W/root-product.txt" ) 2>/dev/null; then echo "RBM5B ROOT_PRODUCT_FILE=ALLOW"; else echo "RBM5B ROOT_PRODUCT_FILE=DENY"; fi',
    'if ( mkdir -p "$W/root-product-dir" && echo probe > "$W/root-product-dir/nested.txt" ) 2>/dev/null; then echo "RBM5B ROOT_PRODUCT_DIR=ALLOW"; else echo "RBM5B ROOT_PRODUCT_DIR=DENY"; fi',
    'if ( echo rewritten > "$W/README.md" ) 2>/dev/null; then echo "RBM5B ROOT_EXISTING_WRITE=ALLOW"; else echo "RBM5B ROOT_EXISTING_WRITE=DENY"; fi',
    // The credential, network and environment boundaries, unchanged.
    'if ( exec 9< "$A" ) 2>/dev/null; then echo "RBM5B AUTH_OPEN=OPEN"; else echo "RBM5B AUTH_OPEN=DENY"; fi',
    'if ( exec 3<>/dev/tcp/127.0.0.1/9 ) 2>/dev/null; then echo "RBM5B NETWORK=ALLOW"; else echo "RBM5B NETWORK=DENY"; fi',
    'if [ -n "${CODEX_HOME}" ]; then echo "RBM5B CODEX_HOME_VISIBLE=YES"; else echo "RBM5B CODEX_HOME_VISIBLE=NO"; fi',
  ];
  sentinelRoots.forEach((root, index) => {
    const key = `S${index}`;
    const target = `"$W/${root}"`;
    lines.push(
      `if ( mkdir ${target} ) 2>/dev/null; then echo "RBM5B ${key}_CREATE=ALLOW"; else echo "RBM5B ${key}_CREATE=DENY"; fi`,
      `if ( echo x > ${target}/nested.txt ) 2>/dev/null; then echo "RBM5B ${key}_NESTED=ALLOW"; else echo "RBM5B ${key}_NESTED=DENY"; fi`,
      `if ( rm -rf ${target} ) 2>/dev/null && [ ! -e ${target} ]; then echo "RBM5B ${key}_DELETE=ALLOW"; else echo "RBM5B ${key}_DELETE=DENY"; fi`,
      `if ( mv ${target} "$W/${key.toLowerCase()}-stolen" ) 2>/dev/null; then echo "RBM5B ${key}_RENAME_AWAY=ALLOW"; else echo "RBM5B ${key}_RENAME_AWAY=DENY"; fi`,
      `if ( rm -rf ${target} && printf x > ${target} ) 2>/dev/null; then echo "RBM5B ${key}_REPLACE_FILE=ALLOW"; else echo "RBM5B ${key}_REPLACE_FILE=DENY"; fi`,
      `if ( rm -rf ${target} && ln -s /etc ${target} ) 2>/dev/null; then echo "RBM5B ${key}_SYMLINK=ALLOW"; else echo "RBM5B ${key}_SYMLINK=DENY"; fi`,
      `if ( mkdir -p "$W/${key.toLowerCase()}-source" && mv -T "$W/${key.toLowerCase()}-source" ${target} ) 2>/dev/null; then echo "RBM5B ${key}_RENAME_ONTO=ALLOW"; else echo "RBM5B ${key}_RENAME_ONTO=DENY"; fi`,
      `if ( cp "$W/README.md" ${target}/copied.txt ) 2>/dev/null; then echo "RBM5B ${key}_COPY_INTO=ALLOW"; else echo "RBM5B ${key}_COPY_INTO=DENY"; fi`,
    );
  });
  lines.push('echo "RBM5B DONE=1"', "");
  return lines.join("\n");
}

/** The per-sentinel checks the matrix must answer DENY for, in order. */
export const CODEX_ROOT_SENTINEL_ATTACKS_V2: readonly string[] = Object.freeze([
  "CREATE", "NESTED", "DELETE", "RENAME_AWAY", "REPLACE_FILE", "SYMLINK", "RENAME_ONTO", "COPY_INTO",
]);

/** The positive controls that make a matrix denial meaningful. */
export const CODEX_ROOT_POSITIVE_CONTROLS_V2: readonly string[] = Object.freeze([
  "PC_MKDIR", "PC_MV", "PC_MV_T", "PC_CP", "PC_LN", "PC_RM",
]);

/** The root-level product writes a root-scope WorkUnit must be able to make. */
export const CODEX_ROOT_PRODUCT_WRITES_V2: readonly string[] = Object.freeze([
  "ROOT_PACKAGE_JSON", "ROOT_PRODUCT_FILE", "ROOT_PRODUCT_DIR", "ROOT_EXISTING_WRITE",
]);

export interface CodexCapabilityProbeReportV2 {
  readonly schema: typeof CODEX_CAPABILITY_PROBE_SCHEMA_V2;
  /** Physical state of the credential-file boundary. */
  readonly credentialFileBoundary: CodexCredentialBoundaryStateV2;
  readonly stagingWriteCapability: CodexCapabilityStateV2;
  readonly controlPlaneDenialCapability: CodexCapabilityStateV2;
  readonly networkDenialCapability: CodexCapabilityStateV2;
  readonly shellEnvironmentIsolationCapability: CodexCapabilityStateV2;
  readonly permissionProfileDigest: string;
  /** Path-independent shape shared with the profile the dispatch will use. */
  readonly permissionPolicyShapeDigest: string;
  readonly probeExitCode: number | null;
  /**
   * The ROOT-SCOPE half of the probe: a second, independent non-model
   * sandbox run under the exact root-write profile a root WorkUnit will use.
   * A root-scope dispatch is authorized only when both halves are PROVEN.
   */
  readonly rootProductWriteCapability: CodexCapabilityStateV2;
  readonly rootSentinelDenialCapability: CodexCapabilityStateV2;
  readonly rootPermissionProfileDigest: string;
  readonly rootPermissionPolicyShapeDigest: string;
  readonly rootSentinelCount: number;
  readonly rootAttackCount: number;
  /** Digest of every observed matrix outcome; bounded, credential-free. */
  readonly rootMatrixDigest: string;
  readonly rootProbeExitCode: number | null;
  readonly observedAt: string;
  readonly reportDigest: string;
}

export interface ProbeCodexCapabilityInputV2 {
  readonly deadlineMs: number;
  readonly codexHome?: string;
  readonly executablePath?: string;
}

export interface CodexProbeHostObservationsV2 {
  /** The host saw the product file the sandbox claimed it wrote. */
  readonly hostProductWrite: boolean;
  /** The host saw at least one control-plane path the sandbox must not make. */
  readonly hostControlPlane: boolean;
}

export interface CodexProbeEvaluationV2 {
  readonly completed: boolean;
  readonly credentialFileBoundary: CodexCredentialBoundaryStateV2;
  readonly stagingWriteCapability: CodexCapabilityStateV2;
  readonly controlPlaneDenialCapability: CodexCapabilityStateV2;
  readonly networkDenialCapability: CodexCapabilityStateV2;
  readonly shellEnvironmentIsolationCapability: CodexCapabilityStateV2;
}

/**
 * Interpret the probe's markers against the host's own observations.
 *
 * Pure and separately testable on purpose, because the most dangerous
 * misreading in this module has no visible symptom: a sandbox that NEVER
 * STARTED prints no markers at all, and absent markers must never read as
 * denials.  That is the exact M5-B.1 bundled-bwrap failure mode — the
 * commands did not run, so nothing was proven, and the boundary is UNKNOWN
 * rather than DENIED.  The host's own filesystem observations are the second
 * authority: a marker claiming a denial while the host sees the forbidden
 * path is not a denial.
 */
export function evaluateCodexProbeMarkersV2(stdout: string, host: CodexProbeHostObservationsV2): CodexProbeEvaluationV2 {
  const markers = readMarkersV2(stdout);
  const completed = markers.get("DONE") === "1";
  const credentialFileBoundary: CodexCredentialBoundaryStateV2 = !completed
    ? "UNKNOWN"
    : markers.get("AUTH_OPEN") === "DENY"
      ? "DENIED"
      : markers.get("AUTH_OPEN") === "OPEN"
        ? "PROVIDER_READABLE"
        : "UNKNOWN";
  return Object.freeze({
    completed,
    credentialFileBoundary,
    stagingWriteCapability: capability(completed && markers.get("PRODUCT_WRITE") === "ALLOW" && host.hostProductWrite),
    controlPlaneDenialCapability: capability(
      completed
      && markers.get("RB_HARNESS_WRITE") === "DENY"
      && markers.get("RB_WRITE") === "DENY"
      && markers.get("GIT_WRITE") === "DENY"
      && markers.get("STAGING_ROOT_WRITE") === "DENY"
      && !host.hostControlPlane,
    ),
    networkDenialCapability: capability(completed && markers.get("NETWORK") === "DENY"),
    shellEnvironmentIsolationCapability: capability(completed && markers.get("CODEX_HOME_VISIBLE") === "NO"),
  });
}

/**
 * Run the NON-MODEL capability probe.  The permission profile is built by the
 * same typed builder the real dispatch uses, so a policy change cannot pass
 * the gate while the dispatch runs something weaker.
 */
export async function probeCodexPhysicalCapabilityV2(
  input: ProbeCodexCapabilityInputV2 = { deadlineMs: 120_000 },
): Promise<CodexCapabilityProbeReportV2> {
  const codexHome = input.codexHome ?? resolveCodexHomeV2();
  if (!isAbsolute(codexHome)) throw new RalphM5BError("M5B_CHILD_ENVIRONMENT_INVALID");
  const executablePath = input.executablePath ?? CODEX_CLI_NATIVE_EXECUTABLE_PATH_V2;
  const authPath = join(codexHome, "auth.json");
  const workspace = await mkdtemp(resolve(tmpdir(), "rb-ralph-m5b-capability-"));
  try {
    // The probe projection has exactly the shape of a real staging
    // projection: a product root and no control-plane root at all.
    await mkdir(join(workspace, PROBE_PRODUCT_ROOT), { recursive: true, mode: 0o700 });
    await writeFile(join(workspace, "README.md"), "rb-ralph m5b capability probe\n", { mode: 0o600 });
    const scriptPath = join(workspace, "capability-probe.sh");
    await writeFile(scriptPath, PROBE_SCRIPT, { mode: 0o700 });

    const profile = buildCodexPermissionProfileV2({
      stagingWorkspace: workspace,
      writableRoots: [PROBE_PRODUCT_ROOT],
      codexHome,
      codexRuntimeReadRoot: codexRuntimeReadRootV2(executablePath),
    });

    const run = await runCodexProcessV2({
      executablePath,
      argv: [
        "sandbox",
        "--permission-profile", profile.name,
        "--cd", workspace,
        ...codexPermissionProfileOverridesV2(profile).flatMap((override) => ["-c", override]),
        ...codexShellEnvironmentPolicyOverridesV2().flatMap((override) => ["-c", override]),
        "--",
        "/bin/sh", scriptPath, workspace, authPath,
      ],
      cwd: workspace,
      environment: codexParentEnvironmentV2(codexHome),
      stdin: "",
      deadlineMs: input.deadlineMs,
    });

    const hostProductWrite = await pathExistsV2(join(workspace, PROBE_PRODUCT_ROOT, "product-write.txt"));
    const hostControlPlane = (await Promise.all([
      pathExistsV2(join(workspace, ".rb-harness", "forbidden.txt")),
      pathExistsV2(join(workspace, ".rb", "forbidden.txt")),
      pathExistsV2(join(workspace, ".git", "forbidden.txt")),
      pathExistsV2(join(workspace, "staging-root-write.txt")),
    ])).some(Boolean);
    const {
      credentialFileBoundary,
      stagingWriteCapability,
      controlPlaneDenialCapability,
      networkDenialCapability,
      shellEnvironmentIsolationCapability,
    } = evaluateCodexProbeMarkersV2(run.stdout, { hostProductWrite, hostControlPlane });

    const root = await probeCodexRootScopeCapabilityV2({ deadlineMs: input.deadlineMs, codexHome, executablePath, authPath });

    const base = {
      schema: CODEX_CAPABILITY_PROBE_SCHEMA_V2,
      credentialFileBoundary,
      stagingWriteCapability,
      controlPlaneDenialCapability,
      networkDenialCapability,
      shellEnvironmentIsolationCapability,
      permissionProfileDigest: profile.profileDigest,
      permissionPolicyShapeDigest: codexPermissionPolicyShapeDigestV2(profile),
      probeExitCode: run.exitCode,
      rootProductWriteCapability: root.rootProductWriteCapability,
      rootSentinelDenialCapability: root.rootSentinelDenialCapability,
      rootPermissionProfileDigest: root.rootPermissionProfileDigest,
      rootPermissionPolicyShapeDigest: root.rootPermissionPolicyShapeDigest,
      rootSentinelCount: root.rootSentinelCount,
      rootAttackCount: root.rootAttackCount,
      rootMatrixDigest: root.rootMatrixDigest,
      rootProbeExitCode: root.rootProbeExitCode,
      observedAt: run.finishedAt,
    };
    return Object.freeze({ ...base, reportDigest: sha256Canonical(base) });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

interface CodexRootProbeOutcomeV2 {
  readonly rootProductWriteCapability: CodexCapabilityStateV2;
  readonly rootSentinelDenialCapability: CodexCapabilityStateV2;
  readonly rootPermissionProfileDigest: string;
  readonly rootPermissionPolicyShapeDigest: string;
  readonly rootSentinelCount: number;
  readonly rootAttackCount: number;
  readonly rootMatrixDigest: string;
  readonly rootProbeExitCode: number | null;
}

/**
 * Exercise the exact ROOT-WRITE permission profile, without a model.
 *
 * The projection here has the shape a root-scope Attempt will have: a
 * writable staging root, root-level product files, and one protected sentinel
 * per control-plane root — materialized with the same constants and verified
 * with the same production function the real dispatch uses.
 *
 * Both halves must agree.  The sandbox's own markers say what it observed;
 * the host independently re-reads the filesystem, and a matrix where the two
 * disagree is UNPROVEN rather than quietly accepted.
 */
async function probeCodexRootScopeCapabilityV2(input: {
  readonly deadlineMs: number;
  readonly codexHome: string;
  readonly executablePath: string;
  readonly authPath: string;
}): Promise<CodexRootProbeOutcomeV2> {
  const sentinelRoots = [...CODEX_PROJECTION_EXCLUDED_ROOTS_V2].sort();
  const workspace = await mkdtemp(resolve(tmpdir(), "rb-ralph-m5b-root-capability-"));
  try {
    await mkdir(join(workspace, PROBE_PRODUCT_ROOT), { recursive: true, mode: 0o700 });
    await writeFile(join(workspace, "README.md"), "rb-ralph m5b root capability probe\n", { mode: 0o600 });
    const sentinels: CodexSentinelEntryV2[] = [];
    for (const sentinelRoot of sentinelRoots) {
      const target = join(workspace, sentinelRoot);
      await mkdir(target, { recursive: false, mode: CODEX_SENTINEL_MODE_V2 });
      await chmod(target, CODEX_SENTINEL_MODE_V2);
      sentinels.push(Object.freeze({
        path: sentinelRoot,
        kind: "directory" as const,
        mode: CODEX_SENTINEL_MODE_V2,
        childCount: 0 as const,
        identityDigest: codexSentinelIdentityDigestV2(sentinelRoot, CODEX_SENTINEL_MODE_V2),
      }));
    }
    const manifest = { stagingRootWritable: true as const, sentinels: Object.freeze(sentinels) };
    const preimage = await captureCodexSentinelPreimageV2(workspace, manifest);

    const scriptPath = join(workspace, "root-capability-probe.sh");
    await writeFile(scriptPath, rootProbeScriptV2(sentinelRoots), { mode: 0o700 });

    const profile = buildCodexPermissionProfileV2({
      stagingWorkspace: workspace,
      stagingRootWritable: true,
      writableRoots: [],
      sentinelRoots,
      codexHome: input.codexHome,
      codexRuntimeReadRoot: codexRuntimeReadRootV2(input.executablePath),
    });
    if (!codexPermissionProfileGrantsRootWriteV2(profile)) {
      throw new RalphM5BError("M5B_PERMISSION_PROFILE_INVALID", "M5B_PERMISSION_PROFILE_INVALID: the root probe profile does not grant staging-root write");
    }

    const run = await runCodexProcessV2({
      executablePath: input.executablePath,
      argv: [
        "sandbox",
        "--permission-profile", profile.name,
        "--cd", workspace,
        ...codexPermissionProfileOverridesV2(profile).flatMap((override) => ["-c", override]),
        ...codexShellEnvironmentPolicyOverridesV2().flatMap((override) => ["-c", override]),
        "--",
        "/bin/sh", scriptPath, workspace, input.authPath,
      ],
      cwd: workspace,
      environment: codexParentEnvironmentV2(input.codexHome),
      stdin: "",
      deadlineMs: input.deadlineMs,
    });

    const markers = readMarkersV2(run.stdout);
    const completed = markers.get("DONE") === "1";
    const outcomes: Record<string, string> = {};
    for (const key of [...CODEX_ROOT_POSITIVE_CONTROLS_V2, ...CODEX_ROOT_PRODUCT_WRITES_V2, "AUTH_OPEN", "NETWORK", "CODEX_HOME_VISIBLE"]) {
      outcomes[key] = markers.get(key) ?? "ABSENT";
    }
    sentinelRoots.forEach((_root, index) => {
      for (const attack of CODEX_ROOT_SENTINEL_ATTACKS_V2) outcomes[`S${index}_${attack}`] = markers.get(`S${index}_${attack}`) ?? "ABSENT";
    });

    // Host-side truth for the product writes the sandbox claimed to make.
    const hostProduct = await Promise.all([
      pathExistsV2(join(workspace, "package.json")),
      pathExistsV2(join(workspace, "root-product.txt")),
      pathExistsV2(join(workspace, "root-product-dir", "nested.txt")),
      readFile(join(workspace, "README.md"), "utf8").then((text) => text.trim() === "rewritten").catch(() => false),
    ]);

    // Host-side truth for the sentinels, using the SAME verification the real
    // Attempt runs before publication.
    let sentinelsIntact = true;
    try { await verifyCodexRootSentinelsV2(workspace, manifest, preimage); }
    catch { sentinelsIntact = false; }

    const positiveControlsProven = CODEX_ROOT_POSITIVE_CONTROLS_V2.every((key) => outcomes[key] === "ALLOW");
    const productWritesProven = CODEX_ROOT_PRODUCT_WRITES_V2.every((key) => outcomes[key] === "ALLOW") && hostProduct.every(Boolean);
    const attacksDenied = sentinelRoots.every((_root, index) =>
      CODEX_ROOT_SENTINEL_ATTACKS_V2.every((attack) => outcomes[`S${index}_${attack}`] === "DENY"));

    const rootMatrixDigest = sha256Canonical({
      sentinelRoots,
      attacks: [...CODEX_ROOT_SENTINEL_ATTACKS_V2],
      outcomes,
      hostProductWrites: hostProduct,
      sentinelsIntact,
      completed,
    });

    return Object.freeze({
      // A denial only counts once the same tool has been shown to work on a
      // product path: otherwise a missing binary would read as security.
      rootProductWriteCapability: capability(completed && positiveControlsProven && productWritesProven),
      rootSentinelDenialCapability: capability(completed && positiveControlsProven && attacksDenied && sentinelsIntact),
      rootPermissionProfileDigest: profile.profileDigest,
      rootPermissionPolicyShapeDigest: codexPermissionPolicyShapeDigestV2(profile),
      rootSentinelCount: sentinelRoots.length,
      rootAttackCount: sentinelRoots.length * CODEX_ROOT_SENTINEL_ATTACKS_V2.length,
      rootMatrixDigest,
      rootProbeExitCode: run.exitCode,
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

/**
 * Backwards-compatible narrow view: only the credential-file boundary.
 * Retained because the boundary state is the single fail-closed condition the
 * inference gate is expressed in.
 */
export async function probeCodexCredentialFileBoundaryV2(
  input: ProbeCodexCapabilityInputV2 = { deadlineMs: 120_000 },
): Promise<CodexCapabilityProbeReportV2> {
  return probeCodexPhysicalCapabilityV2(input);
}

/**
 * The fail-closed pre-dispatch assertion.  Every physical capability must be
 * PROVEN and the credential boundary must be DENIED; anything else — including
 * an ambiguous or never-started probe — refuses the dispatch.
 */
export function assertCodexPhysicalCapabilityV2(report: CodexCapabilityProbeReportV2, profile?: CodexPermissionProfileV2): void {
  if (report.credentialFileBoundary !== "DENIED") {
    throw new RalphM5BError(
      "M5B_CREDENTIAL_FILE_BOUNDARY_UNSAFE",
      `M5B_CREDENTIAL_FILE_BOUNDARY_UNSAFE: the provider tool sandbox boundary is ${report.credentialFileBoundary}; no model-bearing dispatch is authorized`,
    );
  }
  for (const [label, state] of [
    ["staging write", report.stagingWriteCapability],
    ["control-plane denial", report.controlPlaneDenialCapability],
    ["network denial", report.networkDenialCapability],
    ["shell environment isolation", report.shellEnvironmentIsolationCapability],
    // The root-scope half is not optional even for a non-root Attempt: the
    // capability record declares one boundary, and it is either physically
    // established in full or it is not established.
    ["root product write", report.rootProductWriteCapability],
    ["root sentinel denial", report.rootSentinelDenialCapability],
  ] as const) {
    if (state !== "PROVEN") {
      throw new RalphM5BError("M5B_CREDENTIAL_FILE_BOUNDARY_UNSAFE", `M5B_CREDENTIAL_FILE_BOUNDARY_UNSAFE: ${label} is ${state}`);
    }
  }
  if (profile) {
    // The probe must have exercised the same POLICY the dispatch will use.
    // Absolute paths differ between the probe workspace and the Attempt
    // projection, so the comparison is on the role/access shape — and a
    // root-scope dispatch is compared against the ROOT half of the probe, so
    // a non-root profile can never stand in for a root one.
    const dispatched = codexPermissionPolicyShapeDigestV2(profile);
    const expected = codexPermissionProfileGrantsRootWriteV2(profile) ? report.rootPermissionPolicyShapeDigest : report.permissionPolicyShapeDigest;
    if (dispatched !== expected) {
      throw new RalphM5BError("M5B_PERMISSION_PROFILE_INVALID", "M5B_PERMISSION_PROFILE_INVALID: the probed policy shape is not the dispatched policy shape");
    }
  }
}

function capability(proven: boolean): CodexCapabilityStateV2 {
  return proven ? "PROVEN" : "UNPROVEN";
}

function readMarkersV2(stdout: string): ReadonlyMap<string, string> {
  const markers = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const match = line.trim().match(/^RBM5B ([A-Z0-9_]+)=(\S+)$/);
    if (match) markers.set(match[1]!, match[2]!);
  }
  return markers;
}

async function pathExistsV2(path: string): Promise<boolean> {
  try { await stat(path); return true; }
  catch { return false; }
}
