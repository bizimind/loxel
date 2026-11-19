/**
 * Routes browser panel pages' web notifications, which the Electron main process sends to the
 * window (see `src/electron/browser-notifications.ts`), to the panel whose `<webview>` the page is
 * in: a shown notification goes to the notification center with that panel as its source, and a
 * site asking for permission gets the panel's Allow / Block bar. Also keeps main's copy of the
 * per-site decisions and mutes in step with settings.
 */
import { type RefObject, useCallback, useEffect } from "react";

import { sendTo } from "@/api/client";
import type { ServerId } from "@/api/worktree-ref";
import {
  type BrowserNotification,
  type NotificationPermissionRequest,
  type NotificationSiteDecision,
  browserNotificationSchema,
  notificationPermissionRequestSchema,
} from "@/electron/browser-notification-protocol";
import { permissionWithdrawnSchema } from "@/electron/site-permission-protocol";
import { frontendLog } from "@/lib/frontend-logger";
import type { BrowserBookmark } from "@/store/browser-bookmarks";
import { useSettingsStore } from "@/store/settings-store";

import { createWebviewRouter, syncSettingToMain, useWebviewRequests } from "./webview-messages";

const log = frontendLog.child("ui");

interface PanelListener {
  opened: (notification: BrowserNotification) => void;
  request: (request: NotificationPermissionRequest) => void;
  withdraw: (id: number) => void;
}

type Item =
  | { kind: "opened"; notification: BrowserNotification }
  | { kind: "request"; request: NotificationPermissionRequest };

const router = createWebviewRouter<PanelListener, Item>((listener, item) => {
  if (item.kind === "opened") listener.opened(item.notification);
  else listener.request(item.request);
}, 20);
let listening = false;

function warnMalformed(error: { message: string }): void {
  log.warn("Ignoring malformed browser notification message", { error: error.message });
}

function handleOpened(value: unknown): void {
  const parsed = browserNotificationSchema.safeParse(value);
  if (!parsed.success) return warnMalformed(parsed.error);
  router.deliver(parsed.data.webContentsId, { kind: "opened", notification: parsed.data });
}

function handleRequest(value: unknown): void {
  const parsed = notificationPermissionRequestSchema.safeParse(value);
  if (!parsed.success) return warnMalformed(parsed.error);
  router.deliver(parsed.data.webContentsId, { kind: "request", request: parsed.data });
}

function handleWithdrawn(value: unknown): void {
  const parsed = permissionWithdrawnSchema.safeParse(value);
  if (!parsed.success) return warnMalformed(parsed.error);
  const { id, webContentsId } = parsed.data;
  router
    .withdraw(webContentsId, (item) => item.kind === "request" && item.request.id === id)
    ?.withdraw(id);
}

/**
 * One window-wide subscription, kept for the window's lifetime and started when the first browser
 * panel mounts, before its webview loads a page. Also sends main the settings' per-site decisions
 * and mutes; mutes go first, so no muted site's notification gets through once the decisions let
 * pages notify.
 */
function listen(): void {
  if (listening || !window.electronAPI) return;
  listening = true;
  window.electronAPI.onBrowserNotifications({
    onOpened: handleOpened,
    onPermissionRequest: handleRequest,
    onPermissionWithdrawn: handleWithdrawn,
  });
  syncSettingToMain(
    (state) => state.browser.notificationMutes,
    (mutes) => window.electronAPI?.setNotificationMutes(mutes),
  );
  syncSettingToMain(
    (state) => state.browser.notificationSites,
    (sites) => window.electronAPI?.setNotificationSites(sites),
  );
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
  server: ServerId,
  notification: BrowserNotification,
  panelId: string,
  worktreePath: string | null,
  page: PanelPage,
): void {
  const { ref, origin, title, body, tag } = notification;
  const faviconUrl = faviconFor(page, origin);
  sendTo(server, {
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
 * shown in the notification center of `server` (the layout's) as coming from the browser panel
 * `panelId` in the layout of `worktreePath` (null: Home's), whether or not that layout is shown, with the favicon of the page
 * `pageRef` holds when one arrives. `request` is the oldest open permission request, for the
 * panel's prompt, and `answer` replies to it: Allow and Block are saved for the site, Dismiss
 * decides nothing.
 */
export function useBrowserNotifications(
  server: ServerId,
  webContentsId: number | null,
  panelId: string,
  worktreePath: string | null,
  pageRef: RefObject<PanelPage>,
): {
  request: NotificationPermissionRequest | null;
  answer: (answer: NotificationPermissionAnswer) => void;
} {
  const { requests, add, remove } =
    useWebviewRequests<NotificationPermissionRequest>(webContentsId);

  useEffect(() => {
    listen();
    if (webContentsId === null) return;
    return router.subscribe(webContentsId, {
      opened: (notification) =>
        showInNotificationCenter(server, notification, panelId, worktreePath, pageRef.current),
      request: add,
      withdraw: remove,
    });
  }, [server, webContentsId, panelId, worktreePath, pageRef, add, remove]);

  const request = requests[0] ?? null;
  const answer = useCallback(
    (decision: NotificationPermissionAnswer) => {
      if (!request) return;
      window.electronAPI?.respondToNotificationPermission({ id: request.id, decision });
      if (decision !== "dismiss") {
        useSettingsStore.getState().setNotificationSite(request.origin, decision);
      }
      remove(request.id);
    },
    [request, remove],
  );

  return { request, answer };
}
