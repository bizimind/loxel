/**
 * Builds the yaml-language-server into a standalone Bun binary.
 *
 * Two-step process:
 *   1. Bun.build() of the package's ESM server entry → single JS bundle
 *   2. bun build --compile on the resulting bundle → standalone binary
 */

import path from "node:path";

import { resolvePackage } from "./resolve-package";

const LOXEL = path.resolve(import.meta.dir, "..");
const OUTDIR = path.join(LOXEL, "build");

const yamlLspDir = resolvePackage("yaml-language-server");

console.log("Step 1: Bundling yaml-language-server...");

const result = await Bun.build({
  entrypoints: [path.join(yamlLspDir, "out/src/server.js")],
  target: "bun",
  outdir: path.join(OUTDIR, ".yaml-lsp-intermediate"),
  plugins: [
    {
      name: "stub-l10n",
      setup(build) {
        // The translations' path gets baked in as an absolute CI path by bun --compile.
        // Translations are non-essential (English fallback).
        build.onLoad({ filter: /nodeTranslationSetup/ }, () => ({
          contents: "export async function setupl10nBundle() {}",
          loader: "js",
        }));

        // 2.0 matches `yaml.schemas` globs with picomatch's defaults (1.24 passed `bash: true`), so
        // `**` and `*` skip dot segments: `**/*.yaml` would miss every file in a worktree under
        // `.worktrees/`, in `.github/`, or named `.something.yaml`. `dot: true` matches them, as
        // Loxel's own `schemaGlobMatches` does for JSON and TOML.
        build.onLoad(
          { filter: /languageservice\/services\/yamlSchemaService\.js$/ },
          async (args) => {
            const source = await Bun.file(args.path).text();
            const options = "noglobstar: false,";
            const matchers = source.split(options).length - 1;
            if (matchers !== 2) {
              throw new Error(
                `Expected 2 picomatch calls with "${options}" in ${args.path}, found ${matchers}: update the dot-segment patch`,
              );
            }
            return { contents: source.replaceAll(options, `${options} dot: true,`), loader: "js" };
          },
        );
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

const intermediateJs = path.join(OUTDIR, ".yaml-lsp-intermediate/server.js");
const outfile = path.join(OUTDIR, "yaml-language-server");

const compile = Bun.spawn(
  [
    "bun",
    "build",
    intermediateJs,
    "--compile",
    "--no-compile-autoload-bunfig",
    "--no-compile-autoload-dotenv",
    "--outfile",
    outfile,
  ],
  { stdout: "inherit", stderr: "inherit" },
);
const exitCode = await compile.exited;
if (exitCode !== 0) {
  console.error("Compile step failed");
  process.exit(1);
}

console.log(`Built: ${outfile}`);
