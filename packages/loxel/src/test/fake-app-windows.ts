/**
 * Windows for main-process tests, so `isAppWindowSender` (`src/electron/app-windows.ts`) can tell
 * Loxel's windows from other senders. A test's `electron` mock answers
 * `BrowserWindow.fromWebContents` with {@link windowOf}, and its window renderers come from
 * {@link fakeWindow}.
 */
import type {
  BrowserWindow,
  IpcMainEvent,
  IpcMainInvokeEvent,
  WebContents,
  WebFrameMain,
} from "electron";

import { APP_ORIGIN } from "../electron/app-server";
import { registerAppWindow } from "../electron/app-windows";

const windows = new Map<WebContents, BrowserWindow>();

/** `BrowserWindow.fromWebContents` for an `electron` mock. */
export function windowOf(contents: WebContents): BrowserWindow | null {
  return windows.get(contents) ?? null;
}

/** A frame with `origin` loaded. */
export function fakeFrame(origin = APP_ORIGIN): WebFrameMain {
  return { origin, detached: false, processId: 1, routingId: 1 } as unknown as WebFrameMain;
}

/**
 * Make `contents` (its other members given) a window's own webContents, with the app's document in
 * its main frame unless it has one: one of Loxel's windows, or (`app: false`) a window that isn't,
 * such as a page's popup.
 */
export function fakeWindow<T extends object>(contents: T, { app = true } = {}): T & WebContents {
  const windowContents = {
    mainFrame: fakeFrame(),
    getType: () => "window",
    ...contents,
  } as unknown as T & WebContents;
  const win = { webContents: windowContents, on: () => win } as unknown as BrowserWindow;
  windows.set(windowContents, win);
  if (app) registerAppWindow(win);
  return windowContents;
}

/** An IPC message or invoke `sender` sends from its main frame. */
export function mainFrameEvent(sender: WebContents): IpcMainEvent & IpcMainInvokeEvent {
  return {
    sender,
    senderFrame: sender.mainFrame,
    returnValue: undefined,
  } as unknown as IpcMainEvent & IpcMainInvokeEvent;
}
