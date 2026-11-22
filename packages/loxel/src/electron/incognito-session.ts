/**
 * The session incognito browser tabs share, as Chrome's incognito windows share one: in memory
 * only, so nothing a page stores (cookies, storage, cache) reaches the disk, and it ends once no
 * incognito tab is left in any window. The next incognito tab then starts a new, empty session.
 *
 * A webview asks for it by naming `INCOGNITO_PARTITION` (`webview-attach.ts`), and main gives it
 * the current session's partition (`incognito-<n>`, never `persist:`). Each new session gets the
 * same setup as the browser partition (`main.ts`), plus `incognito-preload.cjs` in its frames.
 * Windows report whether they hold incognito tabs (`BROWSER_INCOGNITO_TABS`), counting tabs whose
 * page is unloaded to the background budget: the session lives as long as the tabs, not their
 * pages. A window's report lasts until its document is replaced, since a reload drops its tabs.
 */
import path from "node:path";

import { BrowserWindow, type Session, session, webContents } from "electron";

import { onAppWindowMessage } from "./app-windows";
import { BROWSER_INCOGNITO_TABS } from "./ipc-channels";

let current: { partition: string; session: Session } | null = null;
let sessionCount = 0;
let setUpSession: (browserSession: Session) => void = () => {};
/**
 * The windows (by webContents id) whose current document has incognito tabs, with what stops
 * following that document.
 */
const windowsWithTabs = new Map<number, () => void>();

/** The current incognito session, or null while there is none. */
export function currentIncognitoSession(): Session | null {
  return current?.session ?? null;
}

/** The partition an incognito webview attaching now gets: the current session's, or a new one. */
export function incognitoPartition(): string {
  if (current) return current.partition;
  const partition = `incognito-${++sessionCount}`;
  const created = session.fromPartition(partition);
  created.registerPreloadScript({
    type: "frame",
    filePath: path.join(import.meta.dirname, "incognito-preload.cjs"),
  });
  setUpSession(created);
  current = { partition, session: created };
  return partition;
}

/**
 * End the current session: close the popups still using it and empty it, so its memory goes. What
 * main keeps per session (permission answers, certificate choices) is keyed by the session, so a
 * later one starts without it.
 */
function endSession(): void {
  const ended = current?.session;
  if (!ended) return;
  current = null;
  for (const contents of webContents.getAllWebContents()) {
    if (contents.getType() !== "window" || contents.session !== ended) continue;
    BrowserWindow.fromWebContents(contents)?.close();
  }
  void Promise.allSettled([
    ended.clearStorageData(),
    ended.clearCache(),
    ended.clearAuthCache(),
    ended.closeAllConnections(),
  ]).then((results) => {
    for (const result of results) {
      if (result.status === "rejected") {
        console.error("[incognito] Could not empty an ended session", result.reason);
      }
    }
  });
}

function forgetWindow(id: number): void {
  const unfollow = windowsWithTabs.get(id);
  if (!unfollow) return;
  unfollow();
  windowsWithTabs.delete(id);
  if (windowsWithTabs.size === 0) endSession();
}

/**
 * Set up incognito sessions with `setUp` (what every browser session gets), and follow the
 * windows' incognito tabs.
 */
export function installIncognitoSessions(setUp: (browserSession: Session) => void): void {
  setUpSession = setUp;
  onAppWindowMessage(BROWSER_INCOGNITO_TABS, (event, hasTabs: unknown) => {
    const host = event.sender;
    if (hasTabs !== true) {
      forgetWindow(host.id);
      return;
    }
    if (windowsWithTabs.has(host.id)) return;
    // On commit, as for the other per-document subscriptions (`listening-renderers.ts`): a reload
    // or a new document drops the window's tabs.
    const forget = () => forgetWindow(host.id);
    host.on("did-navigate", forget);
    host.once("destroyed", forget);
    windowsWithTabs.set(host.id, () => {
      host.off("did-navigate", forget);
      host.off("destroyed", forget);
    });
  });
}
