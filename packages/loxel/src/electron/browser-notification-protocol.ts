/**
 * Messages that carry a browser panel page's web notifications (`new Notification()`,
 * `Notification.requestPermission()`) from the webview's preload, through the main process, to the
 * window renderer that shows them in Loxel's notification center (see `browser-notifications.ts`),
 * and the ones a service worker registration shows, from the page or the worker's own preload
 * (see `service-worker-notifications.ts`).
 */
import { z } from "zod";

/** What the user decided for a site: its pages may show notifications, or never ask again. */
export const notificationSiteDecisionSchema = z.enum(["allow", "block"]);
export type NotificationSiteDecision = z.infer<typeof notificationSiteDecisionSchema>;

/** Decisions by origin (`https://example.com`), kept in Loxel's settings. */
export type NotificationSites = Record<string, NotificationSiteDecision>;

/** The valid entries of stored or sent decisions; anything else (hand-edited) is dropped. */
export function parseNotificationSites(value: unknown): NotificationSites {
  if (typeof value !== "object" || value === null) return {};
  const sites: NotificationSites = {};
  for (const [origin, decision] of Object.entries(value)) {
    const parsed = notificationSiteDecisionSchema.safeParse(decision);
    if (parsed.success) sites[origin] = parsed.data;
  }
  return sites;
}

/** `Notification.permission`, as the page sees it. */
export type NotificationPermissionState = "default" | "granted" | "denied";

/** Webview preload → main: the page constructed a `Notification`. */
export const pageNotificationSchema = z.object({
  /** The page's own id for the object, to deliver its `click` event. */
  pageId: z.number().int(),
  title: z.string(),
  body: z.string(),
  tag: z.string(),
});

/** Main → window renderer: show a page's notification for the panel hosting `webContentsId`. */
export const browserNotificationSchema = z.object({
  /** Main's id for the page's notification, for clicks and `close()`. */
  ref: z.string(),
  /** The guest webContents of the panel's `<webview>`. */
  webContentsId: z.number().int(),
  origin: z.string(),
  title: z.string(),
  body: z.string(),
  tag: z.string(),
});
export type BrowserNotification = z.infer<typeof browserNotificationSchema>;

/** Window renderer → main: the user clicked a page's notification (by main's ref). */
export const browserNotificationRefSchema = z.object({ ref: z.string() });

/** Main → window renderer: ask the user whether `origin` may show notifications. */
export const notificationPermissionRequestSchema = z.object({
  id: z.number().int(),
  webContentsId: z.number().int(),
  origin: z.string(),
});
export type NotificationPermissionRequest = z.infer<typeof notificationPermissionRequestSchema>;

/** Window renderer → main: the user's answer; `dismiss` decides nothing, so the page may ask again. */
export const notificationPermissionResponseSchema = z.object({
  id: z.number().int(),
  decision: z.union([notificationSiteDecisionSchema, z.literal("dismiss")]),
});
export type NotificationPermissionResponse = z.infer<typeof notificationPermissionResponseSchema>;

/** Main → window renderer: a request was withdrawn (answered elsewhere, or the page went away). */
export const notificationPermissionWithdrawnSchema = z.object({
  id: z.number().int(),
  webContentsId: z.number().int(),
});

/**
 * Webview or service worker preload → main (invoke): `ServiceWorkerRegistration.showNotification()`.
 * `scope` is the registration's, sent by pages only: a worker's own scope is known to main.
 */
export const registrationNotificationSchema = z.object({
  scope: z.string().optional(),
  title: z.string(),
  body: z.string(),
  tag: z.string(),
  timestamp: z.number(),
  /** The `data` option, structured-cloned; handed back to the worker on clicks. */
  data: z.unknown(),
});

/** Main → preload: why `showNotification()` was refused, or `shown` (also when dropped quietly). */
export type RegistrationShowResult = "shown" | "denied" | "data-too-large";

/** Preload → main: `getNotifications()` (invoke), or `close()` on one of them (by main's ref). */
export const registrationNotificationQuerySchema = z.object({
  scope: z.string().optional(),
  tag: z.string().optional(),
});
export const registrationNotificationCloseSchema = z.object({
  scope: z.string().optional(),
  ref: z.string(),
});

/**
 * Main → preload: a live notification of a registration, for `getNotifications()` and the
 * worker's `notificationclick`; `ref` is main's id for it, which `close()` sends back.
 */
export interface RegistrationNotificationInfo {
  ref: string;
  title: string;
  body: string;
  tag: string;
  timestamp: number;
  data: unknown;
}
