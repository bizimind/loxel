/**
 * The window's favicon loads. Web favicons are loaded by the main process through the browser
 * panels' session (see `electron/browser-favicons.ts`): Loxel's window has none of a site's
 * cookies, and some sites refuse to be loaded from another site. Cookies go only with a favicon of
 * the page's own origin, and a favicon on this machine or the local network loads only as far as
 * the page itself may reach it, so a load is keyed by its URL, whether it carries cookies, the
 * page's origin, and whether the page is an incognito tab's, whose favicons load through the
 * incognito session.
 *
 * Loads are shared by everything showing the same favicon, at most `MAX_RUNNING` run at once, and
 * queued ones nothing wants any more by their turn (a page cycling through favicons) are dropped.
 * Successful loads are kept, least recently used first, so a tab rebuilt by a worktree switch shows
 * its favicon at once; a failure isn't kept, so the next try loads it again.
 */
import { onLastIncognitoTabClosed } from "@/store/browser-pages";
import { isHttpUrl, isSameOrigin, isStorableFavicon } from "@/url-utils";

/** Whether favicon `url` is loaded through main: a web favicon, in the desktop app. */
export function loadsThroughMain(url: string): boolean {
  return window.electronAPI !== undefined && isHttpUrl(url);
}

/**
 * Counts this window's incognito sessions: favicons an ended one loaded (with its cookies, for its
 * sites) are dropped and never shown to the next.
 */
let incognitoGeneration = 0;
const sessionKey = (incognito: boolean) =>
  incognito ? `incognito:${incognitoGeneration}` : "browser";

const loadKey = (url: string, pageUrl: string | undefined, incognito: boolean) => {
  const cookies = pageUrl !== undefined && isSameOrigin(url, pageUrl) ? "cookies" : "none";
  const page = pageUrl !== undefined && URL.canParse(pageUrl) ? new URL(pageUrl).origin : "";
  return `${sessionKey(incognito)} ${cookies} ${page} ${url}`;
};

/** Whether a load of `key` belongs to an incognito session that has ended since. */
const isStale = (key: string) =>
  key.startsWith("incognito:") && !key.startsWith(`${sessionKey(true)} `);

/** Loaded favicons as `data:` URLs by load key, least recently used first. */
const loaded = new Map<string, string>();
/** How much `loaded` keeps, in characters: the favicons of the open tabs, bookmarks and the bell. */
const MAX_LOADED_LENGTH = 4 * 1024 * 1024;
let loadedLength = 0;

// The window's last incognito tab closed: its session's favicons go.
onLastIncognitoTabClosed(() => {
  incognitoGeneration++;
  for (const [key, src] of loaded) {
    if (!isStale(key)) continue;
    loaded.delete(key);
    loadedLength -= src.length;
  }
});

function keepLoaded(key: string, src: string): void {
  loaded.set(key, src);
  loadedLength += src.length;
  for (const [oldKey, oldSrc] of loaded) {
    if (loadedLength <= MAX_LOADED_LENGTH || oldKey === key) break;
    loaded.delete(oldKey);
    loadedLength -= oldSrc.length;
  }
}

/** The loaded favicon at web URL `url` for page `pageUrl`, if it is loaded already. */
export function loadedFavicon(
  url: string,
  pageUrl: string | undefined,
  incognito = false,
): string | undefined {
  return loaded.get(loadKey(url, pageUrl, incognito));
}

interface Load {
  readonly promise: Promise<string | null>;
  readonly start: () => void;
  /** How many callers still want it. */
  wanted: number;
}
const loads = new Map<string, Load>();
const MAX_RUNNING = 6;
let running = 0;
const queue: string[] = [];

function runQueued(): void {
  while (running < MAX_RUNNING) {
    const key = queue.shift();
    if (key === undefined) return;
    const load = loads.get(key);
    if (!load) continue;
    if (load.wanted === 0) {
      loads.delete(key);
      continue;
    }
    running++;
    load.start();
  }
}

/** A requested favicon load: its result, and `release` once the caller no longer wants it. */
export interface FaviconRequest {
  readonly promise: Promise<string | null>;
  readonly release: () => void;
}

/**
 * Load the web favicon `url` for page `pageUrl` (an incognito tab's when `incognito`) through
 * main, as a `data:` URL, or null if it fails. Must only be called when `loadsThroughMain(url)`.
 */
export function requestFavicon(
  url: string,
  pageUrl: string | undefined,
  incognito = false,
): FaviconRequest {
  const key = loadKey(url, pageUrl, incognito);
  const src = loaded.get(key);
  if (src) {
    // Most recently used, so it is the last to go.
    loaded.delete(key);
    loaded.set(key, src);
    return { promise: Promise.resolve(src), release: () => {} };
  }
  let load = loads.get(key);
  if (load) {
    load.wanted++;
  } else {
    const { promise, resolve } = Promise.withResolvers<string | null>();
    const start = () => {
      const api = window.electronAPI;
      void (api ? api.loadFavicon(url, pageUrl, undefined, incognito) : Promise.resolve(null))
        .catch(() => null)
        .then((result) => {
          running--;
          loads.delete(key);
          if (result && !isStale(key)) keepLoaded(key, result);
          resolve(result);
          runQueued();
        });
    };
    load = { promise, start, wanted: 1 };
    loads.set(key, load);
    queue.push(key);
    runQueued();
  }
  const current = load;
  let released = false;
  return {
    promise: current.promise,
    release: () => {
      if (released) return;
      released = true;
      current.wanted--;
    },
  };
}

/** How many of a page's favicon candidates are tried. */
const MAX_CANDIDATES = 4;

/**
 * The favicons a page offers (`page-favicon-updated`, Chromium's preferred first, with the site's
 * `/favicon.ico` when the page declares none), without repeats or what can't be shown.
 */
export function faviconCandidates(favicons: readonly string[]): string[] {
  const shown = favicons.filter(
    (url) => isHttpUrl(url) || url.startsWith("data:image/") || url.startsWith("blob:"),
  );
  return [...new Set(shown)].slice(0, MAX_CANDIDATES);
}

/**
 * The first of `candidates` (from `faviconCandidates`) of page `pageUrl` that loads: a web URL once
 * main has loaded it (so showing it is instant), an inline image as it is, or a `blob:` favicon as
 * `readBlob` reads it in its page, if a bookmark could keep that (`isStorableFavicon`). Undefined
 * if none loads. Stops early once `isCurrent` says a newer favicon took over. `incognito` for an
 * incognito tab's page.
 */
export async function pickFavicon(
  candidates: readonly string[],
  pageUrl: string,
  readBlob: (url: string) => Promise<string | null>,
  isCurrent: () => boolean,
  incognito = false,
): Promise<string | undefined> {
  for (const url of candidates) {
    if (!isCurrent()) return undefined;
    if (url.startsWith("data:")) return url;
    if (url.startsWith("blob:")) {
      const src = await readBlob(url).catch(() => null);
      if (src && isStorableFavicon(src)) return src;
      continue;
    }
    if (!loadsThroughMain(url)) return url;
    const request = requestFavicon(url, pageUrl, incognito);
    const src = await request.promise;
    request.release();
    if (src) return url;
  }
  return undefined;
}
