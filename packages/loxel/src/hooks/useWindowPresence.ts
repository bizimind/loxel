import { useEffect } from "react";

import { wsClient } from "@/api/client";
import { WINDOW_ID } from "@/lib/window-id";

/**
 * Tell the server which window this is and whenever it gains focus, so requests such as
 * `loxel <folder>` reach the window whose terminal ran them — or, from an outside terminal, the
 * window the user last worked in.
 */
export function useWindowPresence(): void {
  useEffect(() => {
    const hello = () => wsClient.send({ type: "window_hello", windowId: WINDOW_ID });
    const report = () => wsClient.send({ type: "window_focused" });
    const reportIfFocused = () => {
      if (document.hasFocus()) report();
    };

    hello();
    reportIfFocused();
    const unsubReconnect = wsClient.onReconnect(() => {
      hello();
      reportIfFocused();
    });
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
