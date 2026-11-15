/**
 * Loxel's own windows, the ones `createWindow` opens: not browser panel popups. Their backgrounds
 * follow the theme, and a quit asks in one of them.
 */
import type { BrowserWindow } from "electron";

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
