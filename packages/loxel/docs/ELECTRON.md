# Desktop app (Electron)

How the Electron shell fits around the Bun server and React renderer, and the constraints that come from how the app is shipped and updated. Entry point: `src/electron/main.ts`.

## Process model

- **One shared server per mode.** On launch, Electron reuses a Loxel server already listening on the mode's port (7433 prod, 7434 dev) and otherwise spawns one: the compiled `loxel-server` binary in production, `bun run src/server/index.ts` with `LOXEL_DEV=1` in dev. Every window connects to that server, identifies itself with its window ID, and talks to it over REST and WebSocket. The server shuts itself down after an idle period with no connected clients. Discovery, ownership, idle shutdown and state scopes are detailed in [SHARED_SERVER.md](SHARED_SERVER.md).
- **Windows load the server's URL** (`http://127.0.0.1:<port>`), or the Vite dev server's URL under `pnpm run dev:app` (Vite proxies `/api` and `/ws` to the dev server).
- **Electron IPC is only for native integrations** (dock badge, folder dialog, window focus, opening links in a browser panel, keystrokes inside webviews). Channel names live in `src/electron/ipc-channels.ts`, and the renderer-facing API (`window.electronAPI`) is typed in `src/electron-api.d.ts`. Everything else goes through the server.

## What ships where

The `.app` bundle contains the Electron main process, the preload, `Info.plist` (including the file types from `electron-builder.yml`) and the code-signing entitlements. In-app updates replace only the server binary and the renderer: they are installed under `~/.local/share/loxel/loxel/` and used when newer than the bundled copies, with the renderer served from `LOXEL_STATIC_DIR`.

Consequences:

- A change to the main process, preload, file type declarations or entitlements reaches users only with a new app download.
- A renderer can run against an older preload, so `window.electronAPI` members added after the first release are optional and must be called with `?.()` (see the comment in `src/electron-api.d.ts`).

## Browser panels

Browser panels host a `<webview>` per tab.

- **No reloads.** Re-attaching a `<webview>` to the DOM reloads its page, so browser panels are created with dockview's `renderer: "always"` and activation of an already-active tab goes through `activatePanel()` (`src/store/layout-actions.ts`). Switching worktrees still rebuilds the layout and reloads them.
- **Shortcuts** keep working while a page has focus through keystroke forwarding from the main process; see [KEYBINDINGS.md](KEYBINDINGS.md#shortcuts-inside-browser-panels).
- **Passkeys** use the macOS Touch ID platform authenticator (`src/electron/webauthn.ts`). This needs a restricted entitlement that only provisioned Developer ID builds carry, so dev runs and unprovisioned local builds have no passkeys; see [RELEASE_SIGNING.md](RELEASE_SIGNING.md).

## macOS integration

- **Open from Finder.** `electron-builder.yml` declares Loxel an _Alternate_ handler for text and source files, `.excalidraw` and folders. The main process receives these as `open-file` events and posts each to `POST /api/open`, the same request the `loxel <path>` CLI sends (`src/open-request.ts`).
- **Reveal in Finder / Open In.** App lists and icons come from LaunchServices through `bun:ffi`, which runs in a helper process (the server executable started with a helper flag, see `src/server/launch-services-client.ts`) so a native crash only kills the helper.

## Build and release

`pnpm run build:app` compiles the standalone server, builds the renderer and packages the app with electron-builder into `release/` (`build:app:local` builds an unpacked arm64 app only). `release-loxel.yml` releases on every merge to main that touches `packages/loxel/**`; see the [README](../README.md#releases).
