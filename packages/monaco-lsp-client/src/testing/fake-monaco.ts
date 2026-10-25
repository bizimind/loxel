import type * as monaco from "monaco-editor";

import type { IDisposable } from "../utils";

// The real `monaco-editor` needs a DOM, so tests swap in this module with
// `mock.module("monaco-editor", () => fakeMonacoModule)`. `mock.module` is
// process-wide in `bun test`, so every test file must install this same
// module object and configure it through `fakeMonaco` rather than define its own.

type Listener<T> = (e: T) => void;

export class FakeEmitter<T> {
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

type CommandHandler = (accessor: unknown, ...args: unknown[]) => unknown;

export const fakeMonaco = {
  models: [] as monaco.editor.ITextModel[],
  editors: [] as monaco.editor.ICodeEditor[],
  commands: new Map<string, CommandHandler>(),
  /** Language providers registered through `monaco.languages.register<Kind>Provider`, by kind. */
  providers: new Map<string, unknown>(),
  didCreateModel: new FakeEmitter<monaco.editor.ITextModel>(),
  reset(): void {
    this.models.length = 0;
    this.editors.length = 0;
    this.commands.clear();
    this.providers.clear();
  },
};

/** Stands in for a Monaco enum: every member reads as its own name. */
const anyEnum: unknown = new Proxy({}, { get: (_target, key) => String(key) });
/**
 * Stands in for `monaco.languages`: `register<Kind>Provider` records the provider under its kind in
 * `fakeMonaco.providers`; any other member reads as an enum.
 */
const languagesNamespace: unknown = new Proxy(
  {},
  {
    get: (_target, key) => {
      const kind = /^register(\w+)Provider$/.exec(String(key))?.[1];
      if (!kind) return anyEnum;
      return (_selector: unknown, provider: unknown): IDisposable => {
        fakeMonaco.providers.set(kind, provider);
        return { dispose: () => fakeMonaco.providers.delete(kind) };
      };
    },
  },
);

/** Enough of `monaco.Uri.parse` for lookups and messages: `scheme://authority/path`. */
function parseUri(
  value: string,
): Pick<monaco.Uri, "scheme" | "authority" | "path" | "toString" | "with"> {
  const match = /^([^:]+):\/\/([^/]*)(.*)$/.exec(value);
  if (!match) throw new Error(`Not a uri: ${value}`);
  const [, scheme = "", authority = "", path = ""] = match;
  return {
    scheme,
    authority,
    path: decodeURIComponent(path),
    toString: () => value,
    with: (change) => parseUri(`${scheme}://${authority}${change.path ?? path}`) as monaco.Uri,
  };
}

export const fakeMonacoModule = {
  Uri: { parse: parseUri },
  editor: {
    getModels: () => fakeMonaco.models,
    getEditors: () => fakeMonaco.editors,
    getModel: (uri: monaco.Uri) =>
      fakeMonaco.models.find((m) => m.uri.toString() === uri.toString()) ?? null,
    onDidCreateModel: fakeMonaco.didCreateModel.event,
    registerCommand: (id: string, handler: CommandHandler): IDisposable => {
      fakeMonaco.commands.set(id, handler);
      return { dispose: () => fakeMonaco.commands.delete(id) };
    },
  },
  languages: languagesNamespace,
  MarkerSeverity: anyEnum,
  MarkerTag: anyEnum,
};
