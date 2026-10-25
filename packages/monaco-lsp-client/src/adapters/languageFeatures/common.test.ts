import { describe, expect, mock, test } from "bun:test";

import type * as monaco from "monaco-editor";

import { fakeMonacoModule } from "../../testing/fake-monaco";
import type { Range, WorkspaceEdit } from "../../types";
import type { LspConnection } from "../LspConnection";

mock.module("monaco-editor", () => fakeMonacoModule);

const { matchesDocumentSelector, toMonacoWorkspaceEdit } = await import("./common");

function fakeModel(languageId: string, path = "/a.py") {
  return {
    getLanguageId: () => languageId,
    uri: { scheme: "loxel", path },
  } as unknown as monaco.editor.ITextModel;
}

describe("matchesDocumentSelector", () => {
  test("a null or empty selector falls back to the client's language ids", () => {
    expect(matchesDocumentSelector(fakeModel("python"), null, ["python"])).toBe(true);
    expect(matchesDocumentSelector(fakeModel("typescript"), null, ["python"])).toBe(false);
    expect(matchesDocumentSelector(fakeModel("typescript"), [], ["python"])).toBe(false);
  });

  test("a null selector matches every model when the client has no language ids", () => {
    expect(matchesDocumentSelector(fakeModel("typescript"), null)).toBe(true);
  });

  test("typescript and javascript filters also match tsx and jsx models", () => {
    expect(matchesDocumentSelector(fakeModel("tsx"), [{ language: "typescript" }])).toBe(true);
    expect(matchesDocumentSelector(fakeModel("jsx"), [{ language: "javascript" }])).toBe(true);
    expect(matchesDocumentSelector(fakeModel("tsx"), [{ language: "javascript" }])).toBe(false);
  });
});

function fakeConnection(): LspConnection {
  const bridge = {
    translateBackRange: ({ uri }: { uri: string }, range: Range) => ({
      textModel: { uri: { toString: () => uri } },
      range: { startLineNumber: range.start.line + 1, endLineNumber: range.end.line + 1 },
    }),
  };
  return { bridge } as unknown as LspConnection;
}

const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };

describe("toMonacoWorkspaceEdit", () => {
  test("prefers documentChanges over changes", () => {
    const edit: WorkspaceEdit = {
      changes: { "file:///a.py": [{ range, newText: "from changes" }] },
      documentChanges: [
        { textDocument: { uri: "file:///a.py", version: 3 }, edits: [{ range, newText: "doc" }] },
      ],
    };
    const result = toMonacoWorkspaceEdit(edit, fakeConnection());
    expect(result.rejectReason).toBeUndefined();
    expect(result.edits).toHaveLength(1);
    const [only] = result.edits as monaco.languages.IWorkspaceTextEdit[];
    expect(only.textEdit.text).toBe("doc");
    expect(only.versionId).toBe(3);
  });

  test("converts changes when there are no documentChanges", () => {
    const edit: WorkspaceEdit = {
      changes: { "file:///a.py": [{ range, newText: "x" }], "file:///b.py": [] },
    };
    const result = toMonacoWorkspaceEdit(edit, fakeConnection());
    expect(result.edits).toHaveLength(1);
    expect((result.edits[0] as monaco.languages.IWorkspaceTextEdit).versionId).toBeUndefined();
  });

  test("rejects an edit with file operations instead of applying part of it", () => {
    const edit: WorkspaceEdit = {
      documentChanges: [
        { textDocument: { uri: "file:///a.py", version: null }, edits: [{ range, newText: "x" }] },
        { kind: "rename", oldUri: "file:///a.py", newUri: "file:///b.py" },
      ],
    };
    const result = toMonacoWorkspaceEdit(edit, fakeConnection());
    expect(result.edits).toEqual([]);
    expect(result.rejectReason).toContain("rename");
  });
});
