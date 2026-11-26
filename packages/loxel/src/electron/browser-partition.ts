/**
 * Session partition shared by every browser panel `<webview>`. Persistent on
 * purpose: passkeys created in a non-persistent session are orphaned in the
 * keychain after relaunch (electron/electron#52302).
 */
export const BROWSER_PARTITION = "persist:browser";

/**
 * What an incognito browser panel's `<webview>` names as its partition. It is never used as one:
 * main puts such a webview in the current incognito session (`incognito-session.ts`), an in-memory
 * partition that changes once no incognito tab is left.
 */
export const INCOGNITO_PARTITION = "loxel-incognito";

/** The incognito sessions `incognito-session.ts` made this run, ended ones included. */
const incognitoSessions = new WeakSet<object>();

/** Record `browserSession` as an incognito one (`incognito-session.ts`, when it makes one). */
export function markIncognitoSession(browserSession: object): void {
  incognitoSessions.add(browserSession);
}

/**
 * Whether a browser session is incognito: one main made for incognito tabs, not just any in-memory
 * session (electron-updater's is one too).
 */
export function isIncognitoSession(browserSession: object): boolean {
  return incognitoSessions.has(browserSession);
}
