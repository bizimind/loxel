import type { Session } from "electron";

type PermissionCheckHandler = NonNullable<Parameters<Session["setPermissionCheckHandler"]>[0]>;
type PermissionRequestHandler = NonNullable<Parameters<Session["setPermissionRequestHandler"]>[0]>;

/** A web permission as Electron names it to a session's permission handlers. */
export type BrowserPermission = Parameters<PermissionCheckHandler>[1];

/** The frame a permission check or request comes from. */
export interface PermissionAsker {
  isMainFrame: boolean;
}

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
  // `requestFullscreen()`, as video players use it. Chromium already requires a user gesture, and
  // Esc leaves. Fullscreen without a gesture (`automatic-fullscreen`) stays refused.
  "fullscreen",
  // `navigator.keyboard.lock()`, for remote desktops and cloud games: only held while the page is
  // fullscreen and focused, and holding Esc leaves.
  "keyboardLock",
  // `requestPointerLock()`, for games and 3D viewers. Needs a click, and Esc releases it.
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
  return GRANTED.has(permission);
}

/**
 * Decide browser panel permissions in `browserSession`. Both handlers are needed: requests answer
 * `requestPermission()`-style calls, and checks are what `navigator.permissions.query()` and many
 * APIs read before (or instead of) asking.
 */
export function installBrowserPermissions(
  browserSession: Pick<Session, "setPermissionCheckHandler" | "setPermissionRequestHandler">,
): void {
  const check: PermissionCheckHandler = (_webContents, permission, _origin, details) =>
    browserPermissionGranted(permission, { isMainFrame: details.isMainFrame });
  const request: PermissionRequestHandler = (_webContents, permission, callback, details) => {
    callback(browserPermissionGranted(permission, { isMainFrame: details.isMainFrame }));
  };
  browserSession.setPermissionCheckHandler(check);
  browserSession.setPermissionRequestHandler(request);
}
