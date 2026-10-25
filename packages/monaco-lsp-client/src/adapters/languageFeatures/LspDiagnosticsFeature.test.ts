import { beforeEach, describe, expect, mock, test } from "bun:test";

import type * as monaco from "monaco-editor";

import { fakeMonaco, fakeMonacoModule } from "../../testing/fake-monaco";
import type { PublishDiagnosticsParams } from "../../types";
import type { LspConnection } from "../LspConnection";

mock.module("monaco-editor", () => fakeMonacoModule);

const { LspDiagnosticsFeature } = await import("./LspDiagnosticsFeature");

const URI = "file:///wt/app.py";

/** A diagnostics feature on a fake connection, plus a way to deliver `publishDiagnostics`. */
function setup(model: monaco.editor.ITextModel) {
  let publish: ((params: PublishDiagnosticsParams) => void) | undefined;
  const noop = { dispose: () => {} };
  const connection = {
    capabilities: {
      addStaticClientCapabilities: () => noop,
      registerCapabilityHandler: () => noop,
    },
    connection: {
      registerNotificationHandler: (_type: unknown, handler: typeof publish) => {
        publish = handler;
        return noop;
      },
      registerRequestHandler: () => noop,
    },
    bridge: { translateBack: () => ({ textModel: model }) },
  } as unknown as LspConnection;
  const feature = new LspDiagnosticsFeature(connection);
  const send = (message: string) =>
    publish?.({
      uri: URI,
      diagnostics: [
        { message, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
      ],
    });
  return { feature, send };
}

function messagesByOwner(): string[][] {
  return [...fakeMonaco.markers.values()].map((byModel) =>
    (byModel.get(URI) ?? []).map((marker) => marker.message),
  );
}

describe("LspDiagnosticsFeature", () => {
  beforeEach(() => {
    fakeMonaco.reset();
  });

  test("clients publishing for the same model keep separate markers", () => {
    const model = { uri: { toString: () => URI }, isDisposed: () => false };
    const pyright = setup(model as unknown as monaco.editor.ITextModel);
    const ruff = setup(model as unknown as monaco.editor.ITextModel);

    pyright.send("type error");
    ruff.send("unused import");
    pyright.send("another type error");
    expect(messagesByOwner()).toEqual([["another type error"], ["unused import"]]);

    // A disposed client's markers go with it; the other server's stay.
    ruff.feature.dispose();
    expect(messagesByOwner()).toEqual([["another type error"]]);
  });
});
