# Desktop app (Electron)

How the Electron shell fits around the Bun server and React renderer, and the constraints that come from how the app is shipped and updated. Entry point: `src/electron/main.ts`.

## Process model

- **One shared server per mode.** On launch, Electron reuses a Loxel server already listening on the mode's port (7433 prod, 7434 dev) and otherwise spawns one: the compiled `loxel-server` binary in production, `bun run src/server/index.ts` with `LOXEL_DEV=1` in dev. Every window connects to that server, identifies itself with its window ID, and talks to it over REST and WebSocket. The server shuts itself down after an idle period with no connected clients. Discovery, ownership, idle shutdown and state scopes are detailed in [SHARED_SERVER.md](SHARED_SERVER.md).
- **Windows load the server's URL** (`http://127.0.0.1:<port>`), or the Vite dev server's URL under `pnpm run dev:app` (Vite proxies `/api` and `/ws` to the dev server).
- **Electron IPC is only for native integrations** (dock badge, folder dialog, window focus and fullscreen state, opening links in a browser panel, keystrokes inside webviews, copying images from webviews, page dialogs in webviews). Channel names live in `src/electron/ipc-channels.ts`, and the renderer-facing API (`window.electronAPI`) is typed in `src/electron-api.d.ts`. Everything else goes through the server.

## What ships where

The `.app` bundle contains the Electron main process, the window and webview preloads, `Info.plist` (including the file types from `electron-builder.yml`) and the code-signing entitlements. In-app updates replace only the server binary and the renderer: they are installed under `~/.local/share/loxel/loxel/` and used when newer than the bundled copies, with the renderer served from `LOXEL_STATIC_DIR`.

Consequences:

- A change to the main process, the preloads, file type declarations or entitlements reaches users only with a new app download.
- A renderer can run against an older window preload, and a local main process against an older installed renderer. So `window.electronAPI` members added after the first release are optional and must be called with `?.()` (see the comment in `src/electron-api.d.ts`), and main must not wait on a renderer for something it never subscribed to.

## Browser panels

Browser panels host a `<webview>` per tab. `will-attach-webview` in `src/electron/main.ts` strips any preload and Node.js settings a webview asks for, then gives it Loxel's own sandboxed `src/electron/webview-preload.cjs`, which runs in every frame.

- **No reloads.** Re-attaching a `<webview>` to the DOM reloads its page, so browser panels are created with dockview's `renderer: "always"` and activation of an already-active tab goes through `activatePanel()` (`src/store/layout-actions.ts`). Switching worktrees still rebuilds the layout and reloads them.
- **New tabs.** Webviews carry `allowpopups`, so the page's new-tab and new-window requests (⌘-click, middle-click, `target="_blank"`, `window.open`) reach the main process, which never creates a window: `src/electron/webview-new-tabs.ts` drops non-`http(s)` URLs and acts as a popup blocker, letting each click or key press in the page (within 5 seconds) open one tab, and sends the rest to the host renderer with the webview's webContents id and whether the disposition was a background tab. The `BrowserPanel` that owns that webview opens the tab with `openBrowserTab` (`src/lib/panel-creators.ts`), the same placement the context menu's Open in New Tab uses. The renderer sets `allowpopups` only when the preload has `onOpenInNewBrowserTab`, since an older main process would send these links to the system browser.
- **Context menu.** The renderer draws the page's right-click menu with the app's own `ContextMenu` from the webview's `context-menu` event (`src/components/browser/BrowserContextMenu.tsx`). The event's `x`/`y` are window coordinates in device-independent pixels, not relative to the webview, so the menu is placed at them divided by the app zoom factor; `copyImageAt` and `inspectElement` take them unchanged. `<webview>` has no `copyImageAt`, so Copy Image asks the main process to call it on the webview's webContents (`src/electron/webview-copy-image.ts`), which only accepts webviews the sending window hosts.
- **Shortcuts** keep working while a page has focus through keystroke forwarding from the main process; see [KEYBINDINGS.md](KEYBINDINGS.md#shortcuts-inside-browser-panels).
- **Page dialogs** (`alert()`, `confirm()`, `prompt()`) are shown by the hosting panel, not by Electron. Electron throws on `prompt()` and shows the other two as native sheets over the whole window. The webview preload replaces the page's dialog functions with a synchronous IPC call (`JAVASCRIPT_DIALOG_RUN`), so the page blocks as with a real dialog. `src/electron/javascript-dialogs.ts` forwards the call to the host renderer and sets the IPC's return value when the panel answers. Only that page's renderer process waits, while the window stays responsive. The message shapes live in `src/electron/javascript-dialog-protocol.ts`, and the renderer side is `src/components/browser/useJavaScriptDialogs.ts`.
  - **Readiness.** Main forwards dialogs only to window renderers that subscribed (`JAVASCRIPT_DIALOG_LISTEN`, sent by the window preload's `onJavaScriptDialog`). A subscription lasts until the window's document is replaced: a committed navigation, not one the window starts and cancels, such as an external link opened in the system browser. Pages of windows without one get the dismissed result instead of blocking on a dialog nobody shows.
  - **Policy.** Main owns the browser-like policy. From a page's second dialog on, the user can block further dialogs until the page navigates, and blocking also dismisses the page's queued dialogs. Once the main frame starts a cross-document navigation, the page's pending dialogs are withdrawn and the outgoing document gets no new ones. Dialogs from frames that are gone when the new document commits are dismissed too.
  - **Toolbar navigation.** A browser-initiated navigation waits for the blocked page (its `beforeunload` round trip), so the panel dismisses its queued dialogs before navigating from the toolbar.
  - **Preload rules.** The preload ignores dialogs during `beforeunload` and `pagehide`. `disableDialogs` is set as a backstop, so frames the preload can't reach (`about:blank` iframes) get no dialog rather than a window-wide sheet.
- **Passkeys** use the macOS Touch ID platform authenticator (`src/electron/webauthn.ts`). This needs a restricted entitlement that only provisioned Developer ID builds carry, so dev runs and unprovisioned local builds have no passkeys; see [RELEASE_SIGNING.md](RELEASE_SIGNING.md).

## macOS integration

- **Open from Finder.** `electron-builder.yml` declares Loxel an _Alternate_ handler for text and source files, `.excalidraw` and folders. The main process receives these as `open-file` events and posts each to `POST /api/open`, the same request the `loxel <path>` CLI sends (`src/open-request.ts`).
- **Reveal in Finder / Open In.** App lists and icons come from LaunchServices through `bun:ffi`, which runs in a helper process (the server executable started with a helper flag, see `src/server/launch-services-client.ts`) so a native crash only kills the helper.

## Build and release

`pnpm run build:app` compiles the standalone server, builds the renderer and packages the app with electron-builder into `release/`, on macOS for this machine's architecture (`build:app:local` builds an unpacked arm64 app only). `release-loxel.yml` releases on every merge to main that touches `packages/loxel/**`; see the [README](../README.md#releases).

The server, language server scripts and Go builds all produce binaries for the machine they run on, so each macOS architecture builds on a runner of that architecture. [check-binary-arch.ts](../scripts/check-binary-arch.ts) reads the header of every file in the app and the update archive and fails the release if a binary doesn't match.
