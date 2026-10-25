import * as monaco from "monaco-editor";

import type { RenameRegistrationOptions } from "../../types";
import { capabilities } from "../../types";
import { Disposable } from "../../utils";
import { LspConnection } from "../LspConnection";
import { toMonacoLanguageSelector } from "./common";

export class LspRenameFeature extends Disposable {
  constructor(private readonly _connection: LspConnection) {
    super();

    this._register(
      this._connection.capabilities.addStaticClientCapabilities({
        textDocument: { rename: { dynamicRegistration: true, prepareSupport: true } },
      }),
    );

    this._register(
      this._connection.capabilities.registerCapabilityHandler(
        capabilities.textDocumentRename,
        true,
        (capability) => {
          return monaco.languages.registerRenameProvider(
            toMonacoLanguageSelector(
              capability.documentSelector,
              this._connection.defaultLanguageIds,
            ),
            new LspRenameProvider(this._connection, capability),
          );
        },
      ),
    );
  }
}

class LspRenameProvider implements monaco.languages.RenameProvider {
  constructor(
    private readonly _client: LspConnection,
    private readonly _capabilities: RenameRegistrationOptions,
  ) {}

  /**
   * Applies the rename itself and hands Monaco an empty edit: Monaco's standalone bulk-edit
   * service can only edit open models, and a rename usually touches files that are not open.
   */
  async provideRenameEdits(
    model: monaco.editor.ITextModel,
    position: monaco.Position,
    newName: string,
    token: monaco.CancellationToken,
  ): Promise<(monaco.languages.WorkspaceEdit & monaco.languages.Rejection) | null> {
    if (!this._client.bridge.isSyncedModel(model)) return null;
    const translated = this._client.bridge.translate(model, position);

    const result = await this._client.server.textDocumentRename({
      textDocument: translated.textDocument,
      position: translated.position,
      newName,
    });

    // Monaco cancels when the user moves on (types, moves the caret) before the edit arrives.
    if (!result || token.isCancellationRequested) {
      return null;
    }

    const applied = await this._client.edits.apply(result);
    return applied.applied ? { edits: [] } : { edits: [], rejectReason: applied.failureReason };
  }

  async resolveRenameLocation(
    model: monaco.editor.ITextModel,
    position: monaco.Position,
    _token: monaco.CancellationToken,
  ): Promise<monaco.languages.RenameLocation | null> {
    if (!this._client.bridge.isSyncedModel(model)) return null;
    if (!this._capabilities.prepareProvider) {
      return null;
    }

    const translated = this._client.bridge.translate(model, position);

    const result = await this._client.server.textDocumentPrepareRename({
      textDocument: translated.textDocument,
      position: translated.position,
    });

    if (!result) {
      return null;
    }

    if ("range" in result && "placeholder" in result) {
      return {
        range: this._client.bridge.translateBackRange(translated.textDocument, result.range).range,
        text: result.placeholder,
      };
    } else if ("defaultBehavior" in result) {
      return null;
    } else if ("start" in result && "end" in result) {
      const range = this._client.bridge.translateBackRange(translated.textDocument, result).range;
      return { range, text: model.getValueInRange(range) };
    }

    return null;
  }
}
