import { beforeEach, describe, expect, mock, test } from "bun:test";

import type * as monaco from "monaco-editor";

import { fakeMonaco, fakeMonacoModule } from "../../testing/fake-monaco";
import type { ClientCapabilities, CompletionItem, Range, TextEdit } from "../../types";
import { InsertTextFormat, capabilities } from "../../types";
import type { IDisposable } from "../../utils";
import type { LspConnection } from "../LspConnection";

mock.module("monaco-editor", () => fakeMonacoModule);

const { LspCompletionFeature } = await import("./LspCompletionFeature");

const URI = "file:///wt/main.rs";
const model = {
  uri: fakeMonacoModule.Uri.parse(URI),
  isDisposed: () => false,
  getLanguageId: () => "rust",
} as unknown as monaco.editor.ITextModel;
const position = { lineNumber: 3, column: 3 } as monaco.Position;
const word: Range = { start: { line: 2, character: 0 }, end: { line: 2, character: 2 } };
const importEdit: TextEdit = {
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
  newText: "use std::fmt;\n",
};

/** The completion feature on a fake connection whose server answers `items` and `resolve`. */
function client(items: CompletionItem[], resolve: (item: CompletionItem) => CompletionItem) {
  const declared: ClientCapabilities[] = [];
  const resolved: CompletionItem[] = [];
  const handlers = new Map<unknown, (options: unknown) => IDisposable>();
  const noop = { dispose: () => {} };
  const connection = {
    server: {
      textDocumentCompletion: async () => items,
      completionItemResolve: async (item: CompletionItem) => {
        resolved.push(item);
        return resolve(item);
      },
    },
    capabilities: {
      addStaticClientCapabilities: (capability: ClientCapabilities) => {
        declared.push(capability);
        return noop;
      },
      registerCapabilityHandler: (capability: unknown, _static: boolean, handler: never) => {
        handlers.set(capability, handler);
        return noop;
      },
    },
    bridge: {
      isSyncedModel: () => true,
      translate: () => ({ textDocument: { uri: URI }, position: { line: 2, character: 2 } }),
      translateBackRange: (_document: unknown, range: Range) => ({ textModel: model, range }),
    },
    commands: { toMonacoCommand: () => undefined },
    defaultLanguageIds: ["rust"],
  } as unknown as LspConnection;

  const feature = new LspCompletionFeature(connection);
  handlers.get(capabilities.textDocumentCompletion)?.({
    documentSelector: null,
    resolveProvider: true,
  });
  const provider = fakeMonaco.providers.get(
    "CompletionItem",
  ) as monaco.languages.CompletionItemProvider;

  async function suggestions(): Promise<monaco.languages.CompletionItem[]> {
    const list = await provider.provideCompletionItems(
      model,
      position,
      { triggerKind: 0 } as monaco.languages.CompletionContext,
      { isCancellationRequested: false } as monaco.CancellationToken,
    );
    return list?.suggestions ?? [];
  }

  return { declared, feature, provider, resolved, suggestions };
}

beforeEach(() => fakeMonaco.reset());

describe("LspCompletionFeature", () => {
  test("declares snippets and deferring additional text edits to resolve", () => {
    const { declared } = client([], (item) => item);
    const completionItem = declared[0]?.textDocument?.completion?.completionItem;
    expect(completionItem?.snippetSupport).toBe(true);
    expect(completionItem?.resolveSupport).toEqual({ properties: ["additionalTextEdits"] });
  });

  test("inserts only items in snippet format as snippets", async () => {
    const newText = "foo(${1:a})$0";
    const { suggestions } = client(
      [
        {
          label: "foo(…)",
          insertTextFormat: InsertTextFormat.Snippet,
          textEdit: { range: word, newText },
        },
        { label: "$plain", textEdit: { range: word, newText: "$plain" } },
      ],
      (item) => item,
    );
    const [snippet, plain] = await suggestions();
    expect(snippet?.insertText).toBe(newText);
    // The fake's enum members read as their names.
    expect(String(snippet?.insertTextRules)).toBe("InsertAsSnippet");
    expect(plain?.insertText).toBe("$plain");
    expect(plain?.insertTextRules).toBeUndefined();
  });

  test("fills in the additional text edits a server defers to resolve", async () => {
    const data = { imports: [{ path: "std::fmt" }] };
    const item: CompletionItem = { label: "fmt", data, textEdit: { range: word, newText: "fmt" } };
    const { provider, resolved, suggestions } = client([item], (original) => ({
      ...original,
      additionalTextEdits: [importEdit],
    }));
    const [suggestion] = await suggestions();
    expect(suggestion?.additionalTextEdits).toBeUndefined();

    await provider.resolveCompletionItem?.(
      suggestion as monaco.languages.CompletionItem,
      {} as monaco.CancellationToken,
    );
    // The server gets its item back as it sent it, `data` included.
    expect(resolved).toEqual([item]);
    expect(suggestion?.additionalTextEdits).toEqual([
      { range: importEdit.range, text: importEdit.newText } as never,
    ]);
  });
});
