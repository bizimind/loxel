/**
 * The window's favicon loads. Web favicons are loaded by the main process through the browser
 * panels' session (see `electron/browser-favicons.ts`): Loxel's window has none of a site's
 * cookies, and some sites refuse to be loaded from another site. Cookies go only with a favicon of
 * the page's own origin, so a load is keyed by its URL and whether it carries them.
 *
 * Loads are shared by everything showing the same favicon, at most `MAX_RUNNING` run at once, and
 * queued ones nothing wants any more by their turn (a page cycling through favicons) are dropped.
 * Successful loads are kept, least recently used first, so a tab rebuilt by a worktree switch shows
 * its favicon at once; a failure isn't kept, so the next try loads it again.
 */
import { isHttpUrl, isSameOrigin, isStorableFavicon } from "@/url-utils";

/** Whether favicon `url` is loaded through main: a web favicon, in the desktop app. */
export function loadsThroughMain(url: string): boolean {
  return window.electronAPI !== undefined && isHttpUrl(url);
}

/** The page URL a load of `url` for page `pageUrl` passes to main: set only to send cookies. */
const cookiePage = (url: string, pageUrl: string | undefined) =>
  pageUrl !== undefined && isSameOrigin(url, pageUrl) ? pageUrl : undefined;

const loadKey = (url: string, pageUrl: string | undefined) =>
  `${cookiePage(url, pageUrl) === undefined ? "none" : "cookies"} ${url}`;

/** Loaded favicons as `data:` URLs by load key, least recently used first. */
const loaded = new Map<string, string>();
/** How much `loaded` keeps, in characters: the favicons of the open tabs, bookmarks and the bell. */
const MAX_LOADED_LENGTH = 4 * 1024 * 1024;
let loadedLength = 0;

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
export function loadedFavicon(url: string, pageUrl: string | undefined): string | undefined {
  return loaded.get(loadKey(url, pageUrl));
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
 * Load the web favicon `url` for page `pageUrl` through main, as a `data:` URL, or null if it
 * fails. Must only be called when `loadsThroughMain(url)`.
 */
export function requestFavicon(url: string, pageUrl: string | undefined): FaviconRequest {
  const key = loadKey(url, pageUrl);
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
      void (api ? api.loadFavicon(url, cookiePage(url, pageUrl)) : Promise.resolve(null))
        .catch(() => null)
        .then((result) => {
          running--;
          loads.delete(key);
          if (result) keepLoaded(key, result);
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
 * if none loads. Stops early once `isCurrent` says a newer favicon took over.
 */
export async function pickFavicon(
  candidates: readonly string[],
  pageUrl: string,
  readBlob: (url: string) => Promise<string | null>,
  isCurrent: () => boolean,
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
    const request = requestFavicon(url, pageUrl);
    const src = await request.promise;
    request.release();
    if (src) return url;
  }
  return undefined;
}
