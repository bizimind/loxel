import * as monaco from "monaco-editor";

import type {
  Diagnostic,
  DiagnosticRegistrationOptions,
  DocumentDiagnosticReport,
  FullDocumentDiagnosticReport,
  PublishDiagnosticsParams,
  UnchangedDocumentDiagnosticReport,
} from "../../types";
import { api, capabilities } from "../../types";
import { Disposable, DisposableStore } from "../../utils";
import { LspConnection } from "../LspConnection";
import {
  lspDiagnosticTagToMonacoMarkerTag,
  matchesDocumentSelector,
  toDiagnosticMarker,
} from "./common";

let markerOwnerCount = 0;

/**
 * The fields a Monaco marker keeps of the diagnostic it was made from. Monaco hands code action
 * providers its stored copies of the markers, so this is how they are matched back to diagnostics.
 * The range is sanitized as Monaco's marker service stores it (an end before the start moves to
 * the start), so a server's inverted range still matches.
 */
function markerKey(marker: monaco.editor.IMarkerData): string {
  const code = typeof marker.code === "object" ? marker.code.value : marker.code;
  const startLineNumber = marker.startLineNumber > 0 ? marker.startLineNumber : 1;
  const startColumn = marker.startColumn > 0 ? marker.startColumn : 1;
  return JSON.stringify([
    marker.severity,
    startLineNumber,
    startColumn,
    marker.endLineNumber >= startLineNumber ? marker.endLineNumber : startLineNumber,
    marker.endColumn > 0 ? marker.endColumn : startColumn,
    marker.message,
    code,
    marker.source,
  ]);
}

/** Monaco's markers are `IMarker`s, with their owner, though providers are typed `IMarkerData`. */
function markerOwner(marker: monaco.editor.IMarkerData): unknown {
  return "owner" in marker ? marker.owner : undefined;
}

export class LspDiagnosticsFeature extends Disposable {
  private readonly _pullDiagnosticProviders = new Map<
    monaco.editor.ITextModel,
    ModelDiagnosticProvider
  >();
  /**
   * The diagnostics behind this client's markers, by model URI and `markerKey`, since a marker
   * keeps neither `data` nor the rest of what servers expect back in a code action request.
   */
  private readonly _diagnostics = new Map<string, Map<string, Diagnostic[]>>();

  /**
   * @param _diagnosticsMarkerOwner Per client, so servers sharing a model (basedpyright and ruff for
   * Python) keep their own markers.
   */
  constructor(
    private readonly _connection: LspConnection,
    private readonly _diagnosticsMarkerOwner = `lsp-${++markerOwnerCount}`,
  ) {
    super();

    // The client's markers must not outlive it.
    this._register({
      dispose: () => {
        monaco.editor.removeAllMarkers(this._diagnosticsMarkerOwner);
        this._diagnostics.clear();
      },
    });
    // A closed file's diagnostics would otherwise stay: the server's empty report for it arrives
    // after its model is gone.
    this._register(
      monaco.editor.onWillDisposeModel((model) => this._diagnostics.delete(model.uri.toString())),
    );

    this._register(
      this._connection.capabilities.addStaticClientCapabilities({
        textDocument: {
          publishDiagnostics: {
            relatedInformation: true,
            tagSupport: { valueSet: [...lspDiagnosticTagToMonacoMarkerTag.keys()] },
            versionSupport: true,
            codeDescriptionSupport: true,
            dataSupport: true,
          },
          diagnostic: { dynamicRegistration: true, relatedDocumentSupport: true },
        },
        workspace: { diagnostics: { refreshSupport: true } },
      }),
    );

    this._register(
      this._connection.connection.registerNotificationHandler(
        api.client.textDocumentPublishDiagnostics,
        (params) => this._handlePublishDiagnostics(params),
      ),
    );

    this._register(
      this._connection.connection.registerRequestHandler(
        api.client.workspaceDiagnosticRefresh,
        async () => {
          for (const provider of this._pullDiagnosticProviders.values()) {
            provider.refresh();
          }
          return { ok: null };
        },
      ),
    );

    this._register(
      this._connection.capabilities.registerCapabilityHandler(
        capabilities.textDocumentDiagnostic,
        true,
        (capability) => {
          const disposables = new DisposableStore();
          for (const model of monaco.editor.getModels()) {
            this._addPullDiagnosticProvider(model, capability, disposables);
          }
          disposables.add(
            monaco.editor.onDidCreateModel((model) => {
              this._addPullDiagnosticProvider(model, capability, disposables);
            }),
          );
          return disposables;
        },
      ),
    );
  }

  private _addPullDiagnosticProvider(
    model: monaco.editor.ITextModel,
    capability: DiagnosticRegistrationOptions,
    disposables: DisposableStore,
  ): void {
    if (!this._connection.bridge.isSyncedModel(model)) return;
    if (
      !matchesDocumentSelector(
        model,
        capability.documentSelector,
        this._connection.defaultLanguageIds,
      )
    ) {
      return;
    }

    const provider = new ModelDiagnosticProvider(model, this._connection, capability, (m, items) =>
      this._setDiagnostics(m, items),
    );

    this._pullDiagnosticProviders.set(model, provider);
    disposables.add(provider);

    disposables.add(
      model.onWillDispose(() => {
        this._pullDiagnosticProviders.delete(model);
      }),
    );
  }

  private _handlePublishDiagnostics(params: PublishDiagnosticsParams): void {
    const uri = params.uri;

    try {
      const translated = this._connection.bridge.translateBack({ uri }, { line: 0, character: 0 });
      const model = translated.textModel;

      if (!model || model.isDisposed()) {
        return;
      }

      this._setDiagnostics(model, params.diagnostics);
    } catch (error) {
      // Model not found or already disposed - this is normal when files are closed
      console.debug(`Could not set diagnostics for ${uri}:`, error);
    }
  }

  private _setDiagnostics(model: monaco.editor.ITextModel, diagnostics: readonly Diagnostic[]) {
    const byKey = new Map<string, Diagnostic[]>();
    const markers = diagnostics.map((diagnostic) => {
      const marker = toDiagnosticMarker(diagnostic);
      const key = markerKey(marker);
      byKey.set(key, [...(byKey.get(key) ?? []), diagnostic]);
      return marker;
    });
    const uri = model.uri.toString();
    if (byKey.size > 0) this._diagnostics.set(uri, byKey);
    else this._diagnostics.delete(uri);
    monaco.editor.setModelMarkers(model, this._diagnosticsMarkerOwner, markers);
  }

  /**
   * The diagnostics this client's server sent for the markers among `markers` (Monaco's markers
   * on `model`) that it owns, as the server sent them, for a code action request's context: servers
   * find their fixes by a diagnostic's `code`, `source` and `data`. Other clients' markers are left
   * out, since their diagnostics mean nothing to this server.
   */
  diagnosticsForMarkers(
    model: monaco.editor.ITextModel,
    markers: readonly monaco.editor.IMarkerData[],
  ): Diagnostic[] {
    const byKey = this._diagnostics.get(model.uri.toString());
    if (!byKey) return [];
    // Identical markers stand for as many diagnostics, in order.
    const taken = new Map<string, number>();
    const result: Diagnostic[] = [];
    for (const marker of markers) {
      if (markerOwner(marker) !== this._diagnosticsMarkerOwner) continue;
      const key = markerKey(marker);
      const index = taken.get(key) ?? 0;
      const diagnostic = byKey.get(key)?.[index];
      if (!diagnostic) continue;
      taken.set(key, index + 1);
      result.push(diagnostic);
    }
    return result;
  }
}

/**
 * Manages pull diagnostics for a single text model
 */
class ModelDiagnosticProvider extends Disposable {
  private _updateHandle: number | undefined;
  /** Set on dispose, so an answer arriving afterwards does not overwrite a later client's markers. */
  private _disposed = false;
  private _previousResultId: string | undefined;

  constructor(
    private readonly _model: monaco.editor.ITextModel,
    private readonly _connection: LspConnection,
    private readonly _capability: DiagnosticRegistrationOptions,
    private readonly _setDiagnostics: (
      model: monaco.editor.ITextModel,
      diagnostics: readonly Diagnostic[],
    ) => void,
  ) {
    super();
    this._register(
      this._model.onDidChangeContent(() => {
        this._scheduleDiagnosticUpdate();
      }),
    );
    this._scheduleDiagnosticUpdate();
  }

  public refresh(): void {
    this._scheduleDiagnosticUpdate();
  }

  private _scheduleDiagnosticUpdate(): void {
    if (this._updateHandle !== undefined) {
      clearTimeout(this._updateHandle);
    }

    this._updateHandle = window.setTimeout(() => {
      this._updateHandle = undefined;
      this._requestDiagnostics();
    }, 500);
  }

  private async _requestDiagnostics(): Promise<void> {
    if (this._model.isDisposed()) {
      return;
    }

    try {
      const translated = this._connection.bridge.translate(this._model, new monaco.Position(1, 1));

      const result = await this._connection.server.textDocumentDiagnostic({
        textDocument: translated.textDocument,
        identifier: this._capability.identifier,
        previousResultId: this._previousResultId,
      });

      if (this._disposed || this._model.isDisposed()) {
        return;
      }

      this._handleDiagnosticReport(result);
    } catch (error) {
      console.error("Error requesting diagnostics:", error);
    }
  }

  private _handleDiagnosticReport(report: DocumentDiagnosticReport): void {
    if (report.kind === "full") {
      // Full diagnostic report
      this._previousResultId = report.resultId;

      this._setDiagnostics(this._model, report.items);

      // Handle related documents if present
      if ("relatedDocuments" in report && report.relatedDocuments) {
        this._handleRelatedDocuments(report.relatedDocuments);
      }
    } else if (report.kind === "unchanged") {
      // Unchanged report - diagnostics are still valid
      this._previousResultId = report.resultId;
      // No need to update markers
    }
  }

  private _handleRelatedDocuments(relatedDocuments: {
    [key: string]: FullDocumentDiagnosticReport | UnchangedDocumentDiagnosticReport;
  }): void {
    for (const [uri, report] of Object.entries(relatedDocuments)) {
      try {
        const translated = this._connection.bridge.translateBack(
          { uri },
          { line: 0, character: 0 },
        );
        const model = translated.textModel;

        if (!model || model.isDisposed()) {
          continue;
        }

        if (report.kind === "full") this._setDiagnostics(model, report.items);
      } catch (error) {
        // Model not found - this is normal
        console.debug(`Could not set related diagnostics for ${uri}:`, error);
      }
    }
  }

  override dispose(): void {
    this._disposed = true;
    if (this._updateHandle !== undefined) {
      clearTimeout(this._updateHandle);
      this._updateHandle = undefined;
    }
    super.dispose();
  }
}
