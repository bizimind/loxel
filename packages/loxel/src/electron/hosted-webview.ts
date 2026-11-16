import { type WebContents, webContents } from "electron";

/**
 * The webview with webContents id `id`, if the window `host` hosts it. Only a window's own
 * webviews: a renderer must not reach into another window's pages.
 */
export function hostedWebview(host: WebContents, id: unknown): WebContents | null {
  if (typeof id !== "number" || !Number.isInteger(id)) return null;
  const guest = webContents.fromId(id);
  return guest?.getType() === "webview" && guest.hostWebContents === host ? guest : null;
}
