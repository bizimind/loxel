/**
 * File System Access requests from browser panel pages, which Loxel asks the user about as Chrome
 * does: writing to a file or folder the user picked or dropped only for reading, reading a folder
 * the user picked, and using a file or folder a site kept from an earlier visit.
 *
 * The patched Electron Loxel ships (PATCHED_ELECTRON.md) leaves such access to the session's
 * permission request, which comes here; the check (`browser-permissions.ts`) only keeps what was
 * granted. The panel's bar names the site, the file or folder, and whether the page would read or
 * write it. Allow gives the page that access, and Block or closing the bar refuses it. Chromium
 * keeps either answer for as long as the page holds the file or folder (until it reloads or leaves,
 * say), so a refused page can't ask again meanwhile. Nothing is saved, so a later visit asks again.
 * A popup window has no panel to ask in, and its requests are refused, as is a request whose page
 * has moved on to another site.
 */
import path from "node:path";

import type { FilesystemPermissionRequest, WebContents } from "electron";

import { normalizeOrigin } from "../url-utils";
import { askSiteAccess } from "./browser-site-access";
import type { SiteAccess } from "./site-permission-protocol";

type FileAccessDetails = Pick<
  FilesystemPermissionRequest,
  "filePath" | "isDirectory" | "fileAccessType" | "requestingUrl"
>;

async function decide(contents: WebContents, details: FileAccessDetails): Promise<boolean> {
  const site = normalizeOrigin(details.requestingUrl);
  const { filePath } = details;
  if (!site || !filePath || contents.isDestroyed() || contents.getType() !== "webview") {
    return false;
  }
  // The request reaches main after a hop, so the page may have moved on to another site.
  if (contents.mainFrame.origin !== site) return false;
  const access: SiteAccess = {
    kind: "file-system",
    origin: site,
    path: filePath,
    name: path.basename(filePath) || filePath,
    directory: details.isDirectory === true,
    write: details.fileAccessType === "writable",
  };
  return askSiteAccess(contents, access);
}

/** The `fileSystem` permission request: a page asked to read or write `details.filePath`. */
export function requestFileAccess(
  contents: WebContents,
  details: FileAccessDetails,
  callback: (granted: boolean) => void,
): void {
  decide(contents, details).then(callback, (error: unknown) => {
    console.error("[browser-file-access] Refused file access after an error", error);
    callback(false);
  });
}
