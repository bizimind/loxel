import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { IpcMainEvent, Session, WebContents } from "electron";

import { BROWSER_INCOGNITO_TABS } from "./ipc-channels";

type Handler = (event: IpcMainEvent, ...args: unknown[]) => void;
const ipcHandlers = new Map<string, Handler>();

interface FakeSession {
  partition: string;
  preloads: { type: string; filePath: string }[];
  cleared: string[];
}
const sessions: FakeSession[] = [];
const fakeSession = (partition: string): FakeSession => {
  const cleared: string[] = [];
  const done = (what: string) => async () => {
    cleared.push(what);
  };
  const created = {
    partition,
    preloads: [] as FakeSession["preloads"],
    cleared,
    registerPreloadScript: (preload: { type: string; filePath: string }) =>
      created.preloads.push(preload),
    clearStorageData: done("storage"),
    clearCache: done("cache"),
    clearAuthCache: done("auth"),
    closeAllConnections: done("connections"),
  };
  sessions.push(created);
  return created;
};

/** Popup windows open in the sessions, and the ones destroyed. */
const popups: { contents: WebContents; destroyed: boolean }[] = [];
void mock.module("electron", () => ({
  ipcMain: { on: (channel: string, handler: Handler) => ipcHandlers.set(channel, handler) },
  session: { fromPartition: fakeSession },
  webContents: { getAllWebContents: () => popups.map((p) => p.contents) },
  BrowserWindow: {
    fromWebContents: (contents: WebContents) => {
      const popup = popups.find((p) => p.contents === contents);
      if (popup) {
        return {
          destroy: () => {
            popup.destroyed = true;
          },
        };
      }
      return windowOf(contents);
    },
  },
}));

const { fakeWindow, mainFrameEvent, windowOf } = await import("../test/fake-app-windows");
const { fakeEmitter } = await import("../test/fake-browser-panels");
const { isIncognitoSession } = await import("./browser-partition");
const { currentIncognitoSession, incognitoPartition, installIncognitoSessions } =
  await import("./incognito-session");

const setUp: Session[] = [];
installIncognitoSessions((created) => setUp.push(created));

let nextId = 1000;
/** One of Loxel's windows, whose document can be replaced or closed. */
function appWindow() {
  const emitter = fakeEmitter();
  const contents = fakeWindow({ id: nextId++, ...emitter });
  const report = (hasTabs: unknown) =>
    ipcHandlers.get(BROWSER_INCOGNITO_TABS)!(mainFrameEvent(contents), hasTabs);
  return { contents, report, emit: emitter.emit };
}

const sessionOf = (partition: string) => sessions.find((s) => s.partition === partition)!;

beforeEach(() => {
  // End whatever session an earlier test left, from a window of its own.
  const window = appWindow();
  window.report(true);
  window.report(false);
});

describe("the incognito session", () => {
  test("is made once for all incognito tabs, in memory, with the browser sessions' setup", () => {
    const partition = incognitoPartition();
    expect(partition).toMatch(/^incognito-\d+$/);
    expect(incognitoPartition()).toBe(partition);
    const created = sessionOf(partition);
    expect(isIncognitoSession(created)).toBe(true);
    expect(currentIncognitoSession()).toBe(created as unknown as Session);
    expect(setUp.at(-1)).toBe(created as unknown as Session);
    expect(created.preloads).toEqual([
      { type: "frame", filePath: expect.stringMatching(/incognito-preload\.cjs$/) },
    ]);
  });

  test("lasts while any window has incognito tabs, and is emptied after the last", () => {
    const first = appWindow();
    const second = appWindow();
    first.report(true);
    second.report(true);
    const partition = incognitoPartition();
    first.report(false);
    expect(incognitoPartition()).toBe(partition);
    second.report(false);
    expect(currentIncognitoSession()).toBeNull();
    expect(sessionOf(partition).cleared.toSorted()).toEqual([
      "auth",
      "cache",
      "connections",
      "storage",
    ]);
    const next = incognitoPartition();
    expect(next).not.toBe(partition);
  });

  test("ends when the last window with incognito tabs reloads or closes", () => {
    const reloaded = appWindow();
    reloaded.report(true);
    const partition = incognitoPartition();
    reloaded.emit("did-navigate");
    expect(currentIncognitoSession()).toBeNull();

    const closed = appWindow();
    closed.report(true);
    const next = incognitoPartition();
    expect(next).not.toBe(partition);
    closed.emit("destroyed");
    expect(currentIncognitoSession()).toBeNull();
  });

  test("destroys the popups still in it when it ends, whatever their pages want", () => {
    const window = appWindow();
    window.report(true);
    const created = sessionOf(incognitoPartition());
    const popup = {
      contents: { getType: () => "window", session: created } as unknown as WebContents,
      destroyed: false,
    };
    const other = {
      contents: { getType: () => "window", session: {} } as unknown as WebContents,
      destroyed: false,
    };
    popups.push(popup, other);
    window.report(false);
    expect(popup.destroyed).toBe(true);
    expect(other.destroyed).toBe(false);
    popups.length = 0;
  });
});
