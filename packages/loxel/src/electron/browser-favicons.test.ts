import { describe, expect, mock, test } from "bun:test";

import type { BrowserWindow, IpcMainInvokeEvent, Session, WebContents } from "electron";

import { registerAppWindow } from "./app-windows";
import { BROWSER_FAVICON_LOAD } from "./ipc-channels";

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<string | null>;
const ipcHandlers = new Map<string, Handler>();
const windows = new Map<WebContents, BrowserWindow>();
const guests = new Map<number, WebContents>();
void mock.module("electron", () => ({
  ipcMain: { handle: (channel: string, handler: Handler) => ipcHandlers.set(channel, handler) },
  BrowserWindow: { fromWebContents: (contents: WebContents) => windows.get(contents) ?? null },
  webContents: { fromId: (id: number) => guests.get(id) },
}));

const { imageDataUrl, installBrowserFavicons, MAX_FAVICON_BYTES } =
  await import("./browser-favicons");

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const ICO = Uint8Array.from([0x00, 0x00, 0x01, 0x00, 1, 2]);
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

describe("imageDataUrl", () => {
  test("types the bytes by their image content type", () => {
    expect(imageDataUrl("image/svg+xml; charset=utf-8", PNG)).toBe(
      `data:image/svg+xml;base64,${base64(PNG)}`,
    );
  });

  test("recognizes untyped bitmaps by their first bytes", () => {
    expect(imageDataUrl("application/octet-stream", ICO)).toBe(
      `data:image/x-icon;base64,${base64(ICO)}`,
    );
    expect(imageDataUrl(null, PNG)).toBe(`data:image/png;base64,${base64(PNG)}`);
  });

  test("refuses what is no image, nothing, or too much", () => {
    expect(imageDataUrl("text/html", new TextEncoder().encode("<html>Sign in</html>"))).toBeNull();
    expect(imageDataUrl("image/png", new Uint8Array())).toBeNull();
    expect(imageDataUrl("image/png", new Uint8Array(MAX_FAVICON_BYTES + 1))).toBeNull();
  });
});

/** One of Loxel's windows, or (`app: false`) a window that isn't, such as a page's popup. */
function fakeWindow({ app = true } = {}): WebContents {
  const contents = { getType: () => "window" } as unknown as WebContents;
  const win = { webContents: contents, on: () => win } as unknown as BrowserWindow;
  windows.set(contents, win);
  if (app) registerAppWindow(win);
  return contents;
}

let nextGuestId = 1;
function fakeGuest(host: WebContents, url: string, pageResult: unknown) {
  const id = nextGuestId++;
  const executeJavaScriptInIsolatedWorld = mock(async () => pageResult);
  guests.set(id, {
    getType: () => "webview",
    hostWebContents: host,
    getURL: () => url,
    executeJavaScriptInIsolatedWorld,
  } as unknown as WebContents);
  return { id, executeJavaScriptInIsolatedWorld };
}

const fetchFavicon = mock(
  async (_url: string, _init?: RequestInit): Promise<Response> =>
    new Response(PNG, { headers: { "content-type": "image/png" } }),
);
installBrowserFavicons({ fetch: fetchFavicon } as unknown as Session);
const load = (sender: WebContents, url: unknown, pageUrl?: unknown, webContentsId?: unknown) =>
  ipcHandlers.get(BROWSER_FAVICON_LOAD)!(
    { sender } as IpcMainInvokeEvent,
    url,
    pageUrl,
    webContentsId,
  );

describe("loading a favicon", () => {
  test("loads a favicon of the page's own origin with its cookies, and never along a redirect", async () => {
    const result = await load(
      fakeWindow(),
      "https://example.com/favicon.png",
      "https://example.com/a",
    );
    expect(result).toBe(`data:image/png;base64,${base64(PNG)}`);
    expect(fetchFavicon.mock.lastCall?.[1]).toMatchObject({
      credentials: "include",
      redirect: "error",
    });
  });

  test("loads another site's favicon without cookies", async () => {
    await load(fakeWindow(), "https://victim.example/logout", "https://evil.example/");
    expect(fetchFavicon.mock.lastCall?.[1]).toMatchObject({
      credentials: "omit",
      redirect: "follow",
    });
    await load(fakeWindow(), "https://example.com/favicon.png");
    expect(fetchFavicon.mock.lastCall?.[1]).toMatchObject({ credentials: "omit" });
  });

  test("loads a favicon that redirects again, without cookies", async () => {
    fetchFavicon.mockClear();
    fetchFavicon.mockRejectedValueOnce(new TypeError("fetch failed: redirect"));
    const result = await load(
      fakeWindow(),
      "https://example.com/favicon.ico",
      "https://example.com/",
    );
    expect(result).toBe(`data:image/png;base64,${base64(PNG)}`);
    expect(fetchFavicon.mock.calls.map(([, init]) => init?.credentials)).toEqual([
      "include",
      "omit",
    ]);
  });

  test("answers only Loxel's own windows", async () => {
    fetchFavicon.mockClear();
    expect(await load(fakeWindow({ app: false }), "https://example.com/favicon.png")).toBeNull();
    expect(fetchFavicon).not.toHaveBeenCalled();
  });

  test("gives nothing for a page served in place of the favicon, or a failed load", async () => {
    const window = fakeWindow();
    fetchFavicon.mockResolvedValueOnce(
      new Response("<html>Sign in</html>", { headers: { "content-type": "text/html" } }),
    );
    expect(await load(window, "https://example.com/private.ico")).toBeNull();
    fetchFavicon.mockResolvedValueOnce(new Response(PNG, { status: 404 }));
    expect(await load(window, "https://example.com/gone.ico")).toBeNull();
    fetchFavicon.mockRejectedValueOnce(new Error("net::ERR_NAME_NOT_RESOLVED"));
    expect(await load(window, "https://nope.example/favicon.ico")).toBeNull();
  });

  test("stops reading a favicon past the size limit", async () => {
    fetchFavicon.mockResolvedValueOnce(
      new Response(new Uint8Array(MAX_FAVICON_BYTES + 1), {
        headers: { "content-type": "image/png" },
      }),
    );
    expect(await load(fakeWindow(), "https://example.com/huge.png")).toBeNull();
  });

  test("loads no other scheme", async () => {
    expect(await load(fakeWindow(), "file:///etc/passwd")).toBeNull();
    expect(await load(fakeWindow(), 42)).toBeNull();
  });
});

describe("a blob: favicon", () => {
  const svg = new TextEncoder().encode("<svg/>");
  const pageResult = `data:image/svg+xml;base64,${base64(svg)}`;

  test("is read in the page of one of the window's webviews, apart from the page's scripts", async () => {
    const window = fakeWindow();
    const guest = fakeGuest(window, "https://example.com/app", pageResult);
    expect(await load(window, "blob:https://example.com/1", undefined, guest.id)).toBe(pageResult);
    expect(guest.executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(1);
  });

  test("is not read in another window's webview, or for another site", async () => {
    const window = fakeWindow();
    const other = fakeGuest(fakeWindow(), "https://example.com/app", pageResult);
    expect(await load(window, "blob:https://example.com/1", undefined, other.id)).toBeNull();
    expect(other.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();

    const own = fakeGuest(window, "https://example.com/app", pageResult);
    expect(await load(window, "blob:https://evil.example/1", undefined, own.id)).toBeNull();
    expect(own.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
  });

  test("must read as an image", async () => {
    const window = fakeWindow();
    const guest = fakeGuest(window, "https://example.com/app", "data:text/html;base64,PGh0bWw+");
    expect(await load(window, "blob:https://example.com/1", undefined, guest.id)).toBeNull();
  });
});
