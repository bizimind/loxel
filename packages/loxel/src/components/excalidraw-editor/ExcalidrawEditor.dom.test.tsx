import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { ExcalidrawImperativeAPI, ExcalidrawProps } from "@excalidraw/excalidraw/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { DockviewPanelApi } from "dockview-react";
import { useEffect } from "react";

import { localServerId } from "@/api/local-server";
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

/** Point the page at `url`, through the controls happy-dom's DOM preload puts on `window`. */
function setPageUrl(url: string): void {
  const happyDOM: unknown = Reflect.get(window, "happyDOM");
  if (typeof happyDOM !== "object" || happyDOM === null || !("setURL" in happyDOM)) {
    throw new Error("happy-dom is not registered");
  }
  const { setURL } = happyDOM;
  if (typeof setURL !== "function") throw new Error("happy-dom has no setURL");
  setURL.call(happyDOM, url);
}

// The real Excalidraw, wrapped to hand the test its API and count the changes it reports.
const excalidraw = await import("@excalidraw/excalidraw");
const RealExcalidraw = excalidraw.Excalidraw;
let api: ExcalidrawImperativeAPI | null = null;
let reportedChanges = 0;
let onLinkOpen: ExcalidrawProps["onLinkOpen"];
function ObservedExcalidraw(props: ExcalidrawProps) {
  useEffect(() => {
    onLinkOpen = props.onLinkOpen;
  });
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
const { LayoutServerContext } = await import("@/components/dockview/panel-context");

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

let diskContent = "";
let writes: { path: string; content: string }[] = [];
const realFetch = globalThis.fetch;

function renderEditor() {
  const client = new QueryClient();
  const result = render(
    <QueryClientProvider client={client}>
      <LayoutServerContext.Provider value={localServerId()}>
        <ExcalidrawEditor filePath={FILE} panelApi={panelApi} />
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
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
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

  describe("a link on an element", () => {
    /** Click the link on rectangle `a` as Excalidraw reports it; returns the event it hands over. */
    async function openLink(link: string): Promise<CustomEvent> {
      const loaded = await loadedApi();
      const element = loaded.getSceneElements().find((el) => el.id === "a");
      if (!element || !onLinkOpen) throw new Error("the drawing has no rectangle or link handler");
      const event = new CustomEvent("excalidraw-link", {
        cancelable: true,
        detail: { nativeEvent: new MouseEvent("click") },
      });
      onLinkOpen({ ...element, link }, event);
      return event;
    }

    const realOpen = window.open;
    let realUrl = "";
    let opened: unknown[] = [];
    beforeEach(() => {
      // The app's page, which happy-dom's `about:blank` stands in for, has a web origin.
      realUrl = location.href;
      setPageUrl("http://localhost:7433/");
      opened = [];
      window.open = (url) => {
        opened.push(url);
        return null;
      };
    });
    afterEach(() => {
      setPageUrl(realUrl);
      window.open = realOpen;
    });

    test("opens a web link the way the app's other links open", async () => {
      renderEditor();
      const event = await openLink("https://example.com/docs");

      expect(event.defaultPrevented).toBe(true);
      expect(opened).toEqual(["https://example.com/docs"]);
    });

    /** Render the editor and record what its link handler scrolls to. */
    async function recordScrolls(): Promise<unknown[]> {
      renderEditor();
      const loaded = await loadedApi();
      const scrolledTo: unknown[] = [];
      loaded.scrollToContent = (target) => {
        scrolledTo.push(target);
      };
      return scrolledTo;
    }

    test("scrolls to the element a link to this drawing names", async () => {
      const scrolledTo = await recordScrolls();
      const event = await openLink("http://localhost:7433/?element=b");

      expect(event.defaultPrevented).toBe(true);
      expect(scrolledTo).toEqual(["http://localhost:7433/?element=b"]);
      expect(opened).toEqual([]);
    });

    test("scrolls to the element a relative link names", async () => {
      const scrolledTo = await recordScrolls();
      await openLink("?element=b");

      expect(scrolledTo).toEqual(["http://localhost:7433/?element=b"]);
      expect(opened).toEqual([]);
    });

    test("hands a link to another page of the app's origin to the window, not the canvas", async () => {
      const scrolledTo = await recordScrolls();
      await openLink("/docs");

      expect(scrolledTo).toEqual([]);
      expect(opened).toEqual(["/docs"]);
    });
  });
});
