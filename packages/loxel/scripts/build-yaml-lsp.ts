/**
 * Builds the yaml-language-server into a standalone Bun binary.
 *
 * Several dependencies (vscode-json-languageservice, jsonc-parser, vscode-languageserver-textdocument)
 * use UMD module format with dynamic require() inside factory functions that Bun's bundler cannot
 * statically analyze. This build script redirects those packages to their ESM entry points so the
 * bundler can trace all imports correctly.
 *
 * Two-step process:
 *   1. Bun.build() with a plugin that rewrites UMD → ESM imports → single JS bundle
 *   2. bun build --compile on the resulting bundle → standalone binary
 */

import path from "node:path";

const LOXEL = path.resolve(import.meta.dir, "..");
const OUTDIR = path.join(LOXEL, "build");

import { resolvePackage } from "./resolve-package";

const yamlLspDir = resolvePackage("yaml-language-server");
// These are transitive deps of yaml-language-server — resolve from its directory
const jsonLsDir = resolvePackage("vscode-json-languageservice", yamlLspDir);
const jsoncParserDir = resolvePackage("jsonc-parser", yamlLspDir);
const textDocDir = resolvePackage("vscode-languageserver-textdocument", yamlLspDir);

// Step 1: Bundle with UMD → ESM redirects
console.log("Step 1: Bundling yaml-language-server with ESM redirects...");

const result = await Bun.build({
  entrypoints: [path.join(yamlLspDir, "out/server/src/server.js")],
  target: "bun",
  outdir: path.join(OUTDIR, ".yaml-lsp-intermediate"),
  plugins: [
    {
      name: "umd-to-esm",
      setup(build) {
        // Stub l10n setup — the bundle path gets baked as an absolute CI path
        // by bun --compile. Translations are non-essential (English fallback).
        build.onLoad({ filter: /nodeTranslationSetup/ }, () => ({
          contents: "export async function setupl10nBundle() {}",
          loader: "js",
        }));

        // vscode-json-languageservice: redirect bare and deep UMD imports to ESM
        build.onResolve({ filter: /vscode-json-languageservice/ }, (args) => {
          const esmPath = args.path.replace("/lib/umd/", "/lib/esm/");
          if (esmPath === "vscode-json-languageservice") {
            return { path: path.join(jsonLsDir, "lib/esm/jsonLanguageService.js") };
          }
          const subpath = esmPath.replace("vscode-json-languageservice/", "");
          return { path: path.join(jsonLsDir, subpath + ".js") };
        });

        // jsonc-parser: UMD → ESM
        build.onResolve({ filter: /^jsonc-parser$/ }, () => {
          return { path: path.join(jsoncParserDir, "lib/esm/main.js") };
        });

        // vscode-languageserver-textdocument: UMD → ESM
        build.onResolve({ filter: /^vscode-languageserver-textdocument$/ }, () => {
          return { path: path.join(textDocDir, "lib/esm/main.js") };
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

// Step 2: Compile to standalone binary
console.log("Step 2: Compiling to standalone binary...");

const intermediateJs = path.join(OUTDIR, ".yaml-lsp-intermediate/server.js");
const outfile = path.join(OUTDIR, "yaml-language-server");

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
