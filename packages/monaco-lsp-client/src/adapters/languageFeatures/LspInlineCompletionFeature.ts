import * as monaco from "monaco-editor";

import type {
  InlineCompletionItem,
  InlineCompletionRegistrationOptions,
  StringValue,
} from "../../types";
import { capabilities, InlineCompletionTriggerKind } from "../../types";
import { Disposable } from "../../utils";
import { LspConnection } from "../LspConnection";
import { toMonacoCommand, toMonacoLanguageSelector } from "./common";

export class LspInlineCompletionFeature extends Disposable {
  constructor(private readonly _connection: LspConnection) {
    super();

    this._register(
      this._connection.capabilities.addStaticClientCapabilities({
        textDocument: { inlineCompletion: { dynamicRegistration: true } },
      }),
    );

    this._register(
      this._connection.capabilities.registerCapabilityHandler(
        capabilities.textDocumentInlineCompletion,
        true,
        (capability) =>
          monaco.languages.registerInlineCompletionsProvider(
            toMonacoLanguageSelector(
              capability.documentSelector,
              this._connection.defaultLanguageIds,
            ),
            new LspInlineCompletionProvider(this._connection, capability),
          ),
      ),
    );
  }
}

class LspInlineCompletionProvider implements monaco.languages.InlineCompletionsProvider {
  constructor(
    private readonly _client: LspConnection,
    private readonly _capabilities: InlineCompletionRegistrationOptions,
  ) {}

  async provideInlineCompletions(
    model: monaco.editor.ITextModel,
    position: monaco.Position,
    context: monaco.languages.InlineCompletionContext,
    _token: monaco.CancellationToken,
  ): Promise<monaco.languages.InlineCompletions | null> {
    const translated = this._client.bridge.translate(model, position);

    const result = await this._client.server.textDocumentInlineCompletion({
      textDocument: translated.textDocument,
      position: translated.position,
      context: {
        // Monaco Automatic=0 → LSP Automatic=1; Monaco Explicit=1 → LSP Invoked=0
        triggerKind:
          context.triggerKind === monaco.languages.InlineCompletionTriggerKind.Automatic
            ? InlineCompletionTriggerKind.Automatic
            : InlineCompletionTriggerKind.Invoked,
        selectedCompletionInfo: context.selectedSuggestionInfo
          ? {
              range: this._client.bridge.translateRange(
                model,
                monaco.Range.lift(context.selectedSuggestionInfo.range),
              ),
              text: context.selectedSuggestionInfo.text,
            }
          : undefined,
      },
    });

    if (!result) {
      return null;
    }

    const items: InlineCompletionItem[] = Array.isArray(result) ? result : result.items;

    return { items: items.map((item) => toMonacoInlineCompletion(item, this._client, translated)) };
  }

  disposeInlineCompletions(_completions: monaco.languages.InlineCompletions): void {}
}

function toMonacoInlineCompletion(
  item: InlineCompletionItem,
  client: LspConnection,
  translated: { textDocument: { uri: string } },
): monaco.languages.InlineCompletion {
  const insertText: string | { snippet: string } =
    typeof item.insertText === "string"
      ? item.insertText
      : { snippet: (item.insertText as StringValue).value };

  return {
    insertText,
    range: item.range
      ? client.bridge.translateBackRange(translated.textDocument, item.range).range
      : undefined,
    command: toMonacoCommand(item.command),
  };
}
