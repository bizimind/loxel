import { describe, expect, mock, test } from "bun:test";

import { stubElectronAPI } from "@/test/electron-api-stub";

import {
  DEFAULT_BROWSER_GET,
  DEFAULT_BROWSER_SET,
  APP_QUIT_KEEPING_TERMINALS,
  APP_RESTART,
  SET_THEME_SOURCE,
  UPDATE_CHECK,
  UPDATE_DOWNLOAD,
  UPDATE_GET_STATUS,
  UPDATE_INSTALL,
  UPDATE_STATUS_CHANGED,
} from "./ipc-channels";

type Listener = (event: unknown, ...args: unknown[]) => void;

const exposed = new Map<string, unknown>();
const ipcRenderer = {
  invoke: mock(async (_channel: string) => undefined),
  send: mock((_channel: string) => {}),
  sendSync: mock((_channel: string) => false),
  on: mock((_channel: string, _listener: Listener) => {}),
  removeListener: mock((_channel: string, _listener: Listener) => {}),
};
void mock.module("electron", () => ({
  contextBridge: { exposeInMainWorld: (key: string, api: unknown) => exposed.set(key, api) },
  ipcRenderer,
  webFrame: { getZoomFactor: () => 1 },
}));
// Electron's process has it; the preload reads it on macOS.
Object.assign(process, { getSystemVersion: () => "15.0.0" });
await import("./preload.cjs");

const api = exposed.get("electronAPI") as NonNullable<Window["electronAPI"]>;

describe("window preload", () => {
  test("exposes every member of the renderer's electronAPI type", () => {
    expect(Object.keys(api).toSorted()).toEqual(Object.keys(stubElectronAPI()).toSorted());
  });

  test("sends update requests on the update channels", async () => {
    await api.getUpdateStatus();
    await api.checkForUpdates();
    await api.downloadUpdate();
    expect(ipcRenderer.invoke.mock.calls.map(([channel]) => channel)).toEqual([
      UPDATE_GET_STATUS,
      UPDATE_CHECK,
      UPDATE_DOWNLOAD,
    ]);
    api.installUpdate();
    expect(ipcRenderer.send).toHaveBeenLastCalledWith(UPDATE_INSTALL);
  });

  test("asks about the default browser on its channels", async () => {
    ipcRenderer.invoke.mockClear();
    await api.getDefaultBrowserStatus();
    await api.setAsDefaultBrowser();
    expect(ipcRenderer.invoke.mock.calls.map(([channel]) => channel)).toEqual([
      DEFAULT_BROWSER_GET,
      DEFAULT_BROWSER_SET,
    ]);
  });

  test("delivers update status changes until unsubscribed", () => {
    const callback = mock((_status: unknown) => {});
    const unsubscribe = api.onUpdateStatusChange(callback);
    const [channel, listener] = ipcRenderer.on.mock.lastCall ?? [];
    expect(channel).toBe(UPDATE_STATUS_CHANGED);
    listener?.({}, { state: "checking" });
    expect(callback).toHaveBeenCalledWith({ state: "checking" });
    unsubscribe();
    expect(ipcRenderer.removeListener).toHaveBeenLastCalledWith(UPDATE_STATUS_CHANGED, listener);
  });

  test("sends Quit and Keep Terminals and Restart Loxel on their channels", () => {
    api.quitKeepingTerminals();
    expect(ipcRenderer.send).toHaveBeenLastCalledWith(APP_QUIT_KEEPING_TERMINALS);
    api.restartApp();
    expect(ipcRenderer.send).toHaveBeenLastCalledWith(APP_RESTART);
  });

  test("sends the theme setting on its channel", () => {
    api.setThemeSource("light");
    expect(ipcRenderer.send).toHaveBeenLastCalledWith(SET_THEME_SOURCE, "light");
  });
});
