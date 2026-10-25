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
  commands: new Map<string, CommandHandler>(),
  didCreateModel: new FakeEmitter<monaco.editor.ITextModel>(),
  /** owner → model URI → markers, as set through `setModelMarkers`. */
  markers: new Map<string, Map<string, monaco.editor.IMarkerData[]>>(),
  reset(): void {
    this.models.length = 0;
    this.commands.clear();
    this.markers.clear();
  },
};

/** Stands in for a Monaco enum: every member reads as its own name. */
const anyEnum: unknown = new Proxy({}, { get: (_target, key) => String(key) });
/** Stands in for `monaco.languages`, whose members the adapters only read as enums at load time. */
const anyNamespace: unknown = new Proxy({}, { get: () => anyEnum });

export const fakeMonacoModule = {
  editor: {
    getModels: () => fakeMonaco.models,
    getModel: (uri: monaco.Uri) =>
      fakeMonaco.models.find((m) => m.uri.toString() === uri.toString()) ?? null,
    onDidCreateModel: fakeMonaco.didCreateModel.event,
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
  languages: anyNamespace,
  MarkerSeverity: anyEnum,
  MarkerTag: anyEnum,
};
