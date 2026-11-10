import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DockviewPanelApi } from "dockview-react";

/** The parts of a Monaco model and editor the panel uses; edits go through `userEdit`. */
class FakeModel {
  constructor(public value: string) {}
  getValue = () => this.value;
  setValue = (next: string) => {
    this.value = next;
  };
  getEOL = () => "\n";
  getLanguageId = () => "typescript";
  updateOptions = () => {};
  getOptions = () => ({ tabSize: 2, indentSize: 2 });
  dispose = () => {};
  onDidChangeContent = () => ({ dispose() {} });
}

class FakeEditor {
  listeners: ((e: { eol: string }) => void)[] = [];
  constructor(
    public options: { model: FakeModel; readOnly: boolean },
    public model = options.model,
  ) {}
  /** An edit reaching the model whatever `readOnly` says, as a language server's can. */
  userEdit(text: string) {
    this.model.setValue(text);
    for (const listener of this.listeners) listener({ eol: "\n" });
  }
  getModel = () => this.model;
  getOption = () => this.options.readOnly;
  updateOptions = (next: { readOnly?: boolean }) => {
    if (next.readOnly !== undefined) this.options.readOnly = next.readOnly;
  };
  onDidChangeModelContent = (listener: (e: { eol: string }) => void) => {
    this.listeners.push(listener);
  };
  onDidChangeCursorPosition = () => ({ dispose() {} });
  onDidDispose = () => {};
  addAction = () => ({ dispose() {} });
  focus = () => {
    focusCalls += 1;
  };
  dispose = () => {};
}

let editor: FakeEditor | null = null;
let focusCalls = 0;
/** The content of each model at its creation, which is what `didOpen` sends. */
let createdWith: string[] = [];
mock.module("monaco-editor", () => ({
  Uri: { from: (parts: { path: string }) => parts },
  KeyMod: { CtrlCmd: 0, Shift: 0 },
  KeyCode: { KeyI: 0 },
  MarkerSeverity: {},
  editor: {
    EditorOption: {},
    getModel: () => null,
    // Opening an editor looks for the schemas its open files need.
    getModels: () => [],
    createModel: (content: string) => {
      createdWith.push(content);
      return new FakeModel(content);
    },
    create: (_container: unknown, options: { model: FakeModel; readOnly: boolean }) => {
      editor = new FakeEditor(options);
      return editor;
    },
    setTheme: () => {},
    setModelMarkers: () => {},
    setModelLanguage: () => {},
  },
}));
mock.module("monaco-editor/esm/vs/editor/common/languages.js", () => ({}));
mock.module("monaco-editor/esm/vs/editor/common/encodedTokenAttributes.js", () => ({}));
let saveAction: (() => void) | null = null;
mock.module("@/lib/monaco-save-action", () => ({
  addSaveAction: (_editor: unknown, save: () => void) => {
    saveAction = save;
  },
}));
mock.module("@/lib/monaco-theme", () => ({
  getMonacoThemeName: () => "loxel-dark",
  toMonacoLanguage: () => "typescript",
}));
mock.module("@/lib/lsp-clients", () => ({ fileSchemeLanguages: new Set<string>() }));
mock.module("@/lib/editorconfig-save-actions", () => ({ applyEditorConfigOnSave: () => {} }));
mock.module("@/lib/textmate-inspector", () => ({ inspectTokenAtPosition: async () => null }));
mock.module("@/components/code-editor/TextMateScopeInspector", () => ({
  TextMateScopeInspector: () => {},
}));
mock.module("@/components/code-editor/caret-row", () => ({
  trackCaretRow: () => ({ dispose() {} }),
}));

const { CodeEditorPanel } = await import("./CodeEditorPanel");

const FILE = "/repo/real.ts";

const panelApi = {
  id: FILE,
  isActive: true,
  isGroupActive: true,
  onDidActiveChange: () => ({ dispose() {} }),
  onDidActiveGroupChange: () => ({ dispose() {} }),
  onDidGroupChange: () => ({ dispose() {} }),
} as unknown as DockviewPanelApi;

let fileResponse: () => Response | Promise<Response>;
let writes: { path: string; content: string }[] = [];
const realFetch = globalThis.fetch;

function renderPanel() {
  // No delay before the hook's one retry, so a failure settles at once.
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <CodeEditorPanel filePath={FILE} onClose={() => {}} panelApi={panelApi} />
    </QueryClientProvider>,
  );
}

function mountedEditor(): FakeEditor {
  if (!editor) throw new Error("the panel has not created an editor");
  return editor;
}

beforeEach(() => {
  editor = null;
  focusCalls = 0;
  createdWith = [];
  saveAction = null;
  writes = [];
  fileResponse = () => Response.json({ content: "REAL" });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/file-content")) return fileResponse();
    if (url.includes("/file-write")) {
      writes.push(JSON.parse(String(init?.body)));
      return Response.json({ success: true });
    }
    if (url.includes("/editorconfig")) return Response.json({ properties: {} });
    return Response.json({});
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  onlineManager.setOnline(true);
});

describe("CodeEditorPanel content load", () => {
  test("the model waits for the file's content, then the editor takes focus", async () => {
    const { promise: response, resolve: respond } = Promise.withResolvers<Response>();
    let requested = false;
    fileResponse = () => {
      requested = true;
      return response;
    };
    renderPanel();

    await waitFor(() => expect(requested).toBe(true));
    expect(createdWith).toEqual([]);
    expect(editor).toBeNull();

    respond(Response.json({ content: "REAL" }));
    await waitFor(() => expect(createdWith).toEqual(["REAL"]));
    expect(focusCalls).toBe(1);
  });

  test("a failed load shows Retry and cannot be edited or saved over the file", async () => {
    fileResponse = () => new Response("boom", { status: 500 });
    const { unmount } = renderPanel();

    await screen.findByRole("button", { name: "Retry" });
    expect(mountedEditor().options.readOnly).toBe(true);

    // Cmd+S, then an edit that would flush on unmount. Both would reach the write synchronously;
    // the Retry test below shows the same flush writing once the file has loaded.
    await saveAction?.();
    act(() => mountedEditor().userEdit("oops"));
    unmount();
    expect(writes).toEqual([]);
  });

  test("Retry loads the file and makes the editor editable and savable", async () => {
    fileResponse = () => new Response("boom", { status: 500 });
    const { unmount } = renderPanel();
    const retry = await screen.findByRole("button", { name: "Retry" });

    fileResponse = () => Response.json({ content: "REAL" });
    fireEvent.click(retry);

    await waitFor(() => expect(mountedEditor().model.getValue()).toBe("REAL"));
    await waitFor(() => expect(mountedEditor().options.readOnly).toBe(false));
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();

    act(() => mountedEditor().userEdit("REAL edited"));
    unmount();
    await waitFor(() =>
      expect(writes).toEqual([expect.objectContaining({ path: FILE, content: "REAL edited" })]),
    );
  });

  test("an edit that reaches a failed load's model is replaced by the retried content", async () => {
    fileResponse = () => new Response("boom", { status: 500 });
    const { unmount } = renderPanel();
    const retry = await screen.findByRole("button", { name: "Retry" });
    act(() => mountedEditor().userEdit("oops"));

    fileResponse = () => Response.json({ content: "REAL" });
    fireEvent.click(retry);

    await waitFor(() => expect(mountedEditor().model.getValue()).toBe("REAL"));
    unmount();
    expect(writes).toEqual([]);
  });

  test("a confirmed-missing file is an editable empty buffer without Retry", async () => {
    fileResponse = () => Response.json({ error: "missing", code: "ENOENT" }, { status: 404 });
    renderPanel();

    await screen.findByRole("button", { name: "Re-create file" });
    await waitFor(() => expect(mountedEditor().options.readOnly).toBe(false));
    expect(mountedEditor().model.getValue()).toBe("");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  test("the browser reporting offline does not stop the load from the local server", async () => {
    onlineManager.setOnline(false);
    renderPanel();
    await waitFor(() => expect(mountedEditor().model.getValue()).toBe("REAL"));
    await waitFor(() => expect(mountedEditor().options.readOnly).toBe(false));
  });
});
