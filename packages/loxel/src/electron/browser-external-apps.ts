/**
 * Links from browser panel pages to other apps (`mailto:`, `zoommtg:`, `vscode:`), which Electron
 * hands to the browser session's `openExternal` permission request before opening them in the app.
 *
 * Like Chrome, Loxel asks first: the panel's bar names the site and the app, and the user allows
 * the site's links of that scheme (saved), opens this one, or blocks them (saved). Electron asks
 * without saying whether the user clicked, so a launch also needs a click or key press in the page
 * within the last few seconds (`user-activation.ts`), even for an allowed site: a page can't open
 * an app as it loads, or open several from one click. Only the page itself may open them, not
 * frames embedded in it, such as ads; a popup window, with no panel to ask in, opens only the
 * links its site was allowed.
 */
import { type OpenExternalPermissionRequest, type WebContents, app } from "electron";

import { normalizeOrigin } from "./browser-media";
import { askSiteAccess, siteAccessLoaded, siteAccessState } from "./browser-site-access";
import type { SiteAccess } from "./site-permission-protocol";
import { userActivationOf } from "./user-activation";

/** A URL's scheme without the colon (`zoommtg`), or null when it isn't a URL. */
export function schemeOf(url: string): string | null {
  return URL.canParse(url) ? new URL(url).protocol.slice(0, -1) : null;
}

/** The app the OS opens `url` in (`zoom.us`), or empty when it doesn't say. */
function appFor(url: string): string {
  try {
    return app.getApplicationNameForProtocol(url);
  } catch {
    return "";
  }
}

async function decide(
  contents: WebContents,
  details: Pick<OpenExternalPermissionRequest, "externalURL" | "requestingUrl" | "isMainFrame">,
): Promise<boolean> {
  const site = normalizeOrigin(details.requestingUrl);
  const url = details.externalURL ?? "";
  const scheme = schemeOf(url);
  if (!details.isMainFrame || !site || !scheme || contents.isDestroyed()) return false;
  // The request reaches main after a hop, so the page may have moved on to another site.
  if (contents.mainFrame.origin !== site) return false;
  const activation = userActivationOf(contents);
  if (!activation?.isActive()) return false;
  activation.consume();
  await siteAccessLoaded();
  if (contents.isDestroyed() || contents.mainFrame.origin !== site) return false;
  const access: SiteAccess = { kind: "external-app", origin: site, scheme, app: appFor(url) };
  if (contents.getType() !== "webview") return siteAccessState(contents.id, access) === "allow";
  return askSiteAccess(contents, access);
}

/** The `openExternal` permission request: a page asked to open `details.externalURL`. */
export function requestExternalApp(
  contents: WebContents,
  details: Pick<OpenExternalPermissionRequest, "externalURL" | "requestingUrl" | "isMainFrame">,
  callback: (granted: boolean) => void,
): void {
  decide(contents, details).then(callback, (error: unknown) => {
    console.error("[browser-external-apps] Refused a link to another app after an error", error);
    callback(false);
  });
}
