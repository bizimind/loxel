import { describe, expect, mock, test } from "bun:test";

import type { HandlerDetails, WebContents, WindowOpenHandlerResponse } from "electron";

import { appWindowTarget, guardAppNavigation, isAppPage, mayFrameNavigate } from "./app-navigation";
import { USER_ACTIVATION_MS } from "./user-activation";

const APP_URL = "http://127.0.0.1:7433";
const APP_ORIGIN = "http://127.0.0.1:7433";
const MEDIA_FRAME = `${APP_ORIGIN}/api/media-frame?path=a.svg&wt=%2Frepo`;

describe("isAppPage", () => {
  test("is the URL the windows load, fragment aside", () => {
    expect(isAppPage(`${APP_ORIGIN}/`, APP_URL)).toBe(true);
    expect(isAppPage(`${APP_ORIGIN}/#settings`, APP_URL)).toBe(true);
  });

  test("is no other path, query, origin or scheme", () => {
    expect(isAppPage(MEDIA_FRAME, APP_URL)).toBe(false);
    expect(isAppPage(`${APP_ORIGIN}/api/version`, APP_URL)).toBe(false);
    expect(isAppPage(`${APP_ORIGIN}/index.html`, APP_URL)).toBe(false);
    expect(isAppPage(`${APP_ORIGIN}/?x=1`, APP_URL)).toBe(false);
    expect(isAppPage("http://localhost:7433/", APP_URL)).toBe(false);
    expect(isAppPage("http://127.0.0.1:7434/", APP_URL)).toBe(false);
    expect(isAppPage("not a url", APP_URL)).toBe(false);
  });

  test("follows the dev server's URL in dev", () => {
    expect(isAppPage("http://localhost:5173/", "http://localhost:5173")).toBe(true);
    expect(isAppPage(`${APP_ORIGIN}/`, "http://localhost:5173")).toBe(false);
  });
});

describe("appWindowTarget", () => {
  test("opens the app's page as a Loxel window", () => {
    expect(appWindowTarget(`${APP_ORIGIN}/`, APP_URL)).toBe("app-page");
  });

  test("opens nothing else on the app's origin", () => {
    expect(appWindowTarget(MEDIA_FRAME, APP_URL)).toBe("none");
    expect(appWindowTarget(`${APP_ORIGIN}/api/file-raw?path=a.png`, APP_URL)).toBe("none");
    expect(appWindowTarget(`${APP_ORIGIN}/docs/readme.md`, APP_URL)).toBe("none");
  });

  test("sends web links outside the app", () => {
    expect(appWindowTarget("https://example.com/", APP_URL)).toBe("outside");
    expect(appWindowTarget("http://localhost:3000/", APP_URL)).toBe("outside");
  });

  test("opens no other scheme", () => {
    expect(appWindowTarget("file:///etc/hosts", APP_URL)).toBe("none");
    expect(appWindowTarget("javascript:alert(1)", APP_URL)).toBe("none");
    expect(appWindowTarget("data:text/html,hi", APP_URL)).toBe("none");
  });
});

describe("mayFrameNavigate", () => {
  test("keeps a frame the app's server sent on the server", () => {
    expect(
      mayFrameNavigate(MEDIA_FRAME, `${APP_ORIGIN}/api/media-frame?path=b.svg`, APP_ORIGIN),
    ).toBe(true);
    expect(mayFrameNavigate(MEDIA_FRAME, "https://example.com/", APP_ORIGIN)).toBe(false);
    expect(mayFrameNavigate(MEDIA_FRAME, "data:text/html,hi", APP_ORIGIN)).toBe(false);
    expect(mayFrameNavigate(MEDIA_FRAME, "about:blank", APP_ORIGIN)).toBe(false);
  });

  test("lets other frames go where they like", () => {
    expect(mayFrameNavigate("about:blank", MEDIA_FRAME, APP_ORIGIN)).toBe(true);
    expect(mayFrameNavigate("https://example.com/", "https://example.org/", APP_ORIGIN)).toBe(true);
    expect(mayFrameNavigate("", "https://example.org/", APP_ORIGIN)).toBe(true);
  });
});

type Listener = (...args: unknown[]) => void;
type OpenHandler = (details: HandlerDetails) => WindowOpenHandlerResponse;

/** A webContents that records the handlers the guard installs, on a clock the test moves. */
function fakeContents() {
  const listeners = new Map<string, Listener[]>();
  let openHandler: OpenHandler | undefined;
  const clock = { time: 1_000 };
  const contents = {
    setWindowOpenHandler: (handler: OpenHandler) => {
      openHandler = handler;
    },
    on: (event: string, listener: Listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
  };
  const actions = { openAppWindow: mock(() => {}), openOutside: mock((_url: string) => {}) };
  guardAppNavigation(contents as unknown as WebContents, APP_URL, actions, () => clock.time);

  /** A click anywhere in the window, a sub-frame's included. */
  function click(): void {
    for (const listener of listeners.get("before-mouse-event") ?? []) {
      listener({}, { type: "mouseDown" });
    }
  }

  function open(url: string): WindowOpenHandlerResponse {
    if (!openHandler) throw new Error("no window open handler");
    return openHandler({
      url,
      frameName: "",
      features: "",
      disposition: "foreground-tab",
    } as HandlerDetails);
  }
  /** Emit a navigation event; returns whether a listener cancelled it. */
  function emit(name: string, ...args: unknown[]): boolean {
    let prevented = false;
    const event = { preventDefault: () => (prevented = true) };
    const [listener] = listeners.get(name) ?? [];
    if (!listener) throw new Error(`no ${name} listener`);
    if (name === "will-frame-navigate") listener({ ...event, ...(args[0] as object) });
    else listener(event, ...args);
    return prevented;
  }
  return { actions, clock, click, open, emit };
}

describe("guardAppNavigation", () => {
  test("opens every window a page asks for as no child of it", () => {
    const { actions, click, open } = fakeContents();
    for (const url of [
      `${APP_ORIGIN}/`,
      MEDIA_FRAME,
      "https://example.com/",
      "file:///etc/hosts",
    ]) {
      click();
      expect(open(url)).toEqual({ action: "deny" });
    }
    expect(actions.openAppWindow).toHaveBeenCalledTimes(1);
    expect(actions.openOutside.mock.calls).toEqual([["https://example.com/"]]);
  });

  test("opens a window only right after a click or key press, one per action", () => {
    const { actions, clock, click, open } = fakeContents();
    open("https://example.com/");
    open(`${APP_ORIGIN}/`);
    expect(actions.openOutside).not.toHaveBeenCalled();
    expect(actions.openAppWindow).not.toHaveBeenCalled();

    click();
    open("https://example.com/a");
    open("https://example.com/b");
    expect(actions.openOutside.mock.calls).toEqual([["https://example.com/a"]]);

    click();
    clock.time += USER_ACTIVATION_MS;
    open(`${APP_ORIGIN}/`);
    expect(actions.openAppWindow).not.toHaveBeenCalled();
  });

  test("a refused URL leaves the click for the next window", () => {
    const { actions, click, open } = fakeContents();
    click();
    open("file:///etc/hosts");
    open("https://example.com/");
    expect(actions.openOutside.mock.calls).toEqual([["https://example.com/"]]);
  });

  test("keeps the main frame on the app's page", () => {
    const { actions, emit } = fakeContents();
    expect(emit("will-navigate", `${APP_ORIGIN}/`)).toBe(false);
    expect(emit("will-navigate", `${APP_ORIGIN}/#x`)).toBe(false);
    expect(emit("will-navigate", MEDIA_FRAME)).toBe(true);
    expect(emit("will-navigate", "https://example.com/")).toBe(true);
    expect(actions.openOutside.mock.calls).toEqual([["https://example.com/"]]);
  });

  test("keeps a media frame on the server", () => {
    const { emit } = fakeContents();
    const frame = { url: MEDIA_FRAME };
    const navigate = (url: string, isMainFrame = false) =>
      emit("will-frame-navigate", { url, isMainFrame, frame });
    expect(navigate("https://example.com/")).toBe(true);
    expect(navigate(`${APP_ORIGIN}/api/media-frame?path=b.svg`)).toBe(false);
    // The main frame is will-navigate's.
    expect(navigate("https://example.com/", true)).toBe(false);
    // A frame that is gone has nothing to keep.
    expect(
      emit("will-frame-navigate", { url: "https://example.com/", isMainFrame: false, frame: null }),
    ).toBe(false);
  });
});
