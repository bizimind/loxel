/**
 * Favicons of browser panel pages, loaded the way the page itself would load them, for Loxel's
 * windows to show as inline (`data:`) images.
 *
 * Loxel's window can't load every favicon a page reports: it has none of the page's cookies (a
 * favicon behind a sign-in redirects to it), a site may refuse cross-site loads of it
 * (`Cross-Origin-Resource-Policy`), and a `blob:` URL only resolves in the page that made it. So
 * main loads web favicons through the browser panels' session, and reads a `blob:` favicon in an
 * isolated world of the page's own frame, which the page's scripts can't reach. Either way the
 * bytes must be an image, and small.
 *
 * A page picks its favicon's URL, so cookies go only where the page's own request would take them
 * as a same-origin one: to a favicon of the page's own origin, and never along a redirect. Any other
 * favicon loads without cookies, so a page can't make Loxel send another site a request carrying
 * that site's cookies.
 */
import {
  BrowserWindow,
  ipcMain,
  type IpcMainInvokeEvent,
  type Session,
  type WebContents,
} from "electron";

import { isHttpUrl, isSameOrigin } from "../url-utils";
import { isAppWindow } from "./app-windows";
import { hostedWebview } from "./hosted-webview";
import { BROWSER_FAVICON_LOAD } from "./ipc-channels";

/** Largest favicon loaded; a page picks its favicon's URL, and every window may cache it. */
export const MAX_FAVICON_BYTES = 256 * 1024;
const LOAD_TIMEOUT_MS = 10_000;
/** The isolated world `blob:` favicons are read in: Loxel's own, apart from the preload's. */
const FAVICON_WORLD_ID = 1009;

/** Leading bytes of the bitmap formats browsers take for favicons whatever their content type. */
const SIGNATURES: { type: string; bytes: (number | null)[] }[] = [
  { type: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47] },
  { type: "image/x-icon", bytes: [0x00, 0x00, 0x01, 0x00] },
  { type: "image/gif", bytes: [0x47, 0x49, 0x46, 0x38] },
  { type: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  // "RIFF", the size, "WEBP".
  {
    type: "image/webp",
    bytes: [0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50],
  },
];

/**
 * `bytes` as a `data:` URL, typed by `contentType` when that is an image type, else by the bitmap
 * format they start with (servers often send `.ico` files untyped). Null when they are no image,
 * such as a sign-in page served in its place, or too large.
 */
export function imageDataUrl(contentType: string | null, bytes: Uint8Array): string | null {
  if (bytes.length === 0 || bytes.length > MAX_FAVICON_BYTES) return null;
  const declared = contentType?.split(";")[0]?.trim().toLowerCase();
  const type = declared?.startsWith("image/")
    ? declared
    : SIGNATURES.find((signature) =>
        signature.bytes.every((byte, i) => byte === null || bytes[i] === byte),
      )?.type;
  if (!type) return null;
  return `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
}

/** The body of `response`, or null once it grows past `MAX_FAVICON_BYTES`. */
async function readCapped(response: Response): Promise<Uint8Array | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > MAX_FAVICON_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Fetch `url` without a referrer, with the session's cookies or none. */
function fetchFavicon(browserSession: Session, url: string, withCookies: boolean) {
  return browserSession.fetch(url, {
    credentials: withCookies ? "include" : "omit",
    // With cookies, a redirect fails rather than take them elsewhere.
    redirect: withCookies ? "error" : "follow",
    signal: AbortSignal.timeout(LOAD_TIMEOUT_MS),
  });
}

async function loadWebFavicon(
  browserSession: Session,
  url: string,
  pageUrl: string | undefined,
): Promise<string | null> {
  const withCookies = pageUrl !== undefined && isSameOrigin(url, pageUrl);
  const response = withCookies
    ? // A favicon that redirects (to a CDN, say) loads again without cookies.
      await fetchFavicon(browserSession, url, true).catch(() =>
        fetchFavicon(browserSession, url, false),
      )
    : await fetchFavicon(browserSession, url, false);
  if (!response.ok) return null;
  const bytes = await readCapped(response);
  return bytes && imageDataUrl(response.headers.get("content-type"), bytes);
}

/** A `data:` URL as its type and bytes, or null if it isn't base64-encoded. */
function parseDataUrl(url: string): { type: string; bytes: Uint8Array } | null {
  const match = /^data:([^;,]*)(?:;[^,]*)?;base64,(.*)$/s.exec(url);
  if (!match) return null;
  return { type: match[1] ?? "", bytes: Buffer.from(match[2] ?? "", "base64") };
}

/** Read the `blob:` favicon `url` in `guest`'s main frame, which made it. */
async function loadBlobFavicon(guest: WebContents, url: string): Promise<string | null> {
  // The blob's origin is the page's: a page can only report its own.
  if (!isSameOrigin(url, guest.getURL())) return null;
  const code = `fetch(${JSON.stringify(url)})
    .then((response) => response.blob())
    .then((blob) => blob.size > ${MAX_FAVICON_BYTES} ? null : new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    }))`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result: unknown = await Promise.race([
    guest.executeJavaScriptInIsolatedWorld(FAVICON_WORLD_ID, [{ code }]),
    new Promise((resolve) => {
      timer = setTimeout(resolve, LOAD_TIMEOUT_MS, null);
    }),
  ]).finally(() => clearTimeout(timer));
  if (typeof result !== "string") return null;
  const parsed = parseDataUrl(result);
  return parsed && imageDataUrl(parsed.type, parsed.bytes);
}

/** Whether `sender` is one of Loxel's windows: not a page, nor a browser panel's popup. */
function isAppWindowContents(sender: WebContents): boolean {
  const win = BrowserWindow.fromWebContents(sender);
  return win !== null && win.webContents === sender && isAppWindow(win);
}

async function loadFavicon(
  browserSession: Session,
  event: IpcMainInvokeEvent,
  url: unknown,
  pageUrl: unknown,
  webContentsId: unknown,
): Promise<string | null> {
  if (typeof url !== "string" || !isAppWindowContents(event.sender)) return null;
  if (isHttpUrl(url)) {
    return loadWebFavicon(browserSession, url, typeof pageUrl === "string" ? pageUrl : undefined);
  }
  if (!url.startsWith("blob:")) return null;
  const guest = hostedWebview(event.sender, webContentsId);
  return guest ? loadBlobFavicon(guest, url) : null;
}

/** Answer `BROWSER_FAVICON_LOAD` from Loxel's windows. */
export function installBrowserFavicons(browserSession: Session): void {
  ipcMain.handle(
    BROWSER_FAVICON_LOAD,
    (event, url: unknown, pageUrl: unknown, webContentsId: unknown) =>
      loadFavicon(browserSession, event, url, pageUrl, webContentsId).catch(() => null),
  );
}
