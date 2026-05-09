#!/usr/bin/env bun
/**
 * Build script for code-analysis CLI.
 *
 * dependency-cruiser has two incompatibilities with Bun's ahead-of-time bundler:
 *
 * 1. `report/index.mjs` uses `import(variable)` for reporter selection — Bun
 *    can't bundle dynamic imports with non-literal strings. Patched to use
 *    static import literals for the two reporters we need.
 *
 * 2. `extract/transpile/try-import-available.mjs` probes for `typescript` via
 *    `createRequire(import.meta.url)`. In a compiled binary import.meta.url
 *    points at $bunfs, so the probe fails and `.ts`/`.tsx` are excluded from
 *    `scannableExtensions` → 0 modules found. Additionally, `typescript-wrap.mjs`
 *    dynamically imports the 9.4 MB `typescript` package.
 *    Patched: `typescript-wrap.mjs` is replaced with a `Bun.Transpiler`-based
 *    implementation (always available in compiled binaries), and
 *    `try-import-available.mjs` is patched to return `true` for `typescript`.
 *
 * All patches are applied before `bun build --compile` and restored afterward.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = import.meta.dir;
const nmDir = join(dir, "node_modules/dependency-cruiser/src");

interface Patch {
  path: string;
  original?: string;
  apply(content: string): string;
}

const patches: Patch[] = [
  {
    // Patch 1: replace dynamic reporter import with static import literals.
    path: join(nmDir, "report/index.mjs"),
    apply(content) {
      return content.replace(
        "const lModule = await import(lModuleToImport);",
        [
          `const lModule = await (`,
          `  lModuleToImport === "./json.mjs"     ? import("./json.mjs") :`,
          `  lModuleToImport === "./identity.mjs" ? import("./identity.mjs") :`,
          `  Promise.reject(new Error("Reporter not bundled: " + lModuleToImport))`,
          `);`,
        ].join("\n"),
      );
    },
  },
  {
    // Patch 2: make tryAvailable return true for "typescript" so that .ts/.tsx
    // are included in scannableExtensions even when the typescript package can't
    // be resolved via require (which fails in compiled binaries).
    path: join(nmDir, "extract/transpile/try-import-available.mjs"),
    apply(content) {
      return content.replace(
        "export default function tryImportAvailable(pModuleName, pSemanticVersion) {",
        [
          `export default function tryImportAvailable(pModuleName, pSemanticVersion) {`,
          `  // In compiled Bun binaries require.resolve can't probe npm packages.`,
          `  // TypeScript parsing is handled by the patched typescript-wrap.mjs below.`,
          `  if (pModuleName === "typescript") return true;`,
        ].join("\n"),
      );
    },
  },
  {
    // Patch 3: replace the typescript-wrap module with a Bun.Transpiler-based
    // implementation. This avoids bundling the 9.4 MB typescript package and
    // works in compiled binaries where dynamic import("typescript") would fail.
    path: join(nmDir, "extract/transpile/typescript-wrap.mjs"),
    apply(_content) {
      return [
        `// Patched by build.ts: uses Bun.Transpiler instead of the typescript package.`,
        `export default function typescriptWrap(_pFlavor) {`,
        `  return {`,
        `    isAvailable: () => true,`,
        `    version: () => "bun",`,
        `    transpile: (pSource, _pFileName, _pTranspileOptions = {}) => {`,
        `      const t = new Bun.Transpiler({ loader: "tsx" });`,
        `      return t.transformSync(pSource);`,
        `    },`,
        `  };`,
        `}`,
      ].join("\n");
    },
  },
];

// Verify all patch targets exist and apply patches.
for (const patch of patches) {
  if (!existsSync(patch.path)) {
    process.stderr.write(`build: cannot find ${patch.path}\n`);
    process.exit(1);
  }
  patch.original = readFileSync(patch.path, "utf-8");
  const patched = patch.apply(patch.original);
  if (patched === patch.original && patches.indexOf(patch) < 2) {
    // Patch 3 always changes (full replacement), patches 1-2 must find their target.
    process.stderr.write(
      `build: patch target not found in ${patch.path} — dependency-cruiser may have updated its internals\n`,
    );
    process.exit(1);
  }
  writeFileSync(patch.path, patched);
}

let exitCode = 0;
try {
  const proc = Bun.spawn(
    [
      "bun",
      "build",
      "--compile",
      "--minify",
      "src/cli.ts",
      "--outfile",
      "dist/code-analysis",
      "--external",
      "tsconfig-paths-webpack-plugin",
    ],
    { cwd: dir, stdout: "inherit", stderr: "inherit" },
  );
  exitCode = await proc.exited;
} finally {
  for (const patch of patches) {
    if (patch.original !== undefined) {
      writeFileSync(patch.path, patch.original);
    }
  }
}

process.exit(exitCode);
