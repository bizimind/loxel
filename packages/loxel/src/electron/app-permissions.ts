import type { Session } from "electron";

type PermissionCheckHandler = NonNullable<Parameters<Session["setPermissionCheckHandler"]>[0]>;

/** A web permission as Electron names it to a session's permission handlers. */
type AppPermission = Parameters<PermissionCheckHandler>[1];

/**
 * The permissions Loxel's own page uses, for its main frame only. Everything else is refused, to
 * the page and to every frame inside it, unless it is in `FRAME_PERMISSIONS`: with no handlers,
 * Electron grants every permission to every page, and frames in the app's windows can show content
 * from a repository or the web (an embed in a drawing).
 */
const APP_PAGE_PERMISSIONS: ReadonlySet<AppPermission> = new Set<AppPermission>([
  // `window.queryLocalFonts()`, the font pickers in Settings. The list fingerprints the machine.
  // Electron answers it from the check handler alone: its status is never "ask".
  "local-fonts",
  // `navigator.clipboard.read()` / `readText()`: Paste in the drawing editor's context menu and the
  // code editor's Paste command.
  "clipboard-read",
  // The File System Access API, for the drawing editor's export and image pickers. On the patched
  // Electron the check only keeps the access a picker gave (PATCHED_ELECTRON.md).
  "fileSystem",
]);

/**
 * Permissions every frame of the app's page gets too, as browsers give them: the page's copy
 * buttons and the drawing editor's "Enter fullscreen", and an embed's own copy and fullscreen
 * buttons. Chromium asks for them only on a click or key press in the asking frame: a write without
 * one, or of custom formats, counts as `clipboard-read`, and fullscreen without one as
 * `automatic-fullscreen`, both refused to frames.
 */
const FRAME_PERMISSIONS: ReadonlySet<AppPermission> = new Set<AppPermission>([
  // `navigator.clipboard.writeText()` / `write()`.
  "clipboard-sanitized-write",
  // `requestFullscreen()`.
  "fullscreen",
]);

/**
 * Decide the permissions of `appSession`, the session of Loxel's windows, with one decision for
 * both handlers, so what the page reads (`navigator.permissions.query()`) matches what requesting
 * gets it. The app's page is the main frame at an origin `isAppOrigin` accepts: frames inside it,
 * even one at the app's URL (a media frame), get only `FRAME_PERMISSIONS`. Browser panels have a
 * session of their own (browser-permissions.ts).
 */
export function installAppPermissions(
  appSession: Pick<Session, "setPermissionCheckHandler" | "setPermissionRequestHandler">,
  isAppOrigin: (url: string) => boolean,
): void {
  const granted = (
    permission: AppPermission,
    frame: { url: string; isMainFrame: boolean; pageUrl: string | undefined },
  ) => {
    if (FRAME_PERMISSIONS.has(permission)) {
      return frame.pageUrl !== undefined && isAppOrigin(frame.pageUrl);
    }
    return APP_PAGE_PERMISSIONS.has(permission) && frame.isMainFrame && isAppOrigin(frame.url);
  };
  appSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) =>
    granted(permission, {
      url: requestingOrigin,
      // Electron checks a File System Access grant with no frame, by the origin that holds it, so
      // no `fileSystem` check is a main frame's. The request that grants it is.
      isMainFrame: details.isMainFrame || permission === "fileSystem",
      // The top-level page's origin, set for main frames too.
      pageUrl: details.embeddingOrigin,
    }),
  );
  appSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(
      granted(permission, {
        url: details.requestingUrl,
        isMainFrame: details.isMainFrame,
        pageUrl: webContents.getURL(),
      }),
    );
  });
}
