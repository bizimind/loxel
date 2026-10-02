import { useEffect } from "react";

import { wsClient } from "@/api/client";

/**
 * Tell the server whenever this window gains focus, so requests that name no window (such as
 * `loxel <folder>` run in an outside terminal) reach the window the user last worked in.
 */
export function useReportWindowFocus(): void {
  useEffect(() => {
    const report = () => wsClient.send({ type: "window_focused" });
    const reportIfFocused = () => {
      if (document.hasFocus()) report();
    };

    reportIfFocused();
    const unsubReconnect = wsClient.onReconnect(reportIfFocused);
    // Electron reports BrowserWindow focus, which DOM focus misses when a <webview> has it.
    const unsubElectron = window.electronAPI?.onWindowFocusChange((focused) => {
      if (focused) report();
    });
    window.addEventListener("focus", report);
    return () => {
      unsubReconnect();
      unsubElectron?.();
      window.removeEventListener("focus", report);
    };
  }, []);
}
