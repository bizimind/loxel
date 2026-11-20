/**
 * Site access that browser panels ask the user about, as browsers do: opening a link in another
 * app (`browser-external-apps.ts`), reaching this machine or the local network
 * (`browser-local-network.ts`), and reading or writing a file the user gave the page
 * (`browser-file-access.ts`).
 *
 * A site without a decision gets a bar in the panel of the page that asked: Allow and Block are
 * saved for the site (and, for apps, the link's scheme) in Loxel's settings, which window renderers
 * send here on load and on every change. Allow this time opens that one link, or lets the page
 * reach the local network while the panel stays on the site. File access is never saved: the answer
 * lasts as long as the page holds the file or folder (Chromium keeps it), and a later visit asks
 * again, as in Chrome. Requests from the same page for the same access
 * share one prompt and one answer.
 */
import type { IpcMainEvent, WebContents } from "electron";

import { onAppWindowMessage } from "./app-windows";
import {
  SITE_ACCESS_LISTEN,
  SITE_ACCESS_REQUEST,
  SITE_ACCESS_RESPOND,
  SITE_ACCESS_SET_SITES,
  SITE_ACCESS_WITHDRAWN,
} from "./ipc-channels";
import { createListeningRenderers } from "./listening-renderers";
import { createPermissionPrompts, createSettingsMirror } from "./permission-prompts";
import {
  type SiteAccess,
  type SiteAccessRequest,
  type SiteAccessSites,
  type SiteDecision,
  parseSiteAccessSites,
  sitePermissionResponseSchema,
  withExternalAppDecision,
} from "./site-permission-protocol";

const sites = createSettingsMirror<SiteAccessSites>({ externalApps: {}, localNetwork: {} });

const listeningHosts = createListeningRenderers();

interface PendingRequest {
  guestId: number;
  host: WebContents;
  origin: string;
  access: SiteAccess;
  /** What waits on the answer, told whether it may go ahead. */
  waiters: ((allowed: boolean) => void)[];
}
const prompts = createPermissionPrompts<PendingRequest>(
  { request: SITE_ACCESS_REQUEST, withdrawn: SITE_ACCESS_WITHDRAWN },
  (id, pending): SiteAccessRequest => ({
    id,
    webContentsId: pending.guestId,
    access: pending.access,
  }),
);

/** Local network access granted with "Allow this time": the site each guest's panel was on. */
const localNetworkOnce = new Map<number, string>();
/**
 * Guests whose page closed its local network prompt: its requests are refused without asking
 * until it navigates, since every request would put the prompt straight back up.
 */
const dismissedLocalNetwork = new Set<number>();

/** The saved decision for `access`, if the user made one. File access has none. */
function savedDecision(access: SiteAccess): SiteDecision | undefined {
  const { externalApps, localNetwork } = sites.get();
  switch (access.kind) {
    case "local-network":
      return localNetwork[access.origin];
    case "external-app":
      return externalApps[access.origin]?.[access.scheme];
    case "file-system":
      return undefined;
    default: {
      const _exhaustive: never = access;
      throw new Error(`Unknown site access: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/**
 * `access`'s state for the page of guest `guestId` (null for requests of no page, such as a
 * worker's): its saved decision, or the panel's Allow this time, or still to ask.
 */
export function siteAccessState(guestId: number | null, access: SiteAccess): SiteDecision | "ask" {
  const saved = savedDecision(access);
  if (saved) return saved;
  const once = guestId === null ? undefined : localNetworkOnce.get(guestId);
  return access.kind === "local-network" && once === access.origin ? "allow" : "ask";
}

/** Resolves once a window has sent the settings' decisions; requests wait for them. */
export function siteAccessLoaded(): Promise<void> {
  return sites.loaded;
}

/** The window showing the guest's panel, when it asks about site access. */
function listeningHost(guest: WebContents): WebContents | null {
  const host = guest.hostWebContents;
  if (!host || host.isDestroyed() || !listeningHosts.has(host.id)) return null;
  return host;
}

/**
 * Whether the answer to an open prompt for `asked` also answers `wanted`. Writing a file covers
 * reading it: a folder picker requests both at once.
 */
function answersAccess(asked: SiteAccess, wanted: SiteAccess): boolean {
  if (asked.origin !== wanted.origin) return false;
  switch (asked.kind) {
    case "local-network":
      return wanted.kind === "local-network";
    case "external-app":
      return wanted.kind === "external-app" && asked.scheme === wanted.scheme;
    case "file-system":
      return (
        wanted.kind === "file-system" &&
        asked.path === wanted.path &&
        asked.directory === wanted.directory &&
        (asked.write || !wanted.write)
      );
    default: {
      const _exhaustive: never = asked;
      throw new Error(`Unknown site access: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/** Whether `guest`'s panel can ask about local network access for `origin` now. */
export function canAskLocalNetwork(guest: WebContents): boolean {
  return listeningHost(guest) !== null && !dismissedLocalNetwork.has(guest.id);
}

/** The webview with an open local network prompt for `origin`, if one has. */
export function askingLocalNetwork(origin: string): number | null {
  for (const [, pending] of prompts.entries()) {
    if (pending.access.kind === "local-network" && pending.origin === origin) {
      return pending.guestId;
    }
  }
  return null;
}

/**
 * Ask the user in the panel of webview `guest` whether its page may have `access`, unless it has
 * a decision already; resolves with whether it may. Refused without asking when the panel can't
 * ask (no window shows prompts, or the page closed its local network prompt).
 */
export function askSiteAccess(guest: WebContents, access: SiteAccess): Promise<boolean> {
  const state = siteAccessState(guest.id, access);
  if (state !== "ask") return Promise.resolve(state === "allow");
  const host = listeningHost(guest);
  if (!host || (access.kind === "local-network" && dismissedLocalNetwork.has(guest.id))) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    // Asking again while the prompt is up (each held request, or another click on the link)
    // waits for the same answer.
    for (const [id, pending] of prompts.entries()) {
      if (pending.guestId !== guest.id) continue;
      if (answersAccess(pending.access, access)) {
        pending.waiters.push(resolve);
        return;
      }
      // `requestPermission({ mode: "readwrite" })` asks to read, then to write, at once: one
      // prompt asks to write, and its answer covers both.
      if (answersAccess(access, pending.access)) {
        prompts.reprompt(id, { ...pending, access, waiters: [...pending.waiters, resolve] });
        return;
      }
    }
    prompts.show({ guestId: guest.id, host, origin: access.origin, access, waiters: [resolve] });
  });
}

/** Take down a prompt, answering what waits on it with `allowed`. */
function withdraw(id: number, allowed: boolean): void {
  for (const resolve of prompts.withdraw(id)?.waiters ?? []) resolve(allowed);
}

/** Answer and take down the prompts whose access now has a decision. */
function settleDecidedRequests(): void {
  for (const [id, pending] of prompts.entries()) {
    const state = siteAccessState(pending.guestId, pending.access);
    if (state !== "ask") withdraw(id, state === "allow");
  }
}

/** `current` with the user's `decision` for `access`. */
function withDecision(
  current: SiteAccessSites,
  access: Exclude<SiteAccess, { kind: "file-system" }>,
  decision: SiteDecision,
): SiteAccessSites {
  if (access.kind === "external-app") {
    const externalApps = withExternalAppDecision(
      current.externalApps,
      access.origin,
      access.scheme,
      decision,
    );
    return { ...current, externalApps };
  }
  return { ...current, localNetwork: { ...current.localNetwork, [access.origin]: decision } };
}

function respondToRequest(event: IpcMainEvent, value: unknown): void {
  const parsed = sitePermissionResponseSchema.safeParse(value);
  if (!parsed.success) return;
  const { id, answer } = parsed.data;
  const pending = prompts.answered(event, id);
  if (!pending) return;
  const { access, guestId } = pending;
  // File access answers only this request; Chromium keeps the grant while the page is on the site.
  if (access.kind === "file-system") {
    withdraw(id, answer === "allow" || answer === "allow-once");
    return;
  }
  if (answer === "dismiss") {
    if (access.kind === "local-network") dismissedLocalNetwork.add(guestId);
    withdraw(id, false);
    return;
  }
  if (answer === "allow-once") {
    // A link opens this once; the local network stays reachable while the panel is on the site.
    if (access.kind === "external-app") withdraw(id, true);
    else localNetworkOnce.set(guestId, access.origin);
  } else {
    // The renderer also saves the decision in settings, which sends it back here; applying it now
    // answers the page without waiting for that round trip.
    sites.apply(withDecision(sites.get(), access, answer));
  }
  settleDecidedRequests();
}

function setSites(_event: IpcMainEvent, value: unknown): void {
  sites.receive(parseSiteAccessSites(value));
  settleDecidedRequests();
}

export function installSiteAccess(): void {
  onAppWindowMessage(SITE_ACCESS_LISTEN, (event) => listeningHosts.add(event.sender));
  // Only Loxel's own windows hold the settings; a page must never decide for itself.
  onAppWindowMessage(SITE_ACCESS_SET_SITES, setSites);
  onAppWindowMessage(SITE_ACCESS_RESPOND, respondToRequest);
}

/** Withdraw the guest's open prompts, refusing what waits on them: its page is going away. */
function withdrawRequests(guestId: number): void {
  for (const [id, pending] of prompts.entries()) {
    if (pending.guestId === guestId) withdraw(id, false);
  }
}

/** Track a webview's page lifecycle for its site access (from `web-contents-created`). */
export function trackWebviewSiteAccess(contents: WebContents): void {
  if (contents.getType() !== "webview") return;
  const guestId = contents.id;
  // The page being left gets no answer to its prompts, as with dialogs.
  contents.on("did-start-navigation", ({ isMainFrame, isSameDocument }) => {
    if (isMainFrame && !isSameDocument) withdrawRequests(guestId);
  });
  // "Allow this time" stays with the site: reloads and its other pages keep it, leaving drops it.
  // A new document may ask again after its page closed the prompt.
  contents.on("did-navigate", () => {
    const origin = contents.mainFrame.origin;
    if (localNetworkOnce.get(guestId) !== origin) localNetworkOnce.delete(guestId);
    dismissedLocalNetwork.delete(guestId);
    for (const [id, pending] of prompts.entries()) {
      if (pending.guestId === guestId && pending.origin !== origin) withdraw(id, false);
    }
  });
  contents.on("render-process-gone", () => withdrawRequests(guestId));
  contents.once("destroyed", () => {
    withdrawRequests(guestId);
    localNetworkOnce.delete(guestId);
    dismissedLocalNetwork.delete(guestId);
  });
}
