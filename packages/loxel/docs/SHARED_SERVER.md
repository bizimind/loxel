# Shared server and multiple windows

How every Loxel window shares one Bun server process, how the app starts, restarts and stops that server, and why this design was chosen over one server per window.

## Model

One server runs per mode, on a well-known port: `7433` in production and `7434` in dev (`src/server/config.ts`; `LOXEL_SERVE_PORT` overrides it for a standalone server, but Electron and the `loxel` CLI always use the well-known ports). Dev and production also use separate state directories (`~/.local/state/loxel/loxel-dev` and `.../loxel`), so they never share a server or its state. The app is a single Electron process, and every window it opens ("New Window" in the File and Dock menus, or a native window tab) connects to that one server over WebSocket and REST.

Running one server instead of one per window removes a whole class of cross-process problems for every feature that touches the filesystem or persistent state:

- **Git** — all Git commands run in one process, so windows never contend for `index.lock`.
- **Watchers** — one set of watchers and one `git status` per event, whatever the window count (see [WATCHERS.md](WATCHERS.md)).
- **Write nonces** — all clients share one nonce store, so the window that saved a file suppresses its own echo while every other window viewing the file receives `file_content_changed` as an external change.
- **Caches** — directory caches and Git status snapshots are shared rather than duplicated.

## One app process

`src/electron/main.ts` takes Electron's single-instance lock. A second launch of the same app, such as `open -n` or the binary run directly, focuses a window of the running one and exits. So exactly one Electron process owns the server, and no other process runs from the bundle when a full-app update replaces it (see [ELECTRON.md](ELECTRON.md#updates)). Dev and production builds have different app names and data directories, so each holds its own lock. Dev builds have the same name in every worktree, so one dev app runs at a time: `pnpm run dev:app` in a second worktree focuses the first worktree's dev app and exits.

## Starting and restarting the server

`startAppServer()` in `src/electron/main.ts` runs on app start, before the first window opens. It spawns the server and waits until `GET /api/version` answers. In dev that is `bun run src/server/index.ts` with `LOXEL_DEV=1`. In production it is the bundled `loxel-server` binary, with `LOXEL_STATIC_DIR` set to the bundled renderer.

- **A server already on the port.** `GET /api/version` reports `appOwned` for a server an app started. Such a server is one a previous run of the app left shutting down, including, in dev, the one an Electron restarted on a main-process rebuild leaves behind. Launch waits up to 15 seconds for it to go, then fails with a startup error naming the port. Any other server was not started by an app. In dev, it is a dev server started by hand (`pnpm run dev:server`), and the app uses it without restarting or stopping it. When it later shuts down (a hand-started server does when idle), the next window the app opens starts the app's own server. In production, it is one from an earlier version, which can stay up for 5 minutes after its last window closed, or one started by hand, so launch fails at once with an error saying so.
- **One start at a time.** Startup, reopening from the Dock and New Window all join the start already in flight (`startAppServer()`), so the app never spawns two servers. New Window requests that arrive before startup has opened the first window are ignored, as are second launches.
- **Crashes.** Any exit the app did not ask for counts as a crash. The app restarts the server with linear backoff (1s, 2s, 3s), with a single restart in flight at a time. A server that stayed up for a minute gets a fresh retry budget. After three crashes in quick succession, the app reports the failure and quits.

## Server lifecycle

The server lives as long as the app:

- **Quit.** On `will-quit`, after every window has closed, the app sends the server SIGTERM, and the server finishes shutting down on its own. A window's last layout promote that has not reached the server by then is recovered when the next server starts (see [STATE_AND_STORAGE.md](STATE_AND_STORAGE.md)).
- **An app that crashed or was killed.** The app passes its process ID in `LOXEL_PARENT_PID`. The server checks every 2 seconds that it is still that process's child, and shuts down once it has been reparented, which a reused process ID cannot fake (`src/server/server.ts`). It removes the variable from its environment at startup (`src/server/config.ts`), so a server started from a Loxel terminal does not take the app for its parent.
- **No windows.** macOS keeps the app running with every window closed. When the last app client disconnects, detached terminal sessions get 5 minutes to be reattached, for example by a window opening again or the machine waking from sleep. Then they are destroyed. The server itself keeps running.

A server started without `LOXEL_PARENT_PID`, such as `pnpm run dev` in a browser or a test server, shuts itself down instead. That happens 30 seconds after the last app client disconnects, or at the end of the 5-minute grace period when detached sessions are alive.

The renderer's WebSocket client reconnects on its own, so windows survive a server restart. On reconnect it compares the server version with the one it first saw and reloads the page when it changed.

## State scopes

The server keeps state at these scopes (`src/server/server-state.ts`):

| Scope                    | Lifetime                             | Shared across windows?                                                                                                                             |
| ------------------------ | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ProjectState`           | per registered repo, server lifetime | Yes — one watcher, review database and worktree status list per repo                                                                               |
| `WorktreeResources`      | first subscriber to last             | Yes — file services and undo/redo history are shared by every window on the worktree                                                               |
| `ClientState`            | per app WebSocket connection         | No — its terminals, subscriptions and window ID belong to that connection                                                                          |
| Terminal sessions        | create to destroy                    | No — output goes to the owning connection; sessions detach on disconnect and can be reattached                                                     |
| Language-server sessions | per language-server WebSocket        | Partly — worktree-scoped managers keep one process per worktree path (see [LANGUAGE_SERVERS.md](LANGUAGE_SERVERS.md)); only YAML is per connection |

Undo/redo is per worktree, so two windows on the same worktree share one history; that matches the single filesystem they both edit.

## Persistent state

Only the server opens the SQLite databases (WAL mode, 5-second busy timeout); what lives in the state directory is listed in [STATE_AND_STORAGE.md](STATE_AND_STORAGE.md#server-state-directory). Server logs are written per process to `logs/server-{instanceId}.log`, and log files of other instances are cleaned up after 24 hours, so overlapping processes (for example a server shutting down while its replacement starts) never write the same file.

Internal temporary worktrees (used for diagnostics of past commits) are named with `INTERNAL_WORKTREE_PREFIX`, hidden from worktree lists, and pruned when a project is initialized, so ones left behind by a crash do not accumulate. Pruning must not remove a temp worktree that another server using the same repository (for example the dev and production servers) is still using.
