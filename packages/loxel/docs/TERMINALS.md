# Terminals

How terminal panels work end to end: PTY sessions in the server, the binary WebSocket protocol, the xterm.js client, terminal notifications, and the `loxel` CLI that runs inside terminals.

## Overview

A terminal panel is an xterm.js instance in the renderer bound to a PTY session in the shared Bun server (see [SHARED_SERVER.md](SHARED_SERVER.md)) by a client-generated UUID, the `terminalId`. The renderer creates the UUID once ([panel-creators.ts](../src/lib/panel-creators.ts) `createTerminal`), stores it in the Dockview panel params together with the worktree path, and the persisted layout keeps it across reloads. The PTY lives as long as the server or until the panel is closed; the xterm.js instance lives only while the panel is mounted. Everything below follows from that split.

## Server: PTY sessions

[pty-manager.ts](../src/server/pty-manager.ts) owns a `Map<terminalId, PtySession>`. Each session holds the `Bun.spawn` subprocess (Bun's built-in `terminal` option provides the PTY), the current size, a scrollback buffer and two mutable callbacks, `onOutput` and `onExit`.

- **Spawn.** `create()` runs `$SHELL -il` (falling back to `/bin/bash`) as an interactive login shell in the requested `cwd`. Nothing else is wrapped around the shell.
- **Idempotent create = reattach.** If a session with that ID already exists, `create()` swaps in the new callbacks and replays the scrollback through `onOutput` synchronously. `cwd` and env apply only at spawn.
- **Scrollback.** Output chunks are appended to an array and the oldest chunks are evicted once the byte total exceeds `maxScrollback`. The cap is derived from the client's scrollback setting: lines are clamped to 1,000–100,000 (default `DEFAULT_SCROLLBACK_LINES` = 50,000 in [ws-protocol.ts](../src/api/ws-protocol.ts)) and multiplied by an estimated 100 bytes per line. Eviction is per chunk.
- **Detach.** `detach()` nulls both callbacks. Output keeps being produced and buffered; it is just not delivered. `hasOrphanSessions()` and `destroyOrphans()` treat "no `onOutput`" as orphaned.
- **Destroy.** `destroy()` closes the PTY and kills the process. A natural exit removes the session and fires `onExit`.
- **Input.** `writeBinary()` decodes the frame payload with `TextDecoder` because Bun's `terminal.write` takes a string.

Every output chunk is counted by the stress detector under `pty-output` ([stress-detector.ts](../src/server/stress-detector.ts)); it only logs, it never throttles.

### Ownership and lifetime in server.ts

[server.ts](../src/server/server.ts) maps each terminal to exactly one owning WebSocket (`terminalOwners`) and records the IDs in that connection's `ClientState.terminals`.

- `terminal_create` registers ownership **before** calling `ptyManager.create()`, because a reattach replays scrollback synchronously through the callback, which looks up the owner. Any connection that sends `terminal_create` for an existing ID becomes its owner.
- `terminal_resize`, `terminal_destroy` and binary input are ignored unless they come from the current owner.
- On socket close, `detachClientTerminals()` detaches (never destroys) that connection's sessions.
- When the last app client disconnects and orphaned terminal or agent sessions exist, the server waits 5 minutes (`ORPHAN_CLEANUP_MS`) instead of 30 seconds, then destroys orphans and shuts down. Any client connecting cancels the timer. See [SHARED_SERVER.md](SHARED_SERVER.md) for the idle-shutdown rules.
- `shutdown()` calls `ptyManager.destroyAll()`, so no shell outlives the server.

### Environment

`buildTerminalEnv()` starts from `buildSpawnEnv()` in [shell-env.ts](../src/server/shell-env.ts) and sets `TERM=xterm-256color` if unset. `buildSpawnEnv()` copies the server's `process.env`, replaces `PATH` with the login-shell `PATH` captured once at startup by `resolveLoginShellEnv()` (a `$SHELL -ilc` run bracketed by sentinels so greeting output is ignored), prepends `~/.local/bin` if missing, and guarantees `HOME`. The login-shell `PATH` matters because an app launched from Finder or the Dock inherits launchd's minimal environment.

`server.ts` then adds per-terminal overrides:

| Variable          | Value                                     | Why                                                                               |
| ----------------- | ----------------------------------------- | --------------------------------------------------------------------------------- |
| `LOXEL`           | `1`                                       | Lets the CLI (and user scripts) detect they run inside a Loxel terminal           |
| `LOXEL_PORT`      | `config.port`                             | The CLI talks to the exact server that owns the terminal (dev and prod differ)    |
| `LOXEL_WORKTREE`  | the panel's worktree path (`msg.cwd`)     | CLI fallback for URL requests when the shell's cwd is not inside a git repository |
| `LOXEL_WINDOW_ID` | the creating window's `WINDOW_ID`, if any | Routes `loxel <file>` back to the window the terminal belongs to                  |

These are fixed at spawn. A session reattached by another window keeps the original `LOXEL_WINDOW_ID`.

## WebSocket protocol

Terminal messages are part of the main app socket (`/ws`). Types live in [ws-protocol.ts](../src/api/ws-protocol.ts); note that [ws-messages.ts](../src/server/ws-messages.ts) only builds the `worktrees_changed` message and has nothing terminal-specific.

- **JSON control frames (client to server):** `terminal_create { id, cols, rows, cwd, scrollbackLines?, windowId? }`, `terminal_resize { id, cols, rows }`, `terminal_destroy { id }`.
- **JSON control frame (server to client):** `terminal_exit { id, exitCode }`, sent only to the owner.
- **Binary frames** for I/O, to avoid JSON overhead and keep raw bytes: `[type: 1 byte][terminalId: 36 ASCII bytes][payload]`. `0x01` is output (server to client, raw PTY bytes), `0x02` is input (client to server, UTF-8). `encodeBinaryFrame` / `parseBinaryHeader` are shared by both sides, which is why terminal IDs must be 36-character UUIDs.

On the client, [client.ts](../src/api/client.ts) routes binary output to at most one handler per terminal (`onTerminalOutput`, registered by a mounted `Terminal`) and to every `onTerminalData` listener (the background notification scanner). `sendTerminalInput` drops input while disconnected rather than queueing it; JSON `send` queues until the first connection only.

## Client: the Terminal component

[Terminal.tsx](../src/components/terminal/Terminal.tsx) is mounted by `TerminalPanelComponent` in [panels.tsx](../src/components/dockview/panels.tsx), which provides the panel's `worktreePath` param through `PanelContext`. That worktree path is the shell's `cwd`; if it is missing, no `terminal_create` is sent and the panel stays empty.

### Lifecycle

1. Construct `XTerm` with the theme read from CSS variables (`--editor-surface`, `--term-*`), the fit, search and web-links addons, the file-path link provider and the OSC handlers.
2. Wait for the font (below), then `terminal.open()`, attach WebGL if visible, and on the next animation frame `fit()` and send `terminal_create` with the fitted size, the scrollback setting and `WINDOW_ID`.
3. Input from `terminal.onData` goes out as binary frames until `terminal_exit` arrives, after which the component prints `[Process exited with code N]` and stops sending.
4. On WebSocket reconnect (same server version; a changed version reloads the page instead), it calls `terminal.reset()` and re-sends `terminal_create`. Against the same server process this reattaches and replays scrollback into the cleared terminal; against a restarted server it spawns a fresh shell under the same ID.
5. Unmount disposes the xterm instance and handlers but sends nothing to the server.

Sizing: a `ResizeObserver` and a device-pixel-ratio media query schedule a 100 ms debounced `fit()`; `terminal_resize` is sent only when cols or rows actually changed. Theme and scrollback options are updated in place when dark mode or the setting changes.

### Font loading

xterm measures the cell grid and the WebGL renderer rasterizes its glyph atlas at `open()`, and neither re-measures when a web font arrives. `loadTerminalFont()` therefore loads the `JetBrains Mono NL` `FontFace` objects directly (Chromium's `document.fonts.load()` matches nothing for this family because of a `local()` fallback face in [index.css](../src/index.css)) and races them against a 2 second timeout before opening.

### WebGL renderer and fallback

[webgl-renderer.ts](../src/components/terminal/webgl-renderer.ts) wraps `@xterm/addon-webgl`. WebGL is used because it draws box-drawing and block glyphs as exact-cell custom glyphs; a Vite plugin in [vite.config.ts](../vite.config.ts) (`xtermWebglPixelGrid`) patches the addon to snap glyphs and cell width to whole device pixels. Chromium caps live WebGL contexts per window (about 16) and force-loses the oldest, so a terminal holds a context only while its panel is visible: `onDidVisibilityChange` attaches on show and detaches on hide, and detach explicitly calls `WEBGL_lose_context` so the context does not count against the cap until GC. If the addon throws, or the context is lost (GPU reset, cap), the terminal stays on xterm's DOM renderer; on context loss the component refits because DOM cell metrics differ. Showing the panel again retries WebGL.

### Links

- **URLs** come from `WebLinksAddon` and xterm's `linkHandler` (OSC 8 hyperlinks); both call `openUrl()`, which accepts only `http:`/`https:`. Cmd+click dispatches `loxel-create-browser` (handled in [useLoxelEventListeners.ts](../src/hooks/useLoxelEventListeners.ts), which opens a browser panel); a plain click calls `window.open`, which the Electron main process turns into `shell.openExternal` through `setWindowOpenHandler` in [main.ts](../src/electron/main.ts); main also accepts only `http:`/`https:` there, so no other scheme ever reaches the OS.
- **File paths** come from [file-link-provider.ts](../src/components/terminal/file-link-provider.ts). Pass 1 always links tokens starting with `/`, `./`, `../` or `~/`, trimming trailing punctuation but keeping a `:line[:col]` suffix. Pass 2 links bare tokens with an extension (`CLAUDE.md`, `src/index.ts:12`) only if they match the worktree's file index by full relative path or by basename (first match wins). The index comes from the file-search store cache or `api.getFileIndex`. Column ranges are mapped back from ANSI-stripped text to raw cell positions. Links activate on Cmd+click only.
- Relative paths resolve against the **panel's worktree root**, not the shell's current directory (the renderer does not track `cd`). `~/` is left for the server to expand. Activation calls `openPath()` in [open-path.ts](../src/lib/open-path.ts), which asks `GET /api/path-info` whether the path is a directory: folders go to `openFolder()`, everything else to `dispatchOpenFile(path, location)` in [open-file.ts](../src/lib/open-file.ts), so the `:line:col` location reaches the editor. Missing files still open an editor, which reports the error.

### Keys and selection

`attachCustomKeyEventHandler` translates a few Cmd/Alt combinations into control sequences or xterm calls; app-level shortcuts are passed through to the global keybinding system (see [KEYBINDINGS.md](KEYBINDINGS.md); terminals are a find target via `usePanelFind`). Shift+Enter sends `ESC CR` and Ctrl+Enter sends the CSI-u sequence `ESC [13;5u`, which TUI coding agents read as "newline without submit". The handler returns `false` for modified Enter on keydown, keypress and keyup alike, so xterm never emits its own CR as a second newline; only keydown writes the sequence. `macOptionIsMeta` is on. There is no terminal-specific copy or selection code: copying relies on xterm's selection and the Electron Edit menu roles.

## Notifications

Terminal programs can raise notifications with OSC sequences; they become badge dots and entries in the notification center.

- **Parsing.** [osc-notification-parser.ts](../src/lib/osc-notification-parser.ts) has pure parsers for OSC 9 (iTerm2, whole payload is the body), OSC 777 (`notify;title;body`, anything else ignored) and OSC 99 (Kitty; `p=` selects title or body, `e=0..3` maps to `low`..`critical`; multi-part `d=0` sequences are not coalesced). Each sequence can be disabled in settings (`terminal.notificationSequences`, all on by default); settings are read at fire time.
- **Two detection paths.** A mounted terminal registers xterm parser hooks for 9, 777 and 99 in `Terminal.tsx`. Terminals without a mounted xterm (typically those in background worktrees, whose layout is swapped out) are covered by [terminal-notification-scanner.ts](../src/lib/terminal-notification-scanner.ts), started from [ws-bridge.ts](../src/queries/ws-bridge.ts): it scans raw output bytes for `ESC ]` or C1 `0x9d`, the OSC number and a BEL or `ESC \` terminator, skipping any terminal that has an output handler.
- **The bell.** A bare BEL (`0x07`) is not a notification; there is no `onBell` handler. BEL appears only as an OSC terminator.
- **Server store.** Both paths send `notification_add` with source `{ kind: "terminal", panelId: terminalId, worktreePath }`, where the worktree comes from the client-side `panelWorktreeMap`. [notification-store.ts](../src/server/notification-store.ts) keeps an in-memory, newest-first list capped at 200 and loses it on restart; `server.ts` broadcasts every change to all clients and sends `notifications_sync` on connect. The model is [notification-model.ts](../src/api/notification-model.ts).
- **Client mirror.** [panel-notifications.ts](../src/store/panel-notifications.ts) mirrors the server list and derives `panelIndex` and `worktreeIndex`. The terminal tab ([terminal-tab.tsx](../src/components/dockview/terminal-tab.tsx)) shows a dot when its terminal is in `panelIndex` and the tab is inactive, and dismisses that panel's notifications whenever the tab becomes active. The sidebar shows a dot for worktrees in `worktreeIndex`. In Electron the count also drives the Dock badge (`useLoxelEventListeners`).
- **Registration and replay suppression.** Panels are registered with their worktree when created (`addTerminal` in [worktree-tools-bar.ts](../src/store/worktree-tools-bar.ts)) or restored (`syncTerminalsFromLayout` in [default-layout.ts](../src/components/dockview/default-layout.ts)). For 3 seconds after registration, `addFromServer` drops notifications from that panel locally so scrollback replay after a remount does not re-raise old notifications.
- **Navigation.** [notification-navigation.ts](../src/lib/notification-navigation.ts) `navigateToNotification()` switches to the source worktree if needed, then activates the source terminal's tab, retrying once after 150 ms because the swapped-in layout may not be mounted yet. It is used by the notification center items and the "recent notification" action.
- **Cleanup.** Closing a terminal panel calls `unregisterPanel`, which sends `notification_dismiss_panel`.

## The `loxel` CLI

The CLI entry is [cli.ts](../src/cli.ts); `pnpm run build:cli` compiles it with `bun build --compile` to `build/loxel`. Bundling it with the app and installing it on `PATH` is planned (#322).

- **No argument:** runs `open -a Loxel`.
- **Finding the server:** inside a Loxel terminal (`LOXEL=1` and `LOXEL_PORT` set) it uses `LOXEL_PORT` directly. Otherwise it probes `GET /api/version` on 7433, then 7434 (1 second each), runs `open -a Loxel` to focus or launch the app, and if nothing answered waits up to 15 seconds for port 7433.
- **URLs** (`http:`/`https:`, per [url-utils.ts](../src/url-utils.ts)): the worktree is `git rev-parse --show-toplevel` of the cwd, falling back to `LOXEL_WORKTREE` inside a Loxel terminal. The request is `{ url, wtPath }`.
- **Everything else** is treated as a path: `{ filePath: resolve(arg), windowId? }`, with `LOXEL_WINDOW_ID` included only inside a Loxel terminal.

[open-request.ts](../src/open-request.ts) `requestOpen()` posts to `POST /api/open` and, on `503` (no window connected yet), retries every 300 ms for up to 30 seconds. The Electron main process reuses it for files macOS hands to the app (see [ELECTRON.md](ELECTRON.md)).

`handleOpen` in [routes.ts](../src/server/routes.ts):

- URL: rejects non-http(s), requires `wtPath` to belong to a known project, and broadcasts `open_url` to every client subscribed to that worktree, which [ws-bridge.ts](../src/queries/ws-bridge.ts) turns into `loxel-create-browser`.
- Path: `stat`s it (404 if missing; 400 for anything that is not a regular file or directory, since pipes and devices would hang the editor), canonicalizes it (`~/` expansion, `realpath`), and calls `sendToActiveWindow()` in `server.ts` with `open_file` or `open_folder`. That targets every connection whose `window_hello` reported the given window ID, else the most recently focused window (`window_focused`, from [useWindowPresence.ts](../src/hooks/useWindowPresence.ts)), else any client; with no client it returns 503.

In the renderer, `openFile()` and `openFolder()` in [open-path.ts](../src/lib/open-path.ts) pick the owning worktree, switching to it if needed, or fall back to the active worktree's Others section. A file for a worktree whose center Dockview is not mounted yet is queued in the worktree UI store (`queueOpenFile`) and opened once the layout is restored. Panel creation itself is covered in [PANELS_AND_LAYOUT.md](PANELS_AND_LAYOUT.md); worktree switching in [PROJECTS_AND_WORKTREES.md](PROJECTS_AND_WORKTREES.md).

## Opening things in external apps

"Open In" (reveal in Finder, open with another app) is served under `/api/open-in/*` by [open-in-routes.ts](../src/server/open-in-routes.ts), with request and response schemas in [open-in-model.ts](../src/api/open-in-model.ts). It is macOS-only (`routes.ts` returns 501 elsewhere). Targets must be normalized absolute paths that Loxel manages, POST bodies must be declared as `application/json`, and `open -a` only launches an app the route itself offered for that target. App lists for files come from LaunchServices (see [ELECTRON.md](ELECTRON.md)). Folders get no LaunchServices lookup: [folder-apps.ts](../src/server/folder-apps.ts) checks a curated list of terminals (Terminal, iTerm, Ghostty, Warp) and editors for an installed `.app` in `/Applications`, `~/Applications` and `/System/Applications/Utilities`.

## Invariants

- **Survives reloads, not server exit.** Terminal IDs are persisted in the layout's panel params and the PTY is keyed by them, so a renderer reload or a WebSocket drop reattaches with replayed scrollback. Server shutdown destroys every PTY; after a restart the client respawns a fresh shell under the same ID, in the same worktree.
- **Worktree switches keep shells running.** Switching worktrees swaps the center layout and unmounts terminal components, but `CenterHost` skips `terminal_destroy` during layout swaps. Output keeps flowing to the owning socket, where only the notification scanner reads it; switching back remounts and replays the server-side scrollback.
- **Per-worktree cwd.** A terminal's cwd and `LOXEL_WORKTREE` are the panel's `worktreePath` param at creation. Link resolution uses that path, not the live shell cwd.
- **Many terminals.** Output of every live terminal is sent to its owner whether or not it is mounted, and each holds up to `scrollbackLines × 100` bytes on the server (about 5 MB at the default). WebGL contexts are held only by visible terminals.
- **Modified Enter.** Shift+Enter and Ctrl+Enter are forwarded as `ESC CR` and `ESC [13;5u` at the key-handler level; there is no per-program detection.

## Where to look

- [src/server/pty-manager.ts](../src/server/pty-manager.ts): session model, scrollback, detach and orphans
- [src/server/server.ts](../src/server/server.ts): ownership, `terminal_*` handlers, `LOXEL_*` env, idle shutdown, notification handlers, `sendToActiveWindow`
- [src/server/shell-env.ts](../src/server/shell-env.ts): login-shell `PATH`
- [src/api/ws-protocol.ts](../src/api/ws-protocol.ts): terminal messages and the binary frame format
- [src/api/client.ts](../src/api/client.ts): binary routing, reconnect listeners
- [src/components/terminal/](../src/components/terminal/): xterm.js setup, WebGL, links, search decorations
- [src/lib/osc-notification-parser.ts](../src/lib/osc-notification-parser.ts), [src/lib/terminal-notification-scanner.ts](../src/lib/terminal-notification-scanner.ts), [src/server/notification-store.ts](../src/server/notification-store.ts), [src/store/panel-notifications.ts](../src/store/panel-notifications.ts), [src/lib/notification-navigation.ts](../src/lib/notification-navigation.ts): notifications
- [src/cli.ts](../src/cli.ts), [src/open-request.ts](../src/open-request.ts), `handleOpen` in [src/server/routes.ts](../src/server/routes.ts), [src/lib/open-path.ts](../src/lib/open-path.ts), [src/lib/open-file.ts](../src/lib/open-file.ts): the CLI and open requests
