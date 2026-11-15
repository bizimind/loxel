import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from "bun:test";

import type { IpcMainEvent, WebContents, WebFrameMain } from "electron";

import {
  type NotificationMutes,
  type NotificationPermissionRequest,
  type NotificationPermissionState,
  type NotificationSites,
  browserNotificationSchema,
  notificationPermissionRequestSchema,
} from "./browser-notification-protocol";
import {
  BROWSER_NOTIFICATION_CLICK,
  BROWSER_NOTIFICATION_CLOSE,
  BROWSER_NOTIFICATION_EVENT,
  BROWSER_NOTIFICATION_LISTEN,
  BROWSER_NOTIFICATION_OPENED,
  BROWSER_NOTIFICATION_PERMISSION,
  BROWSER_NOTIFICATION_PERMISSION_REQUEST,
  BROWSER_NOTIFICATION_PERMISSION_RESPOND,
  BROWSER_NOTIFICATION_PERMISSION_WITHDRAWN,
  BROWSER_NOTIFICATION_REQUEST_PERMISSION,
  BROWSER_NOTIFICATION_SET_MUTES,
  BROWSER_NOTIFICATION_SET_SITES,
  BROWSER_NOTIFICATION_SHOW,
} from "./ipc-channels";

type Handler = (event: IpcMainEvent, value?: unknown) => unknown;
const ipcHandlers = new Map<string, Handler>();
void mock.module("electron", () => ({
  ipcMain: {
    on: (channel: string, handler: Handler) => ipcHandlers.set(channel, handler),
    handle: (channel: string, handler: Handler) => ipcHandlers.set(channel, handler),
  },
}));

const { installBrowserNotifications, trackWebviewNotifications } =
  await import("./browser-notifications");
installBrowserNotifications();

const handler = (channel: string) => ipcHandlers.get(channel)!;

let nextContentsId = 1;
let nextRoutingId = 1;
type Listener = (...args: unknown[]) => void;

function fakeEmitter() {
  const listeners = new Map<string, Listener[]>();
  const add = (name: string, fn: Listener) => {
    listeners.set(name, [...(listeners.get(name) ?? []), fn]);
  };
  return {
    on: add,
    once: add,
    off: (name: string, fn: Listener) => {
      listeners.set(
        name,
        (listeners.get(name) ?? []).filter((l) => l !== fn),
      );
    },
    emit: (name: string, ...args: unknown[]) => {
      for (const fn of [...(listeners.get(name) ?? [])]) fn(...args);
    },
  };
}

function frame(origin: string): WebFrameMain & { sent: unknown[][] } {
  const sent: unknown[][] = [];
  return {
    origin,
    detached: false,
    processId: 1,
    routingId: nextRoutingId++,
    send: (...args: unknown[]) => sent.push(args),
    sent,
  } as unknown as WebFrameMain & { sent: unknown[][] };
}

/** A window renderer that records what main sends it; listening unless told not to. */
function fakeHost({ listening = true } = {}) {
  const sent: { channel: string; payload: unknown }[] = [];
  const host = {
    ...fakeEmitter(),
    id: nextContentsId++,
    getType: () => "window",
    isDestroyed: () => false,
    send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
  } as unknown as WebContents;
  if (listening) {
    handler(BROWSER_NOTIFICATION_LISTEN)({ sender: host } as unknown as IpcMainEvent);
  }
  const of = (channel: string) => sent.filter((m) => m.channel === channel).map((m) => m.payload);
  return {
    host,
    requests: () =>
      of(BROWSER_NOTIFICATION_PERMISSION_REQUEST).map((p) =>
        notificationPermissionRequestSchema.parse(p),
      ),
    withdrawn: () => of(BROWSER_NOTIFICATION_PERMISSION_WITHDRAWN),
    opened: () => of(BROWSER_NOTIFICATION_OPENED).map((p) => browserNotificationSchema.parse(p)),
  };
}

/** A webview guest hosted by `host`, with its lifecycle events triggerable. */
function fakeGuest(host: WebContents, origin = "http://localhost:5173") {
  const emitter = fakeEmitter();
  const mainFrame = frame(origin);
  const guest = {
    ...emitter,
    id: nextContentsId++,
    getType: () => "webview",
    isDestroyed: () => false,
    hostWebContents: host,
    mainFrame,
  } as unknown as WebContents;
  trackWebviewNotifications(guest);
  return { guest, mainFrame, emit: emitter.emit };
}

function call(channel: string, guest: WebContents, value?: unknown, senderFrame?: WebFrameMain) {
  const event = {
    sender: guest,
    senderFrame: senderFrame ?? guest.mainFrame,
    returnValue: undefined as unknown,
  };
  const result = handler(channel)(event as unknown as IpcMainEvent, value);
  return { event, result };
}

const permission = (guest: WebContents, senderFrame?: WebFrameMain) =>
  call(BROWSER_NOTIFICATION_PERMISSION, guest, undefined, senderFrame).event.returnValue;

const requestPermission = (guest: WebContents) =>
  call(BROWSER_NOTIFICATION_REQUEST_PERMISSION, guest)
    .result as Promise<NotificationPermissionState>;

const show = (guest: WebContents, pageId: number, senderFrame?: WebFrameMain) =>
  call(
    BROWSER_NOTIFICATION_SHOW,
    guest,
    { pageId, title: "Build", body: "done", tag: "" },
    senderFrame,
  );

/** Loxel's window sending the settings' decisions. */
const windowSender = { sender: { getType: () => "window" } } as unknown as IpcMainEvent;
const setSites = (sites: NotificationSites) =>
  handler(BROWSER_NOTIFICATION_SET_SITES)(windowSender, sites);
const setMutes = (mutes: NotificationMutes) =>
  handler(BROWSER_NOTIFICATION_SET_MUTES)(windowSender, mutes);

function respond(host: WebContents, id: number, decision: string) {
  handler(BROWSER_NOTIFICATION_PERMISSION_RESPOND)({ sender: host } as unknown as IpcMainEvent, {
    id,
    decision,
  });
}

/** Let the handlers' pending microtasks (their awaits) run, without waiting on time. */
const microtasksDone = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

/** Settle a promise's state without waiting on time: pending if it hasn't resolved by now. */
async function state<T>(promise: Promise<T>): Promise<T | "pending"> {
  return Promise.race([promise, Promise.resolve("pending" as const)]);
}

describe("before settings arrive", () => {
  test("pages see the default permission and their requests wait for the decisions", async () => {
    const host = fakeHost();
    const { guest } = fakeGuest(host.host);
    expect(permission(guest)).toBe("default");
    const request = requestPermission(guest);
    // A page whose webview goes away during the wait: Electron's accessors throw once it has.
    const gone = fakeGuest(host.host).guest;
    const goneRequest = requestPermission(gone);
    Object.defineProperty(gone, "isDestroyed", { value: () => true });
    Object.defineProperty(gone, "hostWebContents", {
      get: () => {
        throw new TypeError("Object has been destroyed");
      },
    });
    expect(await state(request)).toBe("pending");
    setSites({ "http://localhost:5173": "allow" });
    expect(await request).toBe("granted");
    expect(await goneRequest).toBe("denied");
    expect(host.requests()).toEqual([]);
  });
});

let host: ReturnType<typeof fakeHost>;
/** Settings have arrived, with no decisions; for every describe after the first. */
function withSettings() {
  beforeEach(() => {
    setSites({});
    setMutes({});
    host = fakeHost();
  });
}

describe("permission", () => {
  withSettings();
  test("follows the site's decision", () => {
    const { guest } = fakeGuest(host.host);
    expect(permission(guest)).toBe("default");
    setSites({ "http://localhost:5173": "allow" });
    expect(permission(guest)).toBe("granted");
    setSites({ "http://localhost:5173": "block" });
    expect(permission(guest)).toBe("denied");
  });

  test("is denied to plain http away from this machine", () => {
    setSites({ "http://example.com": "allow", "http://127.0.0.1:3000": "allow" });
    expect(permission(fakeGuest(host.host, "http://example.com").guest)).toBe("denied");
    expect(permission(fakeGuest(host.host, "http://127.0.0.1:3000").guest)).toBe("granted");
  });

  test("ignores decisions sent by anything but Loxel's windows", () => {
    const { guest } = fakeGuest(host.host);
    handler(BROWSER_NOTIFICATION_SET_SITES)({ sender: guest } as unknown as IpcMainEvent, {
      "http://localhost:5173": "allow",
    });
    expect(permission(guest)).toBe("default");
  });

  test("is denied to cross-origin frames, non-web pages and windows that don't listen", () => {
    setSites({ "http://localhost:5173": "allow", null: "allow" });
    const { guest } = fakeGuest(host.host);
    expect(permission(guest, frame("https://ads.example"))).toBe("denied");
    expect(permission(guest, frame("http://localhost:5173"))).toBe("granted");
    expect(permission(fakeGuest(host.host, "null").guest)).toBe("denied");
    expect(permission(fakeGuest(fakeHost({ listening: false }).host).guest)).toBe("denied");
  });
});

describe("requestPermission", () => {
  withSettings();
  test("asks the hosting window and resolves with the user's answer", async () => {
    const { guest } = fakeGuest(host.host);
    const request = requestPermission(guest);
    await microtasksDone();
    const [shown] = host.requests();
    expect(shown).toEqual({
      id: shown!.id,
      webContentsId: guest.id,
      origin: "http://localhost:5173",
    } satisfies NotificationPermissionRequest);
    respond(host.host, shown!.id, "allow");
    expect(await request).toBe("granted");
    expect(permission(guest)).toBe("granted");
  });

  test("an answer settles every page of the site that is asking", async () => {
    const first = fakeGuest(host.host).guest;
    const second = fakeGuest(host.host).guest;
    const other = fakeGuest(host.host, "https://example.com").guest;
    const requests = [
      requestPermission(first),
      requestPermission(first),
      requestPermission(second),
    ];
    const otherRequest = requestPermission(other);
    await microtasksDone();
    // One prompt per page, however often it asks.
    expect(host.requests().map((r) => r.webContentsId)).toEqual([first.id, second.id, other.id]);

    respond(host.host, host.requests()[0]!.id, "block");
    expect(await Promise.all(requests)).toEqual(["denied", "denied", "denied"]);
    expect(host.withdrawn()).toEqual([
      { id: host.requests()[0]!.id, webContentsId: first.id },
      { id: host.requests()[1]!.id, webContentsId: second.id },
    ]);
    expect(await state(otherRequest)).toBe("pending");
  });

  test("dismissing decides nothing, and the page can't ask again until it navigates", async () => {
    const { guest, emit } = fakeGuest(host.host);
    const request = requestPermission(guest);
    await microtasksDone();
    respond(host.host, host.requests()[0]!.id, "dismiss");
    expect(await request).toBe("default");
    expect(permission(guest)).toBe("default");

    expect(await requestPermission(guest)).toBe("default");
    expect(host.requests()).toHaveLength(1);
    emit("did-navigate");
    void requestPermission(guest);
    await microtasksDone();
    expect(host.requests()).toHaveLength(2);
  });

  test("only the window that was asked can answer", async () => {
    const { guest } = fakeGuest(host.host);
    const request = requestPermission(guest);
    await microtasksDone();
    respond(fakeHost().host, host.requests()[0]!.id, "allow");
    respond(guest, host.requests()[0]!.id, "allow");
    expect(await state(request)).toBe("pending");
  });

  test("a decision saved elsewhere (another window, settings) settles open requests", async () => {
    const { guest } = fakeGuest(host.host);
    const request = requestPermission(guest);
    await microtasksDone();
    setSites({ "http://localhost:5173": "allow" });
    expect(await request).toBe("granted");
    expect(host.withdrawn()).toHaveLength(1);
  });

  test("is withdrawn when the page navigates away or goes away", async () => {
    const navigating = fakeGuest(host.host);
    const destroyed = fakeGuest(host.host);
    const requests = [requestPermission(navigating.guest), requestPermission(destroyed.guest)];
    await microtasksDone();
    navigating.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    destroyed.emit("destroyed");
    expect(await Promise.all(requests)).toEqual(["default", "default"]);
    expect(host.withdrawn()).toHaveLength(2);
  });

  test("resolves at once when the site has decided, and is denied to frames without a site", async () => {
    setSites({ "http://localhost:5173": "block" });
    const { guest } = fakeGuest(host.host);
    expect(await requestPermission(guest)).toBe("denied");
    expect(await requestPermission(fakeGuest(host.host, "file://").guest)).toBe("denied");
    expect(host.requests()).toEqual([]);
  });
});

describe("notifications", () => {
  withSettings();
  beforeEach(() => setSites({ "http://localhost:5173": "allow" }));

  test("go to the hosting window with the page's origin", () => {
    const { guest } = fakeGuest(host.host);
    show(guest, 1);
    expect(host.opened()).toEqual([
      {
        ref: host.opened()[0]!.ref,
        webContentsId: guest.id,
        origin: "http://localhost:5173",
        title: "Build",
        body: "done",
        tag: "",
      },
    ]);
  });

  test("are dropped without permission, from cross-origin frames, and past the rate limit", () => {
    const blocked = fakeGuest(host.host, "https://example.com").guest;
    show(blocked, 1);
    const { guest, emit } = fakeGuest(host.host);
    show(guest, 1, frame("https://ads.example"));
    expect(host.opened()).toEqual([]);
    for (let i = 0; i < 15; i++) show(guest, i);
    expect(host.opened()).toHaveLength(10);
    // Reloading doesn't reset the limit.
    emit("did-navigate");
    show(guest, 99);
    expect(host.opened()).toHaveLength(10);
  });

  describe("of a muted site", () => {
    afterEach(() => setSystemTime());

    test("are dropped while the site keeps its permission", () => {
      const { guest } = fakeGuest(host.host);
      setMutes({ "http://localhost:5173": {} });
      show(guest, 1);
      expect(host.opened()).toEqual([]);
      expect(permission(guest)).toBe("granted");
      setMutes({});
      show(guest, 2);
      expect(host.opened()).toHaveLength(1);
    });

    test("come back when the snooze ends", () => {
      const { guest } = fakeGuest(host.host);
      setSystemTime(new Date(1_000));
      setMutes({ "http://localhost:5173": { until: 2_000 } });
      show(guest, 1);
      expect(host.opened()).toEqual([]);
      setSystemTime(new Date(2_000));
      show(guest, 2);
      expect(host.opened()).toHaveLength(1);
    });

    test("are dropped before counting toward the rate limit", () => {
      const { guest } = fakeGuest(host.host);
      setMutes({ "http://localhost:5173": {} });
      for (let i = 0; i < 15; i++) show(guest, i);
      setMutes({});
      show(guest, 99);
      expect(host.opened()).toHaveLength(1);
    });

    test("ignores mutes sent by anything but Loxel's windows", () => {
      const { guest } = fakeGuest(host.host);
      handler(BROWSER_NOTIFICATION_SET_MUTES)({ sender: guest } as unknown as IpcMainEvent, {
        "http://localhost:5173": {},
      });
      show(guest, 1);
      expect(host.opened()).toHaveLength(1);
    });
  });

  test("clicks reach the page from its window only, until the page closes the notification", () => {
    const { guest, mainFrame } = fakeGuest(host.host);
    show(guest, 7);
    const { ref } = host.opened()[0]!;

    handler(BROWSER_NOTIFICATION_CLICK)({ sender: fakeHost().host } as unknown as IpcMainEvent, {
      ref,
    });
    expect(mainFrame.sent).toEqual([]);
    handler(BROWSER_NOTIFICATION_CLICK)({ sender: host.host } as unknown as IpcMainEvent, { ref });
    expect(mainFrame.sent).toEqual([[BROWSER_NOTIFICATION_EVENT, 7, "click"]]);

    call(BROWSER_NOTIFICATION_CLOSE, guest, 7);
    // It stays in the notification center (nothing goes to the window), but has nothing to click.
    expect(host.opened()).toHaveLength(1);
    handler(BROWSER_NOTIFICATION_CLICK)({ sender: host.host } as unknown as IpcMainEvent, { ref });
    expect(mainFrame.sent).toHaveLength(1);
  });

  test("of a page that navigated have no page to click", () => {
    const { guest, mainFrame, emit } = fakeGuest(host.host);
    show(guest, 1);
    emit("did-navigate");
    const { ref } = host.opened()[0]!;
    handler(BROWSER_NOTIFICATION_CLICK)({ sender: host.host } as unknown as IpcMainEvent, { ref });
    expect(mainFrame.sent).toEqual([]);
  });
});
