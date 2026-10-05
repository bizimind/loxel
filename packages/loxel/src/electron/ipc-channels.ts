/** Shared IPC channel names between main process and preload. */
export const OPEN_IN_BROWSER_TAB = "open-in-browser-tab";
export const SET_DOCK_BADGE = "set-dock-badge";
export const WINDOW_FOCUS_CHANGE = "window:focus-change";
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
