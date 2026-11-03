import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DockviewPanelApi } from "dockview-react";

const created: string[] = [];
const disposedModels: string[] = [];
const editorOptions: { readOnly?: boolean }[] = [];
let focusCalls = 0;

mock.module("monaco-editor", () => ({
  Uri: { parse: (uri: string) => ({ uri }) },
  CancellationTokenSource: class {
    token = { isCancellationRequested: false };
    cancel() {
      this.token.isCancellationRequested = true;
    }
    dispose() {}
  },
  editor: {
    getModel: () => null,
    createModel: (text: string) => {
      created.push(text);
      return { updateOptions() {}, dispose: () => disposedModels.push(text) };
    },
    create: (_container: unknown, options: { readOnly?: boolean }) => {
      editorOptions.push(options);
      return {
        dispose() {},
        focus: () => {
          focusCalls += 1;
        },
        revealLineInCenter() {},
        setPosition() {},
        updateOptions() {},
      };
    },
    setTheme() {},
  },
}));
const toasts: string[] = [];
mock.module("@/components/ui/toast", () => ({
  showToast: (message: string) => toasts.push(message),
}));
mock.module("@/lib/monaco-theme", () => ({ getMonacoThemeName: () => "loxel-dark" }));

const { VirtualDocumentPanel } = await import("./VirtualDocumentPanel");
const { registerVirtualDocumentScheme, virtualDocumentConnection } =
  await import("@/lib/virtual-documents");

const URI = "panel-doc://contents/java.util/List.java?%3Dp";
const scheme = registerVirtualDocumentScheme(
  { scheme: "panel-doc", read: (client, uri, token) => client.request(uri, {}, token) as never },
  "java",
);

const close = mock();
const panelApi = {
  id: "panel",
  isActive: true,
  isGroupActive: true,
  close,
  updateParameters() {},
  onDidActiveChange: () => ({ dispose() {} }),
  onDidActiveGroupChange: () => ({ dispose() {} }),
  onDidGroupChange: () => ({ dispose() {} }),
} as unknown as DockviewPanelApi;

function panel(connectionId: string) {
  return <VirtualDocumentPanel uri={URI} connectionId={connectionId} panelApi={panelApi} />;
}

function connect(request: () => Promise<unknown>): { id: string; end: () => void } {
  const end = scheme.connected({ request });
  return { id: virtualDocumentConnection(URI)?.id ?? "", end };
}

let endConnection: () => void = () => {};

beforeEach(() => {
  created.length = 0;
  disposedModels.length = 0;
  editorOptions.length = 0;
  toasts.length = 0;
  focusCalls = 0;
  close.mockClear();
});

afterEach(() => {
  cleanup();
  endConnection();
  endConnection = () => {};
});

describe("VirtualDocumentPanel", () => {
  test("shows the server's text read-only, focused, and disposes it with the tab", async () => {
    const { id, end } = connect(async () => "class List {}");
    endConnection = end;
    const { unmount } = render(panel(id));

    await waitFor(() => expect(created).toEqual(["class List {}"]));
    expect(editorOptions[0]?.readOnly).toBe(true);
    expect(focusCalls).toBeGreaterThan(0);

    unmount();
    expect(disposedModels).toEqual(["class List {}"]);
  });

  test("a tab restored from another connection closes once, saying why", async () => {
    const { end } = connect(async () => "class List {}");
    endConnection = end;
    render(panel("an-earlier-connection"));
    render(panel("an-earlier-connection"));

    await waitFor(() => expect(close).toHaveBeenCalledTimes(2));
    expect(toasts).toHaveLength(1);
    expect(created).toEqual([]);
  });

  test("closes when its connection ends, without a notice", async () => {
    const { id, end } = connect(async () => "class List {}");
    render(panel(id));
    await waitFor(() => expect(created).toHaveLength(1));

    act(() => end());

    expect(close).toHaveBeenCalledTimes(1);
    expect(toasts).toEqual([]);
  });

  test("a read that finishes after the tab closed creates nothing", async () => {
    let answer: (text: string) => void = () => {};
    const { id, end } = connect(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    endConnection = end;
    const { unmount } = render(panel(id));

    unmount();
    answer("class List {}");
    await act(async () => {
      await Promise.resolve();
    });

    expect(created).toEqual([]);
  });

  test("a failed read offers a retry", async () => {
    let fail = true;
    const { id, end } = connect(async () => {
      if (fail) throw new Error("no such class");
      return "class List {}";
    });
    endConnection = end;
    render(panel(id));

    const retry = await screen.findByRole("button", { name: "Retry" });
    fail = false;
    fireEvent.click(retry);

    await waitFor(() => expect(created).toEqual(["class List {}"]));
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});
