import type { IpcMainEvent, IpcMainInvokeEvent, WebFrameMain } from "electron";

/**
 * The frame a page channel's message comes from, when it is a browser panel page's (a webview
 * guest's, not a popup window's or Loxel's own) and still attached. Page channels decide by this
 * frame, never by what the page says about itself.
 */
export function webviewSenderFrame({
  sender,
  senderFrame,
}: IpcMainEvent | IpcMainInvokeEvent): WebFrameMain | null {
  if (sender.getType() !== "webview" || !senderFrame || senderFrame.detached) return null;
  return senderFrame;
}
