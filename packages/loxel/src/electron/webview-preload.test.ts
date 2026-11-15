import { beforeEach, describe, expect, mock, test } from "bun:test";

import {
  BROWSER_NOTIFICATION_CLOSE,
  BROWSER_NOTIFICATION_EVENT,
  BROWSER_NOTIFICATION_PERMISSION,
  BROWSER_NOTIFICATION_REQUEST_PERMISSION,
  BROWSER_NOTIFICATION_SHOW,
  JAVASCRIPT_DIALOG_RUN,
} from "./ipc-channels";

interface DialogCall {
  type: string;
  message: string;
  defaultValue: string;
}
interface PageDialogs {
  alert: (...args: unknown[]) => void;
  confirm: (...args: unknown[]) => boolean;
  prompt: (...args: unknown[]) => string | null;
}
type InstallDialogs = (runDialog: (call: DialogCall) => unknown) => void;

interface MainWorldScript {
  func: (...args: never[]) => void;
  args: unknown[];
}
const scripts: MainWorldScript[] = [];
const sendSync = mock((_channel: string, _call?: unknown): unknown => null);
const send = mock((_channel: string, _payload: unknown) => {});
const invoke = mock((_channel: string): Promise<unknown> => Promise.resolve("granted"));
const ipcListeners = new Map<string, (event: unknown, ...args: unknown[]) => void>();
void mock.module("electron", () => ({
  contextBridge: { executeInMainWorld: (s: MainWorldScript) => scripts.push(s) },
  ipcRenderer: {
    sendSync,
    send,
    invoke,
    on: (channel: string, listener: (event: unknown, ...args: unknown[]) => void) =>
      ipcListeners.set(channel, listener),
  },
}));
await import("./webview-preload.cjs");
const [dialogScript, notificationScript] = scripts;
if (!dialogScript || !notificationScript) {
  throw new Error("the preload did not install its main-world scripts");
}
const installDialogs = dialogScript.func as unknown as InstallDialogs;
const args = dialogScript.args as [(call: DialogCall) => unknown];

/** Run the main-world function against a stub page; returns its dialogs and page events. */
function stubPage(answer: (call: DialogCall) => unknown) {
  const listeners = new Map<string, () => void>();
  const page = {} as PageDialogs;
  const runDialog = mock(answer);
  Object.assign(globalThis, {
    window: page,
    addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
  });
  installDialogs(runDialog);
  const fire = (type: string) => listeners.get(type)?.();
  return { page, runDialog, fire };
}

beforeEach(() => {
  sendSync.mockReset();
  send.mockClear();
});

describe("webview preload", () => {
  test("asks main synchronously on the dialog channel", () => {
    const call = { type: "alert", message: "hi", defaultValue: "" };
    sendSync.mockReturnValueOnce("answer");
    expect(args[0](call)).toBe("answer");
    expect(sendSync).toHaveBeenCalledWith(JAVASCRIPT_DIALOG_RUN, call);
  });

  test("converts arguments like the DOM's dialog functions", () => {
    const { page, runDialog } = stubPage(() => null);
    page.alert();
    page.alert(null);
    page.alert(undefined);
    page.confirm(undefined);
    page.confirm({});
    page.prompt("Name?", undefined);
    page.prompt(42, 7);
    expect(runDialog.mock.calls.map(([call]) => call)).toEqual([
      { type: "alert", message: "", defaultValue: "" },
      { type: "alert", message: "null", defaultValue: "" },
      { type: "alert", message: "undefined", defaultValue: "" },
      { type: "confirm", message: "", defaultValue: "" },
      { type: "confirm", message: "[object Object]", defaultValue: "" },
      { type: "prompt", message: "Name?", defaultValue: "" },
      { type: "prompt", message: "42", defaultValue: "7" },
    ]);
    expect(() => page.alert(Symbol("no"))).toThrow(TypeError);
    expect(runDialog).toHaveBeenCalledTimes(7);
  });

  test("returns what browsers return", () => {
    const answers: unknown[] = [true, "yes", "typed", 5, null, "ignored"];
    const { page } = stubPage(() => answers.shift());
    expect(page.confirm()).toBe(true);
    expect(page.confirm()).toBe(false);
    expect(page.prompt()).toBe("typed");
    expect(page.prompt()).toBeNull();
    expect(page.prompt()).toBeNull();
    expect(page.alert()).toBeUndefined();
  });

  test("keeps the functions' names and arity", () => {
    const { page } = stubPage(() => null);
    expect([page.alert, page.confirm, page.prompt].map((f) => [f.name, f.length])).toEqual([
      ["alert", 0],
      ["confirm", 0],
      ["prompt", 0],
    ]);
  });

  test("ignores dialogs while the page is being left", async () => {
    const { page, runDialog, fire } = stubPage(() => true);
    fire("beforeunload");
    expect(page.confirm("Leave?")).toBe(false);
    expect(page.prompt("Why?")).toBeNull();
    // The page stays if the unload is cancelled.
    await Bun.sleep(1);
    expect(page.confirm("Still here?")).toBe(true);

    fire("pagehide");
    expect(page.confirm("Gone?")).toBe(false);
    fire("pageshow"); // back from the back/forward cache
    expect(page.confirm("Back?")).toBe(true);
    expect(runDialog).toHaveBeenCalledTimes(2);
  });
});

interface PageNotification extends EventTarget {
  title: string;
  body: string;
  tag: string;
  data: unknown;
  onclick: ((event: Event) => void) | null;
  close: () => void;
}
interface NotificationClass {
  new (title: unknown, options?: Record<string, unknown>): PageNotification;
  readonly permission: string;
  requestPermission: (callback?: (permission: string) => void) => Promise<string>;
}

/** Run the notification script against a stub page; returns the page's Notification. */
function notificationPage(permission: string) {
  const page = {} as { Notification: NotificationClass };
  Object.assign(globalThis, { window: page });
  sendSync.mockImplementation(() => permission);
  const install = notificationScript!.func as unknown as (bridge: unknown) => void;
  install(notificationScript!.args[0]);
  return page.Notification;
}

/** Resolves on the next event of `type` the notification fires. */
const nextEvent = (target: EventTarget, type: string) =>
  new Promise<Event>((resolve) => {
    target.addEventListener(type, resolve, { once: true });
  });

describe("webview preload notifications", () => {
  test("reads the permission from main on every access", () => {
    const Notification = notificationPage("default");
    expect(Notification.permission).toBe("default");
    sendSync.mockImplementation(() => "granted");
    expect(Notification.permission).toBe("granted");
    expect(sendSync).toHaveBeenLastCalledWith(BROWSER_NOTIFICATION_PERMISSION);
  });

  test("shows a granted page's notification through main and fires show", async () => {
    const Notification = notificationPage("granted");
    const notification = new Notification("Build", { body: "done", tag: "ci", data: { id: 1 } });
    expect([notification.title, notification.body, notification.tag]).toEqual([
      "Build",
      "done",
      "ci",
    ]);
    expect(notification.data).toEqual({ id: 1 });
    expect(send).toHaveBeenCalledWith(BROWSER_NOTIFICATION_SHOW, {
      pageId: expect.any(Number),
      title: "Build",
      body: "done",
      tag: "ci",
    });
    await nextEvent(notification, "show");
  });

  test("without permission, shows nothing and fires error", async () => {
    const Notification = notificationPage("denied");
    const notification = new Notification("Nope");
    expect(send).not.toHaveBeenCalled();
    await nextEvent(notification, "error");
  });

  test("delivers main's click to the notification and its onclick", async () => {
    const Notification = notificationPage("granted");
    const notification = new Notification("Build");
    const [, { pageId }] = send.mock.calls[0] as [string, { pageId: number }];
    const onclick = mock((_event: Event) => {});
    notification.onclick = onclick;
    const clicked = nextEvent(notification, "click");
    ipcListeners.get(BROWSER_NOTIFICATION_EVENT)!({}, pageId, "click");
    expect((await clicked).type).toBe("click");
    expect(onclick).toHaveBeenCalledTimes(1);
  });

  test("close() tells main once and fires close", async () => {
    const Notification = notificationPage("granted");
    const notification = new Notification("Build");
    const [, { pageId }] = send.mock.calls[0] as [string, { pageId: number }];
    notification.close();
    notification.close();
    expect(send.mock.calls.filter(([channel]) => channel === BROWSER_NOTIFICATION_CLOSE)).toEqual([
      [BROWSER_NOTIFICATION_CLOSE, pageId],
    ]);
    await nextEvent(notification, "close");
  });

  test("requestPermission asks main and also calls the legacy callback", async () => {
    const Notification = notificationPage("default");
    const callback = mock((_permission: string) => {});
    expect(await Notification.requestPermission(callback)).toBe("granted");
    expect(invoke).toHaveBeenCalledWith(BROWSER_NOTIFICATION_REQUEST_PERMISSION);
    expect(callback).toHaveBeenCalledWith("granted");
  });

  test("requires a title, like the DOM's constructor", () => {
    const Notification = notificationPage("granted");
    expect(() => new (Notification as unknown as new () => unknown)()).toThrow(TypeError);
  });
});
