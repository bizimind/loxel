interface Window {
  electronAPI?: {
    onOpenInBrowserTab: (callback: (url: string) => void) => () => void;
    setDockBadge: (count: number) => void;
    onWindowFocusChange: (callback: (focused: boolean) => void) => () => void;
    openFolderDialog: () => Promise<string | null>;
    // The members below are optional: the preload ships in the .app bundle, while in-app updates
    // replace only the renderer and server, so a newer renderer can run with an older preload.
    // Guard every call (`?.()`) — an unguarded call throws on bundles that predate the member.
    /**
     * Keystrokes (KeyCombo strings) to withhold from this window's webviews and forward to it;
     * `captureAll` forwards every keystroke (a chord is in progress). Since v0.1.198.
     */
    setKeystrokeInterception?: (interception: { combos: string[]; captureAll: boolean }) => void;
    /** A forwarded keystroke (KeyCombo string) typed inside one of this window's webviews. Since v0.1.198. */
    onWebviewKeystroke?: (callback: (combo: unknown, isRepeat: unknown) => void) => () => void;
    /**
     * One of this window's webviews gained keyboard focus (fires no focusin in the document).
     * Since v0.1.199.
     */
    onWebviewFocused?: (callback: () => void) => () => void;
    /** Current page zoom factor (Cmd+/Cmd-), read synchronously from `webFrame`. */
    getZoomFactor?: () => number;
  };
  loxelWindow?: {
    /** Stable per-BrowserWindow ID assigned by Electron main; null in non-Electron contexts. */
    windowId: string | null;
    /** True if no other loxel windows were alive at this window's creation. */
    isFirstWindow: boolean;
  };
}
