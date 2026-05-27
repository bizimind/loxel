# Loxel

An IDE built for the agentic coding era. Designed around the reality that developers now work across multiple tasks in parallel — with AI agents exploring, writing, and iterating on code — while humans plan, review, and steer.

Loxel packages the things critical for agentic work into a single interface: fast project and worktree switching, planning and ideation tools, code review for AI-generated work, integrated terminals for running agents and commands, and an opinionated coding agent harness — all in a flexible, dockable panel system.

## Why

Coding agents change how developers work. Instead of writing every line yourself, you direct agents across multiple workstreams in parallel. This demands a new kind of tool:

- **Isolation** — each task needs its own worktree so agents don't collide
- **Fast context switching** — jump between projects and worktrees instantly, with layout and state preserved per context
- **Orientation** — understand what changed, where you are, and what the agent did — fast
- **Review before commit** — inspect, comment on, and iterate on AI work before it becomes a PR
- **Planning** — sketch ideas, write plans, and (in the future) use AI to communicate them more clearly
- **Agent interaction** — run and monitor coding agents directly, with a UI built for their workflows

Loxel is built around these needs.

## Core Concepts

### Multi-Project & Worktree Context Switching

The primary workflow: manage multiple repositories and worktrees from a single window, switching between them instantly.

- **Project sidebar** — add and switch between git repositories
- **Worktree sidebar** — view and switch between worktrees within bare repos
- **Per-context layouts** — each project + worktree combination remembers its own panel layout, so switching back restores exactly where you left off
- **Cross-worktree awareness** — see dirty status across all worktrees of the same repo at a glance
- **Shared review database** — code review comments are stored per-repo (keyed by git's common dir), so reviews are visible from any worktree

### Planning & Ideation

Tools for thinking and communicating before (and during) agent work:

- **Markdown editor** — Milkdown/Crepe-based rich editor with CodeMirror syntax highlighting. Persisted to disk as `.md` files with capped debounced autosave (250ms idle / 5s max wait). Search results navigate to the matched position using remark AST source-position mapping with ordinal text-node matching
- **Excalidraw drawing editor** — full whiteboarding canvas for architecture diagrams, flow sketches, and visual planning. Persisted to disk as `.excalidraw` JSON files with autosave
- **Drafts** — new editors create files in a detached "Drafts" directory (scoped per project + worktree, stored outside the repo in `~/.local/state/loxel/loxel/detached/`). Drafts appear in a dedicated section at the top of the project files panel
- **Drag to project** — drag draft files from the Drafts section into any project directory to move them into the repo. Editors continue working seamlessly after the move
- **Conflict detection** — same bi-directional sync as the code editor: if a file changes on disk while you have unsaved edits, a banner lets you accept the disk version or keep yours
- **Extension-based routing** — double-clicking `.md` files opens the markdown editor; `.excalidraw` files open the drawing editor
- **Future direction** — AI-assisted explanation and refinement of plans and ideas using these tools

### Coding Agent Panel

An opinionated agent harness designed for a better interaction model:

- **Dedicated agent panel** — timeline-based UI showing the full conversation: user messages, assistant responses, tool calls and results, plans, and events
- **Human interaction overlays** — when the agent needs input (questions, approval requests), overlays appear inline with multi-select options
- **Session lifecycle** — auto-create, suspend, resume, and exit agent sessions. Agents survive UI navigation and are organized by scope (project + worktree)
- **Event replay** — up to 5000 events buffered per session, replayed on reattach so you never lose context
- **Subprocess management** — each agent runs as an isolated subprocess, communicating via newline-delimited JSON

### Integrated Terminals

Terminals are first-class panels, used for running CLI-based agents (Claude Code, Codex, Opencode, Gemini, etc.) and normal development tasks (tests, builds, dev servers, git).

- **xterm.js terminals** with web link detection
- **Multiple tabs** in the same panel group (`Ctrl+Shift+T` to create)
- **Low-overhead PTY I/O** — binary WebSocket protocol (37-byte header) for responsive interaction
- **Scrollback persistence** — configurable scrollback (default 50K lines), server-side circular buffer replayed on reattach
- **Session survival** — terminals persist across project and worktree switches
- **Theme sync** — terminal colors follow dark/light mode

### Code Review

Local review sessions for inspecting and iterating on AI-generated (or human) work before creating a PR:

- **Named review sessions** with context metadata (commit hashes, branch, worktree)
- **Comment threads** anchored to specific code ranges on either side of a diff
- **Smart comment placement** — FNV-1a content fingerprinting with 3-line context. Comments survive code edits and are classified as exact, relocated, outdated, or lost
- **Outdated diff views** — when anchored code has changed, a mini-diff shows the original context
- **Thread resolution** workflow for tracking what's been addressed
- **Markdown rendering** (GitHub flavored) in all comments
- **Persistent and shared** — SQLite database per repo, shared across all worktrees

### Side-by-Side Diff Viewer

JetBrains-style split diff with synchronized scrolling:

- **Content-aware scroll alignment** — unchanged lines stay aligned; insertions/deletions use pause-and-catch-up mechanics with a 50% viewport center rule
- **Monaco Editor** with syntax highlighting (Shiki), diff decorations, and collapsible unchanged regions
- **Gutter connector** SVG showing line relationships between panels
- **Split and unified** view modes
- **Hunk-level staging** — stage or unstage individual hunks directly from the diff view

### TypeScript Language Intelligence

All per-file TS/JS language features are delivered by a `tsgo --lsp -stdio` subprocess per worktree, proxied to Monaco over a WebSocket at `/ws/ts-lsp` via the `monaco-lsp-client` package. The backend is pluggable (`LOXEL_TS_LSP=tsgo|tsls`, see `packages/loxel/src/server/ts-lsp-backend.ts`). No TypeScript runs on Bun's JS thread.

- **Project diagnostics** — the `GET /api/diagnostics` endpoint shells out to the `tsgo` CLI against a committed ref or the working tree and caches results per-commit. Used by the diff viewer and the project-wide diagnostics query
- **Per-file diagnostics** — pushed by tsgo over LSP (`textDocument/publishDiagnostics`) and rendered as Monaco markers by `LspDiagnosticsFeature`
- **Hover, go to definition, find references, completions, rename, code actions, inlay hints, signature help, document symbols, folding ranges** — delivered via the corresponding `Lsp*Feature` registered by `MonacoLspClient`. Cmd-click/F12 jumps open a new editor tab via `registerEditorOpener` (see `monaco-env.ts`), not Monaco's inline peek widget
- **Semantic highlighting** — only provided when the chosen backend implements `textDocument/semanticTokens/full`. `tsgo` currently does not, so TS files fall back to Monarch syntactic highlighting. Switch to `LOXEL_TS_LSP=tsls` (`typescript-language-server`) for full semantic tokens
- **Unused variable dimming** — tsgo emits these as diagnostics with the appropriate tag, surfaced by `LspDiagnosticsFeature` via `MarkerTag.Unnecessary`
- **LSP stderr rate-cap** — every `StdioLspManager` subprocess (TS, terraform-ls, etc.) drains stderr through a per-session token-bucket throttle (200-line burst, 50 lines/sec steady-state). Chatty servers can't flood the shared log ring buffer or rotating log file; dropped lines are counted and summarized periodically at `debug` level

**LSP lifecycle**: `tsgo` is connected eagerly when a worktree becomes active, since most worktrees have TS/JS files. `terraform-language-server`, `docker-language-server`, `pyright` (Python), and `@astrojs/language-server` (Astro) are expensive to spawn (they walk the workspace) and most worktrees don't need them, so they are lazy-connected: the subprocess is only started when a model of the matching language (`terraform`, `dockerfile`/`dockerbake`, `python`, or `astro`) first appears in the active worktree, and disconnected when the last such model is disposed. Switching worktrees re-evaluates the count so the LSP follows the active scope. See `createLazyLspConnector` in `src/lib/monaco-env.ts`.

### Git Operations

Full git client via context menus and inline forms:

- **Commit graph** — interactive DAG with branch/tag labels, multi-select, search with filters (branch, author, date range, file paths), and an "uncommitted changes" virtual row
- **Changes panel** — defaults to showing local changes (staged + unstaged + untracked) when no commits are selected. Includes a branch commit dropdown for selecting commits unique to the current branch, with multi-select, "All branch changes" shortcut, and bidirectional sync with the Git graph
- **Staging** — file-level and hunk-level staging, unstaging, discard
- **Commits** — create, cherry-pick, revert (single and multi-select)
- **Branches** — create, delete, rename, checkout, favorites, upstream tracking (ahead/behind)
- **Reset** — soft, mixed, hard to any commit
- **Stash** — create, apply, pop, drop
- **Worktree status** — dirty status across all worktrees

### Code Editor & File Explorer

Standard IDE editing experience built on Monaco Editor:

- **Syntax highlighting** for all major languages, code folding, line numbers, glyph margin
- **TypeScript diagnostics** — real-time type errors and warnings from `tsgo` shown as inline markers
- **Quick Open** (`Cmd+P`) — fuzzy file path search with file icons, MRU list, and go-to-line via `:line` suffix. Search results (`Cmd+Shift+F`) navigate directly to the matched line and column
- **Command Palette** (`Cmd+K`) — fuzzy search across all registered actions with keyboard navigation (arrow keys, Enter to execute). Internal actions (tree navigation, the palette itself) are hidden via `hidden: true` on `ActionDef`
- **Autosave** with capped debounce (250ms idle / 5s max wait), `Cmd+S` to save immediately, `Cmd+W` to close
- **Format on save** — auto-detects project formatters (oxfmt, prettier, rustfmt, ruff, etc.) from config files and `package.json`. Formats on explicit save (`Cmd+S`) by default; optional format-on-auto-save. Persistent formatter backends (LSP for oxfmt, library import for prettier) eliminate per-request process spawn overhead. Configurable via Settings > Editor.
- **Conflict detection** — when a file changes on disk (e.g. by an agent), a banner lets you accept the disk version or keep your edits
- **File tree** — project files panel with git status coloring (modified, untracked, ignored), expandable folders, double-click to open in editor. Keyboard navigation is command/keybinding driven: Arrow Up/Down move between rows, Arrow Right expands or enters a directory, Arrow Left collapses or jumps to parent, Space toggles expand/collapse, Enter opens, and F2 / Shift+F6 renames. Shared `FilesTree` component powers both the project files and changes panels

### Panel System

Dockview-powered layout with drag-and-drop arrangement:

```
┌──────────────┬───────────────────────────────────────────────────┐
│ File Tree    │ Diff View / Code Editor / Markdown / Excalidraw   │
│ Changes      │ Coding Agent                                      │
│ Branches     ├───────────────────────────────────────────────────┤
│ Comments     │ Git Graph (branches sidebar + commit graph)        │
│ Projects     ├───────────────────────────────────────────────────┤
│ Worktrees    │ Terminal (tabbed, multiple sessions)               │
└──────────────┴───────────────────────────────────────────────────┘
```

- **Center panels**: diff viewer, code editor, markdown editor, Excalidraw, coding agent, standalone terminals
- **Side panels**: file changes, project files, branches, comments, projects, worktrees — dockable left or right
- **Bottom panels**: git graph, terminal container, server logs
- **Collapsible** with saved dimensions, responsive sidebar collapse via container queries
- **Per-context persistence** — layout saved and restored per project + worktree combination
- **Per-panel error boundaries** — every panel is wrapped with a `react-error-boundary` at the registration level (`wrapPanelComponents`), so a render error in one panel shows an inline fallback (panel icon, error message, retry button) without crashing the rest of the app. Errors are logged to the frontend structured logger

### Status Bar

Branch info, upstream tracking (ahead/behind), working tree status counts (staged, modified, untracked, conflicts), loading indicator, and terminal launcher.

## Architecture

### Client-Server Model

**Server** (Bun, port 7433 prod / 7434 dev):

- REST API for git operations, file content, project management, server log history (`GET /api/logs`), and file index for quick-open search (`GET /api/file-index`)
- Static file serving from `dist/` in production (single-process deployment)
- WebSocket for real-time updates (file watcher, terminal I/O, agent events, server log streaming)
- SQLite databases for reviews/comments and project metadata
- PTY manager for terminal sessions with scrollback buffers
- Agent manager for coding agent subprocess lifecycle
- TypeScript LSP subprocess manager (`TsLspManager` spawns `tsgo --lsp -stdio` per worktree) proxied to the frontend over `/ws/ts-lsp`
- File watcher with debounced broadcasts (150ms status, 500ms worktree changes)

**Client** (React 19, Vite):

- Zustand stores for all application state (repository, UI, reviews, agents, editors, projects, worktrees)
- TanStack React Query for server data fetching and caching
- All UI state persisted to localStorage with version tracking
- WebSocket client for bidirectional real-time communication

### Key Dependencies

| Dependency     | Purpose                      |
| -------------- | ---------------------------- |
| React 19       | UI framework                 |
| Vite 7         | Dev server and bundler       |
| Dockview       | JetBrains-style panel layout |
| Monaco Editor  | Code diff and editing        |
| xterm.js       | Terminal emulation           |
| TanStack Query | Data fetching and caching    |
| TanStack Table | Commit graph table           |
| Zustand        | State management             |
| Milkdown       | Markdown editor              |
| Excalidraw     | Drawing editor               |
| Shiki          | Syntax highlighting          |
| Zod            | Schema validation            |
| Tailwind CSS 4 | Styling                      |

## Development

Loxel supports separate dev and production environments that can run simultaneously.

### Dev mode

```bash
bun run dev             # Server (port 7434) + Vite HMR (port 5173)
bun run dev:server      # Bun server with --watch
bun run dev:client      # Vite dev server only
```

Dev mode is activated by `LOXEL_DEV=1` (set automatically by the dev scripts). It uses a separate state directory (`~/.local/state/loxel/loxel-dev/`) and localStorage prefix (`loxel-dev-*`) so it won't conflict with a running production instance. The UI shows a red "DEV" badge in the top bar.

### Production mode

```bash
bun run build           # Build client + server to dist/
bun run start           # Run the built server (port 7433)
bun run prod            # Build + start in one command
```

Individual build targets: `bun run build:ui` (Vite client only), `bun run build:server` (Bun server only).

### Desktop app (Electron)

Loxel can run as a desktop app via Electron. The Electron shell spawns the Bun server as a child process and opens a window pointing to `http://127.0.0.1:<port>`. Server/renderer traffic runs over WS + REST; Electron IPC is used only for a small set of native integrations.

**IPC channels** (main → renderer, exposed via `contextBridge` as `window.electronAPI`, constants in `src/electron/ipc-channels.ts`):

- `open-in-browser-tab` — Cmd+click on an external link in the renderer opens it in a Loxel browser panel tab instead of the system browser.
- `set-dock-badge` — renderer pushes the unread-notification count to the macOS dock badge.
- `window:focus-change` — main sends `true` / `false` on `BrowserWindow` focus/blur so the renderer can reflect OS-level window activation (consumed via the `useWindowFocused()` hook; the top bar tints to `bg-surface-muted` when the window is inactive). This is driven by `BrowserWindow` focus, not DOM focus, so clicking into a `<webview>` browser panel does not register as a blur.

**First-click-to-focus**: the `BrowserWindow` is created with `acceptFirstMouse: true`, so a click on a backgrounded Loxel window both activates the window _and_ reaches the renderer — the clicked panel takes focus on the same click instead of requiring a second one.

```bash
bun run dev:app           # Electron window with Vite HMR
bun run build:app         # Build standalone server + renderer + package DMG/zip
```

`build:app` runs two steps: compiles the server to a standalone binary (`bun build --compile`), builds the renderer with Vite, and packages everything with electron-builder. Output goes to `release/`.

### Type check

```bash
bun run typecheck
```

The server accepts an optional repo path argument: `bun run src/server/index.ts /path/to/repo`. Defaults to the current directory.

## Performance Monitoring

Always-on, low-overhead monitoring runs across all three processes. Metrics are emitted as structured log entries with `cat: "perf"` through the existing logging pipeline. Periodic summaries are logged at `debug` level (file + ring buffer only, no WebSocket broadcast). Anomalies (long tasks >200ms, low FPS, high memory, event loop lag) escalate to `warn`/`error`.

**Renderer** (`src/lib/perf-monitor.ts`): FPS via `requestAnimationFrame` counter, long tasks via `PerformanceObserver`, event loop lag via `MessageChannel` round-trip, JS heap via `performance.memory`. Summary flushed every 5s.

**Electron main process** (`src/electron/main-perf-monitor.ts`): Per-process CPU/memory via `app.getAppMetrics()`, main process heap via `process.memoryUsage()`, event loop lag via `setTimeout` drift. Summary flushed every 10s.

**Server** (`src/server/server-perf-monitor.ts`): Event loop lag via `setTimeout` drift, memory via `process.memoryUsage()`. Summary flushed every 10s.

View metrics in the Logs panel filtered by category "perf", or in the NDJSON log files under `logs/`.

## Data Storage

All server-side state lives under `~/.local/state/loxel/loxel/` (production) or `~/.local/state/loxel/loxel-dev/` (dev mode):

- **Layout & UI preferences**: `localStorage` (browser), per project + worktree combination. Keys prefixed `loxel-*` (prod) or `loxel-dev-*` (dev)
- **Reviews & comments**: `comments/{repo-hash}.db` (SQLite, shared across worktrees)
- **Detached files (Drafts)**: `detached/{project-hash}/{worktree-hash}/` — markdown and excalidraw files created via the editor, scoped per project + worktree. Moved into the project tree via drag-and-drop
- **Projects**: `projects.json`
- **Server logs**: `logs/server-{instanceId}.log` (NDJSON, per-instance to avoid contention when multiple instances run concurrently; rotated at 5 MB; stale files from dead instances cleaned up after 24h)
