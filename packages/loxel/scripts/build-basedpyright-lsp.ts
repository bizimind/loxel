/**
 * Builds basedpyright-langserver into a standalone Bun binary.
 *
 * basedpyright ships its language server as one pre-bundled CommonJS file
 * (dist/pyright-langserver.js) that finds its bundled typeshed stubs through
 * `global.__rootDirectory`, which the npm package's bin shim sets. A wrapper
 * entry does the same relative to the running binary, and `bun build --compile`
 * turns it into a standalone binary (with a Bun workaround, see the entry). The
 * `typeshed-fallback` directory is copied alongside.
 */

import fs from "node:fs";
import path from "node:path";

import { resolvePackage } from "./resolve-package";

const LOXEL = path.resolve(import.meta.dir, "..");
const OUTDIR = path.join(LOXEL, "build");

const distDir = path.join(resolvePackage("basedpyright"), "dist");

const intermediateDir = path.join(OUTDIR, ".basedpyright-lsp-intermediate");
fs.mkdirSync(intermediateDir, { recursive: true });

const entryPath = path.join(intermediateDir, "entry.js");
fs.writeFileSync(
  entryPath,
  `const os = require("os");
const path = require("path");
const v8 = require("v8");
// Use process.execPath so __rootDirectory resolves to the directory containing
// the running binary at runtime (not the build-time path of the npm package).
global.__rootDirectory = path.dirname(process.execPath) + "/";
// basedpyright reads v8.getHeapStatistics() for every file it checks to decide whether
// to empty its caches. Bun implements it with a full heap walk and reports a heap limit
// of a few tens of MB, which makes completions and code actions take ~10 s instead of
// milliseconds. Report Bun's cheap memory counters (strings and buffers live in
// \`external\` under Bun, on the heap under V8) against a limit like Node's default
// (a quarter of RAM, at most 4 GiB). basedpyright captures the function when it loads,
// so this must run first.
const HEAP_SIZE_LIMIT = Math.min(4 * 1024 ** 3, os.totalmem() / 4);
v8.getHeapStatistics = () => {
  const memory = process.memoryUsage();
  return {
    total_heap_size: memory.heapTotal,
    total_heap_size_executable: 0,
    total_physical_size: memory.rss,
    total_available_size: Math.max(0, HEAP_SIZE_LIMIT - memory.heapUsed - memory.external),
    used_heap_size: memory.heapUsed + memory.external,
    heap_size_limit: HEAP_SIZE_LIMIT,
    malloced_memory: 0,
    peak_malloced_memory: 0,
    does_zap_garbage: 0,
    number_of_native_contexts: 0,
    number_of_detached_contexts: 0,
    total_global_handles_size: 0,
    used_global_handles_size: 0,
    external_memory: memory.external,
  };
};
require(${JSON.stringify(path.join(distDir, "pyright-langserver.js"))});
`,
);

console.log("Compiling basedpyright-langserver to a standalone binary...");

const outfile = path.join(OUTDIR, "basedpyright-langserver");

const compile = Bun.spawn(["bun", "build", entryPath, "--compile", "--outfile", outfile], {
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
