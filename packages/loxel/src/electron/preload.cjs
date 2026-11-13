// Preload script — must be CJS (sandboxed Electron renderers cannot use ESM imports).
// Channel names must match constants in ipc-channels.ts.
const { contextBridge, ipcRenderer, webFrame } = require("electron");

const OPEN_IN_BROWSER_TAB = "open-in-browser-tab";
const OPEN_IN_NEW_BROWSER_TAB = "browser:open-in-new-tab";
const SET_DOCK_BADGE = "set-dock-badge";
const WINDOW_FOCUS_CHANGE = "window:focus-change";
const WINDOW_FULL_SCREEN_CHANGE = "window:full-screen-change";
const GET_WINDOW_FULL_SCREEN = "window:get-full-screen";
const SET_THEME_SOURCE = "theme:set-source";
const SET_KEYSTROKE_INTERCEPTION = "keybindings:set-interception";
const WEBVIEW_KEYSTROKE = "keybindings:webview-keystroke";
const WEBVIEW_FOCUSED = "keybindings:webview-focused";
const COPY_WEBVIEW_IMAGE = "browser:copy-image-at";
const JAVASCRIPT_DIALOG_LISTEN = "javascript-dialog:listen";
const JAVASCRIPT_DIALOG_OPEN = "javascript-dialog:open";
const JAVASCRIPT_DIALOG_RESPOND = "javascript-dialog:respond";
const JAVASCRIPT_DIALOG_CLOSED = "javascript-dialog:closed";
const UPDATE_GET_STATUS = "update:get-status";
const PASSKEY_QR_SHOW = "passkey:qr-show";
const PASSKEY_QR_HIDE = "passkey:qr-hide";
const UPDATE_CHECK = "update:check";
const UPDATE_DOWNLOAD = "update:download";
const UPDATE_INSTALL = "update:install";
const UPDATE_STATUS_CHANGED = "update:status-changed";
const DEFAULT_BROWSER_GET = "default-browser:get";
const DEFAULT_BROWSER_SET = "default-browser:set";

// Per-window identity assigned by main when this BrowserWindow was created.
// Stable across renderer reloads (Cmd+R) — different per BrowserWindow.
function readArg(prefix) {
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}
const windowId = readArg("--loxel-window-id=");
const isFirstWindow = readArg("--loxel-is-first-window=") === "1";

contextBridge.exposeInMainWorld("loxelWindow", { windowId, isFirstWindow });

contextBridge.exposeInMainWorld("electronAPI", {
  onOpenInBrowserTab: (callback) => {
    const handler = (_event, url) => callback(url);
    ipcRenderer.on(OPEN_IN_BROWSER_TAB, handler);
    return () => ipcRenderer.removeListener(OPEN_IN_BROWSER_TAB, handler);
  },
  onOpenInNewBrowserTab: (callback) => {
    const handler = (_event, webContentsId, url, background) =>
      callback(webContentsId, url, background);
    ipcRenderer.on(OPEN_IN_NEW_BROWSER_TAB, handler);
    return () => ipcRenderer.removeListener(OPEN_IN_NEW_BROWSER_TAB, handler);
  },
  macOSVersion: process.platform === "darwin" ? process.getSystemVersion() : undefined,
  setDockBadge: (count) => ipcRenderer.send(SET_DOCK_BADGE, count),
  onWindowFocusChange: (callback) => {
    const handler = (_event, focused) => callback(focused);
    ipcRenderer.on(WINDOW_FOCUS_CHANGE, handler);
    return () => ipcRenderer.removeListener(WINDOW_FOCUS_CHANGE, handler);
  },
  isFullScreen: () => ipcRenderer.sendSync(GET_WINDOW_FULL_SCREEN),
  onWindowFullScreenChange: (callback) => {
    const handler = (_event, fullScreen) => callback(fullScreen);
    ipcRenderer.on(WINDOW_FULL_SCREEN_CHANGE, handler);
    return () => ipcRenderer.removeListener(WINDOW_FULL_SCREEN_CHANGE, handler);
  },
  setThemeSource: (theme) => ipcRenderer.send(SET_THEME_SOURCE, theme),
  setKeystrokeInterception: (interception) =>
    ipcRenderer.send(SET_KEYSTROKE_INTERCEPTION, interception),
  onWebviewKeystroke: (callback) => {
    const handler = (_event, combo, isRepeat) => callback(combo, isRepeat);
    ipcRenderer.on(WEBVIEW_KEYSTROKE, handler);
    return () => ipcRenderer.removeListener(WEBVIEW_KEYSTROKE, handler);
  },
  onWebviewFocused: (callback) => {
    const handler = () => callback();
    ipcRenderer.on(WEBVIEW_FOCUSED, handler);
    return () => ipcRenderer.removeListener(WEBVIEW_FOCUSED, handler);
  },
  getZoomFactor: () => webFrame.getZoomFactor(),
  copyWebviewImage: (webContentsId, x, y) =>
    ipcRenderer.send(COPY_WEBVIEW_IMAGE, webContentsId, x, y),
  onJavaScriptDialog: (onOpen, onClosed) => {
    const openHandler = (_event, request) => onOpen(request);
    const closedHandler = (_event, closed) => onClosed(closed);
    ipcRenderer.on(JAVASCRIPT_DIALOG_OPEN, openHandler);
    ipcRenderer.on(JAVASCRIPT_DIALOG_CLOSED, closedHandler);
    ipcRenderer.send(JAVASCRIPT_DIALOG_LISTEN);
    return () => {
      ipcRenderer.removeListener(JAVASCRIPT_DIALOG_OPEN, openHandler);
      ipcRenderer.removeListener(JAVASCRIPT_DIALOG_CLOSED, closedHandler);
    };
  },
  respondToJavaScriptDialog: (response) => ipcRenderer.send(JAVASCRIPT_DIALOG_RESPOND, response),
  onPasskeyQrCode: (onShow, onHide) => {
    const show = (_event, request) => onShow(request);
    const hide = (_event, webContentsId) => onHide(webContentsId);
    ipcRenderer.on(PASSKEY_QR_SHOW, show);
    ipcRenderer.on(PASSKEY_QR_HIDE, hide);
    return () => {
      ipcRenderer.removeListener(PASSKEY_QR_SHOW, show);
      ipcRenderer.removeListener(PASSKEY_QR_HIDE, hide);
    };
  },
  getUpdateStatus: () => ipcRenderer.invoke(UPDATE_GET_STATUS),
  checkForUpdates: () => ipcRenderer.invoke(UPDATE_CHECK),
  downloadUpdate: () => ipcRenderer.invoke(UPDATE_DOWNLOAD),
  installUpdate: () => ipcRenderer.send(UPDATE_INSTALL),
  onUpdateStatusChange: (callback) => {
    const handler = (_event, status) => callback(status);
    ipcRenderer.on(UPDATE_STATUS_CHANGED, handler);
    return () => ipcRenderer.removeListener(UPDATE_STATUS_CHANGED, handler);
  },
  getDefaultBrowserStatus: () => ipcRenderer.invoke(DEFAULT_BROWSER_GET),
  setAsDefaultBrowser: () => ipcRenderer.invoke(DEFAULT_BROWSER_SET),
});
