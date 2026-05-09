import { useEffect, useState } from "react";

/**
 * Tracks OS-level focus of the Electron BrowserWindow via main-process IPC.
 * Stays `true` when focus is inside a <webview> — unlike DOM `window.focus`/`blur`,
 * which fire when focus crosses into a guest webContents.
 */
export function useWindowFocused(): boolean {
  const [focused, setFocused] = useState(true);
  useEffect(() => {
    return window.electronAPI?.onWindowFocusChange(setFocused);
  }, []);
  return focused;
}
