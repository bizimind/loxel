import { afterEach, beforeEach, describe, expect, jest, mock, spyOn, test } from "bun:test";

import type * as monaco from "monaco-editor";

import { fakeMonaco, fakeMonacoModule } from "../../testing/fake-monaco";
import type { Diagnostic, DocumentDiagnosticReport, PublishDiagnosticsParams } from "../../types";
import { LSPErrorCodes } from "../../types";
import { ServerCancellationError } from "../LspCancellableRequests";
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

describe("pull diagnostics", () => {
  const PULL_DELAY_MS = 500;
  let errors: ReturnType<typeof spyOn<Console, "error">>;

  beforeEach(() => {
    fakeMonaco.reset();
    jest.useFakeTimers();
    errors = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errors.mockRestore();
    jest.useRealTimers();
  });

  /** A synced model with pull diagnostics registered, whose server answers from `answers`. */
  function pull(answers: (() => Promise<DocumentDiagnosticReport>)[]) {
    const model = {
      uri: { toString: () => URI },
      getLanguageId: () => "rust",
      isDisposed: () => false,
      onDidChangeContent: () => ({ dispose: () => {} }),
      onWillDispose: () => ({ dispose: () => {} }),
    } as unknown as monaco.editor.ITextModel;
    fakeMonaco.models.push(model);
    const noop = { dispose: () => {} };
    let register: ((options: unknown) => monaco.IDisposable) | undefined;
    const requests: unknown[] = [];
    const answered: Promise<unknown>[] = [];
    const connection = {
      capabilities: {
        addStaticClientCapabilities: () => noop,
        registerCapabilityHandler: (_c: unknown, _s: boolean, handler: typeof register) => {
          register = handler;
          return noop;
        },
      },
      connection: { registerNotificationHandler: () => noop, registerRequestHandler: () => noop },
      bridge: {
        isSyncedModel: () => true,
        translate: () => ({ textDocument: { uri: URI } }),
        translateBack: () => ({ textModel: model }),
      },
      server: {
        textDocumentDiagnostic: (params: unknown) => {
          requests.push(params);
          const answer = answers.shift();
          if (!answer) throw new Error("no more answers");
          const promise = answer();
          answered.push(promise);
          return promise;
        },
      },
    } as unknown as LspConnection;
    const feature = new LspDiagnosticsFeature(connection, "rust-lsp");
    register?.({
      documentSelector: null,
      interFileDependencies: true,
      workspaceDiagnostics: false,
    });

    /**
     * Fires the scheduled pull and waits until the provider has handled its answer: the provider
     * awaited the answer first, so it has run by the time a later reaction to it does.
     */
    async function pullNow(): Promise<void> {
      jest.advanceTimersByTime(PULL_DELAY_MS);
      await answered.at(-1)?.then(
        () => {},
        () => {},
      );
    }
    return { feature, requests, pullNow };
  }

  const cancelled = (data?: unknown) => () =>
    Promise.reject(
      new ServerCancellationError(LSPErrorCodes.ServerCancelled, "server cancelled", data),
    );
  const report =
    (message: string): (() => Promise<DocumentDiagnosticReport>) =>
    async () => ({
      kind: "full",
      items: [
        { message, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
      ],
    });

  test("asks again when the server cancels with retriggerRequest, without logging an error", async () => {
    const { feature, requests, pullNow } = pull([
      cancelled({ retriggerRequest: true }),
      report("late"),
    ]);

    await pullNow();
    expect(requests).toHaveLength(1);
    expect(jest.getTimerCount()).toBe(1);

    await pullNow();
    expect(requests).toHaveLength(2);
    expect(messagesByOwner()).toEqual([["late"]]);
    expect(errors).not.toHaveBeenCalled();
    feature.dispose();
  });

  test("does not ask again when the server says retriggering is pointless", async () => {
    const { feature, requests, pullNow } = pull([cancelled({ retriggerRequest: false })]);

    await pullNow();
    expect(jest.getTimerCount()).toBe(0);
    expect(requests).toHaveLength(1);
    expect(errors).not.toHaveBeenCalled();
    feature.dispose();
  });

  test("logs a request that failed, and does not ask again", async () => {
    const { feature, pullNow } = pull([() => Promise.reject(new Error("internal error"))]);

    await pullNow();
    expect(jest.getTimerCount()).toBe(0);
    expect(errors).toHaveBeenCalledTimes(1);
    feature.dispose();
  });
});
