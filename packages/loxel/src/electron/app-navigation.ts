/**
 * Where the web contents of the app's session may go: Loxel's windows show the app's page and
 * nothing else. Their main frame stays on the app's page, a frame showing a document the app's
 * server sent stays on the server, and a window they ask to open is a new Loxel window (for the
 * app's page) or a web link opened outside the app, once per click or key press in the window.
 * Browser panels and their popups have a session of their own, with rules of their own
 * (webview-new-tabs.ts).
 */
import type { WebContents } from "electron";

import { isHttpUrl } from "../url-utils";
import { trackUserActivation } from "./user-activation";

/** What to do with a URL a window asks to open or navigate its main frame to. */
export type AppWindowTarget = "app-page" | "outside" | "none";

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * Whether `url` is the app's page, the URL Loxel's windows load (`appUrl`): the same origin, path
 * and query. Only its fragment may differ, which never loads a new document.
 */
export function isAppPage(url: string, appUrl: string): boolean {
  const target = parseUrl(url);
  const app = new URL(appUrl);
  return (
    target !== null &&
    target.origin === app.origin &&
    target.pathname === app.pathname &&
    target.search === app.search
  );
}

/**
 * Where a URL a Loxel window asks to open, or to show in its main frame, belongs: the app's page,
 * a web page outside the app, or nowhere. The app's origin serves nothing else a window shows.
 */
export function appWindowTarget(url: string, appUrl: string): AppWindowTarget {
  if (isAppPage(url, appUrl)) return "app-page";
  if (parseUrl(url)?.origin === new URL(appUrl).origin) return "none";
  return isHttpUrl(url) ? "outside" : "none";
}

/**
 * Whether a frame showing `frameUrl` may navigate to `url`. A document the app's server sent (a
 * media frame) stays on the server; other frames, such as an embedded page, go where they like.
 */
export function mayFrameNavigate(frameUrl: string, url: string, appOrigin: string): boolean {
  if (parseUrl(frameUrl)?.origin !== appOrigin) return true;
  return parseUrl(url)?.origin === appOrigin;
}

export interface AppNavigationActions {
  /** Open a new Loxel window. */
  openAppWindow: () => void;
  /** Open a web page outside the app: the system browser, or a browser panel. */
  openOutside: (url: string) => void;
}

/** Log what was refused by origin and path only: a query may name the user's files. */
function logRefused(what: string, url: string): void {
  const parsed = parseUrl(url);
  const shown = parsed ? `${parsed.origin}${parsed.pathname}` : "an invalid URL";
  console.warn(`[electron] Refused to ${what} ${shown}`);
}

/**
 * Hold `contents`, a window of the app's session (a Loxel window, or any other window in it), to
 * the rules above. A window it asks to open never opens as its child, so no page gets a
 * `window.opener` into a Loxel window. The app's server answers these URLs without redirects, so
 * checking where a navigation starts is enough.
 */
export function guardAppNavigation(
  contents: WebContents,
  appUrl: string,
  actions: AppNavigationActions,
  now = Date.now,
): void {
  const appOrigin = new URL(appUrl).origin;
  // Electron blocks no popups in its windows and doesn't tell the handler whether the user acted,
  // so a frame embedded in the app could open windows on its own. Like a browser's popup blocker,
  // each click or key press in the window opens at most one.
  const activation = trackUserActivation(contents, now);
  contents.setWindowOpenHandler(({ url }) => {
    const target = appWindowTarget(url, appUrl);
    if (target === "none") {
      logRefused("open a window for", url);
      return { action: "deny" };
    }
    if (!activation.isActive()) return { action: "deny" };
    activation.consume();
    if (target === "app-page") actions.openAppWindow();
    else actions.openOutside(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    const target = appWindowTarget(url, appUrl);
    if (target === "app-page") return;
    event.preventDefault();
    if (target === "outside") actions.openOutside(url);
    else logRefused("navigate a window to", url);
  });
  // will-navigate covers only the main frame.
  contents.on("will-frame-navigate", (event) => {
    // A frame that is gone (null) shows nothing to keep on the server.
    if (event.isMainFrame || !event.frame) return;
    if (mayFrameNavigate(event.frame.url, event.url, appOrigin)) return;
    event.preventDefault();
    logRefused("navigate a frame to", event.url);
  });
}
