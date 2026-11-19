import type { Session } from "electron";

type PermissionCheckHandler = NonNullable<Parameters<Session["setPermissionCheckHandler"]>[0]>;
type PermissionRequestHandler = NonNullable<Parameters<Session["setPermissionRequestHandler"]>[0]>;

/** A web permission as Electron names it to a session's permission handlers. */
export type BrowserPermission = Parameters<PermissionCheckHandler>[1];

/** The frame a permission check or request comes from. */
export interface PermissionAsker {
  isMainFrame: boolean;
  /** It is in a browser panel's page, not a popup window (or no page, such as a worker). */
  inBrowserPanel: boolean;
}

/**
 * Permissions that take the screen or the pointer. Only a browser panel can say which site has
 * them (exclusive-access.ts), so popup windows don't get them.
 */
const EXCLUSIVE_ACCESS: ReadonlySet<BrowserPermission> = new Set<BrowserPermission>([
  "fullscreen",
  "pointerLock",
]);

/**
 * Permissions every browser panel page gets without being asked, as browsers give them. Everything
 * else is refused, since Loxel has no permission prompt; Electron's default, with no handler,
 * grants every permission to every page.
 *
 * Some permissions browsers grant quietly are refused anyway, as pages carry on without them:
 * `persistent-storage` (storage stays best-effort), and `background-sync`, `sensors` and
 * `payment-handler`, which do nothing in Loxel. Local network access (`local-network-access`,
 * `local-network`, `loopback-network`) is refused too, but Electron turns Chromium's checks off, so
 * nothing asks for it; if an Electron upgrade turns them on, public pages that call local dev
 * servers need a decision here.
 */
const GRANTED: ReadonlySet<BrowserPermission> = new Set<BrowserPermission>([
  // `navigator.clipboard.write()` / `writeText()` from a click or key press: copy buttons. Writes
  // without one, or of custom formats, count as `clipboard-read`, which stays refused with reads.
  "clipboard-sanitized-write",
  // `requestFullscreen()`, as video players use it. Chromium already requires a user gesture, Esc
  // leaves, and the panel names the site (exclusive-access.ts). Fullscreen without a gesture
  // (`automatic-fullscreen`) stays refused. `navigator.keyboard.lock()` (`keyboardLock`) is refused:
  // Chromium refuses it to webviews before asking anyway, and a lock that held Esc would make the
  // panel's "Press Esc" wrong.
  "fullscreen",
  // `requestPointerLock()`, for games and 3D viewers. Needs a click, Esc releases it, and the panel
  // names the site.
  "pointerLock",
  // `navigator.wakeLock.request("screen")`, for slides, recipes and video calls: keeps the display
  // awake, nothing more, and Chromium releases it when the page is hidden.
  "screen-wake-lock",
  // File System Access. Required, not chosen: once a check handler exists, Electron decides every
  // file handle's access from it alone, so refusing it breaks the API, save dialogs included. What
  // it grants is read and write access to whatever the user picked or dropped on the page, also
  // through handles the page kept from an earlier visit; browsers ask before writing to a file
  // picked for reading.
  "fileSystem",
]);

/**
 * Whether a browser panel page gets `permission`. One decision answers both the check and the
 * request, so what a page reads (`navigator.permissions.query()`) matches what asking gets it. Each
 * permission decided otherwise than by the allowlist has its own branch here.
 */
export function browserPermissionGranted(
  permission: BrowserPermission,
  asker: PermissionAsker,
): boolean {
  // Chromium's notifications would bypass Loxel's: pages get Loxel's own Notification, which
  // asks the user per site and shows in the notification center (browser-notifications.ts).
  if (permission === "notifications") return false;
  // Links to other apps (`mailto:`, `zoommtg:`, `vscode:`), which open in those apps today.
  // Browsers ask first; until Loxel can, the page itself may open them, but frames embedded in it,
  // such as ads, may not.
  if (permission === "openExternal") return asker.isMainFrame;
  if (EXCLUSIVE_ACCESS.has(permission) && !asker.inBrowserPanel) return false;
  return GRANTED.has(permission);
}

/**
 * Decide browser panel permissions in `browserSession`. Both handlers are needed: requests answer
 * `requestPermission()`-style calls, and checks are what `navigator.permissions.query()` and many
 * APIs read before (or instead of) asking.
 */
export function installBrowserPermissions(
  browserSession: Pick<Session, "setPermissionCheckHandler" | "setPermissionRequestHandler">,
  onGranted?: (
    webContents: Parameters<PermissionRequestHandler>[0],
    permission: BrowserPermission,
    requestingUrl: string,
  ) => void,
): void {
  const check: PermissionCheckHandler = (webContents, permission, _origin, details) =>
    browserPermissionGranted(permission, {
      isMainFrame: details.isMainFrame,
      inBrowserPanel: webContents?.getType() === "webview",
    });
  const request: PermissionRequestHandler = (webContents, permission, callback, details) => {
    const granted = browserPermissionGranted(permission, {
      isMainFrame: details.isMainFrame,
      inBrowserPanel: webContents.getType() === "webview",
    });
    // Before the callback, which can act on the grant synchronously (fullscreen does).
    if (granted) onGranted?.(webContents, permission, details.requestingUrl);
    callback(granted);
  };
  browserSession.setPermissionCheckHandler(check);
  browserSession.setPermissionRequestHandler(request);
}
