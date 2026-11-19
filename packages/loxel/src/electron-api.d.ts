interface Window {
  /**
   * Native integrations, from Electron's window preload; undefined outside Electron. The preload
   * and the renderer ship together in the app, so every member exists whenever this does.
   */
  electronAPI?: {
    onOpenInBrowserTab: (callback: (url: string) => void) => () => void;
    setDockBadge: (count: number) => void;
    onWindowFocusChange: (callback: (focused: boolean) => void) => () => void;
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
    /** Memory and CPU of this window's webviews by webContents id, and the machine's memory. */
    getBrowserPageUsage: (
      webContentsIds: number[],
    ) => Promise<import("@/electron/browser-page-protocol").BrowserPagesUsage>;
    /**
     * Freeze one of this window's hidden webviews (tasks and timers stop), or resume it. Resolves
     * whether it is now in that state.
     */
    setBrowserPageFrozen: (webContentsId: number, frozen: boolean) => Promise<boolean>;
    /**
     * A browser page's favicon as a `data:` URL, or null if it is no image or can't be loaded.
     * It loads through the browser panels' session, with cookies only if it has the origin of
     * `pageUrl`, the page it is shown for. A `blob:` favicon is read in the page of webview
     * `webContentsId`, which must be one of this window's.
     */
    loadFavicon: (
      url: string,
      pageUrl: string | undefined,
      webContentsId?: number,
    ) => Promise<string | null>;
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
    /**
     * Fullscreen and pointer lock notices for this window's browser panels: `onShow` gets an
     * `ExclusiveAccessNotice` payload, `onHide` the webContents ID whose page left fullscreen.
     * Returns an unsubscribe function.
     */
    onExclusiveAccessNotice: (
      onShow: (notice: unknown) => void,
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
    /** Whether Loxel is the default web browser, and whether this build can become it. */
    getDefaultBrowserStatus: () => Promise<
      import("@/api/default-browser-model").DefaultBrowserStatus
    >;
    /**
     * Ask macOS to make Loxel the default web browser. macOS confirms with its own prompt, so the
     * status returned may not show the user's answer yet.
     */
    setAsDefaultBrowser: () => Promise<import("@/api/default-browser-model").DefaultBrowserStatus>;
    /** Quit, leaving the terminals running for the next launch to reattach. */
    quitKeepingTerminals: () => void;
    /** Quit, leaving the terminals running, and open the app again. */
    restartApp: () => void;
    /**
     * Browser panel pages' web notifications: one was shown (payload: `BrowserNotification`), a
     * site asks to show them (`NotificationPermissionRequest`), or such a request was withdrawn
     * (`{ id, webContentsId }`). Subscribing tells main this
     * document handles them.
     */
    onBrowserNotifications: (handlers: {
      onOpened: (notification: unknown) => void;
      onPermissionRequest: (request: unknown) => void;
      onPermissionWithdrawn: (withdrawn: unknown) => void;
    }) => () => void;
    /** The per-site notification decisions from settings (payload: `NotificationSites`). */
    setNotificationSites: (sites: unknown) => void;
    /** The per-site mutes and snoozes from settings (payload: `NotificationMutes`). */
    setNotificationMutes: (mutes: unknown) => void;
    /** Answer a permission request (payload: `NotificationPermissionResponse`). */
    respondToNotificationPermission: (response: unknown) => void;
    /** The user clicked a page's notification in the notification center (payload: `{ ref }`). */
    clickBrowserNotification: (ref: unknown) => void;
    /**
     * Browser panel pages' camera and microphone: a site asks to use them
     * (`MediaPermissionRequest`), such a request was withdrawn (`{ id, webContentsId }`, also when
     * main asks again under a new id), or an allowed site was refused because macOS has Loxel's
     * access off (`MediaSystemBlocked`). Subscribing tells main this document asks.
     */
    onBrowserMediaPermissions: (handlers: {
      onRequest: (request: unknown) => void;
      onWithdrawn: (withdrawn: unknown) => void;
      onSystemBlocked: (notice: unknown) => void;
    }) => () => void;
    /** The per-site camera and microphone decisions from settings (payload: `MediaSites`). */
    setMediaSites: (sites: unknown) => void;
    /** Answer a camera or microphone request (payload: `MediaPermissionResponse`). */
    respondToMediaPermission: (response: unknown) => void;
    /** Open the OS privacy settings for `device` (`MediaDevice`), where Loxel's access is turned on. */
    openMediaSystemSettings: (device: unknown) => void;
    /** Quit, ending the terminals, without asking. */
    quitEndingTerminals: () => void;
    /** Tell main the "When quitting Loxel" setting, which Quit Loxel and the app menu follow. */
    setWhenQuitting: (setting: import("@/lib/quit-terminals").WhenQuitting) => void;
    /**
     * Main asks before quitting, terminals being busy: `question` is a `QuitQuestion`, unparsed.
     * The renderer reports it shown with `quitQuestionShown`, then the answer.
     */
    onQuitQuestion: (callback: (question: unknown) => void) => () => void;
    /** Main no longer waits on the quit question with this ID: take it down. */
    onQuitQuestionWithdrawn: (callback: (id: unknown) => void) => () => void;
    /** The quit question with this ID is on screen. */
    quitQuestionShown: (id: number) => void;
    /** The user's answer to a quit question. */
    answerQuitQuestion: (reply: import("@/lib/quit-terminals").QuitReply) => void;
  };
  loxelWindow?: {
    /** Stable per-BrowserWindow ID assigned by Electron main; null in non-Electron contexts. */
    windowId: string | null;
    /** True if no other loxel windows were alive at this window's creation. */
    isFirstWindow: boolean;
  };
}
