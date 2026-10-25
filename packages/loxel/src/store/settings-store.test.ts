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
    });
    expect(resolveIndentation(settings(), "/repo/notes", null)).toEqual({
      tabSize: 2,
      insertSpaces: true,
    });
  });

  test("uses built-in language defaults over the global default", () => {
    expect(resolveIndentation(settings(), "/repo/app.py", "python")).toEqual({
      tabSize: 4,
      insertSpaces: true,
    });
    expect(resolveIndentation(settings(), "/repo/main.go", "go")).toEqual({
      tabSize: 4,
      insertSpaces: false,
    });
    expect(resolveIndentation(settings(), "/repo/lib.rs", "rust")).toEqual({
      tabSize: 4,
      insertSpaces: true,
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
    });
    // Overrides match the last extension only.
    expect(resolveIndentation(editor, "/repo/types.pyi", "python").tabSize).toBe(4);
  });

  test("ignores dots in directory names and trailing dots", () => {
    const editor = settings([{ id: "1", extension: "d", tabSize: 8, insertSpaces: true }]);
    expect(resolveIndentation(editor, "/repo/conf.d/Makefile", null).tabSize).toBe(2);
    expect(resolveIndentation(editor, "/repo/file.", null).tabSize).toBe(2);
  });
});
