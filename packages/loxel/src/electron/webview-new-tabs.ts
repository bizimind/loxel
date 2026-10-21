/**
 * Open the links a browser panel's page asks to open in a new tab or window (⌘-click,
 * middle-click, ⇧⌘-click, `target="_blank"`, `window.open`) as browser tabs next to that panel.
 *
 * No real window is ever created: the request goes to the host renderer, which owns the layout.
 * Like a browser's popup blocker, each click or key press in the page opens at most one tab, and
 * only `http:`/`https:` URLs are opened. The `<webview>` must carry `allowpopups`, or Electron
 * drops every such request before it gets here.
 */
import type { WebContents } from "electron";

import { isModifierKey } from "../store/keybindings/key-combo";
import { isHttpUrl } from "../url-utils";
import { OPEN_IN_NEW_BROWSER_TAB } from "./ipc-channels";

/** How long a click or key press lets the page open a tab: Chromium's transient user activation. */
export const USER_ACTIVATION_MS = 5000;

/** Attach to every webview's webContents (from `web-contents-created`). */
export function openWebviewWindowsAsTabs(contents: WebContents, now = Date.now): void {
  if (contents.getType() !== "webview") return;
  let lastActivation = Number.NEGATIVE_INFINITY;
  contents.on("before-mouse-event", (_, input) => {
    if (input.type === "mouseDown") lastActivation = now();
  });
  contents.on("before-input-event", (_, input) => {
    if (input.type === "keyDown" && !input.isAutoRepeat && !isModifierKey(input.key)) {
      lastActivation = now();
    }
  });
  contents.setWindowOpenHandler(({ url, disposition }) => {
    const host = contents.hostWebContents;
    const userActivated = now() - lastActivation < USER_ACTIVATION_MS;
    if (isHttpUrl(url) && userActivated && host && !host.isDestroyed()) {
      // Consume the activation so one click cannot open a flood of tabs.
      lastActivation = Number.NEGATIVE_INFINITY;
      // ⌘-click and middle-click open in the background; the rest focus the new tab.
      host.send(OPEN_IN_NEW_BROWSER_TAB, contents.id, url, disposition === "background-tab");
    }
    return { action: "deny" };
  });
}
