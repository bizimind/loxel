import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { ExcalidrawImperativeAPI, ExcalidrawProps } from "@excalidraw/excalidraw/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { DockviewPanelApi } from "dockview-react";

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

// The real Excalidraw, wrapped to hand the test its API and count the changes it reports.
const excalidraw = await import("@excalidraw/excalidraw");
const RealExcalidraw = excalidraw.Excalidraw;
let api: ExcalidrawImperativeAPI | null = null;
let reportedChanges = 0;
let validateEmbeddable: ExcalidrawProps["validateEmbeddable"];
function ObservedExcalidraw(props: ExcalidrawProps) {
  return (
    <RealExcalidraw
      {...props}
      excalidrawAPI={(next) => {
        api = next;
        validateEmbeddable = props.validateEmbeddable;
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
});

/** A drawing with one embed, `e`, of `link`. */
function embedDrawing(link: string, version = 1): string {
  return JSON.stringify({
    type: "excalidraw",
    version: 2,
    elements: [
      { id: "e", type: "embeddable", version, versionNonce: version, index: "a0", x: 0, y: 0 },
    ].map((el) => ({ ...el, width: 400, height: 300, link })),
    files: {},
  });
}

const TWEET = "https://x.com/someone/status/123";
const REDDIT_POST = "https://www.reddit.com/r/sub/comments/abc/title/";
const YOUTUBE = "https://www.youtube.com/watch?v=abc";

/** The frames Excalidraw rendered for embeds, as `[src, srcdoc, sandbox]`. */
function embedFrames(): (string | null)[][] {
  return [...document.querySelectorAll("iframe.excalidraw__embeddable")].map((frame) => [
    frame.getAttribute("src"),
    frame.getAttribute("srcdoc"),
    frame.getAttribute("sandbox"),
  ]);
}

describe("ExcalidrawEditor embeds", () => {
  test("refuses X/Twitter and Reddit post links and leaves the rest to Excalidraw", async () => {
    renderEditor();
    await loadedApi();
    const validate = validateEmbeddable;
    if (typeof validate !== "function") throw new Error("Excalidraw got no embed validator");

    expect(validate("https://twitter.com/someone/status/123")).toBe(false);
    expect(validate(TWEET)).toBe(false);
    expect(validate(REDDIT_POST)).toBe(false);
    // `undefined` hands the link to Excalidraw's own allowlist, which accepts YouTube.
    expect(validate(YOUTUBE)).toBeUndefined();
  });

  test("an X/Twitter or Reddit post in a drawing gets no frame", async () => {
    for (const link of [TWEET, REDDIT_POST]) {
      diskContent = embedDrawing(link);
      renderEditor();
      await loadedApi();
      expect(embedFrames()).toEqual([]);
      cleanup();
    }
  });

  test("a YouTube embed keeps its frame", async () => {
    diskContent = embedDrawing(YOUTUBE);
    renderEditor();
    await loadedApi();
    await waitFor(() => expect(embedFrames()).toHaveLength(1));
    expect(embedFrames()[0]?.[0]).toStartWith("https://www.youtube.com/embed/abc");
  });

  test("an embed rewritten on disk to a post shows its link, not a frame", async () => {
    diskContent = embedDrawing(YOUTUBE);
    const { client } = renderEditor();
    await loadedApi();
    await waitFor(() => expect(embedFrames()).toHaveLength(1));

    diskContent = embedDrawing(TWEET, 2);
    await act(() => client.invalidateQueries());
    await waitFor(() => expect(api?.getSceneElements()[0]?.link).toBe(TWEET));
    await waitFor(() => expect(screen.getByText(TWEET)).toBeInTheDocument());
    expect(embedFrames()).toEqual([]);
  });
});
