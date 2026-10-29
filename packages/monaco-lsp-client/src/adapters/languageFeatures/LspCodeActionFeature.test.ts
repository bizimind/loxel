import { beforeEach, describe, expect, mock, test } from "bun:test";

import type * as monaco from "monaco-editor";

import { fakeMonaco, fakeMonacoModule } from "../../testing/fake-monaco";
import type {
  CodeAction,
  CodeActionParams,
  Diagnostic,
  PublishDiagnosticsParams,
} from "../../types";
import { CodeActionKind, capabilities } from "../../types";
import type { IDisposable } from "../../utils";
import type { LspConnection } from "../LspConnection";

mock.module("monaco-editor", () => fakeMonacoModule);

const { LspCodeActionFeature } = await import("./LspCodeActionFeature");
const { LspDiagnosticsFeature } = await import("./LspDiagnosticsFeature");

const URI = "file:///wt/app.py";
const model = {
  uri: fakeMonacoModule.Uri.parse(URI),
  isDisposed: () => false,
  getLanguageId: () => "python",
} as unknown as monaco.editor.ITextModel;
const range = (line: number) => ({ start: { line, character: 0 }, end: { line, character: 9 } });

/** ruff's diagnostic for an unused import, with the fix it reads back from `data`. */
const unusedImport: Diagnostic = {
  range: range(0),
  severity: 2,
  code: "F401",
  codeDescription: { href: "https://docs.astral.sh/ruff/rules/unused-import" },
  source: "Ruff",
  message: "`os` imported but unused",
  tags: [1],
  data: { title: "Remove unused import: `os`", edits: [] },
};

/**
 * One client's diagnostics and code action features on a fake connection. Its server answers
 * code actions like ruff: a fix for each context diagnostic that carries its `data`.
 */
function client(markerOwner: string, registration: { codeActionKinds?: string[] } = {}) {
  let publish: ((params: PublishDiagnosticsParams) => void) | undefined;
  const requests: CodeActionParams[] = [];
  const handlers = new Map<unknown, (options: unknown) => IDisposable>();
  const noop = { dispose: () => {} };
  const connection = {
    server: {
      textDocumentCodeAction: async (params: CodeActionParams): Promise<CodeAction[]> => {
        requests.push(params);
        return params.context.diagnostics.flatMap((d) =>
          isFix(d.data)
            ? [{ title: d.data.title, kind: CodeActionKind.QuickFix, diagnostics: [d] }]
            : [],
        );
      },
    },
    capabilities: {
      addStaticClientCapabilities: () => noop,
      registerCapabilityHandler: (capability: unknown, _static: boolean, handler: never) => {
        handlers.set(capability, handler);
        return noop;
      },
    },
    connection: {
      registerNotificationHandler: (_type: unknown, handler: typeof publish) => {
        publish = handler;
        return noop;
      },
      registerRequestHandler: () => noop,
    },
    bridge: {
      isSyncedModel: () => true,
      translate: () => ({ textDocument: { uri: URI }, position: { line: 0, character: 0 } }),
      translateBack: () => ({ textModel: model }),
      translateRange: () => range(0),
    },
    commands: { toMonacoCommand: () => undefined },
    edits: { unsupportedReason: () => undefined },
    defaultLanguageIds: ["python"],
  } as unknown as LspConnection;

  const diagnostics = new LspDiagnosticsFeature(connection, markerOwner);
  const codeActions = new LspCodeActionFeature(connection, diagnostics);
  const registered = handlers.get(capabilities.textDocumentCodeAction)?.({
    documentSelector: null,
    ...registration,
  });
  const provider = fakeMonaco.providers.get("CodeAction") as monaco.languages.CodeActionProvider;

  /** Ask for code actions the way Monaco does: with its copies of every owner's markers. */
  async function codeActionTitles(
    only?: string,
    markers = fakeMonaco.readMarkers(URI),
  ): Promise<string[]> {
    const context = { markers, only, trigger: 1 };
    const token = { isCancellationRequested: false } as monaco.CancellationToken;
    const list = await provider.provideCodeActions(
      model,
      { getStartPosition: () => ({ lineNumber: 1, column: 1 }) } as monaco.Range,
      context as unknown as monaco.languages.CodeActionContext,
      token,
    );
    return list?.actions.map((action) => action.title) ?? [];
  }

  return {
    diagnostics,
    codeActions,
    registered,
    requests,
    codeActionTitles,
    publish: (items: Diagnostic[]) => publish?.({ uri: URI, diagnostics: items }),
  };
}

function isFix(data: unknown): data is { title: string } {
  return typeof data === "object" && data !== null && "title" in data;
}

describe("LspCodeActionFeature", () => {
  beforeEach(() => {
    fakeMonaco.reset();
  });

  test("sends the server its own diagnostics back whole, so fixes found by `data` are offered", async () => {
    const pyright = client("python-lsp");
    const ruff = client("ruff-lsp");
    const typeError: Diagnostic = {
      range: range(0),
      message: "type error",
      source: "basedpyright",
    };
    pyright.publish([typeError]);
    // Two identical diagnostics but for their data: each marker stands for one of them.
    const twin = { ...unusedImport, data: { title: "Remove the other one", edits: [] } };
    ruff.publish([unusedImport, twin]);

    expect(await ruff.codeActionTitles()).toEqual([
      "Remove unused import: `os`",
      "Remove the other one",
    ]);
    // Only the client's own diagnostics: basedpyright's mean nothing to ruff, and the other way.
    expect(ruff.requests[0]?.context.diagnostics).toEqual([unusedImport, twin]);
    await pyright.codeActionTitles();
    expect(pyright.requests[0]?.context.diagnostics).toEqual([typeError]);
  });

  test("links the marker's code to its description", () => {
    client("ruff-lsp").publish([unusedImport]);
    const [marker] = fakeMonaco.readMarkers(URI);
    expect(marker?.code).toEqual({
      value: "F401",
      target: fakeMonacoModule.Uri.parse("https://docs.astral.sh/ruff/rules/unused-import"),
    });
  });

  test("a diagnostic replaced since the markers were read is not sent", async () => {
    const ruff = client("ruff-lsp");
    ruff.publish([unusedImport]);
    const stale = fakeMonaco.readMarkers(URI);
    ruff.publish([{ ...unusedImport, range: range(3) }]);
    expect(await ruff.codeActionTitles(undefined, stale)).toEqual([]);
    expect(ruff.requests[0]?.context.diagnostics).toEqual([]);
  });

  test("markers without this client's owner are not sent", async () => {
    const ruff = client("ruff-lsp");
    ruff.publish([unusedImport]);
    const ownerless = fakeMonaco.readMarkers(URI).map(({ owner: _owner, ...marker }) => marker);
    expect(ruff.diagnostics.diagnosticsForMarkers(model, ownerless)).toEqual([]);
  });

  test("a diagnostic with an inverted range matches Monaco's sanitized marker", async () => {
    const ruff = client("ruff-lsp");
    const inverted = { ...unusedImport, range: { start: range(4).start, end: range(2).end } };
    ruff.publish([inverted]);
    expect(await ruff.codeActionTitles()).toEqual(["Remove unused import: `os`"]);
  });

  test("a closed file's diagnostics, and a disposed client's, are dropped", () => {
    const ruff = client("ruff-lsp");
    ruff.publish([unusedImport]);
    const markers = fakeMonaco.readMarkers(URI);
    fakeMonaco.willDisposeModel.fire(model);
    expect(ruff.diagnostics.diagnosticsForMarkers(model, markers)).toEqual([]);

    ruff.publish([unusedImport]);
    ruff.diagnostics.dispose();
    expect(ruff.diagnostics.diagnosticsForMarkers(model, markers)).toEqual([]);
  });

  test("asks only for the kind Monaco asks for", async () => {
    const ruff = client("ruff-lsp");
    await ruff.codeActionTitles("source.fixAll");
    await ruff.codeActionTitles();
    expect(ruff.requests.map((r) => r.context.only)).toEqual([
      [CodeActionKind.SourceFixAll],
      undefined,
    ]);
  });

  test("supports the kinds a registration declares, the kinds inside them and around them", () => {
    const { codeActions } = client("ruff-lsp", {
      codeActionKinds: ["quickfix", "source.fixAll.ruff", "source.organizeImports.ruff"],
    });
    expect(codeActions.supportsKind(model, "quickfix")).toBe(true);
    expect(codeActions.supportsKind(model, "source.fixAll")).toBe(true);
    expect(codeActions.supportsKind(model, "source")).toBe(true);
    expect(codeActions.supportsKind(model, "refactor")).toBe(false);
    expect(codeActions.supportsKind(model, "source.fixAllish")).toBe(false);
  });

  test("declared kinds only: a kind equal to or inside the requested one, as Monaco gates Fix All", () => {
    const ruff = client("ruff-lsp", { codeActionKinds: ["source.fixAll.ruff", "source"] });
    expect(ruff.codeActions.supportsKind(model, "source.fixAll", { declared: true })).toBe(true);
    expect(ruff.codeActions.supportsKind(model, "source.organizeImports", { declared: true })).toBe(
      false,
    );
    const yaml = client("yaml-lsp");
    expect(yaml.codeActions.supportsKind(model, "source.fixAll")).toBe(true);
    expect(yaml.codeActions.supportsKind(model, "source.fixAll", { declared: true })).toBe(false);
  });

  test("a registration without kinds may offer any kind, and none is left once it goes", () => {
    const { codeActions, registered } = client("python-lsp");
    expect(codeActions.supportsKind(model, "refactor")).toBe(true);
    registered?.dispose();
    expect(codeActions.supportsKind(model, "quickfix")).toBe(false);
  });
});
