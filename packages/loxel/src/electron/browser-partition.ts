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

/**
 * Whether a browser session is incognito: its data lives in memory only (`storagePath` null), as
 * the incognito sessions' partitions are the browser panels' only ones without `persist:`.
 */
export function isIncognitoSession(browserSession: {
  readonly storagePath: string | null;
}): boolean {
  return browserSession.storagePath === null;
}
