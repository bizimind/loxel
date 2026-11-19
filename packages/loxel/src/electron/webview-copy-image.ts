/**
 * "Copy Image" for the browser panel's context menu. `<webview>` exposes no `copyImageAt`, so the
 * renderer asks the main process to call it on the webview's webContents.
 */
import { onAppWindowMessage } from "./app-windows";
import { hostedWebview } from "./hosted-webview";
import { COPY_WEBVIEW_IMAGE } from "./ipc-channels";

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function installWebviewCopyImage(): void {
  onAppWindowMessage(
    COPY_WEBVIEW_IMAGE,
    (event, webContentsId: unknown, x: unknown, y: unknown) => {
      if (!isFiniteNumber(x) || !isFiniteNumber(y)) return;
      const guest = hostedWebview(event.sender, webContentsId);
      if (!guest) return;
      // Window coordinates, as the webview's `context-menu` event reports them.
      guest.copyImageAt(x, y);
    },
  );
}
