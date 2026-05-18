/**
 * Bundles typescript-language-server into a single JS file (no standalone compile).
 *
 * Unlike other LSP build scripts, this does NOT compile to a standalone binary.
 * typescript-language-server internally uses ChildProcess.fork() to spawn tsserver.js,
 * which requires process.execPath to be a real JS runtime (node). A compiled Bun
 * binary would re-run its embedded code instead of forking tsserver.js.
 *
 * At runtime, loxel-server spawns: `node typescript-language-server.mjs --stdio`
 */

import path from "node:path";

import { resolvePackage } from "./resolve-package";

const LOXEL = path.resolve(import.meta.dir, "..");
const OUTDIR = path.join(LOXEL, "build");

const tslsDir = resolvePackage("typescript-language-server");
const entrypoint = path.join(tslsDir, "lib/cli.mjs");

const { version } = await Bun.file(path.join(tslsDir, "package.json")).json();

console.log(`Bundling typescript-language-server v${version}...`);

const result = await Bun.build({
  entrypoints: [entrypoint],
  target: "node",
  outdir: OUTDIR,
  naming: "typescript-language-server.mjs",
  plugins: [
    {
      name: "inline-package-version",
      setup(build) {
        build.onLoad({ filter: /cli\.mjs$/ }, async (args) => {
          const code = await Bun.file(args.path).text();
          const patched = code.replace(
            /readFileSync\(new URL\(['"]\.\.\/package\.json['"],\s*import\.meta\.url\),\s*\{[\s\S]*?encoding:\s*['"]utf8['"][\s\S]*?\}\)/,
            JSON.stringify(JSON.stringify({ version })),
          );
          if (patched === code) {
            throw new Error(
              "Version inline patch failed to match — typescript-language-server source may have changed",
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

console.log(`Built: ${path.join(OUTDIR, "typescript-language-server.mjs")}`);
