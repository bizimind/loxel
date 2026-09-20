/**
 * Session partition shared by every browser panel `<webview>`. Persistent on
 * purpose: passkeys created in a non-persistent session are orphaned in the
 * keychain after relaunch (electron/electron#52302).
 */
export const BROWSER_PARTITION = "persist:browser";
