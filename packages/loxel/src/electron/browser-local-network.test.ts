import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { IpcMainEvent, Session, WebContents } from "electron";

import {
  SITE_ACCESS_LISTEN,
  SITE_ACCESS_REQUEST,
  SITE_ACCESS_RESPOND,
  SITE_ACCESS_SET_SITES,
  SITE_ACCESS_WITHDRAWN,
} from "./ipc-channels";

type Handler = (event: IpcMainEvent, value?: unknown) => unknown;
const ipcHandlers = new Map<string, Handler>();
const guests = new Map<number, WebContents>();
void mock.module("electron", () => ({
  BrowserWindow: { fromWebContents: (contents: WebContents) => windowOf(contents) },
  ipcMain: {
    on: (channel: string, listener: Handler) => ipcHandlers.set(channel, listener),
    handle: (channel: string, listener: Handler) => ipcHandlers.set(channel, listener),
  },
  webContents: {
    fromId: (id: number) => guests.get(id),
    getAllWebContents: () => [...guests.values()],
  },
}));

const { windowOf } = await import("../test/fake-app-windows");
const { afterMicrotasks, fakeGuest, fakeHost, sendSites } =
  await import("../test/fake-browser-panels");
const { installSiteAccess, trackWebviewSiteAccess } = await import("./browser-site-access");
const { fetchForPage, installLocalNetworkAccess } = await import("./browser-local-network");
installSiteAccess();

const channels = {
  handlers: ipcHandlers,
  listen: SITE_ACCESS_LISTEN,
  setSites: SITE_ACCESS_SET_SITES,
  request: SITE_ACCESS_REQUEST,
  respond: SITE_ACCESS_RESPOND,
  withdrawn: SITE_ACCESS_WITHDRAWN,
};

type Callback = (response: { cancel?: boolean }) => void;
type Listener = (details: object, callback: Callback) => void;
/** What names resolve to, and the proxy each URL goes through; the session asks these. */
const dns = new Map<string, string[]>();
const proxies = new Map<string, string>();
let beforeRequest: Listener = () => {};
let headersReceived: Listener = () => {};
const browserSession = {
  webRequest: {
    onBeforeRequest: (listener: Listener) => {
      beforeRequest = listener;
    },
    onHeadersReceived: (listener: Listener) => {
      headersReceived = listener;
    },
    onCompleted: () => {},
    onErrorOccurred: () => {},
  },
  resolveHost: async (host: string) => {
    const addresses = dns.get(host);
    if (!addresses) throw new Error("ERR_NAME_NOT_RESOLVED");
    return { endpoints: addresses.map((address) => ({ address, family: "ipv4" })) };
  },
  resolveProxy: async (url: string) => proxies.get(new URL(url).host) ?? "DIRECT",
} as unknown as Session;
installLocalNetworkAccess(browserSession);

let nextRequestId = 1;

/** A request's fate: let through (true) or cancelled (false), once main decides. */
function decided(listener: Listener, details: object) {
  let result: boolean | undefined;
  listener(details, (response) => {
    result = !response.cancel;
  });
  return { result: () => result };
}

/** A browser panel on `origin`, its page loaded from `ip`. */
async function panel(origin: string, ip = "93.184.216.34", { listening = true } = {}) {
  const window = fakeHost(channels, { listening });
  const page = fakeGuest(window.host, origin);
  guests.set(page.guest.id, page.guest);
  trackWebviewSiteAccess(page.guest);
  /** Navigate the page to `url`, its document coming from `address`, once main has noted it. */
  const load = async (url: string, address: string) => {
    const response = decided(headersReceived, {
      id: nextRequestId++,
      url,
      resourceType: "mainFrame",
      webContents: page.guest,
      ip: address,
    });
    await settled(response);
    page.navigate(new URL(url).origin);
  };
  await load(`${origin}/`, ip);
  /** The page requests `url` (from its own origin, or `initiator`); resolves with its fate. */
  const request = async (
    url: string,
    { resourceType = "xhr", initiator = page.mainFrame.origin, id = nextRequestId++ } = {},
  ) => {
    const fate = decided(beforeRequest, {
      id,
      url,
      resourceType,
      webContents: page.guest,
      initiatorOrigin: initiator,
    });
    return { id, fate };
  };
  return { ...window, ...page, load, request };
}

/** Until main has decided, or has asked the user in `window`'s panel. */
async function settled(fate: { result: () => boolean | undefined }, asked?: () => number) {
  await afterMicrotasks(
    () => fate.result() !== undefined || (asked !== undefined && asked() > 0),
    "main to decide",
  );
  return fate.result();
}

beforeEach(() => {
  sendSites(channels, {});
  dns.clear();
  proxies.clear();
  dns.set("example.com", ["93.184.216.34"]);
});

describe("pages on this machine", () => {
  test("a dev server's page reaches its API and live reload on other ports without asking", async () => {
    const dev = await panel("http://localhost:3000", "127.0.0.1");
    for (const [url, resourceType] of [
      ["http://localhost:8080/api", "xhr"],
      ["ws://127.0.0.1:24678/", "webSocket"],
      ["http://[::1]:5173/src/main.ts", "script"],
      ["http://192.168.1.1/", "image"],
      ["https://example.com/", "script"],
    ] as const) {
      const { fate } = await dev.request(url, { resourceType });
      expect(await settled(fate)).toBe(true);
    }
    expect(dev.requests()).toEqual([]);
  });
});

describe("public sites", () => {
  test("ask before reaching this machine, holding the requests in one prompt", async () => {
    const site = await panel("https://app.example");
    const first = await site.request("http://localhost:8080/api");
    const second = await site.request("ws://localhost:8080/live", { resourceType: "webSocket" });
    await afterMicrotasks(() => site.requests().length === 1, "the prompt");
    expect(first.fate.result()).toBeUndefined();
    const [prompt] = site.requests();
    expect(prompt!.access).toEqual({ kind: "local-network", origin: "https://app.example" });
    site.respond(prompt!.id, "allow");
    expect(await settled(first.fate)).toBe(true);
    expect(await settled(second.fate)).toBe(true);
    // Saved: the next request goes straight through.
    const third = await site.request("http://192.168.1.1/status");
    expect(await settled(third.fate)).toBe(true);
    expect(site.requests()).toHaveLength(1);
  });

  test("Block fails the held request and the ones after it", async () => {
    const site = await panel("https://ads.example");
    const held = await site.request("http://192.168.0.1/");
    await afterMicrotasks(() => site.requests().length === 1, "the prompt");
    site.respond(site.requests()[0]!.id, "block");
    expect(await settled(held.fate)).toBe(false);
    const next = await site.request("http://127.0.0.1:9000/");
    expect(await settled(next.fate)).toBe(false);
    expect(site.requests()).toHaveLength(1);
  });

  test("Not now fails them, without asking again until the page navigates", async () => {
    const site = await panel("https://app.example");
    const held = await site.request("http://localhost:1/");
    await afterMicrotasks(() => site.requests().length === 1, "the prompt");
    site.respond(site.requests()[0]!.id, "dismiss");
    expect(await settled(held.fate)).toBe(false);
    const again = await site.request("http://localhost:1/");
    expect(await settled(again.fate)).toBe(false);
    await site.load("https://app.example/next", "93.184.216.34");
    void site.request("http://localhost:1/");
    await afterMicrotasks(() => site.requests().length === 2, "a new prompt");
  });

  test("Allow this time lasts while the panel stays on the site", async () => {
    const site = await panel("https://app.example");
    const held = await site.request("http://localhost:1/");
    await afterMicrotasks(() => site.requests().length === 1, "the prompt");
    site.respond(site.requests()[0]!.id, "allow-once");
    expect(await settled(held.fate)).toBe(true);
    await site.load("https://app.example/other", "93.184.216.34");
    expect(await settled((await site.request("http://localhost:1/")).fate)).toBe(true);
    await site.load("https://elsewhere.example/", "93.184.216.34");
    await site.load("https://app.example/", "93.184.216.34");
    void site.request("http://localhost:1/");
    await afterMicrotasks(() => site.requests().length === 2, "a new prompt");
  });

  test("held requests fail when the page navigates away", async () => {
    const site = await panel("https://app.example");
    const held = await site.request("http://localhost:1/");
    await afterMicrotasks(() => site.requests().length === 1, "the prompt");
    site.navigate("https://elsewhere.example");
    expect(await settled(held.fate)).toBe(false);
    expect(site.withdrawn()).toHaveLength(1);
  });

  test("top-level navigations and public requests aren't gated", async () => {
    const site = await panel("https://app.example");
    const navigation = await site.request("http://localhost:3000/", { resourceType: "mainFrame" });
    expect(await settled(navigation.fate)).toBe(true);
    const cdn = await site.request("https://example.com/lib.js", { resourceType: "script" });
    expect(await settled(cdn.fate)).toBe(true);
    const unknown = await site.request("https://nowhere.invalid/");
    expect(await settled(unknown.fate)).toBe(true);
    expect(site.requests()).toEqual([]);
  });

  test("a public name that resolves to this machine counts as this machine", async () => {
    dns.set("dev.localtest.example", ["127.0.0.1"]);
    const site = await panel("https://app.example");
    const held = await site.request("http://dev.localtest.example:8080/");
    expect(await settled(held.fate, () => site.requests().length)).toBeUndefined();
    expect(site.requests()).toHaveLength(1);
  });

  test("embedded frames follow the top-level site's decision", async () => {
    sendSites(channels, { localNetwork: { "https://app.example": "block" } });
    const site = await panel("https://app.example");
    const fromFrame = await site.request("http://localhost:1/", {
      initiator: "https://widget.example",
      resourceType: "subFrame",
    });
    expect(await settled(fromFrame.fate)).toBe(false);
    sendSites(channels, { localNetwork: { "https://app.example": "allow" } });
    const allowed = await site.request("http://localhost:1/", { initiator: "null" });
    expect(await settled(allowed.fate)).toBe(true);
  });

  test("a popup window, with no panel to ask in, is refused undecided access", async () => {
    const window = fakeHost(channels);
    const popup = fakeGuest(window.host, "https://app.example", "window");
    const fate = decided(beforeRequest, {
      id: nextRequestId++,
      url: "http://localhost:1/",
      resourceType: "xhr",
      webContents: popup.guest,
      initiatorOrigin: "https://app.example",
    });
    expect(await settled(fate)).toBe(false);
  });
});

describe("a page's own address space", () => {
  test("is the address its document came from, for the document's life", async () => {
    dns.set("intranet.example", ["10.0.0.5"]);
    const intranet = await panel("https://intranet.example", "10.0.0.5");
    const printer = await intranet.request("http://192.168.1.20/");
    expect(await settled(printer.fate)).toBe(true);
    // A local network page reaches this machine too, as a dev server on its LAN address does.
    const api = await intranet.request("http://localhost:1/");
    expect(await settled(api.fate)).toBe(true);
    expect(intranet.requests()).toEqual([]);

    // A public page whose name later resolves to the local network stays public.
    dns.set("rebind.example", ["93.184.216.34"]);
    const site = await panel("https://rebind.example", "93.184.216.34");
    dns.set("rebind.example", ["192.168.1.1"]);
    void site.request("http://192.168.1.1/");
    await afterMicrotasks(() => site.requests().length === 1, "the prompt");
  });

  test("a response from a more private address than its request was let through for is refused", async () => {
    dns.set("api.example", ["93.184.216.34"]);
    const site = await panel("https://app.example");
    const { id, fate } = await site.request("https://api.example/data");
    expect(await settled(fate)).toBe(true);
    const response = decided(headersReceived, {
      id,
      url: "https://api.example/data",
      resourceType: "xhr",
      webContents: site.guest,
      ip: "192.168.1.1",
    });
    expect(await settled(response)).toBe(false);

    // Through a proxy on this machine, the address is the proxy's.
    proxies.set("cdn.example", "PROXY 127.0.0.1:8888");
    dns.set("cdn.example", ["93.184.216.35"]);
    const proxied = await site.request("https://cdn.example/lib.js");
    expect(await settled(proxied.fate)).toBe(true);
    const viaProxy = decided(headersReceived, {
      id: proxied.id,
      url: "https://cdn.example/lib.js",
      resourceType: "script",
      webContents: site.guest,
      ip: "127.0.0.1",
    });
    expect(await settled(viaProxy)).toBe(true);
  });
});

describe("review cases", () => {
  test("a response that never commits leaves the page's own space", async () => {
    dns.set("intranet2.example", ["10.0.0.6"]);
    const intranet = await panel("https://intranet2.example", "10.0.0.6");
    // A download or a 204 the page navigated to: its response arrives, but nothing commits.
    const response = decided(headersReceived, {
      id: nextRequestId++,
      url: "https://files.example/report.pdf",
      resourceType: "mainFrame",
      webContents: intranet.guest,
      ip: "93.184.216.34",
    });
    expect(await settled(response)).toBe(true);
    const printer = await intranet.request("http://192.168.1.20/");
    expect(await settled(printer.fate)).toBe(true);
  });

  test("a `.local` page served from this machine counts as this machine", async () => {
    const dev = await panel("http://mymac.local:3000", "127.0.0.1");
    const api = await dev.request("http://localhost:8080/api");
    expect(await settled(api.fate)).toBe(true);
    expect(dev.requests()).toEqual([]);
  });

  test("a caller with no document seen counts by its least private address", async () => {
    // A name that resolves to a public address and to this machine stays public.
    dns.set("dual.example", ["93.184.216.40", "127.0.0.1"]);
    const fromWorker = decided(beforeRequest, {
      id: nextRequestId++,
      url: "http://192.168.1.1/",
      resourceType: "other",
      initiatorOrigin: "https://dual.example",
    });
    expect(await settled(fromWorker)).toBe(false);
    // A dev server on a hosts-file name, all of whose addresses are this machine, stays local.
    dns.set("app.test", ["127.0.0.1"]);
    const fromDevWorker = decided(beforeRequest, {
      id: nextRequestId++,
      url: "http://localhost:8080/",
      resourceType: "other",
      initiatorOrigin: "http://app.test",
    });
    expect(await settled(fromDevWorker)).toBe(true);
  });

  test("a request nobody made counts as a public site's that can't be asked", async () => {
    const local = decided(beforeRequest, {
      id: nextRequestId++,
      url: "http://localhost:1/",
      resourceType: "other",
    });
    expect(await settled(local)).toBe(false);
    const remote = decided(beforeRequest, {
      id: nextRequestId++,
      url: "https://example.com/",
      resourceType: "other",
    });
    expect(await settled(remote)).toBe(true);
  });
});

describe("requests of no page", () => {
  test("a worker's are decided by its origin, asking in a panel showing it", async () => {
    const site = await panel("https://worker.example");
    const fromWorker = decided(beforeRequest, {
      id: nextRequestId++,
      url: "http://localhost:1/",
      resourceType: "other",
      initiatorOrigin: "https://worker.example",
    });
    await afterMicrotasks(() => site.requests().length === 1, "the prompt");
    site.respond(site.requests()[0]!.id, "allow");
    expect(await settled(fromWorker)).toBe(true);

    const noPanel = decided(beforeRequest, {
      id: nextRequestId++,
      url: "http://localhost:1/",
      resourceType: "other",
      initiatorOrigin: "https://unshown.example",
    });
    expect(await settled(noPanel)).toBe(false);
  });

  test("main's fetches for a page follow its decision without asking, redirects included", async () => {
    const done = fetchForPage("https://example.com/favicon.ico", "https://app.example/");
    const id = nextRequestId++;
    const first = decided(beforeRequest, {
      id,
      url: "https://example.com/favicon.ico",
      resourceType: "other",
    });
    expect(await settled(first)).toBe(true);
    const redirected = decided(beforeRequest, {
      id,
      url: "http://192.168.1.1/x.ico",
      resourceType: "other",
    });
    expect(await settled(redirected)).toBe(false);
    done();

    const releaseDev = fetchForPage("http://localhost:3000/favicon.ico", "http://localhost:3000/");
    const dev = decided(beforeRequest, {
      id: nextRequestId++,
      url: "http://localhost:3000/favicon.ico",
      resourceType: "other",
    });
    expect(await settled(dev)).toBe(true);
    releaseDev();

    // Without a page, a fetch counts as a public site's.
    const releaseNone = fetchForPage("http://localhost:3000/favicon.ico", undefined);
    const none = decided(beforeRequest, {
      id: nextRequestId++,
      url: "http://localhost:3000/favicon.ico",
      resourceType: "other",
    });
    expect(await settled(none)).toBe(false);
    releaseNone();
  });
});
