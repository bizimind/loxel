#!/usr/bin/env bun
/**
 * Build script for code-analysis CLI.
 *
 * dependency-cruiser has three incompatibilities with Bun's ahead-of-time bundler:
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
 * 3. `javascript-wrap.mjs` resolves Acorn with `createRequire(import.meta.url)`
 *    solely to report its version. In a compiled binary that URL points into
 *    `$bunfs`, where package resolution is unavailable. Patched to use Acorn's
 *    public static `version` export, which Bun can bundle normally.
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
  {
    // Patch 4: replace Acorn's runtime require with its public static export.
    path: join(nmDir, "extract/transpile/javascript-wrap.mjs"),
    apply(_content) {
      return [
        `import { version } from "acorn";`,
        ``,
        `export default {`,
        `  isAvailable: () => true,`,
        `  version: () => \`acorn@\${version}\`,`,
        `  transpile: (pSource) => pSource,`,
        `};`,
      ].join("\n");
    },
  },
];

let exitCode = 0;
try {
  // Verify all patch targets exist and apply patches.
  for (const patch of patches) {
    if (!existsSync(patch.path)) {
      throw new Error(`build: cannot find ${patch.path}`);
    }
    patch.original = readFileSync(patch.path, "utf-8");
    const patched = patch.apply(patch.original);
    if (patched === patch.original) {
      throw new Error(
        `build: patch target not found in ${patch.path} — dependency-cruiser may have updated its internals`,
      );
    }
    writeFileSync(patch.path, patched);
  }

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

if (exitCode === 0) {
  const verification = Bun.spawn(
    [join(dir, "dist/code-analysis"), "run", "-p", "import-graph", "-w", "src", "--json"],
    { cwd: dir, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, verificationExitCode] = await Promise.all([
    new Response(verification.stdout).text(),
    new Response(verification.stderr).text(),
    verification.exited,
  ]);

  if (verificationExitCode !== 0) {
    process.stderr.write(stderr);
    exitCode = verificationExitCode;
  } else {
    const records: unknown = JSON.parse(stdout);
    const hasTypeScriptEdge =
      Array.isArray(records) &&
      records.some(
        (record) =>
          typeof record === "object" &&
          record !== null &&
          "source" in record &&
          "target" in record &&
          typeof record.source === "string" &&
          typeof record.target === "string" &&
          record.source.endsWith(".ts") &&
          record.target.endsWith(".ts"),
      );

    if (!hasTypeScriptEdge) {
      process.stderr.write("build: compiled import-graph smoke test found no TypeScript edge\n");
      exitCode = 1;
    }
  }
}

process.exit(exitCode);
