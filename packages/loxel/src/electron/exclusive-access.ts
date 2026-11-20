import { ipcMain, type WebContents, type WebFrameMain } from "electron";

import type { BrowserPermission } from "./browser-permissions";
import type { ExclusiveAccessNotice } from "./exclusive-access-notice";
import { EXCLUSIVE_ACCESS_HIDE, EXCLUSIVE_ACCESS_SHOW, POINTER_LOCK_CHANGE } from "./ipc-channels";
import { webviewSenderFrame } from "./webview-sender";

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
 *
 * Main gets no signal when the pointer is unlocked, so for the notice shown again after the user
 * was away, the webview preload reports each `pointerlockchange` of its frame. A page could lie in
 * that report, or send it late, so it only ever ends tracking a lock in favour of the notice: main
 * tracks a granted lock until the frame that asked for it reports taking it and then losing it
 * (see `PointerLock`), and any other lock, as one an `about:blank` frame took, until the page
 * navigates.
 */

/** How long without input before the next input shows a page's notice again (Chrome's). */
export const IDLE_RESHOW_MS = 15 * 60 * 1000;

/** The webContents of a browser panel page, as far as this module uses it. */
export type ExclusiveAccessPage = Pick<WebContents, "id" | "getType" | "getURL" | "on"> & {
  hostWebContents: Pick<WebContents, "send" | "isDestroyed"> | null;
  mainFrame: { framesInSubtree: Array<ExclusiveAccessFrame> };
};

/** A frame of a browser panel page, as far as this module uses it. */
export type ExclusiveAccessFrame = Pick<WebFrameMain, "url" | "origin" | "processId" | "routingId">;

/** A pointer lock granted to one of the page's frames, until it is known to have ended. */
interface PointerLock {
  /** The origin of the frame whose request was granted. */
  origin: string;
  /**
   * The frame that asked (`frameKey`), when the page had exactly one frame at the requesting URL:
   * Electron names the requester only by its URL. Only this frame's reports end the lock, never
   * another frame's, which may describe a lock its renderer hasn't yet learned it lost.
   */
  requester: string | null;
  /** The requester reported taking the lock since the grant, so its report of losing it counts. */
  taken: boolean;
}

interface PageState {
  /** The origin of the frame whose fullscreen request was just granted, until the page enters. */
  requester: string | null;
  /** The origin of the frame that is fullscreen, while the page is. */
  fullscreen: string | null;
  /** The page's pointer lock, while it may hold one. */
  pointerLock: PointerLock | null;
  lastInput: number;
  /** The page's clock, which `trackWebviewExclusiveAccess` sets. */
  now: () => number;
}

// By webContents ID. Electron grants a fullscreen request, then emits `enter-html-full-screen`
// synchronously, without naming the frame, so the grant leaves its origin here.
const pages = new Map<number, PageState>();

function stateOf(page: ExclusiveAccessPage): PageState {
  let state = pages.get(page.id);
  if (!state) {
    state = { requester: null, fullscreen: null, pointerLock: null, lastInput: 0, now: Date.now };
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
    const requesters = page.mainFrame.framesInSubtree.filter(
      (frame) => frame.url === requestingUrl,
    );
    const [requester] = requesters;
    state.pointerLock = {
      origin,
      requester: requesters.length === 1 && requester ? frameKey(requester) : null,
      taken: false,
    };
    state.lastInput = state.now();
    showPointerLock(page, state.pointerLock, state);
  } else if (state.fullscreen === null) {
    state.requester = origin;
  } else {
    // Another frame takes over while the page is fullscreen: Electron emits no second entry.
    state.fullscreen = origin;
    show(page, { origin, fullscreen: true, pointerLock: false });
  }
}

/**
 * Note a frame's report (`POINTER_LOCK_CHANGE`) that it took (`locked`) or lost the pointer lock.
 * `frame` is the sender frame as Chromium knows it, never what the page says about itself.
 */
export function notePointerLockReport(
  page: Pick<ExclusiveAccessPage, "id">,
  frame: Pick<WebFrameMain, "processId" | "routingId">,
  locked: boolean,
): void {
  const state = pages.get(page.id);
  const lock = state?.pointerLock;
  if (!state || !lock || lock.requester !== frameKey(frame)) return;
  if (locked) lock.taken = true;
  else if (lock.taken) state.pointerLock = null;
}

/** Listen for the webview preload's pointer lock reports. */
export function installPointerLockReports(): void {
  ipcMain.on(POINTER_LOCK_CHANGE, (event, locked: unknown) => {
    const frame = webviewSenderFrame(event);
    if (frame && typeof locked === "boolean") notePointerLockReport(event.sender, frame, locked);
  });
}

function frameKey({ processId, routingId }: Pick<WebFrameMain, "processId" | "routingId">) {
  return `${processId}:${routingId}`;
}

/**
 * Show a notice in the page's panel each time it goes fullscreen, again on the first input after
 * the user was away for `IDLE_RESHOW_MS` while it is fullscreen or holds the pointer lock, and drop
 * it when the page leaves fullscreen.
 */
export function trackWebviewExclusiveAccess(
  page: ExclusiveAccessPage,
  now: () => number = Date.now,
): void {
  if (page.getType() !== "webview") return;
  stateOf(page).now = now;
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
  // A new document holds no lock: navigating releases the old one's.
  page.on("did-navigate", () => {
    const state = pages.get(page.id);
    if (state) state.pointerLock = null;
  });
  const onInput = () => {
    const state = pages.get(page.id);
    if (!state || (!state.fullscreen && !state.pointerLock)) return;
    const time = now();
    if (time - state.lastInput >= IDLE_RESHOW_MS) showAgain(page, state);
    state.lastInput = time;
  };
  page.on("before-input-event", onInput);
  page.on("before-mouse-event", onInput);
  page.on("destroyed", () => pages.delete(page.id));
}

/**
 * The notice for what the page holds now. Locked by a frame other than the fullscreen one, it names
 * the frame that has the screen.
 */
function showAgain(page: ExclusiveAccessPage, state: PageState) {
  const lock = state.pointerLock;
  if (lock && (state.fullscreen === null || state.fullscreen === lock.origin)) {
    showPointerLock(page, lock, state);
    return;
  }
  if (state.fullscreen) {
    show(page, { origin: state.fullscreen, fullscreen: true, pointerLock: false });
  }
}

/** Locked from the frame that is fullscreen, one notice says both, as Chrome's does. */
function showPointerLock(page: ExclusiveAccessPage, lock: PointerLock, state: PageState) {
  show(page, {
    origin: lock.origin,
    fullscreen: state.fullscreen === lock.origin,
    pointerLock: true,
  });
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
export function frameOrigin(
  url: string,
  page: Pick<ExclusiveAccessPage, "getURL"> & {
    mainFrame: { framesInSubtree: Array<Pick<ExclusiveAccessFrame, "url" | "origin">> };
  },
) {
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
