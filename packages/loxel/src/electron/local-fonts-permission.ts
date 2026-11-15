import type { Session } from "electron";

type PermissionCheckHandler = NonNullable<Parameters<Session["setPermissionCheckHandler"]>[0]>;

/**
 * A permission check handler that decides `local-fonts`, the Local Font Access API the font
 * pickers in Settings list installed fonts with. The list fingerprints the machine, so only pages
 * `allowOrigin` accepts get it, and never from a cross-origin frame.
 *
 * Electron answers a page's font query from the check handler alone: its permission status is
 * granted or denied, never "ask", so no permission request follows. Other permissions get the
 * answer Electron gives without a check handler.
 */
export function localFontsCheckHandler(
  allowOrigin: (origin: string) => boolean,
): PermissionCheckHandler {
  return (_webContents, permission, requestingOrigin, details) => {
    if (permission === "local-fonts") {
      // `embeddingOrigin` is set for main frames too, as their own origin.
      const { embeddingOrigin } = details;
      return (
        allowOrigin(requestingOrigin) &&
        (embeddingOrigin === undefined || allowOrigin(embeddingOrigin))
      );
    }
    return permission !== "deprecated-sync-clipboard-read";
  };
}
