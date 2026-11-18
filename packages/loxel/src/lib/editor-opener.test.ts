import { describe, expect, mock, test } from "bun:test";

import * as monaco from "monaco-editor";

import { localServerId } from "@/api/local-server";

import { createEditorOpener } from "./editor-opener";
import { registerVirtualDocumentScheme } from "./virtual-documents";

const sourceAt = (uri: string, peek: object | null = null) =>
  ({
    getModel: () => ({ uri: monaco.Uri.parse(uri) }),
    getContribution: (id: string) => (id === "editor.contrib.referencesController" ? peek : null),
  }) as unknown as monaco.editor.ICodeEditor;

function open(resource: string, source = sourceAt("loxel://test-server/repo/main.ts")) {
  const openFile = mock();
  const handled = createEditorOpener(openFile).openCodeEditor(
    source,
    monaco.Uri.parse(resource),
    new monaco.Range(3, 5, 3, 9),
  );
  return { handled, calls: openFile.mock.calls };
}

/** A file of the window's server. */
const at = (path: string) => ({ server: localServerId(), path });

describe("createEditorOpener", () => {
  test("opens a connected server's read-only document in its own tab, canonically encoded", () => {
    const scheme = registerVirtualDocumentScheme({ scheme: "opener-doc" }, "java");
    const openFile = mock();
    const openVirtual = mock();
    const opener = createEditorOpener(openFile, openVirtual);
    const resource = monaco.Uri.parse("opener-doc://contents/a/List.java?=p/x%28List.class");
    const source = sourceAt("file://test-server/repo/main.java");

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

  test("opens file: and loxel: targets on their server at the selection's start, decoded", () => {
    expect(open("file://test-server/usr/lib/python3.12/os.py")).toEqual({
      handled: true,
      calls: [[at("/usr/lib/python3.12/os.py"), { line: 3, column: 5 }]],
    });
    expect(open("loxel://test-server/repo/a%20b/%C3%BC.ts")).toEqual({
      handled: true,
      calls: [[at("/repo/a b/ü.ts"), { line: 3, column: 5 }]],
    });
    expect(open("file://other-server/repo/b.py")).toEqual({
      handled: true,
      calls: [
        [
          { server: "other-server", path: "/repo/b.py" },
          { line: 3, column: 5 },
        ],
      ],
    });
  });

  test("opens a link with no server, as servers write them in hovers, on the source's server", () => {
    expect(open("file:///usr/lib/python3.12/os.py")).toEqual({
      handled: true,
      calls: [[at("/usr/lib/python3.12/os.py"), { line: 3, column: 5 }]],
    });
    // A source that is no editor file has no server to give it.
    expect(open("file:///usr/lib/os.py", sourceAt("inmemory://model/1"))).toEqual({
      handled: false,
      calls: [],
    });
  });

  test("takes a position too, and opens at the top without one", () => {
    const openFile = mock();
    const opener = createEditorOpener(openFile);
    const source = sourceAt("file://test-server/repo/main.py");
    opener.openCodeEditor(
      source,
      monaco.Uri.parse("file://test-server/repo/b.py"),
      new monaco.Position(7, 2),
    );
    opener.openCodeEditor(source, monaco.Uri.parse("file://test-server/repo/c.py"));
    expect(openFile.mock.calls).toEqual([
      [at("/repo/b.py"), { line: 7, column: 2 }],
      [at("/repo/c.py"), { line: 1, column: 1 }],
    ]);
  });

  test("closes the source's peek widget when its pick opens in another tab", () => {
    const closeWidget = mock();
    const source = sourceAt("file://test-server/repo/main.py", { closeWidget });

    expect(open("file://test-server/repo/b.py", source).handled).toBe(true);
    expect(closeWidget.mock.calls).toEqual([[false]]);
    // A pick in the source's own file is revealed in the peek by Monaco.
    expect(open("file://test-server/repo/main.py", source).handled).toBe(false);
    expect(closeWidget).toHaveBeenCalledTimes(1);
  });

  test("leaves a target in the source's own model to Monaco", () => {
    expect(
      open("file://test-server/repo/main.py", sourceAt("file://test-server/repo/main.py")),
    ).toEqual({ handled: false, calls: [] });
  });

  test("leaves diff, history and compare sides and other schemes to Monaco", () => {
    for (const target of [
      "loxel://abc123/repo/a.ts#old",
      "loxel://HEAD/repo/a.ts#old",
      "loxel://working-tree/repo/a.ts#new",
      "loxel://compare/repo/a.ts#panel-1-old",
      "https://example.com/a.ts",
      "untitled:Untitled-1",
    ]) {
      expect(open(target)).toEqual({ handled: false, calls: [] });
    }
  });
});
