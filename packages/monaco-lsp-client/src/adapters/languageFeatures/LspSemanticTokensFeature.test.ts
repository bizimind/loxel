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
  let version = 1;
  const model = {
    getPositionAt: () => ({ lineNumber: 1, column: 1 }),
    getVersionId: () => version,
    isDisposed: () => false,
  } as unknown as monaco.editor.ITextModel;
  const requests: unknown[] = [];
  /** Called once, as the next request is answered, before the answer reaches the provider. */
  let onRequest = () => {};
  const connection = {
    bridge: {
      isSyncedModel: () => true,
      translate: () => ({ textDocument: { uri: "file:///a.rs" } }),
    },
    server: {
      textDocumentSemanticTokensFull: (params: unknown) => {
        requests.push(params);
        const callback = onRequest;
        onRequest = () => {};
        callback();
        return Promise.resolve({ data });
      },
    },
  } as unknown as LspConnection;
  const provider = new LspSemanticTokensProvider(
    connection,
    { legend: LEGEND, documentSelector: null },
    () => ({ dispose: () => {} }),
    new Set(),
    () => {},
    styling,
  );
  const edit = () => {
    version++;
  };
  const whenRequested = (callback: () => void) => {
    onRequest = callback;
  };
  return { provider, model, requests, edit, whenRequested };
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

  test("drops an answer the model moved past, without asking again itself", async () => {
    // Which content the answer is for is not known (rust-analyzer can answer for newer content),
    // so Monaco keeps its own shifted tokens and asks again.
    const { provider, model, requests, edit, whenRequested } = setup([0, 0, 1, 2, 0]);
    whenRequested(edit);
    const answer = provider.provideDocumentSemanticTokens(model, null, cancellation);
    await expect(answer).rejects.toMatchObject({ name: "Canceled", message: "Canceled" });
    expect(requests).toHaveLength(1);
  });
});
