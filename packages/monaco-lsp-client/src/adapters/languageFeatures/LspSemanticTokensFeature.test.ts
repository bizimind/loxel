import { describe, expect, mock, test } from "bun:test";

import type * as monaco from "monaco-editor";

import { fakeMonacoModule } from "../../testing/fake-monaco";
import type { LspConnection } from "../LspConnection";
import type { SemanticTokenStyling } from "./LspSemanticTokensFeature";

mock.module("monaco-editor", () => fakeMonacoModule);

const { LspSemanticTokensProvider } = await import("./LspSemanticTokensFeature");

const LEGEND = {
  tokenTypes: ["function", "macro", "variable"],
  tokenModifiers: ["declaration", "readonly", "local"],
};
const STYLING: SemanticTokenStyling = {
  types: new Set(["function", "variable"]),
  modifiers: new Set(["readonly", "local"]),
};
const cancellation = { isCancellationRequested: false } as monaco.CancellationToken;

function setup(data: number[], styling?: SemanticTokenStyling) {
  const model = {
    getPositionAt: () => ({ lineNumber: 1, column: 1 }),
    getVersionId: () => 1,
    isDisposed: () => false,
  } as unknown as monaco.editor.ITextModel;
  const connection = {
    bridge: {
      isSyncedModel: () => true,
      translate: () => ({ textDocument: { uri: "file:///a.rs" } }),
    },
    server: { textDocumentSemanticTokensFull: () => Promise.resolve({ data }) },
  } as unknown as LspConnection;
  const provider = new LspSemanticTokensProvider(
    connection,
    { legend: LEGEND, documentSelector: null },
    () => ({ dispose: () => {} }),
    new Set(),
    () => {},
    styling,
  );
  return { provider, model };
}

describe("LspSemanticTokensProvider", () => {
  test("blanks the types the theme has no rule for, keeping indexes stable", () => {
    const { provider } = setup([], STYLING);
    expect(provider.getLegend().tokenTypes).toEqual(["function", "", "variable"]);
  });

  test("drops modifiers no rule names from tokens", async () => {
    // variable.declaration.readonly, then variable.declaration.readonly.local
    const { provider, model } = setup([0, 0, 1, 2, 0b011, 1, 0, 1, 2, 0b111], STYLING);
    const tokens = await provider.provideDocumentSemanticTokens(model, null, cancellation);
    expect(tokens).toMatchObject({ data: new Uint32Array([0, 0, 1, 2, 0b010, 1, 0, 1, 2, 0b110]) });
  });

  test("passes the legend and tokens through without styling", async () => {
    const { provider, model } = setup([0, 0, 1, 2, 0b011]);
    expect(provider.getLegend()).toEqual(LEGEND);
    const tokens = await provider.provideDocumentSemanticTokens(model, null, cancellation);
    expect(tokens).toMatchObject({ data: new Uint32Array([0, 0, 1, 2, 0b011]) });
  });
});
