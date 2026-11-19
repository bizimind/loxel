import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DockviewPanelApi } from "dockview-react";

import { localServerId } from "@/api/local-server";
import { toServerId, type WorktreeRef, worktreeRef } from "@/api/worktree-ref";

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
  getLineCount = () => this.value.split("\n").length;
  getLineMaxColumn = (line: number) => (this.value.split("\n")[line - 1] ?? "").length + 1;
  /** Applies range edits as Monaco does, last first so earlier ranges stay valid. */
  pushEditOperations = (_selections: unknown, edits: { range: FakeRange; text: string }[]) => {
    const offset = (line: number, column: number) =>
      this.value
        .split("\n")
        .slice(0, line - 1)
        .reduce((sum, text) => sum + text.length + 1, column - 1);
    const sorted = edits.toSorted(
      (a, b) =>
        offset(b.range.startLineNumber, b.range.startColumn) -
        offset(a.range.startLineNumber, a.range.startColumn),
    );
    for (const { range, text } of sorted) {
      const start = offset(range.startLineNumber, range.startColumn);
      const end = offset(range.endLineNumber, range.endColumn);
      this.value = this.value.slice(0, start) + text + this.value.slice(end);
    }
    return null;
  };
}

interface FakeRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
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
/** The URI parts of each model at its creation. */
let createdUris: unknown[] = [];
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
    createModel: (content: string, _language: string, uri: unknown) => {
      createdWith.push(content);
      createdUris.push(uri);
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
  caretOptionsFor: () => ({}),
  trackCaretRow: () => ({ dispose() {} }),
}));

const { CodeEditorPanel } = await import("./CodeEditorPanel");
const { LayoutServerContext, PanelContext } = await import("@/components/dockview/panel-context");
const { outboxEntriesForTests, resetSaveOutboxForTests } = await import("@/lib/save-outbox");
const { fileEditorKey, useEditorStateStore } = await import("@/store/editor-state");

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
let writeResponse: () => Response;
const realFetch = globalThis.fetch;

function renderPanel(worktree: WorktreeRef | null = null) {
  // No delay before the hook's one retry, so a failure settles at once.
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <LayoutServerContext.Provider value={localServerId()}>
        <PanelContext.Provider value={{ worktree }}>
          <CodeEditorPanel filePath={FILE} onClose={() => {}} panelApi={panelApi} />
        </PanelContext.Provider>
      </LayoutServerContext.Provider>
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
  createdUris = [];
  saveAction = null;
  writes = [];
  fileResponse = () => Response.json({ content: "REAL" });
  writeResponse = () => Response.json({ success: true });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/file-content")) return fileResponse();
    if (url.includes("/file-write")) {
      writes.push(JSON.parse(String(init?.body)));
      return writeResponse();
    }
    if (url.includes("/editorconfig")) return Response.json({ properties: {} });
    return Response.json({});
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  resetSaveOutboxForTests();
  globalThis.fetch = realFetch;
  onlineManager.setOnline(true);
});

describe("CodeEditorPanel model URI", () => {
  test("names the server of the panel's worktree, or the window's in Home", async () => {
    renderPanel(worktreeRef(toServerId("other-server"), "/repo"));
    await waitFor(() => expect(createdWith).toEqual(["REAL"]));
    cleanup();
    renderPanel();
    await waitFor(() => expect(createdWith).toEqual(["REAL", "REAL"]));

    expect(createdUris).toEqual([
      { scheme: "loxel", authority: "other-server", path: FILE },
      { scheme: "loxel", authority: localServerId(), path: FILE },
    ]);
  });
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

describe("CodeEditorPanel refused save", () => {
  test("keeps the edit across the editor unmounting and mounting again, unsaved", async () => {
    writeResponse = () =>
      Response.json({ error: "EACCES: permission denied, open '/repo/real.ts'" }, { status: 500 });
    const { unmount } = renderPanel();
    await waitFor(() => expect(mountedEditor().options.readOnly).toBe(false));
    act(() => mountedEditor().userEdit("REAL edited"));
    await act(async () => {
      await saveAction?.();
    });
    await screen.findByText(/could not be saved: EACCES: permission denied/);

    // A worktree switch unmounts the editor, and switching back mounts it again.
    unmount();
    renderPanel();

    await waitFor(() => expect(mountedEditor().model.getValue()).toBe("REAL edited"));
    await screen.findByText(/could not be saved: EACCES: permission denied/);
    const key = fileEditorKey(localServerId(), FILE);
    expect(useEditorStateStore.getState().files.get(key)?.state).toBe("dirty");

    // Once the file can be written, Try again saves the edit and the banner goes.
    writeResponse = () => Response.json({ success: true });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(writes.at(-1)).toMatchObject({ content: "REAL edited" }));
    await waitFor(() => expect(screen.queryByText(/could not be saved/)).toBeNull());
  });

  test.each([
    ["REAL", "a file"],
    ["", "an empty file"],
  ])("Discard changes loads the disk version %p of %s and gives the edit up", async (onDisk) => {
    fileResponse = () => Response.json({ content: onDisk });
    writeResponse = () => Response.json({ error: "EACCES: permission denied" }, { status: 500 });
    renderPanel();
    await waitFor(() => expect(mountedEditor().options.readOnly).toBe(false));
    act(() => mountedEditor().userEdit("REAL edited"));
    await act(async () => {
      await saveAction?.();
    });
    const writesBefore = writes.length;

    fireEvent.click(await screen.findByRole("button", { name: "Discard changes" }));

    await waitFor(() => expect(mountedEditor().model.getValue()).toBe(onDisk));
    await waitFor(() => expect(screen.queryByText(/could not be saved/)).toBeNull());
    const key = fileEditorKey(localServerId(), FILE);
    expect(useEditorStateStore.getState().files.get(key)?.state).toBe("clean");
    expect(outboxEntriesForTests()).toEqual([]);
    expect(writes.length).toBe(writesBefore);
  });

  test("a refused save's file deleted on disk shows only the deleted-file banner", async () => {
    writeResponse = () => Response.json({ error: "EACCES: permission denied" }, { status: 500 });
    renderPanel();
    await waitFor(() => expect(mountedEditor().options.readOnly).toBe(false));
    act(() => mountedEditor().userEdit("REAL edited"));
    await act(async () => {
      await saveAction?.();
    });
    await screen.findByText(/could not be saved/);

    act(() =>
      useEditorStateStore.getState().setDeleted(fileEditorKey(localServerId(), FILE), true),
    );

    await screen.findByRole("button", { name: "Re-create file" });
    expect(screen.queryByText(/could not be saved/)).toBeNull();
    expect(screen.getAllByRole("button", { name: "Discard changes" })).toHaveLength(1);
  });
});
