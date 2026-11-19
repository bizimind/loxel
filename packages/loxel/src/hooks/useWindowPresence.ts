import { useEffect } from "react";

import type { WsClient } from "@/api/client";
import { connections } from "@/api/server-connection";
import { WINDOW_ID } from "@/lib/window-id";

/**
 * Tell the server which window this is and whenever it gains focus, so requests such as
 * `loxel <folder>` reach the window whose terminal ran them — or, from an outside terminal, the
 * window the user last worked in.
 */
export function useWindowPresence(): void {
  useEffect(() => {
    // Every server the window is connected to opens what it is asked in this window, so each one
    // is told which window this is.
    const sockets = connections().map((connection) => connection.ws);
    const hello = (ws: WsClient) => ws.send({ type: "window_hello", windowId: WINDOW_ID });
    const report = () => {
      for (const ws of sockets) ws.send({ type: "window_focused" });
    };
    const reportIfFocused = () => {
      if (document.hasFocus()) report();
    };

    for (const ws of sockets) hello(ws);
    reportIfFocused();
    const reconnects = sockets.map((ws) =>
      ws.onReconnect(() => {
        hello(ws);
        if (document.hasFocus()) ws.send({ type: "window_focused" });
      }),
    );
    // Electron reports BrowserWindow focus, which DOM focus misses when a <webview> has it.
    const unsubElectron = window.electronAPI?.onWindowFocusChange((focused) => {
      if (focused) report();
    });
    window.addEventListener("focus", report);
    return () => {
      for (const unsubscribe of reconnects) unsubscribe();
      unsubElectron?.();
      window.removeEventListener("focus", report);
    };
  }, []);
}
