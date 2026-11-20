import { describe, expect, mock, test } from "bun:test";

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
void mock.module("electron", () => ({
  BrowserWindow: { fromWebContents: (contents: WebContents) => windowOf(contents) },
  ipcMain: {
    on: (channel: string, listener: Handler) => ipcHandlers.set(channel, listener),
    handle: (channel: string, listener: Handler) => ipcHandlers.set(channel, listener),
  },
}));

const { windowOf } = await import("../test/fake-app-windows");
const { afterMicrotasks, fakeGuest, fakeHost, sendSites } =
  await import("../test/fake-browser-panels");
const { installSiteAccess, trackWebviewSiteAccess } = await import("./browser-site-access");
const { requestFileAccess } = await import("./browser-file-access");
installSiteAccess();

const channels = {
  handlers: ipcHandlers,
  listen: SITE_ACCESS_LISTEN,
  setSites: SITE_ACCESS_SET_SITES,
  request: SITE_ACCESS_REQUEST,
  respond: SITE_ACCESS_RESPOND,
  withdrawn: SITE_ACCESS_WITHDRAWN,
};
sendSites(channels, {});

/** A browser panel on `origin`, and the way its page requests file access. */
function panel(origin: string, type = "webview") {
  const window = fakeHost(channels);
  const page = fakeGuest(window.host, origin, type);
  trackWebviewSiteAccess(page.guest);
  const request = (
    filePath: string,
    { write = false, directory = false, requestingUrl = `${origin}/` } = {},
  ) => {
    let granted: boolean | undefined;
    requestFileAccess(
      page.guest,
      {
        filePath,
        isDirectory: directory,
        fileAccessType: write ? "writable" : "readable",
        requestingUrl,
      },
      (answer) => {
        granted = answer;
      },
    );
    return { granted: () => granted };
  };
  return { ...window, ...page, request };
}

/** Until the request is answered; undefined while it waits on the prompt. */
async function answered(fate: { granted: () => boolean | undefined }) {
  await afterMicrotasks(() => fate.granted() !== undefined, "an answer");
  return fate.granted();
}

describe("file access requests", () => {
  test("ask in the panel, naming the file and whether the page would write it", async () => {
    const site = panel("https://editor.example");
    const write = site.request("/Users/me/notes.txt", { write: true });
    await afterMicrotasks(() => site.requests().length === 1, "the prompt");
    expect(site.requests()[0]!.access).toEqual({
      kind: "file-system",
      origin: "https://editor.example",
      path: "/Users/me/notes.txt",
      name: "notes.txt",
      directory: false,
      write: true,
    });
    expect(write.granted()).toBeUndefined();
    site.respond(site.requests()[0]!.id, "allow-once");
    expect(await answered(write)).toBe(true);
  });

  test("Block and closing the bar refuse only that request, and nothing is saved", async () => {
    const site = panel("https://editor.example");
    const first = site.request("/Users/me/a.txt", { write: true });
    await afterMicrotasks(() => site.requests().length === 1, "the prompt");
    site.respond(site.requests()[0]!.id, "dismiss");
    expect(await answered(first)).toBe(false);
    const second = site.request("/Users/me/a.txt", { write: true });
    await afterMicrotasks(() => site.requests().length === 2, "a new prompt");
    // A renderer answering Allow saves nothing either: the next request asks again.
    site.respond(site.requests()[1]!.id, "allow");
    expect(await answered(second)).toBe(true);
    void site.request("/Users/me/a.txt", { write: true });
    await afterMicrotasks(() => site.requests().length === 3, "a third prompt");
  });

  test("a folder picker's write and read requests share one prompt", async () => {
    const site = panel("https://editor.example");
    const write = site.request("/Users/me/project", { write: true, directory: true });
    const read = site.request("/Users/me/project", { directory: true });
    await afterMicrotasks(() => site.requests().length === 1, "the prompt");
    site.respond(site.requests()[0]!.id, "allow-once");
    expect(await answered(write)).toBe(true);
    expect(await answered(read)).toBe(true);
    expect(site.requests()).toHaveLength(1);
  });

  test("allowing a read doesn't answer a write", async () => {
    const site = panel("https://editor.example");
    void site.request("/Users/me/a.txt");
    const write = site.request("/Users/me/a.txt", { write: true });
    await afterMicrotasks(() => site.requests().length === 2, "two prompts");
    site.respond(site.requests()[0]!.id, "allow-once");
    await afterMicrotasks(() => site.withdrawn().length === 1, "the read prompt to go");
    expect(write.granted()).toBeUndefined();
  });

  test("are refused without asking from a popup or a page that moved on", async () => {
    const popup = panel("https://editor.example", "window");
    expect(await answered(popup.request("/Users/me/a.txt", { write: true }))).toBe(false);
    const moved = panel("https://other.example");
    const stale = moved.request("/Users/me/a.txt", { requestingUrl: "https://editor.example/" });
    expect(await answered(stale)).toBe(false);
    expect([...popup.requests(), ...moved.requests()]).toEqual([]);
  });

  test("are refused when the page navigates away while asking", async () => {
    const site = panel("https://editor.example");
    const held = site.request("/Users/me/a.txt", { write: true });
    await afterMicrotasks(() => site.requests().length === 1, "the prompt");
    site.navigate("https://elsewhere.example");
    expect(await answered(held)).toBe(false);
  });
});
