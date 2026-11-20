import type { Session } from "electron";

import { normalizeOrigin } from "../url-utils";
import type { requestExternalApp } from "./browser-external-apps";
import type { requestFileAccess } from "./browser-file-access";
import type { localNetworkPermitted } from "./browser-local-network";
import type { checkMediaPermission, requestMediaPermission } from "./browser-media";

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

/** Chromium's Local Network Access permissions, decided by `browser-local-network.ts`. */
const LOCAL_NETWORK: ReadonlySet<BrowserPermission> = new Set<BrowserPermission>([
  "local-network",
  "local-network-access",
  "loopback-network",
]);

/**
 * Permissions every browser panel page gets without being asked, as browsers give them. Everything
 * else is refused, unless Loxel decides it itself (the camera and microphone, in
 * `browser-media.ts`, links to other apps, in `browser-external-apps.ts`, file access requests, in
 * `browser-file-access.ts`, the local network, in `browser-local-network.ts`, and notifications);
 * Electron's default, with no handler, grants every permission to every page.
 *
 * Some permissions browsers grant quietly are refused anyway, as pages carry on without them:
 * `persistent-storage` (storage stays best-effort), and `background-sync`, `sensors` and
 * `payment-handler`, which do nothing in Loxel.
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
  // File System Access checks. The patched Electron makes this check a veto (PATCHED_ELECTRON.md):
  // it keeps the access the page was given (a file the user picked, saved or dropped, or access
  // the user allowed), and refusing it would break the API, save dialogs included. Access the page
  // doesn't have is requested, and the user is asked (browser-file-access.ts). On stock Electron,
  // as in dev runs and tests, this check alone decides, and grants write access to a file picked
  // only for reading.
  "fileSystem",
]);

/**
 * Whether a browser panel page gets `permission`, for every permission but `media`, the
 * `openExternal` and `fileSystem` requests and the local network, which the user decides
 * (`browser-media.ts`, `browser-external-apps.ts`, `browser-file-access.ts`,
 * `browser-local-network.ts`). One decision answers both the check and the request, so what a page
 * reads (`navigator.permissions.query()`) matches what asking gets it. Each permission decided
 * otherwise than by the allowlist has its own branch here.
 */
export function browserPermissionGranted(
  permission: BrowserPermission,
  asker: PermissionAsker,
): boolean {
  // Chromium's notifications would bypass Loxel's: pages get Loxel's own Notification, which
  // asks the user per site and shows in the notification center (browser-notifications.ts).
  if (permission === "notifications") return false;
  // Links to other apps are only ever requested, and asked about (browser-external-apps.ts).
  if (permission === "openExternal") return false;
  if (EXCLUSIVE_ACCESS.has(permission) && !asker.inBrowserPanel) return false;
  return GRANTED.has(permission);
}

/** The modules that decide a permission from what the user said (passed in by `main.ts`). */
export interface PermissionAskers {
  media: { check: typeof checkMediaPermission; request: typeof requestMediaPermission };
  openExternal: typeof requestExternalApp;
  fileSystem: typeof requestFileAccess;
  localNetwork: typeof localNetworkPermitted;
}

/**
 * Decide browser panel permissions in `browserSession`. Both handlers are needed: requests answer
 * `requestPermission()`-style calls, and checks are what `navigator.permissions.query()` and many
 * APIs read before (or instead of) asking. The camera and microphone (`media`), links to other
 * apps (`openExternal`), file access requests (`fileSystem`) and the local network go to `askers`,
 * which may ask the user before answering a request.
 */
export function installBrowserPermissions(
  browserSession: Pick<Session, "setPermissionCheckHandler" | "setPermissionRequestHandler">,
  { media, openExternal, fileSystem, localNetwork }: PermissionAskers,
  onGranted?: (
    webContents: Parameters<PermissionRequestHandler>[0],
    permission: BrowserPermission,
    requestingUrl: string,
  ) => void,
): void {
  const check: PermissionCheckHandler = (webContents, permission, origin, details) => {
    if (permission === "media") return media.check(webContents, origin, details.mediaType);
    if (LOCAL_NETWORK.has(permission)) {
      return localNetwork(webContents, origin, details.embeddingOrigin);
    }
    return browserPermissionGranted(permission, {
      isMainFrame: details.isMainFrame,
      inBrowserPanel: webContents?.getType() === "webview",
    });
  };
  const request: PermissionRequestHandler = (webContents, permission, callback, details) => {
    // Before the callback, which can act on the grant synchronously (fullscreen does).
    const answer = (granted: boolean) => {
      if (granted) onGranted?.(webContents, permission, details.requestingUrl);
      callback(granted);
    };
    // Every `media` request goes to the media module: getUserMedia()'s name their media types, a
    // `<usermedia>`, `<camera>` or `<microphone>` element's don't (browser-media.ts).
    if (permission === "media") {
      media.request(webContents, details, answer);
      return;
    }
    if (permission === "openExternal") {
      openExternal(webContents, details, answer);
      return;
    }
    if (permission === "fileSystem") {
      fileSystem(webContents, details, answer);
      return;
    }
    // Electron only checks these, never requests them; a request gets the same answer.
    if (LOCAL_NETWORK.has(permission)) {
      answer(localNetwork(webContents, normalizeOrigin(details.requestingUrl) ?? ""));
      return;
    }
    answer(
      browserPermissionGranted(permission, {
        isMainFrame: details.isMainFrame,
        inBrowserPanel: webContents.getType() === "webview",
      }),
    );
  };
  browserSession.setPermissionCheckHandler(check);
  browserSession.setPermissionRequestHandler(request);
}
