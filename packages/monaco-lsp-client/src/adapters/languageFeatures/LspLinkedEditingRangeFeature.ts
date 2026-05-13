import * as monaco from "monaco-editor";

import type { LinkedEditingRangeRegistrationOptions } from "../../types";

import { capabilities } from "../../types";
import { Disposable } from "../../utils";
import { LspConnection } from "../LspConnection";
import { toMonacoLanguageSelector } from "./common";

export class LspLinkedEditingRangeFeature extends Disposable {
  constructor(private readonly _connection: LspConnection) {
    super();

    this._register(
      this._connection.capabilities.addStaticClientCapabilities({
        textDocument: { linkedEditingRange: { dynamicRegistration: true } },
      }),
    );

    this._register(
      this._connection.capabilities.registerCapabilityHandler(
        capabilities.textDocumentLinkedEditingRange,
        true,
        (capability) =>
          monaco.languages.registerLinkedEditingRangeProvider(
            toMonacoLanguageSelector(
              capability.documentSelector,
              this._connection.defaultLanguageIds,
            ),
            new LspLinkedEditingRangeProvider(this._connection, capability),
          ),
      ),
    );
  }
}

class LspLinkedEditingRangeProvider implements monaco.languages.LinkedEditingRangeProvider {
  constructor(
    private readonly _client: LspConnection,
    private readonly _capabilities: LinkedEditingRangeRegistrationOptions,
  ) {}

  async provideLinkedEditingRanges(
    model: monaco.editor.ITextModel,
    position: monaco.Position,
    _token: monaco.CancellationToken,
  ): Promise<monaco.languages.LinkedEditingRanges | null> {
    const translated = this._client.bridge.translate(model, position);

    const result = await this._client.server.textDocumentLinkedEditingRange({
      textDocument: translated.textDocument,
      position: translated.position,
    });

    if (!result) {
      return null;
    }

    let wordPattern: RegExp | undefined;
    if (result.wordPattern !== undefined) {
      try {
        wordPattern = new RegExp(result.wordPattern);
      } catch {
        wordPattern = undefined;
      }
    }

    return {
      ranges: result.ranges.map(
        (r) => this._client.bridge.translateBackRange(translated.textDocument, r).range,
      ),
      wordPattern,
    };
  }
}
