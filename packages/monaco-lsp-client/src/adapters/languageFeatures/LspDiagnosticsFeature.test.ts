import { beforeEach, describe, expect, mock, test } from "bun:test";

import type * as monaco from "monaco-editor";

import { fakeMonaco, fakeMonacoModule } from "../../testing/fake-monaco";
import type { Diagnostic, PublishDiagnosticsParams } from "../../types";
import type { LspConnection } from "../LspConnection";

mock.module("monaco-editor", () => fakeMonacoModule);

const { LspDiagnosticsFeature } = await import("./LspDiagnosticsFeature");

const URI = "file:///wt/app.py";

/** A diagnostics feature on a fake connection, plus a way to deliver `publishDiagnostics`. */
function setup(model: monaco.editor.ITextModel, markerOwner?: string) {
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
  const feature = new LspDiagnosticsFeature(connection, markerOwner);
  const send = (message: string, extra?: Partial<Diagnostic>) =>
    publish?.({
      uri: URI,
      diagnostics: [
        {
          message,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          ...extra,
        },
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

  test("a given owner is used, and the next client of a route takes it over", () => {
    const model = { uri: { toString: () => URI }, isDisposed: () => false };
    const first = setup(model as unknown as monaco.editor.ITextModel, "python-lsp");
    first.send("old worktree");
    expect([...fakeMonaco.markers.keys()]).toEqual(["python-lsp"]);

    first.feature.dispose();
    const next = setup(model as unknown as monaco.editor.ITextModel, "python-lsp");
    next.send("new worktree");
    expect([...fakeMonaco.markers.keys()]).toEqual(["python-lsp"]);
    expect(messagesByOwner()).toEqual([["new worktree"]]);
  });

  test("a code with a description links to its documentation", () => {
    const model = { uri: { toString: () => URI }, isDisposed: () => false };
    const mypy = setup(model as unknown as monaco.editor.ITextModel, "mypy-lsp");
    const href = "https://mypy.readthedocs.io/en/stable/_refs.html#code-assignment";
    mypy.send("Incompatible types", { code: "assignment", codeDescription: { href } });
    const [marker] = fakeMonaco.markers.get("mypy-lsp")?.get(URI) ?? [];
    const code = marker?.code;
    expect(typeof code === "object" ? [code.value, code.target.toString(true)] : code).toEqual([
      "assignment",
      href,
    ]);

    mypy.send("Plain code", { code: 7 });
    expect(fakeMonaco.markers.get("mypy-lsp")?.get(URI)?.[0]?.code).toBe("7");
  });
});
