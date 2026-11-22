import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from "bun:test";

import type { ExcalidrawImperativeAPI, ExcalidrawProps } from "@excalidraw/excalidraw/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DockviewPanelApi } from "dockview-react";

import { localServerId } from "@/api/local-server";
import { worktreeRef } from "@/api/worktree-ref";
import { fileEditorKey, useEditorStateStore } from "@/store/editor-state";

// happy-dom has no canvas or font loading; Excalidraw only needs these calls to exist.
function noopContext(): unknown {
  return new Proxy(() => {}, {
    get: (_target, prop) => (prop === "filter" ? "none" : noopContext()),
    apply: () => noopContext(),
    set: () => true,
    has: () => true,
  });
}
HTMLCanvasElement.prototype.getContext = (() => noopContext()) as never;
Object.assign(globalThis, {
  Path2D: function Path2D() {},
  FontFace: class FontFace {
    load = async () => this;
  },
});
Object.defineProperty(document, "fonts", {
  configurable: true,
  value: Object.assign(new Set(), {
    check: () => true,
    load: async () => [],
    ready: Promise.resolve(),
  }),
});

// The real Excalidraw, wrapped to hand the test its API and count the changes it reports.
const excalidraw = await import("@excalidraw/excalidraw");
const RealExcalidraw = excalidraw.Excalidraw;
let api: ExcalidrawImperativeAPI | null = null;
let reportedChanges = 0;
function ObservedExcalidraw(props: ExcalidrawProps) {
  return (
    <RealExcalidraw
      {...props}
      excalidrawAPI={(next) => {
        api = next;
        props.excalidrawAPI?.(next);
      }}
      onChange={(...args) => {
        props.onChange?.(...args);
        reportedChanges += 1;
      }}
    />
  );
}
mock.module("@excalidraw/excalidraw", () => ({ ...excalidraw, Excalidraw: ObservedExcalidraw }));
// Vite resolves the stylesheet through the package's `development`/`production` export
// conditions, which Bun's resolver does not match; the test needs no styles.
mock.module("@excalidraw/excalidraw/index.css", () => ({}));

const { ExcalidrawEditor } = await import("./ExcalidrawEditor");
const { LayoutServerContext, PanelContext } = await import("@/components/dockview/panel-context");

const FILE = "/repo/unindexed.excalidraw";

const panelApi = {
  id: FILE,
  isActive: false,
  onDidActiveChange: () => ({ dispose() {} }),
  onDidActiveGroupChange: () => ({ dispose() {} }),
  onDidGroupChange: () => ({ dispose() {} }),
} as unknown as DockviewPanelApi;

/** A drawing as written by hand, a script, or Excalidraw before 0.17: no fractional `index`. */
function unindexedDrawing(rectangleX: number): string {
  return JSON.stringify({
    type: "excalidraw",
    version: 2,
    source: "https://excalidraw.com",
    elements: [
      {
        id: "a",
        type: "rectangle",
        version: 1,
        versionNonce: 1,
        x: rectangleX,
        y: 0,
        width: 40,
        height: 20,
      },
      { id: "b", type: "ellipse", version: 1, versionNonce: 2, x: 80, y: 0, width: 40, height: 20 },
    ],
    appState: { viewBackgroundColor: "#ffffff" },
    files: {},
  });
}

/** What an `iframe` element made by excalidraw.com's generation keeps: its HTML and more. */
const FRAME_CUSTOM_DATA = {
  generationData: { status: "done", html: "<p>Generated diagram</p>" },
  note: "kept",
};

/** A drawing with an `iframe` element that embeds HTML, and a rectangle to edit. */
function drawingWithHtml(customData: unknown = FRAME_CUSTOM_DATA): string {
  return JSON.stringify({
    type: "excalidraw",
    version: 2,
    elements: [
      {
        id: "frame",
        type: "iframe",
        version: 1,
        versionNonce: 1,
        index: "a0",
        x: 0,
        y: 0,
        width: 200,
        height: 100,
        opacity: 100,
        customData,
      },
      {
        id: "a",
        type: "rectangle",
        version: 1,
        versionNonce: 2,
        index: "a1",
        x: 300,
        y: 0,
        width: 40,
        height: 20,
      },
    ],
    files: {},
  });
}

const HTML_BANNER = /This drawing embeds HTML/;

function frameCustomData(loaded: ExcalidrawImperativeAPI | null): unknown {
  return loaded?.getSceneElements().find((el) => el.id === "frame")?.customData;
}

/** Whether Excalidraw shows the frame as not loaded rather than any HTML from the file. */
function frameHeld(loaded: ExcalidrawImperativeAPI | null): boolean {
  const data = frameCustomData(loaded);
  if (typeof data !== "object" || data === null || !("generationData" in data)) return false;
  const shown = data.generationData;
  return typeof shown === "object" && shown !== null && "code" in shown
    ? shown.code === "ERR_NOT_LOADED"
    : false;
}

/** Move the rectangle and wait for the autosave; returns what was written. */
async function editAndAutosave(loaded: ExcalidrawImperativeAPI): Promise<string> {
  act(() => {
    loaded.updateScene({
      elements: loaded
        .getSceneElements()
        .map((el) => (el.id === "a" ? { ...el, x: 310, version: el.version + 1 } : el)),
    });
  });
  await waitFor(() => expect(writes).toHaveLength(1), { timeout: 5000 });
  return writes[0]?.content ?? "";
}

let diskContent = "";
let trustDecision = "undecided";
let writes: { path: string; content: string }[] = [];
const realFetch = globalThis.fetch;

function renderEditor(filePath = FILE) {
  const client = new QueryClient();
  const worktree = worktreeRef(localServerId(), "/repo");
  const result = render(
    <QueryClientProvider client={client}>
      <LayoutServerContext.Provider value={localServerId()}>
        <PanelContext.Provider value={{ worktree }}>
          <ExcalidrawEditor filePath={filePath} panelApi={panelApi} />
        </PanelContext.Provider>
      </LayoutServerContext.Provider>
    </QueryClientProvider>,
  );
  return { ...result, client };
}

/** Wait until Excalidraw has loaded the drawing and reported the loaded scene. */
async function loadedApi(): Promise<ExcalidrawImperativeAPI> {
  await waitFor(() => expect(reportedChanges).toBeGreaterThan(0), { timeout: 5000 });
  if (!api) throw new Error("Excalidraw reported a change before handing out its API");
  return api;
}

beforeEach(() => {
  api = null;
  reportedChanges = 0;
  writes = [];
  diskContent = unindexedDrawing(0);
  trustDecision = "undecided";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/repo-trust")) {
      return Response.json({ repository: "/repo", decision: trustDecision, restrictions: [] });
    }
    if (url.includes("/file-content")) return Response.json({ content: diskContent });
    if (url.includes("/file-write")) {
      writes.push(JSON.parse(String(init?.body)));
      return Response.json({ success: true });
    }
    return Response.json({});
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  setSystemTime();
  globalThis.fetch = realFetch;
});

describe("ExcalidrawEditor", () => {
  test("opening a drawing without fractional indices schedules no save", async () => {
    const { unmount } = renderEditor();
    const loaded = await loadedApi();

    // Loading filled in the indices, which bumps every element's version.
    expect(loaded.getSceneElements().map((el) => `${el.version} ${el.index}`)).toEqual([
      "2 a0",
      "2 a1",
    ]);
    expect(
      useEditorStateStore.getState().files.get(fileEditorKey(localServerId(), FILE))?.state,
    ).toBe("clean");

    // Unmounting flushes a pending autosave, so nothing written means nothing was scheduled.
    unmount();
    expect(writes).toEqual([]);
  });

  test("an external rewrite to another unindexed drawing schedules no save", async () => {
    const { client, unmount } = renderEditor();
    await loadedApi();
    const changesAfterLoad = reportedChanges;

    diskContent = unindexedDrawing(30);
    await act(() => client.invalidateQueries());
    await waitFor(() => {
      expect(api?.getSceneElements()[0]?.x).toBe(30);
      expect(reportedChanges).toBeGreaterThan(changesAfterLoad);
    });

    expect(
      useEditorStateStore.getState().files.get(fileEditorKey(localServerId(), FILE))?.state,
    ).toBe("clean");
    unmount();
    expect(writes).toEqual([]);
  });

  test("an external write to an open empty drawing shows on the canvas", async () => {
    diskContent = JSON.stringify({ type: "excalidraw", version: 2, elements: [], files: {} });
    const { client } = renderEditor();
    await loadedApi();

    diskContent = unindexedDrawing(0);
    await act(() => client.invalidateQueries());
    await waitFor(() => expect(api?.getSceneElements()).toHaveLength(2));
    expect(
      useEditorStateStore.getState().files.get(fileEditorKey(localServerId(), FILE))?.state,
    ).toBe("clean");
  });

  test("the first real edit after opening autosaves", async () => {
    renderEditor();
    const loaded = await loadedApi();

    act(() => {
      loaded.updateScene({
        elements: loaded
          .getSceneElements()
          .map((el) => (el.id === "a" ? { ...el, x: 10, version: el.version + 1 } : el)),
      });
    });

    await waitFor(() => expect(writes).toHaveLength(1), { timeout: 5000 });
    const saved: { elements: { id: string; x: number; index: string }[] } = JSON.parse(
      writes[0]?.content ?? "",
    );
    expect(saved.elements.map((el) => [el.id, el.x, el.index])).toEqual([
      ["a", 10, "a0"],
      ["b", 80, "a1"],
    ]);
  });

  test("an untrusted drawing's embedded HTML is held back and saved unchanged", async () => {
    // Loading stamps elements with the time, which the two saves compared below must share.
    setSystemTime(new Date("2026-01-01T00:00:00Z"));
    diskContent = drawingWithHtml();
    const { unmount } = renderEditor();
    const loaded = await loadedApi();

    expect(frameHeld(loaded)).toBe(true);
    expect(await screen.findByText(HTML_BANNER)).toBeInTheDocument();

    const saved = await editAndAutosave(loaded);
    unmount();
    expect(writes).toHaveLength(1);

    // What the same drawing saves after the same edit with its HTML loaded (another path, so the
    // content cache of the first does not apply).
    api = null;
    reportedChanges = 0;
    writes = [];
    trustDecision = "trusted";
    renderEditor("/repo/trusted.excalidraw");
    const trustedApi = await loadedApi();
    expect(frameCustomData(trustedApi)).toEqual(FRAME_CUSTOM_DATA);
    expect(await editAndAutosave(trustedApi)).toBe(saved);
    expect(JSON.parse(saved).elements[0].customData).toEqual(FRAME_CUSTOM_DATA);
  });

  test("Load shows the drawing's HTML without saving", async () => {
    diskContent = drawingWithHtml();
    const { unmount } = renderEditor();
    await loadedApi();

    // Load remounts Excalidraw, which hands out a new API.
    fireEvent.click(await screen.findByRole("button", { name: "Load" }));
    await waitFor(() => expect(frameCustomData(api)).toEqual(FRAME_CUSTOM_DATA));
    expect(screen.queryByText(HTML_BANNER)).toBeNull();

    unmount();
    expect(writes).toEqual([]);
  });

  test("a trusted repository's drawing shows its HTML without a banner", async () => {
    diskContent = drawingWithHtml();
    trustDecision = "trusted";
    renderEditor();
    const loaded = await loadedApi();

    expect(frameCustomData(loaded)).toEqual(FRAME_CUSTOM_DATA);
    expect(screen.queryByText(HTML_BANNER)).toBeNull();
  });

  test("every iframe element is held back, whatever its customData holds", async () => {
    // Loxel's own held-back key in the file does not count as held back.
    const fileCustomData = { loxelHeldCustomData: null, ...FRAME_CUSTOM_DATA };
    for (const [i, customData] of [undefined, { note: "no HTML" }, fileCustomData].entries()) {
      cleanup();
      api = null;
      reportedChanges = 0;
      diskContent = drawingWithHtml(customData);
      renderEditor(`/repo/held-${i}.excalidraw`);
      expect(frameHeld(await loadedApi())).toBe(true);
    }
  });

  test("an untrusted drawing's HTML stays held back after an external change", async () => {
    diskContent = drawingWithHtml();
    const { client } = renderEditor();
    const loaded = await loadedApi();

    const changed = JSON.parse(
      drawingWithHtml({ generationData: { status: "done", html: "<p>New</p>" } }),
    );
    changed.elements[0].version = 5;
    diskContent = JSON.stringify(changed);
    await act(() => client.invalidateQueries());
    await waitFor(() => expect(loaded.getSceneElements()[0]?.version).toBe(5));
    expect(frameHeld(loaded)).toBe(true);
  });

  test("stopping trust holds the HTML back again", async () => {
    diskContent = drawingWithHtml();
    trustDecision = "trusted";
    const { client } = renderEditor();
    expect(frameHeld(await loadedApi())).toBe(false);

    trustDecision = "declined";
    await act(() => client.invalidateQueries());
    await waitFor(() => expect(frameHeld(api)).toBe(true));
  });

  test("a duplicate of a held-back element saves with its HTML", async () => {
    diskContent = drawingWithHtml();
    const { container } = renderEditor();
    const loaded = await loadedApi();

    // Excalidraw's own Duplicate (Cmd/Ctrl+D) on the selected iframe element.
    act(() => loaded.updateScene({ appState: { selectedElementIds: { frame: true } } }));
    const canvas = container.querySelector(".excalidraw");
    if (!canvas) throw new Error("Excalidraw did not render");
    fireEvent.keyDown(canvas, { key: "d", ctrlKey: true, metaKey: true });

    await waitFor(() => expect(writes).toHaveLength(1), { timeout: 5000 });
    const saved: { elements: { id: string; type: string; customData?: unknown }[] } = JSON.parse(
      writes[0]?.content ?? "",
    );
    const frames = saved.elements.filter((el) => el.type === "iframe");
    expect(frames).toHaveLength(2);
    for (const frame of frames) expect(frame.customData).toEqual(FRAME_CUSTOM_DATA);
  });
});
