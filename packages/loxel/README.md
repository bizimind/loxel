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
- **Worktree sidebar** — view and switch between worktrees, in bare and regular repos alike (managed by `wt`, under `.worktrees/`)
- **Keyboard** — `⌃⌥[` / `⌃⌥]` go back / forward through recently visited worktrees across all projects, `⌃⇧`+arrow moves focus into the sidebar and up/down its entries (Enter switches), `⌃⌥B` collapses/expands it; see [Keyboard Shortcuts & Focus Navigation](#keyboard-shortcuts--focus-navigation)
- **Worktree context menu** — right-click a worktree to copy its name, branch name (disabled for a detached HEAD) or absolute path, hide/show it in the collapsed icon rail (hidden worktrees stay dimmed in the expanded list), or remove it
- **Sidebar sizing** — collapses to an icon rail or expands to a list; when expanded, drag its right edge to resize (200–560px, double-click to reset). The width is global, not per worktree, and is persisted with the other sidebar preferences
- **Per-context layouts** — each project + worktree combination remembers its own panel layout, so switching back restores exactly where you left off
- **Cross-worktree awareness** — see dirty status across all worktrees of the same repo at a glance
- **Shared review database** — code review comments are stored per-repo (keyed by git's common dir), so reviews are visible from any worktree

### Planning & Ideation

Tools for thinking and communicating before (and during) agent work:

- **Markdown editor** — Milkdown/Crepe-based rich editor with CodeMirror syntax highlighting. Persisted to disk as `.md` files with capped debounced autosave (250ms idle / 5s max wait). Saves are source-preserving: the serializer output is reconciled against the text the file was loaded from, top-level block by top-level block, and every block whose content is unchanged is written back with its original bytes (list markers, heading style, emphasis markers, blank-line runs, link reference definitions), so an edit only rewrites the blocks it touches. The reconciliation is validated by re-parsing and falls back to the full canonical serialization if the preserved text would parse differently; editing anywhere inside a block (for example one list item) still rewrites that whole block in canonical form. Programmatic content updates (own save echoes, external disk changes, auto-merges) are skipped when the markdown already matches the live document and otherwise replace only the changed region so the caret keeps its place; they are excluded from undo history. Search results navigate to the matched position using remark AST source-position mapping with ordinal text-node matching. Tables size columns to content (no persisted widths — markdown cannot store them), wrap long cells at ~42 characters, may extend into the right prose padding, and scroll horizontally beyond that; the header row is bold, full-brightness text with a stronger divider (no background tint), body rows are plain with dividers only (no zebra striping), and cell alignment follows the markdown alignment markers. `:::localdb` fenced blocks render as database widgets; lines inside the fence the widget does not understand are preserved verbatim (an unclosed fence keeps everything it swallowed inside the block rather than dropping it), other `:::name` / `::name` directives are shown as plain text, and inline `:name` directives are never parsed so prose like `10:30am` is left untouched. If a disk change cannot be parsed, the editor keeps its current document and logs a warning; if an auto-merge cannot be applied, the file falls through to the conflict banner
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
- **Pixel-perfect block art** — the WebGL renderer (`@xterm/addon-webgl`) draws block elements and box-drawing characters as custom glyphs, so ASCII art like the Claude Code mascot renders seamlessly at every zoom level. A Vite transform (`xtermWebglPixelGrid` in `vite.config.ts`) snaps the addon to the device pixel grid like Ghostty: cell width is rounded (not floored) from the font's advance, and block element edges land on whole pixels. Chromium allows ~16 live WebGL contexts per window, so a terminal holds one only while its panel is visible (`src/components/terminal/webgl-renderer.ts`): hidden tabs release it and use the DOM renderer, and re-acquire it when shown. More than ~16 visible terminals, a lost context or missing WebGL fall back to the DOM renderer. The terminal opens only after its font faces load, since the cell grid and glyph atlas are built from the font at open
- **Multiple tabs** in the same panel group (`Cmd+T` to create)
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
- **Intra-line highlights** — modified lines (blue) additionally mark the changed characters in red and green, using the VS Code diff heuristics bundled with Monaco; applies to the side-by-side, split, and unified views
- **Gutter connector** SVG showing line relationships between panels
- **Split and unified** view modes
- **Server-resolved bases** — both panes use the exact commit that produced the diff, including
  worktree-specific `HEAD` values and merge bases for three-dot ranges
- **Hunk-level staging** — stage or unstage individual hunks directly from the diff view

### TypeScript Language Intelligence

All per-file TS/JS language features are delivered by the official TypeScript 7 native language server (`tsc --lsp -stdio`) in a subprocess per worktree, proxied to Monaco over a WebSocket at `/ws/ts-lsp` via the `monaco-lsp-client` package. No TypeScript runs on Bun's JS thread.

- **Project diagnostics** — the `GET /api/diagnostics` endpoint shells out to the `tsc` CLI against a committed ref or the working tree and caches results per-commit. Used by the diff viewer and the project-wide diagnostics query
- **Per-file diagnostics** — pushed by TypeScript over LSP (`textDocument/publishDiagnostics`) and rendered as Monaco markers by `LspDiagnosticsFeature`
- **Hover, go to definition, find references, completions, rename, code actions, inlay hints, signature help, document symbols, folding ranges** — delivered via the corresponding `Lsp*Feature` registered by `MonacoLspClient`. Cmd-click/F12 jumps open a new editor tab via `registerEditorOpener` (see `monaco-env.ts`), not Monaco's inline peek widget
- **Semantic highlighting** — provided when TypeScript returns semantic tokens; TS files otherwise fall back to Monarch syntactic highlighting
- **Unused variable dimming** — TypeScript emits these as diagnostics with the appropriate tag, surfaced by `LspDiagnosticsFeature` via `MarkerTag.Unnecessary`
- **LSP stderr rate-cap** — every `StdioLspManager` subprocess (TS, terraform-ls, etc.) drains stderr through a per-session token-bucket throttle (200-line burst, 50 lines/sec steady-state). Chatty servers can't flood the shared log ring buffer or rotating log file; dropped lines are counted and summarized periodically at `debug` level

**LSP lifecycle**: TypeScript is connected eagerly when a worktree becomes active, since most worktrees have TS/JS files. `terraform-language-server`, `docker-language-server`, `pyright` (Python), and `@astrojs/language-server` (Astro) are expensive to spawn (they walk the workspace) and most worktrees don't need them, so they are lazy-connected: the subprocess is only started when a model of the matching language (`terraform`, `dockerfile`/`dockerbake`, `python`, or `astro`) first appears in the active worktree, and disconnected when the last such model is disposed. Switching worktrees re-evaluates the count so the LSP follows the active scope. See `createLazyLspConnector` in `src/lib/monaco-env.ts`.

### Git Operations

Full git client via context menus and inline forms:

- **Commit graph** — interactive DAG with branch/tag labels, multi-select, search with filters (branch, author, date range, file paths), and an "uncommitted changes" virtual row
- **Changes panel** — defaults to showing local changes (staged + unstaged + untracked) when no commits are selected. Includes a branch commit dropdown for selecting the commits this branch adds on top of the repository's default branch (`merge-base(default, HEAD)..HEAD` — the same range a pull request shows, so a branch stacked on another reports its whole range), with multi-select, "All branch changes" shortcut, and bidirectional sync with the Git graph
- **Staging** — file-level and hunk-level staging, unstaging, discard
- **Commits** — create, cherry-pick, revert (single and multi-select)
- **Branches** — create, delete, rename, checkout, favorites, upstream tracking (ahead/behind)
- **Reset** — soft, mixed, hard to any commit
- **Stash** — create, apply, pop, drop
- **Worktree status** — dirty status across all worktrees. The active worktree updates live from its own watchers; the others are re-read after commits, checkouts and worktree add/remove, and at most every 5 seconds while you work in the active one (see [WATCHERS.md](WATCHERS.md#status-refresh-pipeline))

### Code Editor & File Explorer

Standard IDE editing experience built on Monaco Editor:

- **Syntax highlighting** for all major languages, code folding, line numbers, glyph margin
- **TypeScript diagnostics** — real-time type errors and warnings from TypeScript shown as inline markers
- **Quick Open** (`Cmd+P`) — fuzzy file path search with file icons, MRU list, and go-to-line via `:line` suffix. Search results (`Cmd+Shift+F`) navigate directly to the matched line and column
- **Command Palette** (`Cmd+Shift+P`) — fuzzy search across all registered actions with keyboard navigation (arrow keys, Enter to execute), showing each action's bindings (chords included). Internal actions (tree navigation, the palette itself) are hidden via `hidden: true` on `ActionDef`
- **Autosave** with capped debounce (250ms idle / 5s max wait), `Cmd+S` to save immediately, `Cmd+W` to close
- **Format on save** — auto-detects project formatters (oxfmt, prettier, rustfmt, ruff, etc.) from config files and `package.json`. oxfmt covers everything it can format (TS/JS, CSS/SCSS/Less, JSON, Markdown, YAML, TOML, HTML, Vue, GraphQL), not just JS/TS; when a project has both a prettier config and oxfmt, prettier takes precedence for the extensions it claims. Formats on explicit save (`Cmd+S`) by default; optional format-on-auto-save. Persistent formatter backends (LSP for oxfmt, library import for prettier) eliminate per-request process spawn overhead. Configurable via Settings > Editor.
- **Conflict detection** — when a file changes on disk (e.g. by an agent), a banner lets you accept the disk version or keep your edits
- **File tree** — project files panel with git status coloring (modified, untracked, ignored), expandable folders, double-click to open in editor. Keyboard navigation is command/keybinding driven: Arrow Up/Down move between rows, Arrow Right expands or enters a directory, Arrow Left collapses or jumps to parent, Space toggles expand/collapse, Enter opens, and F2 / Shift+F6 renames. Right-click a file or folder to copy its name, its path relative to the worktree (or to the Others folder holding it; not offered for tree roots, drafts or individually opened Others files) or its absolute path. Shared `FilesTree` component powers both the project files and changes panels
- **Reveal in Finder / Open In** (macOS) — right-click a file or folder in the project files panel, a worktree in the sidebar, or a file tab (code, markdown, Excalidraw, media) to reveal it in Finder or open it in another app. For files, the "Open In" submenu lists the apps macOS offers for that file type (the Finder "Open With" list): the system default first, then the rest by name, with their app icons; apps bundled inside other apps (e.g. Xcode's Instruments) are hidden. For folders and worktrees, macOS's own list is not useful (Finder, media players, archivers), so the submenu offers a curated list of developer apps found in `/Applications`, `~/Applications` or `/System/Applications/Utilities`: terminals (Terminal, iTerm, Ghostty, Warp), then editors (VS Code, Cursor, Windsurf, Zed, Sublime Text, JetBrains IDEs, Android Studio). Only paths Loxel manages (inside an open project's repo or worktrees directory, drafts, opened external files) can be revealed or opened, and only with an app the menu offered
- **Other folders** — folders outside every project open in the file tree's **Others** section (alongside individually opened outside files) via `loxel <folder>`, Cmd+click on a folder path in a terminal, or a folder link in markdown. A folder inside a registered worktree is revealed there instead, switching worktrees if needed; folders containing a project, `/` and the home folder are refused, and paths are resolved through symlinks; `loxel <folder>` goes to the window whose terminal ran it (`LOXEL_WINDOW_ID`; windows identify themselves over the WebSocket), otherwise to the most recently focused window. Each worktree's list of Others folders is persisted server-side (`stores.db`, key `external-folders:<worktree>`, deleted when the worktree is removed in-app). Each folder's listing is shared server-wide (`ExternalFolderRegistry`): one git-free `ProjectFilesService` per folder, live while any subscribed worktree lists it, whose changes are pushed to every such worktree and whose expanded directories stay watched until every worktree has collapsed them. File operations stay per worktree: each worktree gets its own git-free `FileOperationsService` per folder (no `git mv`/`rm`), so undo/redo only ever touches that worktree's own operations, and requests resolve to the requesting worktree's services; the client re-reads Others directories when loading them, so switching worktrees never shows a stale listing. The Others section is part of the same `FilesTree` as the worktree (extra roots after it), so selection, keyboard navigation, reveal and file operations are shared; file operations stay within their folder, individually opened Others files are read-only in the tree, and undo/redo is ordered across the worktree and its folders by the worktree's `FileOperationsHistory`. Format on save, Quick Open, search and diagnostics stay worktree-only; lazily spawned language servers also start for files outside every project. Right-click a folder root → **Remove from Others** to close it
- **Open from Finder and `loxel <file>`** (macOS) — the app declares itself an _Alternate_ handler (`CFBundleDocumentTypes` in `electron-builder.yml`) for text and source files (`public.text` plus extensions macOS may lack a text type for, e.g. `.md`, `.ts`), `.excalidraw` and folders. Finder then offers it in "Open With" (folders have no such menu, but can be dropped on the Dock icon or opened with `open -a Loxel`) without displacing an existing default app; types no other app claims (e.g. `.excalidraw`, `.tf`) open in Loxel on double-click. The Electron main process receives these as `open-file` events (queued until the startup window exists, opening a window if all are closed) and posts each to `POST /api/open` — the same request `loxel <path>` sends (`src/open-request.ts`, retrying the "no window yet" 503 for up to 30s). The server refuses anything but regular files and folders, and sends them to one window: the one whose terminal ran the CLI (`LOXEL_WINDOW_ID`), else the most recently focused. In that window `openFile` (`src/lib/open-path.ts`) opens a file inside a registered worktree in that worktree, switching to it if needed, and anything else in the active worktree's Others section. It opens the file at once only when the center dockview is mounted for the target worktree (`getCenterApiWorktree`); across a switch, or before the editor area first mounts, the file is queued in the worktree's UI store and opened when a center layout next mounts for that worktree. Declaring the file types is part of the `.app` bundle, so it reaches users with a new app download, not the in-app update

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
- **Rename from the tab** — right-click a terminal or file tab (code, markdown, Excalidraw, media) → **Rename**, or double-click its title, to edit the name inline (Enter commits, Escape or an unchanged name cancels). A terminal rename changes its tab title, which is saved with the layout. A file rename renames the file on disk like the file tree does, so it is offered for files in the worktree, its Drafts and its Others folders but not for individually opened Others files; the reopened tab keeps its place and active state, and a refused rename (e.g. the name already exists) shows an error toast
- **Per-panel error boundaries** — every panel is wrapped with a `react-error-boundary` at the registration level (`wrapPanelComponents`), so a render error in one panel shows an inline fallback (panel icon, error message, retry button) without crashing the rest of the app. Errors are logged to the frontend structured logger

### Keyboard Shortcuts & Focus Navigation

Every action lives in the action registry (`src/store/keybindings/action-registry.ts`); default bindings are in `keybinding-schema.ts` and can be remapped in Settings > Keybindings. A binding is a single key combo or a chord of up to three keystrokes (press the first, release, press the next). The arrow-key layers stay clear of macOS text editing, Monaco's defaults and Rectangle's `⌃⌥`+arrow snapping; Delete Worktree has no default key because Rectangle's Restore takes `⌃⌥⌫` (run it from the command palette or the worktree context menu). A test keeps the defaults off these reserved keys:

| Action                                                                                              | Default                                                                                   |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Move focus between groups, tool bars, the worktree sidebar and the bottom panel                     | `⌃⇧` + arrow                                                                              |
| Switch tabs within the active group                                                                 | `⌘⇧[` / `⌘⇧]`, `⌃Tab` / `⌃⇧Tab`                                                           |
| Move the active tab to the adjacent group (new split at the edge)                                   | `⌃⌘` + arrow                                                                              |
| New terminal / agent / markdown / drawing / browser tab                                             | `⌘T` / `⌘⇧A` / `⌘⇧M` (or `⌘N`) / `⌘⇧D` / `⌘⇧B`                                            |
| Split the active panel (same type)                                                                  | `⌘\` then arrow                                                                           |
| Split as a new panel type                                                                           | `⌘\` then `T` terminal / `A` agent / `M` markdown / `D` drawing / `B` browser, then arrow |
| New tab of a panel type in the active group                                                         | `⌘\` then the type letter, then `Enter`                                                   |
| New tab of the active panel's type                                                                  | `⌘\` then `Enter`                                                                         |
| Move the active tab into a new split                                                                | `⌘\` then `⇧` + arrow                                                                     |
| Worktree back / forward                                                                             | `⌃⌥[` / `⌃⌥]`                                                                             |
| Switch to worktree 1–8, last, 10 of the active project (sidebar order, hidden worktrees skipped)    | `⌃⌥1`–`⌃⌥8`, `⌃⌥9`, `⌃⌥0`                                                                 |
| New worktree                                                                                        | `⌃⌥N`                                                                                     |
| Collapse / expand the worktree sidebar (keeps the sidebar cursor when it has focus)                 | `⌃⌥B`                                                                                     |
| Collapse / expand the focused area (worktree sidebar, or the side zone of the focused panel / icon) | `⌃⇧Space`                                                                                 |
| Find in the focused browser page or terminal / next / previous match                                | `⌘F` / `⌘G` / `⇧⌘G`                                                                       |

- **Chords** — while a chord is in progress the status bar shows the keys typed so far; Escape, a key that continues no chord, leaving the window or a 3 s pause cancels it. Later steps also match with `⌘` still held from the leader (`⌘\` then `⌘→`). A single-key binding takes precedence over a chord with the same first key, and remapping removes overlapping bindings (equal, or a chord prefix) from other actions. Key auto-repeat never advances a chord. While Option is held and macOS composes a character (Option+N types `˜`), the physical key is used instead. In Settings, a chord must start with `⌘`, `⌃` or `⌥`, and tree keys can't be chords
- **Focus navigation** (`src/lib/focus-navigation.ts`) — `⌃⇧`+arrow walks the window left to right: worktree sidebar ⇄ left tool bar ⇄ center panels ⇄ right tool bar. In the center, arrows move between groups (tabs are switched with `⌘⇧[ ]` / `⌃Tab`); leaving the center's left or right edge enters that side's tool bar, and leaving its bottom edge enters the bottom zone's panel when that zone is expanded (`⌃⇧↑` from inside that panel returns to the center). In a tool bar, up/down walk the icons (the left bar lists the left zone, then the bottom zone below the divider): landing on an icon of an expanded zone shows that panel and focuses its content, landing on an icon of a collapsed zone focuses just the icon (Enter/Space expands it). Entering a tool bar lands on its open panel, else its topmost icon. Entering the worktree sidebar lands on the active worktree; up/down move a cursor over the visible entries (project roots and the worktrees of expanded projects, so hidden worktrees are skipped in the collapsed rail) and Enter switches. Plain ↑/↓ also work on a focused icon or sidebar entry, and Escape returns focus to the center. `⌃⇧Space` collapses or expands whatever holds focus: the worktree sidebar (the cursor stays on its entry, as with `⌃⌥B`), or the zone of the focused panel or icon (collapsing leaves focus on the icon, expanding focuses the panel). In the center it is not handled at all, so the key reaches the focused terminal or editor — actions can declare where they apply with `ActionDef.isEnabled`, and a disabled action's key resolves as unbound. The current area is read from DOM focus, so mouse clicks and keyboard navigation agree
- **Panel focus targets** — a panel takes focus through the function it passes to `usePanelActivationFocus` (registered in `src/lib/panel-focus.ts`, so an already-active panel can be re-focused), else its `panelAutofocusProps()` element (`src/lib/focus-targets.ts`; file trees focus their selected row), else its first tabbable element. Toggling a side panel with its shortcut or icon focuses it when it opens and returns focus to the center when it closes while focused
- **Find in panel** (`src/lib/find-targets.ts`, `src/hooks/usePanelFind.ts`) — browser panels and terminals register their root element as a find target; the `find.open` / `find.next` / `find.previous` actions (`⌘F` / `⌘G` / `⇧⌘G`) are enabled only while focus is inside one, so elsewhere the keys reach the focused widget (e.g. Monaco's own find widget; the markdown editor has no find yet, #375). Both panels show the shared floating `FindBar` (Enter / `⇧`Enter step through matches, Escape closes it and returns focus to the content, and reopening keeps the last query). Browser panels search with Chromium's native find (`<webview>.findInPage`, match counts from `found-in-page`, cleared when the page navigates); terminals use xterm's search addon, whose match highlights need the terminal's `allowProposedApi` option. While a page has focus, the page never sees `⌘F` / `⌘G` / `⇧⌘G`, so web apps with their own find shortcut (Google Docs, github.dev) get Loxel's find bar instead
- **Worktree history** (`src/store/worktree-history.ts`) — back/forward work like a browser's, across all projects: every switch of the active worktree (click, shortcut, command, opening a file elsewhere) pushes the previous one onto the back stack and clears the forward stack; worktrees that no longer exist are skipped. History is kept per window and not persisted
- **Inside browser panels** — keys typed in a `<webview>` go to the guest page, never the window's document. The renderer tells the main process which keystrokes to intercept (`keybindings:set-interception`): the first keystroke of every non-tree binding enabled where focus is, or every keystroke while a chord is in progress. The main process withholds those from the page and forwards them back (`keybindings:webview-keystroke`), where they are resolved like document keys. The set is re-sent whenever focus moves (on `focusin`; when the main process reports a webview gaining focus via `keybindings:webview-focused`, since that fires no `focusin` in the host document; and, as a fallback, one tick after a `focusout` or window `blur`) or a find target is registered or removed, so a context-disabled key (e.g. `⌃⇧Space` while the webview has focus) is never taken from the page

### Status Bar

Branch info, upstream tracking (ahead/behind), working tree status counts (staged, modified, untracked, conflicts), loading indicator, pending keyboard chord, and terminal launcher.

## Architecture

### Client-Server Model

**Server** (Bun, port 7433 prod / 7434 dev):

- REST API for git operations, file content, project management, server log history (`GET /api/logs`), and file index for quick-open search (`GET /api/file-index`)
- Static file serving from `dist/` in production (single-process deployment)
- WebSocket for real-time updates (file watcher, terminal I/O, agent events, server log streaming)
- SQLite databases for reviews/comments and project metadata
- PTY manager for terminal sessions with scrollback buffers
- Agent manager for coding agent subprocess lifecycle
- TypeScript LSP subprocess manager (`TsLspManager` spawns `tsc --lsp -stdio` per worktree) proxied to the frontend over `/ws/ts-lsp`
- LaunchServices helper for "Open In" (`/api/open-in/*`, macOS): file app lists and app icons come from `NSWorkspace` via `bun:ffi`, which runs in a separate helper process (the server's own executable started with `--launch-services-helper`, dispatched in `src/server/index.ts`), so a crash in native code only kills the helper. `LaunchServicesClient` starts it on first use, talks JSON lines over stdio, restarts it on the next request after a crash or a 10 s timeout, and stops it after 60 s idle. App lists are cached per file type (lowercased extension, or the executable bit for extension-less files) for 60 s; icons are cached per app bundle until it changes, and are only served for apps an app list returned. Folder apps (`folder-apps.ts`) are plain file-system checks of a curated list and never use the helper. Reveal and open go through `/usr/bin/open`, and the POST routes only accept `Content-Type: application/json` so other web pages can't trigger them with a simple cross-site form post
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

**IPC channels** (main → renderer unless noted, exposed via `contextBridge` as `window.electronAPI`, constants in `src/electron/ipc-channels.ts`):

- `open-in-browser-tab` — Cmd+click on an external link in the renderer opens it in a Loxel browser panel tab instead of the system browser.
- `set-dock-badge` — renderer pushes the unread-notification count to the macOS dock badge.
- `keybindings:set-interception` (renderer → main) / `keybindings:webview-keystroke` and `keybindings:webview-focused` (main → renderer) — keep app shortcuts working while a browser panel's webview has focus (see [Keyboard Shortcuts & Focus Navigation](#keyboard-shortcuts--focus-navigation)).
- `window:focus-change` — main sends `true` / `false` on `BrowserWindow` focus/blur so the renderer can reflect OS-level window activation (consumed via the `useWindowFocused()` hook; the top bar tints to `bg-surface-muted` when the window is inactive). This is driven by `BrowserWindow` focus, not DOM focus, so clicking into a `<webview>` browser panel does not register as a blur.

**Passkeys in browser panels (macOS)**: Electron's Touch ID platform authenticator is enabled with `app.configureWebAuthn` (`src/electron/webauthn.ts`), so sites in a `<webview>` browser panel can create and use passkeys with Touch ID instead of only security keys. Credentials are stored in the Secure Enclave under the keychain access group `JJ88G244AR.com.bizimind.loxel.webauthn`, which `assets/entitlements.mac.plist` grants. Because `keychain-access-groups` is a restricted entitlement, the build must embed a Developer ID provisioning profile that includes Keychain Sharing for the App ID: the release workflow decodes the `LOXEL_PROVISIONING_PROFILE` secret and passes it to electron-builder, and `build:app` / `build:app:local` (both via `scripts/build-app.ts`) embed `build/embedded.provisionprofile` when present and otherwise sign with `assets/entitlements.mac.unprovisioned.plist`, producing an app that launches but has passkeys disabled. Dev runs and unprovisioned builds configure nothing, so passkeys are simply unavailable there. When a site matches several passkeys, the main process shows a native chooser (`select-webauthn-account`); passkeys already in iCloud Keychain are not reachable, since Apple grants that only to approved browsers.

**Browser panel focus without reload**: re-attaching a `<webview>` to the DOM reloads its page, and dockview's `panel.api.setActive()` re-attaches the content of a panel that is already its group's active tab. Keyboard focus navigation and "open existing panel" paths therefore go through `activatePanel()` (`src/store/layout-actions.ts`), which activates the group instead in that case, and the browser panel moves keyboard focus into the webview on activation. Browser panels are also created with dockview's `renderer: "always"` (older saved layouts are upgraded on mount), so hidden tabs stay attached with `visibility: hidden` and moves between groups only reposition the overlay — neither reloads the page. Adding an always-rendered panel as a background tab (layout restore, group merges, the renderer upgrade) makes dockview detach the group's visible content, so `CenterHost` calls `reattachActiveContent()` after restores and panel moves. Switching worktrees still rebuilds the layout and reloads browser panels.

**First-click-to-focus**: the `BrowserWindow` is created with `acceptFirstMouse: true`, so a click on a backgrounded Loxel window both activates the window _and_ reaches the renderer — the clicked panel takes focus on the same click instead of requiring a second one.

```bash
bun run dev:app           # Electron window with Vite HMR
bun run build:app         # Build standalone server + renderer + package DMG/zip
```

`build:app` runs two steps: compiles the server to a standalone binary (`bun build --compile`), builds the renderer with Vite, and packages everything with electron-builder. Output goes to `release/`.

**Releases**: `release-loxel.yml` bumps the patch version, builds, and publishes on every merge to main that touches `packages/loxel/**`. For changes outside the package that still affect the app (e.g. root lockfile or dependency overrides), trigger it manually with `gh workflow run release-loxel.yml --ref main`. After publishing the manifest, the release dispatches `release-site.yml` so the site's download page (which reads the manifest at build time) shows the new version.

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
