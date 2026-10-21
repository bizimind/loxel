/** Shared IPC channel names between main process and preload. */
export const OPEN_IN_BROWSER_TAB = "open-in-browser-tab";
export const SET_DOCK_BADGE = "set-dock-badge";
export const WINDOW_FOCUS_CHANGE = "window:focus-change";
/** Main → renderer: the window entered (`true`) or left (`false`) macOS native fullscreen. */
export const WINDOW_FULL_SCREEN_CHANGE = "window:full-screen-change";
/** Renderer → main (sync): whether the sender's window is fullscreen right now. */
export const GET_WINDOW_FULL_SCREEN = "window:get-full-screen";
export const OPEN_FOLDER_DIALOG = "dialog:open-folder";
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
 * Webview preload → main, synchronous: a page called `alert()` / `confirm()` / `prompt()`. The
 * page stays blocked until main sets the return value. See `javascript-dialogs.ts`.
 */
export const JAVASCRIPT_DIALOG_RUN = "javascript-dialog:run";
/**
 * Renderer → main: this document shows page dialogs. Pages of a window whose renderer never sent
 * it (one that predates dialogs) get no dialog instead of blocking on one that is never shown.
 */
export const JAVASCRIPT_DIALOG_LISTEN = "javascript-dialog:listen";
/** Main → renderer: show a page's dialog in the browser panel hosting that webview. */
export const JAVASCRIPT_DIALOG_OPEN = "javascript-dialog:open";
/** Renderer → main: the user answered a dialog. */
export const JAVASCRIPT_DIALOG_RESPOND = "javascript-dialog:respond";
/** Main → renderer: a dialog was withdrawn because its page navigated or went away. */
export const JAVASCRIPT_DIALOG_CLOSED = "javascript-dialog:closed";
