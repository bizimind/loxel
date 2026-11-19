import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { IpcMainEvent, WebContents } from "electron";

import {
  SITE_ACCESS_LISTEN,
  SITE_ACCESS_REQUEST,
  SITE_ACCESS_RESPOND,
  SITE_ACCESS_SET_SITES,
  SITE_ACCESS_WITHDRAWN,
} from "./ipc-channels";

type Handler = (event: IpcMainEvent, value?: unknown) => unknown;
const ipcHandlers = new Map<string, Handler>();
const appNames = new Map([["zoommtg:", "zoom.us"]]);
void mock.module("electron", () => ({
  BrowserWindow: { fromWebContents: (contents: WebContents) => windowOf(contents) },
  ipcMain: {
    on: (channel: string, listener: Handler) => ipcHandlers.set(channel, listener),
    handle: (channel: string, listener: Handler) => ipcHandlers.set(channel, listener),
  },
  app: {
    getApplicationNameForProtocol: (url: string) => appNames.get(new URL(url).protocol) ?? "",
  },
  shell: {},
  systemPreferences: {},
}));

const { windowOf } = await import("../test/fake-app-windows");
const { afterMicrotasks, fakeGuest, fakeHost, sendSites } =
  await import("../test/fake-browser-panels");
const { installSiteAccess, trackWebviewSiteAccess } = await import("./browser-site-access");
const { requestExternalApp, schemeOf } = await import("./browser-external-apps");
const { trackUserActivation } = await import("./user-activation");
installSiteAccess();

const channels = {
  handlers: ipcHandlers,
  listen: SITE_ACCESS_LISTEN,
  setSites: SITE_ACCESS_SET_SITES,
  request: SITE_ACCESS_REQUEST,
  respond: SITE_ACCESS_RESPOND,
  withdrawn: SITE_ACCESS_WITHDRAWN,
};

const SITE = "https://meet.example";
const ZOOM_LINK = "zoommtg://meet.example/join?id=1";

/** A browser panel on `SITE` whose page the user can click in. */
function panel({ type = "webview", listening = true } = {}) {
  const window = fakeHost(channels, { listening });
  const page = fakeGuest(window.host, SITE, type);
  trackWebviewSiteAccess(page.guest);
  trackUserActivation(page.guest);
  const click = () => page.emit("before-mouse-event", {}, { type: "mouseDown" });
  return { ...window, ...page, click };
}

/** The page opens `url`; resolves with whether Electron may open it in its app. */
function openLink(guest: WebContents, url = ZOOM_LINK, { isMainFrame = true } = {}) {
  return new Promise<boolean>((resolve) => {
    const details = { externalURL: url, isMainFrame, requestingUrl: `${SITE}/` };
    requestExternalApp(guest, details, resolve);
  });
}

beforeEach(() => sendSites(channels, {}));

describe("links to other apps", () => {
  test("names the link's scheme as the settings keep it", () => {
    expect(schemeOf("zoommtg://x")).toBe("zoommtg");
    expect(schemeOf("mailto:a@example.com")).toBe("mailto");
    expect(schemeOf("not a url")).toBeNull();
  });

  test("ask in the page's panel, naming the site and the app, and Allow is saved", async () => {
    const page = panel();
    page.click();
    const opened = openLink(page.guest);
    await afterMicrotasks(() => page.requests().length === 1, "the prompt");
    const [request] = page.requests();
    expect(request).toEqual({
      id: request!.id,
      webContentsId: page.guest.id,
      access: { kind: "external-app", origin: SITE, scheme: "zoommtg", app: "zoom.us" },
    });
    page.respond(request!.id, "allow");
    expect(await opened).toBe(true);
    // Saved for the site and scheme: the next click opens without asking.
    page.click();
    expect(await openLink(page.guest)).toBe(true);
    expect(page.requests()).toHaveLength(1);
  });

  test("needs a click or key press in the page, even for an allowed site", async () => {
    sendSites(channels, { externalApps: { [SITE]: { zoommtg: "allow" } } });
    const page = panel();
    expect(await openLink(page.guest)).toBe(false);
    page.click();
    expect(await openLink(page.guest)).toBe(true);
    // One click opens one link.
    expect(await openLink(page.guest)).toBe(false);
    expect(page.requests()).toEqual([]);
  });

  test("blocked sites, other schemes' decisions and embedded frames don't open", async () => {
    sendSites(channels, { externalApps: { [SITE]: { zoommtg: "block", mailto: "allow" } } });
    const page = panel();
    page.click();
    expect(await openLink(page.guest)).toBe(false);
    page.click();
    expect(await openLink(page.guest, ZOOM_LINK, { isMainFrame: false })).toBe(false);
    page.click();
    expect(await openLink(page.guest, "mailto:a@example.com")).toBe(true);
    expect(page.requests()).toEqual([]);
  });

  test("Allow this time opens this link only, and the scheme falls back for an unknown app", async () => {
    const page = panel();
    page.click();
    const opened = openLink(page.guest, "vscode://file/x");
    await afterMicrotasks(() => page.requests().length === 1, "the prompt");
    const [request] = page.requests();
    expect(request!.access).toEqual({
      kind: "external-app",
      origin: SITE,
      scheme: "vscode",
      app: "",
    });
    page.respond(request!.id, "allow-once");
    expect(await opened).toBe(true);
    page.click();
    void openLink(page.guest, "vscode://file/x");
    await afterMicrotasks(() => page.requests().length === 2, "a second prompt");
  });

  test("Block and Not now refuse, and leaving the page withdraws the prompt", async () => {
    const page = panel();
    page.click();
    const blocked = openLink(page.guest);
    await afterMicrotasks(() => page.requests().length === 1, "the prompt");
    page.respond(page.requests()[0]!.id, "block");
    expect(await blocked).toBe(false);

    page.click();
    const dismissed = openLink(page.guest, "mailto:a@example.com");
    await afterMicrotasks(() => page.requests().length === 2, "a second prompt");
    page.respond(page.requests()[1]!.id, "dismiss");
    expect(await dismissed).toBe(false);

    page.click();
    const left = openLink(page.guest, "mailto:a@example.com");
    await afterMicrotasks(() => page.requests().length === 3, "a third prompt");
    page.navigate("https://other.example");
    expect(await left).toBe(false);
    expect(page.withdrawn()).toHaveLength(3);
  });

  test("a popup window, with no panel to ask in, opens only links its site was allowed", async () => {
    const popup = panel({ type: "window" });
    popup.click();
    expect(await openLink(popup.guest)).toBe(false);
    sendSites(channels, { externalApps: { [SITE]: { zoommtg: "allow" } } });
    popup.click();
    expect(await openLink(popup.guest)).toBe(true);
    expect(popup.requests()).toEqual([]);
  });

  test("a window that shows no prompts refuses", async () => {
    const page = panel({ listening: false });
    page.click();
    expect(await openLink(page.guest)).toBe(false);
  });
});
