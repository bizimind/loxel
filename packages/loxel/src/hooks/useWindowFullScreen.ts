import { useEffect, useState } from "react";

const isFullScreen = () => window.electronAPI?.isFullScreen() ?? false;

/**
 * Tracks whether the Electron BrowserWindow is in macOS native fullscreen, where the traffic
 * lights are hidden. The initial state is read synchronously, so a window that opens into a
 * fullscreen space renders right from the start. Always `false` outside Electron.
 */
export function useWindowFullScreen(): boolean {
  const [fullScreen, setFullScreen] = useState(isFullScreen);
  useEffect(() => {
    const unsubscribe = window.electronAPI?.onWindowFullScreenChange(setFullScreen);
    // Catch a change that landed between the initial read and subscribing.
    setFullScreen(isFullScreen());
    return unsubscribe;
  }, []);
  return fullScreen;
}
