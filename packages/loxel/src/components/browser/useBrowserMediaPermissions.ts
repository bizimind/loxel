/**
 * Routes browser panel pages' camera and microphone requests, which the Electron main process
 * sends to the window (see `src/electron/browser-media.ts`), to the panel whose `<webview>` the
 * page is in, for its permission bar. Also keeps main's copy of the per-site decisions in step with
 * settings.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  type MediaPermissionAnswer,
  type MediaPermissionRequest,
  type MediaSystemBlocked,
  mediaPermissionRequestSchema,
  mediaPermissionWithdrawnSchema,
  mediaSystemBlockedSchema,
} from "@/electron/browser-media-protocol";
import { frontendLog } from "@/lib/frontend-logger";
import { useSettingsStore } from "@/store/settings-store";

const log = frontendLog.child("ui");

interface PanelListener {
  request: (request: MediaPermissionRequest) => void;
  withdraw: (id: number) => void;
  systemBlocked: (notice: MediaSystemBlocked) => void;
}

type Unclaimed =
  | { kind: "request"; request: MediaPermissionRequest }
  | { kind: "system-blocked"; notice: MediaSystemBlocked };

/** Browser panels by the guest webContents id of their webview. */
const listeners = new Map<number, PanelListener>();
/**
 * What arrived for a webview whose panel hasn't subscribed yet (a page can ask while loading,
 * before the panel knows its webContents id). Bounded: a webview no panel claims must not grow it.
 */
const unclaimed = new Map<number, Unclaimed[]>();
const MAX_UNCLAIMED = 20;
let listening = false;

function deliver(webContentsId: number, item: Unclaimed): void {
  const listener = listeners.get(webContentsId);
  if (listener && item.kind === "request") return listener.request(item.request);
  if (listener && item.kind === "system-blocked") return listener.systemBlocked(item.notice);
  const held = [...(unclaimed.get(webContentsId) ?? []), item].slice(-MAX_UNCLAIMED);
  unclaimed.set(webContentsId, held);
}

function warnMalformed(error: { message: string }): void {
  log.warn("Ignoring malformed camera or microphone permission message", { error: error.message });
}

function handleRequest(value: unknown): void {
  const parsed = mediaPermissionRequestSchema.safeParse(value);
  if (!parsed.success) return warnMalformed(parsed.error);
  deliver(parsed.data.webContentsId, { kind: "request", request: parsed.data });
}

function handleWithdrawn(value: unknown): void {
  const parsed = mediaPermissionWithdrawnSchema.safeParse(value);
  if (!parsed.success) return warnMalformed(parsed.error);
  const { id, webContentsId } = parsed.data;
  listeners.get(webContentsId)?.withdraw(id);
  const waiting = unclaimed
    .get(webContentsId)
    ?.filter((item) => item.kind !== "request" || item.request.id !== id);
  if (waiting?.length) unclaimed.set(webContentsId, waiting);
  else unclaimed.delete(webContentsId);
}

function handleSystemBlocked(value: unknown): void {
  const parsed = mediaSystemBlockedSchema.safeParse(value);
  if (!parsed.success) return warnMalformed(parsed.error);
  deliver(parsed.data.webContentsId, { kind: "system-blocked", notice: parsed.data });
}

/** Send main the settings' per-site decisions now and whenever they change. */
function syncSitesToMain(): void {
  const push = () =>
    window.electronAPI?.setMediaSites(useSettingsStore.getState().browser.mediaSites);
  // Not before hydration: main would take the defaults for the user's decisions.
  if (useSettingsStore.persist.hasHydrated()) push();
  else useSettingsStore.persist.onFinishHydration(push);
  useSettingsStore.subscribe((state, previous) => {
    if (state.browser.mediaSites !== previous.browser.mediaSites) push();
  });
}

/**
 * One window-wide subscription, kept for the window's lifetime and started when the first browser
 * panel mounts, before its webview loads a page.
 */
function listen(): void {
  if (listening || !window.electronAPI) return;
  listening = true;
  window.electronAPI.onBrowserMediaPermissions({
    onRequest: handleRequest,
    onWithdrawn: handleWithdrawn,
    onSystemBlocked: handleSystemBlocked,
  });
  syncSitesToMain();
}

function subscribe(webContentsId: number, listener: PanelListener): () => void {
  listeners.set(webContentsId, listener);
  const held = unclaimed.get(webContentsId) ?? [];
  unclaimed.delete(webContentsId);
  for (const item of held) deliver(webContentsId, item);
  return () => {
    if (listeners.get(webContentsId) === listener) listeners.delete(webContentsId);
  };
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
  answer: (answer: MediaPermissionAnswer) => void;
  systemBlocked: MediaSystemBlocked | null;
  dismissSystemBlocked: () => void;
} {
  const [queue, setQueue] = useState<MediaPermissionRequest[]>([]);
  const [systemBlocked, setSystemBlocked] = useState<MediaSystemBlocked | null>(null);

  useEffect(() => {
    listen();
    if (webContentsId === null) return;
    return subscribe(webContentsId, {
      // A new guest (the webview was re-created) drops the old guest's requests. A request sent
      // again (the page asked for another device) replaces its earlier version in place.
      request: (request) =>
        setQueue((prev) => {
          const own = prev.filter((r) => r.webContentsId === webContentsId);
          return own.some((r) => r.id === request.id)
            ? own.map((r) => (r.id === request.id ? request : r))
            : [...own, request];
        }),
      withdraw: (id) => setQueue((prev) => prev.filter((request) => request.id !== id)),
      systemBlocked: setSystemBlocked,
    });
  }, [webContentsId]);

  const request = useMemo(
    () => queue.find((r) => r.webContentsId === webContentsId) ?? null,
    [queue, webContentsId],
  );
  const answer = useCallback(
    (reply: MediaPermissionAnswer) => {
      if (!request) return;
      window.electronAPI?.respondToMediaPermission({ id: request.id, answer: reply });
      if (reply === "allow" || reply === "block") {
        useSettingsStore.getState().setMediaSite(request.origin, request.devices, reply);
      }
      setQueue((prev) => prev.filter((r) => r.id !== request.id));
    },
    [request],
  );
  const dismissSystemBlocked = useCallback(() => setSystemBlocked(null), []);
  const pageOrigin = URL.canParse(pageUrl) ? new URL(pageUrl).origin : null;
  const shown =
    systemBlocked?.webContentsId === webContentsId && systemBlocked.origin === pageOrigin
      ? systemBlocked
      : null;

  return { request, answer, systemBlocked: shown, dismissSystemBlocked };
}
