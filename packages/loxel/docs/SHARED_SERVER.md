# Shared server and multiple windows

How every Loxel window shares one Bun server process, how that server is started, owned and shut down, and why this design was chosen over one server per window.

## Model

One server runs per mode, on a well-known port: `7433` in production and `7434` in dev (`src/server/config.ts`; `LOXEL_SERVE_PORT` overrides it for a standalone server, but Electron and the `loxel` CLI always use the well-known ports). Dev and production also use separate state directories (`~/.local/state/loxel/loxel-dev` and `.../loxel`), so they never share a server or its state. Every window, whether opened from the same Electron process ("New Window" in the Dock menu) or from another Electron process, connects to that one server over WebSocket and REST.

Running one server instead of one per window removes a whole class of cross-process problems for every feature that touches the filesystem or persistent state:

- **Git** — all Git commands run in one process, so windows never contend for `index.lock`.
- **Watchers** — one set of watchers and one `git status` per event, whatever the window count (see [WATCHERS.md](WATCHERS.md)).
- **Write nonces** — all clients share one nonce store, so the window that saved a file suppresses its own echo while every other window viewing the file receives `file_content_changed` as an external change.
- **Caches** — directory caches and Git status snapshots are shared rather than duplicated.
- **Updates** — one server checks for and downloads updates.

## Electron: discover or spawn

`ensureServer()` in `src/electron/main.ts` runs on app start:

1. Probe `GET /api/version` on the well-known port. If a server answers, connect to it.
2. Otherwise apply any pending update left behind by a previous server (see below), spawn the server (`bun run src/server/index.ts` in dev, the bundled or newer external `loxel-server` binary in production) and wait for it to answer.

The Electron process that spawned the server is its **owner**. When two Electron processes start at once and both spawn, the loser's server exits with `EADDRINUSE`; its Electron process sees the non-zero exit while the port is already being served, drops ownership, and uses the winner's server.

Only the owner holds the server's child-process handle, so only the owner reacts to its exit. In production, exit code `42` means an update is ready: the owner installs it and relaunches. Any other non-zero exit with nobody serving the port is a crash: the owner respawns the server with linear backoff (1s, 2s, 3s), with a single restart in flight at a time, and after three crashes in quick succession it drops ownership and falls back to polling; a server that stayed up for a minute gets a fresh retry budget. Dropping ownership for any reason cancels a pending restart. If the owner has already quit, the update stays in `updates/pending.json` and is applied by whichever Electron process spawns the next server. A process that does not own the server, whether from launch or after losing ownership, polls the server every 5 seconds; when it is gone it runs `ensureServer()` again and reloads its windows.

## Server lifecycle

Electron never kills the server on quit (`before-quit` does nothing), because other windows may still be connected. The server shuts itself down instead (`src/server/server.ts`):

- When the last app client disconnects, it shuts down after 30 seconds unless a client reconnects first.
- If detached terminal or agent sessions are still alive at that point, it waits 5 minutes instead, so clients can reattach (for example after the machine wakes from sleep), then destroys the orphaned terminals and shuts down.

The renderer's WebSocket client reconnects on its own, so windows survive a server restart. On reconnect it compares the server version with the one it first saw and reloads the page when it changed.

## State scopes

The server keeps state at these scopes (`src/server/server-state.ts`):

| Scope                       | Lifetime                             | Shared across windows?                                                                                                                             |
| --------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ProjectState`              | per registered repo, server lifetime | Yes — one watcher, review database and worktree status list per repo                                                                               |
| `WorktreeResources`         | first subscriber to last             | Yes — file services and undo/redo history are shared by every window on the worktree                                                               |
| `ClientState`               | per app WebSocket connection         | No — its terminals, subscriptions and window ID belong to that connection                                                                          |
| Terminal and agent sessions | create to destroy                    | No — output goes to the owning connection; sessions detach on disconnect and can be reattached                                                     |
| Language-server sessions    | per language-server WebSocket        | Partly — worktree-scoped managers keep one process per worktree path (see [LANGUAGE_SERVERS.md](LANGUAGE_SERVERS.md)); only YAML is per connection |

Undo/redo is per worktree, so two windows on the same worktree share one history; that matches the single filesystem they both edit.

## Persistent state

Only the server opens the SQLite databases (WAL mode, 5-second busy timeout); what lives in the state directory is listed in [STATE_AND_STORAGE.md](STATE_AND_STORAGE.md#server-state-directory). Server logs are written per process to `logs/server-{instanceId}.log`, and log files of other instances are cleaned up after 24 hours, so overlapping processes (for example a server shutting down while its replacement starts) never write the same file.

Internal temporary worktrees (used for diagnostics of past commits) are named with `INTERNAL_WORKTREE_PREFIX`, hidden from worktree lists, and pruned when a project is initialized, so ones left behind by a crash do not accumulate. Pruning must not remove a temp worktree that another server using the same repository (for example the dev and production servers) is still using.
