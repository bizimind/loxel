import { beforeEach, describe, expect, mock, test } from "bun:test";

import type * as monaco from "monaco-editor";

import { fakeMonaco, fakeMonacoModule } from "../../testing/fake-monaco";

mock.module("monaco-editor", () => fakeMonacoModule);

const { applyWorkspaceEdit } = await import("./LspApplyEditFeature");

function fakeModel(uri: string, versionId = 1) {
  const calls: string[] = [];
  const operations: monaco.editor.IIdentifiedSingleEditOperation[][] = [];
  const model = {
    uri: { toString: () => uri },
    getVersionId: () => versionId,
    pushStackElement: () => calls.push("stop"),
    pushEditOperations: (
      _selections: unknown,
      ops: monaco.editor.IIdentifiedSingleEditOperation[],
    ) => {
      calls.push("edit");
      operations.push(ops);
      return null;
    },
  } as unknown as monaco.editor.ITextModel;
  fakeMonaco.models.push(model);
  return { model, calls, operations };
}

const range = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 };

function textEdit(uri: string, text: string, versionId?: number) {
  return { resource: { toString: () => uri } as monaco.Uri, versionId, textEdit: { range, text } };
}

describe("applyWorkspaceEdit", () => {
  beforeEach(() => {
    fakeMonaco.reset();
  });

  test("applies every edit to its model as one undo stop", () => {
    const a = fakeModel("loxel://HEAD/a.py", 4);
    const b = fakeModel("loxel://HEAD/b.py");

    const result = applyWorkspaceEdit({
      edits: [
        textEdit("loxel://HEAD/a.py", "1", 4),
        {
          ...textEdit("loxel://HEAD/a.py", "2", 4),
          textEdit: { range: { ...range, startLineNumber: 2, endLineNumber: 2 }, text: "2" },
        },
        textEdit("loxel://HEAD/b.py", "3"),
      ],
    });

    expect(result).toEqual({ applied: true });
    expect(a.calls).toEqual(["stop", "edit", "stop"]);
    expect(a.operations[0].map((op) => op.text)).toEqual(["1", "2"]);
    expect(b.operations[0].map((op) => op.text)).toEqual(["3"]);
  });

  test("refuses the whole edit when a target is not open", () => {
    const a = fakeModel("loxel://HEAD/a.py");

    const result = applyWorkspaceEdit({
      edits: [textEdit("loxel://HEAD/a.py", "1"), textEdit("loxel://HEAD/closed.py", "2")],
    });

    expect(result.applied).toBe(false);
    expect(result.failureReason).toContain("closed.py");
    expect(a.calls).toEqual([]);
  });

  test("refuses the whole edit when a model changed since the server computed it", () => {
    const a = fakeModel("loxel://HEAD/a.py", 5);

    const result = applyWorkspaceEdit({ edits: [textEdit("loxel://HEAD/a.py", "1", 4)] });

    expect(result.applied).toBe(false);
    expect(a.calls).toEqual([]);
  });

  test("refuses the whole edit when edits to one model overlap", () => {
    const a = fakeModel("loxel://HEAD/a.py");
    const b = fakeModel("loxel://HEAD/b.py");
    const wide = { startLineNumber: 1, startColumn: 1, endLineNumber: 3, endColumn: 1 };
    const inside = { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 4 };

    const result = applyWorkspaceEdit({
      edits: [
        textEdit("loxel://HEAD/a.py", "fine"),
        { ...textEdit("loxel://HEAD/b.py", "1"), textEdit: { range: wide, text: "1" } },
        { ...textEdit("loxel://HEAD/b.py", "2"), textEdit: { range: inside, text: "2" } },
      ],
    });

    expect(result.applied).toBe(false);
    expect(result.failureReason).toContain("b.py");
    expect(a.calls).toEqual([]);
    expect(b.calls).toEqual([]);
  });

  test("passes a conversion rejection on as the failure reason", () => {
    const result = applyWorkspaceEdit({ edits: [], rejectReason: "no file operations" });
    expect(result).toEqual({ applied: false, failureReason: "no file operations" });
  });
});
