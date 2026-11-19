/**
 * Routes browser panel pages' camera and microphone requests, which the Electron main process
 * sends to the window (see `src/electron/browser-media.ts`), to the panel whose `<webview>` the
 * page is in, for its permission bar. Also keeps main's copy of the per-site decisions in step with
 * settings.
 */
import { useCallback, useEffect, useState } from "react";

import {
  type MediaPermissionRequest,
  type MediaSystemBlocked,
  mediaPermissionRequestSchema,
  mediaSystemBlockedSchema,
} from "@/electron/browser-media-protocol";
import {
  type SitePermissionAnswer,
  permissionWithdrawnSchema,
} from "@/electron/site-permission-protocol";
import { frontendLog } from "@/lib/frontend-logger";
import { useSettingsStore } from "@/store/settings-store";

import { createWebviewRouter, syncSettingToMain, useWebviewRequests } from "./webview-messages";

const log = frontendLog.child("ui");

interface PanelListener {
  request: (request: MediaPermissionRequest) => void;
  withdraw: (id: number) => void;
  systemBlocked: (notice: MediaSystemBlocked) => void;
}

type Item =
  | { kind: "request"; request: MediaPermissionRequest }
  | { kind: "system-blocked"; notice: MediaSystemBlocked };

const router = createWebviewRouter<PanelListener, Item>((listener, item) => {
  if (item.kind === "request") listener.request(item.request);
  else listener.systemBlocked(item.notice);
}, 20);
let listening = false;

function warnMalformed(error: { message: string }): void {
  log.warn("Ignoring malformed camera or microphone permission message", { error: error.message });
}

function handleRequest(value: unknown): void {
  const parsed = mediaPermissionRequestSchema.safeParse(value);
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

function handleSystemBlocked(value: unknown): void {
  const parsed = mediaSystemBlockedSchema.safeParse(value);
  if (!parsed.success) return warnMalformed(parsed.error);
  router.deliver(parsed.data.webContentsId, { kind: "system-blocked", notice: parsed.data });
}

/**
 * One window-wide subscription, kept for the window's lifetime and started when the first browser
 * panel mounts, before its webview loads a page. Also keeps main's copy of the per-site decisions
 * in step with settings.
 */
function listen(): void {
  if (listening || !window.electronAPI) return;
  listening = true;
  window.electronAPI.onBrowserMediaPermissions({
    onRequest: handleRequest,
    onWithdrawn: handleWithdrawn,
    onSystemBlocked: handleSystemBlocked,
  });
  syncSettingToMain(
    (state) => state.browser.mediaSites,
    (sites) => window.electronAPI?.setMediaSites(sites),
  );
}

/**
 * The camera and microphone requests of the webview with this guest webContents id (null until it
 * is ready). `request` is the oldest open one, for the panel's prompt, and `answer` replies to it:
 * Allow and Block are saved for the site. `systemBlocked` is set when an allowed site was refused
 * because macOS has Loxel's access off, until `dismissSystemBlocked` or the panel's page (`pageUrl`)
 * leaves that site.
 */
export function useBrowserMediaPermissions(
  webContentsId: number | null,
  pageUrl: string,
): {
  request: MediaPermissionRequest | null;
  answer: (answer: SitePermissionAnswer) => void;
  systemBlocked: MediaSystemBlocked | null;
  dismissSystemBlocked: () => void;
} {
  const { requests, add, remove } = useWebviewRequests<MediaPermissionRequest>(webContentsId);
  const [systemBlocked, setSystemBlocked] = useState<MediaSystemBlocked | null>(null);

  useEffect(() => {
    listen();
    if (webContentsId === null) return;
    return router.subscribe(webContentsId, {
      request: add,
      withdraw: remove,
      systemBlocked: setSystemBlocked,
    });
  }, [webContentsId, add, remove]);

  const request = requests[0] ?? null;
  const answer = useCallback(
    (reply: SitePermissionAnswer) => {
      if (!request) return;
      window.electronAPI?.respondToMediaPermission({ id: request.id, answer: reply });
      if (reply === "allow" || reply === "block") {
        useSettingsStore.getState().setMediaSite(request.origin, request.devices, reply);
      }
      remove(request.id);
    },
    [request, remove],
  );
  const dismissSystemBlocked = useCallback(() => setSystemBlocked(null), []);
  const pageOrigin = URL.canParse(pageUrl) ? new URL(pageUrl).origin : null;
  const shown =
    systemBlocked?.webContentsId === webContentsId && systemBlocked.origin === pageOrigin
      ? systemBlocked
      : null;

  return { request, answer, systemBlocked: shown, dismissSystemBlocked };
}
