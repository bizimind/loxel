/**
 * Local Network Access for browser panels, as in Chrome: a page may only reach a more private
 * address space than its own (`address-space.ts`) with its site's permission. Public sites ask
 * before they reach this machine or devices on the local network, and local network pages before
 * they reach this machine. Pages on this machine (dev servers on `localhost`) reach anything, so
 * a dev server's page calls its API on another port without asking.
 *
 * Electron turns Chromium's own checks off, so main gates the browser session's requests itself,
 * in `webRequest`, which sees every frame's subresources, fetches, websockets, subframes and
 * workers' requests, including frames the webview preload never runs in (`about:blank`). Top-level
 * navigations aren't gated, as in Chrome. The site deciding is the top-level page's, so embedded
 * frames follow its decision; a worker's requests have no page and are decided by the worker's
 * origin.
 *
 * Address spaces:
 * - A request's target is classified by its URL's host when that names its space (an IP address,
 *   `localhost`, a `.local` name), and otherwise by the addresses the name resolves to
 *   (`session.resolveHost`), so a public name that resolves to a private address counts as
 *   private. The resolution is Loxel's own, not the connection's; when a response then comes from
 *   a more private address than the request was let through for, and not through a proxy, it is
 *   refused.
 * - A page's own space is that of the address its document was loaded from, kept for the
 *   document's life, so a name that changes its answer later can't make the page more private.
 *
 * A site without a decision gets the panel's bar (`browser-site-access.ts`) while its requests
 * wait: Allow lets them through, and Block or closing the bar fails them. They fail too when the
 * page navigates away.
 */
import { type Session, type WebContents, webContents as allWebContents } from "electron";

import {
  type AddressSpace,
  ipAddressSpace,
  isMorePrivate,
  literalHostSpace,
  mostPrivate,
} from "./address-space";
import {
  askSiteAccess,
  askingLocalNetwork,
  canAskLocalNetwork,
  siteAccessLoaded,
  siteAccessState,
} from "./browser-site-access";
import type { SiteAccess } from "./site-permission-protocol";

/** URL schemes that reach the network. */
const NETWORK_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"]);

/** How long a name's resolved space is kept: Chromium's own cache time for the OS resolver. */
const RESOLVED_TTL_MS = 60_000;
const MAX_RESOLVED = 1000;
/** Requests let through whose responses are still to be checked; past this, the oldest go. */
const MAX_CHECKED = 5000;

/** Who makes a request: the page (or worker) it is attributed to. */
interface Caller {
  /** The webview or popup whose frame made it, or null for a worker's or main's own. */
  contents: WebContents | null;
  /** The site deciding, or null when no site can be asked (the request is refused). */
  site: string | null;
  /** The origin of the document or worker that made it. */
  initiator: string | null;
  /** Whether the user may be asked; main's own fetches for a page never ask. */
  mayAsk: boolean;
}

/** A request let through without asking, kept to check where its response came from. */
interface Checked {
  callerSpace: AddressSpace;
  site: string | null;
  contentsId: number | null;
}

/** Per webview or popup, the space of each origin's documents it loaded since its last page. */
const documentSpaces = new Map<number, Map<string, AddressSpace>>();
const resolved = new Map<string, { space: AddressSpace; until: number }>();
const resolving = new Map<string, Promise<AddressSpace>>();
const checked = new Map<number, Checked>();

/** Main's own fetches through the browser session for a page, by URL, until each starts. */
const pendingMainFetches = new Map<string, { pageUrl: string | undefined }[]>();
const mainFetches = new Map<number, { pageUrl: string | undefined }>();

function originOf(url: string | undefined): string | null {
  if (!url || !URL.canParse(url)) return null;
  const { origin } = new URL(url);
  return origin === "null" ? null : origin;
}

/**
 * Let main fetch `url` through the browser session for the page at `pageUrl` (its favicon), as
 * that page: the same rules apply, but the user is never asked. Call the returned function once
 * the fetch is done. Without a page, the fetch counts as a public site's.
 */
export function fetchForPage(url: string, pageUrl: string | undefined): () => void {
  const key = URL.canParse(url) ? new URL(url).href : url;
  const fetch = { pageUrl };
  pendingMainFetches.set(key, [...(pendingMainFetches.get(key) ?? []), fetch]);
  return () => {
    const left = (pendingMainFetches.get(key) ?? []).filter((f) => f !== fetch);
    if (left.length > 0) pendingMainFetches.set(key, left);
    else pendingMainFetches.delete(key);
    for (const [id, f] of mainFetches) if (f === fetch) mainFetches.delete(id);
  };
}

interface RequestDetails {
  id: number;
  url: string;
  resourceType: string;
  webContents?: WebContents;
  initiatorOrigin?: string;
}

function callerOf(details: RequestDetails): Caller | null {
  const contents =
    details.webContents && !details.webContents.isDestroyed() ? details.webContents : null;
  if (contents) {
    const site = originOf(contents.mainFrame.origin);
    return { contents, site, initiator: originOf(details.initiatorOrigin) ?? site, mayAsk: true };
  }
  const initiator = originOf(details.initiatorOrigin);
  if (initiator) return { contents: null, site: initiator, initiator, mayAsk: true };
  // A request of no page and no initiator is main's own: a fetch it made for a page (redirects
  // keep their request's id), or one of no page's, which only Loxel's code chooses.
  let fetch = mainFetches.get(details.id);
  if (!fetch) {
    fetch = pendingMainFetches.get(details.url)?.shift();
    if (!fetch) return null;
    mainFetches.set(details.id, fetch);
  }
  const page = originOf(fetch.pageUrl);
  return { contents: null, site: page, initiator: page, mayAsk: false };
}

/** The most private space `host`'s addresses fall in; public when it doesn't resolve. */
function resolvedSpace(browserSession: Session, host: string): Promise<AddressSpace> {
  const cached = resolved.get(host);
  if (cached && cached.until > Date.now()) return Promise.resolve(cached.space);
  const inFlight = resolving.get(host);
  if (inFlight) return inFlight;
  const lookup = browserSession
    .resolveHost(host)
    .then(
      ({ endpoints }) =>
        endpoints.reduce<AddressSpace>(
          (space, { address }) => mostPrivate(space, ipAddressSpace(address) ?? "public"),
          "public",
        ),
      (): AddressSpace => "public",
    )
    .then((space) => {
      resolved.set(host, { space, until: Date.now() + RESOLVED_TTL_MS });
      if (resolved.size > MAX_RESOLVED) resolved.delete(resolved.keys().next().value ?? "");
      return space;
    })
    .finally(() => resolving.delete(host));
  resolving.set(host, lookup);
  return lookup;
}

/** The space of `hostname` as a URL names it: by itself, or by what it resolves to. */
function hostSpace(browserSession: Session, hostname: string): Promise<AddressSpace> {
  const literal = literalHostSpace(hostname);
  return literal ? Promise.resolve(literal) : resolvedSpace(browserSession, hostname);
}

/** The space of the document or worker making a request. */
async function callerSpace(browserSession: Session, caller: Caller): Promise<AddressSpace> {
  const spaces = caller.contents ? documentSpaces.get(caller.contents.id) : undefined;
  // An opaque origin (a sandboxed frame) counts as its page.
  const origin = caller.initiator ?? caller.site;
  const known = origin ? spaces?.get(origin) : undefined;
  if (known) return known;
  if (!origin) return "public";
  return hostSpace(browserSession, new URL(origin).hostname);
}

/** Whether `caller`'s site may reach a more private space: decided, or asked in a panel. */
async function allowedFor(caller: Caller): Promise<boolean> {
  const { site, contents } = caller;
  if (!site) return false;
  await siteAccessLoaded();
  const access: SiteAccess = { kind: "local-network", origin: site };
  const state = siteAccessState(contents?.id ?? null, access);
  if (state !== "ask" || !caller.mayAsk) return state === "allow";
  // A popup window has no panel to ask in.
  const panel = contents ? (contents.getType() === "webview" ? contents : null) : panelOf(site);
  if (!panel || panel.isDestroyed() || panel.mainFrame.origin !== site) return false;
  return askSiteAccess(panel, access);
}

/** The panel to ask in for a worker of `site`: the one asking already, or one showing the site. */
function panelOf(site: string): WebContents | null {
  const asking = askingLocalNetwork(site);
  if (asking !== null) return allWebContents.fromId(asking) ?? null;
  for (const contents of allWebContents.getAllWebContents()) {
    if (contents.getType() !== "webview" || contents.isDestroyed()) continue;
    if (contents.mainFrame.origin === site && canAskLocalNetwork(contents)) return contents;
  }
  return null;
}

/** Whether the request may go ahead (`onBeforeRequest`); it waits while the user is asked. */
async function admit(browserSession: Session, details: RequestDetails): Promise<boolean> {
  // Top-level navigations aren't gated, as in Chrome: the user goes there.
  if (details.resourceType === "mainFrame" || !URL.canParse(details.url)) return true;
  const url = new URL(details.url);
  if (!NETWORK_PROTOCOLS.has(url.protocol)) return true;
  const caller = callerOf(details);
  if (!caller) return true;
  const space = await callerSpace(browserSession, caller);
  if (space === "loopback") return true;
  if (isMorePrivate(await hostSpace(browserSession, url.hostname), space)) {
    return allowedFor(caller);
  }
  checked.set(details.id, {
    callerSpace: space,
    site: caller.site,
    contentsId: caller.contents?.id ?? null,
  });
  if (checked.size > MAX_CHECKED) checked.delete(checked.keys().next().value ?? 0);
  return true;
}

/** The space of the address a response came from, or null when it came through a proxy. */
async function responseSpace(
  browserSession: Session,
  url: string,
  ip: string,
): Promise<AddressSpace | null> {
  const space = ipAddressSpace(ip);
  if (!space || space === "public") return space;
  // Through a proxy, the address is the proxy's, not the server's.
  const proxy = await browserSession.resolveProxy(url).catch(() => "DIRECT");
  return proxy.trim().toUpperCase() === "DIRECT" ? space : null;
}

interface ResponseDetails extends RequestDetails {
  /** The address the response came from; Electron reports it, though its types leave it out. */
  ip?: unknown;
}

/** Remember the space of the document a frame response loads. */
async function noteDocument(browserSession: Session, details: ResponseDetails): Promise<void> {
  const contents = details.webContents;
  const origin = originOf(details.url);
  if (!contents || contents.isDestroyed() || !origin) return;
  const literal = literalHostSpace(new URL(origin).hostname);
  const fromIp =
    typeof details.ip === "string"
      ? await responseSpace(browserSession, details.url, details.ip)
      : null;
  const space = literal ?? fromIp ?? (await hostSpace(browserSession, new URL(origin).hostname));
  let spaces = documentSpaces.get(contents.id);
  if (!spaces) {
    spaces = new Map();
    documentSpaces.set(contents.id, spaces);
    const id = contents.id;
    contents.once("destroyed", () => documentSpaces.delete(id));
  }
  // A new page starts over; a frame keeps the space its origin's first document had.
  if (details.resourceType === "mainFrame") spaces.clear();
  if (!spaces.has(origin)) spaces.set(origin, space);
}

/**
 * Whether a response may be read (`onHeadersReceived`): one that came from a more private address
 * than its request was let through for is refused, unless the site may reach it.
 */
async function acceptResponse(browserSession: Session, details: ResponseDetails): Promise<boolean> {
  if (details.resourceType === "mainFrame" || details.resourceType === "subFrame") {
    await noteDocument(browserSession, details);
  }
  const request = checked.get(details.id);
  checked.delete(details.id);
  if (!request || typeof details.ip !== "string") return true;
  const space = ipAddressSpace(details.ip);
  if (!space || !isMorePrivate(space, request.callerSpace)) return true;
  if (request.site) {
    await siteAccessLoaded();
    const access: SiteAccess = { kind: "local-network", origin: request.site };
    if (siteAccessState(request.contentsId, access) === "allow") return true;
  }
  return (await responseSpace(browserSession, details.url, details.ip)) === null;
}

/** Gate `browserSession`'s requests (the browser panels' session). */
export function installLocalNetworkAccess(browserSession: Session): void {
  browserSession.webRequest.onBeforeRequest((details, callback) => {
    admit(browserSession, details).then(
      (allowed) => callback(allowed ? {} : { cancel: true }),
      (error: unknown) => {
        console.error("[browser-local-network] Refused a request after an error", error);
        callback({ cancel: true });
      },
    );
  });
  browserSession.webRequest.onHeadersReceived((details, callback) => {
    acceptResponse(browserSession, details).then(
      (accepted) => callback(accepted ? {} : { cancel: true }),
      (error: unknown) => {
        console.error("[browser-local-network] Refused a response after an error", error);
        callback({ cancel: true });
      },
    );
  });
}
