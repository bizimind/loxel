import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { IpcMainEvent, MediaAccessPermissionRequest, WebContents } from "electron";

import {
  type MediaDevice,
  type MediaPermissionAnswer,
  type MediaSites,
  mediaPermissionRequestSchema,
  mediaSystemBlockedSchema,
  parseMediaSites,
  withMediaDecision,
} from "./browser-media-protocol";
import {
  BROWSER_MEDIA_LISTEN,
  BROWSER_MEDIA_OPEN_SYSTEM_SETTINGS,
  BROWSER_MEDIA_PERMISSION,
  BROWSER_MEDIA_PERMISSION_REQUEST,
  BROWSER_MEDIA_PERMISSION_RESPOND,
  BROWSER_MEDIA_PERMISSION_WITHDRAWN,
  BROWSER_MEDIA_SET_SITES,
  BROWSER_MEDIA_SYSTEM_BLOCKED,
} from "./ipc-channels";

type Handler = (event: IpcMainEvent, value?: unknown) => unknown;
const ipcHandlers = new Map<string, Handler>();
type SystemStatus = "not-determined" | "granted" | "denied" | "restricted" | "unknown";
const systemStatus = new Map<MediaDevice, SystemStatus>();
const askForMediaAccess = mock((_device: MediaDevice) => Promise.resolve(true));
const openExternal = mock((_url: string) => Promise.resolve());
void mock.module("electron", () => ({
  ipcMain: {
    on: (channel: string, handler: Handler) => ipcHandlers.set(channel, handler),
    handle: (channel: string, handler: Handler) => ipcHandlers.set(channel, handler),
  },
  shell: { openExternal },
  systemPreferences: {
    getMediaAccessStatus: (device: MediaDevice) => systemStatus.get(device) ?? "granted",
    askForMediaAccess,
  },
}));

const {
  checkMediaPermission,
  deviceState,
  devicesOf,
  installBrowserMedia,
  normalizeOrigin,
  requestMediaPermission,
  requestState,
  trackWebviewMedia,
} = await import("./browser-media");
installBrowserMedia();

const handler = (channel: string) => ipcHandlers.get(channel)!;

let nextContentsId = 1;
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

const windowEvent = (sender: WebContents) => ({ sender }) as unknown as IpcMainEvent;

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
  if (listening) handler(BROWSER_MEDIA_LISTEN)(windowEvent(host));
  const of = (channel: string) => sent.filter((m) => m.channel === channel).map((m) => m.payload);
  return {
    host,
    requests: () =>
      of(BROWSER_MEDIA_PERMISSION_REQUEST).map((p) => mediaPermissionRequestSchema.parse(p)),
    withdrawn: () => of(BROWSER_MEDIA_PERMISSION_WITHDRAWN),
    systemBlocked: () =>
      of(BROWSER_MEDIA_SYSTEM_BLOCKED).map((p) => mediaSystemBlockedSchema.parse(p)),
    respond: (id: number, answer: MediaPermissionAnswer) =>
      handler(BROWSER_MEDIA_PERMISSION_RESPOND)(windowEvent(host), { id, answer }),
  };
}

/** A webview guest hosted by `host`, whose page can navigate to another origin. */
function fakeGuest(host: WebContents, origin = "https://meet.example") {
  const emitter = fakeEmitter();
  const mainFrame = { origin, detached: false };
  const guest = {
    ...emitter,
    id: nextContentsId++,
    getType: () => "webview",
    isDestroyed: () => false,
    hostWebContents: host,
    mainFrame,
  } as unknown as WebContents;
  trackWebviewMedia(guest);
  const navigate = (to: string) => {
    emitter.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    mainFrame.origin = to;
    emitter.emit("did-navigate");
  };
  return { guest, mainFrame, navigate, emit: emitter.emit };
}

/** The page calls `getUserMedia()`; resolves with whether main granted it. */
function getUserMedia(guest: WebContents, mediaTypes: ("video" | "audio")[]) {
  return new Promise<boolean>((resolve) => {
    const details = { mediaTypes, isMainFrame: true } as unknown as MediaAccessPermissionRequest;
    requestMediaPermission(guest, details, resolve);
  });
}

/** Until main has sent the window the prompt the page's request waits on. */
async function nextRequest(requests: () => unknown[], count: number) {
  for (let turn = 0; requests().length < count; turn++) {
    if (turn > 1000) throw new Error(`main sent ${requests().length} of ${count} prompts`);
    await Promise.resolve();
  }
}

function setSites(sites: MediaSites) {
  const settings = fakeHost({ listening: false });
  handler(BROWSER_MEDIA_SET_SITES)(windowEvent(settings.host), sites);
}

const pageStates = (guest: WebContents, frameOrigin?: string) => {
  const event = {
    sender: guest,
    senderFrame: { origin: frameOrigin ?? guest.mainFrame.origin, detached: false },
    returnValue: undefined as unknown,
  };
  handler(BROWSER_MEDIA_PERMISSION)(event as unknown as IpcMainEvent);
  return event.returnValue;
};

const realPlatform = process.platform;
const setPlatform = (platform: NodeJS.Platform) =>
  Object.defineProperty(process, "platform", { value: platform });

beforeEach(() => {
  setSites({});
  systemStatus.clear();
  askForMediaAccess.mockClear();
  openExternal.mockClear();
  setPlatform("darwin");
});

afterEach(() => setPlatform(realPlatform));

describe("decisions", () => {
  test("a saved decision wins, then the panel's one-time grant, otherwise the site asks", () => {
    const sites: MediaSites = { "https://a.example": { camera: "block" } };
    const once = {
      origin: "https://a.example",
      devices: new Set<MediaDevice>(["camera", "microphone"]),
    };
    expect(deviceState(sites, once, "https://a.example", "camera")).toBe("block");
    expect(deviceState(sites, once, "https://a.example", "microphone")).toBe("allow");
    expect(deviceState(sites, once, "https://b.example", "microphone")).toBe("ask");
  });

  test("a request is refused when any device is blocked, and granted when all are allowed", () => {
    expect(requestState(["allow", "block"])).toBe("block");
    expect(requestState(["allow", "ask"])).toBe("ask");
    expect(requestState(["allow", "allow"])).toBe("allow");
  });

  test("names devices and origins as pages do", () => {
    expect(devicesOf(["audio", "video", "audio"])).toEqual(["microphone", "camera"]);
    expect(normalizeOrigin("https://meet.example/")).toBe("https://meet.example");
    expect(normalizeOrigin("data:text/html,hi")).toBeNull();
    expect(normalizeOrigin("not a url")).toBeNull();
  });

  test("stored decisions keep only known devices and decisions", () => {
    expect(
      parseMediaSites({
        "https://a.example": { camera: "allow", microphone: "sometimes", screen: "allow" },
        "https://b.example": { speaker: "allow" },
        "https://c.example": "allow",
      }),
    ).toEqual({ "https://a.example": { camera: "allow" } });
    const sites = withMediaDecision({}, "https://a.example", ["camera", "microphone"], "allow");
    expect(withMediaDecision(sites, "https://a.example", ["camera", "microphone"], null)).toEqual(
      {},
    );
  });
});

describe("requests", () => {
  test("a site without a decision asks in the page's panel, and Allow is kept", async () => {
    const window = fakeHost();
    const { guest } = fakeGuest(window.host);
    const granted = getUserMedia(guest, ["audio", "video"]);
    await nextRequest(window.requests, 1);
    const [request] = window.requests();
    expect(request).toEqual({
      id: request!.id,
      webContentsId: guest.id,
      origin: "https://meet.example",
      devices: ["microphone", "camera"],
    });
    window.respond(request!.id, "allow");
    expect(await granted).toBe(true);
    expect(window.withdrawn()).toEqual([{ id: request!.id, webContentsId: guest.id }]);
    // Answered from the decision now, without asking.
    expect(await getUserMedia(guest, ["video"])).toBe(true);
    expect(window.requests()).toHaveLength(1);
    expect(pageStates(guest)).toEqual({ camera: "granted", microphone: "granted" });
  });

  test("Block refuses, now and next time, without asking again", async () => {
    const window = fakeHost();
    const { guest } = fakeGuest(window.host);
    const granted = getUserMedia(guest, ["video"]);
    await nextRequest(window.requests, 1);
    window.respond(window.requests()[0]!.id, "block");
    expect(await granted).toBe(false);
    expect(await getUserMedia(guest, ["video"])).toBe(false);
    expect(window.requests()).toHaveLength(1);
    expect(pageStates(guest)).toEqual({ camera: "denied", microphone: "prompt" });
  });

  test("Not now refuses this request only, so the page may ask again", async () => {
    const window = fakeHost();
    const { guest } = fakeGuest(window.host);
    const granted = getUserMedia(guest, ["video"]);
    await nextRequest(window.requests, 1);
    window.respond(window.requests()[0]!.id, "dismiss");
    expect(await granted).toBe(false);
    void getUserMedia(guest, ["video"]);
    await nextRequest(window.requests, 2);
    expect(pageStates(guest)).toEqual({ camera: "prompt", microphone: "prompt" });
  });

  test("a device blocked for the site refuses a request for both", async () => {
    setSites({ "https://meet.example": { microphone: "block" } });
    const window = fakeHost();
    const { guest } = fakeGuest(window.host);
    expect(await getUserMedia(guest, ["audio", "video"])).toBe(false);
    expect(window.requests()).toEqual([]);
  });

  test("asking for another device while the prompt is up asks for both in it", async () => {
    const window = fakeHost();
    const { guest } = fakeGuest(window.host);
    const microphone = getUserMedia(guest, ["audio"]);
    await nextRequest(window.requests, 1);
    const camera = getUserMedia(guest, ["video"]);
    await nextRequest(window.requests, 2);
    const [first, second] = window.requests();
    expect(second).toEqual({ ...first!, devices: ["microphone", "camera"] });
    window.respond(first!.id, "allow");
    expect([await microphone, await camera]).toEqual([true, true]);
  });

  test("Allow this time lasts while the panel stays on the site", async () => {
    const window = fakeHost();
    const { guest, navigate } = fakeGuest(window.host);
    const granted = getUserMedia(guest, ["video"]);
    await nextRequest(window.requests, 1);
    window.respond(window.requests()[0]!.id, "allow-once");
    expect(await granted).toBe(true);
    navigate("https://meet.example");
    expect(await getUserMedia(guest, ["video"])).toBe(true);
    expect(pageStates(guest)).toEqual({ camera: "granted", microphone: "prompt" });
    navigate("https://other.example");
    navigate("https://meet.example");
    void getUserMedia(guest, ["video"]);
    await nextRequest(window.requests, 2);
  });

  test("a page that navigates away gets no answer, and its prompt is withdrawn", async () => {
    const window = fakeHost();
    const { guest, navigate } = fakeGuest(window.host);
    const granted = getUserMedia(guest, ["video"]);
    await nextRequest(window.requests, 1);
    navigate("https://other.example");
    expect(await granted).toBe(false);
    expect(window.withdrawn()).toHaveLength(1);
  });

  test("a decision saved in settings answers the open prompt", async () => {
    const window = fakeHost();
    const { guest } = fakeGuest(window.host);
    const granted = getUserMedia(guest, ["video"]);
    await nextRequest(window.requests, 1);
    setSites({ "https://meet.example": { camera: "allow" } });
    expect(await granted).toBe(true);
    expect(window.withdrawn()).toHaveLength(1);
  });

  test("insecure pages, and windows that don't ask, are refused without a prompt", async () => {
    const window = fakeHost();
    expect(await getUserMedia(fakeGuest(window.host, "http://meet.example").guest, ["video"])).toBe(
      false,
    );
    const silent = fakeHost({ listening: false });
    expect(await getUserMedia(fakeGuest(silent.host).guest, ["video"])).toBe(false);
    expect([...window.requests(), ...silent.requests()]).toEqual([]);
  });

  test("an answer from another window is ignored", async () => {
    const window = fakeHost();
    const other = fakeHost();
    const { guest } = fakeGuest(window.host);
    let settled = false;
    void getUserMedia(guest, ["video"]).then(() => {
      settled = true;
    });
    await nextRequest(window.requests, 1);
    other.respond(window.requests()[0]!.id, "allow");
    await Promise.resolve();
    expect(settled).toBe(false);
    window.respond(window.requests()[0]!.id, "dismiss");
  });
});

describe("macOS access", () => {
  test("the first allowed request asks macOS, once for pages asking together", async () => {
    systemStatus.set("camera", "not-determined");
    setSites({ "https://meet.example": { camera: "allow" } });
    const window = fakeHost();
    const { guest } = fakeGuest(window.host);
    const both = await Promise.all([
      getUserMedia(guest, ["video"]),
      getUserMedia(guest, ["video"]),
    ]);
    expect(both).toEqual([true, true]);
    expect(askForMediaAccess).toHaveBeenCalledTimes(1);
    expect(askForMediaAccess).toHaveBeenCalledWith("camera");
  });

  test("with Loxel's access off, the page is refused and the panel says so", async () => {
    systemStatus.set("microphone", "denied");
    setSites({ "https://meet.example": { camera: "allow", microphone: "allow" } });
    const window = fakeHost();
    const { guest } = fakeGuest(window.host);
    expect(await getUserMedia(guest, ["audio", "video"])).toBe(false);
    expect(window.systemBlocked()).toEqual([{ webContentsId: guest.id, devices: ["microphone"] }]);
    expect(askForMediaAccess).not.toHaveBeenCalled();
  });

  test("other systems don't gate it", async () => {
    setPlatform("linux");
    systemStatus.set("camera", "denied");
    setSites({ "https://meet.example": { camera: "allow" } });
    expect(await getUserMedia(fakeGuest(fakeHost().host).guest, ["video"])).toBe(true);
  });

  test("opens the device's System Settings pane, for Loxel's windows only", () => {
    const window = fakeHost();
    const { guest } = fakeGuest(window.host);
    handler(BROWSER_MEDIA_OPEN_SYSTEM_SETTINGS)(windowEvent(guest), "camera");
    handler(BROWSER_MEDIA_OPEN_SYSTEM_SETTINGS)(windowEvent(window.host), "speaker");
    handler(BROWSER_MEDIA_OPEN_SYSTEM_SETTINGS)(windowEvent(window.host), "microphone");
    expect(openExternal.mock.calls).toEqual([
      ["x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"],
    ]);
  });
});

describe("checks and page state", () => {
  test("checks grant the page's own frames what the site is allowed", () => {
    setSites({ "https://meet.example": { camera: "allow" } });
    const { guest } = fakeGuest(fakeHost().host);
    expect(checkMediaPermission(guest, "https://meet.example/", "video")).toBe(true);
    expect(checkMediaPermission(guest, "https://meet.example/", "audio")).toBe(false);
    // Device labels: the page's once it may use either device.
    expect(checkMediaPermission(guest, "https://meet.example/", undefined)).toBe(true);
    expect(checkMediaPermission(guest, "https://embed.example/", "video")).toBe(false);
    expect(checkMediaPermission(null, "https://meet.example/", "video")).toBe(false);
  });

  test("a site's pages read prompt until decided; other frames are left to Chromium", () => {
    const { guest } = fakeGuest(fakeHost().host);
    expect(pageStates(guest)).toEqual({ camera: "prompt", microphone: "prompt" });
    expect(pageStates(guest, "https://embed.example")).toBeNull();
    expect(pageStates(fakeGuest(fakeHost().host, "http://meet.example").guest)).toBeNull();
  });

  test("decisions come only from Loxel's windows", () => {
    const { guest } = fakeGuest(fakeHost().host);
    handler(BROWSER_MEDIA_SET_SITES)(windowEvent(guest), {
      "https://meet.example": { camera: "allow" },
    });
    expect(pageStates(guest)).toEqual({ camera: "prompt", microphone: "prompt" });
  });
});
