/**
 * Loxel's prompts and dialogs take the screen and the pointer back from browser panel pages, as
 * Chrome's do (`ForSecurityDropFullscreen`): a page in HTML fullscreen would cover a prompt shown
 * over its panel, and a locked pointer couldn't reach it. Before a prompt shows over a page, the
 * page leaves fullscreen and releases the pointer lock (`webContents.exitExclusiveAccess()`, from
 * the patched Electron releases ship with, PATCHED_ELECTRON.md), and until the prompt closes it may
 * take neither back: `browser-permissions.ts` refuses its `fullscreen` and `pointerLock` requests,
 * since the exit is one-shot and a page with its user gesture, or a request on its way, could
 * enter again right after.
 *
 * A hold covers one page (a prompt in its panel, or a native dialog it asked for) or every page a
 * window hosts (a Loxel modal over the whole window, which the window's renderer reports). Stock
 * Electron, as in dev runs and tests, has no `exitExclusiveAccess()`, so there a hold only
 * refuses. No runtime imports from `electron` here: the prompts that hold are tested against
 * partial mocks of it.
 *
 * A held page that asks again is told no without a word, so its panel highlights the prompt that
 * holds it (`EXCLUSIVE_ACCESS_REFUSED`), and the user sees why the video didn't go fullscreen.
 */
import { EXCLUSIVE_ACCESS_REFUSED } from "./ipc-channels";

/** A browser panel page's webContents, as far as holds use it. */
export interface HoldablePage {
  id: number;
  isDestroyed: () => boolean;
  hostWebContents: {
    id: number;
    send: (channel: string, payload: unknown) => void;
    isDestroyed: () => boolean;
  } | null;
  /** Patch 0008; missing on stock Electron. */
  exitExclusiveAccess?: () => void;
}

/** Browser panel pages by webContents ID, as `trackHoldablePage` registers them. */
const pages = new Map<number, HoldablePage>();
/** Open holds per page, by webContents ID. */
const pageHolds = new Map<number, number>();
/** Window renderers (webContents IDs) holding every page they host. */
const windowHolds = new Set<number>();
/**
 * Window renderers whose windows animate into native fullscreen for a page of theirs, with the
 * cancel of the wait's timeout.
 */
const windowsEntering = new Map<number, () => void>();
/** Pages whose exit waits for their window to finish entering fullscreen. */
const deferredExits = new Set<number>();

/** Know `page`, so holds can reach it, until it is destroyed. */
export function trackHoldablePage(
  page: HoldablePage & { once: (event: "destroyed", listener: () => void) => unknown },
): void {
  pages.set(page.id, page);
  page.once("destroyed", () => {
    pages.delete(page.id);
    pageHolds.delete(page.id);
    deferredExits.delete(page.id);
  });
}

/**
 * A prompt is about to show over the page of webContents `pageId` (a browser panel's guest; for
 * any other webContents, such as a popup, which never gets fullscreen or pointer lock, it only
 * counts). Returns the release, for when the prompt closes; calling it again does nothing.
 */
export function holdExclusiveAccess(pageId: number): () => void {
  pageHolds.set(pageId, (pageHolds.get(pageId) ?? 0) + 1);
  const page = pages.get(pageId);
  if (page) exitExclusiveAccess(page);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = pageHolds.get(pageId) ?? 0;
    if (count > 1) pageHolds.set(pageId, count - 1);
    else pageHolds.delete(pageId);
  };
}

/** A held page asked for fullscreen or pointer lock and was refused: its panel points at why. */
export function noteRefusedWhileHeld(pageId: number): void {
  const page = pages.get(pageId);
  const host = page && !page.isDestroyed() ? page.hostWebContents : null;
  if (host && !host.isDestroyed()) host.send(EXCLUSIVE_ACCESS_REFUSED, pageId);
}

/** Show a dialog over the page of webContents `pageId` (`show`), holding the page until it closes. */
export async function whileHoldingExclusiveAccess<T>(
  pageId: number,
  show: () => Promise<T>,
): Promise<T> {
  const release = holdExclusiveAccess(pageId);
  try {
    return await show();
  } finally {
    release();
  }
}

/**
 * Hold (or stop holding) every page the window renderer `hostId` hosts, while it shows a modal
 * over the whole window. A window either holds or doesn't: its renderer counts its modals.
 */
export function setWindowExclusiveAccessHold(hostId: number, held: boolean): void {
  if (!held) {
    windowHolds.delete(hostId);
    return;
  }
  windowHolds.add(hostId);
  for (const page of pagesOf(hostId)) exitExclusiveAccess(page);
}

/**
 * Whether a prompt holds the page of webContents `pageId`: it gets neither fullscreen nor pointer
 * lock until the prompt closes.
 */
export function exclusiveAccessHeld(pageId: number): boolean {
  if (pageHolds.has(pageId)) return true;
  const page = pages.get(pageId);
  const host = page && !page.isDestroyed() ? page.hostWebContents : null;
  return host !== null && windowHolds.has(host.id);
}

/** How long a window may take to enter fullscreen before deferred exits run anyway. */
export const ENTER_FULL_SCREEN_WAIT_MS = 2000;

/** Run `callback` after `ms`; returns the cancel. */
export type Schedule = (callback: () => void, ms: number) => () => void;

const scheduleTimeout: Schedule = (callback, ms) => {
  const timer = setTimeout(callback, ms);
  return () => clearTimeout(timer);
};

/**
 * A page of the window hosted by renderer `hostId` was granted fullscreen, in a window that was
 * fullscreen already or not (`windowWasFullScreen`). One that wasn't now animates into native
 * fullscreen for the page (on macOS), until its `enter-full-screen` or `leave-full-screen`, or
 * `ENTER_FULL_SCREEN_WAIT_MS` should neither come.
 */
export function noteFullscreenGranted(
  hostId: number,
  windowWasFullScreen: boolean,
  schedule: Schedule = scheduleTimeout,
): void {
  if (windowWasFullScreen) return;
  windowsEntering.get(hostId)?.();
  windowsEntering.set(
    hostId,
    schedule(() => windowSettled(hostId), ENTER_FULL_SCREEN_WAIT_MS),
  );
}

/**
 * The window hosted by renderer `hostId` finished entering or leaving fullscreen
 * (`enter-full-screen`, `leave-full-screen`): its pages' deferred exits run now.
 */
export function windowSettled(hostId: number): void {
  windowsEntering.get(hostId)?.();
  windowsEntering.delete(hostId);
  for (const page of pagesOf(hostId)) {
    if (!deferredExits.delete(page.id)) continue;
    // A prompt that closed meanwhile needs the screen no more.
    if (exclusiveAccessHeld(page.id)) exitExclusiveAccess(page);
  }
}

function pagesOf(hostId: number): HoldablePage[] {
  return [...pages.values()].filter(
    (page) => !page.isDestroyed() && page.hostWebContents?.id === hostId,
  );
}

/**
 * Does what the user's Esc does; nothing when the page holds neither. Not while the page's window
 * animates into fullscreen for it, on macOS: an exit then leaves the page fullscreen (Electron
 * reports it left, and the window ends up in native fullscreen), and a second call does nothing,
 * as Electron already counts the page out. So the exit waits for the window to settle
 * (`windowSettled`), the prompt showing meanwhile without waiting for it: the animation is short,
 * and the page can't take the screen again while held.
 */
function exitExclusiveAccess(page: HoldablePage): void {
  if (page.isDestroyed() || typeof page.exitExclusiveAccess !== "function") return;
  const host = page.hostWebContents;
  if (host && windowsEntering.has(host.id)) {
    deferredExits.add(page.id);
    return;
  }
  page.exitExclusiveAccess();
}
