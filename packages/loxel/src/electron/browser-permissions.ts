import type { Session } from "electron";

type PermissionCheckHandler = NonNullable<Parameters<Session["setPermissionCheckHandler"]>[0]>;
type PermissionRequestHandler = NonNullable<Parameters<Session["setPermissionRequestHandler"]>[0]>;

/** A web permission as Electron names it to a session's permission handlers. */
export type BrowserPermission = Parameters<PermissionCheckHandler>[1];

/**
 * Permissions browser panel pages get without being asked, as browsers give them. Everything else
 * is refused, since Loxel has no permission prompt; Electron's default, with no handler, grants
 * every permission to every page.
 *
 * Local network access (`local-network-access`, `local-network`, `loopback-network`) is not
 * listed: Electron turns Chromium's checks off, so nothing asks for it. If an Electron upgrade turns
 * them on, public pages that call local dev servers need a decision here.
 */
const GRANTED: ReadonlySet<BrowserPermission> = new Set<BrowserPermission>([
  // `navigator.clipboard.write()` / `writeText()`: copy buttons. Writes only, and sanitized;
  // reading the clipboard (`clipboard-read`) stays refused.
  "clipboard-sanitized-write",
  // `requestFullscreen()`, as video players use it. Chromium already requires a user gesture, and
  // Esc leaves. Fullscreen without a gesture (`automatic-fullscreen`) stays refused.
  "fullscreen",
  // `requestPointerLock()`, for games and 3D viewers. Needs a click, and Esc releases it.
  "pointerLock",
  // File System Access on a file or folder the user picked in the native dialog, which is the
  // consent. Electron also decides each picked handle's read and write access from the check
  // handler, so refusing it would break the API for every page.
  "fileSystem",
  // Links to other apps (`mailto:`, `zoommtg:`, `vscode:`). Browsers ask first; until Loxel can,
  // refusing would break those links, which open in other apps today.
  "openExternal",
]);

/**
 * Whether a browser panel page gets `permission`. One decision answers both the check and the
 * request, so what a page reads (`Notification.permission`) matches what asking gets it. A
 * permission decided per site gets its own branch here.
 */
export function browserPermissionGranted(permission: BrowserPermission): boolean {
  // Not offered yet: no page can show notifications.
  if (permission === "notifications") return false;
  return GRANTED.has(permission);
}

/**
 * Decide browser panel permissions in `browserSession`. Both handlers are needed: requests answer
 * `requestPermission()`-style calls, and checks are what `Notification.permission`,
 * `navigator.permissions.query()` and many APIs read before (or instead of) asking.
 */
export function installBrowserPermissions(
  browserSession: Pick<Session, "setPermissionCheckHandler" | "setPermissionRequestHandler">,
): void {
  const check: PermissionCheckHandler = (_webContents, permission) =>
    browserPermissionGranted(permission);
  const request: PermissionRequestHandler = (_webContents, permission, callback) => {
    callback(browserPermissionGranted(permission));
  };
  browserSession.setPermissionCheckHandler(check);
  browserSession.setPermissionRequestHandler(request);
}
