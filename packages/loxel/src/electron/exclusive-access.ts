import type { WebContents, WebFrameMain } from "electron";

import type { BrowserPermission } from "./browser-permissions";
import type { ExclusiveAccessNotice } from "./exclusive-access-notice";
import { EXCLUSIVE_ACCESS_HIDE, EXCLUSIVE_ACCESS_SHOW } from "./ipc-channels";

/**
 * Tells a browser panel when its page goes fullscreen or locks the pointer, so the panel can show
 * which site it is and how to leave (`ExclusiveAccessNotice`). Electron draws no such notice
 * itself, and without one a fullscreen page can draw a convincing copy of Loxel or of a system
 * prompt. Esc leaves both, handled by Electron; keyboard lock, which would make that "hold Esc",
 * is refused to webviews (browser-permissions.ts), and so are fullscreen and pointer lock to popup
 * windows, which have no panel to show a notice.
 *
 * Fullscreen is known from the guest's `enter-html-full-screen`. Pointer lock has no event, so its
 * notice comes from the permission request, which Electron makes on every `requestPointerLock()`
 * and which the page cannot route around (the webview preload, by contrast, doesn't run in
 * `about:blank` frames). Both requests name the frame that asked, so the notice names that frame's
 * origin, as Chrome's does: an embedded frame that goes fullscreen is not shown as its host.
 */

/** How long without input before the next input shows a fullscreen page's notice again (Chrome's). */
export const IDLE_RESHOW_MS = 15 * 60 * 1000;

/** The webContents of a browser panel page, as far as this module uses it. */
export type ExclusiveAccessPage = Pick<WebContents, "id" | "getType" | "getURL" | "on"> & {
  hostWebContents: Pick<WebContents, "send" | "isDestroyed"> | null;
  mainFrame: { framesInSubtree: Array<Pick<WebFrameMain, "url" | "origin">> };
};

interface PageState {
  /** The origin of the frame whose fullscreen request was just granted, until the page enters. */
  requester: string | null;
  /** The origin of the frame that is fullscreen, while the page is. */
  fullscreen: string | null;
  lastInput: number;
}

// By webContents ID. Electron grants a fullscreen request, then emits `enter-html-full-screen`
// synchronously, without naming the frame, so the grant leaves its origin here.
const pages = new Map<number, PageState>();

function stateOf(page: ExclusiveAccessPage): PageState {
  let state = pages.get(page.id);
  if (!state) {
    state = { requester: null, fullscreen: null, lastInput: 0 };
    pages.set(page.id, state);
  }
  return state;
}

/**
 * Note a permission `browser-permissions.ts` grants a page, before the grant takes effect.
 * `requestingUrl` is the URL of the frame that asked.
 */
export function noteExclusiveAccessGrant(
  page: ExclusiveAccessPage,
  permission: BrowserPermission,
  requestingUrl: string,
): void {
  if (page.getType() !== "webview") return;
  if (permission !== "fullscreen" && permission !== "pointerLock") return;
  const state = stateOf(page);
  const origin = frameOrigin(requestingUrl, page);
  if (permission === "pointerLock") {
    // Locked from the page that is fullscreen: one notice says both, as Chrome's does.
    const fullscreen = state.fullscreen === origin;
    show(page, { origin, fullscreen, pointerLock: true });
  } else if (state.fullscreen === null) {
    state.requester = origin;
  } else {
    // Another frame takes over while the page is fullscreen: Electron emits no second entry.
    state.fullscreen = origin;
    show(page, { origin, fullscreen: true, pointerLock: false });
  }
}

/**
 * Show a notice in the page's panel each time it goes fullscreen, again on the first input after
 * the user was away for `IDLE_RESHOW_MS`, and drop it when the page leaves fullscreen.
 */
export function trackWebviewExclusiveAccess(
  page: ExclusiveAccessPage,
  now: () => number = Date.now,
): void {
  if (page.getType() !== "webview") return;
  page.on("enter-html-full-screen", () => {
    const state = stateOf(page);
    const origin = state.requester ?? frameOrigin(page.getURL(), page);
    state.requester = null;
    state.fullscreen = origin;
    state.lastInput = now();
    show(page, { origin, fullscreen: true, pointerLock: false });
  });
  // Leaving fullscreen also releases a pointer lock, so it ends either notice.
  page.on("leave-html-full-screen", () => {
    stateOf(page).fullscreen = null;
    send(page, EXCLUSIVE_ACCESS_HIDE, page.id);
  });
  const onInput = () => {
    const state = pages.get(page.id);
    if (!state?.fullscreen) return;
    const time = now();
    if (time - state.lastInput >= IDLE_RESHOW_MS) {
      show(page, { origin: state.fullscreen, fullscreen: true, pointerLock: false });
    }
    state.lastInput = time;
  };
  page.on("before-input-event", onInput);
  page.on("before-mouse-event", onInput);
  page.on("destroyed", () => pages.delete(page.id));
}

function show(page: ExclusiveAccessPage, notice: Omit<ExclusiveAccessNotice, "webContentsId">) {
  send(page, EXCLUSIVE_ACCESS_SHOW, { webContentsId: page.id, ...notice });
}

function send(page: ExclusiveAccessPage, channel: string, payload: unknown): void {
  const host = page.hostWebContents;
  if (host && !host.isDestroyed()) host.send(channel, payload);
}

/**
 * The origin to name for the frame at `url`. A URL with an opaque origin (`about:blank`,
 * `about:srcdoc`, `data:`) doesn't say whose the frame is, so it is looked up among the page's
 * frames at that URL, whose origins Chromium inherited from their creators. Should those differ,
 * one other than the page's own is named, so an embedded frame is never passed off as its host.
 * With none, it is the page's origin, as Chrome falls back to, or for a page without one, such as a
 * local file, its scheme.
 */
export function frameOrigin(url: string, page: Pick<ExclusiveAccessPage, "getURL" | "mainFrame">) {
  const own = originOf(url);
  if (own) return own;
  const pageUrl = page.getURL();
  const pageOrigin = originOf(pageUrl);
  const inherited = page.mainFrame.framesInSubtree
    .filter((frame) => frame.url === url && frame.origin && frame.origin !== "null")
    .map((frame) => frame.origin);
  return (
    inherited.find((origin) => origin !== pageOrigin) ??
    inherited[0] ??
    pageOrigin ??
    schemeOf(pageUrl)
  );
}

function originOf(url: string): string | null {
  if (!URL.canParse(url)) return null;
  const { origin } = new URL(url);
  return origin === "null" ? null : origin;
}

function schemeOf(url: string): string {
  return URL.canParse(url) ? `${new URL(url).protocol}//` : url;
}
