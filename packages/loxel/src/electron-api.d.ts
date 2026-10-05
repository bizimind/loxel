interface Window {
  electronAPI?: {
    onOpenInBrowserTab: (callback: (url: string) => void) => () => void;
    setDockBadge: (count: number) => void;
    onWindowFocusChange: (callback: (focused: boolean) => void) => () => void;
    openFolderDialog: () => Promise<string | null>;
    /**
     * Current page zoom factor (Cmd+/Cmd-), read synchronously from `webFrame`. Optional because
     * an in-app update can pair a newer renderer with an older app bundle's preload.
     */
    getZoomFactor?: () => number;
  };
  loxelWindow?: {
    /** Stable per-BrowserWindow ID assigned by Electron main; null in non-Electron contexts. */
    windowId: string | null;
    /** True if no other loxel windows were alive at this window's creation. */
    isFirstWindow: boolean;
  };
}
