import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { build } from "esbuild";

const packageRoot = resolve(import.meta.dirname, "..");
const dist = resolve(packageRoot, "dist");
const pluginScripts = resolve(packageRoot, "../../plugins/rb-harness/scripts");
const pluginCli = resolve(pluginScripts, "rb-harness.cjs");
const obsoletePluginCli = resolve(pluginScripts, "rb-harness.mjs");
const resources = resolve(packageRoot, "../../resources");
const contracts = resolve(packageRoot, "../../contracts");
const pluginResources = resolve(packageRoot, "../../plugins/rb-harness/standalone-resources");
const pluginContracts = resolve(packageRoot, "../../plugins/rb-harness/contracts");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(resources, resolve(dist, "resources"), { recursive: true });
await cp(contracts, resolve(dist, "contracts"), { recursive: true });
await rm(pluginResources, { recursive: true, force: true });
await cp(resources, pluginResources, { recursive: true });
await rm(pluginContracts, { recursive: true, force: true });
await cp(contracts, pluginContracts, { recursive: true });
await mkdir(pluginScripts, { recursive: true });
await rm(obsoletePluginCli, { force: true });

await build({
  entryPoints: [resolve(packageRoot, "src/index.ts")],
  outfile: resolve(dist, "index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  packages: "external",
});

await build({
  entryPoints: [resolve(packageRoot, "src/cli.ts")],
  outfile: resolve(dist, "cli.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  packages: "external",
  banner: { js: "#!/usr/bin/env node" },
});

await build({
  entryPoints: [resolve(packageRoot, "src/cli.ts")],
  outfile: pluginCli,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  packages: "bundle",
  minify: true,
  banner: { js: "#!/usr/bin/env node" },
});

await chmod(resolve(dist, "cli.js"), 0o755);
await chmod(pluginCli, 0o755);

const bundle = await readFile(pluginCli);
const packageMetadata = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
await writeFile(
  resolve(dist, "headless-init-bundle.json"),
  `${JSON.stringify({
    contract: "rb-headless-init/v1",
    version: packageMetadata.version,
    artifact: "plugins/rb-harness/scripts/rb-harness.cjs",
    sha256: createHash("sha256").update(bundle).digest("hex"),
  }, null, 2)}\n`,
  "utf8",
);
await writeFile(
  resolve(dist, "headless-interview-bundle.json"),
  `${JSON.stringify({
    contract: "rb-headless-interview/v1",
    version: packageMetadata.version,
    artifact: "plugins/rb-harness/scripts/rb-harness.cjs",
    sha256: createHash("sha256").update(bundle).digest("hex"),
  }, null, 2)}\n`,
  "utf8",
);
