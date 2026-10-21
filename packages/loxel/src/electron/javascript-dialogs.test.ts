import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { IpcMainEvent, WebContents, WebFrameMain, WebPreferences } from "electron";

import {
  JAVASCRIPT_DIALOG_CLOSED,
  JAVASCRIPT_DIALOG_LISTEN,
  JAVASCRIPT_DIALOG_OPEN,
  JAVASCRIPT_DIALOG_RESPOND,
  JAVASCRIPT_DIALOG_RUN,
} from "./ipc-channels";
import {
  type JavaScriptDialogRequest,
  type JavaScriptDialogResponse,
  javaScriptDialogRequestSchema,
} from "./javascript-dialog-protocol";

type Handler = (event: IpcMainEvent, value?: unknown) => void;
const ipcHandlers = new Map<string, Handler>();
void mock.module("electron", () => ({
  ipcMain: { on: (channel: string, handler: Handler) => ipcHandlers.set(channel, handler) },
}));

const { configureWebviewDialogs, installJavaScriptDialogs, trackWebviewDialogs } =
  await import("./javascript-dialogs");
installJavaScriptDialogs();

let nextContentsId = 1;

type Listener = (...args: unknown[]) => void;

/** `on` / `once` / `off` and a way to fire the registered listeners. */
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
    listenerCount: (name: string) => listeners.get(name)?.length ?? 0,
  };
}

function frame(origin: string, fields: Partial<WebFrameMain> = {}): WebFrameMain {
  return { origin, detached: false, ...fields } as WebFrameMain;
}

/** A window renderer that records what main sends it; listening for dialogs unless told not to. */
function fakeHost({ listening = true } = {}) {
  const sent: { channel: string; payload: unknown }[] = [];
  const emitter = fakeEmitter();
  const host = {
    ...emitter,
    id: nextContentsId++,
    mainFrame: frame("http://127.0.0.1:7433"),
    isDestroyed: () => false,
    send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
  } as unknown as WebContents;
  const listen = () =>
    ipcHandlers.get(JAVASCRIPT_DIALOG_LISTEN)!({
      sender: host,
      senderFrame: host.mainFrame,
    } as unknown as IpcMainEvent);
  if (listening) listen();
  const requests = () =>
    sent
      .filter((m) => m.channel === JAVASCRIPT_DIALOG_OPEN)
      .map((m) => javaScriptDialogRequestSchema.parse(m.payload));
  return { host, sent, requests, listen, emit: emitter.emit, listenerCount: emitter.listenerCount };
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
  trackWebviewDialogs(guest);
  return { guest, mainFrame, emit: emitter.emit };
}

const mainFrameNavigation = { isMainFrame: true, isSameDocument: false };

/** The page calling a dialog function; `returnValue` is what the function returns. */
function run(
  guest: WebContents,
  call: { type: string; message?: string; defaultValue?: string },
  senderFrame: WebFrameMain | null = guest.mainFrame,
) {
  const event = { sender: guest, senderFrame, returnValue: undefined as unknown };
  ipcHandlers.get(JAVASCRIPT_DIALOG_RUN)!(event as unknown as IpcMainEvent, {
    message: "",
    defaultValue: "",
    ...call,
  });
  return event;
}

function respond(
  sender: WebContents,
  response: Partial<JavaScriptDialogResponse> & { id: number },
) {
  const event = { sender, senderFrame: sender.mainFrame };
  ipcHandlers.get(JAVASCRIPT_DIALOG_RESPOND)!(event as unknown as IpcMainEvent, {
    accepted: true,
    value: "",
    suppress: false,
    ...response,
  });
}

const closedMessages = (sent: { channel: string }[]) =>
  sent.filter((m) => m.channel === JAVASCRIPT_DIALOG_CLOSED);

let host: ReturnType<typeof fakeHost>;
beforeEach(() => {
  host = fakeHost();
});

describe("configureWebviewDialogs", () => {
  test("loads the dialog preload sandboxed in every frame, with native dialogs off", () => {
    const prefs: WebPreferences = {};
    configureWebviewDialogs(prefs);
    expect(prefs.preload).toEndWith("webview-preload.cjs");
    expect(prefs.sandbox).toBe(true);
    expect(prefs.nodeIntegrationInSubFrames).toBe(true);
    expect(prefs.disableDialogs).toBe(true);
  });
});

describe("page dialogs", () => {
  test("a prompt is shown in the hosting window and returns the entered text", () => {
    const { guest } = fakeGuest(host.host);
    const event = run(guest, { type: "prompt", message: "Name?", defaultValue: "Ada" });
    expect(event.returnValue).toBeUndefined(); // the page is blocked until the answer

    const [request] = host.requests();
    expect(request).toMatchObject({
      webContentsId: guest.id,
      type: "prompt",
      title: "localhost:5173 says",
      message: "Name?",
      defaultValue: "Ada",
      canSuppress: false,
    } satisfies Partial<JavaScriptDialogRequest>);

    respond(host.host, { id: request!.id, accepted: true, value: "Grace" });
    expect(event.returnValue).toBe("Grace");
  });

  test("cancelling returns what browsers return", () => {
    const { guest } = fakeGuest(host.host);
    const prompt = run(guest, { type: "prompt" });
    const confirm = run(guest, { type: "confirm" });
    const alert = run(guest, { type: "alert" });
    for (const request of host.requests()) {
      respond(host.host, { id: request.id, accepted: false, value: "ignored" });
    }
    expect(prompt.returnValue).toBeNull();
    expect(confirm.returnValue).toBe(false);
    expect(alert.returnValue).toBeNull();
  });

  test("an accepted confirm returns true", () => {
    const { guest } = fakeGuest(host.host);
    const event = run(guest, { type: "confirm" });
    respond(host.host, { id: host.requests()[0]!.id, accepted: true });
    expect(event.returnValue).toBe(true);
  });

  test("only the window's own document can answer a dialog", () => {
    const { guest } = fakeGuest(host.host);
    const event = run(guest, { type: "confirm" });
    const id = host.requests()[0]!.id;
    respond(fakeHost().host, { id });
    respond(guest, { id });
    const fromSubframe = { sender: host.host, senderFrame: frame("http://127.0.0.1:7433") };
    ipcHandlers.get(JAVASCRIPT_DIALOG_RESPOND)!(fromSubframe as unknown as IpcMainEvent, {
      id,
      accepted: true,
      value: "",
      suppress: false,
    });
    expect(event.returnValue).toBeUndefined();
    respond(host.host, { id, accepted: false });
    expect(event.returnValue).toBe(false);
  });

  test("names iframes from another origin, and pages without a web origin", () => {
    const { guest } = fakeGuest(host.host);
    run(guest, { type: "alert" }, frame("https://ads.example.com"));
    run(guest, { type: "alert" }, frame("http://localhost:5173"));
    run(guest, { type: "alert" }, frame("null"));
    run(fakeGuest(host.host, "file://").guest, { type: "alert" });
    expect(host.requests().map((r) => r.title)).toEqual([
      "An embedded page at ads.example.com says",
      "localhost:5173 says",
      "An embedded page on this page says",
      "This page says",
    ]);
  });

  test("cuts very long text", () => {
    const { guest } = fakeGuest(host.host);
    run(guest, { type: "prompt", message: "x".repeat(50_000), defaultValue: "y".repeat(50_000) });
    const [request] = host.requests();
    expect(request!.message).toHaveLength(10_001);
    expect(request!.message).toEndWith("…");
    expect(request!.defaultValue).toHaveLength(10_001);
  });

  test("malformed calls, non-webview senders and gone frames get no dialog", () => {
    const { guest } = fakeGuest(host.host);
    expect(run(guest, { type: "print" }).returnValue).toBeNull();

    const window = {
      id: nextContentsId++,
      getType: () => "window",
      mainFrame: frame("http://localhost:5173"),
    } as unknown as WebContents;
    expect(run(window, { type: "confirm" }).returnValue).toBe(false);
    expect(run(guest, { type: "confirm" }, null).returnValue).toBe(false);
    const detached = frame("http://a.test", { detached: true });
    expect(run(guest, { type: "confirm" }, detached).returnValue).toBe(false);
    expect(host.requests()).toHaveLength(0);
  });

  test("a window renderer that doesn't show dialogs leaves pages unblocked", () => {
    const old = fakeHost({ listening: false });
    const { guest } = fakeGuest(old.host);
    expect(run(guest, { type: "confirm" }).returnValue).toBe(false);
    expect(old.requests()).toHaveLength(0);

    old.listen();
    run(guest, { type: "confirm" });
    expect(old.requests()).toHaveLength(1);

    // A navigation the window starts and cancels (an external link) keeps its document.
    old.emit("did-start-navigation", mainFrameNavigation);
    run(guest, { type: "confirm" });
    expect(old.requests()).toHaveLength(2);

    // A reloaded window renderer must subscribe again.
    old.emit("did-navigate");
    expect(run(guest, { type: "prompt" }).returnValue).toBeNull();
    expect(old.requests()).toHaveLength(2);
    old.listen();
    run(guest, { type: "confirm" });
    expect(old.requests()).toHaveLength(3);
    // Each document's subscription removes its listeners when it ends.
    expect(old.listenerCount("did-navigate")).toBe(1);
    expect(old.listenerCount("destroyed")).toBe(1);
    old.emit("destroyed");
    expect(old.listenerCount("did-navigate")).toBe(0);
    expect(old.listenerCount("destroyed")).toBe(0);
  });
});

describe("abuse protection", () => {
  test("from the second dialog on, the user can block the page's dialogs", () => {
    const { guest } = fakeGuest(host.host);
    run(guest, { type: "alert" });
    respond(host.host, { id: host.requests()[0]!.id });
    run(guest, { type: "alert" });
    const second = host.requests()[1]!;
    expect(second.canSuppress).toBe(true);
    respond(host.host, { id: second.id, suppress: true });

    expect(run(guest, { type: "confirm" }).returnValue).toBe(false);
    expect(run(guest, { type: "prompt" }).returnValue).toBeNull();
    expect(host.requests()).toHaveLength(2);
  });

  test("blocking also dismisses the page's other queued dialogs", () => {
    const { guest } = fakeGuest(host.host);
    run(guest, { type: "alert" }, frame("https://a.example.com"));
    const second = run(guest, { type: "confirm" }, frame("https://b.example.com"));
    const third = run(guest, { type: "prompt" }, frame("https://c.example.com"));
    respond(host.host, { id: host.requests()[0]!.id, suppress: true });

    expect(second.returnValue).toBe(false);
    expect(third.returnValue).toBeNull();
    expect(closedMessages(host.sent)).toHaveLength(2);
  });

  test("blocking is lifted, and the count reset, when the page navigates", () => {
    const { guest, emit } = fakeGuest(host.host);
    run(guest, { type: "alert" });
    run(guest, { type: "alert" });
    for (const request of host.requests()) respond(host.host, { id: request.id, suppress: true });
    emit("did-navigate");

    run(guest, { type: "alert" });
    expect(host.requests()).toHaveLength(3);
    expect(host.requests()[2]!.canSuppress).toBe(false);
  });

  test("a page's dialogs are dismissed when its main frame starts navigating", () => {
    const { guest, emit } = fakeGuest(host.host);
    const event = run(guest, { type: "prompt" });
    const id = host.requests()[0]!.id;

    emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
    emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
    expect(event.returnValue).toBeUndefined();

    emit("did-start-navigation", mainFrameNavigation);
    expect(event.returnValue).toBeNull();
    expect(host.sent.at(-1)).toEqual({
      channel: JAVASCRIPT_DIALOG_CLOSED,
      payload: { id, webContentsId: guest.id },
    });
    // A late answer for the withdrawn dialog is ignored.
    respond(host.host, { id, value: "late" });
    expect(event.returnValue).toBeNull();
  });

  test("the page being left gets no new dialogs until the navigation ends", () => {
    const { guest, emit } = fakeGuest(host.host);
    emit("did-start-navigation", mainFrameNavigation);
    expect(run(guest, { type: "confirm" }).returnValue).toBe(false);
    expect(host.requests()).toHaveLength(0);

    // A navigation that doesn't commit (a download, a 204) leaves the page in place.
    emit("did-stop-loading");
    run(guest, { type: "confirm" });
    expect(host.requests()).toHaveLength(1);

    emit("did-start-navigation", mainFrameNavigation);
    emit("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", "https://nope.test", true);
    run(guest, { type: "confirm" });
    expect(host.requests()).toHaveLength(2);
  });

  test("dialogs from frames of the old document are dismissed when the new one commits", () => {
    const { guest, emit } = fakeGuest(host.host);
    const oldFrame = frame("https://old.example.com");
    const fromOld = run(guest, { type: "confirm" }, oldFrame);
    const fromLive = run(guest, { type: "confirm" }, frame("https://ads.example.com"));
    Object.assign(oldFrame, { detached: true });
    emit("did-navigate");

    expect(fromOld.returnValue).toBe(false);
    expect(fromLive.returnValue).toBeUndefined();
  });

  test("a crashed or destroyed page's dialogs are withdrawn from the window", () => {
    const { guest, emit } = fakeGuest(host.host);
    const crashed = run(guest, { type: "confirm" });
    emit("render-process-gone");
    expect(crashed.returnValue).toBe(false);

    run(guest, { type: "prompt" });
    emit("destroyed");
    expect(closedMessages(host.sent)).toHaveLength(2);
  });
});
