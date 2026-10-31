import { describe, expect, test } from "bun:test";

import { classifySchemaGlob } from "@/lib/schema-glob";

import {
  BUILTIN_SCHEMA_DEFAULTS,
  DEFAULT_EDITOR_SETTINGS,
  type EditorSettings,
  type IndentationInputs,
  type ResolvedIndentation,
  resolveIndentation,
  type SettingsState,
  useSettingsStore,
} from "./settings-store";

function settings(overrides: EditorSettings["overrides"] = []): EditorSettings {
  return { ...DEFAULT_EDITOR_SETTINGS, overrides };
}

/** The resolved indentation alone. */
function indentation(
  editor: EditorSettings,
  filePath: string,
  inputs: IndentationInputs,
): ResolvedIndentation {
  return resolveIndentation(editor, filePath, inputs).indentation;
}

describe("resolveIndentation", () => {
  test("uses the global default for languages without a built-in default", () => {
    expect(indentation(settings(), "/repo/src/app.ts", { language: "typescript" })).toEqual({
      tabSize: 2,
      insertSpaces: true,
      indentSize: 2,
    });
    expect(indentation(settings(), "/repo/notes", { language: null })).toEqual({
      tabSize: 2,
      insertSpaces: true,
      indentSize: 2,
    });
  });

  test("uses built-in language defaults over the global default", () => {
    expect(indentation(settings(), "/repo/app.py", { language: "python" })).toEqual({
      tabSize: 4,
      insertSpaces: true,
      indentSize: 4,
    });
    expect(indentation(settings(), "/repo/main.go", { language: "go" })).toEqual({
      tabSize: 4,
      insertSpaces: false,
      indentSize: 4,
    });
    expect(indentation(settings(), "/repo/go.mod", { language: "go.mod" })).toEqual({
      tabSize: 4,
      insertSpaces: false,
      indentSize: 4,
    });
    expect(indentation(settings(), "/repo/go.work", { language: "go.work" })).toEqual({
      tabSize: 4,
      insertSpaces: false,
      indentSize: 4,
    });
    expect(indentation(settings(), "/repo/lib.rs", { language: "rust" })).toEqual({
      tabSize: 4,
      insertSpaces: true,
      indentSize: 4,
    });
  });

  test.each([
    ["/repo/Program.cs", "csharp"],
    ["/repo/Main.kt", "kotlin"],
    ["/repo/index.php", "php"],
    ["/repo/justfile", "just"],
  ])("indents %s with 4 spaces", (path, language) => {
    expect(indentation(settings(), path, { language })).toEqual({
      tabSize: 4,
      insertSpaces: true,
      indentSize: 4,
    });
  });

  test("indents Makefiles with tabs even when the content is mostly indented with spaces", () => {
    const resolution = resolveIndentation(settings(), "/repo/Makefile", {
      language: "make",
      detected: { insertSpaces: true, tabSize: 4, indentSize: 4 },
    });
    expect(resolution.indentation).toEqual({ tabSize: 4, insertSpaces: false, indentSize: 4 });
    expect(resolution.sources.insertSpaces).toBe("language");

    // A project or user that sets another style explicitly still wins.
    expect(
      indentation(settings(), "/repo/Makefile", {
        language: "make",
        editorConfig: { indentStyle: "space" },
      }).insertSpaces,
    ).toBe(true);
    const editor = settings([{ id: "1", extension: "mk", tabSize: 2, insertSpaces: true }]);
    expect(indentation(editor, "/repo/rules.mk", { language: "make" }).insertSpaces).toBe(true);
  });

  test("keys built-in defaults by resolved language, not extension", () => {
    // An extensionless script resolved as Python by its shebang.
    expect(indentation(settings(), "/repo/bin/manage", { language: "python" }).tabSize).toBe(4);
    // A .py file the user associated with another language.
    expect(indentation(settings(), "/repo/template.py", { language: "plaintext" }).tabSize).toBe(2);
  });

  test("a per-extension override wins over the built-in default, case-insensitively", () => {
    const editor = settings([{ id: "1", extension: "PY", tabSize: 2, insertSpaces: false }]);
    expect(indentation(editor, "/repo/App.Py", { language: "python" })).toEqual({
      tabSize: 2,
      insertSpaces: false,
      indentSize: 2,
    });
    // Overrides match the last extension only.
    expect(indentation(editor, "/repo/types.pyi", { language: "python" }).tabSize).toBe(4);
  });

  test("ignores dots in directory names and trailing dots", () => {
    const editor = settings([{ id: "1", extension: "d", tabSize: 8, insertSpaces: true }]);
    expect(indentation(editor, "/repo/conf.d/Makefile", { language: null }).tabSize).toBe(2);
    expect(indentation(editor, "/repo/file.", { language: null }).tabSize).toBe(2);
  });

  test(".editorconfig properties win over built-in and global defaults, one by one", () => {
    expect(
      indentation(settings(), "/repo/app.py", {
        language: "python",
        editorConfig: { indentStyle: "tab" },
      }),
    ).toEqual({ tabSize: 4, insertSpaces: false, indentSize: 4 });
    expect(
      indentation(settings(), "/repo/main.go", {
        language: "go",
        editorConfig: { indentSize: 2, tabWidth: 2 },
      }),
    ).toEqual({ tabSize: 2, insertSpaces: false, indentSize: 2 });
    expect(
      indentation(settings(), "/repo/app.ts", {
        language: "typescript",
        editorConfig: { indentStyle: "space", indentSize: 4, tabWidth: 8 },
      }),
    ).toEqual({ tabSize: 8, insertSpaces: true, indentSize: 4 });
    // tab_width alone is a tab's display width; the indent size stays the language default.
    expect(
      indentation(settings(), "/repo/app.ts", {
        language: "typescript",
        editorConfig: { indentStyle: "space", tabWidth: 4 },
      }),
    ).toEqual({ tabSize: 4, insertSpaces: true, indentSize: 2 });
    // Save-only properties leave indentation alone.
    expect(
      indentation(settings(), "/repo/app.ts", {
        language: "typescript",
        editorConfig: { insertFinalNewline: true },
      }),
    ).toEqual({ tabSize: 2, insertSpaces: true, indentSize: 2 });
  });

  test(".editorconfig wins over a per-extension override, which fills what it leaves out", () => {
    const editor = settings([{ id: "1", extension: "py", tabSize: 2, insertSpaces: true }]);
    const full = resolveIndentation(editor, "/repo/app.py", {
      language: "python",
      editorConfig: { indentStyle: "tab", indentSize: 8, tabWidth: 8 },
    });
    expect(full.indentation).toEqual({ tabSize: 8, insertSpaces: false, indentSize: 8 });
    expect(full.override?.extension).toBe("py");
    expect(full.sources).toEqual({
      insertSpaces: "editorconfig",
      tabSize: "editorconfig",
      indentSize: "editorconfig",
    });

    const partial = resolveIndentation(editor, "/repo/app.py", {
      language: "python",
      editorConfig: { indentStyle: "tab" },
    });
    expect(partial.indentation).toEqual({ tabSize: 2, insertSpaces: false, indentSize: 2 });
    expect(partial.sources).toEqual({
      insertSpaces: "editorconfig",
      tabSize: "override",
      indentSize: "override",
    });
  });

  test("detected indentation applies below .editorconfig and overrides, above defaults", () => {
    const fourSpaces = { insertSpaces: true, tabSize: 4, indentSize: 4 };
    const detected = resolveIndentation(settings(), "/repo/app.ts", {
      language: "typescript",
      detected: fourSpaces,
    });
    expect(detected.indentation).toEqual(fourSpaces);
    expect(detected.sources.indentSize).toBe("detected");

    // Tabs detected: the size, which content cannot tell, comes from the language default.
    expect(
      resolveIndentation(settings(), "/repo/main.py", {
        language: "python",
        detected: { insertSpaces: false },
      }).sources,
    ).toEqual({ insertSpaces: "detected", tabSize: "language", indentSize: "language" });

    expect(
      indentation(settings(), "/repo/app.ts", {
        language: "typescript",
        editorConfig: { indentStyle: "tab" },
        detected: fourSpaces,
      }),
    ).toEqual({ tabSize: 4, insertSpaces: false, indentSize: 4 });

    const editor = settings([{ id: "1", extension: "ts", tabSize: 2, insertSpaces: true }]);
    expect(
      indentation(editor, "/repo/app.ts", { language: "typescript", detected: fourSpaces }),
    ).toEqual({ tabSize: 2, insertSpaces: true, indentSize: 2 });
  });

  test("a choice made for the file wins over everything", () => {
    const editor = settings([{ id: "1", extension: "ts", tabSize: 8, insertSpaces: true }]);
    const resolution = resolveIndentation(editor, "/repo/app.ts", {
      language: "typescript",
      editorConfig: { indentStyle: "space", indentSize: 4, tabWidth: 4 },
      detected: { insertSpaces: true, tabSize: 2, indentSize: 2 },
      fileChoice: { insertSpaces: false },
    });
    expect(resolution.indentation).toEqual({ tabSize: 4, insertSpaces: false, indentSize: 4 });
    expect(resolution.sources.insertSpaces).toBe("file");
  });

  test("reports no override when none matches", () => {
    expect(resolveIndentation(settings(), "/repo/app.ts", { language: null }).override).toBeNull();
  });
});

describe("BUILTIN_SCHEMA_DEFAULTS", () => {
  test("only uses the schema host the privacy policy names", () => {
    for (const { url } of BUILTIN_SCHEMA_DEFAULTS) {
      expect(new URL(url).host).toBe("json.schemastore.org");
    }
  });

  test.each([
    ["**/jsconfig.json", { json: true, yaml: false, toml: false }],
    ["**/lerna.json", { json: true, yaml: false, toml: false }],
    ["**/pnpm-workspace.yaml", { json: false, yaml: true, toml: false }],
    // Monaco's JSON worker cannot load the sibling file this schema refers to.
    ["**/.eslintrc.{yml,yaml}", { json: false, yaml: true, toml: false }],
    // Without a final extension a glob reaches every language, covering the YAML form.
    ["**/.prettierrc{,.json,.yml,.yaml}", { json: true, yaml: true, toml: true }],
    ["**/.lintstagedrc{,.json,.yml,.yaml}", { json: true, yaml: true, toml: true }],
    ["**/{.babelrc,.babelrc.json,babel.config.json}", { json: true, yaml: true, toml: true }],
  ])("%s is built in and routes to its languages", (glob, languages) => {
    expect(BUILTIN_SCHEMA_DEFAULTS.some((schema) => schema.glob === glob)).toBe(true);
    expect(classifySchemaGlob(glob)).toEqual(languages);
  });
});

describe("settings migration", () => {
  const migrate = useSettingsStore.persist.getOptions().migrate;

  test("v11 settings get the automatic update check turned on", async () => {
    const migrated = (await migrate?.({ terminal: {} }, 11)) as SettingsState;
    expect(migrated.autoCheckForUpdates).toBe(true);
  });

  test("keeps an existing opt-out", async () => {
    const migrated = (await migrate?.({ autoCheckForUpdates: false }, 11)) as SettingsState;
    expect(migrated.autoCheckForUpdates).toBe(false);
  });
});
