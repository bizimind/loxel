/**
 * Builds pyright-langserver into a standalone Bun binary.
 *
 * Pyright ships as a pre-bundled webpack build with three chunks loaded via dynamic
 * require() at runtime (vendor.js, pyright-internal.js, pyright-langserver.js).
 * A naive `bun build --compile` fails because the compiled binary has no adjacent
 * chunk files to require() from disk.
 *
 * Two-step process:
 *   1. Bun.build() with a plugin that patches the webpack runtime's dynamic
 *      require("./"+chunkName) to read from a global lookup populated by the
 *      entry wrapper → single JS bundle with all chunks inlined
 *   2. bun build --compile on the resulting bundle → standalone binary
 */

import fs from "node:fs";
import path from "node:path";

const LOXEL = path.resolve(import.meta.dir, "..");
const OUTDIR = path.join(LOXEL, "build");

function resolvePackage(name: string): string {
  const pkgJson = require.resolve(`${name}/package.json`);
  return path.dirname(pkgJson);
}

const pyrightDir = resolvePackage("pyright");
const distDir = path.join(pyrightDir, "dist");

console.log("Step 1: Bundling pyright-langserver with embedded webpack chunks...");

const intermediateDir = path.join(OUTDIR, ".pyright-lsp-intermediate");
fs.mkdirSync(intermediateDir, { recursive: true });

for (const name of ["vendor.js", "pyright-internal.js", "pyright-langserver.js"]) {
  fs.copyFileSync(path.join(distDir, name), path.join(intermediateDir, name));
}

// Wrapper entry: load chunks into a global map, then run the patched langserver
const entryPath = path.join(intermediateDir, "entry.js");
fs.writeFileSync(
  entryPath,
  `const path = require("path");
// Use process.execPath so __rootDirectory resolves to the directory containing
// the running binary at runtime (not the build-time intermediate path).
global.__rootDirectory = path.dirname(process.execPath) + "/";
global.__pyright_chunks = {
  "vendor.js": require("./vendor.js"),
  "pyright-internal.js": require("./pyright-internal.js"),
};
require("./pyright-langserver.js");
`,
);

const result = await Bun.build({
  entrypoints: [entryPath],
  target: "bun",
  outdir: intermediateDir,
  naming: "bundled-entry.js",
  plugins: [
    {
      name: "patch-webpack-chunk-require",
      setup(build) {
        build.onLoad({ filter: /pyright-langserver\.js$/ }, async (args) => {
          let code = await Bun.file(args.path).text();
          // Replace the webpack runtime's dynamic require with global chunk lookup.
          // Original: require("./"+o.u(e))
          // Patched:  global.__pyright_chunks[o.u(e)]
          const patched = code.replace('require("./"+o.u(e))', "global.__pyright_chunks[o.u(e)]");
          if (patched === code) {
            throw new Error(
              "Webpack chunk patch failed to match — pyright bundle format may have changed",
            );
          }
          return { contents: patched, loader: "js" };
        });
      },
    },
  ],
});

if (!result.success) {
  console.error("Bundle step failed:");
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

console.log("Step 1 complete.");

console.log("Step 2: Compiling to standalone binary...");

const intermediateJs = path.join(intermediateDir, "bundled-entry.js");
const outfile = path.join(OUTDIR, "pyright-langserver");

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

console.log("Copying typeshed-fallback alongside binary...");
const typeshedSrc = path.join(distDir, "typeshed-fallback");
const typeshedDst = path.join(OUTDIR, "typeshed-fallback");
fs.rmSync(typeshedDst, { recursive: true, force: true });
fs.cpSync(typeshedSrc, typeshedDst, { recursive: true });
console.log(`Copied typeshed-fallback: ${typeshedSrc} -> ${typeshedDst}`);
