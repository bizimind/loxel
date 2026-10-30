import { describe, expect, test } from "bun:test";

import { BUILTIN_FILE_ASSOCIATIONS } from "@/store/settings-store";

import { toMonacoLanguage } from "./monaco-theme";
import { resolveLanguage } from "./resolve-language";

function resolve(path: string, content?: string): string | null {
  return resolveLanguage(path, BUILTIN_FILE_ASSOCIATIONS, content);
}

describe("resolveLanguage for Python projects", () => {
  test.each([
    ["/repo/app.py", "python"],
    ["/repo/stubs/module.pyi", "python"],
    ["/repo/gui.pyw", "python"],
    ["/repo/pyproject.toml", "toml"],
    ["/repo/ruff.toml", "toml"],
    ["/repo/uv.lock", "toml"],
    ["/repo/poetry.lock", "toml"],
    ["/repo/Pipfile", "toml"],
    ["/repo/Pipfile.lock", "json"],
    ["/repo/requirements.txt", "pip-requirements"],
    ["/repo/requirements-dev.txt", "pip-requirements"],
    ["/repo/requirements.in", "pip-requirements"],
    ["/repo/requirements/base.txt", "pip-requirements"],
    ["/repo/constraints.txt", "pip-requirements"],
  ])("%s → %s", (path, language) => {
    expect(resolve(path)).toBe(language);
  });

  test("matches directory globs under dot directories", () => {
    expect(resolve("/home/me/repo/.worktrees/fix/x/requirements/dev.txt")).toBe("pip-requirements");
    expect(resolve("/repo/.vscode/settings.json")).toBe("jsonc");
  });

  test("leaves other text files alone", () => {
    expect(resolve("/repo/notes.txt")).toBeNull();
  });

  test("sniffs extensionless Python scripts by shebang", () => {
    expect(resolve("/repo/bin/manage", "#!/usr/bin/env python3\nprint(1)\n")).toBe("python");
  });
});

describe("resolveLanguage for JavaScript tooling", () => {
  test.each([
    // These tools accept comments, so strict-JSON markers would be wrong.
    ["/repo/.babelrc", "jsonc"],
    ["/repo/.babelrc.json", "jsonc"],
    ["/repo/babel.config.json", "jsonc"],
    ["/repo/.eslintrc", "jsonc"],
    ["/repo/.eslintrc.json", "jsonc"],
    ["/repo/.jshintrc", "jsonc"],
    ["/repo/.mocharc.json", "jsonc"],
    ["/repo/.mocharc.jsonc", "jsonc"],
    ["/repo/.oxfmtrc.json", "jsonc"],
    ["/repo/.oxlintrc.json", "jsonc"],
    ["/repo/.swcrc", "jsonc"],
    ["/repo/biome.jsonc", "jsonc"],
    ["/repo/bun.lock", "jsonc"],
    ["/repo/jsconfig.json", "jsonc"],
    ["/repo/lerna.json", "jsonc"],
    // These tools reject comments.
    ["/repo/.c8rc", "json"],
    ["/repo/.nycrc", "json"],
    ["/repo/.prettierrc.json", "json"],
    ["/repo/biome.json", "json"],
    ["/repo/package.json", "json"],
    // These tools parse the file as YAML, which covers their JSON form too.
    ["/repo/.commitlintrc", "yaml"],
    ["/repo/.lintstagedrc", "yaml"],
    ["/repo/.prettierrc", "yaml"],
    ["/repo/.releaserc", "yaml"],
    ["/repo/.eslintrc.yml", "yaml"],
    ["/repo/pnpm-workspace.yaml", "yaml"],
    ["/repo/src/app.js", "javascript"],
    ["/repo/src/app.mjs", "javascript"],
    ["/repo/src/app.cjs", "javascript"],
    ["/repo/src/app.jsx", "jsx"],
  ])("%s → %s", (path, language) => {
    expect(resolve(path)).toBe(language);
  });
});

describe("resolveLanguage for build files", () => {
  test.each([
    ["/repo/Makefile", "make"],
    ["/repo/makefile", "make"],
    ["/repo/GNUmakefile", "make"],
    ["/repo/build/rules.mk", "make"],
    ["/repo/justfile", "just"],
    ["/repo/.justfile", "just"],
    ["/repo/tasks.just", "just"],
  ])("%s → %s", (path, language) => {
    expect(resolve(path)).toBe(language);
  });
});

describe("toMonacoLanguage", () => {
  test("keeps TOML as its own Monaco language so it gets the TOML grammar", () => {
    expect(toMonacoLanguage("toml")).toBe("toml");
  });

  test("passes custom languages through", () => {
    expect(toMonacoLanguage("pip-requirements")).toBe("pip-requirements");
  });
});
