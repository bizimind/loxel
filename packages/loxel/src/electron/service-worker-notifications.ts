/**
 * Notifications browser panel pages show through their service worker registration
 * (`ServiceWorkerRegistration.showNotification()`), from a page or from inside the worker. They go
 * to Loxel's notification center like the pages' own (`browser-notifications.ts`), with the same
 * per-site decisions and rate limit.
 *
 * Pages call through the webview preload. Workers call through `service-worker-preload.cjs`, which
 * main registers on the browser panels' session; a worker's IPC only reaches its own
 * `ServiceWorkerMain.ipc`. Main decides by the registration's real scope: a worker's as main sees
 * it, a page's only within the page's own site.
 *
 * A worker has no panel: its notifications go to the most recently focused loaded panel of its
 * origin, and nowhere when none is loaded. Main keeps the notifications by registration, because
 * the browser stops idle workers: `getNotifications()` lists them, and a click starts the worker
 * when needed and dispatches `notificationclick` in it. Chromium gives that event, which a script
 * made, no working `waitUntil()` and lets it open no window, so the preload supplies both, and main
 * opens the one tab `clients.openWindow()` asks for shortly after the click.
 */
import path from "node:path";
import { serialize } from "node:v8";

import {
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type ServiceWorkerMain,
  type Session,
  type WebContents,
  ipcMain,
  webContents,
} from "electron";

import { isHttpUrl } from "../url-utils";
import { onAppWindowMessage } from "./app-windows";
import {
  type RegistrationNotificationInfo,
  type RegistrationShowResult,
  browserNotificationRefSchema,
  registrationNotificationCloseSchema,
  registrationNotificationQuerySchema,
  registrationNotificationSchema,
} from "./browser-notification-protocol";
import {
  capTexts,
  isSecureWebOrigin,
  listeningHost,
  isSiteMuted,
  permissionFor,
  sendToNotificationCenter,
  siteOf,
  withinRateLimit,
} from "./browser-notifications";
import { isIncognitoSession } from "./browser-partition";
import {
  BROWSER_NOTIFICATION_CLICK,
  BROWSER_NOTIFICATION_PERMISSION,
  OPEN_IN_NEW_BROWSER_TAB,
  REGISTRATION_NOTIFICATION_CLICK,
  REGISTRATION_NOTIFICATION_CLICK_DONE,
  REGISTRATION_NOTIFICATION_CLOSE,
  REGISTRATION_NOTIFICATION_LIST,
  REGISTRATION_NOTIFICATION_OPEN_WINDOW,
  REGISTRATION_NOTIFICATION_SHOW,
} from "./ipc-channels";
import { USER_ACTIVATION_MS } from "./user-activation";

/**
 * Largest `data` a notification keeps, structured-cloned. Smaller than Chromium's 1 MB: main holds
 * it in memory until the notification is closed or replaced.
 */
const MAX_DATA_BYTES = 64 * 1024;
/**
 * Live notifications a site keeps across its registrations; showing more forgets its oldest. Per
 * site, not per registration: a page can name any scope of its own site.
 */
const MAX_PER_ORIGIN = 100;
/** Longest registration scope a page may name; real ones are short URLs. */
const MAX_SCOPE_LENGTH = 2048;
/**
 * How long a worker found not to be its scope's first-party registration stays refused before
 * main checks again: long enough that a partitioned worker can't make main start the site's own
 * worker on every call.
 */
const FIRST_PARTY_RECHECK_MS = 10_000;
/** Longest a click keeps its worker running for the `waitUntil()` promises of its handler. */
const CLICK_TASK_MS = 60_000;

/** The browser panel a notification goes to, and the window showing it. */
interface Panel {
  guest: WebContents;
  host: WebContents;
}

/** Who calls about a registration's notifications, as main has checked it. */
interface Caller {
  scope: string;
  origin: string;
  /** The panel its notifications go to now, or null when none is loaded. */
  panel: () => Panel | null;
}

interface RegistrationNotification extends RegistrationNotificationInfo {
  scope: string;
  origin: string;
  /** The panel it was shown for, which a click lets the worker open a tab next to. */
  guestId: number;
  /** The window it went to: the only one whose clicks reach the worker. */
  host: WebContents;
}

/** Live notifications by main's ref, in the order they were shown. */
const notifications = new Map<string, RegistrationNotification>();
let nextRef = 1;

/** Browser panel guests by how recently they had focus (higher is more recent). */
const focusOrder = new Map<number, number>();
let nextFocus = 1;

/** A registration's last click, which lets its worker open one tab shortly after. */
interface Activation {
  at: number;
  guestId: number;
  origin: string;
}
const activations = new Map<string, Activation>();

/** Clicks whose worker main keeps running until their handler is done, by click id. */
const clicks = new Map<number, { scope: string; end: () => void }>();
let nextClickId = 1;

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** The loaded browser panel of `origin` that most recently had focus. */
function focusedPanel(origin: string): Panel | null {
  let best: (Panel & { order: number }) | null = null;
  for (const guest of webContents.getAllWebContents()) {
    if (guest.getType() !== "webview" || guest.isDestroyed()) continue;
    if (guest.mainFrame.origin !== origin) continue;
    const host = listeningHost(guest);
    const order = focusOrder.get(guest.id) ?? 0;
    if (host && (!best || order > best.order)) best = { guest, host, order };
  }
  return best && { guest: best.guest, host: best.host };
}

/** A page calling about its registration of `scope`, which must be of the page's own origin. */
function pageCaller(event: IpcMainEvent | IpcMainInvokeEvent, scope?: string): Caller | null {
  const site = siteOf(event);
  if (!site || !scope || scope.length > MAX_SCOPE_LENGTH || originOf(scope) !== site) return null;
  const guest = event.sender;
  return {
    scope,
    origin: site,
    panel: () => {
      const host = listeningHost(guest);
      return host && { guest, host };
    },
  };
}

function workerOrigin(worker: ServiceWorkerMain): string | null {
  const origin = originOf(worker.scope);
  return origin && isSecureWebOrigin(origin) ? origin : null;
}

interface FirstPartyCheck {
  answer: Promise<boolean>;
  checkedAt: number;
  /** A yes is final for the worker; a no is checked again after `FIRST_PARTY_RECHECK_MS`. */
  confirmed: boolean;
}
const firstPartyChecks = new WeakMap<ServiceWorkerMain, FirstPartyCheck>();

/**
 * Whether the worker belongs to the registration the site made as the top-level page. A site
 * embedded in another one can register a worker from its frame, which Chromium keeps apart
 * (partitioned by the top-level site) though its scope reads the same; it must neither see nor
 * show the site's own notifications. `startWorkerForScope` finds the first-party registration's
 * active version only, so a version still installing doesn't match either: it gets no
 * notifications until it is active and main checks again.
 */
function isFirstParty(session: Session, worker: ServiceWorkerMain): Promise<boolean> {
  const known = firstPartyChecks.get(worker);
  if (known && (known.confirmed || Date.now() - known.checkedAt < FIRST_PARTY_RECHECK_MS)) {
    return known.answer;
  }
  const check: FirstPartyCheck = {
    answer: Promise.resolve(false),
    checkedAt: Date.now(),
    confirmed: false,
  };
  check.answer = session.serviceWorkers.startWorkerForScope(worker.scope).then(
    (active) => {
      check.confirmed = active.versionId === worker.versionId;
      return check.confirmed;
    },
    () => false,
  );
  firstPartyChecks.set(worker, check);
  return check.answer;
}

async function workerCaller(session: Session, worker: ServiceWorkerMain): Promise<Caller | null> {
  const origin = workerOrigin(worker);
  if (!origin || !(await isFirstParty(session, worker))) return null;
  return { scope: worker.scope, origin, panel: () => focusedPanel(origin) };
}

function fitsDataLimit(data: unknown): boolean {
  try {
    return serialize(data).byteLength <= MAX_DATA_BYTES;
  } catch {
    return false;
  }
}

function infoOf(notification: RegistrationNotification): RegistrationNotificationInfo {
  const { ref, title, body, tag, timestamp, data } = notification;
  return { ref, title, body, tag, timestamp, data };
}

/** Forget the notifications whose window is gone: nothing can click them any more. */
function forgetClosedWindows(): void {
  for (const [ref, n] of notifications) {
    if (n.host.isDestroyed()) notifications.delete(ref);
  }
}

/** Keep the site's newest notifications. */
function capOrigin(origin: string): void {
  const own = [...notifications].filter(([, n]) => n.origin === origin);
  for (const [ref] of own.slice(0, Math.max(0, own.length - MAX_PER_ORIGIN))) {
    notifications.delete(ref);
  }
}

function show(caller: Caller | null, value: unknown): RegistrationShowResult {
  const parsed = registrationNotificationSchema.safeParse(value);
  if (!caller || !parsed.success || permissionFor(caller.origin) !== "granted") return "denied";
  const { timestamp, data } = parsed.data;
  if (!fitsDataLimit(data)) return "data-too-large";
  const panel = caller.panel();
  // Resolved like a shown one: only loaded pages notify, and a mute or the rate limit drops the
  // rest quietly.
  if (!panel || isSiteMuted(caller.origin) || !withinRateLimit(panel.guest.id)) return "shown";

  const texts = capTexts(parsed.data);
  // A tag replaces the registration's earlier notification with it, as in browsers.
  for (const [ref, n] of notifications) {
    if (texts.tag && n.scope === caller.scope && n.tag === texts.tag) notifications.delete(ref);
  }
  const ref = `sw-${nextRef++}`;
  notifications.set(ref, {
    ref,
    ...texts,
    timestamp,
    data,
    scope: caller.scope,
    origin: caller.origin,
    guestId: panel.guest.id,
    host: panel.host,
  });
  forgetClosedWindows();
  capOrigin(caller.origin);
  sendToNotificationCenter(panel.host, { ref, guest: panel.guest, ...texts });
  return "shown";
}

function list(caller: Caller | null, value: unknown): RegistrationNotificationInfo[] {
  const parsed = registrationNotificationQuerySchema.safeParse(value);
  if (!caller || !parsed.success) return [];
  const { tag } = parsed.data;
  forgetClosedWindows();
  return [...notifications.values()]
    .filter((n) => n.scope === caller.scope && (!tag || n.tag === tag))
    .map(infoOf);
}

/**
 * The page or worker closed a notification. Like a page's, it stays in the notification center;
 * it just leaves `getNotifications()` and gets no more clicks.
 */
function close(caller: Caller | null, value: unknown): void {
  const parsed = registrationNotificationCloseSchema.safeParse(value);
  if (!caller || !parsed.success) return;
  if (notifications.get(parsed.data.ref)?.scope === caller.scope) {
    notifications.delete(parsed.data.ref);
  }
}

function endClick(clickId: number): void {
  clicks.get(clickId)?.end();
  clicks.delete(clickId);
}

/** Dispatch `notificationclick` in the registration's worker, starting it if it stopped. */
async function click(session: Session, event: IpcMainEvent, value: unknown): Promise<void> {
  const parsed = browserNotificationRefSchema.safeParse(value);
  if (!parsed.success) return;
  const notification = notifications.get(parsed.data.ref);
  if (!notification || notification.host !== event.sender) return;
  const { scope, guestId } = notification;
  let worker: ServiceWorkerMain;
  try {
    worker = await session.serviceWorkers.startWorkerForScope(scope);
  } catch {
    // The site unregistered its worker: nothing is left to tell.
    return;
  }
  const origin = originOf(scope);
  if (worker.isDestroyed() || !origin) return;
  let task: { end: () => void };
  try {
    task = worker.startTask();
  } catch (error) {
    // The worker is stopping or being replaced; the click only shows the panel.
    console.error("[electron] Could not deliver a notification click to a service worker", {
      scope,
      error,
    });
    return;
  }
  activations.set(scope, { at: Date.now(), guestId, origin });
  const clickId = nextClickId++;
  const timer = setTimeout(() => endClick(clickId), CLICK_TASK_MS);
  clicks.set(clickId, {
    scope,
    end: () => {
      clearTimeout(timer);
      if (!worker.isDestroyed()) task.end();
    },
  });
  worker.send(REGISTRATION_NOTIFICATION_CLICK, clickId, infoOf(notification));
}

/**
 * `clients.openWindow()` from the worker: one tab, next to the clicked notification's panel (or the
 * site's most recently focused one when that panel is gone), shortly after a click, as browsers
 * allow it only while handling one.
 */
function openWindow(worker: ServiceWorkerMain, url: unknown): boolean {
  const activation = activations.get(worker.scope);
  if (typeof url !== "string" || !isHttpUrl(url) || !activation) return false;
  if (Date.now() - activation.at >= USER_ACTIVATION_MS) return false;
  const guest = webContents.fromId(activation.guestId);
  const clicked = guest && !guest.isDestroyed() ? listeningHost(guest) : null;
  const panel =
    guest && clicked && guest.mainFrame.origin === activation.origin
      ? { guest, host: clicked }
      : focusedPanel(activation.origin);
  if (!panel) return false;
  // One tab per click, as for pages.
  activations.delete(worker.scope);
  panel.host.send(OPEN_IN_NEW_BROWSER_TAB, panel.guest.id, url, false);
  return true;
}

/** Answer the worker's preload, which runs as the worker starts. */
function listenToWorker(session: Session, worker: ServiceWorkerMain): void {
  const { ipc } = worker;
  // Synchronous, so it can't wait for `isFirstParty`; it only tells the site's decision.
  ipc.on(BROWSER_NOTIFICATION_PERMISSION, (event) => {
    const origin = workerOrigin(worker);
    event.returnValue = origin ? permissionFor(origin) : "denied";
  });
  ipc.handle(REGISTRATION_NOTIFICATION_SHOW, async (_event, value: unknown) =>
    show(await workerCaller(session, worker), value),
  );
  ipc.handle(REGISTRATION_NOTIFICATION_LIST, async (_event, value: unknown) =>
    list(await workerCaller(session, worker), value),
  );
  ipc.on(REGISTRATION_NOTIFICATION_CLOSE, (_event, value: unknown) => {
    void workerCaller(session, worker).then((caller) => close(caller, value));
  });
  ipc.handle(REGISTRATION_NOTIFICATION_OPEN_WINDOW, (_event, url: unknown) =>
    openWindow(worker, url),
  );
  ipc.on(REGISTRATION_NOTIFICATION_CLICK_DONE, (_event, clickId: unknown) => {
    if (typeof clickId === "number" && clicks.get(clickId)?.scope === worker.scope) {
      endClick(clickId);
    }
  });
}

/** The page's registration scope, as it says; `pageCaller` checks it against the page's site. */
function claimedScope(value: unknown): string | undefined {
  const parsed = registrationNotificationQuerySchema.safeParse(value);
  return parsed.success ? parsed.data.scope : undefined;
}

/** Give the browser panels' service workers notifications (`session` is the panels'). */
export function installServiceWorkerNotifications(session: Session): void {
  session.registerPreloadScript({
    type: "service-worker",
    filePath: path.join(import.meta.dirname, "service-worker-preload.cjs"),
  });
  const listened = new WeakSet<ServiceWorkerMain>();
  session.serviceWorkers.on("running-status-changed", ({ versionId, runningStatus }) => {
    // The preload asks main as the worker starts, before it is running.
    if (runningStatus !== "starting") return;
    const worker = session.serviceWorkers.getWorkerFromVersionID(versionId);
    if (!worker || listened.has(worker)) return;
    listened.add(worker);
    listenToWorker(session, worker);
  });

  ipcMain.handle(REGISTRATION_NOTIFICATION_SHOW, (event, value: unknown) =>
    show(pageCaller(event, claimedScope(value)), value),
  );
  ipcMain.handle(REGISTRATION_NOTIFICATION_LIST, (event, value: unknown) =>
    list(pageCaller(event, claimedScope(value)), value),
  );
  ipcMain.on(REGISTRATION_NOTIFICATION_CLOSE, (event, value: unknown) =>
    close(pageCaller(event, claimedScope(value)), value),
  );
  // Next to the pages' listener in browser-notifications.ts: each acts on its own refs only.
  onAppWindowMessage(BROWSER_NOTIFICATION_CLICK, (event, value: unknown) => {
    void click(session, event, value);
  });
}

/**
 * Track which browser panel had focus last (from `web-contents-created`). Not incognito ones: a
 * worker of the browser session must never reach a page of the incognito one.
 */
export function trackWebviewFocus(contents: WebContents): void {
  if (contents.getType() !== "webview" || isIncognitoSession(contents.session)) return;
  const guestId = contents.id;
  // A new panel counts as the most recent until another one gets focus.
  focusOrder.set(guestId, nextFocus++);
  contents.on("focus", () => focusOrder.set(guestId, nextFocus++));
  contents.once("destroyed", () => focusOrder.delete(guestId));
}
