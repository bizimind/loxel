interface Window {
  electronAPI?: {
    onOpenInBrowserTab: (callback: (url: string) => void) => () => void;
    setDockBadge: (count: number) => void;
    onWindowFocusChange: (callback: (focused: boolean) => void) => () => void;
    openFolderDialog: () => Promise<string | null>;
    /**
     * Keystrokes (KeyCombo strings) to withhold from this window's webviews and forward to it;
     * `captureAll` forwards every keystroke (a chord is in progress).
     */
    setKeystrokeInterception: (interception: { combos: string[]; captureAll: boolean }) => void;
    /** A forwarded keystroke (KeyCombo string) typed inside one of this window's webviews. */
    onWebviewKeystroke: (callback: (combo: unknown, isRepeat: unknown) => void) => () => void;
  };
  loxelWindow?: {
    /** Stable per-BrowserWindow ID assigned by Electron main; null in non-Electron contexts. */
    windowId: string | null;
    /** True if no other loxel windows were alive at this window's creation. */
    isFirstWindow: boolean;
  };
}
