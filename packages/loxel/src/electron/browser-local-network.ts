/**
 * Local Network Access for browser panels, as in Chrome: a public page may only reach this machine
 * or the local network (`address-space.ts`) with its site's permission. Pages on this machine or
 * the local network reach anything, so a dev server's page, on `localhost` or its LAN address,
 * calls its API on another port without asking.
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
 *   `localhost`, a `.local` name), and otherwise by the most private address the name resolves to
 *   (`session.resolveHost`), so a public name that resolves to a private address counts as
 *   private. When a response then comes from a more private address than the request was let
 *   through for, and not through a proxy, it is refused.
 * - A page's own space is that of the address its document was loaded from, kept for the
 *   document's life, so a name that changes its answer later can't make the page more private.
 *   A caller with no such document (a service worker, a page a service worker served) counts by
 *   its host the other way round: by the least private address it resolves to.
 *
 * A site without a decision gets the panel's bar (`browser-site-access.ts`) while its requests
 * wait: Allow lets them through, and Block or closing the bar fails them. They fail too when the
 * page navigates away.
 */
import {
  type OnBeforeRequestListenerDetails,
  type OnHeadersReceivedListenerDetails,
  type Session,
  type WebContents,
  webContents as allWebContents,
} from "electron";

import { normalizeOrigin } from "../url-utils";
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

/** How long whether an origin's requests go through a proxy is kept. */
const PROXY_TTL_MS = 60_000;
const MAX_PROXIES = 1000;

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

/** The most and least private spaces of a name's addresses. */
interface ResolvedSpaces {
  most: AddressSpace;
  least: AddressSpace;
}

type RequestDetails = Pick<
  OnBeforeRequestListenerDetails,
  "id" | "url" | "resourceType" | "webContents" | "initiatorOrigin"
>;

interface ResponseDetails extends Pick<
  OnHeadersReceivedListenerDetails,
  "id" | "url" | "resourceType" | "webContents"
> {
  /** The address the response came from; Electron reports it, though its types leave it out. */
  ip?: unknown;
}

/** Per webview or popup, the space of each origin's documents it shows on its current page. */
const documentSpaces = new Map<number, Map<string, AddressSpace>>();
/** Per webview or popup, the main-frame document it is loading, until that commits. */
const loadingPages = new Map<number, { origin: string; space: AddressSpace }>();
const resolving = new Map<string, Promise<ResolvedSpaces>>();
const proxies = new Map<string, { proxied: Promise<boolean>; until: number }>();
/** Requests let through without asking, until their response arrives or they end. */
const checked = new Map<number, Checked>();

/** Main's own fetches through the browser session for a page, by URL, until each starts. */
const pendingMainFetches = new Map<string, { pageUrl: string | undefined }[]>();
const mainFetches = new Map<number, { pageUrl: string | undefined }>();

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

function callerOf(details: RequestDetails): Caller {
  const contents =
    details.webContents && !details.webContents.isDestroyed() ? details.webContents : null;
  if (contents) {
    const site = normalizeOrigin(contents.mainFrame.origin);
    const initiator = normalizeOrigin(details.initiatorOrigin) ?? site;
    return { contents, site, initiator, mayAsk: true };
  }
  const initiator = normalizeOrigin(details.initiatorOrigin);
  if (initiator) return { contents: null, site: initiator, initiator, mayAsk: true };
  // A request of no page and no initiator is main's own: a fetch it made for a page (redirects
  // keep their request's id). Any other counts as a public site's that can't be asked.
  let fetch = mainFetches.get(details.id);
  if (!fetch) {
    fetch = pendingMainFetches.get(details.url)?.shift();
    if (fetch) mainFetches.set(details.id, fetch);
  }
  const page = normalizeOrigin(fetch?.pageUrl);
  return { contents: null, site: page, initiator: page, mayAsk: false };
}

/** The more public of two spaces. */
const leastPrivate = (a: AddressSpace, b: AddressSpace) => (mostPrivate(a, b) === a ? b : a);

/**
 * The spaces of `host`'s addresses; public when it doesn't resolve. Concurrent lookups share one;
 * each request looks up again, so the answer follows the session's own cache.
 */
function resolvedSpaces(browserSession: Session, host: string): Promise<ResolvedSpaces> {
  const inFlight = resolving.get(host);
  if (inFlight) return inFlight;
  const lookup = browserSession
    .resolveHost(host)
    .then(
      ({ endpoints }): ResolvedSpaces => {
        const spaces = endpoints.map(({ address }) => ipAddressSpace(address) ?? "public");
        if (spaces.length === 0) return { most: "public", least: "public" };
        return { most: spaces.reduce(mostPrivate), least: spaces.reduce(leastPrivate) };
      },
      (): ResolvedSpaces => ({ most: "public", least: "public" }),
    )
    .finally(() => resolving.delete(host));
  resolving.set(host, lookup);
  return lookup;
}

/** The space a request to `hostname` reaches: as it names itself, or its most private address. */
async function targetSpace(browserSession: Session, hostname: string): Promise<AddressSpace> {
  return literalHostSpace(hostname) ?? (await resolvedSpaces(browserSession, hostname)).most;
}

/**
 * The space of a caller of `origin` with no document Loxel saw load: as its host names itself,
 * or its least private address, so a name that also resolves to this machine can't make it local.
 */
async function originSpace(browserSession: Session, origin: string): Promise<AddressSpace> {
  const { hostname } = new URL(origin);
  return literalHostSpace(hostname) ?? (await resolvedSpaces(browserSession, hostname)).least;
}

/** The space of the document or worker making a request. */
function callerSpace(browserSession: Session, caller: Caller): Promise<AddressSpace> {
  const spaces = caller.contents ? documentSpaces.get(caller.contents.id) : undefined;
  // An opaque origin (a sandboxed frame) counts as its page.
  const origin = caller.initiator ?? caller.site;
  const known = origin ? spaces?.get(origin) : undefined;
  if (known) return Promise.resolve(known);
  return origin ? originSpace(browserSession, origin) : Promise.resolve("public");
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
  const space = await callerSpace(browserSession, caller);
  // Pages on this machine or the local network reach anything.
  if (space !== "public") return true;
  if (isMorePrivate(await targetSpace(browserSession, url.hostname), space)) {
    return allowedFor(caller);
  }
  const contentsId = caller.contents?.id ?? null;
  checked.set(details.id, { callerSpace: space, site: caller.site, contentsId });
  return true;
}

/** Whether requests to `url`'s origin go through a proxy, whose address is not the server's. */
function isProxied(browserSession: Session, url: string): Promise<boolean> {
  const { origin } = new URL(url);
  const cached = proxies.get(origin);
  if (cached && cached.until > Date.now()) return cached.proxied;
  const proxied = browserSession.resolveProxy(url).then(
    (proxy) => proxy.trim().toUpperCase() !== "DIRECT",
    () => false,
  );
  proxies.delete(origin);
  proxies.set(origin, { proxied, until: Date.now() + PROXY_TTL_MS });
  if (proxies.size > MAX_PROXIES) proxies.delete(proxies.keys().next().value ?? "");
  return proxied;
}

/** The space of the address a response came from, or null when it came through a proxy. */
async function responseSpace(
  browserSession: Session,
  url: string,
  ip: string,
): Promise<AddressSpace | null> {
  const space = ipAddressSpace(ip);
  if (!space || space === "public") return space;
  return (await isProxied(browserSession, url)) ? null : space;
}

/**
 * The spaces of the documents `contents` shows. A main frame's response starts its new page's once
 * it commits: a response that doesn't commit (a download, a 204) leaves the page as it was.
 */
function documentSpacesOf(contents: WebContents): Map<string, AddressSpace> {
  const id = contents.id;
  const known = documentSpaces.get(id);
  if (known) return known;
  const spaces = new Map<string, AddressSpace>();
  documentSpaces.set(id, spaces);
  contents.on("did-navigate", () => {
    const loading = loadingPages.get(id);
    loadingPages.delete(id);
    const page = new Map<string, AddressSpace>();
    if (loading && loading.origin === normalizeOrigin(contents.mainFrame.origin)) {
      page.set(loading.origin, loading.space);
    }
    documentSpaces.set(id, page);
  });
  contents.once("destroyed", () => {
    documentSpaces.delete(id);
    loadingPages.delete(id);
  });
  return spaces;
}

/** Remember the space of the document a frame response loads. */
async function noteDocument(browserSession: Session, details: ResponseDetails): Promise<void> {
  const contents = details.webContents;
  const origin = normalizeOrigin(details.url);
  if (!contents || contents.isDestroyed() || !origin) return;
  const { hostname } = new URL(origin);
  const literal = literalHostSpace(hostname);
  // An IP address or `localhost` is its space; a `.local` name's document counts by the address
  // it came from, which may be this machine.
  const named = literal && !hostname.endsWith(".local") ? literal : null;
  const fromIp =
    named === null && typeof details.ip === "string"
      ? await responseSpace(browserSession, details.url, details.ip)
      : null;
  const space = named ?? fromIp ?? literal ?? (await originSpace(browserSession, origin));
  const spaces = documentSpacesOf(contents);
  if (details.resourceType === "mainFrame") {
    loadingPages.set(contents.id, { origin, space });
    return;
  }
  // A frame keeps the space its origin's first document on the page had.
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
  // A request that ends leaves nothing to check.
  const forget = ({ id }: { id: number }) => {
    checked.delete(id);
    mainFetches.delete(id);
  };
  browserSession.webRequest.onCompleted(forget);
  browserSession.webRequest.onErrorOccurred(forget);
}
