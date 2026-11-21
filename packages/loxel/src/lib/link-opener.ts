import type * as monaco from "monaco-editor";

import { frontendLog } from "@/lib/frontend-logger";
import { isSameOrigin } from "@/url-utils";

const log = frontendLog.child("ui");

/**
 * Opens a web page outside the app's own window: the main process sends it to the system browser,
 * or to a browser panel when `Cmd` is held, as it does for every page the app opens.
 */
function openInBrowser(url: string): void {
  window.open(url, "_blank", "noopener");
}

/**
 * Opens the links editors show (document links, hover links, URLs in the text), which come from
 * the files and the language servers. Web links open in the browser, except those to the app's
 * own origin, which serves the app and its API and is never opened from a link. A `command:` link
 * never runs an editor command: the opener gets no word on whether a link is trusted, and file
 * content reaches links through language workers, so this includes the few command links Monaco
 * shows itself (such as a hover's "Don't Show Again"). Every other link is left to the editor opener.
 */
export function createLinkOpener(
  appOrigin: string = window.location.origin,
  openExternal: (url: string) => void = openInBrowser,
): monaco.editor.ILinkOpener {
  return {
    open(resource) {
      const scheme = resource.scheme.toLowerCase();
      if (scheme === "command") {
        log.warn("Not running a command link from an editor", { command: resource.path });
        return true;
      }
      if (scheme !== "http" && scheme !== "https") return false;
      // Monaco's own form of a link it opens externally.
      const url = encodeURI(resource.toString(true));
      if (isSameOrigin(url, appOrigin)) {
        log.warn("Not opening an editor link to the app's own origin", { path: resource.path });
        return true;
      }
      openExternal(url);
      return true;
    },
  };
}
