/**
 * Routes browser panel pages' web notifications, which the Electron main process sends to the
 * window (see `src/electron/browser-notifications.ts`), to the panel whose `<webview>` the page is
 * in: a shown notification goes to the notification center with that panel as its source, and a
 * site asking for permission gets the panel's Allow / Block bar. Also keeps main's copy of the
 * per-site decisions in step with settings.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

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
import { useSettingsStore } from "@/store/settings-store";

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

/** Send main the settings' per-site decisions now and whenever they change. */
function syncSitesToMain(): void {
  const push = () =>
    window.electronAPI?.setNotificationSites(useSettingsStore.getState().browser.notificationSites);
  // Not before hydration: main would take the defaults for the user's decisions.
  if (useSettingsStore.persist.hasHydrated()) push();
  else useSettingsStore.persist.onFinishHydration(push);
  useSettingsStore.subscribe((state, previous) => {
    if (state.browser.notificationSites !== previous.browser.notificationSites) push();
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

/**
 * Add a page's notification to the notification center, from the browser panel `panelId` in the
 * layout of `worktreePath` (null: Home's).
 */
function showInNotificationCenter(
  notification: BrowserNotification,
  panelId: string,
  worktreePath: string | null,
): void {
  const { ref, origin, title, body, tag } = notification;
  wsClient.send({
    type: "browser_notification_show",
    source: { kind: "browser", panelId, origin, ref, worktreePath, ...(tag && { tag }) },
    title,
    ...(body && { body }),
  });
}

export type NotificationPermissionAnswer = NotificationSiteDecision | "dismiss";

/**
 * The web notifications of the webview with this guest webContents id (null until it is ready),
 * shown in the notification center as coming from the browser panel `panelId` in the layout of
 * `worktreePath` (null: Home's), whether or not that layout is shown. `request` is the
 * oldest open permission request, for the panel's prompt, and `answer` replies to it: Allow and
 * Block are saved for the site, Dismiss decides nothing.
 */
export function useBrowserNotifications(
  webContentsId: number | null,
  panelId: string,
  worktreePath: string | null,
): {
  request: NotificationPermissionRequest | null;
  answer: (answer: NotificationPermissionAnswer) => void;
} {
  const [queue, setQueue] = useState<NotificationPermissionRequest[]>([]);

  useEffect(() => {
    listen();
    if (webContentsId === null) return;
    return subscribe(webContentsId, {
      opened: (notification) => showInNotificationCenter(notification, panelId, worktreePath),
      // A new guest (the webview was re-created) drops the old guest's requests.
      request: (request) =>
        setQueue((prev) => [...prev.filter((r) => r.webContentsId === webContentsId), request]),
      withdraw: (id) => setQueue((prev) => prev.filter((request) => request.id !== id)),
    });
  }, [webContentsId, panelId, worktreePath]);

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
