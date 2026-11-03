import { describe, expect, mock, test } from "bun:test";

import type { HandlerDetails, WebContents, WindowOpenHandlerResponse } from "electron";

import { OPEN_IN_NEW_BROWSER_TAB } from "./ipc-channels";

type Listener = (...args: unknown[]) => void;

/** Event listeners by name, for the fakes below. */
function fakeEmitter() {
  const listeners = new Map<string, Listener[]>();
  return {
    on: (event: string, listener: Listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    emit: (event: string, ...args: unknown[]) => {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
  };
}

/** Every window the module created, in order. */
const windows: FakeBrowserWindow[] = [];

function lastWindow(): FakeBrowserWindow {
  const window = windows.at(-1);
  if (!window) throw new Error("no window was created");
  return window;
}

/** A BrowserWindow the module created for a popup. */
class FakeBrowserWindow {
  /** Stands in for the window that shows `contents`, so tests can tell parents apart. */
  static fromWebContents(contents: WebContents) {
    return { windowOf: contents.id };
  }

  readonly events = fakeEmitter();
  readonly on = this.events.on;
  readonly webContents: unknown;
  title: unknown;
  closed = false;

  constructor(readonly options: Record<string, unknown>) {
    this.webContents = options.webContents;
    this.title = options.title;
    windows.push(this);
  }

  setTitle(title: string) {
    this.title = title;
  }

  close() {
    this.closed = true;
    this.events.emit("closed");
  }
}

void mock.module("electron", () => ({ BrowserWindow: FakeBrowserWindow }));

const { POPUP_MIN_SIZE, USER_ACTIVATION_MS, handleWebviewWindowOpens } =
  await import("./webview-new-tabs");

type OpenHandler = (details: HandlerDetails) => WindowOpenHandlerResponse;

/** The id of Loxel's window's webContents, which hosts the webview. */
const HOST_ID = 1;

/** What the page asks for when it opens a sign-in popup. */
const POPUP_FEATURES = "width=500,height=600";

/** Options Electron worked out for a popup, including ones taken from a hostile page's features. */
const ELECTRON_POPUP_OPTIONS = {
  webPreferences: { sandbox: true, contextIsolation: true },
  width: 500,
  height: 600,
  x: 10,
  y: 20,
  frame: false,
  alwaysOnTop: true,
  closable: false,
  transparent: true,
};

/**
 * A webview's webContents (or a popup it opened, from `createPopup`) on a clock the test moves.
 * Tabs the host is asked to open land in `sent`.
 */
function fakeContents(id: number, type: string, clock: { time: number }, sent: unknown[][]) {
  const { on, emit } = fakeEmitter();
  let openHandler: OpenHandler | undefined;
  let destroyed = false;
  let focused = false;
  const contents = {
    id,
    getType: () => type,
    isDestroyed: () => destroyed,
    focus: () => {
      focused = true;
    },
    on,
    setWindowOpenHandler: (handler: OpenHandler) => {
      openHandler = handler;
    },
    // Only a webview has a host; a popup is a window of its own.
    hostWebContents:
      type === "webview"
        ? { id: HOST_ID, isDestroyed: () => false, send: (...args: unknown[]) => sent.push(args) }
        : null,
  } as unknown as WebContents;

  const fake = {
    contents,
    sent,
    emit,
    isFocused: () => focused,
    destroy: () => {
      destroyed = true;
    },
    hasHandler: () => openHandler !== undefined,
    click: () => emit("before-mouse-event", {}, { type: "mouseDown" }),
    press: (key = "Enter", { isAutoRepeat = false, meta = false, control = false } = {}) => {
      const event = { defaultPrevented: false, preventDefault: () => {} };
      event.preventDefault = () => {
        event.defaultPrevented = true;
      };
      const code = key.length === 1 ? `Key${key.toUpperCase()}` : key;
      const input = {
        type: "keyDown",
        key,
        code,
        isAutoRepeat,
        meta,
        control,
        alt: false,
        shift: false,
      };
      emit("before-input-event", event, input);
      return event.defaultPrevented;
    },
    advance: (ms: number) => {
      clock.time += ms;
    },
    open: (url: string, disposition: HandlerDetails["disposition"], features = "") => {
      if (!openHandler) throw new Error("no window open handler");
      return openHandler({
        url,
        disposition,
        frameName: "",
        features,
        referrer: { url: "", policy: "default" },
      });
    },
    /** Click, open a popup, and have Electron create its window; returns the popup and window. */
    createPopup: (popupId: number, url = "https://accounts.example.com/signin") => {
      fake.click();
      const response = fake.open(url, "new-window", POPUP_FEATURES);
      if (response.action !== "allow" || !response.createWindow) {
        throw new Error("popup was not allowed");
      }
      const popup = fakeContents(popupId, "window", clock, sent);
      const created = response.createWindow({
        ...ELECTRON_POPUP_OPTIONS,
        webContents: popup.contents,
      } as Electron.BrowserWindowConstructorOptions);
      expect(created).toBe(popup.contents);
      return { popup, window: lastWindow() };
    },
  };
  return fake;
}

function fakeWebview(type = "webview") {
  const clock = { time: 1_000_000 };
  const webview = fakeContents(7, type, clock, []);
  handleWebviewWindowOpens(webview.contents, () => clock.time);
  return webview;
}

describe("handleWebviewWindowOpens", () => {
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

  test("opens a popup as a child window of Loxel's window, keeping window.opener", () => {
    const webview = fakeWebview();

    const { window } = webview.createPopup(8);

    expect(window.options).toEqual({
      webContents: window.webContents,
      webPreferences: ELECTRON_POPUP_OPTIONS.webPreferences,
      width: 500,
      height: 600,
      x: 10,
      y: 20,
      minWidth: POPUP_MIN_SIZE.width,
      minHeight: POPUP_MIN_SIZE.height,
      parent: { windowOf: HOST_ID },
      title: "https://accounts.example.com",
    });
    expect(webview.sent).toEqual([]);
  });

  test("titles a popup with its site, not the page's own title", () => {
    const { popup, window } = fakeWebview().createPopup(8);
    const titleUpdate = { defaultPrevented: false, preventDefault: () => {} };
    titleUpdate.preventDefault = () => {
      titleUpdate.defaultPrevented = true;
    };

    window.events.emit("page-title-updated", titleUpdate, "Your Keychain");
    popup.emit("did-navigate", {}, "https://claude.example.com/callback?code=1");

    expect(titleUpdate.defaultPrevented).toBe(true);
    expect(window.title).toBe("https://claude.example.com");
  });

  test("closes a popup with the close-tab shortcut and returns the keyboard to its opener", () => {
    const webview = fakeWebview();
    const { popup, window } = webview.createPopup(8);
    const mac = process.platform === "darwin";

    expect(popup.press("w", { meta: !mac, control: mac })).toBe(false);
    expect(window.closed).toBe(false);
    expect(popup.press("w", { meta: mac, control: !mac })).toBe(true);

    expect(window.closed).toBe(true);
    expect(webview.isFocused()).toBe(true);
  });

  test("gives a popup's own popups and links the browser panel's rules", () => {
    const webview = fakeWebview();
    const { popup } = webview.createPopup(8);

    expect(popup.open("https://example.com/", "new-window", POPUP_FEATURES)).toEqual({
      action: "deny",
    });
    const { window: nested } = popup.createPopup(9);
    expect(nested.options.parent).toEqual({ windowOf: 8 });
    popup.click();
    popup.open("https://example.com/link", "foreground-tab");

    expect(webview.sent).toEqual([[OPEN_IN_NEW_BROWSER_TAB, 7, "https://example.com/link", false]]);
  });

  test("denies a popup's requests once its browser panel is gone", () => {
    const webview = fakeWebview();
    const { popup } = webview.createPopup(8);
    webview.destroy();
    popup.click();

    expect(popup.open("https://example.com/", "foreground-tab")).toEqual({ action: "deny" });
    expect(webview.sent).toEqual([]);
  });

  test("blocks popups the user did not trigger, and opens one popup per click", () => {
    const webview = fakeWebview();

    expect(webview.open("https://example.com/", "new-window", POPUP_FEATURES)).toEqual({
      action: "deny",
    });
    webview.click();
    expect(webview.open("https://example.com/", "new-window", POPUP_FEATURES).action).toBe("allow");

    expect(webview.open("https://example.com/", "new-window", POPUP_FEATURES)).toEqual({
      action: "deny",
    });
  });

  test("does not open non-http popups", () => {
    const webview = fakeWebview();
    webview.click();

    expect(webview.open("file:///etc/passwd", "new-window", POPUP_FEATURES)).toEqual({
      action: "deny",
    });
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
    webview.press("a", { isAutoRepeat: true });

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
