import { afterEach, describe, expect, test } from "bun:test";

import * as monaco from "monaco-editor";

import type { EditorConfigProperties } from "@/api/editorconfig-model";

import { applyEditorConfigOnSave } from "./editorconfig-save-actions";

const disposables: monaco.IDisposable[] = [];

afterEach(() => {
  for (const disposable of disposables.splice(0).reverse()) disposable.dispose();
});

/** A real editor on a new model, with one cursor at each of `cursors`. */
function editorWith(content: string, cursors: Array<[number, number]> = [[1, 1]]) {
  const model = monaco.editor.createModel(content, "plaintext");
  const editor = monaco.editor.create(document.createElement("div"), { model });
  disposables.push(model, editor);
  editor.setSelections(
    cursors.map(([line, column]) => new monaco.Selection(line, column, line, column)),
  );
  return { editor, model };
}

function save(
  content: string,
  properties: EditorConfigProperties,
  reason: "auto" | "explicit" = "explicit",
  cursors?: Array<[number, number]>,
): string {
  const { editor, model } = editorWith(content, cursors);
  applyEditorConfigOnSave(editor, properties, reason);
  return model.getValue();
}

describe("applyEditorConfigOnSave", () => {
  test("does nothing without save properties", () => {
    expect(save("a  \nb", { indentSize: 2 })).toBe("a  \nb");
  });

  test("trims trailing spaces and tabs on every line", () => {
    expect(save("a  \n\tb\t\n  \nc", { trimTrailingWhitespace: true })).toBe("a\n\tb\n\nc");
  });

  test("an autosave keeps the whitespace on the cursors' lines", () => {
    const content = "a  \nb  \nc  ";
    expect(save(content, { trimTrailingWhitespace: true }, "auto", [[2, 4]])).toBe("a\nb  \nc");
    expect(save(content, { trimTrailingWhitespace: true }, "explicit", [[2, 4]])).toBe("a\nb\nc");
  });

  test("adds a missing final newline, but not to an empty file", () => {
    expect(save("a\nb", { insertFinalNewline: true })).toBe("a\nb\n");
    expect(save("a\nb\n", { insertFinalNewline: true })).toBe("a\nb\n");
    expect(save("", { insertFinalNewline: true })).toBe("");
    // false never removes one.
    expect(save("a\n", { insertFinalNewline: false })).toBe("a\n");
  });

  test("combines trimming the last line with the final newline", () => {
    const both = { trimTrailingWhitespace: true, insertFinalNewline: true };
    expect(save("a\nb  ", both)).toBe("a\nb\n");
    expect(save("a\n   ", both)).toBe("a\n");
    // An autosave with the cursor on the last line still gets its newline after the whitespace.
    expect(save("a\nb  ", both, "auto", [[2, 4]])).toBe("a\nb  \n");
  });

  test("converts line endings to end_of_line", () => {
    expect(save("a\nb\n", { endOfLine: "crlf" })).toBe("a\r\nb\r\n");
    expect(save("a\r\nb", { endOfLine: "lf", insertFinalNewline: true })).toBe("a\nb\n");
    expect(save("a\r\nb\r\n", { endOfLine: "crlf", insertFinalNewline: true })).toBe("a\r\nb\r\n");
  });

  test("the save actions are their own undo step, separate from the user's typing", () => {
    const { editor, model } = editorWith("a  \nb\nccc\n", [[2, 2]]);
    editor.trigger("keyboard", "type", { text: "x" });
    applyEditorConfigOnSave(editor, { trimTrailingWhitespace: true, endOfLine: "crlf" }, "auto");
    expect(model.getValue()).toBe("a\r\nbx\r\nccc\r\n");
    model.undo();
    expect(model.getValue()).toBe("a  \nbx\nccc\n");
    model.undo();
    expect(model.getValue()).toBe("a  \nb\nccc\n");
  });

  test("keeps the cursors where they are", () => {
    const { editor } = editorWith("a  \nb", [[2, 2]]);
    applyEditorConfigOnSave(
      editor,
      { trimTrailingWhitespace: true, insertFinalNewline: true },
      "explicit",
    );
    expect(editor.getPosition()?.toString()).toBe("(2,2)");
  });
});
