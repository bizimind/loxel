import { describe, expect, test } from "bun:test";

import type * as monaco from "monaco-editor";

import { DOCUMENT_INDENTATION_METHOD } from "@/api/lsp-indentation-model";

import { reportDocumentIndentation } from "./lsp-document-indentation";

type Listener = () => void;

/** The parts of a Monaco text model the reporter uses. */
class FakeModel {
  readonly listeners = { options: new Set<Listener>() };
  private readonly disposeListeners = new Set<Listener>();

  constructor(
    private readonly uriString: string,
    public languageId: string,
    public options = { tabSize: 4, indentSize: 4, insertSpaces: true },
  ) {}

  get uri() {
    const url = new URL(this.uriString);
    return {
      scheme: url.protocol.slice(0, -1),
      authority: url.host,
      path: url.pathname,
      query: url.search.slice(1),
      fragment: url.hash.slice(1),
      toString: () => this.uriString,
    };
  }

  getLanguageId = () => this.languageId;
  getOptions = () => this.options;
  onDidChangeOptions = (l: Listener) => subscribe(this.listeners.options, l);
  onWillDispose = (l: Listener) => subscribe(this.disposeListeners, l);

  dispose(): void {
    for (const l of this.disposeListeners) l();
  }
}

function subscribe(set: Set<Listener>, listener: Listener): monaco.IDisposable {
  set.add(listener);
  return { dispose: () => set.delete(listener) };
}

function setup(initial: FakeModel[]) {
  const sent: unknown[] = [];
  const created = new Set<(model: FakeModel) => void>();
  const registry = {
    getModels: () => initial,
    onDidCreateModel: (l: (model: FakeModel) => void) => {
      created.add(l);
      return { dispose: () => created.delete(l) };
    },
  } as unknown as Parameters<typeof reportDocumentIndentation>[2];
  const transport = {
    send: (message: unknown) => {
      sent.push(message);
      return Promise.resolve();
    },
  };
  const reporter = reportDocumentIndentation(transport, ["typescript"], registry);
  const create = (model: FakeModel) => {
    for (const l of created) l(model);
  };
  return { sent, reporter, create, createdListeners: created };
}

const notification = (uri: string, tabSize: number, indentSize: number, insertSpaces: boolean) => ({
  jsonrpc: "2.0",
  method: DOCUMENT_INDENTATION_METHOD,
  params: { textDocument: { uri }, indentation: { tabSize, indentSize, insertSpaces } },
});

describe("reportDocumentIndentation", () => {
  test("reports open and created live models of its languages, and their changes", () => {
    const open = new FakeModel("loxel://head/repo/a.ts", "typescript");
    const { sent, create } = setup([
      open,
      new FakeModel("file:///repo/a.py", "python"),
      new FakeModel("loxel://abc123/repo/a.ts#old", "typescript"),
    ]);
    expect(sent).toEqual([notification("loxel://head/repo/a.ts", 4, 4, true)]);

    open.options = { tabSize: 8, indentSize: 2, insertSpaces: false };
    for (const l of open.listeners.options) l();
    create(new FakeModel("loxel://head/repo/b.ts", "typescript"));

    expect(sent.slice(1)).toEqual([
      notification("loxel://head/repo/a.ts", 8, 2, false),
      notification("loxel://head/repo/b.ts", 4, 4, true),
    ]);
  });

  test("stops listening to disposed models and when disposed", () => {
    const first = new FakeModel("loxel://head/repo/a.ts", "typescript");
    const second = new FakeModel("loxel://head/repo/b.ts", "typescript");
    const { reporter, createdListeners } = setup([first, second]);
    first.dispose();
    expect(first.listeners.options.size).toBe(0);
    expect(second.listeners.options.size).toBe(1);

    reporter.dispose();
    expect(second.listeners.options.size).toBe(0);
    expect(createdListeners.size).toBe(0);
  });
});
