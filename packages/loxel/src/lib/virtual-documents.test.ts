import { describe, expect, mock, test } from "bun:test";

import * as monaco from "monaco-editor";

import {
  isVirtualDocumentUri,
  registerVirtualDocumentScheme,
  virtualDocumentConnection,
  virtualDocumentFileName,
  virtualDocumentPath,
  virtualDocumentSchemes,
  virtualDocumentTitle,
} from "./virtual-documents";

const { token } = new monaco.CancellationTokenSource();

describe("registerVirtualDocumentScheme", () => {
  test("a scheme has a connection only while a client is connected", () => {
    const scheme = registerVirtualDocumentScheme({ scheme: "doc-a" }, "java");
    expect(isVirtualDocumentUri("doc-a://x/y")).toBe(true);
    expect(virtualDocumentSchemes()).toContain("doc-a");
    expect(isVirtualDocumentUri("file:///x")).toBe(false);
    expect(virtualDocumentConnection("doc-a://x/y")).toBeNull();

    const end = scheme.connected({ request: async () => null });
    expect(virtualDocumentConnection("doc-a://x/y")?.languageId).toBe("java");

    end();
    expect(virtualDocumentConnection("doc-a://x/y")).toBeNull();
    expect(isVirtualDocumentUri("doc-a://x/y")).toBe(true);
  });

  test("each connection is its own and tells its listeners when it ends", () => {
    const scheme = registerVirtualDocumentScheme({ scheme: "doc-b" }, "java");
    const endFirst = scheme.connected({ request: async () => null });
    const first = virtualDocumentConnection("doc-b:x");
    const listener = mock();
    const removed = mock();
    first?.onDidClose(listener);
    first?.onDidClose(removed).dispose();

    // The newer connection stays when the older one ends after it took over.
    const endSecond = scheme.connected({ request: async () => null });
    const second = virtualDocumentConnection("doc-b:x");
    expect(second?.id).not.toBe(first?.id);
    endFirst();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(removed).not.toHaveBeenCalled();
    expect(virtualDocumentConnection("doc-b:x")).toBe(second);

    // One that throws doesn't stop the rest.
    const after = mock();
    second?.onDidClose(() => {
      throw new Error("the panel is gone");
    });
    second?.onDidClose(after);
    endSecond();
    expect(after).toHaveBeenCalledTimes(1);
  });

  test("reads through workspace/textDocumentContent unless the language says otherwise", async () => {
    const request = mock(async () => ({ text: "class A {}" }));
    const end = registerVirtualDocumentScheme({ scheme: "doc-c" }, "java").connected({ request });
    await expect(virtualDocumentConnection("doc-c:a")?.read("doc-c:a", token)).resolves.toBe(
      "class A {}",
    );
    expect(request.mock.calls).toEqual([
      ["workspace/textDocumentContent", { uri: "doc-c:a" }, token],
    ] as unknown as typeof request.mock.calls);
    end();

    const endBad = registerVirtualDocumentScheme({ scheme: "doc-d" }, "java").connected({
      request: async () => "not the shape",
    });
    await expect(virtualDocumentConnection("doc-d:a")?.read("doc-d:a", token)).rejects.toThrow(
      "no text",
    );
    endBad();

    const custom = mock(async () => "custom text");
    const endCustom = registerVirtualDocumentScheme(
      { scheme: "doc-e", read: custom },
      "csharp",
    ).connected({ request: async () => null });
    await expect(virtualDocumentConnection("doc-e:a")?.read("doc-e:a", token)).resolves.toBe(
      "custom text",
    );
    endCustom();
  });
});

describe("names", () => {
  test("come from the last path segment, whatever the query holds", () => {
    const java = monaco.Uri.parse(
      "jdt://contents/java.base/java.util/List.java?=p/%5C/lib%5C/jrt-fs.jar%60java.base=/x/%3Cjava.util%28List.class",
    ).toString();
    expect(virtualDocumentFileName(java)).toBe("List.java");
    expect(virtualDocumentTitle(java)).toBe("List");
    const csharp = "csharp:/repo/App.csproj/decompiled/System.Text.StringBuilder.cs";
    expect(virtualDocumentTitle(csharp)).toBe("System.Text.StringBuilder");
    expect(virtualDocumentTitle("x:/no-extension")).toBe("no-extension");
    expect(virtualDocumentPath(java)).toBe("java.base/java.util/List.java");
    expect(virtualDocumentPath(csharp)).toBe(
      "repo/App.csproj/decompiled/System.Text.StringBuilder.cs",
    );
  });
});
