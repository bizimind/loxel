/**
 * What a browser panel `<webview>` gets when it attaches (`will-attach-webview`), whatever its
 * element asks for: the browser panels' partition, Loxel's own sandboxed preload, and Chromium's
 * secure defaults. Only Loxel's window renderer can create a webview; this holds even if that
 * renderer were made to ask for less.
 * See: https://www.electronjs.org/docs/latest/tutorial/security#12-verify-webview-options-before-creation
 */
import type { WebPreferences } from "electron";

import { isHttpUrl } from "../url-utils";
import { BROWSER_PARTITION } from "./browser-partition";
import { configureWebviewDialogs } from "./javascript-dialogs";

const VIEW_SOURCE = "view-source:";

/**
 * `BrowserPanel` attaches its webviews blank and navigates them afterwards. A webview attached
 * again starts on its page's URL, which Electron writes back to `src`: a web page, or the source of
 * one (View Page Source).
 */
function isAllowedSource(src: string | undefined): boolean {
  if (src === undefined) return false;
  if (src === "about:blank") return true;
  return isHttpUrl(src.startsWith(VIEW_SOURCE) ? src.slice(VIEW_SOURCE.length) : src);
}

/**
 * Lock down an attaching webview's preferences in place. Returns whether it may attach: only one
 * that starts on `about:blank`, a web page or its source, so none starts on a `file:` or `data:` URL.
 */
export function secureWebviewAttach(
  webPreferences: WebPreferences,
  params: Record<string, string | undefined>,
): boolean {
  if (!isAllowedSource(params.src)) return false;
  // Never the windows' session, whose requests to the server carry the app's secret.
  webPreferences.partition = BROWSER_PARTITION;
  delete webPreferences.preload;
  webPreferences.nodeIntegration = false;
  webPreferences.nodeIntegrationInWorker = false;
  webPreferences.contextIsolation = true;
  webPreferences.webSecurity = true;
  webPreferences.allowRunningInsecureContent = false;
  webPreferences.webviewTag = false;
  webPreferences.experimentalFeatures = false;
  delete webPreferences.enableBlinkFeatures;
  // Loxel's own preload (which also runs in subframes, sandboxed, without Node.js).
  configureWebviewDialogs(webPreferences);
  return true;
}
