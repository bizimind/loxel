import type * as monaco from "monaco-editor";

import type { IDisposable } from "../utils";

// The real `monaco-editor` needs a DOM, so tests swap in this module with
// `mock.module("monaco-editor", () => fakeMonacoModule)`. `mock.module` is
// process-wide in `bun test`, so every test file must install this same
// module object and configure it through `fakeMonaco` rather than define its own.

// Monaco's own URI class (`monaco.Uri`), which loads without a DOM, so encoding and decoding are
// the real ones. The deep import has no type declarations.
const uriModule: string = "monaco-editor/base/common/uri.js";
const { URI } = (await import(uriModule)) as { URI: typeof monaco.Uri };

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
  willDisposeModel: new FakeEmitter<monaco.editor.ITextModel>(),
  /** owner → model URI → markers, as set through `setModelMarkers`. */
  markers: new Map<string, Map<string, monaco.editor.IMarkerData[]>>(),
  /**
   * The markers on `uri` from every owner as Monaco hands them to code action providers: its own
   * copies (`IMarker`s with owner and resource), not the objects that were set.
   */
  readMarkers(uri: string): monaco.editor.IMarker[] {
    return [...this.markers].flatMap(([owner, byModel]) =>
      (byModel.get(uri) ?? []).map((marker) => ({ ...marker, owner, resource: URI.parse(uri) })),
    );
  },
  reset(): void {
    this.models.length = 0;
    this.editors.length = 0;
    this.commands.clear();
    this.markers.clear();
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

export const fakeMonacoModule = {
  Uri: URI,
  Position: class {
    constructor(
      readonly lineNumber: number,
      readonly column: number,
    ) {}
  },
  Range: { lift: (range: monaco.IRange) => range },
  editor: {
    getModels: () => fakeMonaco.models,
    getEditors: () => fakeMonaco.editors,
    getModel: (uri: monaco.Uri) =>
      fakeMonaco.models.find((m) => m.uri.toString() === uri.toString()) ?? null,
    onDidCreateModel: fakeMonaco.didCreateModel.event,
    onWillDisposeModel: fakeMonaco.willDisposeModel.event,
    setModelMarkers: (
      model: monaco.editor.ITextModel,
      owner: string,
      markers: monaco.editor.IMarkerData[],
    ) => {
      const byModel = fakeMonaco.markers.get(owner) ?? new Map();
      byModel.set(model.uri.toString(), markers);
      fakeMonaco.markers.set(owner, byModel);
    },
    removeAllMarkers: (owner: string) => fakeMonaco.markers.delete(owner),
    registerCommand: (id: string, handler: CommandHandler): IDisposable => {
      fakeMonaco.commands.set(id, handler);
      return { dispose: () => fakeMonaco.commands.delete(id) };
    },
  },
  languages: languagesNamespace,
  MarkerSeverity: anyEnum,
  MarkerTag: anyEnum,
};
