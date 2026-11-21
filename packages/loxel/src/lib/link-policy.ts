import type { IDisposable, Uri } from "monaco-editor";
import { StandaloneServices } from "monaco-editor/editor/standalone/browser/standaloneServices.js";
import { IOpenerService } from "monaco-editor/platform/opener/common/opener.js";

import { frontendLog } from "@/lib/frontend-logger";

const log = frontendLog.child("ui");

/**
 * Whether an editor may open `target`, a link from a file or a language server (a document link,
 * a hover link, a URL in the text). A `command:` link never runs an editor command: the check gets
 * no word on whether a link is trusted, so this includes the few command links Monaco shows itself
 * (such as a hover's "Don't Show Again"). A web link is opened by Monaco as written, through
 * `window.open`, so it is resolved here the same way, against `baseUrl`, and is not opened when it
 * lands on `appOrigin`, which serves the app and its API. Everything else is left to the openers.
 */
export function shouldOpenLink(target: string | Uri, baseUrl: string, appOrigin: string): boolean {
  // The string Monaco opens: the link as written, or its own form of a parsed one.
  const href = typeof target === "string" ? target : encodeURI(target.toString(true));
  const lower = href.trimStart().toLowerCase();
  if (lower.startsWith("command:")) return false;
  if (!lower.startsWith("http:") && !lower.startsWith("https:")) return true;
  return URL.canParse(href, baseUrl) && new URL(href, baseUrl).origin !== appOrigin;
}

/**
 * Checks every link Monaco's opener service opens with `shouldOpenLink`, ahead of its own openers.
 * The opener registers on the service itself, as `monaco.editor.registerLinkOpener` hands openers
 * a parsed URI rather than the link as written. A refused link counts as handled, so no other
 * opener sees it; one let through goes on to Monaco's openers, which open web links outside the
 * app's window as written: the main process sends them to the system browser, or to a browser
 * panel when `Cmd` is held.
 */
export function installLinkPolicy(): IDisposable {
  return StandaloneServices.get(IOpenerService).registerOpener({
    open(target) {
      if (shouldOpenLink(target, document.baseURI, window.location.origin)) return false;
      log.warn("Not opening an editor link", { scheme: linkScheme(target) });
      return true;
    },
  });
}

function linkScheme(target: string | Uri): string {
  return typeof target === "string" ? (/^\s*([^:]*):/.exec(target)?.[1] ?? "") : target.scheme;
}
