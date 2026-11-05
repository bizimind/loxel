type ElectronAPI = NonNullable<Window["electronAPI"]>;

/** A complete `window.electronAPI` that does nothing, with `overrides` for what a test watches. */
export function stubElectronAPI(overrides: Partial<ElectronAPI> = {}): ElectronAPI {
  return {
    onOpenInBrowserTab: () => () => {},
    setDockBadge: () => {},
    onWindowFocusChange: () => () => {},
    openFolderDialog: async () => null,
    setKeystrokeInterception: () => {},
    onWebviewKeystroke: () => () => {},
    onWebviewFocused: () => () => {},
    onOpenInNewBrowserTab: () => () => {},
    macOSVersion: undefined,
    getZoomFactor: () => 1,
    isFullScreen: () => false,
    onWindowFullScreenChange: () => () => {},
    copyWebviewImage: () => {},
    onJavaScriptDialog: () => () => {},
    respondToJavaScriptDialog: () => {},
    getUpdateStatus: async () => ({ state: "idle" }),
    checkForUpdates: async () => {},
    downloadUpdate: async () => {},
    installUpdate: () => {},
    onUpdateStatusChange: () => () => {},
    ...overrides,
  };
}
