/**
 * Builds @astrojs/language-server into a standalone Bun binary.
 *
 * The Astro LS uses the Volar framework (@volar/language-server/node) with CJS
 * require(). Bun.build() handles the entire dependency graph cleanly — no special
 * plugin patches needed.
 *
 * Two-step process:
 *   1. Bun.build() → single JS bundle
 *   2. bun build --compile on the bundle → standalone binary
 */

import path from "node:path";

const LOXEL = path.resolve(import.meta.dir, "..");
const OUTDIR = path.join(LOXEL, "build");

function resolvePackage(name: string): string {
  const pkgJson = require.resolve(`${name}/package.json`);
  return path.dirname(pkgJson);
}

const astroLsDir = resolvePackage("@astrojs/language-server");
const entrypoint = path.join(astroLsDir, "dist/nodeServer.js");

console.log("Step 1: Bundling @astrojs/language-server...");

const result = await Bun.build({
  entrypoints: [entrypoint],
  target: "bun",
  outdir: path.join(OUTDIR, ".astro-ls-intermediate"),
});

if (!result.success) {
  console.error("Bundle step failed:");
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

console.log("Step 1 complete.");

console.log("Step 2: Compiling to standalone binary...");

const intermediateJs = path.join(OUTDIR, ".astro-ls-intermediate/nodeServer.js");
const outfile = path.join(OUTDIR, "astro-ls");

const compile = Bun.spawn(["bun", "build", intermediateJs, "--compile", "--outfile", outfile], {
  stdout: "inherit",
  stderr: "inherit",
});
const exitCode = await compile.exited;
if (exitCode !== 0) {
  console.error("Compile step failed");
  process.exit(1);
}

console.log(`Built: ${outfile}`);
