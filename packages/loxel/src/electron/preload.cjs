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
const BROWSER_PAGE_USAGE = "browser:page-usage";
const BROWSER_PAGE_SET_FROZEN = "browser:page-set-frozen";
const BROWSER_FAVICON_LOAD = "browser:favicon-load";
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
const APP_QUIT_KEEPING_TERMINALS = "app:quit-keeping-terminals";
const APP_RESTART = "app:restart";
const BROWSER_NOTIFICATION_LISTEN = "browser-notification:listen";
const BROWSER_NOTIFICATION_SET_SITES = "browser-notification:set-sites";
const BROWSER_NOTIFICATION_SET_MUTES = "browser-notification:set-mutes";
const BROWSER_NOTIFICATION_OPENED = "browser-notification:opened";
const BROWSER_NOTIFICATION_PERMISSION_REQUEST = "browser-notification:permission-request";
const BROWSER_NOTIFICATION_PERMISSION_RESPOND = "browser-notification:permission-respond";
const BROWSER_NOTIFICATION_PERMISSION_WITHDRAWN = "browser-notification:permission-withdrawn";
const BROWSER_NOTIFICATION_CLICK = "browser-notification:click";
const APP_QUIT_ENDING_TERMINALS = "app:quit-ending-terminals";
const SET_WHEN_QUITTING = "quit:set-when-quitting";
const QUIT_QUESTION = "quit:question";
const QUIT_QUESTION_WITHDRAWN = "quit:question-withdrawn";
const QUIT_QUESTION_SHOWN = "quit:question-shown";
const QUIT_ANSWER = "quit:answer";

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
  getBrowserPageUsage: (webContentsIds) => ipcRenderer.invoke(BROWSER_PAGE_USAGE, webContentsIds),
  setBrowserPageFrozen: (webContentsId, frozen) =>
    ipcRenderer.invoke(BROWSER_PAGE_SET_FROZEN, webContentsId, frozen),
  loadFavicon: (url, pageUrl, webContentsId) =>
    ipcRenderer.invoke(BROWSER_FAVICON_LOAD, url, pageUrl, webContentsId),
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
  quitKeepingTerminals: () => ipcRenderer.send(APP_QUIT_KEEPING_TERMINALS),
  restartApp: () => ipcRenderer.send(APP_RESTART),
  onBrowserNotifications: (handlers) => {
    const subscriptions = [
      [BROWSER_NOTIFICATION_OPENED, (_event, notification) => handlers.onOpened(notification)],
      [
        BROWSER_NOTIFICATION_PERMISSION_REQUEST,
        (_event, request) => handlers.onPermissionRequest(request),
      ],
      [
        BROWSER_NOTIFICATION_PERMISSION_WITHDRAWN,
        (_event, withdrawn) => handlers.onPermissionWithdrawn(withdrawn),
      ],
    ];
    for (const [channel, handler] of subscriptions) ipcRenderer.on(channel, handler);
    ipcRenderer.send(BROWSER_NOTIFICATION_LISTEN);
    return () => {
      for (const [channel, handler] of subscriptions) ipcRenderer.removeListener(channel, handler);
    };
  },
  setNotificationSites: (sites) => ipcRenderer.send(BROWSER_NOTIFICATION_SET_SITES, sites),
  setNotificationMutes: (mutes) => ipcRenderer.send(BROWSER_NOTIFICATION_SET_MUTES, mutes),
  respondToNotificationPermission: (response) =>
    ipcRenderer.send(BROWSER_NOTIFICATION_PERMISSION_RESPOND, response),
  clickBrowserNotification: (ref) => ipcRenderer.send(BROWSER_NOTIFICATION_CLICK, ref),
  quitEndingTerminals: () => ipcRenderer.send(APP_QUIT_ENDING_TERMINALS),
  setWhenQuitting: (setting) => ipcRenderer.send(SET_WHEN_QUITTING, setting),
  onQuitQuestion: (callback) => {
    const handler = (_event, question) => callback(question);
    ipcRenderer.on(QUIT_QUESTION, handler);
    return () => ipcRenderer.removeListener(QUIT_QUESTION, handler);
  },
  onQuitQuestionWithdrawn: (callback) => {
    const handler = (_event, id) => callback(id);
    ipcRenderer.on(QUIT_QUESTION_WITHDRAWN, handler);
    return () => ipcRenderer.removeListener(QUIT_QUESTION_WITHDRAWN, handler);
  },
  quitQuestionShown: (id) => ipcRenderer.send(QUIT_QUESTION_SHOWN, id),
  answerQuitQuestion: (reply) => ipcRenderer.send(QUIT_ANSWER, reply),
});
