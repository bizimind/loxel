import { describe, expect, mock, test } from "bun:test";

import * as monaco from "monaco-editor";

import { createEditorOpener } from "./editor-opener";
import { registerVirtualDocumentScheme } from "./virtual-documents";

const sourceAt = (uri: string, peek: object | null = null) =>
  ({
    getModel: () => ({ uri: monaco.Uri.parse(uri) }),
    getContribution: (id: string) => (id === "editor.contrib.referencesController" ? peek : null),
  }) as unknown as monaco.editor.ICodeEditor;

function open(resource: string, source = sourceAt("loxel://HEAD/repo/main.ts")) {
  const openFile = mock();
  const handled = createEditorOpener(openFile).openCodeEditor(
    source,
    monaco.Uri.parse(resource),
    new monaco.Range(3, 5, 3, 9),
  );
  return { handled, calls: openFile.mock.calls };
}

describe("createEditorOpener", () => {
  test("opens a connected server's read-only document in its own tab, canonically encoded", () => {
    const scheme = registerVirtualDocumentScheme({ scheme: "opener-doc" }, "java");
    const openFile = mock();
    const openVirtual = mock();
    const opener = createEditorOpener(openFile, openVirtual);
    const resource = monaco.Uri.parse("opener-doc://contents/a/List.java?=p/x%28List.class");
    const source = sourceAt("file:///repo/main.java");

    // No connection: Monaco's to handle, like any other unknown scheme.
    expect(opener.openCodeEditor(source, resource, new monaco.Position(1, 1))).toBe(false);

    const end = scheme.connected({ request: async () => null });
    expect(opener.openCodeEditor(source, resource, new monaco.Range(3, 5, 3, 9))).toBe(true);
    expect(openVirtual.mock.calls).toEqual([[resource.toString(), { line: 3, column: 5 }]]);
    expect(openFile).not.toHaveBeenCalled();

    // A definition inside the document itself is revealed in place.
    expect(
      opener.openCodeEditor(sourceAt(resource.toString()), resource, new monaco.Position(2, 1)),
    ).toBe(false);
    end();
  });

  test("opens file: and loxel://HEAD targets at the selection's start, decoded", () => {
    expect(open("file:///usr/lib/python3.12/os.py")).toEqual({
      handled: true,
      calls: [["/usr/lib/python3.12/os.py", { line: 3, column: 5 }]],
    });
    expect(open("loxel://HEAD/repo/a%20b/%C3%BC.ts")).toEqual({
      handled: true,
      calls: [["/repo/a b/ü.ts", { line: 3, column: 5 }]],
    });
  });

  test("takes a position too, and opens at the top without one", () => {
    const openFile = mock();
    const opener = createEditorOpener(openFile);
    const source = sourceAt("file:///repo/main.py");
    opener.openCodeEditor(source, monaco.Uri.parse("file:///repo/b.py"), new monaco.Position(7, 2));
    opener.openCodeEditor(source, monaco.Uri.parse("file:///repo/c.py"));
    expect(openFile.mock.calls).toEqual([
      ["/repo/b.py", { line: 7, column: 2 }],
      ["/repo/c.py", { line: 1, column: 1 }],
    ]);
  });

  test("closes the source's peek widget when its pick opens in another tab", () => {
    const closeWidget = mock();
    const source = sourceAt("file:///repo/main.py", { closeWidget });

    expect(open("file:///repo/b.py", source).handled).toBe(true);
    expect(closeWidget.mock.calls).toEqual([[false]]);
    // A pick in the source's own file is revealed in the peek by Monaco.
    expect(open("file:///repo/main.py", source).handled).toBe(false);
    expect(closeWidget).toHaveBeenCalledTimes(1);
  });

  test("leaves a target in the source's own model to Monaco", () => {
    expect(open("file:///repo/main.py", sourceAt("file:///repo/main.py"))).toEqual({
      handled: false,
      calls: [],
    });
  });

  test("leaves diff, history and compare sides and other schemes to Monaco", () => {
    for (const target of [
      "loxel://abc123/repo/a.ts#old",
      "loxel://abc123/repo/a.ts",
      "loxel://HEAD/repo/a.ts#new",
      "loxel://compare/repo/a.ts#panel-1-old",
      "https://example.com/a.ts",
      "untitled:Untitled-1",
    ]) {
      expect(open(target)).toEqual({ handled: false, calls: [] });
    }
  });
});
