import { describe, expect, test } from "bun:test";

import type { HandlerDetails, WebContents, WindowOpenHandlerResponse } from "electron";

import { OPEN_IN_NEW_BROWSER_TAB } from "./ipc-channels";
import { USER_ACTIVATION_MS, openWebviewWindowsAsTabs } from "./webview-new-tabs";

interface Input {
  type: string;
  key?: string;
  isAutoRepeat?: boolean;
}
type Listener = (event: unknown, input: Input) => void;

/** A webview's webContents, its host, and a clock the test moves. */
function fakeWebview(type = "webview") {
  const listeners = new Map<string, Listener[]>();
  const sent: unknown[][] = [];
  let openHandler: ((details: HandlerDetails) => WindowOpenHandlerResponse) | undefined;
  let time = 1_000_000;
  const contents = {
    id: 7,
    getType: () => type,
    on: (event: string, listener: Listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    setWindowOpenHandler: (handler: typeof openHandler) => {
      openHandler = handler;
    },
    hostWebContents: { isDestroyed: () => false, send: (...args: unknown[]) => sent.push(args) },
  } as unknown as WebContents;
  openWebviewWindowsAsTabs(contents, () => time);

  const emit = (event: string, input: Input) => {
    for (const listener of listeners.get(event) ?? []) listener({}, input);
  };
  return {
    sent,
    hasHandler: () => openHandler !== undefined,
    click: () => emit("before-mouse-event", { type: "mouseDown" }),
    press: (key = "Enter", isAutoRepeat = false) =>
      emit("before-input-event", { type: "keyDown", key, isAutoRepeat }),
    advance: (ms: number) => {
      time += ms;
    },
    open: (url: string, disposition: HandlerDetails["disposition"]) => {
      if (!openHandler) throw new Error("no window open handler");
      return openHandler({
        url,
        disposition,
        frameName: "",
        features: "",
        referrer: { url: "", policy: "default" },
      });
    },
  };
}

describe("openWebviewWindowsAsTabs", () => {
  test("opens ⌘-clicked and middle-clicked links in a background tab", () => {
    const webview = fakeWebview();
    webview.click();

    expect(webview.open("https://example.com/", "background-tab")).toEqual({ action: "deny" });

    expect(webview.sent).toEqual([[OPEN_IN_NEW_BROWSER_TAB, 7, "https://example.com/", true]]);
  });

  test("opens target=_blank, window.open and ⇧⌘-click in a foreground tab", () => {
    const webview = fakeWebview();

    for (const disposition of ["foreground-tab", "new-window", "default", "other"] as const) {
      webview.click();
      webview.open("https://example.com/", disposition);
    }

    expect(webview.sent.map((args) => args[3])).toEqual([false, false, false, false]);
  });

  test("counts a key press as a user action", () => {
    const webview = fakeWebview();
    webview.press();

    webview.open("https://example.com/", "foreground-tab");

    expect(webview.sent).toHaveLength(1);
  });

  test("blocks popups the user did not trigger", () => {
    const webview = fakeWebview();

    expect(webview.open("https://example.com/", "foreground-tab")).toEqual({ action: "deny" });
    webview.click();
    webview.advance(USER_ACTIVATION_MS);
    webview.open("https://example.com/", "foreground-tab");

    expect(webview.sent).toEqual([]);
  });

  test("opens one tab per click", () => {
    const webview = fakeWebview();
    webview.click();

    webview.open("https://example.com/1", "background-tab");
    webview.open("https://example.com/2", "background-tab");
    webview.click();
    webview.open("https://example.com/3", "background-tab");

    expect(webview.sent.map((args) => args[2])).toEqual([
      "https://example.com/1",
      "https://example.com/3",
    ]);
  });

  test("does not count holding a modifier or a repeating key as a user action", () => {
    const webview = fakeWebview();
    webview.press("Meta");
    webview.press("a", true);

    webview.open("https://example.com/", "foreground-tab");

    expect(webview.sent).toEqual([]);
  });

  test("allows a popup shortly after a click", () => {
    const webview = fakeWebview();
    webview.click();
    webview.advance(USER_ACTIVATION_MS - 1);

    webview.open("https://example.com/", "foreground-tab");

    expect(webview.sent).toHaveLength(1);
  });

  test("drops non-http URLs", () => {
    const webview = fakeWebview();
    webview.click();

    webview.open("file:///etc/passwd", "foreground-tab");
    webview.open("javascript:alert(1)", "foreground-tab");

    expect(webview.sent).toEqual([]);
  });

  test("leaves web contents other than webviews alone", () => {
    expect(fakeWebview("window").hasHandler()).toBe(false);
  });
});
