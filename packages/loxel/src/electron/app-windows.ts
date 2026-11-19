/**
 * Loxel's own windows, the ones `createWindow` opens: not browser panel popups. Their backgrounds
 * follow the theme, a quit asks in one of them, and only they may send the app's IPC channels.
 */
import { BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent, ipcMain } from "electron";

import { APP_ORIGIN } from "./app-server";

const appWindows = new Set<BrowserWindow>();

/** Count `win` as one of Loxel's windows for as long as it lives. */
export function registerAppWindow(win: BrowserWindow): void {
  appWindows.add(win);
  win.on("closed", () => appWindows.delete(win));
}

export function appWindowList(): BrowserWindow[] {
  return [...appWindows];
}

export function isAppWindow(win: BrowserWindow): boolean {
  return appWindows.has(win);
}

/**
 * Whether an IPC message comes from one of Loxel's windows: from the window's own webContents (not
 * a webview's, nor a page's popup, which is a window too), from its main frame (not an iframe), with
 * the app's document loaded. Like Chrome's browser process, main trusts no other renderer: browser
 * panels' pages and their popups run in renderers of their own, which a page could compromise.
 */
export function isAppWindowSender({
  sender,
  senderFrame,
}: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const win = BrowserWindow.fromWebContents(sender);
  if (!win || win.webContents !== sender || !isAppWindow(win)) return false;
  return senderFrame === sender.mainFrame && senderFrame.origin === APP_ORIGIN;
}

/** Channels a sender that isn't a Loxel window has used, each logged once. */
const refusedChannels = new Set<string>();

function logRefused(channel: string): void {
  if (refusedChannels.has(channel)) return;
  refusedChannels.add(channel);
  console.warn(`[electron] Ignored ${channel} from a renderer that is not a Loxel window`);
}

/**
 * Listen on a channel only Loxel's windows send (`isAppWindowSender`); other senders' messages are
 * dropped. A dropped synchronous message is answered with `undefined`, so its sender doesn't hang.
 * App-only channels register through this or {@link handleAppWindowInvoke}, never on `ipcMain`
 * directly (`app-windows.test.ts` holds the few exceptions).
 */
export function onAppWindowMessage(
  channel: string,
  listener: (event: IpcMainEvent, ...args: unknown[]) => void,
): void {
  ipcMain.on(channel, (event, ...args: unknown[]) => {
    if (isAppWindowSender(event)) {
      listener(event, ...args);
      return;
    }
    logRefused(channel);
    event.returnValue = undefined;
  });
}

/**
 * Answer invokes on a channel only Loxel's windows send (`isAppWindowSender`); other senders' are
 * rejected.
 */
export function handleAppWindowInvoke(
  channel: string,
  handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
): void {
  ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    if (isAppWindowSender(event)) return handler(event, ...args);
    logRefused(channel);
    throw new Error(`${channel} is only answered for Loxel's windows`);
  });
}
