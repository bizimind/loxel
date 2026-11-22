import type { Session } from "electron";

type PermissionCheckHandler = NonNullable<Parameters<Session["setPermissionCheckHandler"]>[0]>;

/** A web permission as Electron names it to a session's permission handlers. */
type AppPermission = Parameters<PermissionCheckHandler>[1];

/**
 * The permissions Loxel's own page uses. Everything else is refused, to the page and to every
 * frame inside it: with no handlers, Electron grants every permission to every page, and frames in
 * the app's windows can show content from a repository or the web (an embed in a drawing).
 */
const APP_PAGE_PERMISSIONS: ReadonlySet<AppPermission> = new Set<AppPermission>([
  // `window.queryLocalFonts()`, the font pickers in Settings. The list fingerprints the machine.
  // Electron answers it from the check handler alone: its status is never "ask".
  "local-fonts",
  // `navigator.clipboard.writeText()` / `write()`: copy buttons and menu items.
  "clipboard-sanitized-write",
  // `navigator.clipboard.read()` / `readText()`: Paste in the drawing editor's context menu and the
  // code editor's Paste command.
  "clipboard-read",
  // `requestFullscreen()` on an embed's frame, the drawing editor's "Enter fullscreen". The embed
  // itself asks from its own frame, and is refused.
  "fullscreen",
  // The File System Access API, for the drawing editor's export and image pickers. On the patched
  // Electron the check only keeps the access a picker gave (PATCHED_ELECTRON.md).
  "fileSystem",
]);

/**
 * Decide the permissions of `appSession`, the session of Loxel's windows, with one decision for
 * both handlers, so what the page reads (`navigator.permissions.query()`) matches what requesting
 * gets it. Only the app's own page (the main frame, at an origin `isAppOrigin` accepts) gets them:
 * never a frame inside it, even one at the app's URL (a media frame), nor the app framed by another
 * origin. Browser panels have a session of their own (browser-permissions.ts).
 */
export function installAppPermissions(
  appSession: Pick<Session, "setPermissionCheckHandler" | "setPermissionRequestHandler">,
  isAppOrigin: (url: string) => boolean,
): void {
  const granted = (permission: AppPermission, url: string, isMainFrame: boolean) =>
    APP_PAGE_PERMISSIONS.has(permission) && isMainFrame && isAppOrigin(url);
  appSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) =>
    granted(
      permission,
      requestingOrigin,
      // Electron checks a File System Access grant with no frame, by the origin that holds it, so
      // no `fileSystem` check is a main frame's. The request that grants it is.
      details.isMainFrame || permission === "fileSystem",
    ),
  );
  appSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    callback(granted(permission, details.requestingUrl, details.isMainFrame));
  });
}
