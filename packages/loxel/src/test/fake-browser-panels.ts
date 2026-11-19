/**
 * Browser panels for main-process tests of the site access prompts (`browser-site-access.ts`):
 * windows that record what main sends them, and webview guests whose page can navigate. A test's
 * `electron` mock answers `BrowserWindow.fromWebContents` with `windowOf` and keeps the `ipcMain`
 * listeners it is handed in the map it passes as `channels.handlers`. Import this module after
 * mocking `electron`.
 */
import type { IpcMainEvent, WebContents } from "electron";

import {
  type SiteAccessSites,
  type SitePermissionAnswer,
  siteAccessRequestSchema,
} from "../electron/site-permission-protocol";
import { fakeWindow, mainFrameEvent } from "./fake-app-windows";

type Listener = (...args: unknown[]) => void;
type Handler = (event: IpcMainEvent, value?: unknown) => unknown;

function handlerOf(channels: SiteAccessChannels, channel: string): Handler {
  const found = channels.handlers.get(channel);
  if (!found) throw new Error(`main listens on no ${channel}`);
  return found;
}

let nextContentsId = 1;

export function fakeEmitter() {
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

/** Channels of the site access prompts (from `ipc-channels.ts`), passed in to keep this generic. */
export interface SiteAccessChannels {
  /** The `ipcMain` listeners main registered, by channel. */
  handlers: Map<string, Handler>;
  listen: string;
  setSites: string;
  request: string;
  respond: string;
  withdrawn: string;
}

/** Loxel's window, recording what main sends it; it shows prompts unless told not to. */
export function fakeHost(channels: SiteAccessChannels, { listening = true } = {}) {
  const sent: { channel: string; payload: unknown }[] = [];
  const host = fakeWindow({
    ...fakeEmitter(),
    id: nextContentsId++,
    isDestroyed: () => false,
    send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
  });
  if (listening) handlerOf(channels, channels.listen)(mainFrameEvent(host));
  const of = (channel: string) => sent.filter((m) => m.channel === channel).map((m) => m.payload);
  return {
    host,
    requests: () => of(channels.request).map((p) => siteAccessRequestSchema.parse(p)),
    withdrawn: () => of(channels.withdrawn),
    respond: (id: number, answer: SitePermissionAnswer) =>
      handlerOf(channels, channels.respond)(mainFrameEvent(host), { id, answer }),
  };
}

/** The settings' decisions, as a window sends them. */
export function sendSites(channels: SiteAccessChannels, sites: Partial<SiteAccessSites>) {
  const settings = fakeHost(channels, { listening: false });
  handlerOf(channels, channels.setSites)(mainFrameEvent(settings.host), {
    externalApps: {},
    localNetwork: {},
    ...sites,
  });
}

/** A webview guest hosted by `host`, whose page can navigate to another origin. */
export function fakeGuest(host: WebContents, origin: string, type = "webview") {
  const emitter = fakeEmitter();
  const mainFrame = { origin, detached: false };
  const guest = {
    ...emitter,
    id: nextContentsId++,
    getType: () => type,
    isDestroyed: () => false,
    hostWebContents: type === "webview" ? host : null,
    mainFrame,
  } as unknown as WebContents;
  const navigate = (to: string) => {
    emitter.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    mainFrame.origin = to;
    emitter.emit("did-navigate");
  };
  return { guest, mainFrame, navigate, emit: emitter.emit };
}

/** Let main's pending work run until `done` holds. */
export async function afterMicrotasks(done: () => boolean, what: string) {
  for (let turn = 0; !done(); turn++) {
    if (turn > 1000) throw new Error(`gave up waiting for ${what}`);
    await Promise.resolve();
  }
}
