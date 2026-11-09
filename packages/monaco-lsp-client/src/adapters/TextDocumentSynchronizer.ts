import * as monaco from "monaco-editor";

import type {
  Position,
  Range,
  TextDocumentContentChangeEvent,
  TextDocumentChangeRegistrationOptions,
  TextDocumentIdentifier,
} from "../types";
import { api, capabilities, TextDocumentSyncKind } from "../types";
import { Disposable } from "../utils";
import type { ITextModelBridge } from "./ITextModelBridge";
import type { ILspCapabilitiesRegistry } from "./LspCapabilitiesRegistry";
import { toLspRange, toMonacoRange } from "./ranges";

export class TextDocumentSynchronizer extends Disposable implements ITextModelBridge {
  private readonly _managedModels = new Map<monaco.editor.ITextModel, ManagedModel>();
  /**
   * Keyed by the model uri's `toString()`, Monaco's canonical percent-encoded form; uris from the
   * server are parsed and re-encoded before the lookup, since servers encode differently.
   */
  private readonly _managedModelsReverse = new Map</* uri */ string, monaco.editor.ITextModel>();

  private _started = false;
  private _syncKind: TextDocumentSyncKind = TextDocumentSyncKind.Incremental;

  constructor(
    private readonly _server: typeof api.TServerInterface,
    private readonly _capabilities: ILspCapabilitiesRegistry,
    private readonly _languageIds?: ReadonlySet<string>,
    private readonly _modelFilter?: (textModel: monaco.editor.ITextModel) => boolean,
  ) {
    super();

    this._register(
      this._capabilities.addStaticClientCapabilities({
        textDocument: {
          synchronization: {
            dynamicRegistration: true,
            willSave: false,
            willSaveWaitUntil: false,
            didSave: false,
          },
        },
      }),
    );

    this._register(
      _capabilities.registerCapabilityHandler(
        capabilities.textDocumentDidChange,
        true,
        (options: TextDocumentChangeRegistrationOptions) => {
          this._syncKind = options.syncKind;
          if (this._started) {
            return { dispose: () => {} };
          }
          this._started = true;
          this._register(
            monaco.editor.onDidCreateModel((m) => {
              this._getOrCreateManagedModel(m);
            }),
          );
          for (const m of monaco.editor.getModels()) {
            this._getOrCreateManagedModel(m);
          }
          return { dispose: () => {} };
        },
      ),
    );
  }

  private _getOrCreateManagedModel(m: monaco.editor.ITextModel) {
    if (!this._started) {
      throw new Error("Not started");
    }

    if (!this.isSyncedModel(m)) return undefined;
    const existing = this._managedModels.get(m);
    if (existing) return existing;

    const mm = new ManagedModel(m, this._server, this._syncKind, () => this._removeManagedModel(m));
    this._managedModels.set(m, mm);
    this._managedModelsReverse.set(m.uri.toString(), m);
    return mm;
  }

  isSyncedModel(textModel: monaco.editor.ITextModel): boolean {
    if (this._languageIds && !this._languageIds.has(textModel.getLanguageId())) return false;
    return this._modelFilter?.(textModel) ?? true;
  }

  private _removeManagedModel(m: monaco.editor.ITextModel): void {
    const mm = this._managedModels.get(m);
    if (!mm) return;
    this._managedModels.delete(m);
    this._managedModelsReverse.delete(m.uri.toString());
    mm.dispose();
  }

  /**
   * Closes every managed model (unsubscribing from content changes and sending
   * `textDocument/didClose`) before disposing the registered capability
   * handlers and the `onDidCreateModel` subscription.
   */
  override dispose(): void {
    for (const m of [...this._managedModels.keys()]) {
      this._removeManagedModel(m);
    }
    this._started = false;
    super.dispose();
  }

  translateBack(
    textDocument: TextDocumentIdentifier,
    position: Position,
  ): { textModel: monaco.editor.ITextModel; position: monaco.Position } {
    const textModel = this._resolveModel(textDocument.uri);
    const monacoPosition = new monaco.Position(position.line + 1, position.character + 1);
    return { textModel, position: monacoPosition };
  }

  translateBackRange(
    textDocument: TextDocumentIdentifier,
    range: Range,
  ): { textModel: monaco.editor.ITextModel; range: monaco.Range } {
    const textModel = this._resolveModel(textDocument.uri);
    return { textModel, range: monaco.Range.lift(toMonacoRange(range)) };
  }

  /**
   * Look up a managed model by URI. Falls back to Monaco's global model
   * registry, then to a minimal uri-only stub when the target file is not
   * currently open — this happens for LSP responses that reference files
   * outside the current editor (e.g., go-to-definition into an unopened
   * file). The stub reports `isDisposed() === true` so features like
   * diagnostics early-return instead of trying to operate on it.
   */
  private _resolveModel(uri: string): monaco.editor.ITextModel {
    const monacoUri = monaco.Uri.parse(uri);
    const managed = this._managedModelsReverse.get(monacoUri.toString());
    if (managed) return managed;
    const global = monaco.editor.getModel(monacoUri);
    if (global) return global;
    return { uri: monacoUri, isDisposed: () => true } as unknown as monaco.editor.ITextModel;
  }

  translate(
    textModel: monaco.editor.ITextModel,
    monacoPos: monaco.Position,
  ): { textDocument: TextDocumentIdentifier; position: Position } {
    return {
      textDocument: { uri: textModel.uri.toString() },
      position: { line: monacoPos.lineNumber - 1, character: monacoPos.column - 1 },
    };
  }

  translateRange(_textModel: monaco.editor.ITextModel, monacoRange: monaco.Range): Range {
    return toLspRange(monacoRange);
  }
}

class ManagedModel extends Disposable {
  constructor(
    private readonly _textModel: monaco.editor.ITextModel,
    private readonly _api: typeof api.TServerInterface,
    _syncKind: TextDocumentSyncKind,
    onWillDisposeModel: () => void,
  ) {
    super();

    this._register(_textModel.onWillDispose(onWillDisposeModel));

    // Percent-encoded, as servers write uris, so their answers match it.
    const uri = _textModel.uri.toString();

    this._api.textDocumentDidOpen({
      textDocument: {
        languageId: _textModel.getLanguageId(),
        uri: uri,
        version: _textModel.getVersionId(),
        text: _textModel.getValue(),
      },
    });

    if (_syncKind !== TextDocumentSyncKind.None) {
      this._register(
        _textModel.onDidChangeContent((e) => {
          const contentChanges: TextDocumentContentChangeEvent[] =
            _syncKind === TextDocumentSyncKind.Full
              ? [{ text: _textModel.getValue() }]
              : e.changes.map((c) => toLspTextDocumentContentChangeEvent(c));

          this._api.textDocumentDidChange({
            textDocument: { uri: uri, version: _textModel.getVersionId() },
            contentChanges: contentChanges,
          });
        }),
      );
    }

    this._register({
      dispose: () => {
        this._api.textDocumentDidClose({ textDocument: { uri: uri } });
      },
    });
  }
}

function toLspTextDocumentContentChangeEvent(
  change: monaco.editor.IModelContentChange,
): TextDocumentContentChangeEvent {
  return { range: toLspRange(change.range), rangeLength: change.rangeLength, text: change.text };
}
