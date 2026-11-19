import { beforeEach, describe, expect, mock, test } from "bun:test";

import {
  BROWSER_MEDIA_PERMISSION,
  BROWSER_NOTIFICATION_CLOSE,
  BROWSER_NOTIFICATION_EVENT,
  BROWSER_NOTIFICATION_PERMISSION,
  BROWSER_NOTIFICATION_REQUEST_PERMISSION,
  BROWSER_NOTIFICATION_SHOW,
  JAVASCRIPT_DIALOG_RUN,
  REGISTRATION_NOTIFICATION_CLOSE,
  REGISTRATION_NOTIFICATION_LIST,
  REGISTRATION_NOTIFICATION_SHOW,
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
const [dialogScript, notificationScript, mediaScript] = scripts;
if (!dialogScript || !notificationScript || !mediaScript) {
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

/**
 * A page's EventTarget as browsers have it: listeners only. The DOM test environment's (happy-dom)
 * also calls `on<type>` properties, which a plain EventTarget subclass in a page never does.
 */
class PageEventTarget {
  private readonly listeners = new Map<string, Set<(event: Event) => void>>();
  addEventListener(type: string, listener: (event: Event) => void, options?: { once?: boolean }) {
    const wrapped = options?.once
      ? (event: Event) => {
          this.listeners.get(type)?.delete(wrapped);
          listener(event);
        }
      : listener;
    this.listeners.set(type, new Set([...(this.listeners.get(type) ?? []), wrapped]));
  }
  dispatchEvent(event: Event): boolean {
    for (const listener of [...(this.listeners.get(event.type) ?? [])]) listener(event);
    return true;
  }
}

/** Run the notification script against a stub page; returns the page's Notification. */
function notificationPage(permission: string) {
  const page = {} as { Notification: NotificationClass };
  const environmentEventTarget = globalThis.EventTarget;
  Object.assign(globalThis, { window: page, EventTarget: PageEventTarget });
  try {
    sendSync.mockImplementation(() => permission);
    const install = notificationScript!.func as unknown as (bridge: unknown) => void;
    install(notificationScript!.args[0]);
  } finally {
    globalThis.EventTarget = environmentEventTarget;
  }
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

  test("routes a service worker registration's notifications through main", async () => {
    class ServiceWorkerRegistration {
      readonly scope = "https://app.example/";
    }
    Object.assign(globalThis, { ServiceWorkerRegistration });
    try {
      const Notification = notificationPage("granted");
      const registration = new ServiceWorkerRegistration() as unknown as {
        showNotification: (title: string, options?: object) => Promise<void>;
        getNotifications: (filter?: { tag?: string }) => Promise<PageNotification[]>;
      };
      const listed = {
        ref: "sw-1",
        title: "Deployed",
        body: "v2 is live",
        tag: "deploy",
        timestamp: 5,
        data: { url: "/releases/2" },
      };
      invoke.mockImplementation((channel: string) =>
        Promise.resolve(channel === REGISTRATION_NOTIFICATION_LIST ? [listed] : "shown"),
      );

      const options = { body: "v2 is live", tag: "deploy", data: { url: "/releases/2" } };
      await registration.showNotification("Deployed", options);
      expect(invoke).toHaveBeenLastCalledWith(REGISTRATION_NOTIFICATION_SHOW, {
        scope: "https://app.example/",
        title: "Deployed",
        body: "v2 is live",
        tag: "deploy",
        timestamp: expect.any(Number),
        data: { url: "/releases/2" },
      });

      const [notification] = await registration.getNotifications({ tag: "deploy" });
      expect(invoke).toHaveBeenLastCalledWith(REGISTRATION_NOTIFICATION_LIST, {
        scope: "https://app.example/",
        tag: "deploy",
      });
      expect(notification).toBeInstanceOf(Notification);
      expect([notification!.title, notification!.tag, notification!.data]).toEqual([
        "Deployed",
        "deploy",
        { url: "/releases/2" },
      ]);
      // Listing shows nothing again; close() goes to the registration's notification.
      expect(send).not.toHaveBeenCalledWith(BROWSER_NOTIFICATION_SHOW, expect.anything());
      notification!.close();
      expect(send).toHaveBeenCalledWith(REGISTRATION_NOTIFICATION_CLOSE, {
        scope: "https://app.example/",
        ref: "sw-1",
      });

      invoke.mockImplementation(() => Promise.resolve("denied"));
      await expect(registration.showNotification("Nope")).rejects.toThrow(TypeError);
    } finally {
      invoke.mockImplementation(() => Promise.resolve("granted"));
      Reflect.deleteProperty(globalThis, "ServiceWorkerRegistration");
    }
  });
});

describe("webview preload camera and microphone permission", () => {
  /** Chromium's PermissionStatus, whose state comes from main's check: denied until allowed. */
  class ChromiumStatus {
    get state() {
      return "denied";
    }
  }
  /** Install the script over a page whose Chromium query answers for `name`. */
  function mediaPage() {
    const query = mock((_descriptor: { name: string }) => Promise.resolve(new ChromiumStatus()));
    const prototype = { query };
    Object.assign(globalThis, { Permissions: { prototype } });
    const install = mediaScript!.func as unknown as (pageStates: unknown) => void;
    install(mediaScript!.args[0]);
    const permissions = Object.create(prototype) as {
      query: (descriptor: { name: string }) => Promise<{ state: string }>;
    };
    return { permissions, query };
  }

  test("reports main's state for the camera and microphone on every read", async () => {
    const { permissions } = mediaPage();
    sendSync.mockImplementation(() => ({ camera: "prompt", microphone: "granted" }));
    const camera = await permissions.query({ name: "camera" });
    expect(camera.state).toBe("prompt");
    expect((await permissions.query({ name: "microphone" })).state).toBe("granted");
    sendSync.mockImplementation(() => ({ camera: "granted", microphone: "granted" }));
    expect(camera.state).toBe("granted");
    expect(sendSync).toHaveBeenLastCalledWith(BROWSER_MEDIA_PERMISSION);
  });

  test("leaves Chromium's answer for frames main doesn't decide, and other permissions", async () => {
    const { permissions } = mediaPage();
    sendSync.mockImplementation(() => null);
    expect((await permissions.query({ name: "camera" })).state).toBe("denied");
    sendSync.mockClear();
    expect((await permissions.query({ name: "geolocation" })).state).toBe("denied");
    expect(sendSync).not.toHaveBeenCalled();
  });
});
