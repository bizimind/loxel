import * as monaco from "monaco-editor";

import type { FoldingRangeRegistrationOptions } from "../../types";

import { capabilities, FoldingRangeKind, api } from "../../types";
import { Disposable } from "../../utils";
import { LspConnection } from "../LspConnection";
import { toMonacoLanguageSelector } from "./common";
import { toMonacoFoldingRangeKind } from "./common";

export class LspFoldingRangeFeature extends Disposable {
  private readonly _providers = new Set<LspFoldingRangeProvider>();

  constructor(private readonly _connection: LspConnection) {
    super();

    this._register(
      this._connection.capabilities.addStaticClientCapabilities({
        textDocument: {
          foldingRange: {
            dynamicRegistration: true,
            rangeLimit: 5000,
            lineFoldingOnly: false,
            foldingRangeKind: {
              valueSet: [
                FoldingRangeKind.Comment,
                FoldingRangeKind.Imports,
                FoldingRangeKind.Region,
              ],
            },
          },
        },
        workspace: { foldingRange: { refreshSupport: true } },
      }),
    );

    this._register(
      this._connection.connection.registerRequestHandler(
        api.client.workspaceFoldingRangeRefresh,
        async () => {
          for (const provider of this._providers) {
            provider.refresh();
          }
          return { ok: null };
        },
      ),
    );

    this._register(
      this._connection.capabilities.registerCapabilityHandler(
        capabilities.textDocumentFoldingRange,
        true,
        (capability) => {
          const provider = new LspFoldingRangeProvider(this._connection, capability);
          this._providers.add(provider);
          const registration = monaco.languages.registerFoldingRangeProvider(
            toMonacoLanguageSelector(
              capability.documentSelector,
              this._connection.defaultLanguageId,
            ),
            provider,
          );
          return {
            dispose: () => {
              this._providers.delete(provider);
              registration.dispose();
            },
          };
        },
      ),
    );
  }
}

class LspFoldingRangeProvider implements monaco.languages.FoldingRangeProvider {
  private readonly _onDidChangeEmitter = new monaco.Emitter<this>();
  public readonly onDidChange = this._onDidChangeEmitter.event;

  constructor(
    private readonly _client: LspConnection,
    private readonly _capabilities: FoldingRangeRegistrationOptions,
  ) {}

  public refresh(): void {
    this._onDidChangeEmitter.fire(this);
  }

  async provideFoldingRanges(
    model: monaco.editor.ITextModel,
    _context: monaco.languages.FoldingContext,
    _token: monaco.CancellationToken,
  ): Promise<monaco.languages.FoldingRange[] | null> {
    const translated = this._client.bridge.translate(model, new monaco.Position(1, 1));

    const result = await this._client.server.textDocumentFoldingRange({
      textDocument: translated.textDocument,
    });

    if (!result) {
      return null;
    }

    return result.map((range) => ({
      start: range.startLine + 1,
      end: range.endLine + 1,
      kind: toMonacoFoldingRangeKind(range.kind),
    }));
  }
}
