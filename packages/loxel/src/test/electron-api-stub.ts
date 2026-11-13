type ElectronAPI = NonNullable<Window["electronAPI"]>;

/** A complete `window.electronAPI` that does nothing, with `overrides` for what a test watches. */
export function stubElectronAPI(overrides: Partial<ElectronAPI> = {}): ElectronAPI {
  return {
    onOpenInBrowserTab: () => () => {},
    setDockBadge: () => {},
    onWindowFocusChange: () => () => {},
    setThemeSource: () => {},
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
    onPasskeyQrCode: () => () => {},
    getUpdateStatus: async () => ({ state: "idle" }),
    checkForUpdates: async () => {},
    downloadUpdate: async () => {},
    installUpdate: () => {},
    onUpdateStatusChange: () => () => {},
    getDefaultBrowserStatus: async () => ({ isDefault: false, canSet: false }),
    setAsDefaultBrowser: async () => ({ isDefault: false, canSet: false }),
    ...overrides,
  };
}
