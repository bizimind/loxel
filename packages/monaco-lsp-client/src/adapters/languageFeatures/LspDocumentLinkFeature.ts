import * as monaco from "monaco-editor";

import type { DocumentLinkRegistrationOptions } from "../../types";
import { capabilities } from "../../types";
import { Disposable } from "../../utils";
import { LspConnection } from "../LspConnection";
import { toMonacoLanguageSelector } from "./common";

export class LspDocumentLinkFeature extends Disposable {
  constructor(private readonly _connection: LspConnection) {
    super();

    this._register(
      this._connection.capabilities.addStaticClientCapabilities({
        textDocument: { documentLink: { dynamicRegistration: true, tooltipSupport: true } },
      }),
    );

    this._register(
      this._connection.capabilities.registerCapabilityHandler(
        capabilities.textDocumentDocumentLink,
        true,
        (capability) => {
          return monaco.languages.registerLinkProvider(
            toMonacoLanguageSelector(
              capability.documentSelector,
              this._connection.defaultLanguageIds,
            ),
            new LspDocumentLinkProvider(this._connection, capability),
          );
        },
      ),
    );
  }
}

/**
 * Whether a link target is a `command:` URI. A document link names a location to open; Monaco
 * would run a `command:` target as an editor command instead, so such links are not shown.
 */
function isCommandTarget(target: string | undefined): boolean {
  return target !== undefined && /^\s*command:/i.test(target);
}

class LspDocumentLinkProvider implements monaco.languages.LinkProvider {
  constructor(
    private readonly _client: LspConnection,
    private readonly _capabilities: DocumentLinkRegistrationOptions,
  ) {}

  async provideLinks(
    model: monaco.editor.ITextModel,
    _token: monaco.CancellationToken,
  ): Promise<monaco.languages.ILinksList | null> {
    if (!this._client.bridge.isSyncedModel(model)) return null;
    const translated = this._client.bridge.translate(model, new monaco.Position(1, 1));

    const result = await this._client.server.textDocumentDocumentLink({
      textDocument: translated.textDocument,
    });

    if (!result) {
      return null;
    }

    return {
      links: result
        .filter((link) => !isCommandTarget(link.target))
        .map((link) => ({
          range: this._client.bridge.translateBackRange(translated.textDocument, link.range).range,
          url: link.target,
          tooltip: link.tooltip,
        })),
    };
  }

  async resolveLink(
    link: monaco.languages.ILink,
    _token: monaco.CancellationToken,
  ): Promise<monaco.languages.ILink> {
    if (!this._capabilities.resolveProvider) {
      return link;
    }

    // TODO: Implement resolve
    return link;
  }
}
