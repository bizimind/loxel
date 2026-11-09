/**
 * Open the links a browser panel's page asks to open in a new tab or window (⌘-click,
 * middle-click, ⇧⌘-click, `target="_blank"`, `window.open`) as browser tabs next to that panel.
 *
 * Popups (`window.open` with window features such as a size) are the exception: they open as a
 * real window over Loxel's window, because the page talks to them through `window.opener`, which a
 * tab cannot keep. Sign-in popups (Google, Apple and other OAuth providers) hand their result back
 * that way and hang on a blank page without it.
 *
 * Like a browser's popup blocker, each click or key press in the page opens at most one tab or
 * popup, and only `http:`/`https:` URLs are opened. The `<webview>` must carry `allowpopups`, or
 * Electron drops every such request before it gets here.
 */
import {
  BrowserWindow,
  type BrowserWindowConstructorOptions,
  type HandlerDetails,
  type WebContents,
} from "electron";

import { inputToKeyCombo, isModifierKey } from "../store/keybindings/key-combo";
import { isHttpUrl } from "../url-utils";
import { OPEN_IN_NEW_BROWSER_TAB } from "./ipc-channels";

/** How long a click or key press lets the page open a tab: Chromium's transient user activation. */
export const USER_ACTIVATION_MS = 5000;

/**
 * A `window.open` call that asked for a popup window rather than a tab. Chromium reports both a
 * popup and a ⇧-clicked link as `new-window`; only the popup comes with window features.
 */
function isPopup({ disposition, features }: HandlerDetails): boolean {
  return disposition === "new-window" && features !== "";
}

/** Smallest popup window, so a page cannot hide one as a speck on the screen. */
export const POPUP_MIN_SIZE = { width: 240, height: 160 };

/** The key that closes a popup window, as browsers close theirs. */
const CLOSE_POPUP_COMBO = process.platform === "darwin" ? "Cmd+W" : "Ctrl+W";

/** `createWindow`'s options also carry the popup's webContents, which Electron's types leave out. */
type PopupWindowOptions = BrowserWindowConstructorOptions & { webContents?: WebContents };

/** Attach to every webview's webContents (from `web-contents-created`). */
export function handleWebviewWindowOpens(contents: WebContents, now = Date.now): void {
  if (contents.getType() !== "webview") return;
  handleWindowOpens(contents, contents, now);
}

/**
 * Apply the browser panel's rules to the windows `contents` asks to open. `contents` is the
 * webview or a popup it opened, directly or through other popups; tabs go next to `webview`.
 */
function handleWindowOpens(contents: WebContents, webview: WebContents, now: () => number): void {
  let lastActivation = Number.NEGATIVE_INFINITY;
  contents.on("before-mouse-event", (_, input) => {
    if (input.type === "mouseDown") lastActivation = now();
  });
  contents.on("before-input-event", (_, input) => {
    if (input.type === "keyDown" && !input.isAutoRepeat && !isModifierKey(input.key)) {
      lastActivation = now();
    }
  });
  contents.setWindowOpenHandler((details) => {
    const host = webview.isDestroyed() ? null : webview.hostWebContents;
    const userActivated = now() - lastActivation < USER_ACTIVATION_MS;
    if (!isHttpUrl(details.url) || !userActivated || !host || host.isDestroyed()) {
      return { action: "deny" };
    }
    // Consume the activation so one click cannot open a flood of tabs.
    lastActivation = Number.NEGATIVE_INFINITY;
    if (isPopup(details)) {
      const parent = BrowserWindow.fromWebContents(contents === webview ? host : contents);
      return {
        action: "allow",
        createWindow: (options) =>
          openPopupWindow(options, details.url, parent ?? undefined, contents, webview, now),
      };
    }
    // ⌘-click and middle-click open in the background; the rest focus the new tab.
    const background = details.disposition === "background-tab";
    host.send(OPEN_IN_NEW_BROWSER_TAB, webview.id, details.url, background);
    return { action: "deny" };
  });
}

/**
 * Create the window for a popup `opener` was allowed to open, and give it the browser panel's
 * rules. Returns its webContents, as `createWindow` must.
 */
function openPopupWindow(
  options: PopupWindowOptions,
  url: string,
  parent: BrowserWindow | undefined,
  opener: WebContents,
  webview: WebContents,
  now: () => number,
): WebContents {
  // Take only the size, position, session and locked-down preferences Electron worked out. It
  // also turns any window option in the page's features into one (frameless, always on top, not
  // closable, transparent...), which would let a page draw a fake prompt over every app.
  const { webContents, webPreferences, width, height, x, y } = options;
  const popupOptions: PopupWindowOptions = {
    webContents,
    webPreferences,
    width,
    height,
    x,
    y,
    minWidth: POPUP_MIN_SIZE.width,
    minHeight: POPUP_MIN_SIZE.height,
    // A child of the opener's window stays above it and closes with it.
    parent,
    // A popup has no address bar, so its title names the site instead of the page's own title.
    title: new URL(url).origin,
  };
  const popup = new BrowserWindow(popupOptions);
  popup.on("page-title-updated", (event) => event.preventDefault());
  popup.webContents.on("did-navigate", (_, address) => popup.setTitle(new URL(address).origin));
  // A popup has no Loxel renderer to handle ⌘W, which closes a tab in Loxel's window.
  popup.webContents.on("before-input-event", (event, input) => {
    if (input.type === "keyDown" && inputToKeyCombo(input) === CLOSE_POPUP_COMBO) {
      event.preventDefault();
      popup.close();
    }
  });
  // Hand the keyboard back to the page that opened it, as browsers return to the opener tab.
  popup.on("closed", () => {
    if (!opener.isDestroyed()) opener.focus();
  });
  // Replaces the handler main.ts gives every non-webview window, which would send the popup's own
  // links and popups to the system browser.
  handleWindowOpens(popup.webContents, webview, now);
  return popup.webContents;
}
