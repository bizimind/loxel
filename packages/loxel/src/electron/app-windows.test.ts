import { describe, expect, mock, test } from "bun:test";

import type { IpcMainEvent, IpcMainInvokeEvent, WebContents } from "electron";

type Listener = (event: IpcMainEvent, ...args: unknown[]) => void;
type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;
const listeners = new Map<string, Listener>();
const handlers = new Map<string, Handler>();
void mock.module("electron", () => ({
  // Like Electron, a webview's window is the one hosting it.
  BrowserWindow: {
    fromWebContents: (contents: WebContents) =>
      windowOf(contents) ?? (contents.hostWebContents ? windowOf(contents.hostWebContents) : null),
  },
  ipcMain: {
    on: (channel: string, listener: Listener) => listeners.set(channel, listener),
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
  },
}));

const { fakeFrame, fakeWindow, mainFrameEvent, windowOf } =
  await import("../test/fake-app-windows");
const { handleAppWindowInvoke, isAppWindowSender, onAppWindowMessage } =
  await import("./app-windows");

const appWindow = () => fakeWindow({});
const guestOf = (host: WebContents) =>
  ({ getType: () => "webview", hostWebContents: host, mainFrame: fakeFrame() }) as WebContents;

describe("isAppWindowSender", () => {
  test("accepts a Loxel window's main frame with the app loaded", () => {
    expect(isAppWindowSender(mainFrameEvent(appWindow()))).toBe(true);
  });

  test("refuses a page's popup and a webview's page", () => {
    expect(isAppWindowSender(mainFrameEvent(fakeWindow({}, { app: false })))).toBe(false);
    expect(isAppWindowSender(mainFrameEvent(guestOf(appWindow())))).toBe(false);
  });

  test("refuses a Loxel window's iframes, other documents, and gone frames", () => {
    const win = appWindow();
    const from = (senderFrame: unknown) =>
      ({ sender: win, senderFrame }) as unknown as IpcMainInvokeEvent;
    expect(isAppWindowSender(from(fakeFrame()))).toBe(false);
    const elsewhere = fakeWindow({ mainFrame: fakeFrame("https://example.com") });
    expect(isAppWindowSender(mainFrameEvent(elsewhere))).toBe(false);
    expect(isAppWindowSender(from(null))).toBe(false);
  });
});

describe("app-only channels", () => {
  test("messages reach the listener from Loxel's windows only", () => {
    const received = mock((_event: IpcMainEvent, value: unknown) => value);
    onAppWindowMessage("test:message", received);
    const send = listeners.get("test:message")!;
    send(mainFrameEvent(fakeWindow({}, { app: false })), "popup");
    send(mainFrameEvent(guestOf(appWindow())), "page");
    send(mainFrameEvent(appWindow()), "app");
    expect(received.mock.calls.map(([, value]) => value)).toEqual(["app"]);
  });

  test("a refused synchronous message is answered, so its sender doesn't hang", () => {
    onAppWindowMessage("test:sync", (event) => {
      event.returnValue = true;
    });
    const event = { ...mainFrameEvent(fakeWindow({}, { app: false })), returnValue: "unanswered" };
    listeners.get("test:sync")!(event);
    expect(event.returnValue).toBeUndefined();
  });

  test("invokes are answered for Loxel's windows and rejected for anything else", async () => {
    const handler = mock(async () => "answer");
    handleAppWindowInvoke("test:invoke", handler);
    const invoke = handlers.get("test:invoke")!;
    expect(await invoke(mainFrameEvent(appWindow()))).toBe("answer");
    await expect(invoke(mainFrameEvent(fakeWindow({}, { app: false })))).rejects.toThrow();
    await expect(invoke(mainFrameEvent(guestOf(appWindow())))).rejects.toThrow();
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

/**
 * The channels registered on `ipcMain` directly: those pages send (the webview and service worker
 * preloads), which decide by the sending frame, and the quit question's, added per question and
 * checked with `isAppWindowSender`. Every other channel is app-only and goes through the helpers.
 */
const RAW_IPC_CHANNELS = new Set([
  "BROWSER_NOTIFICATION_CLOSE",
  "BROWSER_NOTIFICATION_PERMISSION",
  "BROWSER_NOTIFICATION_REQUEST_PERMISSION",
  "BROWSER_NOTIFICATION_SHOW",
  "JAVASCRIPT_DIALOG_RUN",
  "QUIT_ANSWER",
  "QUIT_QUESTION_SHOWN",
  "REGISTRATION_NOTIFICATION_CLOSE",
  "REGISTRATION_NOTIFICATION_LIST",
  "REGISTRATION_NOTIFICATION_SHOW",
]);

test("only page channels and the quit question's register on ipcMain directly", async () => {
  const raw: string[] = [];
  for await (const file of new Bun.Glob("*.ts").scan(import.meta.dirname)) {
    if (file.endsWith(".test.ts") || file === "app-windows.ts") continue;
    const source = await Bun.file(`${import.meta.dirname}/${file}`).text();
    for (const [, channel] of source.matchAll(
      /ipcMain\.(?:on|once|handle|handleOnce)\(\s*(\w+)/g,
    )) {
      if (!RAW_IPC_CHANNELS.has(channel!)) raw.push(`${file}: ${channel}`);
    }
  }
  expect(raw).toEqual([]);
});
