# Architecture

The top-level internal map of `packages/loxel`: processes, source layout, the client-server contract, server composition, observability and tests, with links to the internal docs that cover each area in depth.

## Process topology

Three kinds of process cooperate. A single Bun server per mode (port 7433 prod, 7434 dev) owns everything that touches the filesystem, Git, PTYs, coding-agent sessions, language servers and SQLite, and serves the built renderer. Each Electron window loads the server's URL and runs the React renderer, which talks to the server only over REST (`/api/*`) and WebSocket (`/ws`, plus one socket per language-server session under `/ws/<lsp>`). The Electron main process discovers or spawns the server and handles native integrations over IPC. The `loxel` CLI ([cli.ts](../src/cli.ts)) is a fourth, short-lived client that posts open requests to a running server ([open-request.ts](../src/open-request.ts)). Process model and shipping constraints are in [ELECTRON.md](ELECTRON.md); discovery, ownership, idle shutdown and state scopes are in [SHARED_SERVER.md](SHARED_SERVER.md).

## Source layout

All code lives under one `src/` tree with one [tsconfig.json](../tsconfig.json) (DOM libs included) and the `@/*` path alias, so the server, Electron and renderer typecheck together and can import each other's modules. Boundaries are conventions, not enforced.

| Path                                  | Contents                                                                                                                                                                                  |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [src/server/](../src/server/)         | Bun server: composition root, REST handlers, services, Git command layer (`git-commands/`, `parsers/`), LSP managers, SQLite stores, logger and monitors. Tests sit next to the code.     |
| [src/electron/](../src/electron/)     | Electron main process, preload (`preload.cjs`), IPC channel names, webview keystroke forwarding, WebAuthn, main-process perf monitor. See [ELECTRON.md](ELECTRON.md).                     |
| [src/api/](../src/api/)               | The client-server contract: `client.ts` (REST functions and the WebSocket client), `ws-protocol.ts` and the `*-model.ts` modules imported by both sides.                                  |
| [src/queries/](../src/queries/)       | TanStack Query layer: query keys, scoped query hooks, Git mutations, and the WebSocket-to-cache bridge.                                                                                   |
| [src/store/](../src/store/)           | Zustand stores, many persisted to the server. See [STATE_AND_STORAGE.md](STATE_AND_STORAGE.md).                                                                                           |
| [src/hooks/](../src/hooks/)           | React hooks shared across components (subscriptions, keybindings, sync scroll, panel focus).                                                                                              |
| [src/components/](../src/components/) | React components grouped by feature folder (`diff/`, `terminal/`, `coding-agent/`, `panels/`, `dockview/`, ...), with UI primitives in `ui/`.                                             |
| [src/lib/](../src/lib/)               | Helpers and some shared models, mostly non-React: LSP clients, Monaco setup, themes, three-way merge, content anchors, the frontend logger and perf monitor.                              |
| `src/` root                           | Entry points (`main.tsx`, `App.tsx`, `cli.ts`), `query-client.ts`, ambient `.d.ts` files, and a few modules used by several processes (`open-request.ts`, `url-utils.ts`, `fs-utils.ts`). |
| [scripts/](../scripts/)               | Build-time scripts: app packaging (`build-app.ts`), bundling or downloading language-server binaries, copying the TypeScript 7 binary.                                                    |
| [e2e/](../e2e/)                       | Playwright suite, currently screenshot specs for the site. See [Testing](#testing).                                                                                                       |

Inconsistencies worth knowing (do not take them as rules):

- The server imports a few renderer-side modules: `@/lib/formatting-model`, `@/lib/layout-key-schema`, `@/lib/content-anchor`, `@/lib/media-extensions`, `@/lib/project-file-helpers`, `@/lib/perf-lag-stats`, and `@/components/projects/wizard-detection` (from [routes.ts](../src/server/routes.ts)). Shared code is therefore not confined to `src/api/`.
- Hook file naming is mixed: mostly `useX.ts`, but [use-disk-synced-content.ts](../src/hooks/use-disk-synced-content.ts) is kebab-case and [diff-base.ts](../src/hooks/diff-base.ts) is not a hook. `src/queries/` uses kebab-case `use-*.ts`.
- Feature components are PascalCase; most `components/ui/` primitives are kebab-case (`button.tsx`, `context-menu.tsx`), with exceptions such as `HighlightedLabel.tsx`.
- Model module naming: `git-models.ts` is plural; everything else is `*-model.ts`.

## Client-server contract

### Shared models

`src/api/*-model.ts` modules define the request and response shapes that both [client.ts](../src/api/client.ts) and the server handlers import. Two styles coexist:

- **Zod schemas with inferred types** in [project-model.ts](../src/api/project-model.ts), [review-model.ts](../src/api/review-model.ts), [comment-model.ts](../src/api/comment-model.ts), [open-in-model.ts](../src/api/open-in-model.ts) and [coding-agent-model.ts](../src/api/coding-agent-model.ts). The schema is canonical and the type is `z.infer`.
- **Plain TypeScript types** everywhere else (`git-models.ts`, `diff-model.ts`, `log-entry-model.ts`, `search-model.ts`, ...).

Runtime validation is one-sided and partial: [review-routes.ts](../src/server/review-routes.ts) and [open-in-routes.ts](../src/server/open-in-routes.ts) `safeParse` request bodies; [routes.ts](../src/server/routes.ts) checks fields by hand (`parseBody`, `requireString`, `requireStringArray`). The client never validates responses: `fetchJson<T>` returns the parsed JSON as `T`.

### REST

- **Dispatch.** [server.ts](../src/server/server.ts) forwards every `/api/*` request to `handleRequest(req, ctx)` in [routes.ts](../src/server/routes.ts). It first looks up a static `routes[method][pathname]` table, then falls through to hand-written matches: `/api/projects/:id...` regexes, `/api/layout/promote`, `/api/stores/:key`, and prefix-delegated sub-routers [localdb-routes.ts](../src/server/localdb-routes.ts), [review-routes.ts](../src/server/review-routes.ts) and [open-in-routes.ts](../src/server/open-in-routes.ts). Sub-routers take their own narrow context and return `null` when no route matches.
- **Scope.** Worktree- or project-scoped endpoints take `?wt=<worktree path>` or `?project=<path>` (or a `worktreePath` body field); `resolveWorktreeFromReq` / `resolveProjectFromReq` / `resolveProjectFromBody` map that to a `ProjectState` via `findProjectForPath`.
- **Responses.** Handlers return `json(data)` or `error(message, status)` from [response-helpers.ts](../src/server/response-helpers.ts); `error` keeps only the first line of the message, and the client throws `new Error(body.error)`. Exceptions thrown by a static-table handler become a 500 with the error message. [error-message.ts](../src/server/error-message.ts) `describeError` builds a message from an error's cause chain and `Bun.$` stderr, for failures from Git and `wt`.
- **Dependency injection.** `RouteContext` (defined in `routes.ts`) carries the broadcast functions, project and worktree lookups, lifecycle hooks and formatter/schema services that server.ts owns, which lets route tests build a fake context (for example [routes.detached.test.ts](../src/server/routes.detached.test.ts)). It is partial: routes.ts also imports module singletons directly (`store-db`, `project-store`, `update`, `logger`). server.ts builds the same context literal twice in its `fetch` handler.
- **Naming trap.** `GET /api/log` is the Git log, `POST /api/log` ingests a log entry, and `GET /api/logs` returns server log history.

### WebSocket

The app socket (`/ws`) carries JSON text frames typed in [ws-protocol.ts](../src/api/ws-protocol.ts): `WsMessage` (server to client) and `WsClientMessage` (client to server). Terminal I/O uses binary frames on the same socket: `[type byte][36-byte terminal UUID][payload]`, with `BIN_MSG_OUTPUT` and `BIN_MSG_INPUT`. [ws-messages.ts](../src/server/ws-messages.ts) holds only one shared builder (`worktreesChangedMessage`); every other message is built inline.

Server-to-client delivery uses helpers in server.ts, chosen by scope:

- `broadcastToSubscribers(wtPath)`: clients subscribed to a worktree (`status_changed`, `files_dir_changed`, `file_content_changed`, ...).
- `broadcastToProject(projectPath)`: clients subscribed to any worktree of the project, deduplicated (`refs_changed`, `log_changed`, `worktree_status_changed`, `localdb_changed`).
- `broadcastAll`: every app client (`store_updated`, notifications, `log_error_count`, `update_status_changed`).
- `sendToActiveWindow(windowId)`: one window (`open_file`, `open_folder`), see [Per-window identity](#per-window-identity).
- `sendTo(owner)`: terminal and agent events go only to the connection that owns the session. The `ws-protocol.ts` comments list `terminal_exit` and `agent_*` under "Global (sent to all clients)", which does not match server.ts.

On the client, [client.ts](../src/api/client.ts) exports a singleton `wsClient` that reconnects every 2 s, queues JSON messages sent before the first connection (but drops the queue on reconnect), and on reconnect compares the server version from `/api/version` with the first one it saw: a change reloads the page, otherwise `onReconnect` listeners run so features re-create server-side state (worktree subscription, log subscription, terminal reattach).

- [ws-bridge.ts](../src/queries/ws-bridge.ts) (`useWsBridge`, mounted in [App.tsx](../src/App.tsx)) connects the client and routes push messages into the TanStack Query cache (`setQueryData` or `invalidateQueries`) and into stores (logs, notifications, `store_updated`). Its `switch` ends in a `never` check, so adding a `WsMessage` variant fails typecheck until the bridge handles or explicitly ignores it.
- Terminal and agent messages are ignored by the bridge and consumed by their own `wsClient.subscribe` listeners in [Terminal.tsx](../src/components/terminal/Terminal.tsx), [CodingAgentPanel.tsx](../src/components/coding-agent/CodingAgentPanel.tsx) and [AgentDevToolsPanel.tsx](../src/components/agent-devtools/AgentDevToolsPanel.tsx).
- [useWsSubscription.ts](../src/hooks/useWsSubscription.ts) sends `subscribe_worktree` for the active worktree. When the worktree changes it defers unsubscribing the previous one until its pending saves drain (`onWorktreeSavesDrained`), so server resources outlive panel-unmount autosaves. On reconnect it resubscribes and re-registers open files outside the worktree (`register_external_files`).

### TanStack Query

[query-client.ts](../src/query-client.ts) sets `staleTime: Infinity`, `refetchOnWindowFocus: false` and a 30-minute `gcTime`: data is fresh until a WebSocket push or a mutation's `onSuccess` invalidates it. Keys come from [query-keys.ts](../src/queries/query-keys.ts) and lead with the project path (then worktree path where relevant), so repo-wide data such as refs is shared by the project's worktrees. [use-repo-queries.ts](../src/queries/use-repo-queries.ts) wraps `useQuery` with the active scope from [use-scope.ts](../src/queries/use-scope.ts); [use-git-mutations.ts](../src/queries/use-git-mutations.ts) holds mutations. Some features still build keys inline, for example the `["localdb", projectPath, ...]` keys in the localdb components and in ws-bridge.

### Adding an endpoint end-to-end

1. Define the request and response shapes in the matching `src/api/*-model.ts` (a Zod schema if the server should validate the body).
2. Write the handler in [routes.ts](../src/server/routes.ts) (or the matching `*-routes.ts` sub-router), resolve scope with the `resolve*` helpers, and register it in the `routes` table. Reach server state only through `RouteContext`; extend it in routes.ts and supply the implementation in server.ts if needed.
3. Add a typed function to [client.ts](../src/api/client.ts) using `fetchJson` and `withScope`.
4. For reads, add a key to `queryKeys` and a hook in `src/queries/`; for writes, a mutation that invalidates the affected keys.
5. If other windows must see the change, add a `WsMessage` variant, broadcast it at the right scope, and handle it in ws-bridge (typecheck enforces the last step).
6. Add a route test next to the handler with a fake `RouteContext`.

## Server composition

- [index.ts](../src/server/index.ts) is the process entry. The same executable doubles as the LaunchServices helper, so it checks for the helper flag before loading any server module, then imports [server.ts](../src/server/server.ts).
- [server.ts](../src/server/server.ts) is the composition root, written as module-level state and top-level `await`. Startup: initialise the secret store, resolve the login-shell environment (not awaited), load registered projects (plus an optional repo path from `argv[2]`), initialise all projects in parallel, start `Bun.serve` on `127.0.0.1`, wire the logger's broadcast callbacks, recover orphaned layout sessions, start the perf monitor and, in production, check for updates after 5 s. Non-API paths are served from the renderer build directory (`LOXEL_STATIC_DIR`, else the bundled or `dist/` build) with an `index.html` fallback.
- [config.ts](../src/server/config.ts) derives `isDev`, `stateDir`, `port` and state subdirectories from `LOXEL_DEV`, `LOXEL_STATE_DIR` and `LOXEL_SERVE_PORT`, and provides `hash12` for state paths.
- [server-state.ts](../src/server/server-state.ts) declares the scope types and pure lookup helpers (`findOwningProject`, `externalFolderConflict`, `listOthers`, `worktreeTree`); server.ts owns the maps.

Services by scope:

| Scope                              | Created                                                               | Contents                                                                                                                                                       |
| ---------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server-wide                        | module load in server.ts                                              | `PtyManager`, `AgentManager`, `NotificationStore`, `SchemaService`, `FormatService`, one manager per language server, `ExternalFolderRegistry`, the client map |
| Per project (`ProjectState`)       | `initializeProject` at startup or registration                        | Git `FileWatcher`, `ReviewDb`, `LocalDb`, `WorktreeStatusTracker`, worktrees dir                                                                               |
| Per worktree (`WorktreeResources`) | first `subscribe_worktree`; torn down when the last subscriber leaves | file, file-operations (with undo history), drafts, external files and Others-folder services, a linked worktree's own Git watcher                              |
| Per connection (`ClientState`)     | WebSocket `open`                                                      | owned terminals, subscribed worktrees, `windowId`                                                                                                              |
| Per LSP socket                     | `/ws/<lsp>?wt=...` upgrade                                            | one language-server session per socket; see [LANGUAGE_SERVERS.md](LANGUAGE_SERVERS.md)                                                                         |

`resolveFilePath` maps an absolute path to its owning worktree resources (drafts first, then worktree files, then Others folders and external files, preferring the requester's worktree). Watcher wiring is in [WATCHERS.md](WATCHERS.md); projects and worktrees in [PROJECTS_AND_WORKTREES.md](PROJECTS_AND_WORKTREES.md).

### Per-window identity

[window-id.ts](../src/lib/window-id.ts) exports `WINDOW_ID`: in Electron the main process passes `--loxel-window-id` through `additionalArguments` and the preload exposes it as `window.loxelWindow`; outside Electron a UUID is kept in `localStorage`. [useWindowPresence.ts](../src/hooks/useWindowPresence.ts) sends `window_hello` (stored as `ClientState.windowId`) and `window_focused` (tracked as the last focused client). Terminals receive `LOXEL_WINDOW_ID`, the CLI forwards it in `POST /api/open`, and `sendToActiveWindow` targets that window, else the last focused one, else any client. The same ID keys per-window layout sessions (`/api/layout/promote`, [layout-key-schema.ts](../src/lib/layout-key-schema.ts)); see [PANELS_AND_LAYOUT.md](PANELS_AND_LAYOUT.md).

## Observability

- **Server logger** ([logger.ts](../src/server/logger.ts)): `logger.child(category)` emits `LogEntry` records ([log-entry-model.ts](../src/api/log-entry-model.ts)) with a closed `LOG_CATEGORIES` list. Each entry goes to a 5000-entry ring buffer and to an NDJSON file `<stateDir>/logs/server-<instanceId>.log` (rotated to `.log.1` above 5 MB; other instances' files older than 24 h are deleted). Entries at `info` and above are batched every 100 ms to sockets that sent `subscribe_logs`; an error-count delta is always broadcast to all clients for the Logs badge, and `subscribe_logs` replies with a `log_error_snapshot` total for reconciliation.
- **Frontend and Electron logs** ([frontend-logger.ts](../src/lib/frontend-logger.ts), [main-perf-monitor.ts](../src/electron/main-perf-monitor.ts)): same `ChildLogger` API, sent fire-and-forget to `POST /api/log` and re-emitted by the server, so all processes share one stream. Entries carry no origin field; the category is the only hint. The error serializer is duplicated between the server and frontend loggers.
- **Logs panel**: [logs.ts](../src/store/logs.ts) loads history with `GET /api/logs` (newest first, paged by `before` id), appends live batches, and refcounts the `subscribe_logs` subscription, resending it on reconnect.
- **Perf monitors**: [perf-monitor.ts](../src/lib/perf-monitor.ts) (renderer: FPS, long tasks, lag, heap), [server-perf-monitor.ts](../src/server/server-perf-monitor.ts) (event-loop lag, memory) and `main-perf-monitor.ts` (per-process CPU and memory) log summaries at `debug` and escalate anomalies to `warn`/`error`, all with `cat: "perf"`. Debug summaries reach the file and ring buffer but not the live stream.
- **Stress detector** ([stress-detector.ts](../src/server/stress-detector.ts)): rate checkpoints (`broadcast`, `api-request`, `git-watch`, `pty-output`, ...) that log warnings when a call rate, or the same parameters, exceed a threshold; detection only. The default instance also configures `ts-completions`, `ts-references` and `ts-diagnostics`, which nothing tracks.
- **LSP stderr** is rate-limited per session by [stderr-throttle.ts](../src/server/stderr-throttle.ts) so a chatty server does not flood the ring buffer.
- **Reading logs locally**: open the Logs panel, or read the NDJSON files under `~/.local/state/loxel/loxel-dev/logs/` (dev) or `.../loxel/logs/` (prod), e.g. with `jq`. `@bizimind/logger` is listed in `package.json` but not imported by any loxel source file.

## Testing

- **Unit tests** sit next to the code as `*.test.ts`. `pnpm run test` runs `bun test src --isolate` with two preloads: [dom-preload.ts](../src/test/dom-preload.ts) registers happy-dom globally and [jest-dom-preload.ts](../src/test/jest-dom-preload.ts) adds jest-dom matchers. There is no `bunfig.toml` in the package, so running one file with `bun test` directly needs the same `--preload` flags if it touches the DOM.
- **`*.dom.test.tsx`** marks tests that render React with Testing Library (keybindings, find bar, tree, sidebar, menus, panels). It is a naming convention only: the preloads apply to every test.
- **Server tests** use temporary directories and real Git repos ([git-commands/test-utils.ts](../src/server/git-commands/test-utils.ts)); route tests call `handleRequest` with a fake `RouteContext` (`routes.*.test.ts`).
- **E2E** ([e2e/](../e2e/)): `pnpm run e2e` runs Playwright with [global-setup.ts](../e2e/global-setup.ts), which builds the renderer with `VITE_SCREENSHOT=1`, starts the server from source on a free port in 17434 to 17534 with a throwaway `LOXEL_STATE_DIR`, and waits for `/api/version`. The current specs in `e2e/screenshots/` produce site screenshots into `packages/site/public/screenshots` and run with one worker against the shared server.

## Internal docs

- [ARCHITECTURE.md](ARCHITECTURE.md): this map.
- [ELECTRON.md](ELECTRON.md): Electron process model, what ships in the app bundle versus in-app updates, browser panels, macOS integration.
- [SHARED_SERVER.md](SHARED_SERVER.md): one server shared by all windows, discover-or-spawn, ownership, idle shutdown, state scopes, persistent stores.
- [RELEASE_SIGNING.md](RELEASE_SIGNING.md): macOS code signing and the provisioning profile behind passkeys.
- [WATCHERS.md](WATCHERS.md): filesystem and Git watchers, their ownership and the status refresh pipeline.
- [GIT.md](GIT.md): Git command layer, status tracking, diff data and the commit graph.
- [STATE_AND_STORAGE.md](STATE_AND_STORAGE.md): Zustand stores, server-side persistence, SQLite stores, settings and secrets.
- [PANELS_AND_LAYOUT.md](PANELS_AND_LAYOUT.md): Dockview, panel registry and placement, tools bars, command palette, menus.
- [KEYBINDINGS.md](KEYBINDINGS.md): action registry, chords, focus navigation, find in panel, shortcuts inside webviews.
- [EDITOR.md](EDITOR.md): Monaco, the markdown editor, disk sync, drafts, external files, media, localdb UI.
- [LANGUAGE_SERVERS.md](LANGUAGE_SERVERS.md): LSP managers, routing, URI schemes, diagnostics, formatting, schemas, highlighting.
- [TERMINALS.md](TERMINALS.md): PTYs, xterm.js, notifications, the CLI inside terminals, open routing.
- [CODING_AGENT_INTEGRATION.md](CODING_AGENT_INTEGRATION.md): agent manager, sessions, replay, devtools, fork tree.
- [CODE_REVIEW.md](CODE_REVIEW.md): reviews, comments, anchors, export.
- [PROJECTS_AND_WORKTREES.md](PROJECTS_AND_WORKTREES.md): project store, setup wizard, worktree lifecycle via `wt`, Others folders, reconcile.
- [FILES_TREE.md](FILES_TREE.md): the shared `FilesTree` component: path identity, expansion, focus, reveal.
- [PROJECT_EXPLORER.md](PROJECT_EXPLORER.md): the project files panel: path model, Drafts and Others sections, reveal.
- [DIFF_VIEW_SPEC.md](DIFF_VIEW_SPEC.md): side-by-side diff spec: synchronized scrolling, intra-line highlights, gutter connectors.
