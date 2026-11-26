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
/** Measure the window's background browser pages (see browser-page-lifecycle.ts). */
export const BROWSER_PAGE_USAGE = "browser:page-usage";
/** Freeze one of the window's background browser pages, or resume it. */
export const BROWSER_PAGE_SET_FROZEN = "browser:page-set-frozen";
/**
 * Renderer → main (invoke): a browser page's favicon as a `data:` URL, or null. Args: the favicon's
 * URL, the URL of the page it is shown for (its own origin's favicons load with cookies), for a
 * `blob:` favicon the webContents id of the webview whose page made it, and whether the page is in
 * an incognito tab (it then loads through the incognito session). See `browser-favicons.ts`.
 */
export const BROWSER_FAVICON_LOAD = "browser:favicon-load";
/**
 * Renderer → main: whether this window has incognito browser tabs (a boolean), sent whenever that
 * changes. Once no window has any, main ends the incognito session. See `incognito-session.ts`.
 */
export const BROWSER_INCOGNITO_TABS = "browser:incognito-tabs";
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
/** Main → renderer: a panel's page went fullscreen or locked the pointer (`ExclusiveAccessNotice`). */
export const EXCLUSIVE_ACCESS_SHOW = "exclusive-access:show";
/** Main → renderer: the page of a webview (by webContents ID) left fullscreen; hide its notice. */
export const EXCLUSIVE_ACCESS_HIDE = "exclusive-access:hide";
/**
 * Webview preload → main: the sender frame's `pointerlockchange`, with whether it now holds the
 * pointer lock. See `exclusive-access.ts`.
 */
export const POINTER_LOCK_CHANGE = "exclusive-access:pointer-lock-change";
/** Renderer → main (invoke): whether Loxel is the default web browser (`DefaultBrowserStatus`). */
export const DEFAULT_BROWSER_GET = "default-browser:get";
/** Renderer → main (invoke): ask macOS to make Loxel the default web browser. */
export const DEFAULT_BROWSER_SET = "default-browser:set";
/** Renderer → main: Quit and Keep Terminals, from the command palette. */
export const APP_QUIT_KEEPING_TERMINALS = "app:quit-keeping-terminals";
/** Renderer → main: Restart Loxel, from the command palette. */
export const APP_RESTART = "app:restart";
/**
 * Webview preload → main, synchronous: the page read `Notification.permission`. See
 * `browser-notifications.ts`.
 */
export const BROWSER_NOTIFICATION_PERMISSION = "browser-notification:permission";
/** Webview preload → main (invoke): the page called `Notification.requestPermission()`. */
export const BROWSER_NOTIFICATION_REQUEST_PERMISSION = "browser-notification:request-permission";
/** Webview preload → main: the page constructed a `Notification`. */
export const BROWSER_NOTIFICATION_SHOW = "browser-notification:show";
/** Webview preload → main: the page called `close()` on one of its notifications. */
export const BROWSER_NOTIFICATION_CLOSE = "browser-notification:close";
/** Main → webview preload: fire an event (`click`) on one of the page's notifications. */
export const BROWSER_NOTIFICATION_EVENT = "browser-notification:event";
/** Renderer → main: this document shows its webviews' notifications and permission requests. */
export const BROWSER_NOTIFICATION_LISTEN = "browser-notification:listen";
/** Renderer → main: the per-site decisions from Loxel's settings, on load and on every change. */
export const BROWSER_NOTIFICATION_SET_SITES = "browser-notification:set-sites";
/** Renderer → main: the per-site mutes and snoozes from Loxel's settings, sent before the decisions. */
export const BROWSER_NOTIFICATION_SET_MUTES = "browser-notification:set-mutes";
/** Main → renderer: show a page's notification in the notification center. */
export const BROWSER_NOTIFICATION_OPENED = "browser-notification:opened";
/** Main → renderer: ask whether a site may show notifications, in the panel hosting the page. */
export const BROWSER_NOTIFICATION_PERMISSION_REQUEST = "browser-notification:permission-request";
/** Renderer → main: the user answered a permission request. */
export const BROWSER_NOTIFICATION_PERMISSION_RESPOND = "browser-notification:permission-respond";
/** Main → renderer: a permission request was withdrawn (decided elsewhere, or the page left). */
export const BROWSER_NOTIFICATION_PERMISSION_WITHDRAWN =
  "browser-notification:permission-withdrawn";
/** Renderer → main: the user clicked a page's notification in the notification center. */
export const BROWSER_NOTIFICATION_CLICK = "browser-notification:click";
/**
 * Webview preload → main, synchronous: the page read a camera or microphone permission from
 * `navigator.permissions.query()`. See `browser-media.ts`.
 */
export const BROWSER_MEDIA_PERMISSION = "browser-media:permission";
/** Renderer → main: this document asks the user about its webviews' camera and microphone use. */
export const BROWSER_MEDIA_LISTEN = "browser-media:listen";
/** Renderer → main: the per-site camera and microphone decisions from Loxel's settings. */
export const BROWSER_MEDIA_SET_SITES = "browser-media:set-sites";
/** Main → renderer: ask whether a site may use the camera or microphone, in the page's panel. */
export const BROWSER_MEDIA_PERMISSION_REQUEST = "browser-media:permission-request";
/** Renderer → main: the user answered a camera or microphone request. */
export const BROWSER_MEDIA_PERMISSION_RESPOND = "browser-media:permission-respond";
/** Main → renderer: a camera or microphone request was withdrawn. */
export const BROWSER_MEDIA_PERMISSION_WITHDRAWN = "browser-media:permission-withdrawn";
/** Main → renderer: an allowed site was refused because the OS has Loxel's access turned off. */
export const BROWSER_MEDIA_SYSTEM_BLOCKED = "browser-media:system-blocked";
/** Renderer → main: open the OS privacy settings for the camera or microphone. */
export const BROWSER_MEDIA_OPEN_SYSTEM_SETTINGS = "browser-media:open-system-settings";
/** Renderer → main: this document asks the user about its webviews' site access. */
export const SITE_ACCESS_LISTEN = "site-access:listen";
/** Renderer → main: the per-site decisions for links to other apps and the local network. */
export const SITE_ACCESS_SET_SITES = "site-access:set-sites";
/** Main → renderer: ask whether a site may open another app or reach the local network. */
export const SITE_ACCESS_REQUEST = "site-access:request";
/** Renderer → main: the user answered a site access request. */
export const SITE_ACCESS_RESPOND = "site-access:respond";
/** Main → renderer: a site access request was withdrawn. */
export const SITE_ACCESS_WITHDRAWN = "site-access:withdrawn";
/**
 * Webview or service worker preload → main (invoke): `ServiceWorkerRegistration.showNotification()`.
 * See `service-worker-notifications.ts`.
 */
export const REGISTRATION_NOTIFICATION_SHOW = "registration-notification:show";
/** Webview or service worker preload → main (invoke): `ServiceWorkerRegistration.getNotifications()`. */
export const REGISTRATION_NOTIFICATION_LIST = "registration-notification:list";
/** Webview or service worker preload → main: `close()` on a registration's notification. */
export const REGISTRATION_NOTIFICATION_CLOSE = "registration-notification:close";
/** Main → service worker preload: dispatch `notificationclick` for a notification the user clicked. */
export const REGISTRATION_NOTIFICATION_CLICK = "registration-notification:click";
/** Service worker preload → main: the `notificationclick` handler's `waitUntil` promises settled. */
export const REGISTRATION_NOTIFICATION_CLICK_DONE = "registration-notification:click-done";
/** Service worker preload → main (invoke): `clients.openWindow()`, allowed just after a click. */
export const REGISTRATION_NOTIFICATION_OPEN_WINDOW = "registration-notification:open-window";
/** Renderer → main: Quit and End Terminals, from the command palette. */
export const APP_QUIT_ENDING_TERMINALS = "app:quit-ending-terminals";
/**
 * Renderer → main: the "When quitting Loxel" setting (`WhenQuitting`), which decides what Quit Loxel
 * does and which quit the app menu offers beside it.
 */
export const SET_WHEN_QUITTING = "quit:set-when-quitting";
/** Main → renderer: ask before quitting (`QuitQuestion`), terminals being busy. */
export const QUIT_QUESTION = "quit:question";
/**
 * Main → renderer: main no longer waits on the question with this ID (it asked natively instead, or
 * the quit was decided another way); take it down.
 */
export const QUIT_QUESTION_WITHDRAWN = "quit:question-withdrawn";
/** Renderer → main: the question with this ID is on screen. */
export const QUIT_QUESTION_SHOWN = "quit:question-shown";
/** Renderer → main: the user answered a question (`QuitReply`). */
export const QUIT_ANSWER = "quit:answer";
