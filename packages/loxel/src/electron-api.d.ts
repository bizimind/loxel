interface Window {
  /**
   * Native integrations, from Electron's window preload; undefined outside Electron. The preload
   * and the renderer ship together in the app, so every member exists whenever this does.
   */
  electronAPI?: {
    onOpenInBrowserTab: (callback: (url: string) => void) => () => void;
    setDockBadge: (count: number) => void;
    onWindowFocusChange: (callback: (focused: boolean) => void) => () => void;
    openFolderDialog: () => Promise<string | null>;
    /**
     * Apply the Theme setting to Electron's `nativeTheme`, so native menus and dialogs, browser
     * panels' `prefers-color-scheme` and window backgrounds follow it ("system": the OS).
     */
    setThemeSource: (theme: import("@/lib/theme-preference").ThemePreference) => void;
    /**
     * Keystrokes (KeyCombo strings) to withhold from this window's webviews and forward to it;
     * `captureAll` forwards every keystroke (a chord is in progress).
     */
    setKeystrokeInterception: (interception: { combos: string[]; captureAll: boolean }) => void;
    /** A forwarded keystroke (KeyCombo string) typed inside one of this window's webviews. */
    onWebviewKeystroke: (callback: (combo: unknown, isRepeat: unknown) => void) => () => void;
    /** One of this window's webviews gained keyboard focus (fires no focusin in the document). */
    onWebviewFocused: (callback: () => void) => () => void;
    /**
     * A page in one of this window's webviews (identified by its webContents id) asked to open
     * `url` in a new tab or window; `background` for ⌘-click and middle-click.
     */
    onOpenInNewBrowserTab: (
      callback: (webContentsId: number, url: string, background: boolean) => void,
    ) => () => void;
    /** macOS version (e.g. "15.2.0"); undefined on other platforms. */
    macOSVersion: string | undefined;
    /** Current page zoom factor (Cmd+/Cmd-), read synchronously from `webFrame`. */
    getZoomFactor: () => number;
    /** Whether this window is in macOS native fullscreen, read synchronously. */
    isFullScreen: () => boolean;
    /** The window entered or left macOS native fullscreen. */
    onWindowFullScreenChange: (callback: (fullScreen: boolean) => void) => () => void;
    /**
     * Copy the image at window point (x, y) of one of this window's webviews to the clipboard;
     * the point is in the coordinates of the webview's `context-menu` event.
     */
    copyWebviewImage: (webContentsId: number, x: number, y: number) => void;
    /**
     * A browser panel page called `alert()` / `confirm()` / `prompt()` (payload:
     * `JavaScriptDialogRequest`), or a shown one was withdrawn (`JavaScriptDialogClosed`).
     */
    onJavaScriptDialog: (
      onOpen: (request: unknown) => void,
      onClosed: (closed: unknown) => void,
    ) => () => void;
    /** Answer a dialog from `onJavaScriptDialog` (payload: `JavaScriptDialogResponse`). */
    respondToJavaScriptDialog: (response: unknown) => void;
    /**
     * Passkey QR codes for this window's browser panels: `onShow` gets a `PasskeyQrCode` payload,
     * `onHide` the webContents ID whose request ended. Returns an unsubscribe function.
     */
    onPasskeyQrCode: (
      onShow: (request: unknown) => void,
      onHide: (webContentsId: unknown) => void,
    ) => () => void;
    /** The app update's current state, kept by Electron main. */
    getUpdateStatus: () => Promise<import("@/api/update-model").UpdateState>;
    /** Check the release manifest for a newer version; the result arrives as a status change. */
    checkForUpdates: () => Promise<void>;
    /** Download the available update; progress and the result arrive as status changes. */
    downloadUpdate: () => Promise<void>;
    /** Quit, install the downloaded update and relaunch. */
    installUpdate: () => void;
    /** The app update's state changed. */
    onUpdateStatusChange: (
      callback: (status: import("@/api/update-model").UpdateState) => void,
    ) => () => void;
  };
  loxelWindow?: {
    /** Stable per-BrowserWindow ID assigned by Electron main; null in non-Electron contexts. */
    windowId: string | null;
    /** True if no other loxel windows were alive at this window's creation. */
    isFirstWindow: boolean;
  };
}
