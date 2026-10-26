import { describe, expect, test } from "bun:test";

import { DEFAULT_EDITOR_SETTINGS, type EditorSettings, resolveIndentation } from "./settings-store";

function settings(overrides: EditorSettings["overrides"] = []): EditorSettings {
  return { ...DEFAULT_EDITOR_SETTINGS, overrides };
}

describe("resolveIndentation", () => {
  test("uses the global default for languages without a built-in default", () => {
    expect(resolveIndentation(settings(), "/repo/src/app.ts", "typescript")).toEqual({
      tabSize: 2,
      insertSpaces: true,
      indentSize: 2,
    });
    expect(resolveIndentation(settings(), "/repo/notes", null)).toEqual({
      tabSize: 2,
      insertSpaces: true,
      indentSize: 2,
    });
  });

  test("uses built-in language defaults over the global default", () => {
    expect(resolveIndentation(settings(), "/repo/app.py", "python")).toEqual({
      tabSize: 4,
      insertSpaces: true,
      indentSize: 4,
    });
    expect(resolveIndentation(settings(), "/repo/main.go", "go")).toEqual({
      tabSize: 4,
      insertSpaces: false,
      indentSize: 4,
    });
    expect(resolveIndentation(settings(), "/repo/lib.rs", "rust")).toEqual({
      tabSize: 4,
      insertSpaces: true,
      indentSize: 4,
    });
  });

  test("keys built-in defaults by resolved language, not extension", () => {
    // An extensionless script resolved as Python by its shebang.
    expect(resolveIndentation(settings(), "/repo/bin/manage", "python").tabSize).toBe(4);
    // A .py file the user associated with another language.
    expect(resolveIndentation(settings(), "/repo/template.py", "plaintext").tabSize).toBe(2);
  });

  test("a per-extension override wins over the built-in default, case-insensitively", () => {
    const editor = settings([{ id: "1", extension: "PY", tabSize: 2, insertSpaces: false }]);
    expect(resolveIndentation(editor, "/repo/App.Py", "python")).toEqual({
      tabSize: 2,
      insertSpaces: false,
      indentSize: 2,
    });
    // Overrides match the last extension only.
    expect(resolveIndentation(editor, "/repo/types.pyi", "python").tabSize).toBe(4);
  });

  test("ignores dots in directory names and trailing dots", () => {
    const editor = settings([{ id: "1", extension: "d", tabSize: 8, insertSpaces: true }]);
    expect(resolveIndentation(editor, "/repo/conf.d/Makefile", null).tabSize).toBe(2);
    expect(resolveIndentation(editor, "/repo/file.", null).tabSize).toBe(2);
  });

  test(".editorconfig properties win over built-in and global defaults, one by one", () => {
    expect(
      resolveIndentation(settings(), "/repo/app.py", "python", { indentStyle: "tab" }),
    ).toEqual({ tabSize: 4, insertSpaces: false, indentSize: 4 });
    expect(
      resolveIndentation(settings(), "/repo/main.go", "go", { indentSize: 2, tabWidth: 2 }),
    ).toEqual({ tabSize: 2, insertSpaces: false, indentSize: 2 });
    expect(
      resolveIndentation(settings(), "/repo/app.ts", "typescript", {
        indentStyle: "space",
        indentSize: 4,
        tabWidth: 8,
      }),
    ).toEqual({ tabSize: 8, insertSpaces: true, indentSize: 4 });
    // tab_width alone is a tab's display width; the indent size stays the language default.
    expect(
      resolveIndentation(settings(), "/repo/app.ts", "typescript", {
        indentStyle: "space",
        tabWidth: 4,
      }),
    ).toEqual({ tabSize: 4, insertSpaces: true, indentSize: 2 });
    // Save-only properties leave indentation alone.
    expect(
      resolveIndentation(settings(), "/repo/app.ts", "typescript", { insertFinalNewline: true }),
    ).toEqual({ tabSize: 2, insertSpaces: true, indentSize: 2 });
  });

  test("a per-extension override wins over .editorconfig", () => {
    const editor = settings([{ id: "1", extension: "py", tabSize: 2, insertSpaces: true }]);
    expect(
      resolveIndentation(editor, "/repo/app.py", "python", {
        indentStyle: "tab",
        indentSize: 8,
        tabWidth: 8,
      }),
    ).toEqual({ tabSize: 2, insertSpaces: true, indentSize: 2 });
  });
});
