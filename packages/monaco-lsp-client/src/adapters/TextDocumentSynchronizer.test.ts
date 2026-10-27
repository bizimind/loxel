import { beforeEach, describe, expect, mock, test } from "bun:test";

import type * as monaco from "monaco-editor";

import { FakeEmitter, fakeMonaco, fakeMonacoModule } from "../testing/fake-monaco";
import type { TextDocumentChangeRegistrationOptions } from "../types";
import { api, capabilities, TextDocumentSyncKind } from "../types";
import type { IDisposable } from "../utils";
import type { ILspCapabilitiesRegistry } from "./LspCapabilitiesRegistry";

interface FakeModel {
  readonly model: monaco.editor.ITextModel;
  readonly contentChanged: FakeEmitter<monaco.editor.IModelContentChangedEvent>;
  readonly willDispose: FakeEmitter<void>;
}

function createFakeModel(path: string, languageId = "typescript"): FakeModel {
  const contentChanged = new FakeEmitter<monaco.editor.IModelContentChangedEvent>();
  const willDispose = new FakeEmitter<void>();
  const model = {
    uri: fakeMonacoModule.Uri.file(path),
    getLanguageId: () => languageId,
    getVersionId: () => 1,
    getValue: () => "",
    onDidChangeContent: contentChanged.event,
    onWillDispose: willDispose.event,
  } as unknown as monaco.editor.ITextModel;
  return { model, contentChanged, willDispose };
}

mock.module("monaco-editor", () => fakeMonacoModule);

const { TextDocumentSynchronizer } = await import("./TextDocumentSynchronizer");

function createServer() {
  const calls: string[] = [];
  /** The document uri of each notification. */
  const uris: string[] = [];
  const record =
    (call: string) =>
    ({ textDocument }: { textDocument: { uri: string } }) => {
      calls.push(call);
      uris.push(textDocument.uri);
    };
  const server = {
    textDocumentDidOpen: record("open"),
    textDocumentDidChange: record("change"),
    textDocumentDidClose: record("close"),
  } as unknown as typeof api.TServerInterface;
  return { server, calls, uris };
}

function createRegistry() {
  let didChangeHandler:
    | ((options: TextDocumentChangeRegistrationOptions) => IDisposable)
    | undefined;
  const registry: ILspCapabilitiesRegistry = {
    addStaticClientCapabilities: () => ({ dispose: () => {} }),
    registerCapabilityHandler: (capability, _handleStatic, handler) => {
      if (capability === capabilities.textDocumentDidChange) {
        didChangeHandler = handler as typeof didChangeHandler;
      }
      return { dispose: () => {} };
    },
  };
  const start = () => {
    if (!didChangeHandler) throw new Error("didChange handler not registered");
    didChangeHandler({ documentSelector: null, syncKind: TextDocumentSyncKind.Incremental });
  };
  return { registry, start };
}

const emptyChange = { changes: [] } as unknown as monaco.editor.IModelContentChangedEvent;

describe("TextDocumentSynchronizer", () => {
  beforeEach(() => {
    fakeMonaco.reset();
  });

  test("dispose closes every managed model and stops forwarding changes", () => {
    const a = createFakeModel("/a.ts");
    const b = createFakeModel("/b.ts");
    fakeMonaco.models.push(a.model, b.model);
    const { server, calls } = createServer();
    const { registry, start } = createRegistry();

    const sync = new TextDocumentSynchronizer(server, registry);
    start();
    expect(calls).toEqual(["open", "open"]);

    a.contentChanged.fire(emptyChange);
    expect(calls).toEqual(["open", "open", "change"]);

    sync.dispose();
    expect(calls).toEqual(["open", "open", "change", "close", "close"]);
    expect(a.contentChanged.size).toBe(0);
    expect(b.contentChanged.size).toBe(0);
    expect(a.willDispose.size).toBe(0);
    expect(b.willDispose.size).toBe(0);

    a.contentChanged.fire(emptyChange);
    a.willDispose.fire();
    expect(calls).toEqual(["open", "open", "change", "close", "close"]);
  });

  test("dispose stops tracking models created afterwards", () => {
    const { server, calls } = createServer();
    const { registry, start } = createRegistry();

    const sync = new TextDocumentSynchronizer(server, registry);
    start();
    sync.dispose();

    const late = createFakeModel("/late.ts");
    fakeMonaco.didCreateModel.fire(late.model);
    expect(calls).toEqual([]);
    expect(late.contentChanged.size).toBe(0);
  });

  test("a model disposed by Monaco is closed once and removed", () => {
    const a = createFakeModel("/a.ts");
    fakeMonaco.models.push(a.model);
    const { server, calls } = createServer();
    const { registry, start } = createRegistry();

    const sync = new TextDocumentSynchronizer(server, registry);
    start();
    a.willDispose.fire();
    expect(calls).toEqual(["open", "close"]);
    expect(a.contentChanged.size).toBe(0);

    sync.dispose();
    expect(calls).toEqual(["open", "close"]);
  });

  test("syncs only models that match the language ids and the model filter", () => {
    const live = createFakeModel("/live.py", "python");
    const diff = createFakeModel("/diff.py", "python");
    const other = createFakeModel("/other.ts");
    fakeMonaco.models.push(live.model, diff.model, other.model);
    const { server, calls } = createServer();
    const { registry, start } = createRegistry();

    const sync = new TextDocumentSynchronizer(
      server,
      registry,
      new Set(["python"]),
      (m) => m.uri.path !== "/diff.py",
    );
    start();
    expect(calls).toEqual(["open"]);
    expect(sync.isSyncedModel(live.model)).toBe(true);
    expect(sync.isSyncedModel(diff.model)).toBe(false);
    expect(sync.isSyncedModel(other.model)).toBe(false);

    const lateDiff = createFakeModel("/diff.py", "python");
    fakeMonaco.didCreateModel.fire(lateDiff.model);
    expect(calls).toEqual(["open"]);
    expect(lateDiff.contentChanged.size).toBe(0);
  });

  test("sends percent-encoded uris and finds the model behind the server's, however encoded", () => {
    const m = createFakeModel("/repo/a b/ü.py", "python");
    fakeMonaco.models.push(m.model);
    const { server, uris } = createServer();
    const { registry, start } = createRegistry();

    const sync = new TextDocumentSynchronizer(server, registry);
    start();
    m.contentChanged.fire(emptyChange);
    const encoded = "file:///repo/a%20b/%C3%BC.py";
    const position = { lineNumber: 1, column: 1 } as monaco.Position;
    expect(uris).toEqual([encoded, encoded]);
    expect(sync.translate(m.model, position).textDocument.uri).toBe(encoded);

    // Only the synchronizer knows the model now, so the lookups go through its own map.
    fakeMonaco.models.length = 0;
    // Lowercase escapes (Rust's `url`), and no encoding at all (servers echoing the uri back).
    for (const uri of [encoded, "file:///repo/a%20b/%c3%bc.py", "file:///repo/a b/ü.py"]) {
      expect(sync.translateBack({ uri }, { line: 0, character: 0 }).textModel).toBe(m.model);
    }
    expect(
      sync.translateBack({ uri: "file:///repo/other.py" }, { line: 0, character: 0 }).textModel,
    ).not.toBe(m.model);
    sync.dispose();
    expect(uris.at(-1)).toBe(encoded);
  });
});
