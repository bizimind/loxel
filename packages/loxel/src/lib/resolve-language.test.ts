import { describe, expect, test } from "bun:test";

import { BUILTIN_FILE_ASSOCIATIONS } from "@/store/settings-store";

import { toMonacoLanguage } from "./monaco-theme";
import { languageNeedsContent, resolveLanguage } from "./resolve-language";

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

describe("resolveLanguage for shebang scripts", () => {
  test.each([
    ["#!/usr/bin/env node\n", "javascript"],
    ["#!/usr/local/bin/node\n", "javascript"],
    ["#! /usr/bin/env node\n", "javascript"],
    ["#!/bin/env node\n", "javascript"],
    ["#!/usr/bin/env nodejs\n", "javascript"],
    ["#!/usr/bin/env -S node --no-warnings\n", "javascript"],
    ["#!/usr/bin/env -S NODE_ENV=production node\n", "javascript"],
    ["#!/usr/bin/env -i node\r\n", "javascript"],
    ["#!/usr/bin/env -Snode --no-warnings\n", "javascript"],
    ["#!/usr/bin/env -u DEBUG node\n", "javascript"],
    ["#!/usr/bin/env -C /srv node\n", "javascript"],
    ["#!/usr/bin/env -S npx -p typescript -p ts-node ts-node\n", "typescript"],
    ["#!/usr/bin/env bun\n", "javascript"],
    ["#!/usr/bin/env tsx\n", "typescript"],
    ["#!/usr/bin/env -S npx tsx\n", "typescript"],
    ["#!/usr/bin/env -S npx --yes ts-node\n", "typescript"],
    ["#!/usr/bin/env ts-node\n", "typescript"],
    ["#!/usr/bin/env ts-node-esm\n", "typescript"],
    ["#!/usr/bin/env -S deno run --allow-net\n", "typescript"],
    ["#!/bin/sh\n", "bash"],
    ["#!/usr/bin/env -S python3 -u\n", "python"],
  ])("%j → %s", (content, language) => {
    expect(resolve("/repo/bin/www", content)).toBe(language);
  });

  test.each([
    "#!/usr/bin/env\n",
    "#!/usr/bin/env -S\n",
    "#!/usr/bin/env constructor\n",
    "#!\n",
    "# node\n",
    " #!/usr/bin/env node\n",
    "\n#!/usr/bin/env node\n",
    "#!/opt/unknown\nnode\n",
  ])("names no language for %j", (content) => {
    expect(resolve("/repo/bin/www", content)).toBeNull();
  });

  test("the path wins over the shebang", () => {
    expect(resolve("/repo/bin/a.py", "#!/usr/bin/env node\n")).toBe("python");
  });
});

describe("languageNeedsContent", () => {
  test.each(["/repo/a.js", "/repo/a.ts", "/repo/a.py", "/repo/Dockerfile", "/repo/data.json"])(
    "%s opens by its name, without waiting for content",
    (path) => {
      expect(languageNeedsContent(path, BUILTIN_FILE_ASSOCIATIONS)).toBe(false);
    },
  );

  test("a file association names the language", () => {
    const associations = [{ id: "www", glob: "**/bin/www", language: "javascript", enabled: true }];
    expect(languageNeedsContent("/repo/bin/www", associations)).toBe(false);
  });

  test("an extensionless script waits for its content", () => {
    expect(languageNeedsContent("/repo/bin/www", BUILTIN_FILE_ASSOCIATIONS)).toBe(true);
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
