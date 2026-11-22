/**
 * Routes browser panel pages' requests to open a link in another app, to reach the local network,
 * or to read or write a file, which the Electron main process sends to the window (see
 * `src/electron/browser-site-access.ts`), to the panel whose `<webview>` the page is in, for its
 * permission bar. Also keeps main's copy of the per-site decisions in step with settings.
 */
import { useCallback, useEffect } from "react";

import {
  type SiteAccessRequest,
  type SiteAccessSites,
  type SitePermissionAnswer,
  permissionWithdrawnSchema,
  siteAccessRequestSchema,
} from "@/electron/site-permission-protocol";
import { frontendLog } from "@/lib/frontend-logger";
import { type SettingsState, useSettingsStore } from "@/store/settings-store";

import { createWebviewRouter, syncSettingToMain, useWebviewRequests } from "./webview-messages";

const log = frontendLog.child("ui");

interface PanelListener {
  request: (request: SiteAccessRequest) => void;
  withdraw: (id: number) => void;
}

const router = createWebviewRouter<PanelListener, SiteAccessRequest>(
  (listener, request) => listener.request(request),
  20,
);
let listening = false;

function warnMalformed(error: { message: string }): void {
  log.warn("Ignoring malformed site access message", { error: error.message });
}

function handleRequest(value: unknown): void {
  const parsed = siteAccessRequestSchema.safeParse(value);
  if (!parsed.success) return warnMalformed(parsed.error);
  router.deliver(parsed.data.webContentsId, parsed.data);
}

function handleWithdrawn(value: unknown): void {
  const parsed = permissionWithdrawnSchema.safeParse(value);
  if (!parsed.success) return warnMalformed(parsed.error);
  const { id, webContentsId } = parsed.data;
  router.withdraw(webContentsId, (request) => request.id === id)?.withdraw(id);
}

const siteAccessSites = ({ browser }: SettingsState): SiteAccessSites => ({
  externalApps: browser.externalAppSites,
  localNetwork: browser.localNetworkSites,
});

const sameSites = (a: SiteAccessSites, b: SiteAccessSites) =>
  a.externalApps === b.externalApps && a.localNetwork === b.localNetwork;

/**
 * One window-wide subscription, kept for the window's lifetime and started when the first browser
 * panel mounts, before its webview loads a page.
 */
function listen(): void {
  if (listening || !window.electronAPI) return;
  listening = true;
  window.electronAPI.onSiteAccess({ onRequest: handleRequest, onWithdrawn: handleWithdrawn });
  syncSettingToMain(
    siteAccessSites,
    (sites) => window.electronAPI?.setSiteAccessSites(sites),
    sameSites,
  );
}

/**
 * The site access requests of the webview with this guest webContents id (null until it is
 * ready). `request` is the oldest open one, for the panel's prompt, and `answer` replies to it:
 * Allow and Block are saved for the site (file access is never saved).
 */
export function useSiteAccess(webContentsId: number | null): {
  request: SiteAccessRequest | null;
  answer: (answer: SitePermissionAnswer) => void;
} {
  const { requests, add, remove } = useWebviewRequests<SiteAccessRequest>(webContentsId);

  useEffect(() => {
    listen();
    if (webContentsId === null) return;
    return router.subscribe(webContentsId, { request: add, withdraw: remove });
  }, [webContentsId, add, remove]);

  const request = requests[0] ?? null;
  const answer = useCallback(
    (reply: SitePermissionAnswer) => {
      if (!request) return;
      window.electronAPI?.respondToSiteAccess({ id: request.id, answer: reply });
      if (reply === "allow" || reply === "block") {
        const { access } = request;
        const store = useSettingsStore.getState();
        if (access.kind === "external-app") {
          store.setExternalAppSite(access.origin, access.scheme, reply);
        } else if (access.kind === "local-network") {
          store.setLocalNetworkSite(access.origin, reply);
        }
      }
      remove(request.id);
    },
    [request, remove],
  );

  return { request, answer };
}
