# Loxel

The professional workspace for AI-powered development. Loxel is built for developers who orchestrate many coding agents at once: each task gets its own worktree, terminals (and the agents in them), browser tabs, editors, and layout, and one window shows them all. Agents write most of the code, but people still own what ships, so the editor, language servers, diffs, Git graph, and code review stay one click away.

The user documentation lives in the site package ([`packages/site/src/content/docs/`](../site/src/content/docs/), published at https://bizimind.io/docs). This README is the entry point for working on the app itself.

## Why

- **Task context at scale** — every task keeps its worktree, terminals, browser tabs, editors, and layout; agents can start nested subtasks, and a dot shows which task's agent has pinged you
- **Ownership** — look closely where it counts: navigate, read, and review the code you're accountable for without leaving the task
- **Bring your own agents** — Claude Code, Codex, OpenCode, or any terminal agent runs in Loxel's terminals as is
- **Task-scoped tools** — browsers, terminals, previews, and drafts belong to the task they were opened in
- **Agent-to-workspace** — the `loxel` CLI lets agents open files, pages, and terminals in the user's window

## Core Concepts

- **Projects and worktrees** — manage several repositories and their worktrees (bare or regular repos, managed by `wt` under `.worktrees/`) from one window and switch between them instantly. Each project + worktree combination keeps its own panel layout, and dirty status is visible across all worktrees of a repo. See [Worktrees & Tasks](../site/src/content/docs/worktrees-and-tasks.md).
- **Panels** — a Dockview layout with center panels (editors, diffs, markdown, Excalidraw, terminals, browser) and dockable tool panels in the left, right and bottom zones (project files, changes, comments, git graph, logs). Everything is reachable from the keyboard and remappable. See [Panel Layout](../site/src/content/docs/panel-layout.md) and [Keyboard Shortcuts](../site/src/content/docs/reference-keybindings.md).
- **Terminals** — xterm.js terminals backed by server-side PTYs, for CLI agents (Claude Code, Codex, etc.) and everyday commands. Sessions survive project and worktree switches, and `loxel terminal` opens a terminal panel and runs a command in it. See [Terminals](../site/src/content/docs/terminals.md).
- **Browser panels** — web pages in `<webview>` tabs, in tasks and in Home (the layout shown with no worktree), with bookmarks, a right-click menu, find in page, page dialogs (`alert`/`confirm`/`prompt`) shown in the panel, and passkeys on macOS, with Touch ID or from your phone by QR code.
- **Editor and file explorer** — Monaco with Quick Open, Go to Symbol across the language servers, find in files, command palette, autosave, format on save with auto-detected project formatters, and conflict detection when files change on disk. Folders and files outside every project open in the file tree's Others section. See [Editor](../site/src/content/docs/editor.md).
- **Language intelligence** — TypeScript 7 (`tsc --lsp`) per worktree for TypeScript and JavaScript, with a project's ESLint, oxlint or Biome next to it, and a shared, always-running YAML server, plus lazily started servers for other languages (Python with basedpyright, Ruff and mypy, its environment detected per worktree or chosen in an interpreter picker; Go with gopls and golangci-lint; Rust through the user's rust-analyzer; C and C++ with clangd; Java with Eclipse JDT LS on the user's JDK; C# through the user's csharp-ls; Kotlin lint diagnostics from detekt and ktlint; TOML, Docker, Terraform, Astro, XML), proxied to Monaco over WebSockets. Servers run a repository's own code only once the user trusts the repository. See [Language Intelligence](../site/src/content/docs/language-intelligence.md); to add a language, follow the [add-language-server skill](../../.agents/skills/add-language-server/SKILL.md).
- **Diff viewer** — side-by-side (JetBrains-style synchronized scrolling), split and unified Monaco diffs with intra-line highlights, for git changes and for comparing any two files with both sides editable. See [Diff Viewer](../site/src/content/docs/diff-viewer.md).
- **Code review** — local review sessions with comment threads anchored to code ranges that survive edits, stored per repo and shared across its worktrees. See [Code Review](../site/src/content/docs/code-review.md).
- **Git** — commit graph, changes panel, branches, cherry-pick, revert, reset and discard changes from context menus and inline forms. There is no staging or commit UI. See [Git](../site/src/content/docs/git.md).
- **Planning** — a rich markdown editor (Milkdown) and an Excalidraw canvas, saved to disk with autosave. New files start as Drafts outside the repo and can be dragged into it. See [Drafts](../site/src/content/docs/drafts.md).
- **macOS integration** — open files and folders from Finder or with `loxel <path>`, Reveal in Finder / Open In from context menus, and Loxel as the default web browser.

## Architecture

Three processes:

- **Server** (Bun, `src/server/`, entry `src/server/index.ts`) — REST API and WebSocket (file watching, terminal I/O, log streaming, LSP proxies), git commands, PTY sessions, language server subprocesses, SQLite storage, and static serving of the built renderer. One server per mode (port 7433 prod, 7434 dev, 7435 + n for demo instance n) is shared by every window.
- **Renderer** (React 19, Vite, `src/`) — Zustand stores (`src/store/`) persisted to the server, TanStack Query for server data (`src/queries/`), shared request/response and WebSocket models (`src/api/`), Monaco, xterm.js, Dockview, Milkdown and Excalidraw components (`src/components/`).
- **Electron shell** (`src/electron/`) — runs the server for as long as the app runs, opens windows on its URL, handles native integrations and updates the app. See [docs/ELECTRON.md](docs/ELECTRON.md).

The `loxel` CLI (`src/cli.ts`) talks to a running server to open files, folders, URLs and terminals.

Always-on performance monitors in all three processes (`src/lib/perf-monitor.ts`, `src/electron/main-perf-monitor.ts`, `src/server/server-perf-monitor.ts`) log summaries and anomalies with `cat: "perf"`; filter the Logs panel or the server log files by that category.

## Development

Run these from `packages/loxel` (or with `pnpm -C packages/loxel run <script>`). Dev and production instances can run side by side.

```bash
pnpm run dev              # Dev server (port 7434) + Vite HMR (port 5173)
pnpm run dev:server       # Dev server only, with --watch
pnpm run dev:client       # Vite only
pnpm run dev:app          # Electron window with Vite HMR

pnpm run build            # Build renderer + server to dist/
pnpm run start            # Run the built server (port 7433)
pnpm run prod             # build + start

pnpm run build:app        # Standalone server + renderer, packaged with electron-builder into release/
pnpm run build:app:local  # Same, unpacked arm64 macOS app only
pnpm run build:cli        # loxel CLI binary in build/
pnpm run demo             # Demo app with the demo projects, to look around
pnpm run demo:shots       # Capture the site's screenshots in hidden demo apps

pnpm run test             # Unit tests (bun test)
pnpm run e2e              # Playwright tests against an isolated server
pnpm run typecheck
```

Dev mode (`LOXEL_DEV=1`, set by the dev scripts) uses its own state directory and port and shows a red "DEV" badge in the top bar. The server takes an optional repo path to register as a project: `bun src/server/index.ts /path/to/repo`.

To run a second web dev instance beside one already on the default ports (for example from another worktree), give it its own ports and state directory: `LOXEL_SERVE_PORT=7444 LOXEL_VITE_PORT=5183 LOXEL_STATE_DIR=~/.local/state/loxel/loxel-dev-2 pnpm run dev`, then open `http://127.0.0.1:5183`.

Demo mode (`LOXEL_DEMO=1`, set by the demo scripts) runs beside the installed app with its own port, state and data directories, and shows no badge; it stages the site's screenshots from generated demo projects. See [scripts/demo/shots.md](scripts/demo/shots.md) for the shot list and [docs/ELECTRON.md](docs/ELECTRON.md#demo-mode) for how it differs from dev mode.

### Environment variables

| Variable              | Purpose                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------- |
| `LOXEL_DEV`           | `1` for dev mode: dev state directory and port 7434                                                 |
| `LOXEL_DEMO`          | `1` for demo mode: demo state and data directories and port 7435 + n                                |
| `LOXEL_DEMO_INSTANCE` | Which demo app (default 0), so several run at once: port 7435 + n and its own state                 |
| `LOXEL_DEMO_HIDDEN`   | `1` for a demo window that never shows itself, for captures                                         |
| `LOXEL_STATE_DIR`     | Override the state directory (see [Data storage](#data-storage))                                    |
| `LOXEL_SERVE_PORT`    | Override the server port (standalone server and Vite's proxy only; the app uses 7433/7434/7435 + n) |
| `LOXEL_VITE_PORT`     | Vite dev server port (default 5173), also the origin a dev server admits                            |
| `LOXEL_STATIC_DIR`    | Directory of the built renderer the server serves (from source: `dist/`)                            |

Shells opened in a Loxel terminal inherit the app's `LOXEL_STATIC_DIR`, which points at the renderer inside the installed app. When testing a local build from such a shell, set `LOXEL_STATIC_DIR=$PWD/dist`, and use `LOXEL_STATE_DIR` and `LOXEL_SERVE_PORT` to keep a throwaway instance away from your real state. Variables Loxel injects into its terminals (`LOXEL_PORT`, `LOXEL_WORKTREE`, `LOXEL_WINDOW_ID`) are documented on the site's [Environment Variables & Settings](../site/src/content/docs/reference-env-files-cli-settings.md) page.

### Releases

`release-loxel.yml` bumps the patch version, builds, signs and publishes on every merge to main that touches `packages/loxel/**`. For changes outside the package that still affect the app (for example the root lockfile or dependency overrides), run it manually with `gh workflow run release-loxel.yml --ref main`. After publishing, it dispatches `release-site.yml` so the site's download page shows the new version. Each release publishes the dmg for downloads and a zip that installed apps update from, and the installed app replaces itself with the zip; see [docs/ELECTRON.md](docs/ELECTRON.md#updates) for the updater, [docs/RELEASE_SIGNING.md](docs/RELEASE_SIGNING.md) for signing and provisioning, and [docs/PATCHED_ELECTRON.md](docs/PATCHED_ELECTRON.md) for the patched Electron each release packages, which must be built and uploaded before a change to it merges.

## Data storage

Server-side state lives under `~/.local/state/loxel/loxel/` (production) or `~/.local/state/loxel/loxel-dev/` (dev mode):

- `stores.db` — UI state and panel layouts per project + worktree, settings, and other client stores (SQLite)
- `projects.db` — registered projects
- `comments/{repo-hash}.db` — reviews and comments, shared across a repo's worktrees
- `detached/{project-hash}/{worktree-hash}/` — Drafts, and `detached/home/` for plans made in Home
- `localdb/{project-hash}/localdb.db` — data behind `:::localdb` blocks in markdown files
- `logs/server-{instanceId}.log` — server logs (NDJSON, rotated at 5 MB, stale files removed after 24 h)

## Internal docs

Architecture, conventions and design rationale for contributors. Start with [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), the map of processes, source layout, the client-server contract, and testing; it links everything below.

**Platform**

- [docs/ELECTRON.md](docs/ELECTRON.md) — Electron process model, full-app updates, the native theme, browser panels, macOS integration and the default browser
- [docs/SHARED_SERVER.md](docs/SHARED_SERVER.md) — how all windows share one Bun server: one app process, starting, restarting and stopping the server, state scopes
- [docs/STATE_AND_STORAGE.md](docs/STATE_AND_STORAGE.md) — zustand stores and their scopes, server-side persistence into SQLite, settings, secrets, the state directory
- [docs/WATCHERS.md](docs/WATCHERS.md) — filesystem and git watchers, their ownership, the status refresh pipeline and the tests that lock it
- [docs/RELEASE_SIGNING.md](docs/RELEASE_SIGNING.md) — macOS code signing and the provisioning profile behind passkeys
- [docs/PATCHED_ELECTRON.md](docs/PATCHED_ELECTRON.md) — the patched Electron releases ship with: its patches, building and uploading it, and keeping it current

**Workspace**

- [docs/PROJECTS_AND_WORKTREES.md](docs/PROJECTS_AND_WORKTREES.md) — project and worktree models, worktree nesting, setup flows, `wt` integration, context switching, Others folders
- [docs/GIT.md](docs/GIT.md) — git command and parser layer, status pipeline, diff selection and base resolution, commit graph, mutations
- [docs/PANELS_AND_LAYOUT.md](docs/PANELS_AND_LAYOUT.md) — dockview zones, Home, panel registry and identity, opening and focus, tools bars, layout persistence per worktree
- [docs/KEYBINDINGS.md](docs/KEYBINDINGS.md) — action registry, chords, focus navigation, find in panel, shortcuts inside webviews

**Features**

- [docs/EDITOR.md](docs/EDITOR.md) — Monaco and markdown editors, code block highlighting, mermaid previews, peek widgets, EditorConfig, indentation and its status item, disk sync and saving, file operations, drafts, Others files, localdb, search
- [docs/LANGUAGE_SERVERS.md](docs/LANGUAGE_SERVERS.md) — language-server managers and routing (watched files, pulled configuration, on-disk workspace edits), repository trust and the trust policy for what runs untrusted, URI schemes, formatting, toolchain status items, JSON/YAML/TOML schemas, highlighting and editing behavior; per-language detail in docs/languages/ ([Python](docs/languages/python.md): environment, interpreter choice and trust rule, mypy in place of basedpyright's type checks; [TypeScript](docs/languages/typescript.md): its manager and diagnostics; [JavaScript](docs/languages/javascript.md): Node version, formatters, ESLint, oxlint and Biome; [Go](docs/languages/go.md): gopls, its toolchain and golangci-lint; [Rust](docs/languages/rust.md): toolchain and the user's rust-analyzer; [C and C++](docs/languages/c-cpp.md): clangd and compile databases; [Java](docs/languages/java.md): jdtls on the user's JDK, Maven and Gradle import, Checkstyle diagnostics; [Kotlin](docs/languages/kotlin.md): formatters and detekt and ktlint diagnostics; [C#](docs/languages/csharp.md): the user's csharp-ls and its gate; [TOML](docs/languages/toml.md): Tombi)
- [docs/THEMES.md](docs/THEMES.md) — color themes: the model and its storage, the UI token stylesheet, terminal colors, syntax colors in Monaco and Shiki, theme.json, ANSI colors from other terminals' scheme files
- [docs/TERMINALS.md](docs/TERMINALS.md) — server-side terminal emulator with attach, snapshot and resume, login-shell environment capture, toolchain environments (Python activation), the terminal WebSocket protocol, xterm.js client and its colors, notifications, the `loxel` CLI
- [docs/CODE_REVIEW.md](docs/CODE_REVIEW.md) — review and comment storage, content anchoring and placement, rendering in diffs, export
- [docs/DIFF_VIEW_SPEC.md](docs/DIFF_VIEW_SPEC.md) — diff views: components shared by git diffs, file comparisons and patches, synchronized scrolling, intra-line highlights, gutter connectors
- [docs/FILES_TREE.md](docs/FILES_TREE.md) — the shared `FilesTree` component: path identity, expansion, focus, reveal
- [docs/PROJECT_EXPLORER.md](docs/PROJECT_EXPLORER.md) — the Project Files panel: path model, Drafts and Others sections, reveal
