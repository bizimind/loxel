/** Shared IPC channel names between main process and preload. */
export const OPEN_IN_BROWSER_TAB = "open-in-browser-tab";
/**
 * Main → renderer: a page in one of its webviews asked to open a link in a new tab or window.
 * Args: the webview's webContents id, the URL, and whether to open it in the background.
 */
export const OPEN_IN_NEW_BROWSER_TAB = "browser:open-in-new-tab";
export const SET_DOCK_BADGE = "set-dock-badge";
export const WINDOW_FOCUS_CHANGE = "window:focus-change";
/** Main → renderer: the window entered (`true`) or left (`false`) macOS native fullscreen. */
export const WINDOW_FULL_SCREEN_CHANGE = "window:full-screen-change";
/** Renderer → main (sync): whether the sender's window is fullscreen right now. */
export const GET_WINDOW_FULL_SCREEN = "window:get-full-screen";
/**
 * Renderer → main: the Theme setting (`ThemePreference`), applied as `nativeTheme.themeSource` so
 * native UI and browser panels follow it.
 */
export const SET_THEME_SOURCE = "theme:set-source";
/**
 * Renderer → main: which keystrokes to intercept in its webviews — the first keystrokes of its
 * bindings, or all of them while a chord is in progress.
 */
export const SET_KEYSTROKE_INTERCEPTION = "keybindings:set-interception";
/** Main → renderer: a bound keystroke typed inside one of its webviews. */
export const WEBVIEW_KEYSTROKE = "keybindings:webview-keystroke";
/**
 * Main → renderer: one of its webviews gained keyboard focus. The host document gets no focusin
 * for that, so this is the renderer's cue to recompute which keystrokes to intercept.
 */
export const WEBVIEW_FOCUSED = "keybindings:webview-focused";
/**
 * Renderer → main: copy the image at a point of one of its webviews to the clipboard (the browser
 * panel's context menu). `<webview>` has no `copyImageAt`; only its webContents does.
 */
export const COPY_WEBVIEW_IMAGE = "browser:copy-image-at";
/**
 * Webview preload → main, synchronous: a page called `alert()` / `confirm()` / `prompt()`. The
 * page stays blocked until main sets the return value. See `javascript-dialogs.ts`.
 */
export const JAVASCRIPT_DIALOG_RUN = "javascript-dialog:run";
/**
 * Renderer → main: this document shows page dialogs. Pages of a window whose current document has
 * not sent it get no dialog instead of blocking on one that is never shown.
 */
export const JAVASCRIPT_DIALOG_LISTEN = "javascript-dialog:listen";
/** Main → renderer: show a page's dialog in the browser panel hosting that webview. */
export const JAVASCRIPT_DIALOG_OPEN = "javascript-dialog:open";
/** Renderer → main: the user answered a dialog. */
export const JAVASCRIPT_DIALOG_RESPOND = "javascript-dialog:respond";
/** Main → renderer: a dialog was withdrawn because its page navigated or went away. */
export const JAVASCRIPT_DIALOG_CLOSED = "javascript-dialog:closed";
/** Renderer → main (invoke): the app update's current `UpdateState`. */
export const UPDATE_GET_STATUS = "update:get-status";
/** Renderer → main (invoke): check the release manifest for a newer version. */
export const UPDATE_CHECK = "update:check";
/** Renderer → main (invoke): download the available update. */
export const UPDATE_DOWNLOAD = "update:download";
/** Renderer → main: quit, install the downloaded update and relaunch. */
export const UPDATE_INSTALL = "update:install";
/** Main → renderer: the app update's `UpdateState` changed. */
export const UPDATE_STATUS_CHANGED = "update:status-changed";
/** Main → renderer: show a passkey QR code (`PasskeyQrCode`) in one of its browser panels. */
export const PASSKEY_QR_SHOW = "passkey:qr-show";
/** Main → renderer: the passkey request of a webview (by webContents ID) ended; hide its QR code. */
export const PASSKEY_QR_HIDE = "passkey:qr-hide";
/** Renderer → main (invoke): whether Loxel is the default web browser (`DefaultBrowserStatus`). */
export const DEFAULT_BROWSER_GET = "default-browser:get";
/** Renderer → main (invoke): ask macOS to make Loxel the default web browser. */
export const DEFAULT_BROWSER_SET = "default-browser:set";
/** Renderer → main: Quit and Keep Terminals, from the command palette. */
export const APP_QUIT_KEEPING_TERMINALS = "app:quit-keeping-terminals";
/** Renderer → main: Restart Loxel, from the command palette. */
export const APP_RESTART = "app:restart";
