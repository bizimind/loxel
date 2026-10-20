/**
 * "Copy Image" for the browser panel's context menu. `<webview>` exposes no `copyImageAt`, so the
 * renderer asks the main process to call it on the webview's webContents.
 */
import { ipcMain, webContents } from "electron";

import { COPY_WEBVIEW_IMAGE } from "./ipc-channels";

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function installWebviewCopyImage(): void {
  ipcMain.on(COPY_WEBVIEW_IMAGE, (event, webContentsId: unknown, x: unknown, y: unknown) => {
    if (!isFiniteNumber(webContentsId) || !isFiniteNumber(x) || !isFiniteNumber(y)) return;
    const guest = webContents.fromId(webContentsId);
    // Only a window's own webviews: a renderer must not reach into another window's pages.
    if (guest?.getType() !== "webview" || guest.hostWebContents !== event.sender) return;
    // Window coordinates, as the webview's `context-menu` event reports them.
    guest.copyImageAt(x, y);
  });
}
