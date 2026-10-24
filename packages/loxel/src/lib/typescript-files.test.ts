import { describe, expect, test } from "bun:test";

import { hasTypeScriptDiagnostics } from "./typescript-files";

describe("hasTypeScriptDiagnostics", () => {
  test.each([
    "src/index.ts",
    "/abs/path/App.tsx",
    "lib/a.d.ts",
    "x.mts",
    "x.cts",
    "scripts/build.js",
    "Component.JSX",
    "esm.mjs",
    "cjs.cjs",
    "tsconfig.json",
    "packages/app/tsconfig.build.json",
  ])("%s → true", (path) => {
    expect(hasTypeScriptDiagnostics(path)).toBe(true);
  });

  test.each([
    "main.py",
    "stubs/mod.pyi",
    "package.json",
    "my-tsconfig.json",
    "tsconfig.json/readme.md",
    "Cargo.toml",
    "README.md",
    "Makefile",
    "ts",
  ])("%s → false", (path) => {
    expect(hasTypeScriptDiagnostics(path)).toBe(false);
  });
});
