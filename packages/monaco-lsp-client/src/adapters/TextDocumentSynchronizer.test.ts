import { beforeEach, describe, expect, mock, test } from "bun:test";

import type * as monaco from "monaco-editor";

import type { TextDocumentChangeRegistrationOptions } from "../types";
import { api, capabilities, TextDocumentSyncKind } from "../types";
import type { IDisposable } from "../utils";
import type { ILspCapabilitiesRegistry } from "./LspCapabilitiesRegistry";

type Listener<T> = (e: T) => void;

class FakeEmitter<T> {
  private readonly _listeners = new Set<Listener<T>>();

  readonly event = (listener: Listener<T>): IDisposable => {
    this._listeners.add(listener);
    return { dispose: () => this._listeners.delete(listener) };
  };

  fire(e: T): void {
    for (const l of [...this._listeners]) l(e);
  }

  get size(): number {
    return this._listeners.size;
  }
}

interface FakeModel {
  readonly model: monaco.editor.ITextModel;
  readonly contentChanged: FakeEmitter<monaco.editor.IModelContentChangedEvent>;
  readonly willDispose: FakeEmitter<void>;
}

function createFakeModel(path: string): FakeModel {
  const contentChanged = new FakeEmitter<monaco.editor.IModelContentChangedEvent>();
  const willDispose = new FakeEmitter<void>();
  const model = {
    uri: { toString: () => `file://${path}` },
    getLanguageId: () => "typescript",
    getVersionId: () => 1,
    getValue: () => "",
    onDidChangeContent: contentChanged.event,
    onWillDispose: willDispose.event,
  } as unknown as monaco.editor.ITextModel;
  return { model, contentChanged, willDispose };
}

const models: FakeModel[] = [];
const didCreateModel = new FakeEmitter<monaco.editor.ITextModel>();

mock.module("monaco-editor", () => ({
  editor: {
    getModels: () => models.map((m) => m.model),
    onDidCreateModel: didCreateModel.event,
    getModel: () => null,
  },
}));

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
    models.length = 0;
  });

  test("dispose closes every managed model and stops forwarding changes", () => {
    const a = createFakeModel("/a.ts");
    const b = createFakeModel("/b.ts");
    models.push(a, b);
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
    didCreateModel.fire(late.model);
    expect(calls).toEqual([]);
    expect(late.contentChanged.size).toBe(0);
  });

  test("a model disposed by Monaco is closed once and removed", () => {
    const a = createFakeModel("/a.ts");
    models.push(a);
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
});
