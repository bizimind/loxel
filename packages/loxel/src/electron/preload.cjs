// Preload script — must be CJS (sandboxed Electron renderers cannot use ESM imports).
// Channel names must match constants in ipc-channels.ts.
const { contextBridge, ipcRenderer } = require("electron");

const OPEN_IN_BROWSER_TAB = "open-in-browser-tab";
const SET_DOCK_BADGE = "set-dock-badge";
const WINDOW_FOCUS_CHANGE = "window:focus-change";
const OPEN_FOLDER_DIALOG = "dialog:open-folder";

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
  setDockBadge: (count) => ipcRenderer.send(SET_DOCK_BADGE, count),
  onWindowFocusChange: (callback) => {
    const handler = (_event, focused) => callback(focused);
    ipcRenderer.on(WINDOW_FOCUS_CHANGE, handler);
    return () => ipcRenderer.removeListener(WINDOW_FOCUS_CHANGE, handler);
  },
  openFolderDialog: () => ipcRenderer.invoke(OPEN_FOLDER_DIALOG),
});
