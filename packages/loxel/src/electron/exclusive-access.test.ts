import { describe, expect, mock, test } from "bun:test";

import {
  type ExclusiveAccessPage,
  frameOrigin,
  IDLE_RESHOW_MS,
  noteExclusiveAccessGrant,
  trackWebviewExclusiveAccess,
} from "./exclusive-access";
import { EXCLUSIVE_ACCESS_HIDE, EXCLUSIVE_ACCESS_SHOW } from "./ipc-channels";

type Listener = () => void;
type Frame = { url: string; origin: string };

let nextId = 1;

/** A browser panel page at `url`, whose host records what it is sent. */
function fakePage(url: string, { type = "webview", frames = [] as Frame[] } = {}) {
  const listeners = new Map<string, Listener>();
  const send = mock((_channel: string, _payload: unknown) => {});
  let time = 0;
  const page = {
    id: nextId++,
    getType: () => type,
    getURL: () => url,
    on: (event: string, listener: Listener) => {
      listeners.set(event, listener);
      return page;
    },
    hostWebContents: { send, isDestroyed: () => false },
    mainFrame: { framesInSubtree: frames },
  } as unknown as ExclusiveAccessPage;
  const emit = (event: string) => listeners.get(event)?.();
  const track = () => trackWebviewExclusiveAccess(page, () => time);
  const advance = (ms: number) => {
    time += ms;
  };
  return { page, send, emit, listeners, track, advance };
}

const shown = (
  id: number,
  origin: string,
  fullscreen: boolean,
  pointerLock: boolean,
): [string, unknown] => [
  EXCLUSIVE_ACCESS_SHOW,
  { webContentsId: id, origin, fullscreen, pointerLock },
];

describe("fullscreen", () => {
  test("each entry shows the origin of the frame that asked, and leaving hides it", () => {
    const { page, send, emit, track } = fakePage("https://news.example/story");
    track();

    noteExclusiveAccessGrant(page, "fullscreen", "https://video.example/embed/1");
    emit("enter-html-full-screen");
    emit("leave-html-full-screen");
    // The page's own element: no grant noted for the next entry, so it names the page.
    emit("enter-html-full-screen");

    expect(send.mock.calls).toEqual([
      shown(page.id, "https://video.example", true, false),
      [EXCLUSIVE_ACCESS_HIDE, page.id],
      shown(page.id, "https://news.example", true, false),
    ]);
  });

  test("a frame taking over a fullscreen page is named at once", () => {
    const { page, send, emit, track } = fakePage("https://news.example/");
    track();
    noteExclusiveAccessGrant(page, "fullscreen", "https://news.example/");
    emit("enter-html-full-screen");
    noteExclusiveAccessGrant(page, "fullscreen", "https://video.example/embed");
    expect(send.mock.calls).toEqual([
      shown(page.id, "https://news.example", true, false),
      shown(page.id, "https://video.example", true, false),
    ]);
  });

  test("shows again on the first input after the user was away", () => {
    const { page, send, emit, track, advance } = fakePage("https://video.example/");
    track();
    emit("enter-html-full-screen");
    advance(IDLE_RESHOW_MS - 1);
    emit("before-mouse-event");
    advance(IDLE_RESHOW_MS - 1);
    emit("before-input-event");
    expect(send).toHaveBeenCalledTimes(1);

    advance(IDLE_RESHOW_MS);
    emit("before-input-event");
    expect(send).toHaveBeenCalledTimes(2);

    emit("leave-html-full-screen");
    advance(IDLE_RESHOW_MS);
    emit("before-mouse-event");
    expect(send.mock.calls.at(-1)).toEqual([EXCLUSIVE_ACCESS_HIDE, page.id]);
  });

  test("only browser panel pages are tracked", () => {
    const { listeners, track } = fakePage("https://loxel.example/", { type: "window" });
    track();
    expect(listeners.size).toBe(0);
  });
});

describe("pointer lock", () => {
  test("every granted request shows its frame's origin", () => {
    const { page, send } = fakePage("https://game.example/");
    noteExclusiveAccessGrant(page, "pointerLock", "https://game.example/play");
    noteExclusiveAccessGrant(page, "pointerLock", "https://game.example/play");
    noteExclusiveAccessGrant(page, "clipboard-sanitized-write", "https://game.example/play");
    const notice = shown(page.id, "https://game.example", false, true);
    expect(send.mock.calls).toEqual([notice, notice]);
  });

  test("locked by the fullscreen frame, one notice says both", () => {
    const { page, send, emit, track } = fakePage("https://game.example/");
    track();
    noteExclusiveAccessGrant(page, "fullscreen", "https://game.example/");
    emit("enter-html-full-screen");
    noteExclusiveAccessGrant(page, "pointerLock", "https://game.example/");
    noteExclusiveAccessGrant(page, "pointerLock", "https://ads.example/");
    expect(send.mock.calls.slice(1)).toEqual([
      shown(page.id, "https://game.example", true, true),
      shown(page.id, "https://ads.example", false, true),
    ]);
  });

  test("nothing goes to a host that is gone", () => {
    const { page, send } = fakePage("https://game.example/");
    page.hostWebContents = { send, isDestroyed: () => true };
    noteExclusiveAccessGrant(page, "pointerLock", "https://game.example/");
    expect(send).not.toHaveBeenCalled();
  });
});

describe("frameOrigin", () => {
  const page = (url: string, frames: Frame[] = []) => ({
    getURL: () => url,
    mainFrame: { framesInSubtree: frames },
  });

  test("names the frame by its URL's origin", () => {
    expect(frameOrigin("http://localhost:5173/app", page("https://a.example/"))).toBe(
      "http://localhost:5173",
    );
  });

  test("names an opaque URL's frame by the origin it inherited, preferring an embedded one", () => {
    const frames = [
      { url: "https://news.example/", origin: "https://news.example" },
      { url: "about:blank", origin: "https://news.example" },
      { url: "about:blank", origin: "https://ads.example" },
      { url: "about:srcdoc", origin: "https://news.example" },
    ];
    const news = page("https://news.example/", frames);
    expect(frameOrigin("about:blank", news)).toBe("https://ads.example");
    expect(frameOrigin("about:srcdoc", news)).toBe("https://news.example");
  });

  test("falls back to the page's origin, else its scheme", () => {
    const sandboxed = [{ url: "data:text/html,hi", origin: "null" }];
    expect(frameOrigin("data:text/html,hi", page("https://a.example/x", sandboxed))).toBe(
      "https://a.example",
    );
    expect(frameOrigin("file:///tmp/a.html", page("file:///tmp/a.html"))).toBe("file://");
  });
});
