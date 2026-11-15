import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { IpcMainEvent, WebContents, WebFrameMain } from "electron";

import {
  type NotificationPermissionRequest,
  type NotificationPermissionState,
  type NotificationSites,
  browserNotificationSchema,
  notificationPermissionRequestSchema,
} from "./browser-notification-protocol";
import {
  BROWSER_NOTIFICATION_CLICK,
  BROWSER_NOTIFICATION_CLOSE,
  BROWSER_NOTIFICATION_CLOSED,
  BROWSER_NOTIFICATION_EVENT,
  BROWSER_NOTIFICATION_LISTEN,
  BROWSER_NOTIFICATION_OPENED,
  BROWSER_NOTIFICATION_PERMISSION,
  BROWSER_NOTIFICATION_PERMISSION_REQUEST,
  BROWSER_NOTIFICATION_PERMISSION_RESPOND,
  BROWSER_NOTIFICATION_PERMISSION_WITHDRAWN,
  BROWSER_NOTIFICATION_REQUEST_PERMISSION,
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
    closed: () => of(BROWSER_NOTIFICATION_CLOSED),
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

const setSites = (sites: NotificationSites) =>
  handler(BROWSER_NOTIFICATION_SET_SITES)({} as IpcMainEvent, sites);

function respond(host: WebContents, id: number, decision: string) {
  handler(BROWSER_NOTIFICATION_PERMISSION_RESPOND)({ sender: host } as unknown as IpcMainEvent, {
    id,
    decision,
  });
}

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
    expect(await state(request)).toBe("pending");
    setSites({ "http://localhost:5173": "allow" });
    expect(await request).toBe("granted");
    expect(host.requests()).toEqual([]);
  });
});

let host: ReturnType<typeof fakeHost>;
/** Settings have arrived, with no decisions; for every describe after the first. */
function withSettings() {
  beforeEach(() => {
    setSites({});
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
    await Promise.resolve();
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
    await Promise.resolve();
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

  test("dismissing decides nothing", async () => {
    const { guest } = fakeGuest(host.host);
    const request = requestPermission(guest);
    await Promise.resolve();
    respond(host.host, host.requests()[0]!.id, "dismiss");
    expect(await request).toBe("default");
    expect(permission(guest)).toBe("default");
  });

  test("only the window that was asked can answer", async () => {
    const { guest } = fakeGuest(host.host);
    const request = requestPermission(guest);
    await Promise.resolve();
    respond(fakeHost().host, host.requests()[0]!.id, "allow");
    respond(guest, host.requests()[0]!.id, "allow");
    expect(await state(request)).toBe("pending");
  });

  test("a decision saved elsewhere (another window, settings) settles open requests", async () => {
    const { guest } = fakeGuest(host.host);
    const request = requestPermission(guest);
    await Promise.resolve();
    setSites({ "http://localhost:5173": "allow" });
    expect(await request).toBe("granted");
    expect(host.withdrawn()).toHaveLength(1);
  });

  test("is withdrawn when the page navigates away or goes away", async () => {
    const navigating = fakeGuest(host.host);
    const destroyed = fakeGuest(host.host);
    const requests = [requestPermission(navigating.guest), requestPermission(destroyed.guest)];
    await Promise.resolve();
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
    const { guest } = fakeGuest(host.host);
    show(guest, 1, frame("https://ads.example"));
    expect(host.opened()).toEqual([]);
    for (let i = 0; i < 15; i++) show(guest, i);
    expect(host.opened()).toHaveLength(10);
  });

  test("close() reaches the window; clicks reach the page from its window only", () => {
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
    expect(host.closed()).toEqual([{ ref }]);
    // Closed: nothing left to click.
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
