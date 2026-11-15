import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  BROWSER_NOTIFICATION_PERMISSION,
  REGISTRATION_NOTIFICATION_CLICK,
  REGISTRATION_NOTIFICATION_CLICK_DONE,
  REGISTRATION_NOTIFICATION_CLOSE,
  REGISTRATION_NOTIFICATION_LIST,
  REGISTRATION_NOTIFICATION_OPEN_WINDOW,
  REGISTRATION_NOTIFICATION_SHOW,
} from "./ipc-channels";

interface MainWorldScript {
  func: (bridge: unknown) => void;
  args: unknown[];
}
const scripts: MainWorldScript[] = [];
const sendSync = mock((_channel: string): unknown => "granted");
const send = mock((_channel: string, _payload: unknown) => {});
const invoke = mock((_channel: string, _payload?: unknown): Promise<unknown> =>
  Promise.resolve("shown"),
);
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
await import("./service-worker-preload.cjs");
const [script] = scripts;
if (!script) throw new Error("the preload did not install its main-world script");

interface WorkerNotification {
  title: string;
  tag: string;
  data: unknown;
  close: () => void;
}
interface NotificationClass {
  new (title: string): WorkerNotification;
  readonly permission: string;
}
interface NotificationClickEvent extends Event {
  notification: WorkerNotification;
  action: string;
  waitUntil: (promise: Promise<unknown>) => void;
}

/** Run the preload's main-world script in a fresh worker scope. */
function workerScope() {
  // A worker's globals, as far as the preload touches them; new ones per worker, as the preload
  // patches their prototypes.
  class ServiceWorkerRegistration {
    readonly scope = "https://app.example/";
  }
  class Clients {
    openWindow(_url: string): Promise<unknown> {
      return Promise.reject(
        new DOMException("Not allowed to open a window.", "InvalidAccessError"),
      );
    }
  }
  class WindowClient {
    focus(): Promise<unknown> {
      return Promise.reject(
        new DOMException("Not allowed to focus a window.", "InvalidAccessError"),
      );
    }
  }
  /** Like Chromium's: an event a script made gets no working waitUntil(). */
  class ExtendableEvent extends Event {
    waitUntil(): void {
      throw new DOMException("Can not call waitUntil on a script constructed ExtendableEvent.");
    }
  }
  const scope = Object.assign(new EventTarget(), {
    location: { href: "https://app.example/sw.js" },
    Notification: undefined as unknown as NotificationClass,
  });
  Object.assign(globalThis, {
    self: scope,
    ServiceWorkerRegistration,
    Clients,
    WindowClient,
    ExtendableEvent,
  });
  script!.func(script!.args[0]);
  const registration = new ServiceWorkerRegistration() as unknown as {
    showNotification: (title?: unknown, options?: object) => Promise<void>;
    getNotifications: (filter?: { tag?: string }) => Promise<WorkerNotification[]>;
  };
  return { scope, registration, clients: new Clients(), client: new WindowClient() };
}

const info = {
  ref: "sw-1",
  title: "Build",
  body: "done",
  tag: "ci",
  timestamp: 5,
  data: { url: "/builds/1" },
};

/** Main delivering a click on `info` as click `clickId`. */
const deliverClick = (clickId: number) =>
  ipcListeners.get(REGISTRATION_NOTIFICATION_CLICK)!({}, clickId, info);

/** Resolves once the preload tells main the click's handlers are done. */
const clickDone = () =>
  new Promise<unknown>((resolve) => {
    send.mockImplementation((channel, payload) => {
      if (channel === REGISTRATION_NOTIFICATION_CLICK_DONE) resolve(payload);
    });
  });

const WORKER_GLOBALS = ["ServiceWorkerRegistration", "Clients", "WindowClient", "ExtendableEvent"];
const environmentSelf = globalThis.self;
afterAll(() => {
  globalThis.self = environmentSelf;
  for (const name of WORKER_GLOBALS) Reflect.deleteProperty(globalThis, name);
});

beforeEach(() => {
  send.mockReset();
  invoke.mockReset();
  invoke.mockImplementation(() => Promise.resolve("shown"));
});

describe("service worker preload", () => {
  test("showNotification goes to main, and rejects as browsers do when main refuses", async () => {
    const { registration } = workerScope();
    await registration.showNotification("Build", { body: "done", tag: "ci", data: { id: 1 } });
    expect(invoke).toHaveBeenCalledWith(REGISTRATION_NOTIFICATION_SHOW, {
      title: "Build",
      body: "done",
      tag: "ci",
      timestamp: expect.any(Number),
      data: { id: 1 },
    });
    invoke.mockImplementation(() => Promise.resolve("denied"));
    await expect(registration.showNotification("Nope")).rejects.toThrow(TypeError);
    invoke.mockImplementation(() => Promise.resolve("data-too-large"));
    await expect(registration.showNotification("Big")).rejects.toThrow(TypeError);
    await expect(registration.showNotification()).rejects.toThrow(TypeError);
  });

  test("getNotifications returns Notifications whose close() goes to main", async () => {
    const { scope, registration } = workerScope();
    invoke.mockImplementation(() => Promise.resolve([info]));
    const [notification] = await registration.getNotifications({ tag: "ci" });
    expect(invoke).toHaveBeenCalledWith(REGISTRATION_NOTIFICATION_LIST, { tag: "ci" });
    expect(notification).toBeInstanceOf(scope.Notification);
    expect([notification!.title, notification!.tag, notification!.data]).toEqual([
      "Build",
      "ci",
      { url: "/builds/1" },
    ]);
    notification!.close();
    expect(send).toHaveBeenCalledWith(REGISTRATION_NOTIFICATION_CLOSE, { ref: "sw-1" });
  });

  test("Notification can't be constructed, and reads its permission from main", () => {
    const { scope } = workerScope();
    expect(() => new scope.Notification("Hi")).toThrow(TypeError);
    sendSync.mockImplementation(() => "denied");
    expect(scope.Notification.permission).toBe("denied");
    expect(sendSync).toHaveBeenLastCalledWith(BROWSER_NOTIFICATION_PERMISSION);
  });

  test("a click dispatches notificationclick, and tells main once its waitUntil settles", async () => {
    const { scope } = workerScope();
    let finish: () => void = () => {};
    const handled = new Promise<NotificationClickEvent>((resolve) => {
      scope.addEventListener("notificationclick", (event) => {
        const click = event as NotificationClickEvent;
        click.waitUntil(
          new Promise<void>((r) => {
            finish = r;
          }),
        );
        resolve(click);
      });
    });
    const done = clickDone();
    deliverClick(7);
    const event = await handled;
    expect([event.notification.title, event.notification.data, event.action]).toEqual([
      "Build",
      { url: "/builds/1" },
      "",
    ]);
    expect(send).not.toHaveBeenCalledWith(REGISTRATION_NOTIFICATION_CLICK_DONE, 7);
    finish();
    expect(await done).toBe(7);
    // Like browsers, a finished event takes no more promises.
    expect(() => event.waitUntil(Promise.resolve())).toThrow("already finished");
  });

  test("openWindow asks main for a tab, and focus() works during a click", async () => {
    const { scope, clients, client } = workerScope();
    invoke.mockImplementation(() => Promise.resolve(false));
    await expect(clients.openWindow("/builds/1")).rejects.toThrow("Not allowed to open a window.");
    await expect(client.focus()).rejects.toThrow("Not allowed to focus a window.");

    scope.addEventListener("notificationclick", () => {});
    const done = clickDone();
    deliverClick(8);
    await done;
    invoke.mockImplementation(() => Promise.resolve(true));
    expect(await clients.openWindow("/builds/1")).toBeNull();
    expect(invoke).toHaveBeenLastCalledWith(
      REGISTRATION_NOTIFICATION_OPEN_WINDOW,
      "https://app.example/builds/1",
    );
    expect(await client.focus()).toBe(client);
  });
});
