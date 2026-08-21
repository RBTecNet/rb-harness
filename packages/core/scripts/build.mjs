import { chmod, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

const packageRoot = resolve(import.meta.dirname, "..");
const dist = resolve(packageRoot, "dist");
const pluginScripts = resolve(packageRoot, "../../plugins/rb-harness/scripts");
const pluginCli = resolve(pluginScripts, "rb-harness.cjs");
const obsoletePluginCli = resolve(pluginScripts, "rb-harness.mjs");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
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
  minify: true,
  banner: { js: "#!/usr/bin/env node" },
});

await chmod(resolve(dist, "cli.js"), 0o755);
await chmod(pluginCli, 0o755);
