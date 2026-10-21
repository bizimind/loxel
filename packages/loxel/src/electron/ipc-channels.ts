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
 * Renderer → main: copy the image at a point of one of its webviews to the clipboard (the browser
 * panel's context menu). `<webview>` has no `copyImageAt`; only its webContents does.
 */
export const COPY_WEBVIEW_IMAGE = "browser:copy-image-at";
