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
    uri: { toString: () => `file://${path}`, path },
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
  const server = {
    textDocumentDidOpen: () => calls.push("open"),
    textDocumentDidChange: () => calls.push("change"),
    textDocumentDidClose: () => calls.push("close"),
  } as unknown as typeof api.TServerInterface;
  return { server, calls };
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
});
