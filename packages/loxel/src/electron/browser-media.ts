/**
 * Camera and microphone for browser panel pages (`getUserMedia()`), per site with the user's
 * permission, as in browsers: video calls such as Google Meet work in a panel.
 *
 * The browser session's permission handlers (`browser-permissions.ts`) hand every `media` check
 * and request here. A request from a site without a decision is forwarded to the window hosting
 * the page, whose browser panel asks Allow / Allow this time / Block; Allow and Block are saved
 * per site and device in Loxel's settings, which window renderers send here on load and on every
 * change. "Allow this time" lasts while the panel stays on the site.
 *
 * On macOS an allowed request also needs the system to let Loxel use the device: the first one
 * shows the system prompt, and when the user turned it off, the page is refused and the panel
 * offers to open System Settings. macOS may only apply the change after Loxel restarts.
 *
 * The site deciding is the panel's top-level page: frames embedded in it get the page's decision
 * when its permissions policy delegates the device to them (`allow="camera"`), which Chromium
 * enforces before asking. Only secure pages (`https`, or `http` on this machine) get either.
 *
 * Electron's checks answer granted or denied, never "prompt", so the webview preload reports a
 * page's undecided devices to `navigator.permissions.query()` from here instead.
 */
import {
  type IpcMainEvent,
  type MediaAccessPermissionRequest,
  type WebContents,
  ipcMain,
  shell,
  systemPreferences,
} from "electron";

import {
  MEDIA_DEVICES,
  type MediaDevice,
  type MediaPermissionRequest,
  type MediaPermissionStates,
  type MediaSites,
  type MediaSystemBlocked,
  mediaDeviceSchema,
  mediaPermissionResponseSchema,
  parseMediaSites,
  withMediaDecision,
} from "./browser-media-protocol";
import { isSecureWebOrigin } from "./browser-notifications";
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
import { createListeningRenderers } from "./listening-renderers";

/** A device's state for a page: decided for its site, or still to ask. */
type DeviceState = "allow" | "block" | "ask";

/** Devices granted with "Allow this time", for the site the panel was on. */
export interface OnceGrant {
  origin: string;
  devices: ReadonlySet<MediaDevice>;
}

/** A device's state for a page of `origin`, from the saved decisions and the panel's grant. */
export function deviceState(
  sites: MediaSites,
  once: OnceGrant | undefined,
  origin: string,
  device: MediaDevice,
): DeviceState {
  const saved = sites[origin]?.[device];
  if (saved) return saved;
  return once?.origin === origin && once.devices.has(device) ? "allow" : "ask";
}

/**
 * What a request for `devices` gets: refused when any is blocked (as in browsers, a call asking
 * for camera and microphone fails as a whole), granted when all are allowed, otherwise asks for
 * the undecided ones.
 */
export function requestState(states: readonly DeviceState[]): DeviceState {
  if (states.includes("block")) return "block";
  return states.every((state) => state === "allow") ? "allow" : "ask";
}

/** The devices a request's media types name: video is the camera, audio the microphone. */
export function devicesOf(mediaTypes: readonly ("video" | "audio")[]): MediaDevice[] {
  const devices = new Set<MediaDevice>();
  for (const type of mediaTypes) devices.add(type === "video" ? "camera" : "microphone");
  return [...devices];
}

/** An origin as Electron's handlers give it (`https://example.com/`), as pages name it. */
export function normalizeOrigin(origin: string): string | null {
  try {
    const { origin: normalized } = new URL(origin);
    return normalized === "null" ? null : normalized;
  } catch {
    return null;
  }
}

let sites: MediaSites = {};
/** Whether a renderer has sent the settings' decisions yet; requests wait for them. */
let sitesLoaded = false;
let resolveSitesLoaded: () => void = () => {};
const sitesLoadedPromise = new Promise<void>((resolve) => {
  resolveSitesLoaded = resolve;
});

const listeningHosts = createListeningRenderers();

interface PendingRequest {
  guestId: number;
  host: WebContents;
  origin: string;
  devices: MediaDevice[];
  /** Each `getUserMedia()` waiting on this prompt, told whether its devices may be used. */
  waiters: { devices: readonly MediaDevice[]; resolve: (allowed: boolean) => void }[];
}
const pendingRequests = new Map<number, PendingRequest>();
let nextRequestId = 1;

/** "Allow this time" grants by guest webContents id, dropped when the panel leaves the site. */
const onceGrants = new Map<number, OnceGrant>();

function stateFor(guestId: number, origin: string, device: MediaDevice): DeviceState {
  return deviceState(sites, onceGrants.get(guestId), origin, device);
}

function statesFor(guestId: number, origin: string, devices: readonly MediaDevice[]) {
  return devices.map((device) => stateFor(guestId, origin, device));
}

/** The site deciding for a guest's pages, or null when its page gets no camera or microphone. */
function siteOfGuest(guest: WebContents | null): string | null {
  if (!guest || guest.isDestroyed() || guest.getType() !== "webview") return null;
  const site = guest.mainFrame.origin;
  return isSecureWebOrigin(site) ? site : null;
}

function listeningHost(guest: WebContents): WebContents | null {
  const host = guest.hostWebContents;
  if (!host || host.isDestroyed() || !listeningHosts.has(host.id)) return null;
  return host;
}

/**
 * The `media` permission check: what `navigator.permissions.query()` (before the preload's
 * answer), `enumerateDevices()` device labels and Chromium's own checks read. Only the page's own
 * frames get a grant: a check can't see what the page's permissions policy delegates.
 */
export function checkMediaPermission(
  guest: WebContents | null,
  requestingOrigin: string,
  mediaType: "video" | "audio" | "unknown" | undefined,
): boolean {
  const site = siteOfGuest(guest);
  if (!guest || !site || normalizeOrigin(requestingOrigin) !== site) return false;
  // Device labels are checked with no type: they are the page's once it may use either device.
  const devices = mediaType === "video" || mediaType === "audio" ? devicesOf([mediaType]) : null;
  const states = statesFor(guest.id, site, devices ?? MEDIA_DEVICES);
  return devices ? states.every((s) => s === "allow") : states.includes("allow");
}

function withdraw(id: number, pending: PendingRequest, allowed?: boolean): void {
  pendingRequests.delete(id);
  for (const waiter of pending.waiters) {
    const states = statesFor(pending.guestId, pending.origin, waiter.devices);
    waiter.resolve(allowed ?? requestState(states) === "allow");
  }
  if (pending.host.isDestroyed()) return;
  pending.host.send(BROWSER_MEDIA_PERMISSION_WITHDRAWN, { id, webContentsId: pending.guestId });
}

/** Answer the requests whose devices all have a decision now, and take down their prompts. */
function settleDecidedRequests(): void {
  for (const [id, pending] of pendingRequests) {
    const states = statesFor(pending.guestId, pending.origin, pending.devices);
    if (requestState(states) !== "ask") withdraw(id, pending);
  }
}

/** Ask the user in `host` whether `site` may use `devices`; resolves with the answer. */
function ask(
  guestId: number,
  host: WebContents,
  site: string,
  devices: readonly MediaDevice[],
): Promise<boolean> {
  return new Promise((resolve) => {
    const waiter = { devices, resolve };
    // A page asking again while its prompt is up (Meet asks for each device on its own) adds
    // to the same prompt, which then asks for every device it waits on.
    for (const [id, pending] of pendingRequests) {
      if (pending.guestId !== guestId || pending.origin !== site) continue;
      pending.waiters.push(waiter);
      const added = devices.filter((device) => !pending.devices.includes(device));
      if (added.length === 0) return;
      pending.devices = [...pending.devices, ...added];
      sendRequest(id, pending);
      return;
    }
    const id = nextRequestId++;
    const pending: PendingRequest = {
      guestId,
      host,
      origin: site,
      devices: [...devices],
      waiters: [waiter],
    };
    pendingRequests.set(id, pending);
    sendRequest(id, pending);
  });
}

function sendRequest(id: number, pending: PendingRequest): void {
  const request: MediaPermissionRequest = {
    id,
    webContentsId: pending.guestId,
    origin: pending.origin,
    devices: pending.devices,
  };
  pending.host.send(BROWSER_MEDIA_PERMISSION_REQUEST, request);
}

/** System prompts in flight, so pages asking at once share one. */
const systemPrompts = new Map<MediaDevice, Promise<boolean>>();

/**
 * Whether macOS lets Loxel use `device`, asking the first time (its own prompt, once per app).
 * Elsewhere the OS doesn't gate it for Loxel.
 */
async function systemAllows(device: MediaDevice): Promise<boolean> {
  if (process.platform !== "darwin") return true;
  const status = systemPreferences.getMediaAccessStatus(device);
  if (status === "denied" || status === "restricted") return false;
  if (status !== "not-determined") return true;
  const inFlight = systemPrompts.get(device);
  if (inFlight) return inFlight;
  const prompt = systemPreferences.askForMediaAccess(device).finally(() => {
    systemPrompts.delete(device);
  });
  systemPrompts.set(device, prompt);
  return prompt;
}

/** Whether the OS lets Loxel use all of `devices`; if not, the panel says where to change it. */
async function systemAllowsAll(
  guest: WebContents,
  host: WebContents,
  devices: readonly MediaDevice[],
): Promise<boolean> {
  const blocked: MediaDevice[] = [];
  for (const device of devices) {
    if (!(await systemAllows(device))) blocked.push(device);
  }
  if (blocked.length === 0) return true;
  if (!host.isDestroyed() && !guest.isDestroyed()) {
    const notice: MediaSystemBlocked = { webContentsId: guest.id, devices: blocked };
    host.send(BROWSER_MEDIA_SYSTEM_BLOCKED, notice);
  }
  return false;
}

async function decideRequest(
  guest: WebContents,
  details: MediaAccessPermissionRequest,
): Promise<boolean> {
  const devices = devicesOf(details.mediaTypes ?? []);
  // Who asked is settled now: after a wait, the guest could be on its next page.
  const site = siteOfGuest(guest);
  if (!site || devices.length === 0) return false;
  await sitesLoadedPromise;
  if (siteOfGuest(guest) !== site) return false;
  const host = listeningHost(guest);
  if (!host) return false;
  const state = requestState(statesFor(guest.id, site, devices));
  if (state === "block") return false;
  if (state === "ask" && !(await ask(guest.id, host, site, devices))) return false;
  if (siteOfGuest(guest) !== site) return false;
  return systemAllowsAll(guest, host, devices);
}

/** The `media` permission request: a page called `getUserMedia()` for the camera or microphone. */
export function requestMediaPermission(
  guest: WebContents,
  details: MediaAccessPermissionRequest,
  callback: (granted: boolean) => void,
): void {
  decideRequest(guest, details).then(callback, (error: unknown) => {
    console.error("[browser-media] Refused a camera or microphone request after an error", error);
    callback(false);
  });
}

function respondToRequest(event: IpcMainEvent, value: unknown): void {
  const parsed = mediaPermissionResponseSchema.safeParse(value);
  if (!parsed.success) return;
  const { id, answer } = parsed.data;
  const pending = pendingRequests.get(id);
  if (!pending || pending.host !== event.sender) return;
  if (answer === "dismiss") {
    withdraw(id, pending, false);
    return;
  }
  if (answer === "allow-once") {
    const once = onceGrants.get(pending.guestId);
    const kept = once?.origin === pending.origin ? once.devices : [];
    onceGrants.set(pending.guestId, {
      origin: pending.origin,
      devices: new Set([...kept, ...pending.devices]),
    });
  } else {
    // The renderer also saves the decision in settings, which sends it back here; applying it now
    // answers the page without waiting for that round trip.
    sites = withMediaDecision(sites, pending.origin, pending.devices, answer);
  }
  settleDecidedRequests();
}

function setSites(event: IpcMainEvent, value: unknown): void {
  // Only Loxel's own windows hold the settings; a page must never decide for itself.
  if (event.sender.getType() !== "window") return;
  sites = parseMediaSites(value);
  if (!sitesLoaded) {
    sitesLoaded = true;
    resolveSitesLoaded();
  }
  settleDecidedRequests();
}

/** `navigator.permissions.query()` for the calling frame, or null to leave Chromium's answer. */
function pageStates(event: IpcMainEvent): MediaPermissionStates | null {
  const guest = event.sender;
  const frame = event.senderFrame;
  const site = siteOfGuest(guest);
  if (!site || !frame || frame.detached || frame.origin !== site) return null;
  const states: MediaPermissionStates = { camera: "prompt", microphone: "prompt" };
  if (!sitesLoaded) return states;
  for (const device of MEDIA_DEVICES) {
    const state = stateFor(guest.id, site, device);
    states[device] = state === "allow" ? "granted" : state === "block" ? "denied" : "prompt";
  }
  return states;
}

/** The pane of macOS System Settings where the user turns a device on for Loxel. */
const SYSTEM_SETTINGS: Record<MediaDevice, string> = {
  camera: "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera",
  microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
};

function openSystemSettings(event: IpcMainEvent, value: unknown): void {
  if (event.sender.getType() !== "window" || process.platform !== "darwin") return;
  const device = mediaDeviceSchema.safeParse(value);
  if (device.success) void shell.openExternal(SYSTEM_SETTINGS[device.data]);
}

export function installBrowserMedia(): void {
  ipcMain.on(BROWSER_MEDIA_PERMISSION, (event) => {
    try {
      event.returnValue = pageStates(event);
    } catch {
      // The page is blocked until a value is set; null leaves Chromium's answer.
      event.returnValue = null;
    }
  });
  ipcMain.on(BROWSER_MEDIA_LISTEN, (event) => {
    if (event.sender.getType() === "window") listeningHosts.add(event.sender);
  });
  ipcMain.on(BROWSER_MEDIA_SET_SITES, setSites);
  ipcMain.on(BROWSER_MEDIA_PERMISSION_RESPOND, respondToRequest);
  ipcMain.on(BROWSER_MEDIA_OPEN_SYSTEM_SETTINGS, openSystemSettings);
}

/** Withdraw the guest's open prompts, refusing what waits on them: its page is going away. */
function withdrawRequests(guestId: number): void {
  for (const [id, pending] of pendingRequests) {
    if (pending.guestId === guestId) withdraw(id, pending, false);
  }
}

/** Track a webview's page lifecycle for its camera and microphone (from `web-contents-created`). */
export function trackWebviewMedia(contents: WebContents): void {
  if (contents.getType() !== "webview") return;
  const guestId = contents.id;
  // The page being left gets no answer to its prompts, as with dialogs.
  contents.on("did-start-navigation", ({ isMainFrame, isSameDocument }) => {
    if (isMainFrame && !isSameDocument) withdrawRequests(guestId);
  });
  // "Allow this time" stays with the site: reloads and its other pages keep it, leaving drops it.
  contents.on("did-navigate", () => {
    if (onceGrants.get(guestId)?.origin !== contents.mainFrame.origin) onceGrants.delete(guestId);
  });
  contents.on("render-process-gone", () => withdrawRequests(guestId));
  contents.once("destroyed", () => {
    withdrawRequests(guestId);
    onceGrants.delete(guestId);
  });
}
