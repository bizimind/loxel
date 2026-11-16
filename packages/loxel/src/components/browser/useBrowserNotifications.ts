/**
 * Routes browser panel pages' web notifications, which the Electron main process sends to the
 * window (see `src/electron/browser-notifications.ts`), to the panel whose `<webview>` the page is
 * in: a shown notification goes to the notification center with that panel as its source, and a
 * site asking for permission gets the panel's Allow / Block bar. Also keeps main's copy of the
 * per-site decisions and mutes in step with settings.
 */
import { type RefObject, useCallback, useEffect, useMemo, useState } from "react";

import { wsClient } from "@/api/client";
import {
  type BrowserNotification,
  type NotificationPermissionRequest,
  type NotificationSiteDecision,
  browserNotificationSchema,
  notificationPermissionRequestSchema,
  notificationPermissionWithdrawnSchema,
} from "@/electron/browser-notification-protocol";
import { frontendLog } from "@/lib/frontend-logger";
import type { BrowserBookmark } from "@/store/browser-bookmarks";
import { useSettingsStore } from "@/store/settings-store";
import { useWorktreeStore } from "@/store/worktrees";

const log = frontendLog.child("ui");

interface PanelListener {
  opened: (notification: BrowserNotification) => void;
  request: (request: NotificationPermissionRequest) => void;
  withdraw: (id: number) => void;
}

type Unclaimed =
  | { kind: "opened"; notification: BrowserNotification }
  | { kind: "request"; request: NotificationPermissionRequest };

/** Browser panels by the guest webContents id of their webview. */
const listeners = new Map<number, PanelListener>();
/**
 * What arrived for a webview whose panel hasn't subscribed yet (a page can notify while loading,
 * before the panel knows its webContents id). Bounded: a webview no panel claims must not grow it.
 */
const unclaimed = new Map<number, Unclaimed[]>();
const MAX_UNCLAIMED = 20;
let listening = false;

function hold(webContentsId: number, item: Unclaimed): void {
  const held = [...(unclaimed.get(webContentsId) ?? []), item].slice(-MAX_UNCLAIMED);
  unclaimed.set(webContentsId, held);
}

function warnMalformed(error: { message: string }): void {
  log.warn("Ignoring malformed browser notification message", { error: error.message });
}

function handleOpened(value: unknown): void {
  const parsed = browserNotificationSchema.safeParse(value);
  if (!parsed.success) return warnMalformed(parsed.error);
  const notification = parsed.data;
  const listener = listeners.get(notification.webContentsId);
  if (listener) listener.opened(notification);
  else hold(notification.webContentsId, { kind: "opened", notification });
}

function handleRequest(value: unknown): void {
  const parsed = notificationPermissionRequestSchema.safeParse(value);
  if (!parsed.success) return warnMalformed(parsed.error);
  const request = parsed.data;
  const listener = listeners.get(request.webContentsId);
  if (listener) listener.request(request);
  else hold(request.webContentsId, { kind: "request", request });
}

function handleWithdrawn(value: unknown): void {
  const parsed = notificationPermissionWithdrawnSchema.safeParse(value);
  if (!parsed.success) return warnMalformed(parsed.error);
  const { id, webContentsId } = parsed.data;
  listeners.get(webContentsId)?.withdraw(id);
  const waiting = unclaimed
    .get(webContentsId)
    ?.filter((item) => item.kind !== "request" || item.request.id !== id);
  if (waiting?.length) unclaimed.set(webContentsId, waiting);
  else unclaimed.delete(webContentsId);
}

/** Send main the settings' per-site decisions and mutes now and whenever they change. */
function syncSitesToMain(): void {
  const pushMutes = () =>
    window.electronAPI?.setNotificationMutes(useSettingsStore.getState().browser.notificationMutes);
  const pushSites = () =>
    window.electronAPI?.setNotificationSites(useSettingsStore.getState().browser.notificationSites);
  // Not before hydration: main would take the defaults for the user's decisions. Mutes go first,
  // so no muted site's notification gets through once the decisions let pages notify.
  const pushAll = () => {
    pushMutes();
    pushSites();
  };
  if (useSettingsStore.persist.hasHydrated()) pushAll();
  else useSettingsStore.persist.onFinishHydration(pushAll);
  useSettingsStore.subscribe((state, previous) => {
    if (state.browser.notificationMutes !== previous.browser.notificationMutes) pushMutes();
    if (state.browser.notificationSites !== previous.browser.notificationSites) pushSites();
  });
}

/**
 * One window-wide subscription, kept for the window's lifetime and started when the first browser
 * panel mounts, before its webview loads a page.
 */
function listen(): void {
  if (listening || !window.electronAPI) return;
  listening = true;
  window.electronAPI.onBrowserNotifications({
    onOpened: handleOpened,
    onPermissionRequest: handleRequest,
    onPermissionWithdrawn: handleWithdrawn,
  });
  syncSitesToMain();
}

function subscribe(webContentsId: number, listener: PanelListener): () => void {
  listeners.set(webContentsId, listener);
  for (const item of unclaimed.get(webContentsId) ?? []) {
    if (item.kind === "opened") listener.opened(item.notification);
    else listener.request(item.request);
  }
  unclaimed.delete(webContentsId);
  return () => {
    if (listeners.get(webContentsId) === listener) listeners.delete(webContentsId);
  };
}

/** The page a browser panel shows (its URL is empty while there is none), with its tab's favicon. */
type PanelPage = Pick<BrowserBookmark, "url" | "faviconUrl">;

/**
 * The favicon of `page` for a notification from `origin`: none unless the panel still shows that
 * site, since the page may have navigated away before the notification arrived.
 */
function faviconFor(page: PanelPage, origin: string): string | undefined {
  if (!page.faviconUrl || !URL.canParse(page.url)) return undefined;
  return new URL(page.url).origin === origin ? page.faviconUrl : undefined;
}

/**
 * Add a page's notification to the notification center, from the browser panel `panelId` in the
 * layout of `worktreePath` (null: Home's), with the favicon the panel's tab shows for `page`.
 */
function showInNotificationCenter(
  notification: BrowserNotification,
  panelId: string,
  worktreePath: string | null,
  page: PanelPage,
): void {
  const { ref, origin, title, body, tag } = notification;
  const faviconUrl = faviconFor(page, origin);
  wsClient.send({
    type: "browser_notification_show",
    source: {
      kind: "browser",
      panelId,
      origin,
      ref,
      worktreePath,
      ...(tag && { tag }),
      ...(faviconUrl && { faviconUrl }),
    },
    title,
    ...(body && { body }),
  });
}

export type NotificationPermissionAnswer = NotificationSiteDecision | "dismiss";

/**
 * The web notifications of the webview with this guest webContents id (null until it is ready),
 * shown in the notification center as coming from the browser panel `panelId`, with the favicon of
 * the page `pageRef` holds when one arrives. `request` is the oldest open permission request, for
 * the panel's prompt, and `answer` replies to it: Allow and Block are saved for the site, Dismiss
 * decides nothing.
 */
export function useBrowserNotifications(
  webContentsId: number | null,
  panelId: string,
  pageRef: RefObject<PanelPage>,
): {
  request: NotificationPermissionRequest | null;
  answer: (answer: NotificationPermissionAnswer) => void;
} {
  const [queue, setQueue] = useState<NotificationPermissionRequest[]>([]);
  // The worktree whose layout the panel mounted in, or Home's (null). Read once: during a switch
  // the active worktree is already the next one while this panel's layout is still up.
  const [worktreePath] = useState(() => useWorktreeStore.getState().activeWorktreePath);

  useEffect(() => {
    listen();
    if (webContentsId === null) return;
    return subscribe(webContentsId, {
      opened: (notification) =>
        showInNotificationCenter(notification, panelId, worktreePath, pageRef.current),
      // A new guest (the webview was re-created) drops the old guest's requests.
      request: (request) =>
        setQueue((prev) => [...prev.filter((r) => r.webContentsId === webContentsId), request]),
      withdraw: (id) => setQueue((prev) => prev.filter((request) => request.id !== id)),
    });
  }, [webContentsId, panelId, worktreePath, pageRef]);

  const request = useMemo(
    () => queue.find((r) => r.webContentsId === webContentsId) ?? null,
    [queue, webContentsId],
  );
  const answer = useCallback(
    (decision: NotificationPermissionAnswer) => {
      if (!request) return;
      window.electronAPI?.respondToNotificationPermission({ id: request.id, decision });
      if (decision !== "dismiss") {
        useSettingsStore.getState().setNotificationSite(request.origin, decision);
      }
      setQueue((prev) => prev.filter((r) => r.id !== request.id));
    },
    [request],
  );

  return { request, answer };
}
