/**
 * Check whether a string is a valid http: or https: URL.
 *
 * Also serves as the guard for opening URLs externally (`shell.openExternal`) — it rejects
 * `file://`, custom protocols, and anything that fails to parse.
 */
export function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * The web origin of a URL or origin (`https://example.com/` → `https://example.com`), as pages
 * name it; null for an opaque origin (`data:`, `about:blank`) or anything that isn't a URL.
 */
export function normalizeOrigin(url: string | undefined): string | null {
  if (!url || !URL.canParse(url)) return null;
  const { origin } = new URL(url);
  return origin === "null" ? null : origin;
}

/** Whether `a` and `b` are URLs of the same web origin (never an opaque one, such as `data:`). */
export function isSameOrigin(a: string, b: string): boolean {
  if (!URL.canParse(a) || !URL.canParse(b)) return false;
  const origin = new URL(a).origin;
  return origin !== "null" && origin === new URL(b).origin;
}

/**
 * A host of this machine (`localhost`, `*.localhost`, `127.x.x.x`, `[::1]`), where dev servers run.
 * Plain `http` counts as secure there, as browsers do.
 */
export function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "[::1]" ||
    /^127(\.\d{1,3}){3}$/.test(hostname)
  );
}

/**
 * Largest favicons kept, inline (`data:`) or as a web URL: the lists that hold them (bookmarks,
 * notifications) are written and sent to every window, and a page picks its favicon's URL.
 */
const MAX_DATA_FAVICON_LENGTH = 16 * 1024;
const MAX_WEB_FAVICON_LENGTH = 2048;

/**
 * Whether a page's favicon URL, as Chromium reported it for a browser panel, may be kept beside a
 * bookmark or a notification: a short web URL, or a small inline image.
 */
export function isStorableFavicon(url: string): boolean {
  if (url.startsWith("data:image/")) return url.length <= MAX_DATA_FAVICON_LENGTH;
  return url.length <= MAX_WEB_FAVICON_LENGTH && isHttpUrl(url);
}
