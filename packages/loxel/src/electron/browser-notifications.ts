/**
 * Web notifications for browser panel pages, shown in Loxel's notification center instead of by
 * the OS.
 *
 * Chromium's own notification permission stays denied for the browser session
 * (`browser-permissions.ts`), so pages never reach native notifications. The webview preload (`webview-preload.cjs`) gives pages a
 * `Notification` of Loxel's instead: reading its permission, requesting it and showing a
 * notification are IPC calls to main, which decides by the page's origin as main sees it, never
 * as the page claims it.
 *
 * Decisions per site live in Loxel's settings; window renderers send them here on load and on
 * every change, because `Notification.permission` is synchronous and main must answer it at
 * once. A site without a decision asks: main forwards the request to the window hosting the page,
 * whose browser panel shows Allow / Block, and the answer resolves every page of that site that
 * is waiting. A site the user muted or snoozed keeps its decision, but main drops its
 * notifications.
 *
 * Only secure top-level pages (`https`, or `http` on this machine) and same-origin frames in them
 * get notifications; cross-origin frames are denied, as in browsers.
 */
import {
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents,
  type WebFrameMain,
  ipcMain,
} from "electron";

import { isLoopbackHost } from "../url-utils";
import { onAppWindowMessage } from "./app-windows";
import {
  type BrowserNotification,
  type NotificationPermissionRequest,
  type NotificationMutes,
  type NotificationPermissionState,
  type NotificationSites,
  browserNotificationRefSchema,
  isMuteActive,
  notificationPermissionResponseSchema,
  pageNotificationSchema,
  parseNotificationMutes,
  parseNotificationSites,
} from "./browser-notification-protocol";
import { isIncognitoSession } from "./browser-partition";
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
import { createListeningRenderers } from "./listening-renderers";
import { createPermissionPrompts, createSettingsMirror } from "./permission-prompts";
import { webviewSenderFrame } from "./webview-sender";

/** Longer texts are cut: the notification center shows two lines of body. */
const MAX_TITLE = 500;
const MAX_BODY = 2_000;
const MAX_TAG = 200;
/** A page showing more than this many notifications in the window gets the rest dropped. */
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 10_000;
/** Notification objects a guest's page keeps clickable; older ones only go to the panel. */
const MAX_REFS_PER_GUEST = 100;

const sites = createSettingsMirror<NotificationSites>({});
/** Sites muted or snoozed from the notification center: allowed, but nothing is shown. */
let mutes: NotificationMutes = {};

const listeningHosts = createListeningRenderers();

interface PendingRequest {
  guestId: number;
  host: WebContents;
  origin: string;
  /** What every `requestPermission()` the page made while this request is open resolves to. */
  answer: Promise<NotificationPermissionState>;
  resolve: (state: NotificationPermissionState) => void;
}
const prompts = createPermissionPrompts<PendingRequest>(
  {
    request: BROWSER_NOTIFICATION_PERMISSION_REQUEST,
    withdrawn: BROWSER_NOTIFICATION_PERMISSION_WITHDRAWN,
  },
  (id, pending): NotificationPermissionRequest => ({
    id,
    webContentsId: pending.guestId,
    origin: pending.origin,
  }),
);
/** Guests whose page closed its prompt with "Not now": no new prompt until it navigates. */
const dismissedGuests = new Set<number>();

interface PageNotification {
  guestId: number;
  /** The window the notification went to: the only one whose clicks reach the page. */
  host: WebContents;
  frame: WebFrameMain;
  pageId: number;
}
/** The pages' live notifications by main's ref, for clicks. */
const pageNotifications = new Map<string, PageNotification>();
let nextRef = 1;
/** When each guest showed its recent notifications, for the rate limit; kept across reloads. */
const recentShows = new Map<number, number[]>();

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

interface NotificationTexts {
  title: string;
  body: string;
  tag: string;
}

/** A notification's texts as the notification center takes them: long ones cut. */
export function capTexts({ title, body, tag }: NotificationTexts): NotificationTexts {
  return { title: cap(title, MAX_TITLE), body: cap(body, MAX_BODY), tag: cap(tag, MAX_TAG) };
}

/**
 * A secure context's origin, like browsers require for notifications: `https`, or `http` on this
 * machine (dev servers). Plain `http` elsewhere could be anyone on the network.
 */
export function isSecureWebOrigin(origin: string): boolean {
  try {
    const { protocol, hostname } = new URL(origin);
    if (!hostname) return false;
    return protocol === "https:" || (protocol === "http:" && isLoopbackHost(hostname));
  } catch {
    return false;
  }
}

/**
 * The site deciding for the calling frame, or null when the frame gets no notifications. Incognito
 * tabs get none, as in Chrome: the notification center keeps them on the server.
 */
export function siteOf(event: IpcMainEvent | IpcMainInvokeEvent): string | null {
  const frame = webviewSenderFrame(event);
  if (!frame || isIncognitoSession(event.sender.session)) return null;
  const top = event.sender.mainFrame.origin;
  // Cross-origin frames get no notifications, like in browsers: the user decides for the page.
  if (frame.origin !== top || !isSecureWebOrigin(top)) return null;
  return top;
}

/** The window showing the guest's panel, when it shows notifications. */
export function listeningHost(guest: WebContents): WebContents | null {
  const host = guest.hostWebContents;
  if (!host || host.isDestroyed() || !listeningHosts.has(host.id)) return null;
  return host;
}

export function permissionFor(site: string): NotificationPermissionState {
  const decision = sites.get()[site];
  if (decision === "allow") return "granted";
  if (decision === "block") return "denied";
  return "default";
}

function pagePermission(event: IpcMainEvent | IpcMainInvokeEvent): NotificationPermissionState {
  const site = siteOf(event);
  if (!site || !listeningHost(event.sender)) return "denied";
  return permissionFor(site);
}

function withdraw(id: number, state: NotificationPermissionState): void {
  prompts.withdraw(id)?.resolve(state);
}

/** Resolve the requests of sites that now have a decision, and take down their prompts. */
function settleDecidedRequests(): void {
  for (const [id, pending] of prompts.entries()) {
    const state = permissionFor(pending.origin);
    if (state !== "default") withdraw(id, state);
  }
}

/** The guest's open request for `site`, or a new one shown in `host`. */
function pendingRequestFor(guestId: number, host: WebContents, site: string): PendingRequest {
  // A page asking again while its prompt is up waits for the same answer.
  for (const [, pending] of prompts.entries()) {
    if (pending.guestId === guestId && pending.origin === site) return pending;
  }
  let resolve: (state: NotificationPermissionState) => void = () => {};
  const answer = new Promise<NotificationPermissionState>((r) => {
    resolve = r;
  });
  const pending: PendingRequest = { guestId, host, origin: site, answer, resolve };
  prompts.show(pending);
  return pending;
}

async function requestPermission(event: IpcMainInvokeEvent): Promise<NotificationPermissionState> {
  // Who asked is settled now: after the wait, `senderFrame` could be the frame's next document.
  const site = siteOf(event);
  const guest = event.sender;
  if (!site) return "denied";
  await sites.loaded;
  // The guest may have gone during the wait; its accessors throw once it has.
  const host = guest.isDestroyed() ? null : listeningHost(guest);
  if (!host || guest.mainFrame.origin !== site) return "denied";
  const state = permissionFor(site);
  if (state !== "default" || dismissedGuests.has(guest.id)) return state;
  return pendingRequestFor(guest.id, host, site).answer;
}

function respondToRequest(event: IpcMainEvent, value: unknown): void {
  const parsed = notificationPermissionResponseSchema.safeParse(value);
  if (!parsed.success) return;
  const { id, decision } = parsed.data;
  const pending = prompts.answered(event, id);
  if (!pending) return;
  if (decision === "dismiss") {
    // Like browsers, a page told "not now" can't put the prompt straight back up.
    dismissedGuests.add(pending.guestId);
    withdraw(id, "default");
    return;
  }
  // The renderer also saves the decision in settings, which sends it back here; applying it now
  // answers the page without waiting for that round trip.
  sites.apply({ ...sites.get(), [pending.origin]: decision });
  settleDecidedRequests();
}

function setSites(_event: IpcMainEvent, value: unknown): void {
  sites.receive(parseNotificationSites(value));
  settleDecidedRequests();
}

function setMutes(_event: IpcMainEvent, value: unknown): void {
  mutes = parseNotificationMutes(value);
}

/**
 * Whether the user muted or snoozed the site: it keeps its permission, so its pages can't tell,
 * but its notifications, from pages and service workers alike, go nowhere.
 */
export function isSiteMuted(origin: string): boolean {
  return isMuteActive(mutes[origin], Date.now());
}

/** Whether the guest may show another notification now; counts it if so. */
export function withinRateLimit(guestId: number): boolean {
  const now = Date.now();
  const recent = (recentShows.get(guestId) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) return false;
  recent.push(now);
  recentShows.set(guestId, recent);
  return true;
}

/**
 * Show a notification in the notification center of `host`, for the browser panel of `guest`, with
 * its texts capped. `ref` is the sender's id for it, which comes back on clicks.
 */
export function sendToNotificationCenter(
  host: WebContents,
  fields: NotificationTexts & { ref: string; guest: WebContents },
): void {
  const { ref, guest } = fields;
  const notification: BrowserNotification = {
    ref,
    webContentsId: guest.id,
    origin: guest.mainFrame.origin,
    ...capTexts(fields),
  };
  host.send(BROWSER_NOTIFICATION_OPENED, notification);
}

/** Remember a page's notification for its clicks, keeping the guest's newest ones. */
function track(ref: string, notification: PageNotification): void {
  pageNotifications.set(ref, notification);
  const own = [...pageNotifications].filter(([, n]) => n.guestId === notification.guestId);
  for (const [oldRef] of own.slice(0, Math.max(0, own.length - MAX_REFS_PER_GUEST))) {
    pageNotifications.delete(oldRef);
  }
}

function refOf(guestId: number, frame: WebFrameMain, pageId: number): string | undefined {
  for (const [ref, n] of pageNotifications) {
    // Compared by id: Electron may hand out a new WebFrameMain object for the same frame.
    const sameFrame =
      n.frame.processId === frame.processId && n.frame.routingId === frame.routingId;
    if (n.guestId === guestId && sameFrame && n.pageId === pageId) return ref;
  }
  return undefined;
}

function showNotification(event: IpcMainEvent, value: unknown): void {
  const parsed = pageNotificationSchema.safeParse(value);
  const frame = event.senderFrame;
  if (!parsed.success || !frame || pagePermission(event) !== "granted") return;
  const guest = event.sender;
  const host = listeningHost(guest);
  if (!host || isSiteMuted(guest.mainFrame.origin) || !withinRateLimit(guest.id)) return;

  const { pageId, title, body, tag } = parsed.data;
  const ref = `${guest.id}-${nextRef++}`;
  track(ref, { guestId: guest.id, host, frame, pageId });
  sendToNotificationCenter(host, { ref, guest, title, body, tag });
}

/**
 * The page closed a notification. It stays in the notification center: pages close theirs after a
 * few seconds, or when their tab is shown, because OS banners linger, but the center is where the
 * user catches up later. The object just stops getting clicks.
 */
function closeNotification(event: IpcMainEvent, pageId: unknown): void {
  const frame = event.senderFrame;
  if (typeof pageId !== "number" || !frame) return;
  const ref = refOf(event.sender.id, frame, pageId);
  if (ref) pageNotifications.delete(ref);
}

function clickNotification(event: IpcMainEvent, value: unknown): void {
  const parsed = browserNotificationRefSchema.safeParse(value);
  if (!parsed.success) return;
  const notification = pageNotifications.get(parsed.data.ref);
  if (!notification || notification.host !== event.sender || notification.frame.detached) return;
  notification.frame.send(BROWSER_NOTIFICATION_EVENT, notification.pageId, "click");
}

/** Withdraw the guest's open prompts: its page is going away. */
function withdrawRequests(guestId: number): void {
  for (const [id, pending] of prompts.entries()) {
    if (pending.guestId === guestId) withdraw(id, "default");
  }
}

/** Forget the notification objects of the guest's page: clicks have nothing left to reach. */
function forgetNotifications(guestId: number): void {
  for (const [ref, n] of pageNotifications) {
    if (n.guestId === guestId) pageNotifications.delete(ref);
  }
}

export function installBrowserNotifications(): void {
  ipcMain.on(BROWSER_NOTIFICATION_PERMISSION, (event) => {
    try {
      event.returnValue = sites.isLoaded() ? pagePermission(event) : "default";
    } catch {
      // The page is blocked until a value is set.
      event.returnValue = "denied";
    }
  });
  ipcMain.handle(BROWSER_NOTIFICATION_REQUEST_PERMISSION, requestPermission);
  ipcMain.on(BROWSER_NOTIFICATION_SHOW, showNotification);
  ipcMain.on(BROWSER_NOTIFICATION_CLOSE, closeNotification);
  onAppWindowMessage(BROWSER_NOTIFICATION_LISTEN, (event) => listeningHosts.add(event.sender));
  // Only Loxel's own windows hold the settings; a page must never decide for itself.
  onAppWindowMessage(BROWSER_NOTIFICATION_SET_SITES, setSites);
  onAppWindowMessage(BROWSER_NOTIFICATION_SET_MUTES, setMutes);
  onAppWindowMessage(BROWSER_NOTIFICATION_PERMISSION_RESPOND, respondToRequest);
  onAppWindowMessage(BROWSER_NOTIFICATION_CLICK, clickNotification);
}

/** Track a webview's page lifecycle for its notifications (from `web-contents-created`). */
export function trackWebviewNotifications(contents: WebContents): void {
  if (contents.getType() !== "webview") return;
  const guestId = contents.id;
  // The page being left gets no answer to its prompts, as with dialogs.
  contents.on("did-start-navigation", ({ isMainFrame, isSameDocument }) => {
    if (isMainFrame && !isSameDocument) withdrawRequests(guestId);
  });
  // A new document's notification objects are its own, and it may ask again; the old page's
  // notifications stay in the notification center, and clicking one only goes to the panel.
  contents.on("did-navigate", () => {
    forgetNotifications(guestId);
    dismissedGuests.delete(guestId);
  });
  const gone = () => {
    withdrawRequests(guestId);
    forgetNotifications(guestId);
    dismissedGuests.delete(guestId);
  };
  contents.on("render-process-gone", gone);
  contents.once("destroyed", () => {
    gone();
    recentShows.delete(guestId);
  });
}
