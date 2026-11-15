import { beforeEach, describe, expect, jest, mock, setSystemTime, test } from "bun:test";

import type { IpcMainEvent, ServiceWorkerMain, Session, WebContents } from "electron";

import {
  type NotificationSites,
  type RegistrationNotificationInfo,
  browserNotificationSchema,
} from "./browser-notification-protocol";
import {
  BROWSER_NOTIFICATION_CLICK,
  BROWSER_NOTIFICATION_LISTEN,
  BROWSER_NOTIFICATION_OPENED,
  BROWSER_NOTIFICATION_PERMISSION,
  BROWSER_NOTIFICATION_SET_SITES,
  OPEN_IN_NEW_BROWSER_TAB,
  REGISTRATION_NOTIFICATION_CLICK,
  REGISTRATION_NOTIFICATION_CLICK_DONE,
  REGISTRATION_NOTIFICATION_CLOSE,
  REGISTRATION_NOTIFICATION_LIST,
  REGISTRATION_NOTIFICATION_OPEN_WINDOW,
  REGISTRATION_NOTIFICATION_SHOW,
} from "./ipc-channels";

type Handler = (event: unknown, value?: unknown) => unknown;
type Listener = (...args: unknown[]) => void;

function fakeEmitter() {
  const listeners = new Map<string, Listener[]>();
  const add = (name: string, fn: Listener) => {
    listeners.set(name, [...(listeners.get(name) ?? []), fn]);
  };
  return {
    on: add,
    once: add,
    emit: (name: string, ...args: unknown[]) => {
      for (const fn of [...(listeners.get(name) ?? [])]) fn(...args);
    },
  };
}

/** ipcMain's listeners: several modules listen on the click channel. */
const ipcHandlers = new Map<string, Handler[]>();
const addHandler = (channel: string, handler: Handler) =>
  ipcHandlers.set(channel, [...(ipcHandlers.get(channel) ?? []), handler]);
const guests: WebContents[] = [];
void mock.module("electron", () => ({
  // webview-new-tabs.ts (USER_ACTIVATION_MS) imports it.
  BrowserWindow: {},
  ipcMain: { on: addHandler, handle: addHandler },
  webContents: {
    getAllWebContents: () => guests,
    fromId: (id: number) => guests.find((g) => g.id === id),
  },
}));

const { installBrowserNotifications, trackWebviewNotifications } =
  await import("./browser-notifications");
const { installServiceWorkerNotifications, trackWebviewFocus } =
  await import("./service-worker-notifications");

/** A worker as main sees it, answering its preload's calls through its own `ipc`. */
function fakeWorker(scope: string, versionId: number) {
  const handlers = new Map<string, Handler>();
  const sent: unknown[][] = [];
  const tasks = { started: 0, ended: 0, failing: false };
  const worker = {
    scope,
    versionId,
    isDestroyed: () => false,
    ipc: {
      on: (channel: string, handler: Handler) => handlers.set(channel, handler),
      handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
    },
    send: (...args: unknown[]) => sent.push(args),
    startTask: () => {
      if (tasks.failing) throw new Error("Unable to start service worker task.");
      tasks.started++;
      return { end: () => tasks.ended++ };
    },
  } as unknown as ServiceWorkerMain;
  const call = (channel: string, value?: unknown) => {
    const event = { returnValue: undefined as unknown };
    const result = handlers.get(channel)!(event, value);
    return { event, result };
  };
  /** A call main answers asynchronously (invoke), or a message it acts on after a wait. */
  const ask = async (channel: string, value?: unknown) => {
    const { result } = call(channel, value);
    await microtasksDone();
    return result;
  };
  return { worker, sent, tasks, call, ask };
}

const workersByVersion = new Map<number, ServiceWorkerMain>();
const serviceWorkers = {
  ...fakeEmitter(),
  getWorkerFromVersionID: (id: number) => workersByVersion.get(id),
  // The first-party registration's worker: the first one started for the scope here.
  startWorkerForScope: (scope: string) => {
    const worker = [...workersByVersion.values()].find((w) => w.scope === scope);
    return worker ? Promise.resolve(worker) : Promise.reject(new Error("no registration"));
  },
};
const registerPreloadScript = mock(() => "id");
installBrowserNotifications();
installServiceWorkerNotifications({ serviceWorkers, registerPreloadScript } as unknown as Session);

let nextVersion = 1;
/** Start a worker of `scope`: main listens to its preload as it starts. */
function startWorker(scope: string) {
  const versionId = nextVersion++;
  const fake = fakeWorker(scope, versionId);
  workersByVersion.set(versionId, fake.worker);
  serviceWorkers.emit("running-status-changed", { versionId, runningStatus: "starting" });
  return fake;
}

const ipc = (channel: string, event: unknown, value?: unknown) =>
  ipcHandlers.get(channel)!.map((handler) => handler(event, value));

let nextContentsId = 1;
function fakeHost() {
  const sent: { channel: string; args: unknown[] }[] = [];
  const host = {
    ...fakeEmitter(),
    id: nextContentsId++,
    getType: () => "window",
    isDestroyed: () => false,
    send: (channel: string, ...args: unknown[]) => sent.push({ channel, args }),
  } as unknown as WebContents;
  ipc(BROWSER_NOTIFICATION_LISTEN, { sender: host });
  const of = (channel: string) => sent.filter((m) => m.channel === channel).map((m) => m.args);
  return {
    host,
    opened: () => of(BROWSER_NOTIFICATION_OPENED).map(([p]) => browserNotificationSchema.parse(p)),
    tabs: () => of(OPEN_IN_NEW_BROWSER_TAB),
  };
}

function fakeGuest(host: WebContents, origin = SITE) {
  const emitter = fakeEmitter();
  const guest = {
    ...emitter,
    id: nextContentsId++,
    getType: () => "webview",
    isDestroyed: () => false,
    hostWebContents: host,
    mainFrame: { origin, detached: false },
  } as unknown as WebContents;
  guests.push(guest);
  trackWebviewNotifications(guest);
  trackWebviewFocus(guest);
  return { guest, focus: () => emitter.emit("focus") };
}

const setSites = (sites: NotificationSites) =>
  ipc(BROWSER_NOTIFICATION_SET_SITES, { sender: { getType: () => "window" } }, sites);

const notification = (fields: Record<string, unknown> = {}) => ({
  title: "Build",
  body: "done",
  tag: "",
  timestamp: 1,
  data: { url: "/builds/1" },
  ...fields,
});

/** A page calling its registration, through ipcMain. */
function fromPage(guest: WebContents, channel: string, value: unknown) {
  const [result] = ipc(channel, { sender: guest, senderFrame: guest.mainFrame }, value);
  return result;
}

const click = (sender: WebContents, ref: string) =>
  ipc(BROWSER_NOTIFICATION_CLICK, { sender } as unknown as IpcMainEvent, { ref });

/** Let the handlers' pending microtasks (their awaits) run, without waiting on time. */
const microtasksDone = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

/** Each test's own allowed site, since main keeps notifications across tests. */
let SITE = "";
let SCOPE = "";
let nextSite = 1;

beforeEach(() => {
  guests.length = 0;
  workersByVersion.clear();
  SITE = `https://app${nextSite++}.example`;
  SCOPE = `${SITE}/`;
  setSites({ [SITE]: "allow" });
});

describe("service worker notifications", () => {
  test("registers the worker preload on the browser panels' session", () => {
    expect(registerPreloadScript).toHaveBeenCalledWith({
      type: "service-worker",
      filePath: expect.stringMatching(/service-worker-preload\.cjs$/),
    });
  });

  test("the worker reads its origin's decision", () => {
    expect(startWorker(SCOPE).call(BROWSER_NOTIFICATION_PERMISSION).event.returnValue).toBe(
      "granted",
    );
    const other = startWorker("https://other.example/");
    expect(other.call(BROWSER_NOTIFICATION_PERMISSION).event.returnValue).toBe("default");
    const insecure = startWorker("http://app.example/");
    expect(insecure.call(BROWSER_NOTIFICATION_PERMISSION).event.returnValue).toBe("denied");
  });

  test("go to the most recently focused loaded panel of the worker's origin", async () => {
    const { host, opened } = fakeHost();
    const first = fakeGuest(host);
    const second = fakeGuest(host);
    fakeGuest(host, "https://other.example");
    first.focus();
    const worker = startWorker(SCOPE);
    expect(await worker.ask(REGISTRATION_NOTIFICATION_SHOW, notification())).toBe("shown");
    second.focus();
    await worker.ask(REGISTRATION_NOTIFICATION_SHOW, notification({ title: "Deploy" }));
    expect(opened().map((n) => [n.webContentsId, n.origin, n.title])).toEqual([
      [first.guest.id, SITE, "Build"],
      [second.guest.id, SITE, "Deploy"],
    ]);
  });

  test("are refused without permission or with too much data, and dropped with no panel", async () => {
    const { host, opened } = fakeHost();
    const blocked = startWorker("https://other.example/");
    expect(await blocked.ask(REGISTRATION_NOTIFICATION_SHOW, notification())).toBe("denied");
    const worker = startWorker(SCOPE);
    const big = notification({ data: "x".repeat(70_000) });
    expect(await worker.ask(REGISTRATION_NOTIFICATION_SHOW, big)).toBe("data-too-large");
    expect(await worker.ask(REGISTRATION_NOTIFICATION_SHOW, notification())).toBe("shown");
    expect(await worker.ask(REGISTRATION_NOTIFICATION_LIST, {})).toEqual([]);
    fakeGuest(host);
    await worker.ask(REGISTRATION_NOTIFICATION_SHOW, notification());
    expect(opened()).toHaveLength(1);
  });

  test("a worker the site registered while embedded in another site gets none of them", async () => {
    const { host, opened } = fakeHost();
    fakeGuest(host);
    const own = startWorker(SCOPE);
    await own.ask(REGISTRATION_NOTIFICATION_SHOW, notification());
    // Same scope, another registration: Chromium partitions it by the top-level site.
    const embedded = startWorker(SCOPE);
    expect(await embedded.ask(REGISTRATION_NOTIFICATION_SHOW, notification())).toBe("denied");
    expect(await embedded.ask(REGISTRATION_NOTIFICATION_LIST, {})).toEqual([]);
    await embedded.ask(REGISTRATION_NOTIFICATION_CLOSE, { ref: opened()[0]!.ref });
    expect(await own.ask(REGISTRATION_NOTIFICATION_LIST, {})).toHaveLength(1);
    expect(opened()).toHaveLength(1);
  });

  test("getNotifications lists the registration's live ones; a tag replaces, close removes", async () => {
    const { host } = fakeHost();
    fakeGuest(host);
    const worker = startWorker(SCOPE);
    await worker.ask(REGISTRATION_NOTIFICATION_SHOW, notification({ tag: "ci", title: "One" }));
    await worker.ask(REGISTRATION_NOTIFICATION_SHOW, notification({ tag: "ci", title: "Two" }));
    await worker.ask(REGISTRATION_NOTIFICATION_SHOW, notification({ tag: "chat", title: "Hi" }));
    const list = async (query = {}) =>
      (await worker.ask(REGISTRATION_NOTIFICATION_LIST, query)) as RegistrationNotificationInfo[];
    expect((await list()).map((n) => n.title)).toEqual(["Two", "Hi"]);
    expect(await list({ tag: "chat" })).toEqual([
      {
        ref: expect.any(String),
        title: "Hi",
        body: "done",
        tag: "chat",
        timestamp: 1,
        data: { url: "/builds/1" },
      },
    ]);
    // Another registration of the site sees and closes none of them.
    const other = startWorker(`${SITE}/admin/`);
    expect(await other.ask(REGISTRATION_NOTIFICATION_LIST, {})).toEqual([]);
    await other.ask(REGISTRATION_NOTIFICATION_CLOSE, { ref: (await list())[0]!.ref });
    expect(await list()).toHaveLength(2);
    await worker.ask(REGISTRATION_NOTIFICATION_CLOSE, { ref: (await list())[0]!.ref });
    expect((await list()).map((n) => n.title)).toEqual(["Hi"]);
  });

  test("a site keeps its newest 100 across registrations, and none of a closed window", async () => {
    const { host } = fakeHost();
    const page = fakeGuest(host);
    const scopes = ["a/", "b/"].map((path) => `${SITE}/${path}`);
    // A page may name any scope of its own site; the cap is for the site.
    for (let i = 0; i < 120; i++) {
      // Past the rate limit, the page's notifications are dropped: a new panel each time.
      const guest = i % 10 === 0 ? fakeGuest(host).guest : guests.at(-1)!;
      fromPage(guest, REGISTRATION_NOTIFICATION_SHOW, {
        ...notification({ title: `n${i}` }),
        scope: scopes[i % 2],
      });
    }
    const listed = scopes.flatMap(
      (scope) =>
        fromPage(page.guest, REGISTRATION_NOTIFICATION_LIST, {
          scope,
        }) as RegistrationNotificationInfo[],
    );
    expect(listed).toHaveLength(100);
    expect(listed.some((n) => n.title === "n0")).toBe(false);

    (host as unknown as { isDestroyed: () => boolean }).isDestroyed = () => true;
    expect(fromPage(page.guest, REGISTRATION_NOTIFICATION_LIST, { scope: scopes[0] })).toEqual([]);
  });

  test("a page shows, lists and closes for its own origin's registrations only, in its own panel", () => {
    const { host, opened } = fakeHost();
    const page = fakeGuest(host);
    fakeGuest(host).focus();
    const shown = fromPage(page.guest, REGISTRATION_NOTIFICATION_SHOW, {
      ...notification(),
      scope: SCOPE,
    });
    expect(shown).toBe("shown");
    expect(opened().map((n) => n.webContentsId)).toEqual([page.guest.id]);
    const foreign = "https://other.example/";
    const foreignShow = { ...notification(), scope: foreign };
    expect(fromPage(page.guest, REGISTRATION_NOTIFICATION_SHOW, foreignShow)).toBe("denied");
    expect(fromPage(page.guest, REGISTRATION_NOTIFICATION_LIST, { scope: foreign })).toEqual([]);
    const { ref } = opened()[0]!;
    fromPage(page.guest, REGISTRATION_NOTIFICATION_CLOSE, { scope: foreign, ref });
    expect(fromPage(page.guest, REGISTRATION_NOTIFICATION_LIST, { scope: SCOPE })).toHaveLength(1);
    fromPage(page.guest, REGISTRATION_NOTIFICATION_CLOSE, { scope: SCOPE, ref });
    expect(fromPage(page.guest, REGISTRATION_NOTIFICATION_LIST, { scope: SCOPE })).toEqual([]);
  });

  test("the worker sees what a page showed for its registration", async () => {
    const { host } = fakeHost();
    const page = fakeGuest(host);
    fromPage(page.guest, REGISTRATION_NOTIFICATION_SHOW, { ...notification(), scope: SCOPE });
    expect(await startWorker(SCOPE).ask(REGISTRATION_NOTIFICATION_LIST, {})).toHaveLength(1);
  });

  test("a click from the notification's window dispatches notificationclick in the worker", async () => {
    const { host, opened } = fakeHost();
    fakeGuest(host);
    const worker = startWorker(SCOPE);
    await worker.ask(REGISTRATION_NOTIFICATION_SHOW, notification());
    const { ref } = opened()[0]!;

    click(fakeHost().host, ref);
    await microtasksDone();
    expect(worker.sent).toEqual([]);

    click(host, ref);
    await microtasksDone();
    expect(worker.sent).toEqual([
      [
        REGISTRATION_NOTIFICATION_CLICK,
        expect.any(Number),
        { ref, title: "Build", body: "done", tag: "", timestamp: 1, data: { url: "/builds/1" } },
      ],
    ]);
    // The worker runs until its handler is done; another registration's word doesn't count.
    const clickId = worker.sent[0]![1];
    expect(worker.tasks).toMatchObject({ started: 1, ended: 0 });
    startWorker(`${SITE}/admin/`).call(REGISTRATION_NOTIFICATION_CLICK_DONE, clickId);
    expect(worker.tasks).toMatchObject({ started: 1, ended: 0 });
    worker.call(REGISTRATION_NOTIFICATION_CLICK_DONE, clickId);
    expect(worker.tasks).toMatchObject({ started: 1, ended: 1 });
  });

  test("a click whose handler never finishes lets the worker go after a minute", async () => {
    const { host, opened } = fakeHost();
    fakeGuest(host);
    const worker = startWorker(SCOPE);
    await worker.ask(REGISTRATION_NOTIFICATION_SHOW, notification());
    jest.useFakeTimers();
    try {
      click(host, opened()[0]!.ref);
      // Only microtasks: the fake timers hold setImmediate.
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(worker.tasks).toMatchObject({ started: 1, ended: 0 });
      jest.advanceTimersByTime(60_000);
      expect(worker.tasks).toMatchObject({ started: 1, ended: 1 });
    } finally {
      jest.useRealTimers();
    }
  });

  test("a click on a worker that can't take a task does nothing", async () => {
    const { host, opened } = fakeHost();
    fakeGuest(host);
    const worker = startWorker(SCOPE);
    await worker.ask(REGISTRATION_NOTIFICATION_SHOW, notification());
    worker.tasks.failing = true;
    const consoleError = console.error;
    console.error = () => {};
    try {
      click(host, opened()[0]!.ref);
      await microtasksDone();
    } finally {
      console.error = consoleError;
    }
    expect(worker.sent).toEqual([]);
    expect(worker.call(REGISTRATION_NOTIFICATION_OPEN_WINDOW, `${SITE}/x`).result).toBe(false);
  });

  test("after a click, the worker opens one http tab next to the notification's panel", async () => {
    const { host, opened, tabs } = fakeHost();
    const { guest } = fakeGuest(host);
    const worker = startWorker(SCOPE);
    const openWindow = (url: unknown) =>
      worker.call(REGISTRATION_NOTIFICATION_OPEN_WINDOW, url).result;
    expect(openWindow(`${SITE}/builds/1`)).toBe(false);

    await worker.ask(REGISTRATION_NOTIFICATION_SHOW, notification());
    click(host, opened()[0]!.ref);
    await microtasksDone();
    // A refused URL doesn't use up the click.
    expect(openWindow("javascript:alert(1)")).toBe(false);
    expect(openWindow(`${SITE}/builds/1`)).toBe(true);
    expect(openWindow(`${SITE}/builds/2`)).toBe(false);
    expect(tabs()).toEqual([[guest.id, `${SITE}/builds/1`, false]]);
  });

  test("the worker can't open a tab once the click is 5 seconds old", async () => {
    const { host, opened } = fakeHost();
    fakeGuest(host);
    const worker = startWorker(SCOPE);
    await worker.ask(REGISTRATION_NOTIFICATION_SHOW, notification());
    const now = Date.now();
    setSystemTime(now);
    try {
      click(host, opened()[0]!.ref);
      await microtasksDone();
      setSystemTime(now + 5_000);
      expect(worker.call(REGISTRATION_NOTIFICATION_OPEN_WINDOW, `${SITE}/x`).result).toBe(false);
    } finally {
      setSystemTime();
    }
  });

  test("a click on a notification whose worker was unregistered does nothing", async () => {
    const { host, opened } = fakeHost();
    fakeGuest(host);
    const worker = startWorker(SCOPE);
    await worker.ask(REGISTRATION_NOTIFICATION_SHOW, notification());
    workersByVersion.clear();
    click(host, opened()[0]!.ref);
    await microtasksDone();
    expect(worker.sent).toEqual([]);
  });
});
